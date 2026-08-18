/**
 * Lessons, scenarios, the glossary, and the two kinds of attempt.
 *
 * Content lives in `@prl/content` as *situations*, never as answers (ADR 0006). Every number a
 * learner sees is computed here, at read time, from the maths — so this file's real job is not
 * serving JSON but making sure that a stored teaching claim and the computed figure next to it
 * cannot drift apart. A hard-coded odds table would be faster and would eventually lie.
 *
 * ## The caching split, which is the part that could leak
 *
 * Two kinds of response come out of this file and they get opposite treatment:
 *
 * | Response | Contains | Cache |
 * |---|---|---|
 * | `GET /content/lessons/:id`, `GET /content/scenarios/:id`, `GET /content/glossary` | nothing about the caller | strong `ETag` + `public, max-age=300` |
 * | `GET /content/lessons`, `GET /content/scenarios`, both attempt endpoints | the caller's own completion or attempt state | `no-store`, no `ETag` |
 *
 * The lists are the dangerous ones, and it is worth being explicit about why: `LessonSummary`
 * carries `completed` and `ScenarioSummary` carries `attempted`, so two learners asking for the
 * same URL get *different bodies*. Marked cacheable, one shared cache in front of this server
 * would answer the second learner with the first learner's progress. So the lists are
 * `no-store` and carry no validator at all — there is nothing an `ETag` on them could safely
 * mean.
 *
 * The security layer has a second, independent guard for the same mistake: its `onSend` hook
 * forces `no-store` on *any* response to a request that carried a session cookie. That is belt
 * and braces, not a reason to be careless here — an anonymous request through a shared cache is
 * exactly the case that hook cannot see.
 *
 * The `ETag`s are strong (no `W/`) and they are honest: they are a digest of the exact bytes
 * that go out, taken with the content version, so `If-None-Match` can be answered with a 304
 * and no recomputation at all. Content cannot change while the process runs — `@prl/content`
 * reads its files once and memoises — which is what makes a strong validator correct here.
 *
 * ## Nothing here stores or returns a score
 *
 * `quiz_attempts` has a `was_correct` column per answered question and no aggregate; there is
 * no total, no streak, no pass mark, and this file adds none. `scenario_attempts.matched_expected`
 * is left NULL whenever the computed analysis does not actually support a single action, which
 * is the honest record of a spot that is close to indifferent. See `docs/PRODUCT-GUARDRAILS.md`.
 */

import { createHash } from 'node:crypto';
import {
  content,
  glossary,
  glossaryEntriesFor,
  lessonById,
  lessonsInReadingOrder,
  quizById,
  quizForLesson,
  readSituation,
  scenarioById,
  scenarios,
} from '@prl/content';
import type {
  CoachReport,
  ContentId,
  GlossaryResponse,
  Lesson,
  LessonListResponse,
  LessonResponse,
  LessonSummary,
  LiveCalculation,
  Quiz,
  QuizAttemptRequest,
  QuizAttemptResponse,
  QuizQuestion,
  Scenario,
  ScenarioAttemptRequest,
  ScenarioAttemptResponse,
  ScenarioListResponse,
  ScenarioResponse,
  ScenarioSummary,
} from '@prl/contracts';
import { type Card, parseCards } from '@prl/poker-engine';
import {
  computeOuts,
  evOfCall,
  evOfSemiBluff,
  exactRange,
  judgeConsistency,
  parseRange,
  potOdds,
  projectResults,
  riskOfRuin,
  ruleOf24,
  stackToPotRatio,
} from '@prl/poker-math';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ResolvedSession } from '../auth/session.ts';
import { DEFAULT_WORK_LIMITS, type EquityPlan, parseEquityRequest, type WorkLimits } from '../calc/parse.ts';
import { getSql } from '../db.ts';
import { AppError } from '../errors.ts';
import { recordQuizAttempt, recordScenarioAttempt } from '../repositories/progress.ts';
import type { CoachTask, WireRange } from '../workers/equity-worker.ts';
import { closeSharedPool, getSharedPool, type WorkerPool } from '../workers/pool.ts';

/**
 * Five minutes for the immutable half.
 *
 * Long enough to be worth having in front of a page that loads a lesson and its glossary, short
 * enough that a deploy which changes content is visible without anybody purging anything — and
 * the `ETag` makes a revalidation free anyway.
 */
const IMMUTABLE_CACHE_CONTROL = 'public, max-age=300';

/**
 * Samples for a content-derived Monte Carlo run.
 *
 * Matches the figure `analyseScenario` uses, deliberately: a scenario's numbers are checked by
 * `packages/content/test/scenarios.test.ts` at that sample count, and serving the same scenario
 * at a different one would let the endpoint and the test disagree about a claim the test is
 * supposed to be guarding.
 */
const CONTENT_SAMPLES = 40_000;

/** Fixed, so a scenario's figures are the same for every learner and every reload. */
const CONTENT_SEED = 20_260_817;

// The indifference margin used to be declared here as `CONSISTENCY_MARGIN_BIG_BLINDS`. It now lives
// with the rule that uses it, as `CONSISTENCY_MARGIN_BIG_BLINDS` in `@prl/poker-math/consistency` —
// one constant for both sides of the wire, so the figure quoted in the reasoning below and the
// figure the learner's screen displays cannot be two different numbers.

// ---------------------------------------------------------------------------
// Cache policy
// ---------------------------------------------------------------------------

/** A serialised immutable response and the validator for those exact bytes. */
interface CachedPayload {
  readonly json: string;
  readonly etag: string;
}

/**
 * Serialised immutable payloads, keyed by resource.
 *
 * Bounded by the content bundle — a couple of dozen lessons, scenarios and one glossary — and
 * the bundle cannot grow while the process runs, so this is a fixed-size memo rather than a
 * cache that needs eviction. It exists because the alternative is serialising the same lesson
 * on every request and, for a scenario, recomputing its whole analysis.
 */
const payloads = new Map<string, CachedPayload>();

function digest(json: string): string {
  return createHash('sha256').update(json).digest('hex').slice(0, 32);
}

function payloadFor(key: string, build: () => unknown): CachedPayload {
  const existing = payloads.get(key);
  if (existing !== undefined) return existing;
  const json = JSON.stringify(build());
  // The content version is inside the validator, not only inside the body, so that a deploy
  // which changes how a response is *shaped* invalidates it even if the numbers are identical.
  const payload: CachedPayload = { json, etag: `"${content().version}-${digest(json)}"` };
  payloads.set(key, payload);
  return payload;
}

/** `If-None-Match` uses weak comparison for GET, so a `W/` prefix still matches. */
function matchesEtag(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  return header
    .split(',')
    .map((candidate) => candidate.trim())
    .some((candidate) => candidate === '*' || candidate.replace(/^W\//, '') === etag);
}

/**
 * Sends an immutable payload, answering a revalidation with 304.
 *
 * The bytes are sent as an already-serialised string rather than as an object, so the digest in
 * the `ETag` is a digest of what actually goes out. Handing Fastify the object and hashing a
 * separate `JSON.stringify` would be two serialisations that are only *probably* identical.
 */
function sendImmutable(request: FastifyRequest, reply: FastifyReply, payload: CachedPayload): FastifyReply {
  reply.header('etag', payload.etag);
  reply.header('cache-control', IMMUTABLE_CACHE_CONTROL);
  if (matchesEtag(request.headers['if-none-match'], payload.etag)) {
    // 304 carries the validator and the cache policy and no body, so a client that already has
    // these bytes is told they are still current without them being computed or sent again.
    return reply.status(304).send();
  }
  // The serialised string is sent as-is rather than handed back as an object: Fastify passes a
  // string payload through untouched, so the bytes on the wire are the bytes that were hashed.
  return reply.type('application/json; charset=utf-8').send(payload.json);
}

/**
 * Marks a response as belonging to one caller and to no cache.
 *
 * `no-store` and nothing else. `Vary` is deliberately left alone: `reply.header('vary', ...)`
 * *overwrites*, the CORS hook has already put `Origin` there, and a response whose body depends
 * on the origin with a clobbered `Vary` is the cache-poisoning bug that hook's own comment warns
 * about. The security layer appends `Vary: Cookie` itself whenever a session cookie was
 * presented, which is the case where it matters — and `no-store` means no shared cache is
 * holding this response for anyone in the first place.
 */
function perCaller(reply: FastifyReply): void {
  reply.header('cache-control', 'no-store');
}

// ---------------------------------------------------------------------------
// The caller
// ---------------------------------------------------------------------------

/**
 * The signed-in learner, or null.
 *
 * `request.session` is decorated by `sessionPlugin` in `src/auth/session.ts`, and the type-only
 * import above is what brings that declaration into scope here. This module does not register
 * that plugin — the store it needs belongs to the auth module — so the decorator is read
 * defensively: on an instance built without auth the property is absent altogether, and the
 * honest reading of that is "nobody is signed in" rather than a crash. Every per-caller feature
 * in this file degrades to the anonymous view instead of failing.
 */
function callerSession(request: FastifyRequest): ResolvedSession | null {
  return request.session ?? null;
}

function callerUserId(request: FastifyRequest): string | null {
  return callerSession(request)?.user.id ?? null;
}

/**
 * Lesson ids this learner has finished.
 *
 * Progress rows can outlive the content they point at (there is no foreign key, by design — see
 * the comment on `prl.lesson_progress`), so the result is intersected with the bundle by the
 * caller rather than assumed to be a subset of it.
 */
async function completedLessonIds(userId: string): Promise<ReadonlySet<string>> {
  const rows = await getSql()<{ lesson_id: string }[]>`
    select lesson_id
      from prl.lesson_progress
     where user_id = ${userId}
       and completed_at is not null
  `;
  return new Set(rows.map((row) => row.lesson_id));
}

async function attemptedScenarioIds(userId: string): Promise<ReadonlySet<string>> {
  const rows = await getSql()<{ scenario_id: string }[]>`
    select distinct scenario_id
      from prl.scenario_attempts
     where user_id = ${userId}
  `;
  return new Set(rows.map((row) => row.scenario_id));
}

// ---------------------------------------------------------------------------
// The live analysis
// ---------------------------------------------------------------------------

/**
 * A stored range spec becomes a wire range for the worker.
 *
 * The mapping is one-to-one, which is not a coincidence: `RangeSpec` in the content contract and
 * `WireRange` in the worker protocol both exist to describe a range without expanding it. The
 * expansion — including the three-second preflop strength table a `topPercent` range needs —
 * happens on the worker thread.
 */
function wireRangeFor(scenario: Scenario): WireRange {
  const spec = scenario.opponentRange;
  if (spec.kind === 'exact') {
    return { kind: 'exact', label: 'the opponent', cards: cardsOf(spec.cards) };
  }
  if (spec.kind === 'notation') {
    return { kind: 'notation', label: spec.label, notation: spec.notation };
  }
  return { kind: 'topPercent', label: spec.label, percent: spec.percent };
}

/**
 * Cards out of a content file.
 *
 * Content is validated when it loads — `validate.ts` parses every card in every lesson,
 * scenario and quiz — so a failure here is a bug in this server or in the bundle it was built
 * with, never a caller's mistake. Hence `internal_error` rather than `invalid_request`: telling
 * a learner their request was malformed when the fault is ours would send them looking in the
 * wrong place.
 */
function cardsOf(text: string): Card[] {
  try {
    return parseCards(text);
  } catch (error) {
    throw new AppError('internal_error', {
      logDetail: `content contained cards that do not parse: ${text}`,
      cause: error,
    });
  }
}

/**
 * Builds the Coach task for a scenario.
 *
 * `readSituation` is the single definition of how a stored scenario becomes a pot, a price, a
 * board and a set of stacks — the pot in particular is `potBeforeStreet` plus everything
 * committed on this street, which is easy to get wrong and would silently poison every figure
 * downstream. Reimplementing it here would be the second source of truth ADR 0006 exists to
 * prevent, so it is imported instead.
 *
 * The one thing not taken from it is the range. The situation's `opponentRange` is already
 * expanded, and the worker needs a *description* so that expanding a `topPercent` range — three
 * seconds of preflop strength table — happens on a thread rather than here. See `wireRangeFor`.
 *
 * Be precise about what that does and does not buy, because `readSituation` expands the range
 * internally whatever this function does with the result. No scenario in the bundle uses a
 * top-percentage range today; one that did would pay for the strength table on this thread, once
 * — the table is memoised per thread and the analysis is memoised per scenario, so it is one
 * stall in the life of the process rather than one per request. If content ever grows a
 * top-percentage scenario, that is the line to revisit.
 */
function coachTaskFor(scenario: Scenario): CoachTask {
  const situation = readSituation(scenario);
  // Hero's own share of this street's commitments. `readSituation` folds every seat's
  // commitment into `pot` and does not report the per-seat split, but the Coach needs
  // hero's own figure to state a legal raise total: a raise's `to` is the whole street
  // commitment, so a hero who has posted a blind or been raised off an earlier bet on
  // this street is already part of the way there. Read straight from the stored
  // scenario, which is the same field `readSituation` sums.
  const heroSeat = scenario.seats.find((seat) => seat.isHero === true);
  const heroCommittedThisStreet = scenario.committedThisStreet?.[heroSeat?.seat ?? -1] ?? 0;
  return {
    kind: 'coach',
    spec: {
      heroLabel: 'you',
      heroCards: [...situation.heroCards],
      board: [...situation.board],
      opponents: [wireRangeFor(scenario)],
    },
    street: scenario.street,
    pot: situation.pot,
    toCall: situation.toCall,
    heroCommittedThisStreet,
    heroStack: situation.heroStack,
    opponentStacks: [...situation.opponentStacks],
    bigBlind: scenario.bigBlind,
    samples: CONTENT_SAMPLES,
    seed: CONTENT_SEED,
  };
}

/**
 * The computed analysis for a scenario, memoised.
 *
 * Deterministic — a fixed seed and a fixed sample count — so memoising cannot change an answer,
 * only when the work happens. The first request for a scenario pays for it on a worker thread
 * (tens of milliseconds for a range on a turn, a few hundred for a wide range on a flop, where
 * the outs breakdown re-runs an equity calculation for every candidate card); every later
 * request, and every `If-None-Match` revalidation, pays nothing.
 *
 * `analyseScenario` is deliberately not used. It computes the same equity and the same outs a
 * second time to produce figures that are already inside this report, and doubling the cost to
 * arrive at the same numbers would be the expensive way to be less honest about it.
 */
const reports = new Map<string, CoachReport>();

async function reportFor(pool: WorkerPool, scenario: Scenario): Promise<CoachReport> {
  const cached = reports.get(scenario.id);
  if (cached !== undefined) return cached;
  const report = await pool.runCoach(coachTaskFor(scenario));
  if (report.assumptions.length === 0) {
    throw new AppError('internal_error', {
      logDetail: `scenario ${scenario.id} produced a report with no assumptions; refusing to serve it`,
    });
  }
  reports.set(scenario.id, report);
  return report;
}

/**
 * The serialised scenario response, analysis included.
 *
 * Kept separate from `payloadFor` because building it has to await a worker thread, and a memo
 * whose builder is async is a different shape from one whose builder is not.
 */
async function scenarioPayload(pool: WorkerPool, scenario: Scenario): Promise<CachedPayload> {
  const key = `scenario:${scenario.id}`;
  const existing = payloads.get(key);
  if (existing !== undefined) return existing;
  const analysis = await reportFor(pool, scenario);
  return payloadFor(
    key,
    (): ScenarioResponse => ({
      scenario,
      analysis,
      glossary: glossaryEntriesFor(scenario.glossaryTerms),
    }),
  );
}

// ---------------------------------------------------------------------------
// Numeric questions: the expected value is computed, never stored
// ---------------------------------------------------------------------------

type QuizUnit = Extract<QuizQuestion, { kind: 'numeric' }>['unit'];

interface ComputedField {
  readonly value: number;
  readonly unit: QuizUnit;
  /** The arithmetic in words, from the maths package. Shown to the learner. */
  readonly working: string;
}

/** A fraction in 0..1 reported as percentage POINTS, which is how a learner answers. */
function asPercent(fraction: number): number {
  return fraction * 100;
}

interface FieldTable {
  readonly working: string;
  readonly fields: Readonly<Record<string, { readonly value: number; readonly unit: QuizUnit }>>;
}

/**
 * The price of a call.
 *
 * `oddsRatio` is published only when there IS one. `potOdds` reports `null` for a free call —
 * there is no "X to 1" when nothing is being paid — and a numeric answer cannot be graded against
 * a figure that does not exist. Omitting it means a question that asks for it on a check spot is
 * refused by `expectedValueFor` as "a field this calculation does not produce", loudly and at the
 * content boundary, which is the right place for a content bug to surface. Publishing a 0 instead
 * would mark a learner wrong for answering the only truthful thing, which is that there is no price.
 */
function potOddsFields(calculation: Extract<LiveCalculation, { kind: 'potOdds' }>): FieldTable {
  const odds = potOdds(calculation.pot, calculation.toCall);
  return {
    working: odds.explanation,
    fields: {
      breakEvenEquity: { value: asPercent(odds.breakEvenEquity), unit: 'percent' },
      ...(odds.oddsRatio === null ? {} : { oddsRatio: { value: odds.oddsRatio, unit: 'ratio' as const } }),
      pot: { value: odds.pot, unit: 'chips' },
      toCall: { value: odds.toCall, unit: 'chips' },
    },
  };
}

function ruleOf24Fields(calculation: Extract<LiveCalculation, { kind: 'ruleOf24' }>): FieldTable {
  const estimate = ruleOf24(calculation.outs, calculation.cardsToCome);
  return {
    working: `${estimate.explanation} ${estimate.caveat}`,
    fields: {
      // Already in percentage points: the shortcut is taught as "outs times four", and scaling
      // it again would turn 36% into 3,600%.
      estimatePercent: { value: estimate.estimatePercent, unit: 'percent' },
      multiplier: { value: estimate.multiplier, unit: 'count' },
    },
  };
}

function callEvFields(calculation: Extract<LiveCalculation, { kind: 'callEv' }>): FieldTable {
  const call = evOfCall({ pot: calculation.pot, toCall: calculation.toCall, equity: calculation.equity });
  return { working: call.derivation, fields: { ev: { value: call.ev, unit: 'chips' } } };
}

/**
 * A bet with fold equity.
 *
 * `evOfSemiBluff` rather than `evOfBet`: the two compute the same figure — the maths package says
 * so explicitly — but this one also names the two halves the figure is made of, which is the
 * whole teaching point of a fold-equity question. Both halves are chip amounts, not
 * probabilities: `foldEquityShare` is `foldProbability × pot`.
 */
function foldEquityFields(calculation: Extract<LiveCalculation, { kind: 'foldEquity' }>): FieldTable {
  const bet = evOfSemiBluff({
    pot: calculation.pot,
    betSize: calculation.betSize,
    foldProbability: calculation.foldProbability,
    equityWhenCalled: calculation.equityWhenCalled,
  });
  return {
    working: bet.derivation,
    fields: {
      ev: { value: bet.ev, unit: 'chips' },
      foldEquityShare: { value: bet.foldEquityShare, unit: 'chips' },
      showdownShare: { value: bet.showdownShare, unit: 'chips' },
    },
  };
}

function sprFields(calculation: Extract<LiveCalculation, { kind: 'spr' }>): FieldTable {
  const spr = stackToPotRatio(calculation.effectiveStack, calculation.pot);
  return {
    working: `${spr.explanation} ${spr.implication}`,
    fields: {
      spr: { value: spr.spr, unit: 'ratio' },
      effectiveStack: { value: spr.effectiveStack, unit: 'chips' },
    },
  };
}

function varianceFields(calculation: Extract<LiveCalculation, { kind: 'variance' }>): FieldTable {
  const projection = projectResults({
    hands: calculation.hands,
    winRateBbPer100: calculation.winRateBbPer100,
    standardDeviationBbPer100: calculation.standardDeviationBbPer100,
  });
  return {
    working: projection.explanation,
    fields: {
      probabilityOfLoss: { value: asPercent(projection.probabilityOfLoss), unit: 'percent' },
      standardDeviationBb: { value: projection.standardDeviationBb, unit: 'chips' },
      expectedBb: { value: projection.expectedBb, unit: 'chips' },
    },
  };
}

function riskOfRuinFields(calculation: Extract<LiveCalculation, { kind: 'riskOfRuin' }>): FieldTable {
  const ruin = riskOfRuin({
    bankrollBb: calculation.bankrollBb,
    winRateBbPer100: calculation.winRateBbPer100,
    standardDeviationBbPer100: calculation.standardDeviationBbPer100,
  });
  return {
    working: `${ruin.formula} ${ruin.explanation}`,
    fields: { probability: { value: asPercent(ruin.probability), unit: 'percent' } },
  };
}

/**
 * Outs, which need an opponent.
 *
 * When the question names the opponent's cards the count is against that exact holding; when it
 * does not, the honest default is a uniformly random hand, because "how many outs" has no answer
 * at all without saying what hero is trying to beat. `computeOuts` returns the assumption it
 * used and it is passed through in the working.
 */
function outsFields(calculation: Extract<LiveCalculation, { kind: 'outs' }>): FieldTable {
  const heroCards = cardsOf(calculation.heroCards);
  const board = cardsOf(calculation.board);
  const blockers = [...heroCards, ...board];
  const opponent =
    calculation.opponentCards === undefined
      ? parseRange('random', blockers)
      : exactRange(cardsOf(calculation.opponentCards));
  const outs = computeOuts({ heroCards, board, opponent });
  return {
    working: `${outs.explanation} ${outs.assumptions.join(' ')}`,
    fields: {
      cleanCount: { value: outs.cleanCount, unit: 'count' },
      dirtyCount: { value: outs.dirtyCount, unit: 'count' },
      totalOuts: { value: outs.totalOuts, unit: 'count' },
      equityNow: { value: asPercent(outs.equityNow), unit: 'percent' },
    },
  };
}

/**
 * Equity, which goes through the same planner and the same worker pool as `POST /math/equity`.
 *
 * Reuse rather than a second path: the planner decides exact-versus-sampled and enforces the work
 * ceiling, and a calculation that turns out to be too big should meet the same limit here as it
 * would there rather than being run on the event loop because it came from a file.
 *
 * The planner's refusals are re-labelled, though. It reports a bad range as `invalid_request` with
 * a message against `opponents.0`, which is exactly right for a caller who sent that field and
 * exactly wrong for a learner answering a quiz: the field is ours, in a content file they have
 * never seen. So a refusal here becomes `internal_error`, with the detail in the log where the
 * person who can fix it will find it.
 */
async function equityFields(
  calculation: Extract<LiveCalculation, { kind: 'equity' }>,
  pool: WorkerPool,
  limits: WorkLimits,
): Promise<FieldTable> {
  let plan: EquityPlan;
  try {
    plan = parseEquityRequest(
      {
        heroCards: calculation.heroCards,
        ...(calculation.board === undefined ? {} : { board: calculation.board }),
        opponents: calculation.opponents,
        samples: CONTENT_SAMPLES,
      },
      limits,
    );
  } catch (error) {
    throw new AppError('internal_error', {
      logDetail:
        'a content equity calculation was refused by the planner: ' +
        `hero ${calculation.heroCards}, board "${calculation.board ?? ''}", ` +
        `opponents ${calculation.opponents.join(' / ')}`,
      cause: error,
    });
  }
  const result = await pool.runEquity(plan.request);
  const hero = result.players[0];
  if (hero === undefined) {
    throw new AppError('internal_error', { logDetail: 'content equity produced no players' });
  }
  return {
    working: `${result.assumptions.join(' ')} Method: ${result.method}, ${result.trials} run-outs.`,
    fields: { heroEquity: { value: asPercent(hero.equity), unit: 'percent' } },
  };
}

/**
 * Every calculation except equity, all of which are closed-form arithmetic on this thread.
 *
 * The split is real rather than cosmetic: pot odds, the rule of 2 and 4, EV, SPR, variance and
 * risk of ruin are a handful of floating-point operations each, and the outs breakdown is bounded
 * by the 45-or-so candidate cards of an authored, validated situation. Equity is the one that can
 * cost real CPU, so it is the one that goes to a worker thread.
 */
function closedFormTable(calculation: Exclude<LiveCalculation, { kind: 'equity' }>): FieldTable {
  switch (calculation.kind) {
    case 'potOdds':
      return potOddsFields(calculation);
    case 'ruleOf24':
      return ruleOf24Fields(calculation);
    case 'callEv':
      return callEvFields(calculation);
    case 'foldEquity':
      return foldEquityFields(calculation);
    case 'spr':
      return sprFields(calculation);
    case 'variance':
      return varianceFields(calculation);
    case 'riskOfRuin':
      return riskOfRuinFields(calculation);
    default:
      return outsFields(calculation);
  }
}

async function tableFor(
  calculation: LiveCalculation,
  pool: WorkerPool,
  limits: WorkLimits,
): Promise<FieldTable> {
  if (calculation.kind === 'equity') return await equityFields(calculation, pool, limits);
  return closedFormTable(calculation);
}

/**
 * The value a numeric answer is checked against, computed from the question's own calculation.
 *
 * Two content bugs are caught loudly here rather than being served: a field the calculation does
 * not produce, and a field whose natural unit disagrees with the unit the question declares. The
 * second is the dangerous one — a question that says `percent` while its field is a fraction
 * would mark 33.3 wrong and 0.333 right, and every learner would be told they had it wrong.
 */
export async function expectedValueFor(
  question: Extract<QuizQuestion, { kind: 'numeric' }>,
  pool: WorkerPool,
  limits: WorkLimits,
): Promise<ComputedField> {
  const table = await tableFor(question.calculation, pool, limits);
  const computed = table.fields[question.field];
  if (computed === undefined) {
    throw new AppError('internal_error', {
      logDetail:
        `quiz question ${question.id} asks for field "${question.field}" of a ` +
        `${question.calculation.kind} calculation, which produces: ${Object.keys(table.fields).join(', ')}`,
    });
  }
  if (computed.unit !== question.unit) {
    throw new AppError('internal_error', {
      logDetail:
        `quiz question ${question.id} declares unit "${question.unit}" but field ` +
        `"${question.field}" is in "${computed.unit}"`,
    });
  }
  return { value: computed.value, unit: computed.unit, working: table.working };
}

// ---------------------------------------------------------------------------
// Consistency with the analysis
// ---------------------------------------------------------------------------

interface Consistency {
  readonly consistent: boolean;
  readonly reasoning: string;
  /**
   * True when exactly one action is defensible against the stated range. Stored as
   * `scenario_attempts.matched_expected` only when it holds, and NULL otherwise — which is what
   * that nullable column is for. Never shown as a score.
   */
  readonly claimsOneAction: boolean;
}

/**
 * Whether a chosen action is consistent with the computed report, and why.
 *
 * **The rule is not here.** It is `judgeConsistency` in `@prl/poker-math`, which `apps/web` calls
 * too. It used to be here, and `apps/web/src/lib/consistency.ts` had a second copy that asked a
 * different question with a different tolerance — so the sentence a learner read and the boolean
 * written to `scenario_attempts.matched_expected` could disagree. What is left in this file is the
 * only part that is genuinely the endpoint's: the wording of the response.
 *
 * `bigBlind` still comes from the scenario rather than the report, because a `CoachReport` does not
 * carry one — and the margin has to be denominated in something. Using a fraction of the pot instead
 * would make the same decision "indifferent" in a small pot and "wrong" in a large one.
 */
export function consistencyOf(
  report: CoachReport,
  action: string,
  to: number | undefined,
  bigBlind: number,
): Consistency {
  const verdict = judgeConsistency({ report, action, bigBlind, ...(to === undefined ? {} : { to }) });
  const { claimsOneAction } = verdict;

  if (verdict.chosen === null) {
    return {
      consistent: false,
      reasoning:
        `${action} is not one of the actions available in this spot, so there is nothing for the ` +
        `analysis to compare it with. It evaluated: ${verdict.availableActions.join(', ')}.`,
      claimsOneAction,
    };
  }
  const chosen = verdict.chosen;

  const alternatives = verdict.supportedActions.filter((candidate) => candidate !== action);
  const alsoSupported =
    alternatives.length === 0
      ? ''
      : ` Against this range the analysis also supports ${alternatives.join(' and ')}, so this spot ` +
        'does not come down to one answer.';
  // The learner's own sizing is reported next to the size the analysis priced, because the same
  // action at a very different size is a different decision, and saying so is more useful than
  // quietly grading one against the other.
  const sizing =
    to === undefined ? '' : ` You sized it to ${to}; the analysis priced ${chosen.to ?? chosen.cost}.`;

  if (verdict.consistent) {
    return {
      consistent: true,
      reasoning: `${action} is consistent with this analysis. ${chosen.derivation}${alsoSupported}${sizing}`,
      claimsOneAction,
    };
  }
  return {
    consistent: false,
    reasoning:
      `${action} is not consistent with this analysis. ${chosen.derivation} Measured against ` +
      `folding — which is worth exactly zero — it comes out about ${verdict.shortfallUnits.toFixed(1)} ` +
      `chips behind, more than the ${verdict.marginUnits.toFixed(1)} chips (one big blind) this spot ` +
      `treats as indifferent.${alsoSupported} That is a statement about the stated range assumption, ` +
      `and a different assumption could change it.${sizing}`,
    claimsOneAction,
  };
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

function lessonSummary(lesson: Lesson, completed: ReadonlySet<string>): LessonSummary {
  return {
    id: lesson.id,
    title: lesson.title,
    summary: lesson.summary,
    topic: lesson.topic,
    difficulty: lesson.difficulty,
    estimatedMinutes: lesson.estimatedMinutes,
    prerequisites: lesson.prerequisites,
    ...(lesson.quizId === undefined ? {} : { quizId: lesson.quizId }),
    completed: completed.has(lesson.id),
  };
}

function scenarioSummary(scenario: Scenario, attempted: ReadonlySet<string>): ScenarioSummary {
  return {
    id: scenario.id,
    title: scenario.title,
    topic: scenario.topic,
    difficulty: scenario.difficulty,
    question: scenario.question,
    street: scenario.street,
    attempted: attempted.has(scenario.id),
  };
}

// ---------------------------------------------------------------------------
// Grading one answer
// ---------------------------------------------------------------------------

function questionIn(quiz: Quiz, questionId: ContentId): QuizQuestion {
  const question = quiz.questions.find((candidate) => candidate.id === questionId);
  if (question === undefined) {
    throw new AppError('content_not_found', {
      logDetail: `quiz ${quiz.id} has no question ${questionId}`,
    });
  }
  return question;
}

function wrongAnswerKind(expected: string, got: string): AppError {
  return new AppError('invalid_request', {
    fields: { 'answer.kind': `this question takes a "${expected}" answer, not a "${got}" one` },
    logDetail: `answer kind ${got} did not match question kind ${expected}`,
  });
}

async function gradeQuestion(
  question: QuizQuestion,
  answer: QuizAttemptRequest['answer'],
  deps: { readonly pool: WorkerPool; readonly limits: WorkLimits },
): Promise<QuizAttemptResponse> {
  if (question.kind === 'multipleChoice') {
    if (answer.kind !== 'choice') throw wrongAnswerKind('choice', answer.kind);
    return {
      correct: answer.index === question.correctIndex,
      explanation: question.explanation,
      ...(question.optionNotes === undefined ? {} : { optionNotes: question.optionNotes }),
    };
  }

  if (question.kind === 'numeric') {
    if (answer.kind !== 'number') throw wrongAnswerKind('number', answer.kind);
    const computed = await expectedValueFor(question, deps.pool, deps.limits);
    return {
      correct: Math.abs(answer.value - computed.value) <= question.tolerance,
      // The question's own explanation, then the arithmetic that produced the figure the answer
      // was measured against. The contract has one `explanation` field, and a learner who was
      // marked wrong needs both halves of it.
      explanation: `${question.explanation} ${computed.working}`,
      expected: { value: computed.value, unit: computed.unit, tolerance: question.tolerance },
    };
  }

  if (answer.kind !== 'action') throw wrongAnswerKind('action', answer.kind);
  const scenario = scenarioById(question.scenarioId);
  if (scenario === null) {
    throw new AppError('internal_error', {
      logDetail: `quiz question ${question.id} points at missing scenario ${question.scenarioId}`,
    });
  }
  const report = await reportFor(deps.pool, scenario);
  const consistency = consistencyOf(report, answer.action, undefined, scenario.bigBlind);
  return { correct: consistency.consistent, explanation: `${question.explanation} ${consistency.reasoning}` };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

interface IdParams {
  readonly id: ContentId;
}

/**
 * A bet or a raise has to say how much.
 *
 * `scenarioAttemptBodySchema` cannot express "required only for these two actions" without an
 * `oneOf`, so the rule is checked here — and checked for *every* caller, not only the signed-in
 * one whose row is written. That is the point of the function: `recordScenarioAttempt` refuses to
 * store a sizeless bet, and refusing it only at the write would answer 200 to an anonymous reader
 * and 400 to the learner making the identical request.
 *
 * Refusing rather than substituting the size the analysis happened to price: "bet" and "bet 40"
 * are different decisions, which is exactly why `consistencyOf` reports the learner's own sizing
 * next to the priced one instead of grading it away.
 */
function requireSizing(body: ScenarioAttemptRequest): void {
  if (body.action !== 'bet' && body.action !== 'raise') return;
  if (body.to !== undefined) return;
  throw new AppError('invalid_request', {
    fields: { to: 'is required for a bet or a raise, as a whole number of units' },
    logDetail: `a scenario attempt chose ${body.action} without a sizing`,
  });
}

// A plain function returning a resolved promise, not an `async` function with no `await`: every
// route below is attached synchronously and the linter is right to reject the other shape.
const contentRoutes: FastifyPluginAsync = (app) => {
  const config = app.appConfig;
  const limits: WorkLimits = { ...DEFAULT_WORK_LIMITS, maxSamplesPerRequest: config.monteCarloMaxSamples };
  const pool = getSharedPool(config, {
    onWarn: (warning) => {
      app.log.warn({ poolEvent: warning.event, poolDetail: warning.detail }, 'calculation pool');
    },
  });
  // Idempotent, and registered here as well as in `routes/calc.ts` so that whichever modules a
  // deployment happens to register, the threads still go away with the instance.
  app.addHook('onClose', async () => {
    await closeSharedPool();
  });

  const idSchema = { params: { $ref: 'prl:contentIdParams#' } };

  /** The lesson list, with this caller's completion state. Per-caller, so never cached. */
  app.get('/content/lessons', async (request, reply): Promise<LessonListResponse> => {
    perCaller(reply);
    const userId = callerUserId(request);
    const completed = userId === null ? new Set<string>() : await completedLessonIds(userId);
    return {
      lessons: lessonsInReadingOrder().map((lesson) => lessonSummary(lesson, completed)),
    };
  });

  /** One lesson, its quiz and its glossary terms. Identical for everybody, so cacheable. */
  app.get<{ Params: IdParams }>('/content/lessons/:id', { schema: idSchema }, (request, reply) => {
    const lesson = lessonById(request.params.id);
    if (lesson === null) {
      throw new AppError('content_not_found', { logDetail: `no lesson ${request.params.id}` });
    }
    return sendImmutable(
      request,
      reply,
      payloadFor(
        `lesson:${lesson.id}`,
        (): LessonResponse => ({
          lesson,
          quiz: quizForLesson(lesson.id),
          glossary: glossaryEntriesFor(lesson.glossaryTerms),
        }),
      ),
    );
  });

  /** The scenario list, with this caller's attempt state. Per-caller, so never cached. */
  app.get('/content/scenarios', async (request, reply): Promise<ScenarioListResponse> => {
    perCaller(reply);
    const userId = callerUserId(request);
    const attempted = userId === null ? new Set<string>() : await attemptedScenarioIds(userId);
    return { scenarios: scenarios().map((scenario) => scenarioSummary(scenario, attempted)) };
  });

  /**
   * One scenario, with its analysis computed live.
   *
   * The analysis is not stored anywhere — that is the whole of ADR 0006 — and it is not part of
   * the scenario file. It is computed on a worker thread the first time this scenario is asked
   * for and memoised after that, which is safe because it is deterministic.
   */
  app.get<{ Params: IdParams }>('/content/scenarios/:id', { schema: idSchema }, async (request, reply) => {
    const scenario = scenarioById(request.params.id);
    if (scenario === null) {
      throw new AppError('content_not_found', { logDetail: `no scenario ${request.params.id}` });
    }
    return sendImmutable(request, reply, await scenarioPayload(pool, scenario));
  });

  /** The whole glossary. Identical for everybody. */
  app.get('/content/glossary', (request, reply) =>
    sendImmutable(
      request,
      reply,
      payloadFor('glossary', (): GlossaryResponse => ({ entries: glossary() })),
    ),
  );

  /**
   * One quiz answer.
   *
   * Nothing about a score is computed, stored or returned: the response says whether this one
   * answer matched the computed value, and shows the working. For a numeric question the value
   * comes from the question's `calculation`, never from the content file — a stored answer key is
   * a number that can silently disagree with the maths, and it is the learner who pays for that.
   */
  app.post<{ Params: IdParams; Body: QuizAttemptRequest }>(
    '/content/quizzes/:id/attempt',
    { schema: { params: { $ref: 'prl:contentIdParams#' }, body: { $ref: 'prl:quizAttemptBody#' } } },
    async (request, reply): Promise<QuizAttemptResponse> => {
      perCaller(reply);
      const quiz = quizById(request.params.id);
      if (quiz === null) {
        throw new AppError('content_not_found', { logDetail: `no quiz ${request.params.id}` });
      }
      const question = questionIn(quiz, request.body.questionId);
      const outcome = await gradeQuestion(question, request.body.answer, { pool, limits });

      const userId = callerUserId(request);
      if (userId !== null) {
        // Append-only, one row per answered question, no aggregate. `was_correct` is this app's
        // comparison against a value computed at runtime; the value itself is not stored. The
        // statement lives in `repositories/progress.ts`, which also owns the check that the answer
        // serialises to a JSON *object* — `quiz_attempts_answer_is_object` refuses anything else.
        await recordQuizAttempt(getSql(), {
          userId,
          quizId: quiz.id,
          questionId: question.id,
          answer: { ...request.body.answer },
          wasCorrect: outcome.correct,
        });
      }
      return outcome;
    },
  );

  /**
   * One Scenario Lab decision.
   *
   * `consistentWithAnalysis` is a statement about the analysis, not a mark. `matched_expected` is
   * written as NULL when the computed report does not actually support a single action, which is
   * what the column is for — plenty of spots are close to indifferent and recording one of them
   * as a wrong answer would be a lie about the maths.
   */
  app.post<{ Params: IdParams; Body: ScenarioAttemptRequest }>(
    '/content/scenarios/:id/attempt',
    { schema: { params: { $ref: 'prl:contentIdParams#' }, body: { $ref: 'prl:scenarioAttemptBody#' } } },
    async (request, reply): Promise<ScenarioAttemptResponse> => {
      perCaller(reply);
      const scenario = scenarioById(request.params.id);
      if (scenario === null) {
        throw new AppError('content_not_found', { logDetail: `no scenario ${request.params.id}` });
      }
      requireSizing(request.body);
      const analysis = await reportFor(pool, scenario);
      const consistency = consistencyOf(analysis, request.body.action, request.body.to, scenario.bigBlind);

      const userId = callerUserId(request);
      if (userId !== null) {
        // `matched_expected` stays NULL when the analysis does not single out one action — see the
        // route comment. The statement, and the shape of `chosen_action`, belong to
        // `repositories/progress.ts`.
        await recordScenarioAttempt(getSql(), {
          userId,
          scenarioId: scenario.id,
          action: request.body.action,
          ...(request.body.to === undefined ? {} : { to: request.body.to }),
          matchedExpected: consistency.claimsOneAction ? consistency.consistent : null,
        });
      }

      return {
        consistentWithAnalysis: consistency.consistent,
        reasoning: `${consistency.reasoning} ${scenario.reasoning}`,
        analysis,
        commonMistakes: scenario.commonMistakes,
      };
    },
  );

  return Promise.resolve();
};

export default contentRoutes;

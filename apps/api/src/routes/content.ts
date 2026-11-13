/**
 * Lessons, scenarios, the glossary, and quiz and scenario attempts.
 *
 * Content stores situations, never answers (ADR 0006). Every figure is computed here at read time.
 * Single lessons, scenarios and the glossary are identical for everyone and get a strong `ETag` plus
 * `public, max-age=300`. The lists and attempt endpoints carry the caller's own state, so they are
 * `no-store` with no `ETag`, or a shared cache would serve one learner's progress to another.
 * Strong ETags are correct because `@prl/content` loads once and cannot change while running.
 * No score is stored or returned (`docs/PRODUCT-GUARDRAILS.md`).
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
  SCENARIO_ANALYSIS_SAMPLES,
  SCENARIO_ANALYSIS_SEED,
  scenarioById,
  scenarios,
} from '@prl/content';
import type {
  CoachReport,
  ContentId,
  GlossaryResponse,
  Lesson,
  LessonListResponse,
  LessonReadRequest,
  LessonReadResponse,
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
import { withinTolerance } from '@prl/contracts';
import { type Card, parseCards } from '@prl/poker-engine';
import {
  computeOuts,
  deriveContestablePot,
  deriveLegalActions,
  evOfCall,
  evOfSemiBluff,
  exactRange,
  icmEquity,
  judgeConsistency,
  maximumTo,
  minimumAggressiveTo,
  parseRange,
  potOdds,
  projectResults,
  riskOfRuin,
  ruleOf24,
  type SizedSpot,
  stackToPotRatio,
} from '@prl/poker-math';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ResolvedSession } from '../auth/session.ts';
import { DEFAULT_WORK_LIMITS, type EquityPlan, parseEquityRequest, type WorkLimits } from '../calc/parse.ts';
import { getSql } from '../db.ts';
import { AppError } from '../errors.ts';
import {
  bindCalculationPoolMetrics,
  observeAnalysis,
  workerTaskOutcomeFor,
} from '../observability/telemetry.ts';
import { recordQuizAttempt, recordScenarioAttempt, upsertLessonProgress } from '../repositories/progress.ts';
import type { CoachTask, WireRange } from '../workers/equity-worker.ts';
import {
  closeSharedPool,
  getSharedPool,
  type PoolWarning,
  peekSharedPool,
  type WorkerPool,
} from '../workers/pool.ts';

/** Short enough that a content deploy shows without a purge. The `ETag` makes revalidation free. */
const IMMUTABLE_CACHE_CONTROL = 'public, max-age=300';

/** Same count as `analyseScenario`, so the endpoint agrees with `packages/content/test/scenarios.test.ts`. */
const CONTENT_SAMPLES = SCENARIO_ANALYSIS_SAMPLES;

/** Fixed, so a scenario's figures match for every learner and reload. */
const CONTENT_SEED = SCENARIO_ANALYSIS_SEED;

interface CachedPayload {
  readonly json: string;
  readonly etag: string;
}

/** Bounded by the content bundle, which cannot grow at runtime, so no eviction is needed. */
const payloads = new Map<string, CachedPayload>();

function digest(json: string): string {
  return createHash('sha256').update(json).digest('hex').slice(0, 32);
}

function payloadFor(key: string, build: () => unknown): CachedPayload {
  const existing = payloads.get(key);
  if (existing !== undefined) return existing;
  const json = JSON.stringify(build());
  // The content version is in the validator so a change in response shape invalidates it.
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

/** Sends the pre-serialised string, so the `ETag` digest is of the exact bytes on the wire. */
function sendImmutable(request: FastifyRequest, reply: FastifyReply, payload: CachedPayload): FastifyReply {
  reply.header('etag', payload.etag);
  reply.header('cache-control', IMMUTABLE_CACHE_CONTROL);
  if (matchesEtag(request.headers['if-none-match'], payload.etag)) {
    return reply.status(304).send();
  }
  return reply.type('application/json; charset=utf-8').send(payload.json);
}

/**
 * `no-store` only. `Vary` is left alone because `reply.header('vary', ...)` overwrites the `Origin`
 * the CORS hook set. The security layer appends `Vary: Cookie` itself.
 */
function perCaller(reply: FastifyReply): void {
  reply.header('cache-control', 'no-store');
}

/** Read defensively. On an instance built without auth the decorator is absent, which means signed out. */
function callerSession(request: FastifyRequest): ResolvedSession | null {
  return request.session ?? null;
}

function callerUserId(request: FastifyRequest): string | null {
  return callerSession(request)?.user.id ?? null;
}

/** Progress rows have no foreign key to content, so callers intersect this with the bundle. */
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

/** One-to-one, so the `topPercent` expansion and its strength table run on the worker thread. */
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

/** Content is validated at load, so a parse failure is our bug and answers `internal_error`. */
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
 * `readSituation` is the single definition of the pot, the call, the board and the stacks (ADR 0006).
 * Only the range is taken as a description, so the worker expands it.
 * `readSituation` still expands the range internally. No bundled scenario uses a top-percentage
 * range today. One that did would stall this thread once, since the table and analysis are memoised.
 */
export function coachTaskFor(scenario: Scenario): CoachTask {
  const situation = readSituation(scenario);
  // `readSituation` folds every seat into `pot`. The Coach needs hero's own share to state a legal
  // raise total, so it is read from `committedThisStreet`.
  const heroSeat = scenario.seats.find((seat) => seat.isHero === true);
  const heroCommittedThisStreet = scenario.committedThisStreet?.[heroSeat?.seat ?? -1] ?? 0;
  // A scenario has no `HandState`, so legality is derived from the same figures. A bet or raise is
  // withheld when no opponent has chips behind. `opponentStacks` is chips behind, so all-in is `0`.
  const legalActions = deriveLegalActions({
    toCall: situation.toCall,
    heroCommittedThisStreet,
    heroStack: situation.heroStack,
    opponentStacks: situation.opponentStacks,
  });
  // The pot hero can win, excluding side pots hero is not in. `deriveContestablePot`, not
  // `contestablePotFor`, because a scenario has no complete per-seat street record. For example
  // `preflop-squeeze-fold-equity` lumps hero's posted blind into `potBeforeStreet`.
  const contestable = deriveContestablePot({
    pot: situation.pot,
    toCall: situation.toCall,
    heroCommittedThisStreet,
    heroStack: situation.heroStack,
    opponentStacks: situation.opponentStacks,
  });
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
    contestablePot: contestable,
    toCall: situation.toCall,
    heroCommittedThisStreet,
    heroStack: situation.heroStack,
    opponentStacks: [...situation.opponentStacks],
    bigBlind: scenario.bigBlind,
    legalActions,
    samples: CONTENT_SAMPLES,
    seed: CONTENT_SEED,
  };
}

/**
 * Memoised. A fixed seed and sample count make it deterministic, so the memo changes only timing.
 * `analyseScenario` is not used because it recomputes figures already in this report.
 */
const reports = new Map<string, CoachReport>();

async function reportFor(pool: WorkerPool, scenario: Scenario): Promise<CoachReport> {
  const cached = reports.get(scenario.id);
  if (cached !== undefined) return cached;
  // Only the uncached call is timed, so the histogram counts scenarios computed, not memo hits.
  const report = await observeAnalysis('coach', () => pool.runCoach(coachTaskFor(scenario)));
  if (report.assumptions.length === 0) {
    throw new AppError('internal_error', {
      logDetail: `scenario ${scenario.id} produced a report with no assumptions; refusing to serve it`,
    });
  }
  reports.set(scenario.id, report);
  return report;
}

/** Separate from `payloadFor` because its builder awaits a worker thread. */
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

type QuizUnit = Extract<QuizQuestion, { kind: 'numeric' }>['unit'];

interface ComputedField {
  readonly value: number;
  readonly unit: QuizUnit;
  /** The arithmetic in words, shown to the learner. */
  readonly working: string;
}

/** Percentage points, which is how a learner answers. */
function asPercent(fraction: number): number {
  return fraction * 100;
}

interface FieldTable {
  readonly working: string;
  readonly fields: Readonly<Record<string, { readonly value: number; readonly unit: QuizUnit }>>;
}

/**
 * `oddsRatio` is omitted for a free call, where `potOdds` reports `null`. A question asking for it
 * on a check spot is then refused by `expectedValueFor` as a content bug, rather than grading against 0.
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
      // Already in percentage points. Scaling again would turn 36% into 3,600%.
      estimatePercent: { value: estimate.estimatePercent, unit: 'percent' },
      multiplier: { value: estimate.multiplier, unit: 'count' },
    },
  };
}

function callEvFields(calculation: Extract<LiveCalculation, { kind: 'callEv' }>): FieldTable {
  const call = evOfCall({ pot: calculation.pot, toCall: calculation.toCall, equity: calculation.equity });
  return { working: call.derivation, fields: { ev: { value: call.ev, unit: 'chips' } } };
}

/** `evOfSemiBluff` names the two chip-denominated halves, which is the point of a fold-equity question. */
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

function icmFields(calculation: Extract<LiveCalculation, { kind: 'icm' }>): FieldTable {
  const result = icmEquity(calculation.stacks, calculation.payouts);
  const pool = result.totalPrizePool;
  const leader = result.equities[0] ?? 0;
  const share = pool === 0 ? 0 : leader / pool;
  return {
    working: result.explanation,
    fields: {
      chipLeaderShare: { value: asPercent(share), unit: 'percent' },
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

/** Against the named opponent cards, or a uniformly random hand when none are given. */
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
 * The same planner and pool as `POST /math/equity`, so content meets the same work ceiling.
 * Planner refusals become `internal_error`, because the bad field is in our content.
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
  const result = await observeAnalysis('equity', () => pool.runEquity(plan.request));
  const hero = result.players[0];
  if (hero === undefined) {
    throw new AppError('internal_error', { logDetail: 'content equity produced no players' });
  }
  return {
    working: `${result.assumptions.join(' ')} Method: ${result.method}, ${result.trials} run-outs.`,
    fields: { heroEquity: { value: asPercent(hero.equity), unit: 'percent' } },
  };
}

/** Closed-form arithmetic on this thread. Only equity costs enough CPU to need a worker. */
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
    case 'icm':
      return icmFields(calculation);
    case 'outs':
      return outsFields(calculation);
    default: {
      const unreachable: never = calculation;
      return unreachable;
    }
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
 * Refuses two content bugs. One is a field the calculation does not produce. The other is a unit
 * mismatch, which would mark 33.3 wrong and 0.333 right.
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

interface Consistency {
  readonly consistent: boolean;
  readonly reasoning: string;
  /** Exactly one action is defensible. `matched_expected` is stored only when this holds, else NULL. */
  readonly claimsOneAction: boolean;
  /**
   * The analysis has a row for the submitted action and sizing. When false, `consistent` means
   * "not established", and `matched_expected` is stored as NULL rather than recording a wrong answer.
   */
  readonly priced: boolean;
}

/**
 * The rule is `judgeConsistency` in `@prl/poker-math`, shared with `apps/web`. Only the wording is here.
 * `bigBlind` comes from the scenario because the margin is in big blinds, not a pot fraction.
 */
export function consistencyOf(
  report: CoachReport,
  action: string,
  to: number | undefined,
  bigBlind: number,
): Consistency {
  const verdict = judgeConsistency({ report, action, bigBlind, ...(to === undefined ? {} : { to }) });
  const { claimsOneAction } = verdict;

  // A size the analysis never evaluated. `to` is always present here, and the check is written out.
  // Sizes hero could not reach are refused earlier, in `requirePayableSizing`.
  if (verdict.pricing === 'sizing-not-priced' && to !== undefined) {
    const whatWasPriced =
      verdict.pricedSizes.length === 0
        ? `The analysis priced ${action} with no sizing at all, because ${action} moves no chips`
        : `The analysis priced ${action} to ${verdict.pricedSizes.join(', ')}`;
    return {
      consistent: false,
      reasoning:
        `The analysis did not price ${action} to ${to}, so there is nothing here to judge that ` +
        `decision against. ${whatWasPriced}, and a differently sized ${action} is a different decision — ` +
        'reporting it against one of those would be answering a question you did not ask. This is ' +
        'not a statement that your size is wrong; it is a statement that this analysis does not ' +
        'cover it.',
      claimsOneAction,
      priced: false,
    };
  }

  if (verdict.chosen === null) {
    return {
      consistent: false,
      reasoning:
        `${action} is not one of the actions available in this spot, so there is nothing for the ` +
        `analysis to compare it with. It evaluated: ${verdict.availableActions.join(', ')}.`,
      claimsOneAction,
      priced: false,
    };
  }
  const chosen = verdict.chosen;

  const alternatives = verdict.supportedActions.filter((candidate) => candidate !== action);
  const alsoSupported =
    alternatives.length === 0
      ? ''
      : ` Against this range the analysis also supports ${alternatives.join(' and ')}, so this spot ` +
        'does not come down to one answer.';
  // The evaluated size stated next to the learner's own, so their agreement is visible.
  const sizing =
    to === undefined ? '' : ` You sized it to ${to}; the analysis priced ${chosen.to ?? chosen.cost}.`;

  if (verdict.consistent) {
    return {
      consistent: true,
      reasoning: `${action} is consistent with this analysis. ${chosen.derivation}${alsoSupported}${sizing}`,
      claimsOneAction,
      priced: true,
    };
  }
  // Folding when a check is free is refused outright, not on a margin, so it gets its own sentence.
  if (chosen.action === 'fold' && verdict.availableActions.includes('check')) {
    return {
      consistent: false,
      reasoning:
        'fold is not consistent with this analysis, and this is the one case that does not come ' +
        'down to a margin: you can check here for free. Checking keeps every card still to come ' +
        'and costs nothing, so it is never behind folding however thin the hand is. What the ' +
        `range assumption changes is whether betting would beat checking, not this.${alsoSupported}`,
      claimsOneAction,
      priced: true,
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
    priced: true,
  };
}

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

/** Grading is pure. The route decides storage later (`QuizAttemptResponse.recorded`). */
type QuizGrade = Omit<QuizAttemptResponse, 'recorded'>;

async function gradeQuestion(
  question: QuizQuestion,
  answer: QuizAttemptRequest['answer'],
  deps: { readonly pool: WorkerPool; readonly limits: WorkLimits },
): Promise<QuizGrade> {
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
      // The shared rule, because |3.2 - 3| is 0.20000000000000018 (packages/contracts/src/quiz-tolerance.ts).
      correct: withinTolerance(answer.value, { value: computed.value, tolerance: question.tolerance }),
      // The question's explanation, then the working, because the contract has one field.
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

interface IdParams {
  readonly id: ContentId;
}

/**
 * A bet or raise must state `to`. Checked for every caller, because `recordScenarioAttempt`
 * refuses a sizeless bet and the anonymous and signed-in answers must match.
 */
function requireSizing(body: ScenarioAttemptRequest): void {
  if (body.action !== 'bet' && body.action !== 'raise') return;
  if (body.to !== undefined) return;
  throw new AppError('invalid_request', {
    fields: { to: 'is required for a bet or a raise, as a whole number of units' },
    logDetail: `a scenario attempt chose ${body.action} without a sizing`,
  });
}

/** Memoised per scenario. Uses `coachTaskFor`, so the pot and hero commitment have one definition. */
const attemptSpots = new Map<string, SizedSpot>();

function sizedSpotFor(scenario: Scenario): SizedSpot {
  const cached = attemptSpots.get(scenario.id);
  if (cached !== undefined) return cached;
  const task = coachTaskFor(scenario);
  const spot: SizedSpot = {
    toCall: task.toCall,
    heroCommittedThisStreet: task.heroCommittedThisStreet,
    heroStack: task.heroStack,
    opponentStacks: task.opponentStacks,
    bigBlind: task.bigBlind,
  };
  attemptSpots.set(scenario.id, spot);
  return spot;
}

/**
 * Refuses a size hero could not have put out, before anything is graded.
 * Before this guard, `{"action":"raise","to":26000}` with 500 behind returned
 * `consistentWithAnalysis: true`. The bounds are above zero, at most `maximumTo`, and at least
 * `minimumAggressiveTo` when the rules allow aggression. The floor is quoted back to the caller.
 * Where aggression is not legal, `consistencyOf` reports the action as unavailable instead.
 */
function requirePayableSizing(scenario: Scenario, body: ScenarioAttemptRequest): void {
  const to = body.to;
  if (to === undefined) return;
  const spot = sizedSpotFor(scenario);

  const refusal = (message: string, detail: string): AppError =>
    new AppError('invalid_request', {
      fields: { to: message },
      logDetail: `scenario ${scenario.id}: ${body.action} to ${to} ${detail}`,
    });

  if (to <= 0) {
    throw refusal(
      'is a total commitment for the street, so it has to be above zero — a total of 0 puts no chips out',
      'is not a positive total',
    );
  }
  const maxTo = maximumTo(spot);
  if (to > maxTo) {
    throw refusal(
      `is more than you can reach: ${spot.heroCommittedThisStreet} is already out and ${spot.heroStack} ` +
        `is behind, so ${maxTo} is your whole stack`,
      `exceeds hero's maximum of ${maxTo}`,
    );
  }
  if (body.action !== 'bet' && body.action !== 'raise') return;
  if (!deriveLegalActions(spot).includes(body.action)) return;
  const floorTo = minimumAggressiveTo(spot);
  if (to < floorTo) {
    throw refusal(
      `is below the smallest legal ${body.action} here, which is a total of ${floorTo}`,
      `is below the floor of ${floorTo}`,
    );
  }
}

const contentRoutes: FastifyPluginAsync = (app) => {
  const config = app.appConfig;
  const metrics = app.appMetrics;
  const limits: WorkLimits = { ...DEFAULT_WORK_LIMITS, maxSamplesPerRequest: config.monteCarloMaxSamples };
  const poolHooks = {
    onWarn: (warning: PoolWarning) => {
      app.log.warn({ poolEvent: warning.event, poolDetail: warning.detail }, 'calculation pool');
      // Only the first module's `onWarn` is installed (`getSharedPool` memoises), so every copy counts.
      metrics.workerTasks.inc({ outcome: workerTaskOutcomeFor(warning.event) });
    },
  };

  /** Looked up per request. `closeSharedPool()` drops the memo, and a captured instance stays closed. */
  const currentPool = (): WorkerPool => getSharedPool(config, poolHooks);
  // Idempotent. Also bound in `routes/calc.ts`, so either module alone provides gauges and threads.
  bindCalculationPoolMetrics(peekSharedPool, metrics);
  app.addHook('onClose', async () => {
    await closeSharedPool();
  });

  const idSchema = { params: { $ref: 'prl:contentIdParams#' } };

  /** Per-caller, so never cached. */
  app.get('/content/lessons', async (request, reply): Promise<LessonListResponse> => {
    perCaller(reply);
    const userId = callerUserId(request);
    const completed = userId === null ? new Set<string>() : await completedLessonIds(userId);
    return {
      lessons: lessonsInReadingOrder().map((lesson) => lessonSummary(lesson, completed)),
    };
  });

  /** Identical for everybody, so cacheable. */
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

  /** Per-caller, so never cached. */
  app.get('/content/scenarios', async (request, reply): Promise<ScenarioListResponse> => {
    perCaller(reply);
    const userId = callerUserId(request);
    const attempted = userId === null ? new Set<string>() : await attemptedScenarioIds(userId);
    return { scenarios: scenarios().map((scenario) => scenarioSummary(scenario, attempted)) };
  });

  /** The analysis is computed on a worker the first time, then memoised. It is deterministic. */
  app.get<{ Params: IdParams }>('/content/scenarios/:id', { schema: idSchema }, async (request, reply) => {
    const scenario = scenarioById(request.params.id);
    if (scenario === null) {
      throw new AppError('content_not_found', { logDetail: `no scenario ${request.params.id}` });
    }
    return sendImmutable(request, reply, await scenarioPayload(currentPool(), scenario));
  });

  app.get('/content/glossary', (request, reply) =>
    sendImmutable(
      request,
      reply,
      payloadFor('glossary', (): GlossaryResponse => ({ entries: glossary() })),
    ),
  );

  /**
   * Records a lesson read. Completion is never inferred from `GET`, since prefetches and crawlers
   * look the same. A guest gets a 200 and nothing stored.
   */
  app.post<{ Params: IdParams; Body: LessonReadRequest }>(
    '/content/lessons/:id/read',
    { schema: { params: { $ref: 'prl:contentIdParams#' }, body: { $ref: 'prl:lessonReadBody#' } } },
    async (request, reply): Promise<LessonReadResponse> => {
      perCaller(reply);
      const lesson = lessonById(request.params.id);
      if (lesson === null) {
        throw new AppError('content_not_found', { logDetail: `no lesson ${request.params.id}` });
      }

      const userId = callerUserId(request);
      if (userId === null) {
        // Nothing stored. The reply keeps the member shape.
        return { lessonId: lesson.id, completedAt: null, lastViewedAt: new Date().toISOString() };
      }

      const row = await upsertLessonProgress(getSql(), {
        userId,
        lessonId: lesson.id,
        completed: request.body.completed,
      });
      return {
        lessonId: row.lesson_id,
        completedAt: row.completed_at === null ? null : row.completed_at.toISOString(),
        lastViewedAt: row.last_viewed_at.toISOString(),
      };
    },
  );

  /**
   * One quiz answer. Numeric answers are checked against the question's `calculation`, never a stored key.
   * Guests get a 200 with nothing stored. `recorded` says which, so the panel does not claim a save.
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
      const grade = await gradeQuestion(question, request.body.answer, { pool: currentPool(), limits });

      const userId = callerUserId(request);
      if (userId === null) {
        return { ...grade, recorded: false };
      }

      // Append-only, one row per answer, no aggregate. `repositories/progress.ts` owns the statement.
      await recordQuizAttempt(getSql(), {
        userId,
        quizId: quiz.id,
        questionId: question.id,
        answer: { ...request.body.answer },
        wasCorrect: grade.correct,
      });
      // Reached only after the insert succeeds. There is deliberately no catch.
      return { ...grade, recorded: true };
    },
  );

  /**
   * `consistentWithAnalysis` describes the analysis, not a mark. `matched_expected` is NULL when no
   * single action is supported.
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
      requirePayableSizing(scenario, request.body);
      const analysis = await reportFor(currentPool(), scenario);
      const consistency = consistencyOf(analysis, request.body.action, request.body.to, scenario.bigBlind);

      const userId = callerUserId(request);
      let recorded = false;
      if (userId !== null) {
        // NULL also when the analysis has no row for the learner's action.
        await recordScenarioAttempt(getSql(), {
          userId,
          scenarioId: scenario.id,
          action: request.body.action,
          ...(request.body.to === undefined ? {} : { to: request.body.to }),
          matchedExpected: consistency.priced && consistency.claimsOneAction ? consistency.consistent : null,
        });
        recorded = true;
      }

      return {
        consistentWithAnalysis: consistency.consistent,
        recorded,
        reasoning: `${consistency.reasoning} ${scenario.reasoning}`,
        analysis,
        commonMistakes: scenario.commonMistakes,
      };
    },
  );

  return Promise.resolve();
};

export default contentRoutes;

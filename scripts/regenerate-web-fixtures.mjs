#!/usr/bin/env node
/**
 * Regenerates the computed figures inside `apps/web/src/fixtures/`.
 *
 * ## Why this script exists
 *
 * `apps/web/src/fixtures/*` is the copy the web client renders when the API is unreachable. Every
 * number in it is a *computed* figure — an equity, an out count, a price, an expected value — and
 * the product's whole claim is that such a figure is never stale and never hand-written.
 *
 * `apps/api/test/web-fixture-figures.test.ts` enforces that by recomputing each figure and
 * comparing. Its failure message has always been "regenerate the fixture rather than editing the
 * number" — and until now **the repository contained nothing that could do so**. The result was
 * exactly what you would expect: the engine was fixed, the fixture was not regenerated, and the
 * Scenario Lab shipped a rule-of-2-and-4 estimate of `1.6` that the panel rendered as
 * "160.0%" — a probability above 100% in an application whose subject is probability. A guard
 * whose remedy is not executable is a guard that gets left red.
 *
 * So: this is the remedy, and it is deliberately the *same* computation the guard performs. If the
 * two ever disagree, the guard wins and this script is wrong.
 *
 *   node scripts/regenerate-web-fixtures.mjs            # rewrite the fixtures
 *   node scripts/regenerate-web-fixtures.mjs --check    # report drift, change nothing
 *
 * ## The reconstruction is duplicated, on purpose
 *
 * The hand-review rebuild below mirrors `web-fixture-figures.test.ts`'s own helpers. Importing them
 * would couple the remedy to the guard's internals and let a single edit move both together —
 * which is how a fixture and its check drift into agreeing with each other and disagreeing with the
 * engine. They are kept separate so that agreement is evidence.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(REPO, 'apps/web/src/fixtures');
const CHECK_ONLY = process.argv.includes('--check');

// Imported by path, not by bare specifier: this script lives at the repository root, which is not
// a workspace project and therefore cannot resolve `@prl/*`. Each package's own directory can, so
// resolution of their internal imports still works normally.
const fromRepo = (rel) => import(pathToFileURL(join(REPO, rel)).href);

//
// FROM `src/`, NOT `dist/`. These two read `dist/index.js` until 2026-08-27, which made this
// script answer its question — "are the fixtures what the engine produces today?" — against
// whatever the engine was the last time somebody ran `tsc`. A fix landed in `coach.ts` (the Coach
// told a hero with no equity "You clear that with 0.0% equity, a -24.3 point shortfall") and both
// `fixtures:check` and `fixtures:regenerate` reported the fixtures current while they still
// carried the wrong sentence. Building the two packages surfaced drift in five places at once.
//
// A staleness check was written first and thrown away: `tsc` does not rewrite an output whose
// content has not changed, so `dist` legitimately stays older than `src` and the guard refused a
// tree that was perfectly built. Reading the source removes the question instead of policing it —
// and `build-review.ts` below has always been imported this way, so nothing new is being asked of
// the runtime.
const { buildCoachReport, deriveContestablePot } = await fromRepo('packages/poker-math/src/index.ts');
const { readSituation, SCENARIO_ANALYSIS_SAMPLES, SCENARIO_ANALYSIS_SEED } = await fromRepo(
  'packages/content/src/index.ts',
);
const { buildHandReview } = await fromRepo('apps/api/src/review/build-review.ts');

const load = (file) => import(pathToFileURL(join(FIXTURES, file)).href);

// --- the Scenario Lab -------------------------------------------------------

// Imported, not restated. These must equal what `routes/content.ts` serves, because the fixture
// stands in for that route — and the comment here used to assert that agreement over two literals
// that nothing joined. `@prl/content` owns the pair now and all four consumers read it from there.
const SCENARIO_SAMPLES = SCENARIO_ANALYSIS_SAMPLES;
const SCENARIO_SEED = SCENARIO_ANALYSIS_SEED;

const opponentLabelFor = (scenario) =>
  scenario.opponentRange.kind === 'exact' ? 'the opponent' : scenario.opponentRange.label;

function reportForScenario(scenario) {
  const situation = readSituation(scenario);
  const heroSeat = scenario.seats.find((seat) => seat.isHero === true);
  return buildCoachReport({
    heroCards: [...situation.heroCards],
    board: [...situation.board],
    street: scenario.street,
    opponents: [{ label: opponentLabelFor(scenario), range: situation.opponentRange }],
    pot: situation.pot,
    // The pot hero can actually win. Below `situation.pot` only when a scenario's hero is all-in
    // for less than the bet in front of them, which is a side pot hero is not in. Derived rather
    // than layered because a scenario carries no complete per-seat record of the street — see
    // `routes/content.ts`, which this mirrors.
    contestablePot: deriveContestablePot({
      pot: situation.pot,
      toCall: situation.toCall,
      heroCommittedThisStreet: scenario.committedThisStreet?.[heroSeat?.seat ?? -1] ?? 0,
      heroStack: situation.heroStack,
      opponentStacks: [...situation.opponentStacks],
    }),
    toCall: situation.toCall,
    heroCommittedThisStreet: scenario.committedThisStreet?.[heroSeat?.seat ?? -1] ?? 0,
    heroStack: situation.heroStack,
    opponentStacks: [...situation.opponentStacks],
    bigBlind: scenario.bigBlind,
    samples: SCENARIO_SAMPLES,
    seed: SCENARIO_SEED,
  });
}

// --- the hand review --------------------------------------------------------

const REVIEW_CONFIG = { smallBlind: 10, bigBlind: 20, ante: 0, maxSeats: 6 };
const REVIEW_BUTTON_SEAT = 0;
const REVIEW_VIEWER = 'usr-you';

function reviewActionRows(review) {
  const rows = [];
  let potAfter = null;
  let street = null;
  let betLevel = REVIEW_CONFIG.bigBlind;
  for (const decision of review.decisions) {
    if (decision.street !== street) {
      street = decision.street;
      betLevel = decision.street === 'preflop' ? REVIEW_CONFIG.bigBlind : 0;
    }
    if (decision.to !== null) betLevel = Math.max(betLevel, decision.to);
    const potBefore = potAfter ?? decision.potBefore;
    const nextPotAfter = potBefore + decision.amountPaid;
    potAfter = nextPotAfter;
    rows.push({
      sequence: decision.sequence,
      street: decision.street,
      seat: decision.seat,
      action_type: decision.action,
      action_to: decision.to,
      amount_paid: decision.amountPaid,
      bet_level_after: betLevel,
      pot_after: nextPotAfter,
      was_automatic: decision.wasAutomatic,
    });
  }
  return rows;
}

const reviewSeatRows = (review) =>
  review.seats.map((seat) => ({
    seat: seat.seat,
    user_id: seat.seat === 0 ? REVIEW_VIEWER : `usr-bot-${seat.seat}`,
    display_name: seat.displayName,
    is_bot: seat.isBot,
    starting_stack: seat.startingStack,
    hole_cards: seat.holeCards === null ? null : [...seat.holeCards],
    net_result: seat.net,
    status: 'active',
    showed_down: seat.showedDown,
  }));

const rebuildReview = (review) =>
  buildHandReview(
    {
      hand: {
        id: review.hand.id,
        room_id: review.hand.roomId,
        hand_number: review.hand.handNumber,
        board: [...review.hand.board],
        result: { endedByFold: review.hand.endedByFold, pots: [{ amount: review.hand.potTotal }] },
        started_at: review.hand.startedAt,
        completed_at: review.hand.completedAt,
        button_seat: REVIEW_BUTTON_SEAT,
        config: REVIEW_CONFIG,
        commitment_root: review.commitmentRoot,
        commitment_context: review.commitmentContext,
        street: review.decisions.at(-1)?.street ?? 'preflop',
        reveal: review.reveal,
      },
      seats: reviewSeatRows(review),
      actions: reviewActionRows(review),
      viewerUserId: REVIEW_VIEWER,
      maxPotAfter: review.hand.potTotal,
    },
    { budgetMs: 600_000, maxAnalysedDecisions: 32 },
  );

// --- emitting ---------------------------------------------------------------

/** A TypeScript object literal. Keys are quoted only where they must be, so the output reads. */
function emit(value, indent = 0) {
  const pad = '  '.repeat(indent);
  const inner = '  '.repeat(indent + 1);
  if (value === null) return 'null';
  if (typeof value === 'number') return Object.is(value, -0) ? '0' : String(value);
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[\n${value.map((v) => `${inner}${emit(v, indent + 1)}`).join(',\n')},\n${pad}]`;
  }
  const entries = Object.entries(value).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return '{}';
  const body = entries
    .map(
      ([k, v]) => `${inner}${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}: ${emit(v, indent + 1)}`,
    )
    .join(',\n');
  return `{\n${body},\n${pad}}`;
}

/** Replaces the body of `export const <name>...= { … };` leaving every comment around it intact. */
function spliceConstant(source, name, literal) {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`export const ${name}`));
  if (start === -1) throw new Error(`${name} not found`);
  let end = -1;
  for (let i = start; i < lines.length; i++) {
    if (lines[i] === '};') {
      end = i;
      break;
    }
  }
  if (end === -1) throw new Error(`${name} has no terminator`);
  const header = lines[start].replace(/\{\s*$/, '').trimEnd();
  return [...lines.slice(0, start), `${header} ${literal};`, ...lines.slice(end + 1)].join('\n');
}

// --- run --------------------------------------------------------------------

const drift = [];

const scenariosModule = await load('scenarios.ts');
const analysis = {};
for (const scenario of scenariosModule.LAB_SCENARIOS) {
  const rebuilt = reportForScenario(scenario);
  const stored = scenariosModule.LAB_SCENARIO_ANALYSIS[scenario.id];
  if (JSON.stringify(stored) !== JSON.stringify(rebuilt)) drift.push(`scenarios.ts  ${scenario.id}`);
  analysis[scenario.id] = rebuilt;
}

const reviewModule = await load('review.ts');
const reviews = {};
for (const name of ['REVIEW_HAND_SHOWDOWN', 'REVIEW_HAND_FOLDED']) {
  const stored = reviewModule[name];
  const rebuilt = rebuildReview(stored);
  const merged = {
    ...stored,
    decisions: stored.decisions.map((d, i) => ({ ...d, analysis: rebuilt.decisions[i].analysis })),
  };
  const a = JSON.stringify(stored.decisions.map((d) => d.analysis));
  const b = JSON.stringify(rebuilt.decisions.map((d) => d.analysis));
  if (a !== b) drift.push(`review.ts     ${name}`);
  reviews[name] = merged;
}

if (drift.length === 0) {
  console.log('web fixtures are already the analysis the engine produces today');
  process.exit(0);
}
console.log(`stale computed figures in ${drift.length} place(s):`);
for (const d of drift) console.log(`  · ${d}`);

if (CHECK_ONLY) {
  console.error('\n--check: not rewriting. Run without --check to regenerate.');
  process.exit(1);
}

let scenariosSource = readFileSync(join(FIXTURES, 'scenarios.ts'), 'utf8');
scenariosSource = spliceConstant(scenariosSource, 'LAB_SCENARIO_ANALYSIS', emit(analysis));
writeFileSync(join(FIXTURES, 'scenarios.ts'), scenariosSource);

let reviewSource = readFileSync(join(FIXTURES, 'review.ts'), 'utf8');
for (const name of ['REVIEW_HAND_SHOWDOWN', 'REVIEW_HAND_FOLDED']) {
  reviewSource = spliceConstant(reviewSource, name, emit(reviews[name]));
}
writeFileSync(join(FIXTURES, 'review.ts'), reviewSource);

console.log('\nregenerated. Run `pnpm run format` then the fixture guard.');

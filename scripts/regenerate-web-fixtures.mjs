#!/usr/bin/env node
/**
 * Regenerates the computed figures inside `apps/web/src/fixtures/`, the copy the web client renders
 * when the API is unreachable.
 *
 *   node scripts/regenerate-web-fixtures.mjs            # rewrite the fixtures
 *   node scripts/regenerate-web-fixtures.mjs --check    # report drift, change nothing
 *
 * `apps/api/test/web-fixture-figures.test.ts` is the guard; if the two disagree, the guard wins.
 * The hand-review rebuild duplicates the guard's helpers on purpose, so one edit cannot move both.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(REPO, 'apps/web/src/fixtures');
const CHECK_ONLY = process.argv.includes('--check');

// By path, because the repository root is not a workspace project and cannot resolve `@prl/*`.
const fromRepo = (rel) => import(pathToFileURL(join(REPO, rel)).href);

// From `src/`, not `dist/`, so a stale build cannot make stale fixtures look current. An mtime
// staleness check was rejected because `tsc` leaves an unchanged output's timestamp alone.
const { buildCoachReport, deriveContestablePot, exactRange } = await fromRepo(
  'packages/poker-math/src/index.ts',
);
const { parseCards } = await fromRepo('packages/poker-engine/src/index.ts');
const { readSituation, SCENARIO_ANALYSIS_SAMPLES, SCENARIO_ANALYSIS_SEED } = await fromRepo(
  'packages/content/src/index.ts',
);
const { buildHandReview } = await fromRepo('apps/api/src/review/build-review.ts');

// `buildHandReview` still imports `@prl/poker-math` through node_modules, which resolves to `dist/`.
// So refuse a `dist/` whose output differs from `src/` on one deterministic report.
const distMath = await fromRepo('packages/poker-math/dist/index.js');
const PROBE = {
  heroCards: parseCards('Ah 6h'),
  board: parseCards('Kh 9h 4s 2c'),
  street: 'turn',
  opponents: [{ label: 'the opponent', range: exactRange(parseCards('Kd 9c')) }],
  pot: 220,
  contestablePot: 220,
  toCall: 80,
  heroCommittedThisStreet: 0,
  heroStack: 300,
  opponentStacks: [300],
  bigBlind: 10,
};
{
  const fromSource = JSON.stringify(buildCoachReport(PROBE));
  const fromBuild = JSON.stringify(distMath.buildCoachReport(PROBE));
  if (fromSource !== fromBuild) {
    console.error(
      'packages/poker-math/dist disagrees with its src, and `buildHandReview` reads the built copy.\n' +
        'The hand-review fixtures would be compared against a stale engine and called current.\n' +
        'Run: pnpm --filter ./packages/poker-math build',
    );
    process.exit(78);
  }
}

const load = (file) => import(pathToFileURL(join(FIXTURES, file)).href);

// Imported from `@prl/content`, which owns the pair that `routes/content.ts` also serves.
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
    // The pot hero can win, which is below `situation.pot` only when hero is all-in for less than the
    // bet. Mirrors `routes/content.ts`.
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
      automatic_reason: decision.automaticReason ?? null,
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

// Replaces the body of `export const <name>...= { … };` and leaves the comments around it intact.
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

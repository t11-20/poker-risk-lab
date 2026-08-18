/**
 * The web app's offline fixtures still agree with the engine that produced them.
 *
 * ## Why this exists
 *
 * `apps/web/src/fixtures/scenarios.ts` and `.../review.ts` are generated: every `CoachReport` in
 * them came out of `buildCoachReport` (via `readSituation`) and `buildHandReview`. Generated data
 * with no test is data that silently becomes wrong the moment the generator changes, and it did —
 * the Coach's raise arithmetic was corrected to charge hero the call as well as the increment, and
 * both fixtures went on serving the old figures, which overstate every raise by `(1-f)·C·(1-e)`.
 * Always positive, worse the lower hero's equity, and pointed the one direction a teaching product
 * must not be wrong in: it flatters aggression.
 *
 * The fix was to regenerate them. This is what stops the next generator change from needing anybody
 * to remember: it recomputes both fixtures from the current functions and asserts the stored figures
 * are what those functions produce today. It fails loudly rather than drifting quietly, and its
 * failure message is "regenerate the fixture", not "edit a number".
 *
 * ## Why the review fixture is rebuilt from reconstructed rows
 *
 * `buildHandReview` takes database rows, and the fixture is its output — the rows themselves were
 * never checked in. They are reconstructed here from the fixture's own replay, and the
 * reconstruction is *proved* rather than assumed: everything the review reports other than the
 * per-decision analysis has to come back byte-identical. A wrong button seat, blind or action row
 * would move a pot, a stack or a street and that comparison would fail first, so a passing analysis
 * comparison is a comparison against a faithfully replayed hand.
 *
 * ## Why an API test reads web files
 *
 * `buildHandReview` lives in this app, and `apps/web` is a separate TypeScript program that cannot
 * be imported statically from here. The fixtures are loaded at runtime by URL and narrowed
 * explicitly, the same way `legends-naming-fallback.test.ts` does it.
 */

import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readSituation } from '@prl/content';
import type { CoachReport, HandReviewResponse, Scenario } from '@prl/contracts';
import { buildCoachReport } from '@prl/poker-math';
import { buildHandReview, type HandActionRow, type HandSeatRow } from '../src/review/build-review.ts';

const WEB_FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'src', 'fixtures');

/** The sample count and seed the fixture header names, and the API's own `CONTENT_SAMPLES`/`CONTENT_SEED`. */
const SCENARIO_SAMPLES = 40_000;
const SCENARIO_SEED = 20_260_817;

/*
 * There used to be a `normaliseRuleOfThumb` helper here, dividing the producer's
 * `ruleOfThumb.estimate` by 100 before every comparison, with a comment explaining that
 * `@prl/poker-math` published a percentage while `@prl/ui` rendered a fraction.
 *
 * That helper was the bug, written down and accepted. The two sides genuinely disagreed about
 * the unit, `@prl/ui` multiplied by 100 a second time, and a shipped panel told learners a
 * nine-out flush draw was "3,600.0%". This test compensated for the mismatch instead of
 * failing on it — which is what a fixture comparison is for — and so held it in place.
 *
 * `estimate` is now a fraction in 0..1 on both sides, like every other probability on this
 * contract, so there is nothing to normalise and the reports are compared as they are.
 */

async function loadWebFixture(file: string): Promise<Record<string, unknown>> {
  const module: unknown = await import(pathToFileURL(join(WEB_FIXTURES, file)).href);
  assert.ok(typeof module === 'object' && module !== null, `${file} did not load`);
  return module as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// The Scenario Lab fixture
// ---------------------------------------------------------------------------

/** The label `routes/content.ts` gives the opponent, so the fixture reads exactly like the wire. */
function opponentLabelFor(scenario: Scenario): string {
  const spec = scenario.opponentRange;
  return spec.kind === 'exact' ? 'the opponent' : spec.label;
}

function reportForScenario(scenario: Scenario): CoachReport {
  const situation = readSituation(scenario);
  const heroSeat = scenario.seats.find((seat) => seat.isHero === true);
  return buildCoachReport({
    heroCards: [...situation.heroCards],
    board: [...situation.board],
    street: scenario.street,
    opponents: [{ label: opponentLabelFor(scenario), range: situation.opponentRange }],
    pot: situation.pot,
    toCall: situation.toCall,
    heroCommittedThisStreet: scenario.committedThisStreet?.[heroSeat?.seat ?? -1] ?? 0,
    heroStack: situation.heroStack,
    opponentStacks: [...situation.opponentStacks],
    bigBlind: scenario.bigBlind,
    samples: SCENARIO_SAMPLES,
    seed: SCENARIO_SEED,
  });
}

describe('the Scenario Lab fixture is the analysis the engine produces today', () => {
  it('matches buildCoachReport for every bundled scenario', async () => {
    const module = await loadWebFixture('scenarios.ts');
    const scenarios = module['LAB_SCENARIOS'] as readonly Scenario[];
    const stored = module['LAB_SCENARIO_ANALYSIS'] as Readonly<Record<string, CoachReport>>;
    assert.ok(Array.isArray(scenarios) && scenarios.length > 0, 'the fixture bundles no scenarios');

    for (const scenario of scenarios) {
      const fixture = stored[scenario.id];
      assert.ok(fixture !== undefined, `${scenario.id} has no stored analysis`);
      assert.deepEqual(
        fixture,
        reportForScenario(scenario),
        `${scenario.id}'s stored analysis is not what the engine computes now — regenerate the fixture ` +
          'rather than editing the number',
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The hand-review fixture
// ---------------------------------------------------------------------------

/**
 * The table these fixture hands were played at.
 *
 * Read off the hands rather than chosen: seat 1 folds preflop for a net of -10 and seat 2 pays 40 to
 * call a raise to 60, so the blinds are 10 and 20; seat 0 acts first preflop three-handed, which
 * makes it the button.
 */
const REVIEW_CONFIG = { smallBlind: 10, bigBlind: 20, ante: 0, maxSeats: 6 };
const REVIEW_BUTTON_SEAT = 0;
const REVIEW_VIEWER = 'usr-you';

/**
 * The action rows behind a review, with the two engine-authoritative columns re-derived.
 *
 * `pot_after` is the running total, and `bet_level_after` is the highest total committed on the
 * street so far — seeded at the big blind preflop, because that is a live bet everyone else has to
 * match. Both are checked by the replay itself: `buildHandReview` compares its own reconstruction
 * against them and refuses to analyse a decision where the two disagree.
 */
function reviewActionRows(review: HandReviewResponse): readonly HandActionRow[] {
  const rows: HandActionRow[] = [];
  let potAfter: number | null = null;
  let street: string | null = null;
  let betLevel = REVIEW_CONFIG.bigBlind;
  for (const decision of review.decisions) {
    if (decision.street !== street) {
      street = decision.street;
      betLevel = decision.street === 'preflop' ? REVIEW_CONFIG.bigBlind : 0;
    }
    if (decision.to !== null) betLevel = Math.max(betLevel, decision.to);
    // The first action's own `potBefore` seeds the chain; after that the engine's running total is
    // the only figure that may be trusted, so it is carried rather than re-read.
    const potBefore: number = potAfter ?? decision.potBefore;
    const nextPotAfter: number = potBefore + decision.amountPaid;
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

function reviewSeatRows(review: HandReviewResponse): readonly HandSeatRow[] {
  return review.seats.map((seat) => ({
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
}

function rebuildReview(review: HandReviewResponse): HandReviewResponse {
  const rebuilt = buildHandReview(
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
    // Generous where the route is stingy: the route's budget is about a request deadline, and
    // inheriting it here would make the fixture's correctness depend on how busy this machine is.
    { budgetMs: 600_000, maxAnalysedDecisions: 32 },
  );
  return rebuilt;
}

/** The review with every analysis replaced by a marker, for proving the replay before the figures. */
function withoutAnalyses(review: HandReviewResponse): unknown {
  return {
    ...review,
    decisions: review.decisions.map((decision) => ({
      ...decision,
      analysis: decision.analysis === null ? null : 'present',
    })),
  };
}

describe('the hand-review fixture is the review the builder produces today', () => {
  for (const name of ['REVIEW_HAND_SHOWDOWN', 'REVIEW_HAND_FOLDED']) {
    it(`${name} replays and analyses identically`, async () => {
      const module = await loadWebFixture('review.ts');
      const stored = module[name] as HandReviewResponse;
      assert.ok(stored !== undefined, `${name} is not exported`);
      const rebuilt = rebuildReview(stored);

      // First: the replay. If this fails the reconstruction above is wrong and the figure comparison
      // below would be meaningless rather than merely failing.
      assert.deepEqual(
        withoutAnalyses(stored),
        withoutAnalyses(rebuilt),
        `${name} does not replay from its own rows — the reconstruction in this test is wrong`,
      );

      // Then: the figures.
      assert.deepEqual(
        stored.decisions.map((decision) => decision.analysis),
        rebuilt.decisions.map((decision) => decision.analysis),
        `${name}'s stored analyses are not what buildHandReview computes now — regenerate the fixture`,
      );
    });
  }
});

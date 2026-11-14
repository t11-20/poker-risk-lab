/**
 * The web app's generated offline fixtures still match the engine. Recomputes every `CoachReport`
 * and fails with "regenerate the fixture" (`pnpm run fixtures:regenerate`). The review fixture is
 * rebuilt from reconstructed rows, proved by requiring everything but the analyses to come back
 * byte-identical. `apps/web` cannot be imported statically, so fixtures are loaded by URL.
 */

import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readSituation, SCENARIO_ANALYSIS_SAMPLES, SCENARIO_ANALYSIS_SEED } from '@prl/content';
import type { CoachReport, HandReviewResponse, Scenario } from '@prl/contracts';
import { buildCoachReport, deriveContestablePot } from '@prl/poker-math';
import { buildHandReview, type HandActionRow, type HandSeatRow } from '../src/review/build-review.ts';

const WEB_FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'src', 'fixtures');

/** Imported, not restated, so the fixture and the API cannot disagree on samples or seed. */
const SCENARIO_SAMPLES = SCENARIO_ANALYSIS_SAMPLES;
const SCENARIO_SEED = SCENARIO_ANALYSIS_SEED;

// `ruleOfThumb.estimate` is a fraction in 0..1 on both sides, so reports are compared without normalising.

async function loadWebFixture(file: string): Promise<Record<string, unknown>> {
  const module: unknown = await import(pathToFileURL(join(WEB_FIXTURES, file)).href);
  assert.ok(typeof module === 'object' && module !== null, `${file} did not load`);
  return module as Record<string, unknown>;
}

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
    // The described-spot derivation, as `routes/content.ts` uses, because a scenario has no full
    // per-seat record of the street.
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

/**
 * Read off the hands, with blinds 10 and 20 and seat 0 the button. All five members of
 * `hands_config_shape` are present, as on every stored row.
 */
const REVIEW_CONFIG = { smallBlind: 10, bigBlind: 20, ante: 0, maxSeats: 6, actionTimeoutSeconds: 30 };
const REVIEW_BUTTON_SEAT = 0;
const REVIEW_VIEWER = 'usr-you';

/** `bet_level_after` starts at the big blind preflop. `buildHandReview` checks both against its replay. */
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
      automatic_reason: decision.automaticReason,
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
        random_source_kind: 'csprng' as const,
        street: review.decisions.at(-1)?.street ?? 'preflop',
        reveal: review.reveal,
      },
      seats: reviewSeatRows(review),
      actions: reviewActionRows(review),
      viewerUserId: REVIEW_VIEWER,
      maxPotAfter: review.hand.potTotal,
    },
    // The route's budget is a request deadline, so a busy machine must not decide correctness here.
    { budgetMs: 600_000, maxAnalysedDecisions: 32 },
  );
  return rebuilt;
}

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

      // The replay first, so a wrong reconstruction fails before the figures.
      assert.deepEqual(
        withoutAnalyses(stored),
        withoutAnalyses(rebuilt),
        `${name} does not replay from its own rows — the reconstruction in this test is wrong`,
      );

      assert.deepEqual(
        stored.decisions.map((decision) => decision.analysis),
        rebuilt.decisions.map((decision) => decision.analysis),
        `${name}'s stored analyses are not what buildHandReview computes now — regenerate the fixture`,
      );
    });
  }
});

/**
 * A validated `Spot` as the Coach's input, built the way `coachTaskFor` in `apps/api/src/routes/content.ts`
 * builds a scenario's, so an unedited built-in prices to the byte the Lab page already shows.
 * `apps/api/test/lab-spot-conversion.test.ts` holds that for every bundled scenario.
 *
 * Not `coachInputFor` from `coach-view.ts`: its `AssumedRange` has no exact hand and its `CoachSpot`
 * requires a `minimumRaiseTo` that a described spot does not have.
 */

import type { CoachReport } from '@prl/contracts';
import {
  type AssumedRange,
  buildCoachReport,
  type CoachInput,
  deriveContestablePot,
  deriveLegalActions,
  exactRange,
  expandAssumedRange,
} from '@prl/poker-math';
import { type OpponentHand, type Spot, streetOf } from './spot.ts';
import { topPercentOf, undealableSentence } from './spot-validate.ts';

/**
 * `SCENARIO_ANALYSIS_SAMPLES` and `SCENARIO_ANALYSIS_SEED` from `@prl/content`, restated because the
 * content bundle must stay out of the browser. `test/lab-spot-editing.test.ts` holds them equal.
 */
export const SPOT_SAMPLES = 40_000;
export const SPOT_SEED = 20_260_817;

export function assumedRangeOf(text: string): AssumedRange {
  const share = topPercentOf(text);
  return share === null ? { kind: 'notation', notation: text } : { kind: 'topPercent', percent: share };
}

function expandHand(hand: Exclude<OpponentHand, { kind: 'none' }>, dead: readonly number[]) {
  return hand.kind === 'cards' ? exactRange(hand.cards) : expandAssumedRange(assumedRangeOf(hand.text), dead);
}

export function coachInputForSpot(spot: Spot): CoachInput {
  const heroCards = [...spot.hero.cards];
  const board = [...spot.board];
  const dead = [...heroCards, ...board];
  const opponents = spot.opponents.flatMap((opponent) =>
    opponent.hand.kind === 'none' ? [] : [{ label: opponent.name, range: expandHand(opponent.hand, dead) }],
  );
  const opponentStacks = spot.opponents.map((opponent) => ({
    behind: opponent.stack - opponent.bet,
    committedThisStreet: opponent.bet,
  }));
  const priced = {
    pot: spot.potBefore + spot.hero.bet + spot.opponents.reduce((sum, opponent) => sum + opponent.bet, 0),
    toCall: Math.max(...spot.opponents.map((opponent) => opponent.bet)) - spot.hero.bet,
    heroCommittedThisStreet: spot.hero.bet,
    heroStack: spot.hero.stack - spot.hero.bet,
    opponentStacks,
  };
  return {
    heroCards,
    board,
    street: streetOf(spot.board),
    opponents,
    ...priced,
    contestablePot: deriveContestablePot(priced),
    bigBlind: spot.bigBlind,
    legalActions: deriveLegalActions(priced),
    ...(spot.neverFolds ? { wholeRangeContinues: true } : {}),
    ...(spot.foldRate === null ? {} : { assumedFoldEquity: spot.foldRate }),
    samples: SPOT_SAMPLES,
    seed: SPOT_SEED,
  };
}

export type SpotReport =
  | { readonly ok: true; readonly report: CoachReport }
  | { readonly ok: false; readonly message: string };

/**
 * Never throws. The validator should leave nothing for `buildCoachReport` to refuse, so a refusal here
 * is shown as a sentence and never as numbers.
 */
export function reportForSpot(spot: Spot): SpotReport {
  try {
    const input = coachInputForSpot(spot);
    // `top:NN` is expanded only here, so its share of the dealability check waits until now.
    const undealable = undealableSentence(input.opponents.map((opponent) => opponent.range.combos));
    if (undealable !== null) return { ok: false, message: undealable };
    if (input.opponents.some((opponent) => opponent.range.combos.length === 0)) {
      return { ok: false, message: 'Every hand in one of these ranges uses a card already in play.' };
    }
    return { ok: true, report: buildCoachReport(input) };
  } catch {
    return {
      ok: false,
      message:
        'These numbers could not be worked out for this spot. Change a field and they will be tried again.',
    };
  }
}

/**
 * A built-in scenario as an editable draft, read the way `readSituation` and `coachTaskFor` read it, so
 * an unedited copy prices exactly as the original. Folded seats are not opponents: their chips this
 * street go into the pot. A scenario names one range for the opponent who continues, so only one seat
 * carries it, unless a seat is all in, where the API deals the range to every seat.
 */

import type { Scenario } from '@prl/contracts';
import {
  BOARD_SLOTS,
  type CardSlotId,
  cardsFromText,
  EMPTY_CARDS,
  type OpponentDraft,
  type SpotDraft,
} from './spot.ts';

/** The API labels an exact holding "the opponent" and a range by its own label. */
function rangeLabel(scenario: Scenario): string {
  const range = scenario.opponentRange;
  return range.kind === 'exact' ? 'the opponent' : range.label;
}

function handOf(scenario: Scenario): Pick<OpponentDraft, 'handKind' | 'range' | 'cards'> | null {
  const range = scenario.opponentRange;
  if (range.kind === 'notation') return { handKind: 'range', range: range.notation, cards: [null, null] };
  if (range.kind === 'topPercent')
    return { handKind: 'range', range: `top:${range.percent}`, cards: [null, null] };
  const cards = cardsFromText(range.cards);
  if (cards === null || cards.length !== 2) return null;
  return { handKind: 'cards', range: '', cards: [cards[0] ?? null, cards[1] ?? null] };
}

/** `null` when the scenario's cards do not parse, which content validation already refuses. */
export function draftFromScenario(scenario: Scenario): SpotDraft | null {
  const hero = scenario.seats.find((seat) => seat.isHero === true);
  if (hero?.holeCards === undefined) return null;
  const hole = cardsFromText(hero.holeCards);
  const board = cardsFromText(scenario.board);
  const hand = handOf(scenario);
  if (hole === null || hole.length !== 2 || board === null || board.length > 5 || hand === null) return null;

  const committed = scenario.committedThisStreet ?? {};
  const inFor = (seat: number): number => committed[seat] ?? 0;
  const live = scenario.seats.filter((seat) => seat.isHero !== true && seat.folded !== true);
  const folded = scenario.seats.filter((seat) => seat.folded === true);
  const anyAllIn = live.some((seat) => seat.stack === 0);

  const cards: Record<CardSlotId, number | null> = {
    ...EMPTY_CARDS,
    hole1: hole[0] ?? null,
    hole2: hole[1] ?? null,
  };
  for (const [index, slot] of BOARD_SLOTS.entries()) cards[slot] = board[index] ?? null;

  const heroBet = inFor(hero.seat);
  const opponents = live.map((seat, index): OpponentDraft => {
    const carries = anyAllIn || index === 0;
    return {
      key: `s${seat.seat}`,
      name: carries ? rangeLabel(scenario) : seat.label,
      stack: String(seat.stack + inFor(seat.seat)),
      bet: String(inFor(seat.seat)),
      ...(carries ? hand : { handKind: 'none', range: '', cards: [null, null] }),
    };
  });

  return {
    name: scenario.title,
    cards,
    heroStack: String(hero.stack + heroBet),
    heroBet: String(heroBet),
    potBefore: String(scenario.potBeforeStreet + folded.reduce((sum, seat) => sum + inFor(seat.seat), 0)),
    bigBlind: String(scenario.bigBlind),
    opponents,
    neverFolds: scenario.wholeRangeContinues === true,
    // Rounded to the tenth the field accepts, because 0.35 * 100 is 35.00000000000001.
    foldRate:
      scenario.assumedFoldEquity === undefined
        ? ''
        : String(Math.round(scenario.assumedFoldEquity * 1000) / 10),
  };
}

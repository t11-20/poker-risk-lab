/**
 * The Coach's input for one decision, read off the redacted view of the seat that has to make it.
 * The API and the chat bot both call this, so every figure-deciding question is answered once.
 * Seat labels count from one, as everywhere else a learner sees a seat number.
 *
 * Ranges come back described, not expanded. Expanding `top:NN` builds the preflop ordering (about
 * three seconds the first time on a thread), so `coachInputFor` does it on a calculator thread.
 */

import { type Card, contestablePotFor, type PlayerView, type SeatIndex } from '@prl/poker-engine';
import type { CoachAction, CoachInput } from './coach.ts';
import { topPercentRange } from './hand-ranking.ts';
import { type ParsedRange, parseRange } from './ranges.ts';

/** An opponent's range in either form the contract's `RANGE_PATTERN` accepts, not yet expanded. */
export type AssumedRange =
  | { readonly kind: 'topPercent'; readonly percent: number }
  | { readonly kind: 'notation'; readonly notation: string };

/** What the Coach assumes about a spot that the view cannot tell it, and how hard it samples. */
export interface CoachPolicy {
  /** The same range for every opponent: a per-seat read is information no view carries. */
  readonly range: AssumedRange;
  readonly samples: number;
  readonly seed: number;
}

/** The live Coach's assumptions in every client. The seed is `1`, the old `monteCarloEquity` default. */
export const LIVE_COACH_POLICY = {
  range: { kind: 'topPercent', percent: 40 },
  samples: 2_000,
  seed: 1,
} as const satisfies CoachPolicy;

/** `CoachInput` for one view's decision, with each opponent's range still described. */
export interface CoachSpot
  extends Omit<CoachInput, 'opponents' | 'minimumRaiseTo' | 'legalActions' | 'samples' | 'seed'> {
  readonly opponents: readonly { readonly label: string; readonly range: AssumedRange }[];
  readonly minimumRaiseTo: number;
  readonly legalActions: readonly CoachAction[];
  readonly samples: number;
  readonly seed: number;
}

/** Why a view has no decision for the Coach to read. Each client words it for its own reader. */
export type CoachRefusal =
  | { readonly kind: 'not-seated' }
  | { readonly kind: 'hand-over'; readonly street: 'showdown' | 'complete' }
  | { readonly kind: 'no-opponent' }
  | { readonly kind: 'betting-closed' }
  | { readonly kind: 'not-to-act'; readonly seat: SeatIndex; readonly toAct: SeatIndex | null };

export type CoachSpotReading =
  | { readonly kind: 'spot'; readonly spot: CoachSpot }
  | { readonly kind: 'refused'; readonly refusal: CoachRefusal };

/**
 * How a client names seats, since a view carries a `playerId` per seat and no name. Without it every
 * seat is `seat N`, which keeps `test/fixtures/coach-views.json` and the bot's output stable. The API
 * passes the names the table dealt in, so the Coach matches the seat plates.
 */
export type SeatNamer = (seat: SeatIndex) => string | undefined;

/**
 * A seat's own label: the client's name for it, or its one-based number. A blank name, "you" in any
 * case (`holdsClause` in `equity.ts` would read it as the reader) and a name shaped like a generated
 * label ("seat 4", "... (seat 4)") all fall back to the number. That lets `opponentLabels` dedupe in
 * one pass.
 */
function seatLabel(seat: SeatIndex, nameOf: SeatNamer | undefined): string {
  const name = nameOf?.(seat)?.trim() ?? '';
  const unusable = name === '' || name.toLowerCase() === 'you' || GENERATED_LABEL.test(name);
  return unusable ? `seat ${seat + 1}` : name;
}

const GENERATED_LABEL = /^seat \d+$|\(seat \d+\)$/iu;

/**
 * Each opponent's label, unique among every other seat in the view. Display names are not unique,
 * so a shared name gets its seat number, "Alex (seat 2)". The comparison covers folded seats too,
 * since they are still on a plate, and ignores case, since `holdsClause` capitalises.
 */
function opponentLabels(
  view: PlayerView,
  opponents: readonly { readonly seat: SeatIndex }[],
  nameOf: SeatNamer | undefined,
): readonly string[] {
  const seen = new Map<string, number>();
  for (const seat of view.seats) {
    if (seat.isSelf) continue;
    const key = seatLabel(seat.seat, nameOf).toLowerCase();
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return opponents.map(({ seat }) => {
    const label = seatLabel(seat, nameOf);
    return (seen.get(label.toLowerCase()) ?? 0) > 1 ? `${label} (seat ${seat + 1})` : label;
  });
}

/**
 * Reads the decision in one view, or says why there is none. It takes the view alone, so it cannot
 * analyse an opponent's decision. `legalActions` comes from the view, filled only for the seat to
 * act, so an empty list is a refusal, never "everything is legal".
 */
export function coachSpotForView(
  view: PlayerView,
  policy: CoachPolicy,
  nameOf?: SeatNamer,
): CoachSpotReading {
  const own = view.seats.find((seat) => seat.isSelf);
  const heroCards = own?.holeCards ?? null;
  if (own === undefined || heroCards === null) return refused({ kind: 'not-seated' });
  const street = view.street;
  if (street === 'showdown' || street === 'complete') return refused({ kind: 'hand-over', street });
  const opponents = view.seats.filter(
    (seat) => !seat.isSelf && (seat.status === 'active' || seat.status === 'allIn'),
  );
  if (opponents.length === 0) return refused({ kind: 'no-opponent' });
  const legalActions: readonly CoachAction[] = view.legalActions.map((entry) => entry.type);
  if (legalActions.length === 0) {
    return refused(
      view.toAct === own.seat
        ? { kind: 'betting-closed' }
        : { kind: 'not-to-act', seat: own.seat, toAct: view.toAct },
    );
  }
  // Every seat is passed, folded ones included, because their chips are in the middle. `amountToCall`
  // is already capped at hero's stack.
  const { contestable } = contestablePotFor({
    seats: view.seats,
    heroSeat: own.seat,
    callAmount: view.amountToCall,
    potTotal: view.potTotal,
  });
  return {
    kind: 'spot',
    spot: {
      heroCards,
      board: view.board,
      street,
      // Five is `buildCoachReport`'s ceiling, and a six-max table cannot exceed it.
      opponents: opponentLabels(view, opponents.slice(0, 5), nameOf).map((label) => ({
        label,
        range: policy.range,
      })),
      pot: view.potTotal,
      contestablePot: contestable,
      toCall: view.amountToCall,
      heroCommittedThisStreet: own.committedThisStreet,
      heroStack: own.stack,
      opponentStacks: opponents.map((seat) => seat.stack),
      bigBlind: view.config.bigBlind,
      minimumRaiseTo: view.minimumRaiseTo,
      legalActions,
      samples: policy.samples,
      seed: policy.seed,
    },
  };
}

function refused(refusal: CoachRefusal): CoachSpotReading {
  return { kind: 'refused', refusal };
}

/** The spot as `buildCoachReport` takes it, each range expanded against hero's cards and the board. */
export function coachInputFor(spot: CoachSpot): CoachInput {
  const dead = [...spot.heroCards, ...spot.board];
  return {
    ...spot,
    opponents: spot.opponents.map((opponent) => ({
      label: opponent.label,
      range: expandAssumedRange(opponent.range, dead),
    })),
  };
}

/**
 * One assumed range as combinations, none holding a `dead` card. `top:NN` goes through `parseRange`
 * too, because `topPercentRange` ignores blockers.
 */
export function expandAssumedRange(range: AssumedRange, dead: readonly Card[]): ParsedRange {
  const notation = range.kind === 'topPercent' ? topPercentRange(range.percent).notation : range.notation;
  return parseRange(notation, dead);
}

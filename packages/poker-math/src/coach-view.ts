/**
 * The Coach's input for one decision, read off the redacted view of the seat that has to make it.
 *
 * ## Why this is one function in this package
 *
 * Two clients built it. The API read a `PlayerView` into a Coach task in `apps/api/src/ws/router.ts`,
 * and the chat bot carried a copy with a comment naming the original, because an app may not import
 * an app. The copies already disagreed: the bot labelled opponents `seat N+1`, the API `seat N`, so
 * the same spot printed a different assumptions list in each client. Every question that decides a
 * figure — who is still contesting the pot, which part of it this seat can win, what the seat has
 * already put in, which actions the engine allows, which range each opponent is assumed to hold,
 * how many samples and which seed — is answered here once, and both clients call it.
 *
 * The API's `seat N` was kept at first, so that the move changed no byte. It was the wrong one to
 * keep: every other place a learner sees a seat number counts from one ("Take seat 1", "Seat 2 ran
 * out of time"), so the assumptions list named a "seat 0" that appears nowhere else on screen.
 *
 * ## Why the ranges come back described, not expanded
 *
 * `top:NN` can only be expanded by building the preflop strength ordering, about three seconds
 * the first time a thread asks. The API sends the spot to a calculator thread for exactly that
 * reason, so `coachSpotForView` stays microseconds and leaves each range as an `AssumedRange`.
 * `coachInputFor` expands them, on whichever thread is allowed to pay for it.
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

/**
 * The live Coach's assumptions, in every client.
 *
 * Changing any of these changes every live Coach figure in the product. The seed is `1` because
 * that is what `monteCarloEquity` used when the live path named none.
 */
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
 * How a client names the seats a view cannot: the view carries a `playerId` per seat and no name.
 *
 * Optional, and every caller that passes nothing gets `seat N` exactly as before, so the pinned
 * reports in `test/fixtures/coach-views.json` and the chat bot's assumptions list do not move.
 *
 * It exists because the live table named players two ways at once. The seat plates show a name and
 * a position and no number, and the Coach beside them listed "seat 2 / seat 3 / seat 6" under
 * "Equity by player" and "Seat 2 holds any of 518 combinations…" in its assumptions (audit at
 * 308fadf), so a reader had to count chairs to find out who "seat 3" was. The API hands this the
 * names the table dealt in, which are the names the plates and the narration already use.
 */
export type SeatNamer = (seat: SeatIndex) => string | undefined;

/**
 * The label a seat is given on its own: the client's name for it, or its one-based number.
 *
 * A name that is blank, or that is "you" in any case, falls back to the number. "you" is not a
 * hypothetical: `holdsClause` in `equity.ts` reads that label as the reader and conjugates for them,
 * so an opponent who chose it as a display name would have been written up as "You hold any of…".
 *
 * So does a name in either shape this file writes — "seat 4", or anything ending "(seat 4)" — so
 * that a guest cannot pick the label `opponentLabels` gives somebody else. That is what lets the
 * disambiguation there be one pass: a name that survives this can equal another name, never a label.
 */
function seatLabel(seat: SeatIndex, nameOf: SeatNamer | undefined): string {
  const name = nameOf?.(seat)?.trim() ?? '';
  const unusable = name === '' || name.toLowerCase() === 'you' || GENERATED_LABEL.test(name);
  return unusable ? `seat ${seat + 1}` : name;
}

const GENERATED_LABEL = /^seat \d+$|\(seat \d+\)$/iu;

/**
 * Each opponent's label, unique among every other seat in the view.
 *
 * Review on PR #36 (Devin): display names are not unique — `createGuest` takes any name — so two
 * opponents both called Alex came back as two "Alex" rows under "Equity by player" and two "Alex holds
 * any of…" assumptions, and nothing on screen said which Alex was which. A name another seat also
 * resolves to gets its one-based seat number, "Alex (seat 2)", in the equity row and the assumption
 * alike, because both are read off this one label; a name nobody shares is left exactly as it was.
 *
 * Compared against EVERY other seat, folded ones included, as `onlyTheReaderIsNamed` in the web's
 * `use-live-table.ts` does (review on PR #33): a folded Alex is still on a plate beside the Coach, so
 * a lone "Alex" row does not say which of the two the figure is about. Compared ignoring case, because
 * `holdsClause` capitalises the first letter, which writes "alex" and "Alex" up as the same "Alex
 * holds any of…".
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
 * Reads the decision in one view, or says why there is none.
 *
 * A function of the view alone: the viewer's cards are in it and nobody else's are, so there is
 * no way to ask this for an analysis of an opponent's decision.
 *
 * `legalActions` is the view's own, which is `legalActions(state, seat)` and is filled in only for
 * the seat that is to act. Measured before the Coach was given it: a three-handed preflop spot
 * with one opponent folded and the other all-in, the engine offering `fold, call`, and the Coach
 * headlining "raise to 80-100". An empty list is therefore a refusal, never "everything is legal".
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
  // Asked of the engine's own layering, with every seat passed, folded ones included: their chips
  // are in the middle and hero can win them. `amountToCall` is already capped at hero's stack, so
  // this is the question the dealer answers at settlement, asked one call early.
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
 * One assumed range as combinations, none of them holding a `dead` card.
 *
 * `top:NN` goes through `topPercentRange(...).notation` and then `parseRange`, because the range
 * `topPercentRange` returns knows nothing about blockers, and a "top 40%" that still holds hero's
 * ace inflates the opponent's strong combinations. One parser, one blocker rule, for both forms.
 */
export function expandAssumedRange(range: AssumedRange, dead: readonly Card[]): ParsedRange {
  const notation = range.kind === 'topPercent' ? topPercentRange(range.percent).notation : range.notation;
  return parseRange(notation, dead);
}

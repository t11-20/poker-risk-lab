/**
 * Recipient-specific views, the hidden-information boundary. `HandState` holds the deck, cursor,
 * salts and every hole card, and none of it leaves the server except through here.
 *
 * `redactFor` builds a new `PlayerView` from scratch rather than deleting fields, so a secret added
 * to `HandState` later is absent until someone adds it deliberately (fails closed).
 *
 * Entitlement is a person, never a seat. A finished hand outlives its seating, so keying on the seat
 * index would hand a new occupant the previous player's unshown cards. Every decision comes from the
 * one seat `viewerFor` resolves by `playerId`, which `startHand` writes once and `applyAction` never
 * changes. Pinned by `test/hidden-information.test.ts` and `test/redaction-identity.test.ts`.
 */

import { amountToCall, legalActions, totalPot } from './betting.ts';
import type { Card } from './cards.ts';
import { type PositionLabel, positionLabels } from './positions.ts';
import { buildPots } from './pots.ts';
import type {
  ForcedBet,
  HandResult,
  HandState,
  LegalAction,
  LoggedAction,
  Pot,
  SeatIndex,
  SeatState,
  SeatStatus,
  Street,
  TableConfig,
} from './types.ts';

/** A seat as one particular recipient is allowed to see it. */
export interface SeatView {
  readonly seat: SeatIndex;
  readonly playerId: string;
  readonly stack: number;
  readonly committedThisStreet: number;
  readonly committedTotal: number;
  readonly status: SeatStatus;
  readonly position: PositionLabel | null;
  /** Own cards, or cards shown at a completed showdown. Null otherwise. */
  readonly holeCards: readonly [Card, Card] | null;
  /** True when this seat is the recipient, decided by `playerId` rather than seat index. */
  readonly isSelf: boolean;
  readonly isButton: boolean;
  readonly isToAct: boolean;
}

/** The complete, safe-to-send picture of a hand for one recipient. */
export interface PlayerView {
  readonly handId: string;
  readonly roomId: string;
  readonly handNumber: number;
  readonly config: TableConfig;
  readonly street: Street;
  readonly board: readonly Card[];
  readonly buttonSeat: SeatIndex;
  readonly seats: readonly SeatView[];
  readonly toAct: SeatIndex | null;
  readonly betLevel: number;
  readonly minimumRaiseTo: number;
  readonly potTotal: number;
  readonly pots: readonly Pot[];
  readonly forcedBets: readonly ForcedBet[];
  readonly actions: readonly LoggedAction[];
  readonly actionSequence: number;
  /** Empty unless it is the recipient's turn. */
  readonly legalActions: readonly LegalAction[];
  /** What the recipient must add to call, 0 when nothing is owed. */
  readonly amountToCall: number;
  /** Merkle root, published before the first action. Salts and deck stay sealed. */
  readonly commitmentRoot: string;
  readonly commitmentContext: string;
  /** Present only once the hand is complete. Carries the Merkle proofs. */
  readonly result: HandResult | null;
  /**
   * The recipient's seat in THIS hand, or null for a spectator. Resolved from the hand, never echoed
   * from the request.
   */
  readonly viewerSeat: SeatIndex | null;
  readonly randomSourceKind: HandState['randomSourceKind'];
}

/**
 * Who a view is for. Servers must use `viewerPlayerId`, which is looked up in this hand's dealt roster.
 * `viewerSeat` is valid only for an index read from the same `HandState` (simulation, harnesses,
 * tests). An index from a lobby, socket or database row is the bug this split exists to expose.
 */
export type RedactOptions =
  | {
      /** The player this view is for. `null` builds a spectator view. */
      readonly viewerPlayerId: string | null;
      readonly viewerSeat?: never;
    }
  | {
      /** A seat index read from THIS state. `null` builds a spectator view. */
      readonly viewerSeat: SeatIndex | null;
      readonly viewerPlayerId?: never;
    };

/**
 * The one seat of this hand the view belongs to, or null for a spectator. Fails closed on an unknown
 * player, a missing seat, an empty id, or one id in two seats.
 */
function viewerFor(state: HandState, options: RedactOptions): SeatState | null {
  const playerId = options.viewerPlayerId;
  if (playerId !== undefined) {
    if (playerId === null || playerId === '') return null;
    const matches = state.seats.filter((seat) => seat.playerId === playerId);
    return matches.length === 1 ? (matches[0] ?? null) : null;
  }
  const seat = options.viewerSeat;
  if (seat === undefined || seat === null) return null;
  return state.seats.find((entry) => entry.seat === seat) ?? null;
}

/**
 * Pot layers during a hand. `buildPots` is correct only at settlement. Mid-street it turns an
 * uncalled bet, or the unequal blinds, into a phantom side pot. A live-table fuzz showed 947 of 1,446
 * decision points (65%) with a multi-layer pot and nobody all-in. A side pot exists only once a seat
 * is all in for less than others can still wager.
 */
function livePots(state: HandState): readonly Pot[] {
  const contesting = state.seats.filter((seat) => seat.status !== 'folded');
  const someoneIsAllIn = contesting.some((seat) => seat.stack === 0);
  if (someoneIsAllIn) return buildPots(state.seats);

  const total = totalPot(state);
  if (total === 0) return [];
  let cap = 0;
  for (const seat of contesting) cap = Math.max(cap, seat.committedTotal);
  return [
    {
      amount: total,
      eligibleSeats: contesting.map((seat) => seat.seat),
      capPerSeat: cap,
      index: 0,
    },
  ];
}

/**
 * Builds the view one recipient may see. Hole cards are visible to their own player (by `playerId`)
 * and, once `street === 'complete'`, for seats in the showdown list. Otherwise null. A hand won by a
 * fold shows nobody's cards, or observers would learn whether the folder was bluffing.
 */
export function redactFor(state: HandState, options: RedactOptions): PlayerView {
  const viewer = viewerFor(state, options);
  const viewerSeat = viewer === null ? null : viewer.seat;
  const isComplete = state.street === 'complete';
  const shownSeats = new Set<SeatIndex>(
    isComplete && state.result !== null ? state.result.showdowns.map((showdown) => showdown.seat) : [],
  );

  const occupied = state.seats.filter((seat) => seat.status !== 'sittingOut').map((seat) => seat.seat);
  const labels =
    occupied.length >= 2
      ? // Pass the blinds. `assignBlinds` refuses a dead button and mislabels a dead small blind.
        positionLabels(state.buttonSeat, state.config.maxSeats, occupied, {
          smallBlindSeat: state.smallBlindSeat,
          bigBlindSeat: state.bigBlindSeat,
        })
      : new Map<SeatIndex, PositionLabel>();

  const seats: SeatView[] = state.seats.map((seat) => {
    // At most one seat matches, and never someone who only inherited the chair.
    const isSelf = viewer !== null && seat.playerId === viewer.playerId && seat.seat === viewer.seat;
    const maySeeCards = isSelf || shownSeats.has(seat.seat);
    return {
      seat: seat.seat,
      playerId: seat.playerId,
      stack: seat.stack,
      committedThisStreet: seat.committedThisStreet,
      committedTotal: seat.committedTotal,
      status: seat.status,
      position: labels.get(seat.seat) ?? null,
      holeCards: maySeeCards ? seat.holeCards : null,
      isSelf,
      isButton: seat.seat === state.buttonSeat,
      isToAct: state.toAct === seat.seat,
    };
  });

  return {
    handId: state.handId,
    roomId: state.roomId,
    handNumber: state.handNumber,
    config: state.config,
    street: state.street,
    board: [...state.board],
    buttonSeat: state.buttonSeat,
    seats,
    toAct: state.toAct,
    betLevel: state.betLevel,
    minimumRaiseTo: state.betLevel + Math.max(state.lastFullRaiseIncrement, state.config.bigBlind),
    potTotal: totalPot(state),
    // Pot layers are public. See `livePots` for why this is not `buildPots`.
    pots: livePots(state),
    forcedBets: [...state.forcedBets],
    actions: [...state.actions],
    actionSequence: state.actionSequence,
    legalActions: viewer !== null && state.toAct === viewer.seat ? legalActions(state, viewer.seat) : [],
    // A non-active seat owes nothing. `betting.ts`'s `amountToCall` has no status check, so a folded
    // seat reported the full bet level as "to call" for the rest of the hand (6,772 times in an
    // engine fuzz).
    amountToCall: viewer === null || viewer.status !== 'active' ? 0 : amountToCall(state, viewer),
    commitmentRoot: state.commitment.root,
    commitmentContext: state.commitment.context,
    // The revealed deck and salts are sent only once the hand is complete.
    result: isComplete ? state.result : null,
    viewerSeat,
    randomSourceKind: state.randomSourceKind,
  };
}

/**
 * Every card the recipient must NOT see. Used by the hidden-information tests. Resolves the recipient
 * through `viewerFor`, so the expectation and the view agree on who is asking.
 */
export function cardsHiddenFrom(state: HandState, viewer: RedactOptions | SeatIndex | null): Card[] {
  const options: RedactOptions =
    viewer === null || typeof viewer === 'number' ? { viewerSeat: viewer } : viewer;
  const self = viewerFor(state, options);
  const isComplete = state.street === 'complete';
  const shown = new Set<SeatIndex>(
    isComplete && state.result !== null ? state.result.showdowns.map((s) => s.seat) : [],
  );
  const hidden: Card[] = [];

  for (const seat of state.seats) {
    if (seat.holeCards === null) continue;
    if (self !== null && seat.playerId === self.playerId && seat.seat === self.seat) continue;
    if (shown.has(seat.seat)) continue;
    hidden.push(...seat.holeCards);
  }

  // Undealt cards stay hidden after the hand too. The reveal proves only the public positions.
  for (let index = state.deckCursor; index < state.deck.length; index++) {
    const card = state.deck[index];
    if (card !== undefined) hidden.push(card);
  }
  return hidden;
}

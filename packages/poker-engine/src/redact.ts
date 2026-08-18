/**
 * Recipient-specific views.
 *
 * This is the hidden-information boundary. `HandState` contains the whole deck,
 * the read cursor, the commitment salt and every player's hole cards. None of that
 * may leave the server except through this module.
 *
 * The design decision that matters: `redactFor` does not take `HandState` and
 * delete fields from it. It **constructs a different type** — `PlayerView` — from
 * scratch, listing only the fields a client is allowed to see. Deleting fields
 * fails open: add a secret to `HandState` later and it silently starts leaking.
 * Building a narrower type fails closed: add a field and it simply is not in the
 * view until someone deliberately puts it there, and TypeScript will not let a
 * `HandState` be used where a `PlayerView` is expected.
 *
 * `test/hidden-information.test.ts` backs this up at runtime by deep-scanning
 * serialised views for every card that should not be visible.
 *
 * ## Entitlement is an identity, never a position
 *
 * The second design decision, and the one that was got wrong once: **who** a view
 * is for is a *person*, not a seat number. A seat index is a position at a table.
 * A `HandState` outlives the seating that produced it — a server may keep a
 * finished hand around for the terminal frame, for review or for the archive —
 * and the moment a player stands up and somebody else takes that chair, the seat
 * index and the person diverge. An authorisation decision keyed on the index then
 * hands the new occupant the previous occupant's unshown hole cards, marked as
 * their own.
 *
 * So `redactFor` resolves a *seat state* first (`viewerFor`) and every downstream
 * decision — `isSelf`, hole-card visibility, `legalActions`, `amountToCall`, the
 * `viewerSeat` echoed back — is taken from that one resolved seat. `isSelf` is
 * `playerId` equality, so it cannot be true for somebody who merely inherited a
 * chair. `HandState.seats[].playerId` is written once by `startHand` and never
 * mutated by `applyAction`, which makes it exactly the right anchor: it is the
 * roster **as it was at the moment the hand was dealt**.
 *
 * `test/redaction-identity.test.ts` asserts that property directly.
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
  /**
   * The recipient's own cards, or cards shown at a completed showdown. Null in
   * every other case — including for the recipient's own seat before cards are
   * dealt, and for opponents at all times during play.
   */
  readonly holeCards: readonly [Card, Card] | null;
  /**
   * True when this seat is the recipient themselves.
   *
   * Decided by `playerId`, not by seat index: a recipient who has taken a chair
   * somebody else was dealt into is not that somebody. `holeCards` above is
   * non-null for exactly `isSelf || showed down`, so this flag and that field
   * always agree.
   */
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
   * Which seat of THIS hand the recipient occupies; null for a pure spectator.
   *
   * Resolved from the hand, never echoed back from the request: asking for a
   * player who was not dealt into this hand, or for a seat this hand does not
   * have, produces `null` and therefore the spectator view.
   */
  readonly viewerSeat: SeatIndex | null;
  readonly randomSourceKind: HandState['randomSourceKind'];
}

/**
 * Who a view is being built for. Exactly one of the two forms.
 *
 * `viewerPlayerId` is the form a server must use. It names a *person*, and the
 * person is looked up in this hand's own dealt roster, so it stays correct for
 * as long as the `HandState` exists — including after the hand is over and the
 * seating around it has completely turned over.
 *
 * `viewerSeat` is the *positional* form, and it is only ever valid when the index
 * was read out of the very same `HandState` (a `toAct`, a `SeatState.seat`, a
 * loop over `state.seats`) in the same breath. Passing an index that came from
 * anywhere else — a lobby roster, a socket's remembered seat, a database row —
 * is the bug this type is split in two to make visible at the call site. It is
 * kept because the engine's own callers (simulation, policy harnesses, tests)
 * genuinely are iterating one state's seats, and for them the two forms are the
 * same thing.
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
 * The one seat of this hand the view belongs to, or null for a spectator.
 *
 * Fails closed in every ambiguous case: an unknown player, a seat this hand does
 * not contain, an empty id, or — impossible through `LiveTable.sit`, but not
 * something this function is willing to assume — a state in which one id somehow
 * occupies two seats. Every one of those returns `null`, which is the spectator
 * view: no hole cards, no legal actions, nothing owed.
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
 * Builds the view one recipient is allowed to see.
 *
 * Hole-card visibility, in full:
 *   - own seat: always visible to that recipient, where "own" means the seat
 *     whose `playerId` IS the recipient — not the seat they happen to sit in now
 *   - any seat: visible once `street === 'complete'` AND that seat appears in the
 *     showdown list (i.e. it actually showed its hand)
 *   - otherwise: null
 *
 * A hand that ends by folding produces an empty showdown list, so nobody's cards
 * are revealed — which is the correct behaviour and a real information leak if
 * gotten wrong, since it would tell observers whether a folder was bluffing.
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
      ? // The blinds are handed over rather than re-derived from the button: this
        // hand may have been dealt with a dead button or a dead small blind, and
        // `assignBlinds` would both refuse the first and mislabel the second.
        positionLabels(state.buttonSeat, state.config.maxSeats, occupied, {
          smallBlindSeat: state.smallBlindSeat,
          bigBlindSeat: state.bigBlindSeat,
        })
      : new Map<SeatIndex, PositionLabel>();

  const seats: SeatView[] = state.seats.map((seat) => {
    // Identity AND position, both taken from the one resolved seat. Seat indices
    // are unique within a state and so are player ids within a deal, so this can
    // be true for at most one seat — and never for somebody who merely inherited
    // the chair a dealt-in player left behind.
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
    // Pot layers are public information: everyone at a real table can see the
    // side pots forming.
    pots: buildPots(state.seats),
    forcedBets: [...state.forcedBets],
    actions: [...state.actions],
    actionSequence: state.actionSequence,
    legalActions: viewer !== null && state.toAct === viewer.seat ? legalActions(state, viewer.seat) : [],
    amountToCall: viewer === null ? 0 : amountToCall(state, viewer),
    commitmentRoot: state.commitment.root,
    commitmentContext: state.commitment.context,
    // The result carries the revealed deck and salt — but only ever after the
    // hand is complete, which is exactly when revealing them is harmless.
    result: isComplete ? state.result : null,
    viewerSeat,
    randomSourceKind: state.randomSourceKind,
  };
}

/**
 * Every card the given recipient must NOT be able to see in their view. Used by
 * the hidden-information tests to assert the redaction actually holds, rather
 * than trusting that it does.
 *
 * Takes the same recipient the view does — either form of `RedactOptions`, or a
 * bare seat index for the positional callers that predate the split — and
 * resolves it through the same `viewerFor`, so the expectation and the view can
 * never disagree about who is asking.
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

  // Undealt cards are always hidden — including after the hand completes. The
  // reveal proves only the positions that became public, so the rest of the deck
  // stays sealed forever.
  for (let index = state.deckCursor; index < state.deck.length; index++) {
    const card = state.deck[index];
    if (card !== undefined) hidden.push(card);
  }
  return hidden;
}

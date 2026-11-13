/**
 * Test fixture: a hand dealt and played by `@prl/poker-engine`, written out as the database rows,
 * so a review replay is checked against the engine's own numbers rather than hand-written ones.
 * The deck and salts are never written, since no column holds them. `persistHand` returns the full
 * `HandState` beside the rows so a test can assert hidden cards appear nowhere in a response.
 */

import type { Action, Card, HandState, SeatIndex } from '@prl/poker-engine';
import {
  applyAction,
  cardsToString,
  cardToString,
  createDeterministicRandomForTests,
  orderedDeck,
  parseCards,
  startHand,
} from '@prl/poker-engine';
import type { HandActionRow, HandRow, HandSeatRow } from '../../src/review/build-review.ts';

export interface PersistedHandRow extends HandRow {
  readonly max_pot_after: number | null;
}

export interface PersistedHand {
  readonly hand: PersistedHandRow;
  readonly seats: readonly HandSeatRow[];
  readonly actions: readonly HandActionRow[];
  /** The engine's state, for asking what must NOT be visible. Never persisted, never serialised. */
  readonly state: HandState;
  readonly seatOfUser: ReadonlyMap<string, SeatIndex>;
}

export interface SeatFixture {
  readonly seat: SeatIndex;
  readonly userId: string;
  readonly displayName: string;
  readonly stack: number;
  readonly isBot?: boolean;
}

export interface PersistHandOptions {
  readonly handId: string;
  readonly roomId: string;
  readonly handNumber?: number;
  readonly buttonSeat?: SeatIndex;
  readonly seats: readonly SeatFixture[];
  /** Seat → two cards, e.g. `{ 0: 'AhKs' }`. Every dealt seat needs an entry. */
  readonly holeCards: Readonly<Record<number, string>>;
  readonly board?: string;
  readonly steps: readonly { readonly seat: SeatIndex; readonly action: Action }[];
  readonly smallBlind?: number;
  readonly bigBlind?: number;
  readonly ante?: number;
  /** Defaults to a fixed instant with microseconds, which is what the cursor has to survive. */
  readonly startedAt?: Date;
}

/**
 * A 52-card deck that deals the requested cards. Order must match `machine.ts`: one card at a time,
 * twice round from left of the button, then the board with no burn cards.
 */
function stackedDeck(
  holeCards: Readonly<Record<number, string>>,
  dealOrder: readonly SeatIndex[],
  board: string,
): Card[] {
  const parsed = new Map<SeatIndex, readonly Card[]>();
  for (const [seat, text] of Object.entries(holeCards)) {
    const cards = parseCards(text);
    if (cards.length !== 2) throw new Error(`seat ${seat} needs two hole cards, got ${cards.length}`);
    parsed.set(Number(seat), cards);
  }

  const sequence: Card[] = [];
  for (const round of [0, 1]) {
    for (const seat of dealOrder) {
      const cards = parsed.get(seat);
      const card = cards?.[round];
      if (card === undefined) throw new Error(`no hole card ${round} for seat ${seat}`);
      sequence.push(card);
    }
  }
  sequence.push(...parseCards(board));
  if (new Set(sequence).size !== sequence.length) throw new Error('duplicate card in the fixture');

  const used = new Set(sequence);
  for (const card of orderedDeck()) {
    if (!used.has(card)) sequence.push(card);
  }
  return sequence;
}

function dealOrderFor(buttonSeat: SeatIndex, maxSeats: number, occupied: readonly SeatIndex[]): SeatIndex[] {
  const order: SeatIndex[] = [];
  for (let step = 1; step <= maxSeats; step++) {
    const candidate = (buttonSeat + step) % maxSeats;
    if (occupied.includes(candidate)) order.push(candidate);
  }
  return order;
}

function actionTo(action: Action): number | null {
  return action.type === 'bet' || action.type === 'raise' ? action.to : null;
}

/** JSON round trip, so a fixture row is the plain data a `jsonb` read would hand back. */
function asJson(value: unknown): unknown {
  const text = JSON.stringify(value);
  return text === undefined ? null : JSON.parse(text);
}

// `createDeterministicRandomForTests` is legal here and banned in `src/` (server-randomness.test.ts).
export function persistHand(options: PersistHandOptions): PersistedHand {
  const maxSeats = Math.max(2, ...options.seats.map((seat) => seat.seat + 1));
  const buttonSeat = options.buttonSeat ?? 0;
  const occupied = options.seats.map((seat) => seat.seat).sort((a, b) => a - b);
  const config = {
    smallBlind: options.smallBlind ?? 1,
    bigBlind: options.bigBlind ?? 2,
    ante: options.ante ?? 0,
    maxSeats,
    actionTimeoutSeconds: 30,
  };

  const started = startHand({
    handId: options.handId,
    roomId: options.roomId,
    handNumber: options.handNumber ?? 1,
    config,
    buttonSeat,
    seats: options.seats.map((seat) => ({ seat: seat.seat, playerId: seat.userId, stack: seat.stack })),
    random: createDeterministicRandomForTests(7),
    fixedDeck: stackedDeck(
      options.holeCards,
      dealOrderFor(buttonSeat, maxSeats, occupied),
      options.board ?? '',
    ),
  });

  let state = started.state;
  for (const [index, step] of options.steps.entries()) {
    if (state.toAct !== step.seat) {
      throw new Error(
        `step ${index}: expected seat ${step.seat} to act, it is ${String(state.toAct)}'s turn ` +
          `(street ${state.street})`,
      );
    }
    state = applyAction(state, step.seat, step.action, { actionId: `fixture-action-${index + 1}` }).state;
  }

  const result = state.result;
  const shown = new Set((result?.showdowns ?? []).map((showdown) => showdown.seat));
  const startingStacks = new Map(options.seats.map((seat) => [seat.seat, seat.stack]));
  const startedAt = options.startedAt ?? new Date('2026-08-17T14:26:23.974456Z');

  const seats: HandSeatRow[] = state.seats.map((seat) => {
    const fixture = options.seats.find((entry) => entry.seat === seat.seat);
    return {
      seat: seat.seat,
      user_id: fixture?.userId ?? null,
      display_name: fixture?.displayName ?? null,
      is_bot: fixture?.isBot === true,
      starting_stack: startingStacks.get(seat.seat) ?? 0,
      // Every dealt seat's cards, as `prl.hand_seats` holds them. Filtering is the reader's job.
      hole_cards: seat.holeCards === null ? null : seat.holeCards.map((card) => cardToString(card)),
      net_result: result === null ? null : (result.netBySeat[seat.seat] ?? 0),
      status: seat.status,
      showed_down: shown.has(seat.seat),
    };
  });

  const actions: HandActionRow[] = state.actions.map((logged) => ({
    sequence: logged.sequence,
    street: logged.street,
    seat: logged.seat,
    action_type: logged.action.type,
    action_to: actionTo(logged.action),
    amount_paid: logged.amountPaid,
    bet_level_after: logged.betLevelAfter,
    pot_after: logged.potAfter,
    was_automatic: logged.wasAutomatic,
    // The engine's log has no reason, so this is the pre-0009 null.
    automatic_reason: null,
  }));

  const hand: PersistedHandRow = {
    id: state.handId,
    room_id: state.roomId,
    hand_number: state.handNumber,
    button_seat: state.buttonSeat,
    config: asJson(config),
    commitment_root: state.commitment.root,
    commitment_context: state.commitment.context,
    // The stacked deck's real source. A review must never claim `csprng` for it.
    random_source_kind: state.randomSourceKind,
    board: state.board.map((card) => cardToString(card)),
    street: state.street,
    result: asJson(result),
    reveal: asJson(result?.reveal ?? null),
    started_at: startedAt,
    completed_at: state.street === 'complete' ? new Date(startedAt.getTime() + 60_000) : null,
    max_pot_after: actions.length === 0 ? null : Math.max(...actions.map((action) => action.pot_after)),
  };

  return {
    hand,
    seats,
    actions,
    state,
    seatOfUser: new Map(options.seats.map((seat) => [seat.userId, seat.seat])),
  };
}

/** Notation for a seat's cards, for a "this string must not appear" assertion. */
export function holeCardsOf(fixture: PersistedHand, seat: SeatIndex): readonly string[] {
  const cards = fixture.state.seats.find((entry) => entry.seat === seat)?.holeCards;
  return cards === null || cards === undefined ? [] : cards.map((card) => cardToString(card));
}

export function describeCards(cards: readonly Card[]): string {
  return cardsToString(cards);
}

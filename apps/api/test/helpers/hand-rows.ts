/**
 * Test fixture: a real hand, turned into the rows the database would hold.
 *
 * Not a `.test.ts` file, so the runner's `test/**\/*.test.ts` glob does not pick it up.
 *
 * The hand is dealt and played by `@prl/poker-engine` itself, and then written out through the
 * same narrowing a real persistence path would use: the board and the hole cards as card notation,
 * the actions as the `hand_actions` columns, the result and the reveal as JSON. Two things follow
 * from doing it that way rather than hand-writing rows.
 *
 * First, the review's replay is checked against the engine's own numbers — `pot_after`,
 * `bet_level_after` and `amount_paid` come from `applyAction`, so a reconstruction that disagrees
 * with them is a real disagreement and not a fixture typo.
 *
 * Second, and more importantly: THE DECK AND THE SALTS ARE NOT WRITTEN OUT AT ALL, because there
 * is nowhere to write them. `persistHand` returns the full `HandState` alongside the rows so a
 * test can ask what the cards actually were and then assert that none of the ones the viewer was
 * not entitled to see appears anywhere in the response. The rows themselves carry only what
 * `db/migrations/0001_initial.sql` has a column for.
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

/** `HandRow` plus the aggregate the route computes in SQL. Matches what `buildHandReview` takes. */
export interface PersistedHandRow extends HandRow {
  readonly max_pot_after: number | null;
}

export interface PersistedHand {
  readonly hand: PersistedHandRow;
  readonly seats: readonly HandSeatRow[];
  readonly actions: readonly HandActionRow[];
  /** The engine's state, for asking what must NOT be visible. Never persisted, never serialised. */
  readonly state: HandState;
  /** Seat index for each user id, so a test can talk about "Alice's seat". */
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
  /** Up to five community cards, e.g. `'Qh 7h 2c'`. */
  readonly board?: string;
  readonly steps: readonly { readonly seat: SeatIndex; readonly action: Action }[];
  readonly smallBlind?: number;
  readonly bigBlind?: number;
  readonly ante?: number;
  /** Defaults to a fixed instant with microseconds, which is what the cursor has to survive. */
  readonly startedAt?: Date;
}

/**
 * A 52-card deck that deals the requested cards.
 *
 * Deal order has to match `machine.ts` exactly — one card at a time, twice round the table
 * starting left of the button, then the board straight off the cursor with no burn cards — or the
 * hand would not receive the cards this fixture claims it did.
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

/** Clockwise from the button, exclusive — the deal order `machine.ts` uses. */
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

/**
 * Deals the hand, plays the given steps, and returns the rows plus the state.
 *
 * `createDeterministicRandomForTests` supplies the commitment salts. It is legitimate here and
 * illegal in `src/` — `test/server-randomness.test.ts` scans only the server tree, and a hand
 * dealt from it is permanently labelled in `randomSourceKind`. A `fixedDeck` is used so the cards
 * are the fixture's choice, which is exactly what the Scenario Lab path does.
 */
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
      // The row holds every dealt seat's cards, exactly as `prl.hand_seats` does. Filtering them
      // is the reader's job, and proving that the reader does it is the point of the tests.
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
  }));

  const hand: PersistedHandRow = {
    id: state.handId,
    room_id: state.roomId,
    hand_number: state.handNumber,
    button_seat: state.buttonSeat,
    config: asJson(config),
    commitment_root: state.commitment.root,
    commitment_context: state.commitment.context,
    // What the fixture actually dealt from, not what a real table would. A review that claimed
    // `csprng` over a stacked deck would be the one lie a hand review must never tell.
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

/** Space-separated notation, for readable assertion messages. */
export function describeCards(cards: readonly Card[]): string {
  return cardsToString(cards);
}

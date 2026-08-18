/**
 * Test helpers for driving hands.
 *
 * `playHand` exists so tests read as a sequence of decisions rather than a pile of
 * state plumbing, which keeps the interesting part of each test visible.
 */

import { orderedDeck, parseCards } from '../src/cards.ts';
import { applyAction, type SeatSetup, startHand } from '../src/machine.ts';
import { createDeterministicRandomForTests, type RandomSource } from '../src/rng.ts';
import type { Action, HandState, SeatIndex, TableConfig } from '../src/types.ts';

export const defaultConfig: TableConfig = {
  smallBlind: 1,
  bigBlind: 2,
  ante: 0,
  maxSeats: 6,
  actionTimeoutSeconds: 30,
};

export function config(overrides: Partial<TableConfig> = {}): TableConfig {
  return { ...defaultConfig, ...overrides };
}

export function seats(...stacks: number[]): SeatSetup[] {
  return stacks.map((stack, index) => ({ seat: index, playerId: `p${index}`, stack }));
}

export function testRandom(seed = 1): RandomSource {
  return createDeterministicRandomForTests(seed);
}

/**
 * Builds a 52-card deck that deals specified hole cards and board, with all
 * remaining cards filling the rest in ascending order.
 *
 * Deal order must match `machine.ts`: one card at a time, twice round the table
 * starting left of the button, then burn-free flop/turn/river.
 *
 * @param holeCardsBySeat seat → two cards, e.g. `{0: 'AhAd', 1: 'KsKc'}`
 * @param dealOrder the seats in the order they receive cards (left of button first)
 * @param board up to five community cards
 */
export function stackedDeck(
  holeCardsBySeat: Record<number, string>,
  dealOrder: readonly SeatIndex[],
  board = '',
): number[] {
  const hole = new Map<SeatIndex, number[]>();
  for (const [seat, text] of Object.entries(holeCardsBySeat)) {
    const cards = parseCards(text);
    if (cards.length !== 2) throw new Error(`seat ${seat} needs exactly 2 hole cards, got ${cards.length}`);
    hole.set(Number(seat), cards);
  }

  const sequence: number[] = [];
  for (let round = 0; round < 2; round++) {
    for (const seat of dealOrder) {
      const cards = hole.get(seat);
      if (cards === undefined) throw new Error(`no hole cards supplied for seat ${seat}`);
      const card = cards[round];
      if (card === undefined) throw new Error(`seat ${seat} missing card ${round}`);
      sequence.push(card);
    }
  }
  sequence.push(...parseCards(board));

  const used = new Set(sequence);
  if (used.size !== sequence.length) throw new Error('stackedDeck was given duplicate cards');
  for (const card of orderedDeck()) {
    if (!used.has(card)) sequence.push(card);
  }
  return sequence;
}

export interface Step {
  readonly seat: SeatIndex;
  readonly action: Action;
}

export const fold = (seat: SeatIndex): Step => ({ seat, action: { type: 'fold' } });
export const check = (seat: SeatIndex): Step => ({ seat, action: { type: 'check' } });
export const call = (seat: SeatIndex): Step => ({ seat, action: { type: 'call' } });
export const bet = (seat: SeatIndex, to: number): Step => ({ seat, action: { type: 'bet', to } });
export const raise = (seat: SeatIndex, to: number): Step => ({ seat, action: { type: 'raise', to } });

/** Applies a sequence of actions, asserting each is the expected seat's turn. */
export function play(state: HandState, steps: readonly Step[]): HandState {
  let current = state;
  for (const [index, step] of steps.entries()) {
    if (current.toAct !== step.seat) {
      throw new Error(
        `step ${index}: expected seat ${step.seat} to act but it is ${String(current.toAct)}'s turn ` +
          `(street ${current.street}, betLevel ${current.betLevel})`,
      );
    }
    current = applyAction(current, step.seat, step.action).state;
  }
  return current;
}

export interface DealtHand {
  state: HandState;
  secret: ReturnType<typeof startHand>['secret'];
}

export function deal(options: {
  stacks: number[];
  buttonSeat?: number;
  config?: Partial<TableConfig>;
  fixedDeck?: readonly number[];
  seed?: number;
}): DealtHand {
  const cfg = config({ maxSeats: Math.max(2, options.stacks.length), ...options.config });
  const started = startHand({
    handId: 'h1',
    roomId: 'r1',
    handNumber: 1,
    config: cfg,
    buttonSeat: options.buttonSeat ?? 0,
    seats: seats(...options.stacks),
    random: testRandom(options.seed ?? 1),
    ...(options.fixedDeck === undefined ? {} : { fixedDeck: options.fixedDeck }),
  });
  return { state: started.state, secret: started.secret };
}

/**
 * Total chips in existence: stacks plus whatever is still in the middle.
 *
 * Once a hand completes, the pot has been paid into the stacks, so adding
 * `committedTotal` then would double-count it. `committedTotal` is deliberately
 * not cleared at settle time because hand review needs it.
 */
export function chipsInSystem(state: HandState): number {
  const inStacks = state.seats.reduce((sum, seat) => sum + seat.stack, 0);
  if (state.street === 'complete') return inStacks;
  return inStacks + state.seats.reduce((sum, seat) => sum + seat.committedTotal, 0);
}

/**
 * The hand state machine. `startHand` deals and `applyAction` advances. Both are pure. No clock, no
 * network, no mutated arguments. Street changes, run-outs, showdown and awards all happen inside
 * `applyAction`, so a caller cannot leave a hand half-advanced.
 */

import {
  isBettingClosedForHand,
  isBettingRoundComplete,
  owesAction,
  seatAt,
  seatsAbleToAct,
  seatsInHand,
  totalPot,
  validateAction,
} from './betting.ts';
import { assertDistinctCards, type Card, DECK_SIZE } from './cards.ts';
import type { DeckCommitment, DeckSecret } from './commitment.ts';
import { revealPositions } from './commitment.ts';
import type { HandScore } from './evaluate.ts';
import {
  assignBlinds,
  dealtSeats,
  firstToActPostflop,
  firstToActPreflopFor,
  orderFrom,
} from './positions.ts';
import { awardPots, buildPotLayers, computeShowdowns } from './pots.ts';
import { commitToDeck, commitToKnownDeck, type RandomSource } from './rng.ts';
import type {
  Action,
  BettingStreet,
  ForcedBet,
  HandEvent,
  HandResult,
  HandState,
  LoggedAction,
  SeatIndex,
  SeatState,
  TableConfig,
} from './types.ts';

export class HandStateError extends Error {
  override readonly name = 'HandStateError';
}

const BOARD_CARDS = { flop: 3, turn: 1, river: 1 } as const;

export interface SeatSetup {
  readonly seat: SeatIndex;
  readonly playerId: string;
  readonly stack: number;
  readonly sittingOut?: boolean;
}

export interface StartHandOptions {
  readonly handId: string;
  readonly roomId: string;
  readonly handNumber: number;
  readonly config: TableConfig;
  readonly buttonSeat: SeatIndex;
  readonly seats: readonly SeatSetup[];
  readonly random: RandomSource;
  /**
   * Where the blinds fell, for a table running the dead-button rule. Omit it to derive them from
   * the button. When supplied, the button may name an empty seat and the small blind may be `null`.
   */
  readonly blinds?: {
    readonly smallBlindSeat: SeatIndex | null;
    readonly bigBlindSeat: SeatIndex;
  };
  /**
   * Deals a fixed deck instead of shuffling. Scenario Lab only. The hand still carries a real
   * commitment and is labelled `fixed-deck-scenario` in `randomSourceKind`.
   */
  readonly fixedDeck?: readonly Card[];
}

export interface StartedHand {
  readonly state: HandState;
  readonly secret: DeckSecret;
  readonly events: readonly HandEvent[];
}

function validateConfig(config: TableConfig): void {
  if (!Number.isInteger(config.smallBlind) || config.smallBlind <= 0) {
    throw new HandStateError(`smallBlind must be a positive integer, got ${config.smallBlind}`);
  }
  if (!Number.isInteger(config.bigBlind) || config.bigBlind <= 0) {
    throw new HandStateError(`bigBlind must be a positive integer, got ${config.bigBlind}`);
  }
  if (config.bigBlind < config.smallBlind) throw new HandStateError('bigBlind must be at least smallBlind');
  if (!Number.isInteger(config.ante) || config.ante < 0) {
    throw new HandStateError(`ante must be a non-negative integer, got ${config.ante}`);
  }
  if (!Number.isInteger(config.maxSeats) || config.maxSeats < 2 || config.maxSeats > 6) {
    throw new HandStateError(`maxSeats must be 2..6, got ${config.maxSeats}`);
  }
}

function validateSeats(options: StartHandOptions): readonly SeatSetup[] {
  const seatNumbers = options.seats.map((seat) => seat.seat);
  if (new Set(seatNumbers).size !== seatNumbers.length) {
    throw new HandStateError('duplicate seat numbers in setup');
  }
  for (const seat of options.seats) {
    if (!Number.isInteger(seat.seat) || seat.seat < 0 || seat.seat >= options.config.maxSeats) {
      throw new HandStateError(`seat ${seat.seat} is outside 0..${options.config.maxSeats - 1}`);
    }
    if (!Number.isInteger(seat.stack) || seat.stack < 0) {
      throw new HandStateError(`seat ${seat.seat} has a non-integer or negative stack`);
    }
    if (seat.playerId === '') throw new HandStateError(`seat ${seat.seat} has an empty playerId`);
  }
  const playing = options.seats.filter((seat) => seat.sittingOut !== true && seat.stack > 0);
  if (playing.length < 2) {
    throw new HandStateError(`need at least 2 players with chips, have ${playing.length}`);
  }
  if (playing.length > options.config.maxSeats) {
    throw new HandStateError(`${playing.length} players exceeds maxSeats ${options.config.maxSeats}`);
  }
  return playing;
}

/** Where the blinds fall for this deal. Supplied blinds are checked here, once, at the boundary. */
function resolveBlinds(
  options: StartHandOptions,
  occupied: readonly SeatIndex[],
): { readonly smallBlindSeat: SeatIndex | null; readonly bigBlindSeat: SeatIndex } {
  const { buttonSeat, config } = options;
  if (options.blinds === undefined) {
    if (!occupied.includes(buttonSeat)) {
      throw new HandStateError(`button seat ${buttonSeat} has no player with chips`);
    }
    const { smallBlindSeat, bigBlindSeat } = assignBlinds(buttonSeat, config.maxSeats, occupied);
    return { smallBlindSeat, bigBlindSeat };
  }

  const { smallBlindSeat, bigBlindSeat } = options.blinds;
  if (!occupied.includes(bigBlindSeat)) {
    throw new HandStateError(`big blind seat ${bigBlindSeat} has no player with chips`);
  }
  if (smallBlindSeat !== null && !occupied.includes(smallBlindSeat)) {
    // A dead small blind is spelled `null`. Passing an absent seat would post a blind for a non-player.
    throw new HandStateError(`small blind seat ${smallBlindSeat} has no player with chips; pass null`);
  }
  if (smallBlindSeat === bigBlindSeat) {
    throw new HandStateError(`seat ${bigBlindSeat} cannot post both blinds`);
  }
  if (occupied.length === 2) {
    // Heads-up the button is the small blind. Refused rather than repaired.
    if (smallBlindSeat !== buttonSeat) {
      throw new HandStateError(
        `heads-up the button posts the small blind: button ${buttonSeat}, ` +
          `small blind ${String(smallBlindSeat)}`,
      );
    }
  }
  return { smallBlindSeat, bigBlindSeat };
}

/** Deals a hand: shuffle, commit, post antes and blinds, deal hole cards, set the first actor. */
export function startHand(options: StartHandOptions): StartedHand {
  validateConfig(options.config);
  const playing = validateSeats(options);
  const { config, buttonSeat } = options;

  const occupied = playing.map((seat) => seat.seat).sort((a, b) => a - b);
  const blinds = resolveBlinds(options, occupied);

  // The context binds the commitment to this one hand, so it cannot be replayed for another.
  const context = `${options.roomId}:${options.handNumber}:${options.handId}`;
  let commitment: DeckCommitment;
  let secret: DeckSecret;
  let sourceKind: HandState['randomSourceKind'];
  /**
   * A sampling source may estimate but never deal. `shuffledDeck` refuses it too. Checking here
   * narrows `random.kind` to the labelled kinds without a cast, and fails before the commitment is built.
   */
  const random = options.random;
  if (random.kind === 'deterministic-sampling') {
    throw new HandStateError(
      'a deterministic-sampling source must never deal a hand; it exists for Monte Carlo ' +
        'estimation only, and a hand dealt from it would be predictable from its seed',
    );
  }
  if (options.fixedDeck === undefined) {
    ({ commitment, secret } = commitToDeck(context, random));
    sourceKind = random.kind;
  } else {
    assertDistinctCards(options.fixedDeck, 'fixedDeck');
    if (options.fixedDeck.length !== DECK_SIZE) {
      throw new HandStateError(
        `fixedDeck must contain all ${DECK_SIZE} cards, got ${options.fixedDeck.length}`,
      );
    }
    ({ commitment, secret } = commitToKnownDeck(context, options.fixedDeck, random));
    sourceKind = 'fixed-deck-scenario';
  }

  let seats: SeatState[] = options.seats.map((setup) => ({
    seat: setup.seat,
    playerId: setup.playerId,
    stack: setup.stack,
    committedThisStreet: 0,
    committedTotal: 0,
    holeCards: null,
    status: setup.sittingOut === true || setup.stack <= 0 ? 'sittingOut' : 'active',
    lastActedAtBetLevel: null,
    isAllInThisHand: false,
  }));

  const events: HandEvent[] = [{ type: 'handStarted', handId: options.handId, commitment: commitment.root }];

  // A blind is a live bet and counts toward the bet level. An ante is dead money. It raises
  // `committedTotal` (side pots need it) and goes straight to `potFromPreviousStreets`, but never
  // touches `committedThisStreet`, or the opening bet level would become `ante + bigBlind`.
  const forcedBets: ForcedBet[] = [];
  let deadMoney = 0;
  const post = (target: SeatIndex, amount: number, kind: ForcedBet['kind']): void => {
    const isLiveBet = kind !== 'ante';
    seats = seats.map((candidate) => {
      if (candidate.seat !== target) return candidate;
      const paid = Math.min(amount, candidate.stack);
      forcedBets.push({ kind, seat: target, amount: paid, wasShort: paid < amount });
      if (!isLiveBet) deadMoney += paid;
      const stack = candidate.stack - paid;
      return {
        ...candidate,
        stack,
        committedThisStreet: candidate.committedThisStreet + (isLiveBet ? paid : 0),
        committedTotal: candidate.committedTotal + paid,
        // Short of a blind or ante is all-in, not folded.
        status: stack === 0 ? 'allIn' : candidate.status,
        isAllInThisHand: candidate.isAllInThisHand || stack === 0,
      };
    });
  };

  if (config.ante > 0) {
    for (const target of orderFrom(buttonSeat, config.maxSeats, occupied)) post(target, config.ante, 'ante');
  }
  const { smallBlindSeat, bigBlindSeat } = blinds;
  // A dead small blind posts nothing and is not moved onto the next player, who paid it last hand.
  if (smallBlindSeat !== null) post(smallBlindSeat, config.smallBlind, 'smallBlind');
  post(bigBlindSeat, config.bigBlind, 'bigBlind');
  events.push({ type: 'forcedBetsPosted', forcedBets });

  // One card at a time, twice round, from left of the button. The order must match the deck or
  // verification fails on an honest hand.
  const dealOrder = orderFrom(buttonSeat, config.maxSeats, occupied);
  const holeCards = new Map<SeatIndex, Card[]>();
  // Deck positions of each seat's hole cards, for Merkle proofs of the hands that are shown.
  const holePositions = new Map<SeatIndex, number[]>();
  let cursor = 0;
  for (let round = 0; round < 2; round++) {
    for (const target of dealOrder) {
      const card = secret.deck[cursor];
      if (card === undefined) throw new HandStateError('deck exhausted while dealing hole cards');
      const existing = holeCards.get(target) ?? [];
      existing.push(card);
      holeCards.set(target, existing);
      const positions = holePositions.get(target) ?? [];
      positions.push(cursor);
      holePositions.set(target, positions);
      cursor += 1;
    }
  }
  seats = seats.map((seat) => {
    const cards = holeCards.get(seat.seat);
    if (cards === undefined) return seat;
    const [first, second] = cards;
    if (first === undefined || second === undefined) {
      throw new HandStateError(`seat ${seat.seat} received ${cards.length} hole cards`);
    }
    return { ...seat, holeCards: [first, second] as const };
  });
  events.push({ type: 'holeCardsDealt', seats: dealOrder });

  // The preflop bet level is the big blind, not the largest commitment. A short big blind does not
  // lower the cost to play. With 5/10 blinds and a big blind all-in for 3, deriving it from the
  // largest commitment made calls cost 5 and accepted a raise to 15 instead of 20. `Math.max` keeps
  // the level at or above any forced bet larger than the big blind.
  const postedThisStreet = seats.reduce((highest, seat) => Math.max(highest, seat.committedThisStreet), 0);
  const betLevel = Math.max(config.bigBlind, postedThisStreet);

  const dealt: HandState = {
    handId: options.handId,
    roomId: options.roomId,
    handNumber: options.handNumber,
    config,
    buttonSeat,
    smallBlindSeat,
    bigBlindSeat,
    seats,
    board: [],
    street: 'preflop',
    deck: secret.deck,
    deckCursor: cursor,
    deckSalts: secret.salts,
    commitment,
    toAct: null,
    betLevel,
    // The big blind counts as a complete bet, so the first raise must reach 2 BB.
    lastFullRaiseBetLevel: config.bigBlind,
    lastFullRaiseIncrement: config.bigBlind,
    potFromPreviousStreets: deadMoney,
    forcedBets,
    actions: [],
    actionSequence: 0,
    result: null,
    randomSourceKind: sourceKind,
    holeCardPositions: Object.fromEntries(holePositions),
    boardPositions: [],
  };

  // Blinds alone can leave nobody able to act (two short all-ins). The board then runs out.
  const opener = firstActor(dealt, 'preflop');
  if (opener === null) {
    return { state: advanceStreets(closeStreet(dealt), events), secret, events };
  }
  return { state: { ...dealt, toAct: opener }, secret, events };
}

function firstActor(state: HandState, street: BettingStreet): SeatIndex | null {
  // Without this, `owesAction` would ask the lone seat with chips to act on an all-in hand.
  if (isBettingClosedForHand(state)) return null;
  const occupied = dealtSeats(state.seats);
  // Read the opener off the posted big blind. With a dead button, `button + 2` is not the big blind.
  const start =
    street === 'preflop'
      ? firstToActPreflopFor(state.buttonSeat, state.bigBlindSeat, state.config.maxSeats, occupied)
      : firstToActPostflop(state.buttonSeat, state.config.maxSeats, occupied);
  for (const candidate of [start, ...orderFrom(start, state.config.maxSeats, occupied)]) {
    const seat = state.seats.find((entry) => entry.seat === candidate);
    if (seat !== undefined && owesAction(state, seat)) return candidate;
  }
  return null;
}

function nextActor(state: HandState, from: SeatIndex): SeatIndex | null {
  const occupied = dealtSeats(state.seats);
  for (const candidate of orderFrom(from, state.config.maxSeats, occupied)) {
    const seat = state.seats.find((entry) => entry.seat === candidate);
    if (seat !== undefined && owesAction(state, seat)) return candidate;
  }
  return null;
}

export interface ApplyActionOptions {
  /**
   * True when the server acted for the seat (clock ran out, or the player stood up holding cards).
   * Which one it was lives in `ArchivedAction.automaticReason` in `apps/api/src/rooms/table.ts`.
   */
  readonly automatic?: boolean;
  readonly actionId?: string | null;
}

export interface AppliedAction {
  readonly state: HandState;
  readonly events: readonly HandEvent[];
}

/** Applies one action and advances the hand as far as it allows, through to settlement. */
export function applyAction(
  state: HandState,
  seat: SeatIndex,
  action: Action,
  options: ApplyActionOptions = {},
): AppliedAction {
  if (state.street === 'showdown' || state.street === 'complete') {
    throw new HandStateError(`hand ${state.handId} is already ${state.street}`);
  }
  const street: BettingStreet = state.street;
  const validated = validateAction(state, seat, action);
  const actor = seatAt(state, seat);

  const committedThisStreet =
    validated.kind === 'fold' || validated.kind === 'check' ? actor.committedThisStreet : validated.to;
  const stack = actor.stack - validated.cost;
  if (stack < 0) throw new HandStateError(`action would leave seat ${seat} with a negative stack`);

  const betLevel = Math.max(state.betLevel, committedThisStreet);
  const raisedBetLevel = betLevel > state.betLevel;

  const updatedActor: SeatState = {
    ...actor,
    stack,
    committedThisStreet,
    committedTotal: actor.committedTotal + validated.cost,
    status: validated.kind === 'fold' ? 'folded' : stack === 0 ? 'allIn' : 'active',
    // The bet level AFTER this action. Recording the pre-action level would let a raiser re-raise
    // its own raise under `mayRaise`.
    lastActedAtBetLevel: betLevel,
    isAllInThisHand: actor.isAllInThisHand || stack === 0,
  };

  const seats = state.seats.map((entry) => (entry.seat === seat ? updatedActor : entry));

  // A complete raise reopens the action and a short all-in does not. Only `lastFullRaiseBetLevel`
  // moves. See betting.ts.
  const reopens = validated.isCompleteRaise && raisedBetLevel;

  const logged: LoggedAction = {
    sequence: state.actionSequence + 1,
    street,
    seat,
    playerId: actor.playerId,
    action,
    amountPaid: validated.cost,
    betLevelAfter: betLevel,
    potAfter: totalPot({ ...state, seats }),
    wasAutomatic: options.automatic === true,
    actionId: options.actionId ?? null,
  };

  const next: HandState = {
    ...state,
    seats,
    betLevel,
    lastFullRaiseBetLevel: reopens ? betLevel : state.lastFullRaiseBetLevel,
    lastFullRaiseIncrement: reopens ? betLevel - state.betLevel : state.lastFullRaiseIncrement,
    actions: [...state.actions, logged],
    actionSequence: logged.sequence,
  };

  const events: HandEvent[] = [{ type: 'actionApplied', action: logged }];

  if (seatsInHand(next).length <= 1) {
    return { state: settle(next, events, true), events };
  }

  // Also true once no further wagering is possible, so a call that puts the last opponent all-in
  // falls through to the run-out.
  if (!isBettingRoundComplete(next)) {
    const following = nextActor(next, seat);
    if (following !== null) return { state: { ...next, toAct: following }, events };
  }

  return { state: advanceStreets(closeStreet(next), events), events };
}

function closeStreet(state: HandState): HandState {
  const collected = state.seats.reduce((sum, seat) => sum + seat.committedThisStreet, 0);
  return {
    ...state,
    potFromPreviousStreets: state.potFromPreviousStreets + collected,
    seats: state.seats.map((seat) => ({ ...seat, committedThisStreet: 0, lastActedAtBetLevel: null })),
    betLevel: 0,
    lastFullRaiseBetLevel: 0,
    lastFullRaiseIncrement: 0,
    toAct: null,
  };
}

/**
 * Deals the next street. When no further betting is possible it runs the board out and shows down
 * in one pass. Expects `state` already passed through `closeStreet`.
 */
function advanceStreets(state: HandState, events: HandEvent[]): HandState {
  let current = state;

  for (;;) {
    if (current.street === 'river' || current.street === 'showdown' || current.street === 'complete') {
      return settle({ ...current, street: 'showdown' }, events, false);
    }

    const nextStreet: BettingStreet =
      current.street === 'preflop' ? 'flop' : current.street === 'flop' ? 'turn' : 'river';
    const count = BOARD_CARDS[nextStreet];

    const dealt: Card[] = [];
    const dealtPositions: number[] = [];
    let cursor = current.deckCursor;
    for (let i = 0; i < count; i++) {
      const card = current.deck[cursor];
      if (card === undefined) throw new HandStateError('deck exhausted while dealing the board');
      dealt.push(card);
      dealtPositions.push(cursor);
      cursor += 1;
    }

    current = {
      ...current,
      street: nextStreet,
      board: [...current.board, ...dealt],
      deckCursor: cursor,
      boardPositions: [...current.boardPositions, ...dealtPositions],
    };
    events.push({ type: 'streetAdvanced', street: nextStreet, newCards: dealt });

    if (isBettingClosedForHand(current)) continue;

    const opener = firstActor(current, nextStreet);
    if (opener === null) continue;
    return { ...current, toAct: opener };
  }
}

function settle(state: HandState, events: HandEvent[], endedByFold: boolean): HandState {
  // `buildPots` uses committedTotal, which already includes these. This keeps the shown pot honest.
  const pending = state.seats.reduce((sum, seat) => sum + seat.committedThisStreet, 0);

  const { pots, returns } = buildPotLayers(state.seats);
  events.push({ type: 'potsFormed', pots });

  const contenders = seatsInHand(state);
  const showdowns =
    endedByFold || contenders.length <= 1
      ? []
      : computeShowdowns({
          seats: state.seats,
          board: state.board,
          buttonSeat: state.buttonSeat,
          maxSeats: state.config.maxSeats,
        });

  const scores = new Map<SeatIndex, HandScore>();
  for (const showdown of showdowns) scores.set(showdown.seat, showdown.score);

  const awards = awardPots({
    pots,
    scores,
    seats: state.seats,
    buttonSeat: state.buttonSeat,
    maxSeats: state.config.maxSeats,
  });

  const wonBySeat = new Map<SeatIndex, number>();
  for (const award of awards) wonBySeat.set(award.seat, (wonBySeat.get(award.seat) ?? 0) + award.amount);
  // Uncontested chips go back to whoever put them in. They are not winnings.
  for (const entry of returns) wonBySeat.set(entry.seat, (wonBySeat.get(entry.seat) ?? 0) + entry.amount);

  const netBySeat: Record<number, number> = {};
  const paidSeats = state.seats.map((seat) => {
    const won = wonBySeat.get(seat.seat) ?? 0;
    netBySeat[seat.seat] = won - seat.committedTotal;
    return { ...seat, stack: seat.stack + won, committedThisStreet: 0 };
  });

  // Prove only public cards, the dealt board and the hole cards of seats that showed. A fold reveals
  // no hole cards, which is why the commitment is a per-card Merkle tree.
  const publicPositions = [...state.boardPositions];
  for (const showdown of showdowns) {
    for (const position of state.holeCardPositions[showdown.seat] ?? []) publicPositions.push(position);
  }

  const result: HandResult = {
    showdowns,
    pots,
    awards,
    netBySeat,
    endedByFold: endedByFold || contenders.length <= 1,
    reveal: revealPositions(state.commitment, { deck: state.deck, salts: state.deckSalts }, publicPositions),
  };
  events.push({ type: 'handComplete', result });

  return {
    ...state,
    seats: paidSeats,
    street: 'complete',
    toAct: null,
    potFromPreviousStreets: state.potFromPreviousStreets + pending,
    betLevel: 0,
    result,
  };
}

/** The server's action for a timed-out player. Check if free, else fold. Never a call. */
export function timeoutAction(state: HandState, seat: SeatIndex): Action {
  const actor = seatAt(state, seat);
  const toCall = Math.max(0, state.betLevel - actor.committedThisStreet);
  return toCall === 0 ? { type: 'check' } : { type: 'fold' };
}

export { seatsAbleToAct, seatsInHand, totalPot };

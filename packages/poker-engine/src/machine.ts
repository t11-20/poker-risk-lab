/**
 * The hand state machine.
 *
 * `startHand` deals; `applyAction` advances. Both are pure: they take a state and
 * return a new state plus the events that happened. Nothing in this file reads a
 * clock, touches the network, or mutates its arguments — the server owns all of
 * that and treats this module as the only authority on what is legal and what the
 * result is.
 *
 * Street transitions, all-in run-outs, showdown and pot awarding all happen inside
 * `applyAction` as a consequence of the action, so a caller cannot leave a hand in
 * a half-advanced state by forgetting to call something. The only way to move a
 * hand forward is to apply a legal action.
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

/** Cards added to the board when each street is dealt. */
const BOARD_CARDS = { flop: 3, turn: 1, river: 1 } as const;

export interface SeatSetup {
  readonly seat: SeatIndex;
  readonly playerId: string;
  readonly stack: number;
  /** Seats sitting out are not dealt in. */
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
   * Where the blinds actually fell, for a table running the dead-button rule.
   *
   * Omit it and the blinds are derived from the button exactly as they always
   * were — correct for a single hand, and what every Scenario Lab hand and every
   * test that deals one hand wants. Supply it and the button becomes a position
   * rather than a derivation: it may name a seat nobody is playing from (a dead
   * button), and the small blind may be `null` (a dead small blind). Both are
   * legitimate outcomes of the rule that keeps the big blind advancing by
   * exactly one live player per hand — see `advanceBlindRotation` in
   * positions.ts for why the alternative charges people twice.
   */
  readonly blinds?: {
    readonly smallBlindSeat: SeatIndex | null;
    readonly bigBlindSeat: SeatIndex;
  };
  /**
   * Deals a fixed deck instead of shuffling. Scenario Lab only: a teaching hand
   * must deal the same cards to every learner. Such a hand still carries a real
   * commitment and is labelled `fixed-deck-scenario` in `randomSourceKind`, so it
   * can never be mistaken for a fairly dealt one.
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

/**
 * Where the blinds fall for this deal, checked rather than trusted.
 *
 * The caller supplying the blinds is the caller taking responsibility for the
 * rotation, so every property the rest of the machine relies on is asserted here
 * — at the boundary, once, with a message that names the problem. Downstream
 * code then never has to ask whether the big blind is really in the hand.
 */
function resolveBlinds(
  options: StartHandOptions,
  occupied: readonly SeatIndex[],
): { readonly smallBlindSeat: SeatIndex | null; readonly bigBlindSeat: SeatIndex } {
  const { buttonSeat, config } = options;
  if (options.blinds === undefined) {
    // No rotation supplied: the button must be a real seat, because the blinds
    // are about to be derived from it.
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
    // A small blind seat that is not in the hand is a DEAD small blind, and a
    // dead small blind is spelled `null`. Passing the seat anyway would post a
    // blind for somebody who is not playing, so it is a caller bug, not a rule.
    throw new HandStateError(`small blind seat ${smallBlindSeat} has no player with chips; pass null`);
  }
  if (smallBlindSeat === bigBlindSeat) {
    throw new HandStateError(`seat ${bigBlindSeat} cannot post both blinds`);
  }
  if (occupied.length === 2) {
    // Heads-up the button IS the small blind, and both are the same live seat.
    // Everything downstream — who acts first preflop, who acts last afterwards —
    // depends on it, so it is refused rather than silently repaired.
    if (smallBlindSeat !== buttonSeat) {
      throw new HandStateError(
        `heads-up the button posts the small blind: button ${buttonSeat}, ` +
          `small blind ${String(smallBlindSeat)}`,
      );
    }
  }
  return { smallBlindSeat, bigBlindSeat };
}

/**
 * Deals a hand: shuffle, commit, post antes and blinds, deal hole cards, then set
 * the first player to act.
 */
export function startHand(options: StartHandOptions): StartedHand {
  validateConfig(options.config);
  const playing = validateSeats(options);
  const { config, buttonSeat } = options;

  const occupied = playing.map((seat) => seat.seat).sort((a, b) => a - b);
  const blinds = resolveBlinds(options, occupied);

  // The context binds the commitment to one specific hand, so a commitment can
  // never be replayed as the commitment for a different hand.
  const context = `${options.roomId}:${options.handNumber}:${options.handId}`;
  let commitment: DeckCommitment;
  let secret: DeckSecret;
  let sourceKind: HandState['randomSourceKind'];
  if (options.fixedDeck === undefined) {
    ({ commitment, secret } = commitToDeck(context, options.random));
    sourceKind = options.random.kind;
  } else {
    assertDistinctCards(options.fixedDeck, 'fixedDeck');
    if (options.fixedDeck.length !== DECK_SIZE) {
      throw new HandStateError(
        `fixedDeck must contain all ${DECK_SIZE} cards, got ${options.fixedDeck.length}`,
      );
    }
    ({ commitment, secret } = commitToKnownDeck(context, options.fixedDeck, options.random));
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

  // ---- forced bets ----
  //
  // Antes and blinds are both forced, but they are NOT the same kind of money.
  // A blind is a live bet: it counts towards the bet level, and the player who
  // posted it only has to add the difference to call. An ante is dead money: it
  // goes straight to the pot and buys no part of the current bet.
  //
  // So antes increase `committedTotal` (side pots must know a player paid it, and
  // a player all-in for only an ante is still eligible for that layer) and go
  // directly into `potFromPreviousStreets`, but they do NOT touch
  // `committedThisStreet`. Treating an ante as a live bet would make the opening
  // bet level `ante + bigBlind` and quietly break every call amount at the table.
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
        // A player who cannot cover a blind or ante is all-in, not folded: they
        // still have a live hand and can win the portion they paid for.
        status: stack === 0 ? 'allIn' : candidate.status,
        isAllInThisHand: candidate.isAllInThisHand || stack === 0,
      };
    });
  };

  if (config.ante > 0) {
    for (const target of orderFrom(buttonSeat, config.maxSeats, occupied)) post(target, config.ante, 'ante');
  }
  const { smallBlindSeat, bigBlindSeat } = blinds;
  // A dead small blind posts nothing at all. It is not "posted by the house" and
  // it is not moved onto the next player: the player it would move onto paid it
  // last hand, and charging them again is the defect the dead-button rule exists
  // to prevent. The hand is simply played for one big blind.
  if (smallBlindSeat !== null) post(smallBlindSeat, config.smallBlind, 'smallBlind');
  post(bigBlindSeat, config.bigBlind, 'bigBlind');
  events.push({ type: 'forcedBetsPosted', forcedBets });

  // ---- hole cards ----
  // One card at a time, twice round the table, starting left of the button. The
  // order matters because the revealed deck must match the order cards actually
  // came off it, or verification would fail on an honest hand.
  const dealOrder = orderFrom(buttonSeat, config.maxSeats, occupied);
  const holeCards = new Map<SeatIndex, Card[]>();
  // Which deck positions each seat's hole cards came from. Needed at showdown to
  // build Merkle proofs for the hands that actually get shown, and only those.
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

  // The opening bet level preflop is the big blind — the largest FULL wager in
  // force — and NOT merely the largest amount that happened to reach the pot.
  //
  // The difference is a player who posts the big blind short: they are all-in for
  // less than a big blind, so the biggest live commitment on the table can be as
  // little as the small blind (or an even smaller short small blind). A short
  // blind does not reduce what everyone else must pay to play. Deriving the level
  // from the largest commitment collapsed it onto the short post, which
  // under-charged every caller and, because the minimum raise is measured from the
  // level, let sub-minimum raises through: with 5/10 blinds and a big blind all-in
  // for 3, calls cost 5 instead of 10 and a "raise" to 15 was accepted instead of
  // the 20 the rules require.
  //
  // `Math.max` rather than a bare `config.bigBlind` because the level must never be
  // below what somebody has actually put in; validateConfig already guarantees
  // bigBlind >= smallBlind, so preflop the two agree, but the max keeps this honest
  // if a future forced bet posts above the big blind (a straddle, say).
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
    // The big blind counts as a complete bet of one big blind. That is what makes
    // the first raise have to reach 2 BB rather than BB + 1.
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

  // Blinds alone can leave nobody able to act — e.g. two players both all-in for
  // less than the big blind. In that case the board runs out immediately.
  const opener = firstActor(dealt, 'preflop');
  if (opener === null) {
    return { state: advanceStreets(closeStreet(dealt), events), secret, events };
  }
  return { state: { ...dealt, toAct: opener }, secret, events };
}

/** The first seat to act on a street, or null when nobody can act. */
function firstActor(state: HandState, street: BettingStreet): SeatIndex | null {
  // Covers both "one contender left" and "no further wagering is possible". The
  // second case matters at the top of a street and immediately after the blinds:
  // `owesAction` is true for any active seat that has not acted yet, so without
  // this guard the lone seat with chips behind would be asked to act — and offered
  // a fold, and a bet nobody could call — on a hand that is already all-in.
  if (isBettingClosedForHand(state)) return null;
  const occupied = dealtSeats(state.seats);
  // Preflop the opener is read off the big blind the hand actually posted, not
  // re-derived from the button. With a dead button or a dead small blind
  // `button + 2` is not the big blind, and re-deriving would open the action on
  // the wrong seat — under the gun would act out of turn, every hand.
  const start =
    street === 'preflop'
      ? firstToActPreflopFor(state.buttonSeat, state.bigBlindSeat, state.config.maxSeats, occupied)
      : firstToActPostflop(state.buttonSeat, state.config.maxSeats, occupied);
  // Walk clockwise from `start` inclusive.
  for (const candidate of [start, ...orderFrom(start, state.config.maxSeats, occupied)]) {
    const seat = state.seats.find((entry) => entry.seat === candidate);
    if (seat !== undefined && owesAction(state, seat)) return candidate;
  }
  return null;
}

/** The next seat clockwise from `from` that still owes an action, else null. */
function nextActor(state: HandState, from: SeatIndex): SeatIndex | null {
  const occupied = dealtSeats(state.seats);
  for (const candidate of orderFrom(from, state.config.maxSeats, occupied)) {
    const seat = state.seats.find((entry) => entry.seat === candidate);
    if (seat !== undefined && owesAction(state, seat)) return candidate;
  }
  return null;
}

export interface ApplyActionOptions {
  /** True when the server acted for a player who ran out of time. */
  readonly automatic?: boolean;
  readonly actionId?: string | null;
}

export interface AppliedAction {
  readonly state: HandState;
  readonly events: readonly HandEvent[];
}

/**
 * Applies one action and advances the hand as far as that action allows: closing
 * the street, dealing the next one, running out an all-in board, and settling.
 */
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
    // Records the bet level AFTER this action, not before.
    //
    // This matters for the raiser itself. If a raiser recorded the pre-action
    // level, then `mayRaise` (lastActed < lastFullRaiseBetLevel) would compare
    // the old level against the level the raiser just created, and the raiser
    // would be allowed to raise its own raise. Recording the post-action level
    // makes those two equal, so a player must wait for someone else to raise
    // before it can raise again — which is the actual rule.
    //
    // For a check or a call the two levels are identical, so this is only ever a
    // change for aggressive actions.
    lastActedAtBetLevel: betLevel,
    isAllInThisHand: actor.isAllInThisHand || stack === 0,
  };

  const seats = state.seats.map((entry) => (entry.seat === seat ? updatedActor : entry));

  // A complete raise reopens the action; a short all-in does not. Both cases are
  // expressed purely by whether lastFullRaiseBetLevel moves — there are no
  // per-seat "may raise" flags to keep in sync. See betting.ts.
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

  // Everyone folded to one player: settle without a showdown, cards unseen.
  if (seatsInHand(next).length <= 1) {
    return { state: settle(next, events, true), events };
  }

  // `isBettingRoundComplete` also returns true once no further wagering is possible
  // for the whole hand, so a call that puts the last opponent all-in falls straight
  // through to the run-out below instead of asking anyone else to act.
  if (!isBettingRoundComplete(next)) {
    const following = nextActor(next, seat);
    if (following !== null) return { state: { ...next, toAct: following }, events };
  }

  return { state: advanceStreets(closeStreet(next), events), events };
}

/** Sweeps this street's commitments into the pot and clears per-street state. */
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
 * Deals the next street. Normally one street then waits for action; when no
 * further betting is possible (everyone relevant is all-in) it runs the board out
 * to the river and shows down in one pass.
 *
 * Expects `state` to have already been passed through `closeStreet`.
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

    // Nobody can bet again: keep dealing to the river, then show down.
    if (isBettingClosedForHand(current)) continue;

    const opener = firstActor(current, nextStreet);
    if (opener === null) continue;
    return { ...current, toAct: opener };
  }
}

/** Builds pots, evaluates hands, awards chips and finalises the hand. */
function settle(state: HandState, events: HandEvent[], endedByFold: boolean): HandState {
  // Chips still sitting on the current street belong in the pot before we split
  // it into layers. `buildPots` works off committedTotal, which already includes
  // them, so this only keeps the displayed pot figure honest.
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
  // Uncontested chips go straight back to whoever put them in — they were never
  // part of a pot anyone could win, so they are not "winnings".
  for (const entry of returns) wonBySeat.set(entry.seat, (wonBySeat.get(entry.seat) ?? 0) + entry.amount);

  const netBySeat: Record<number, number> = {};
  const paidSeats = state.seats.map((seat) => {
    const won = wonBySeat.get(seat.seat) ?? 0;
    netBySeat[seat.seat] = won - seat.committedTotal;
    return { ...seat, stack: seat.stack + won, committedThisStreet: 0 };
  });

  // Only cards that legitimately became public are proved: every board card that
  // was actually dealt, plus the hole cards of seats that showed. A hand that ends
  // by folding therefore reveals no hole cards at all, which is the whole reason
  // the commitment is a per-card Merkle tree rather than a hash of the deck.
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

/**
 * The action the server takes for a player who ran out of time: check if that is
 * free, otherwise fold. Never a call — silently spending a timed-out player's
 * chips would be indefensible.
 */
export function timeoutAction(state: HandState, seat: SeatIndex): Action {
  const actor = seatAt(state, seat);
  const toCall = Math.max(0, state.betLevel - actor.committedThisStreet);
  return toCall === 0 ? { type: 'check' } : { type: 'fold' };
}

export { seatsAbleToAct, seatsInHand, totalPot };

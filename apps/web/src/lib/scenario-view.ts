/**
 * Turning an authored `Scenario` into the `PlayerView` the real `PokerTable` renders.
 *
 * ## Why this exists at all
 *
 * There is exactly one poker table in this app and it takes exactly one input: `PlayerView`, the
 * server's redacted view of a live hand. A scenario is not a live hand — nothing was dealt, there
 * is no deck and no commitment — but it describes the same situation, so the honest move is to
 * project it into the same shape rather than to build a second table that reads a second type.
 * A second table would drift: the live one would gain a feature and the teaching one would not.
 *
 * ## What is faithful, and what is a stand-in
 *
 * Faithful, because a scenario states it: seats, stacks, per-street commitments, the board, the
 * button, whose turn it is, the pot and what hero owes.
 *
 * Stand-ins, each named here rather than left for a reader to discover:
 *
 *  - `commitmentRoot` is empty and `commitmentContext` is `scenario:<id>`. There is no deck, so
 *    there is nothing to commit to and nothing to prove. `PokerTable` reads neither field; the
 *    context is filled in so that a value appearing anywhere unexpected can be traced back here.
 *  - `result` is null. A scenario is a decision point, not a finished hand.
 *  - `actions` and `forcedBets` are empty. A scenario states the action hero is *facing* in words
 *    (`facingAction`) rather than as a log, and inventing a log to match would be inventing history.
 *    `PokerTable` renders neither.
 *  - `randomSourceKind` is `'fixed-deck-scenario'`, which is the engine's own name for exactly this
 *    situation: cards that were chosen rather than dealt. It is the truthful value, and it is why
 *    the engine has that variant.
 *
 * ## Legal actions are derived, not taken from the engine
 *
 * `legalActions()` in `@prl/poker-engine` needs a `HandState`, which needs a deck. So the bounds
 * are derived here from the scenario, using the engine's own conventions:
 *
 *  - `to` is a TOTAL street commitment, never an increment.
 *  - the raise floor is `betLevel + max(betLevel - heroCommitted, bigBlind)` — the bet level plus
 *    the last full raise increment, floored at one big blind, which is the rule
 *    `redactFor` encodes as `minimumRaiseTo`.
 *  - the ceiling is `heroCommitted + heroStack`: hero's whole stack expressed as a street total.
 *  - when the floor exceeds the ceiling a full raise is impossible, so the only legal raise is
 *    all-in and floor and ceiling collapse onto the ceiling. That is the engine's behaviour and
 *    `ActionBar` needs it, or the sizer would offer an amount the server would reject.
 *
 * The server re-derives and re-validates all of this on arrival, so nothing here is authoritative.
 * Its job is to make the illegal amount unreachable in the sizer, which is what stops a learner
 * meeting a rejection they could not have predicted.
 *
 * Pure and server-safe: no state, no effects, no `window`.
 */

import type { Scenario, ScenarioSeat } from '@prl/contracts';
import type { LegalAction, PlayerView, SeatStatus, SeatView } from '@prl/poker-engine';
import { parseCards, positionLabels } from '@prl/poker-engine';

export interface ScenarioTable {
  readonly view: PlayerView;
  /** The hero seat index, for the components that need to address it directly. */
  readonly heroSeat: number;
  /** The legal actions offered to hero, already bounded. Empty when hero has no decision. */
  readonly legalActions: readonly LegalAction[];
}

/** A pair of cards, or null when the notation does not parse into exactly two. */
function holeCardsOf(seat: ScenarioSeat): readonly [number, number] | null {
  if (seat.holeCards === undefined) return null;
  let parsed: readonly number[];
  try {
    parsed = parseCards(seat.holeCards);
  } catch {
    // A scenario with unparseable cards is a content bug. Returning null draws a face-down card,
    // which is a visible failure that does not take the page down with it.
    return null;
  }
  const [first, second] = parsed;
  if (first === undefined || second === undefined) return null;
  return [first, second];
}

/**
 * Builds the view, or null when the scenario has no usable hero seat.
 *
 * Null rather than a partial view: a table drawn without hero's cards would silently ask the
 * learner a different question from the one the scenario wrote.
 */
export function scenarioToPlayerView(scenario: Scenario): ScenarioTable | null {
  const hero = scenario.seats.find((seat) => seat.isHero === true);
  if (hero === undefined) return null;
  const heroCards = holeCardsOf(hero);
  if (heroCards === null) return null;

  let board: readonly number[];
  try {
    board = scenario.board === '' ? [] : parseCards(scenario.board);
  } catch {
    return null;
  }

  const committed = scenario.committedThisStreet ?? {};
  const commitmentOf = (seat: number): number => committed[seat] ?? 0;
  const betLevel = scenario.seats.reduce((highest, seat) => Math.max(highest, commitmentOf(seat.seat)), 0);
  const potTotal =
    scenario.potBeforeStreet + scenario.seats.reduce((sum, seat) => sum + commitmentOf(seat.seat), 0);

  const occupied = scenario.seats.map((seat) => seat.seat);
  const maxSeats = Math.max(2, Math.min(6, scenario.seats.length));
  // `positionLabels` needs at least two occupied seats and throws on a layout it cannot read. A
  // scenario without positions is still a perfectly renderable table, so a failure here degrades
  // to unlabelled seats rather than to no table.
  let labels: ReadonlyMap<number, SeatView['position']>;
  try {
    labels = occupied.length >= 2 ? positionLabels(scenario.buttonSeat, maxSeats, occupied) : new Map();
  } catch {
    labels = new Map();
  }

  const seats: SeatView[] = scenario.seats.map((seat) => {
    const isHero = seat.isHero === true;
    const cards = isHero ? heroCards : null;
    const status: SeatStatus = 'active';
    return {
      seat: seat.seat,
      // Not an opaque server id, because there is no server here. The label is what a scenario has,
      // and `PokerTable` never renders `playerId` — it takes names from `seatNames`.
      playerId: `scenario-seat-${seat.seat}`,
      stack: seat.stack,
      committedThisStreet: commitmentOf(seat.seat),
      committedTotal: commitmentOf(seat.seat),
      status,
      position: labels.get(seat.seat) ?? null,
      holeCards: cards,
      isSelf: isHero,
      isButton: seat.seat === scenario.buttonSeat,
      isToAct: isHero,
    };
  });

  const heroCommitted = commitmentOf(hero.seat);
  const view: PlayerView = {
    handId: `scenario-${scenario.id}`,
    roomId: 'scenario-lab',
    handNumber: 0,
    config: {
      smallBlind: scenario.smallBlind,
      bigBlind: scenario.bigBlind,
      ante: scenario.ante ?? 0,
      maxSeats,
      // A scenario has no clock. Zero is the inert value rather than a plausible-looking 30, and
      // `PokerTable` does not render it.
      actionTimeoutSeconds: 0,
    },
    street: scenario.street,
    board,
    buttonSeat: scenario.buttonSeat,
    seats,
    toAct: hero.seat,
    betLevel,
    minimumRaiseTo: raiseFloor(betLevel, heroCommitted, scenario.bigBlind),
    potTotal,
    // One main pot. Side pots only form when a seat is all in for less than the bet level, and a
    // scenario states no all-in — every seat in `ScenarioSeat` has a stack behind it.
    pots: [
      {
        amount: potTotal,
        eligibleSeats: occupied,
        capPerSeat: betLevel,
        index: 0,
      },
    ],
    forcedBets: [],
    actions: [],
    actionSequence: 0,
    legalActions: [],
    amountToCall: scenario.toCall,
    commitmentRoot: '',
    commitmentContext: `scenario:${scenario.id}`,
    result: null,
    viewerSeat: hero.seat,
    randomSourceKind: 'fixed-deck-scenario',
  };

  return {
    view,
    heroSeat: hero.seat,
    legalActions: heroLegalActions(scenario, hero, betLevel, heroCommitted),
  };
}

/** The bet level plus the last full raise increment, floored at one big blind. */
function raiseFloor(betLevel: number, heroCommitted: number, bigBlind: number): number {
  return betLevel + Math.max(betLevel - heroCommitted, bigBlind);
}

/**
 * The actions hero may take, with the bounds the sizer clamps to.
 *
 * `costAtMin` and `allInAtMax` are filled in because `ActionBar` prints them on the buttons: a
 * player should never have to work out what a button will cost them.
 */
function heroLegalActions(
  scenario: Scenario,
  hero: ScenarioSeat,
  betLevel: number,
  heroCommitted: number,
): readonly LegalAction[] {
  const ceiling = heroCommitted + hero.stack;
  const owed = scenario.toCall;
  const actions: LegalAction[] = [];

  if (owed > 0) {
    actions.push({
      type: 'fold',
      note: 'Give up the hand and lose what you have already committed.',
    });
    actions.push({
      type: 'call',
      minTo: heroCommitted + Math.min(owed, hero.stack),
      costAtMin: Math.min(owed, hero.stack),
      note: 'Match the current bet and see the next card.',
    });
  } else {
    actions.push({ type: 'check', note: 'Stay in the hand without putting chips in.' });
  }

  // Aggression needs chips behind the call. With none there is nothing to size.
  if (ceiling > heroCommitted + Math.min(owed, hero.stack)) {
    const floor = owed > 0 ? raiseFloor(betLevel, heroCommitted, scenario.bigBlind) : scenario.bigBlind;
    const capped = Math.min(floor, ceiling);
    const isAllInOnly = floor >= ceiling;
    actions.push({
      type: owed > 0 ? 'raise' : 'bet',
      minTo: capped,
      maxTo: ceiling,
      costAtMin: capped - heroCommitted,
      allInAtMax: true,
      note: isAllInOnly
        ? 'A full raise is larger than your remaining stack, so the only raise available is all in.'
        : 'Amounts are TOTAL commitment for this street, not the increment you are adding.',
    });
  }

  return actions;
}

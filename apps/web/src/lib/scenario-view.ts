/**
 * Projects an authored `Scenario` into the `PlayerView` the one real `PokerTable` renders, so there is
 * no second table to drift. With no deck, `commitmentRoot` is empty, `result` is null, `actions` and
 * `forcedBets` are empty and `randomSourceKind` is `'fixed-deck-scenario'`. Legal actions are derived
 * here with the engine's conventions (`to` is a total street commitment). The server re-validates
 * them; this only keeps an illegal amount out of the sizer.
 */

import type { Scenario, ScenarioSeat } from '@prl/contracts';
import type { LegalAction, PlayerView, PositionLabel, SeatStatus, SeatView } from '@prl/poker-engine';
import { assignBlinds, parseCards, positionLabels } from '@prl/poker-engine';

export interface ScenarioTable {
  readonly view: PlayerView;
  readonly heroSeat: number;
  /** The legal actions offered to hero, already bounded. Empty when hero has no decision. */
  readonly legalActions: readonly LegalAction[];
}

const POSITION_LABELS: ReadonlySet<string> = new Set<PositionLabel>([
  'BTN',
  'SB',
  'BB',
  'UTG',
  'UTG+1',
  'MP',
  'HJ',
  'CO',
  'BTN/SB',
]);

/**
 * Every bundled seat is labelled with its position, which the plate already prints, so a position
 * label becomes the seat's role. Any other label is kept.
 */
export function scenarioSeatName(seat: ScenarioSeat): string {
  if (!POSITION_LABELS.has(seat.label)) return seat.label;
  return seat.isHero === true ? 'You' : 'Opponent';
}

function holeCardsOf(seat: ScenarioSeat): readonly [number, number] | null {
  if (seat.holeCards === undefined) return null;
  let parsed: readonly number[];
  try {
    parsed = parseCards(seat.holeCards);
  } catch {
    // Null draws a face-down card, a visible failure that keeps the page up.
    return null;
  }
  const [first, second] = parsed;
  if (first === undefined || second === undefined) return null;
  return [first, second];
}

/** Null rather than a partial view, which would ask a different question from the scenario's. */
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

  const occupied = scenario.seats.map((seat) => seat.seat).sort((a, b) => a - b);
  // CHAIRS, not players. Seat walks are `% maxSeats`, so two players at seats 3 and 5 need a six-max table.
  const maxSeats = Math.max(2, Math.min(6, Math.max(...occupied, 1) + 1));
  // An unreadable layout degrades to unlabelled seats, not to no table. Blinds are stated, because a
  // single authored spot has no previous hand, so the button fixes them (the case `assignBlinds` fits).
  let labels: ReadonlyMap<number, SeatView['position']>;
  try {
    const blinds = assignBlinds(scenario.buttonSeat, maxSeats, occupied);
    labels = positionLabels(scenario.buttonSeat, maxSeats, occupied, blinds);
  } catch {
    labels = new Map();
  }

  const seats: SeatView[] = scenario.seats.map((seat) => {
    const isHero = seat.isHero === true;
    const cards = isHero ? heroCards : null;
    const status: SeatStatus = 'active';
    return {
      seat: seat.seat,
      // `PokerTable` never renders `playerId`. It takes names from `seatNames`.
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
      // A scenario has no clock. Zero is the inert value.
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
    // One main pot. A scenario states no all-in, so no side pot can form.
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

function raiseFloor(betLevel: number, heroCommitted: number, bigBlind: number): number {
  return betLevel + Math.max(betLevel - heroCommitted, bigBlind);
}

/** `costAtMin` and `allInAtMax` are filled because `ActionBar` prints them on the buttons. */
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

  // Aggression needs chips behind on both sides, the same `stack > 0` test the Coach's
  // `deriveLegalActions` makes, or the Lab offers a raise the Coach never priced.
  const someOpponentCanAnswer = scenario.seats.some((seat) => seat.isHero !== true && seat.stack > 0);
  // Keyed on the bet level, not on what is owed, so the big blind's option in a limped pot is a raise
  // floored at the raise floor, matching how the Coach names the action.
  if (someOpponentCanAnswer && ceiling > heroCommitted + Math.min(owed, hero.stack)) {
    const isRaise = betLevel > 0;
    const floor = isRaise ? raiseFloor(betLevel, heroCommitted, scenario.bigBlind) : scenario.bigBlind;
    const capped = Math.min(floor, ceiling);
    const isAllInOnly = floor >= ceiling;
    actions.push({
      type: isRaise ? 'raise' : 'bet',
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

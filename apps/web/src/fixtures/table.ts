/**
 * The play screen's fixtures: four table states and the Coach report that goes with them.
 *
 * ## Why fixtures exist here at all
 *
 * The API and the WebSocket that will feed `/play` are being built in parallel with this screen, so
 * a screen that could only render from a live server could not be built, reviewed, or checked in CI
 * without a database. Every state below is typed against the real contract — `PlayerView` as
 * `@prl/poker-engine` redacts it, `CoachReport` as `@prl/contracts` declares it — so the day the
 * socket lands, the only change is where the object comes from. Nothing in the components knows the
 * difference, and TypeScript fails the build if the wire shape moves.
 *
 * This is not mock-driven development for its own sake. It is also the only way to get a
 * *deterministic* render of a state that is hard to reach by playing: a three-way all-in with a side
 * pot, a completed hand with three hands shown, a decision with 15 outs.
 *
 * ## The numbers are derived, not decorative
 *
 * Every figure in `FLOP_DECISION_REPORT` is arithmetic on the spot in `FLOP_DECISION_VIEW`, and the
 * derivation is written out beside it. That matters for two reasons. The obvious one: a fixture with
 * inconsistent numbers teaches a reviewer nothing about whether the panel renders a coherent report.
 * The less obvious one: ADR 0006 forbids hard-coded odds in *content*, because a number nobody can
 * reproduce is a number nobody can correct. A fixture is not content, but the same discipline
 * applies — anyone can check the working below.
 *
 * The spot is deliberately the one from the design system: `Ah Kh` on `Qh 7h 2c`, a nut flush draw
 * with two overcards, facing a small continuation bet. It exercises every branch that matters —
 * clean and dirty outs, a large equity surplus, a Monte Carlo interval, a raise suggestion with a
 * size range and only moderate confidence.
 *
 * ## Scale
 *
 * Blinds 5/10 with 1,000-unit stacks, matching `STARTING_UNITS` in `fixtures/session.ts`. Units are
 * free, resettable and valueless; there is no currency symbol anywhere in this file, and there never
 * will be.
 */

import type { CoachReport } from '@prl/contracts';
import type { TurnClock } from '@prl/ui';
import { type PlayerView, parseCardText } from '@prl/ui';

/** Which fixture a request asked for. `decision` is the default and the interesting one. */
export const TABLE_STATES = ['decision', 'loading', 'error', 'complete'] as const;
export type TableStateName = (typeof TABLE_STATES)[number];

export function isTableStateName(value: unknown): value is TableStateName {
  return typeof value === 'string' && (TABLE_STATES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

/**
 * `"Qh 7h 2c"` to the engine's integers, via the same parser the Coach panel uses on its out cards.
 *
 * It throws on a bad token rather than falling back, and that is the point: a typo in a fixture
 * should stop the module loading, loudly, at the moment somebody makes it. A silently-dropped card
 * would show up as a four-card flop that nobody notices for a week.
 */
function cards(text: string): readonly number[] {
  const out: number[] = [];
  for (const token of text.split(' ')) {
    const card = parseCardText(token);
    if (card === null) throw new Error(`fixture card "${token}" is not a card`);
    out.push(card);
  }
  return out;
}

/** A hole-card pair, as the tuple `SeatView.holeCards` requires. */
function pair(text: string): readonly [number, number] {
  const parsed = cards(text);
  const [first, second] = parsed;
  if (first === undefined || second === undefined || parsed.length !== 2) {
    throw new Error(`fixture hole cards "${text}" must be exactly two cards`);
  }
  return [first, second];
}

const HERO_CARDS = pair('Ah Kh');
const FLOP = cards('Qh 7h 2c');
const RIVERED_BOARD = cards('Qh 7h 2c Jh 3s');
/** Hero's best five at showdown: the ace-high flush, ringed in the completed-hand view. */
const HERO_BEST_FIVE = cards('Ah Kh Qh Jh 7h');

// ---------------------------------------------------------------------------
// Seats
// ---------------------------------------------------------------------------

/**
 * Display names by seat index.
 *
 * `SeatView.playerId` is an opaque id and is never rendered — showing one would be both meaningless
 * to a reader and a small privacy leak. The bots are named for their strategy profile rather than
 * given human names, which is the honest description of what they are: a set of numbers, not a
 * person. No celebrity names and no likenesses anywhere (see docs/AI-LEGENDS.md).
 */
export const SEAT_NAMES: Readonly<Record<number, string>> = {
  0: 'You',
  1: 'Tight-passive bot',
  2: 'Loose-aggressive bot',
  3: 'Balanced bot',
  4: 'Calling-station bot',
  5: 'Nit bot',
};

const TABLE_CONFIG = {
  smallBlind: 5,
  bigBlind: 10,
  ante: 0,
  maxSeats: 6,
  actionTimeoutSeconds: 30,
} as const;

/**
 * A placeholder where the wire carries a Merkle root.
 *
 * No screen in this build renders it, and a plausible-looking 64-hex string would be a fabricated
 * cryptographic commitment sitting in the repo — exactly the kind of thing that later gets mistaken
 * for a real one. A real root only ever comes from the server, and hand review verifies it.
 */
const FIXTURE_COMMITMENT = 'fixture-no-commitment';
const FIXTURE_COMMITMENT_CONTEXT = 'fixture-no-context';

// ---------------------------------------------------------------------------
// The decision: hero faces 35 into 100 on the flop
// ---------------------------------------------------------------------------

/**
 * The hand so far, which is what makes every stack below add up:
 *
 *   preflop  small blind 5, big blind 10 (hero)
 *            under the gun folds, hijack folds
 *            cutoff raises to 30
 *            button folds, small blind folds (its 5 stays in the middle)
 *            hero calls 30
 *            pot = 5 + 30 + 30 = 65
 *
 *   flop     Qh 7h 2c
 *            cutoff bets 35
 *            pot = 100, hero owes 35
 *
 * So: hero has 1,000 - 30 = 970 behind, the cutoff 1,000 - 65 = 935, the small blind 995, and every
 * folded seat still has its 1,000. The minimum raise is to 70 — the 35 bet plus a full 35 increment.
 */
export const FLOP_DECISION_VIEW: PlayerView = {
  handId: 'fixture-hand-0012',
  roomId: 'fixture-room',
  handNumber: 12,
  config: TABLE_CONFIG,
  street: 'flop',
  board: FLOP,
  buttonSeat: 4,
  seats: [
    {
      seat: 0,
      playerId: 'fixture-user',
      stack: 970,
      committedThisStreet: 0,
      committedTotal: 30,
      status: 'active',
      position: 'BB',
      holeCards: HERO_CARDS,
      isSelf: true,
      isButton: false,
      isToAct: true,
    },
    {
      seat: 1,
      playerId: 'fixture-bot-1',
      stack: 1000,
      committedThisStreet: 0,
      committedTotal: 0,
      status: 'folded',
      position: 'UTG',
      holeCards: null,
      isSelf: false,
      isButton: false,
      isToAct: false,
    },
    {
      seat: 2,
      playerId: 'fixture-bot-2',
      stack: 1000,
      committedThisStreet: 0,
      committedTotal: 0,
      status: 'folded',
      position: 'HJ',
      holeCards: null,
      isSelf: false,
      isButton: false,
      isToAct: false,
    },
    {
      seat: 3,
      playerId: 'fixture-bot-3',
      stack: 935,
      committedThisStreet: 35,
      committedTotal: 65,
      status: 'active',
      position: 'CO',
      holeCards: null,
      isSelf: false,
      isButton: false,
      isToAct: false,
    },
    {
      seat: 4,
      playerId: 'fixture-bot-4',
      stack: 1000,
      committedThisStreet: 0,
      committedTotal: 0,
      status: 'folded',
      position: 'BTN',
      holeCards: null,
      isSelf: false,
      isButton: true,
      isToAct: false,
    },
    {
      seat: 5,
      playerId: 'fixture-bot-5',
      stack: 995,
      committedThisStreet: 0,
      committedTotal: 5,
      status: 'folded',
      position: 'SB',
      holeCards: null,
      isSelf: false,
      isButton: false,
      isToAct: false,
    },
  ],
  toAct: 0,
  betLevel: 35,
  minimumRaiseTo: 70,
  potTotal: 100,
  pots: [{ amount: 100, eligibleSeats: [0, 3], capPerSeat: 65, index: 0 }],
  forcedBets: [
    { kind: 'smallBlind', seat: 5, amount: 5, wasShort: false },
    { kind: 'bigBlind', seat: 0, amount: 10, wasShort: false },
  ],
  /**
   * Deliberately empty. No screen in this build renders the action log — hand review does, from the
   * server's own record — and a hand-written log here would be a second source of truth that could
   * drift out of step with the seats above. `actionSequence` is real: it is the number the
   * ActionBar's `expectedSequence` echoes back, so a stale decision is rejected rather than applied
   * to a spot the player never saw.
   */
  actions: [],
  actionSequence: 7,
  legalActions: [
    { type: 'fold', note: 'Gives up the hand and any claim on the 100 units already in the middle.' },
    {
      type: 'call',
      minTo: 35,
      costAtMin: 35,
      note: 'Matches the bet and sees the turn.',
    },
    {
      type: 'raise',
      minTo: 70,
      maxTo: 970,
      costAtMin: 70,
      allInAtMax: true,
      note: 'The minimum raise is the bet plus one full increment; the maximum is your whole stack.',
    },
  ],
  amountToCall: 35,
  commitmentRoot: FIXTURE_COMMITMENT,
  commitmentContext: FIXTURE_COMMITMENT_CONTEXT,
  result: null,
  viewerSeat: 0,
  randomSourceKind: 'fixed-deck-scenario',
};

/**
 * The turn clock, expressed the way the wire expresses it: an absolute deadline on the SERVER's
 * clock plus the server's own reading in the same frame.
 *
 * Both are fixed numbers rather than `Date.now()`, and that is not laziness — `TurnTimer` only ever
 * uses the *difference* between them, so a fixed pair renders identically on the server and in the
 * browser and produces a stable, screenshot-comparable 22 seconds remaining out of a 30-second
 * budget. Reading the real clock here would make the render non-deterministic and would tempt the
 * component into trusting a client timestamp, which is the thing it exists not to do.
 */
export const FLOP_DECISION_TURN: TurnClock = {
  serverTimeMs: 1_771_286_400_000,
  deadlineMs: 1_771_286_422_000,
  budgetSeconds: TABLE_CONFIG.actionTimeoutSeconds,
};

// ---------------------------------------------------------------------------
// The Coach report for that decision
// ---------------------------------------------------------------------------

/**
 * The arithmetic, in full, so every figure below can be checked.
 *
 * OUTS. Hero holds `Ah Kh` on `Qh 7h 2c`. Nine hearts remain (13 minus the four on show), and three
 * aces and three kings pair an overcard: 15 cards improve the hand.
 *
 * EQUITY. Two cards to come, 47 unseen:
 *   1 - (32/47) x (31/46) = 1 - 0.68085 x 0.67391 = 0.5410
 * so 54.10%. The rule of 4 says 15 x 4 = 60%, which overstates it by 5.9 points — the rule
 * double-counts the boards where two outs arrive, and the error grows with the number of outs.
 *
 * The report calls this Monte Carlo rather than exact, because the real engine samples against a
 * *range* rather than one hand. At 80,000 trials the 95% half-width is
 *   1.96 x sqrt(0.5410 x 0.4590 / 80,000) = 1.96 x 0.001762 = 0.00345
 * which is 0.35 percentage points. Hence `trials: 80000` and `confidenceHalfWidthPoints: 0.35` —
 * the two are tied together, and changing one without the other would make the panel print an
 * interval that its own trial count cannot support.
 *
 * POT ODDS. 35 to call into 100:
 *   break-even = 35 / (100 + 35) = 0.259259
 *   price      = 100 / 35 = 2.857 to 1
 *   surplus    = 0.5410 - 0.259259 = 0.281741, i.e. +28.2 points
 *
 * EV, all measured against folding, which is why folding is 0:
 *   call     0.5410 x 135 - 35 = 73.03 - 35 = +38.0
 *   raise    with 35% fold equity and 105 committed, the opponent calling for 70 more makes the pot
 *            100 + 105 + 70 = 275:
 *            0.35 x 100 + 0.65 x (0.5410 x 275 - 105) = 35 + 0.65 x 43.78 = +63.5
 *
 * The raise model is a *single* simplification — one call, no further betting — and it is stated in
 * the assumptions rather than hidden. That is the whole reason the assumptions are never collapsible.
 *
 * STACK. Effective stack is the smaller of the two remaining: min(970, 935) = 935. Stack-to-pot
 * ratio 935 / 100 = 9.35, which `describeSpr` bands as "high". A pot-sized bet of 100 into 100 asks
 * a caller for 100 into a 300 pot: 0.3333.
 */
export const FLOP_DECISION_REPORT: CoachReport = {
  street: 'flop',
  potTotal: 100,
  toCall: 35,

  outs: {
    clean: 9,
    dirty: 6,
    total: 15,
    cleanCards: ['2h', '3h', '4h', '5h', '6h', '8h', '9h', 'Th', 'Jh'],
    dirtyCards: ['As', 'Ad', 'Ac', 'Ks', 'Kd', 'Kc'],
    explanation:
      'Nine hearts complete the nut flush and beat everything in the assumed range. The three aces and three kings pair an overcard, which beats one pair of queens but loses to two pair, a set, or a flush the cutoff could hold with a heart of their own — so they are counted separately rather than added to the nine.',
  },

  equity: {
    heroEquity: 0.541,
    method: 'monte-carlo',
    trials: 80_000,
    confidenceHalfWidthPoints: 0.35,
    ruleOfThumb: {
      estimate: 0.6,
      errorPoints: 5.9,
      note: 'The rule of 4 multiplies 15 outs by 4 and lands on 60%. It overstates the truth because it double-counts the runouts where two outs arrive, and the error grows with the number of outs — at 15 it is nearly six points.',
    },
    perPlayer: [
      { label: 'You, ace-king of hearts', equity: 0.541, win: 0.5386, tie: 0.0048 },
      { label: 'Cutoff, the assumed continuation-betting range', equity: 0.459, win: 0.4566, tie: 0.0048 },
    ],
  },

  potOdds: {
    pot: 100,
    toCall: 35,
    breakEvenEquity: 0.259259,
    oddsRatio: 2.857,
    equitySurplus: 0.281741,
    explanation:
      'Calling 35 into 100 needs 25.9% to break even and the hand is estimated at 54.1%, so the price is far better than the hand requires. That is a statement about this call in isolation: it says nothing about whether a raise is worth more, which the expected values below address.',
  },

  candidates: [
    {
      action: 'fold',
      cost: 0,
      ev: 0,
      derivation:
        'Folding is the baseline every other figure is measured against: it costs nothing more and wins nothing, so its expected value is zero by definition.',
    },
    {
      action: 'call',
      cost: 35,
      ev: 38.0,
      derivation:
        '0.541 of the 135 units in the middle after the call, minus the 35 the call costs: 73.0 - 35.0.',
      potShareIfCalled: 0.541,
    },
    {
      action: 'raise',
      to: 105,
      cost: 105,
      ev: 63.5,
      derivation:
        'Two branches. The cutoff folds 35% of the time and the 100 already in the middle is won uncontested. The other 65% they call for 70 more, making the pot 275, of which this hand is estimated to win 0.541: 0.35 x 100 + 0.65 x (148.8 - 105).',
      foldEquityAssumed: 0.35,
      potShareIfCalled: 0.541,
    },
  ],

  suggestion: {
    action: 'raise',
    sizeRange: { min: 90, max: 120 },
    confidence: 'moderate',
    reason:
      'Raising is worth more than calling under the assumptions listed below, because a hand with 15 improving cards keeps its value when the raise is called and picks up the pot when it is not. Confidence is moderate rather than high because the figure turns on an assumed fold frequency of 35%, which is a guess about one opponent rather than a measurement.',
    whatWouldChangeIt: [
      'A cutoff who folds far less often than 35% to a flop raise — though on its own that does not flip the decision, and it is worth seeing why. Each point of fold equity is worth about 0.56 chips here, so at 20% the raise is still 17.0 chips ahead of the call and at zero fold equity it is 5.7 ahead. What carries the raise is 54.1%, not the folds: above an even share, more units in the middle is worth more than more folds. The two lines are worth exactly the same at 50% equity, and below it the call is better.',
      'A shorter effective stack. With less than about three times the pot behind, raising commits the stack on this street and the flush draw no longer has two cards to arrive.',
      'A board where a heart also completes a straight for the range, which would move cards out of the clean column and into the dirty one.',
      'Any read that the cutoff is betting a range containing sets and two pair rather than one pair, which lowers the estimated 54.1% directly.',
    ],
  },

  stackContext: {
    effectiveStack: 935,
    spr: 9.35,
    potOddsOfferedByPotSizedBet: 0.3333,
    explanation:
      'The effective stack is the smaller of the two remaining, 935, which is 9.35 times the pot. At that depth several streets of choices are still ahead, so the decision here does not commit the stack and implied odds carry more of the argument than they would at a ratio of two.',
  },

  assumptions: [
    'The cutoff is betting a range of one-pair hands and draws, weighted towards a queen. Every equity figure above is measured against that range and not against a specific pair of cards.',
    'The cutoff folds to a flop raise 35% of the time. This is an assumed frequency, not an observed one.',
    'The raise model assumes at most one call and no further betting on the turn or the river. Real hands have later streets, and the expected value of a raise usually rises when they are included.',
    'Equity was sampled rather than enumerated, so it carries the interval printed beside it.',
    'Every figure is in free, resettable units with no value, and none of them predicts the result of this particular hand.',
  ],

  uncertainty: {
    method: 'monte-carlo',
    summary:
      'Equity came from 80,000 sampled runouts against the assumed range. A sample is not the truth: it is an estimate with a spread, and the spread is printed beside every figure derived from it.',
    confidenceInterval: { level: 0.95, halfWidthPoints: 0.35 },
    limitations: [
      'The range assumption dominates every number here. A different range for the cutoff moves the equity by more than the sampling error does.',
      'Fold equity is assumed, not measured. It is the single largest source of error in the raise line.',
      'One street is modelled. Implied odds from later betting are not counted, which understates the value of a drawing hand.',
      'Nothing here accounts for how the cutoff reacts to a raise on later streets, or for what this raise tells them about the hand.',
    ],
  },

  teachingNotes: [
    'The gap between the rule of 4 and the sampled figure is the lesson: shortcuts are for the table, not for the analysis. At 15 outs the shortcut is nearly six points too generous.',
    'A price that is better than the hand needs makes calling profitable. It does not make calling the most profitable action — comparing expected values is a different question from comparing equity with break-even.',
    'Nine of the fifteen outs win outright and six only sometimes do. Counting all fifteen as outs is the most common way this spot gets overvalued.',
  ],
};

// ---------------------------------------------------------------------------
// The completed hand: a three-way all-in, one side pot, three hands shown
// ---------------------------------------------------------------------------

/**
 * A different hand, included because a side pot is hard to reach by playing and easy to get wrong in
 * a layout: the main pot and the side pot have different eligibility lists, and a reader has to be
 * able to see which is which.
 *
 * Hero came into this hand short, on 300, which is the only way a side pot can form — with equal
 * stacks every all-in is for the same amount and there is nothing to layer. The cutoff and the button
 * each committed 600 out of 1,000, and the small blind's 5 was already dead in the middle:
 *
 *   main pot  300 x 3 + the dead 5 = 905, contested by all three
 *   side pot  300 x 2 = 600, contested by the two who could cover hero's 300
 *   total     1,505
 *
 * Hero's ace-high flush therefore takes the main pot only; the side pot goes to the better of the two
 * hands that could cover it. That is exactly the fact a learner most often gets wrong about all-ins,
 * and it is why this state exists.
 *
 * `result` is left null on purpose. It carries the revealed deck and the Merkle proofs, and the screen
 * that renders those is hand review — which gets them from the server and verifies them. Fabricating
 * a proof here would put a fake cryptographic artefact in the repo.
 *
 * The play screen pairs this view with `FLOP_DECISION_REPORT`, because the flop it was analysing is
 * this hand's flop and the same two hole cards. The pot and price in that report are from a
 * differently-stacked hand, so the pairing is a fixture convenience rather than a claim: when the API
 * lands, a completed hand's analysis comes from `HandReviewResponse.decisions`, per decision.
 */
export const COMPLETED_HAND_VIEW: PlayerView = {
  handId: 'fixture-hand-0013',
  roomId: 'fixture-room',
  handNumber: 13,
  config: TABLE_CONFIG,
  street: 'complete',
  board: RIVERED_BOARD,
  buttonSeat: 4,
  seats: [
    {
      seat: 0,
      playerId: 'fixture-user',
      stack: 0,
      committedThisStreet: 0,
      committedTotal: 300,
      status: 'allIn',
      position: 'BB',
      holeCards: HERO_CARDS,
      isSelf: true,
      isButton: false,
      isToAct: false,
    },
    {
      seat: 1,
      playerId: 'fixture-bot-1',
      stack: 1000,
      committedThisStreet: 0,
      committedTotal: 0,
      status: 'folded',
      position: 'UTG',
      holeCards: null,
      isSelf: false,
      isButton: false,
      isToAct: false,
    },
    {
      seat: 2,
      playerId: 'fixture-bot-2',
      stack: 1000,
      committedThisStreet: 0,
      committedTotal: 0,
      status: 'folded',
      position: 'HJ',
      holeCards: null,
      isSelf: false,
      isButton: false,
      isToAct: false,
    },
    {
      seat: 3,
      playerId: 'fixture-bot-3',
      stack: 400,
      committedThisStreet: 0,
      committedTotal: 600,
      status: 'active',
      position: 'CO',
      holeCards: pair('Qs Qd'),
      isSelf: false,
      isButton: false,
      isToAct: false,
    },
    {
      seat: 4,
      playerId: 'fixture-bot-4',
      stack: 400,
      committedThisStreet: 0,
      committedTotal: 600,
      status: 'active',
      position: 'BTN',
      holeCards: pair('7s 7d'),
      isSelf: false,
      isButton: true,
      isToAct: false,
    },
    {
      seat: 5,
      playerId: 'fixture-bot-5',
      stack: 995,
      committedThisStreet: 0,
      committedTotal: 5,
      status: 'folded',
      position: 'SB',
      holeCards: null,
      isSelf: false,
      isButton: false,
      isToAct: false,
    },
  ],
  toAct: null,
  betLevel: 0,
  minimumRaiseTo: 10,
  potTotal: 1505,
  pots: [
    /**
     * 905, not 900. The layers are `5` (the dead small blind), `295 x 3` up to hero's all-in cap, and
     * `300 x 2` above it; the first two have the same three live claimants, so pot building merges
     * them into one main pot of `20 + 885`. A dead blind landing in the main pot is exactly the
     * detail a round number would hide.
     */
    { amount: 905, eligibleSeats: [0, 3, 4], capPerSeat: 300, index: 0 },
    { amount: 600, eligibleSeats: [3, 4], capPerSeat: 600, index: 1 },
  ],
  forcedBets: [
    { kind: 'smallBlind', seat: 5, amount: 5, wasShort: false },
    { kind: 'bigBlind', seat: 0, amount: 10, wasShort: false },
  ],
  actions: [],
  actionSequence: 19,
  legalActions: [],
  amountToCall: 0,
  commitmentRoot: FIXTURE_COMMITMENT,
  commitmentContext: FIXTURE_COMMITMENT_CONTEXT,
  result: null,
  viewerSeat: 0,
  randomSourceKind: 'fixed-deck-scenario',
};

/**
 * What happened, in plain sentences.
 *
 * Stated as facts, with no flourish and no second person congratulation. Rewarding the *outcome* is
 * the core casino dark pattern; this product rewards the decision, and the place the positive
 * feedback lives is the analysis, not the result.
 */
export const COMPLETED_HAND_SUMMARY: readonly string[] = [
  'Main pot, 905 units: your ace-high flush. It includes the small blind that was folded.',
  'Side pot, 600 units: three queens, the balanced bot. You were all in for less, so you were not eligible for it.',
  'Three hands were shown, so three sets of hole cards are visible above.',
];

export const COMPLETED_HAND_HIGHLIGHT: readonly number[] = HERO_BEST_FIVE;

/** Announced politely by the table's one live region when the completed view arrives. */
export const COMPLETED_HAND_ANNOUNCEMENT =
  'Hand complete. Main pot 905 units to you with an ace-high flush, side pot 600 units to the balanced bot with three queens.';

export const FLOP_DECISION_ANNOUNCEMENT = 'The balanced bot bet 35 units on the flop. It is your decision.';

/** What the error state says when the table cannot be reached. */
export const TABLE_ERROR_MESSAGE =
  'The table could not be reached. Nothing was staked and no decision was sent — the server is the only authority on a hand, so a lost connection cannot cost you anything.';

/**
 * Fixture: the Scenario Lab's six scenarios and the analysis for each.
 *
 * ## Why the screens are built on a fixture
 *
 * `GET /api/scenarios` and `POST /api/scenarios/:id/attempt` are another team's work and do not
 * exist yet. Rather than block, both Lab screens render from this module whenever the API is
 * unavailable (see `isApiUnavailable` in `src/lib/api.ts`). That is how the screens get designed
 * and reviewed in parallel with the endpoints, and how a render check runs in CI with no database.
 *
 * ## Every number here was COMPUTED, not written
 *
 * This is the part that matters, and it is the reason this file exists as generated data rather
 * than as hand-authored prose with figures in it.
 *
 * The `Scenario` objects below are authored content: a situation, a question, the stated
 * assumptions, the reasoning, the named mistakes. They contain no computed figure at all, which is
 * the rule `packages/contracts/src/content-types.ts` opens with — content stores situations, never
 * results, so a scenario and the maths cannot drift apart.
 *
 * Every `CoachReport` in `LAB_SCENARIO_ANALYSIS` was then produced by running the real analysis
 * over the real situation: `readSituation` from `@prl/content` followed by `buildCoachReport`
 * from `@prl/poker-math`, at 40,000 samples and seed 20260817 — the same two calls the API route
 * will make. So the equities, the pot odds, the outs breakdowns, the candidate EVs and the
 * confidence intervals are the engine's own output. Nothing in this file is an estimate of what
 * the engine would say.
 *
 * Two consequences worth knowing:
 *
 *  - The reasoning prose deliberately does NOT restate the computed figures. It names the things
 *    that are fixed by the situation (a price of 3 to 1, nine hearts, an SPR under 2) and leaves
 *    every derived number to the panel, so the prose cannot go stale when the maths improves.
 *  - `equity.ruleOfThumb.estimate` is divided by 100 on the way in. `@prl/poker-math` sets it
 *    from `ruleOf24().estimatePercent` — a percentage — while `@prl/ui`'s CoachPanel renders it
 *    with `formatPercent`, which multiplies a fraction by 100, so the untouched value prints as
 *    "3600.0%". Every other probability crossing this contract is a fraction, so the fraction is
 *    the contract. The producer is the side that is wrong and the defect is reported upstream; the
 *    fixture normalises it so these screens can be reviewed against a number a reader recognises.
 *
 * ## The attempt response is computed here too
 *
 * `scenarioAttemptFixture` carries no stored verdict. It calls `judgeConsistency` from
 * `src/lib/consistency.ts` — a shape over the one rule in `@prl/poker-math` that the API grades with
 * — so a fixture-backed reveal, an API-backed one and the stored row cannot disagree about what
 * "consistent" means, and the fixture can answer an action nobody wrote a response for.
 */

import type {
  CoachReport,
  ContentId,
  GlossaryEntry,
  Scenario,
  ScenarioAttemptResponse,
  ScenarioListResponse,
  ScenarioResponse,
  ScenarioSummary,
} from '@prl/contracts';
import { judgeConsistency, type ScenarioAction } from '../lib/consistency.ts';
import { LEARN_GLOSSARY } from './learn-glossary.ts';

/**
 * The six scenarios, as authored content.
 *
 * Ordered so the first two are the same price with different hands — that pairing is the teaching
 * device, and the Lab index preserves it as `01` and `02`.
 */
export const LAB_SCENARIOS: readonly Scenario[] = [
  {
    id: 'flop-flush-draw-price',
    title: 'Priced in with a flush draw',
    topic: 'pot-odds-and-ev',
    difficulty: 'core',
    question:
      'You hold the nut flush draw and the pot is laying you 3 to 1. What equity does that price demand, and do you have it?',
    smallBlind: 10,
    bigBlind: 20,
    buttonSeat: 1,
    seats: [
      {
        seat: 0,
        label: 'You',
        stack: 935,
        isHero: true,
        holeCards: '9h 8h',
      },
      {
        seat: 1,
        label: 'Ledger',
        stack: 870,
        profile: 'tight-aggressive',
      },
    ],
    board: 'Ah 5h 2c',
    potBeforeStreet: 130,
    committedThisStreet: {
      '1': 65,
    },
    street: 'flop',
    facingAction: 'Ledger bets 65 into a pot of 130.',
    toCall: 65,
    opponentRange: {
      kind: 'exact',
      cards: 'As Kd',
    },
    assumptions: [
      'Ledger holds exactly the ace of spades and the king of diamonds. The hand is set up this way so the equity below is an exact enumeration rather than an estimate — a real opponent has a range, and the last scenario in this list works one.',
      'Both remaining cards are dealt with no further betting. That is what makes a single break-even number meaningful; in a real hand Ledger bets again on the turn and you rarely see the river for free.',
      'Nobody is all in, so no side pots and no dead money.',
      'Every bet and raise below is priced against an assumed 35% chance that the remaining opponents fold to it. That figure is an input chosen from the stated opponent profile, not a measurement of anybody: move it and the aggressive rows move with it, while the fold and call rows do not move at all.',
    ],
    reasoning:
      'The price is the first thing to fix, because it does not depend on your cards at all. Calling 65 into a pot of 195 means risking 65 to win 260, so the call breaks even at 65 / 260 — a quarter of the time. That is the number the pot is quoting you, and it is the same number whether you hold the nut flush draw or nothing.\n\nOnly then is it worth counting outs. Nine hearts are still out there and every one of them wins the hand on its own, which is why the breakdown below reports them all as clean. Three non-heart sixes make a straight as well, and they are not outs by the usual definition — which is part of why the enumerated equity comes out a little above four times the out count.\n\nThe count is still not the whole hand. The two of hearts gives you the flush and pairs the board at the same time, so an ace after it fills Ledger up; the same is true of the king of hearts. Those runouts are inside the enumeration and outside the outs count, and that gap is exactly what a bare out count hides.',
    expectedInsight: [
      {
        kind: 'breakEvenEquityBetween',
        min: 0.24,
        max: 0.26,
      },
      {
        kind: 'equityExceedsBreakEven',
      },
      {
        kind: 'callEvSign',
        expect: 'positive',
      },
    ],
    commonMistakes: [
      'Counting nine outs and stopping. Nine cards make the flush; one of them can still lose, and the split is the difference between an estimate and an argument.',
      'Multiplying nine outs by four and calling that the answer. The rule of 2 and 4 assumes both cards arrive for free, which is exactly what a turn bet takes away.',
      'Reading "3 to 1" as "win one in three". The ratio counts the chips, not the outcomes: 3 to 1 needs a quarter, not a third.',
      'Deciding the call is right because the draw is to the nut flush. The nut flush changes what happens when you hit; it does not change the price.',
    ],
    glossaryTerms: ['pot-odds', 'outs', 'equity', 'break-even-equity'],
  },
  {
    id: 'turn-gutshot-price',
    title: 'A gutshot at the wrong price',
    topic: 'pot-odds-and-ev',
    difficulty: 'intro',
    question:
      'One card to come, four outs, and the same 3-to-1 price as a flush draw would get. Does the price change with the draw?',
    smallBlind: 10,
    bigBlind: 20,
    buttonSeat: 0,
    seats: [
      {
        seat: 0,
        label: 'You',
        stack: 800,
        isHero: true,
        holeCards: '8h 7h',
      },
      {
        seat: 1,
        label: 'Quartile',
        stack: 700,
        profile: 'nit',
      },
    ],
    board: 'Jc Ts 3d 2c',
    potBeforeStreet: 200,
    committedThisStreet: {
      '1': 100,
    },
    street: 'turn',
    facingAction: 'Quartile bets 100 into a pot of 200 on the turn.',
    toCall: 100,
    opponentRange: {
      kind: 'exact',
      cards: 'Ac Jd',
    },
    assumptions: [
      'Quartile holds exactly the ace of clubs and the jack of diamonds — top pair, top kicker.',
      'One card is still to come and there is no further betting after it, so the river is the whole of the remaining hand.',
      'A nine is worth the pot to you. It is not worth extra: this scenario gives you nothing for implied odds, because Quartile is a nit and a nit does not pay off the obvious straight.',
      'Every bet and raise below is priced against an assumed 20% chance that the remaining opponents fold to it. That figure is an input chosen from the stated opponent profile, not a measurement of anybody: move it and the aggressive rows move with it, while the fold and call rows do not move at all.',
    ],
    reasoning:
      'The price here is identical to the previous scenario — 100 into 200 is 3 to 1, break-even at a quarter — and that is the whole point of putting them next to each other. What changed is the hand, not the price.\n\nFour nines make your straight and nothing else in the deck helps, so with one card to come you get there 4 times in 44. That is a shade over nine per cent against a demand of twenty-five. The gap is not close and no read on Quartile closes it.\n\nThe useful habit is the order of operations. Price first, because it is arithmetic on numbers already visible. Outs second. If the outs cannot reach the price, nothing else in the hand needs thinking about.',
    expectedInsight: [
      {
        kind: 'breakEvenEquityBetween',
        min: 0.24,
        max: 0.26,
      },
      {
        kind: 'breakEvenExceedsEquity',
      },
      {
        kind: 'callEvSign',
        expect: 'negative',
      },
    ],
    commonMistakes: [
      'Calling because the draw is "only 100 into a big pot". The pot being big is why the bet is big; the ratio is what matters and the ratio has not moved.',
      'Applying the rule of 4 on the turn. There is one card to come, so the multiplier is 2 — the rule of 4 would double your equity and turn a fold into a call.',
      'Adding implied odds that the opponent will not pay. Implied odds are chips you expect to win LATER, and they have to come from a specific opponent making a specific mistake.',
    ],
    glossaryTerms: ['pot-odds', 'outs', 'implied-odds', 'rule-of-2-and-4'],
  },
  {
    id: 'preflop-set-mining-odds',
    title: 'Is a small pair worth a call?',
    topic: 'probability-and-equity',
    difficulty: 'intro',
    question:
      'A small pair flops a set about one time in eight. You are being asked for 60 to see it. What has to be true for that to be worth doing?',
    smallBlind: 10,
    bigBlind: 20,
    buttonSeat: 2,
    seats: [
      {
        seat: 0,
        label: 'You',
        stack: 1000,
        isHero: true,
        holeCards: '5c 5d',
      },
      {
        seat: 1,
        label: 'Ledger',
        stack: 1000,
        profile: 'tight-aggressive',
      },
      {
        seat: 2,
        label: 'Quartile',
        stack: 1000,
        profile: 'nit',
      },
    ],
    board: '',
    potBeforeStreet: 30,
    committedThisStreet: {
      '1': 60,
    },
    street: 'preflop',
    facingAction: 'Ledger raises to 60 from early position. You are next to act with fives.',
    toCall: 60,
    opponentRange: {
      kind: 'notation',
      notation: 'TT+, AJs+, KQs, AQo+',
      label: 'a tight early-position opening range',
    },
    assumptions: [
      'Ledger opens the stated range and nothing else. Tighten or widen it and every figure below moves.',
      'Quartile behind you is treated as folding. A third player who calls changes the price you are getting and the value of hitting.',
      'The equity figure is your share if the hand simply ran out from here with no more betting. It is NOT the value of set-mining, which depends on chips you win after you hit.',
      'Every bet and raise below is priced against an assumed 30% chance that the remaining opponents fold to it. That figure is an input chosen from the stated opponent profile, not a measurement of anybody: move it and the aggressive rows move with it, while the fold and call rows do not move at all.',
    ],
    reasoning:
      'Raw equity is the wrong tool for this decision, and seeing why is the lesson. A pair of fives against a strong range has real equity — the number below is not small — but almost all of it is "I stay ahead of two overcards that miss", and you will not get to realise that: you are calling out of position and you will fold the flop most of the time.\n\nThe honest question is whether the times you flop a set pay for all the times you do not. You flop a set roughly 11.8% of the time, so about one call in eight. The 60 you put in buys a lottery ticket, and the ticket has to pay about eight times its price plus something for the hands where you flop a set and still lose.\n\nThat is what makes this a stack-depth question rather than a pot-odds question. With 1,000 behind and a 60 call the implied price is plausible. At 300 behind it is not, and the same cards become a fold with nothing about the cards having changed.',
    expectedInsight: [
      {
        kind: 'breakEvenEquityBetween',
        min: 0.3,
        max: 0.42,
      },
    ],
    commonMistakes: [
      'Reading the raw equity figure as the reason to call. Most of that equity is unrealisable from out of position with a hand that folds to the first bet.',
      'Set-mining with a short stack. The maths needs a stack deep enough to win eight times the call when you hit; the shorter the stack, the worse the ticket.',
      'Forgetting that flopping a set is not the same as winning. Sets lose to flushes, straights and better sets often enough to matter to the price.',
    ],
    glossaryTerms: ['implied-odds', 'equity', 'range', 'effective-stack'],
  },
  {
    id: 'flop-spr-commitment',
    title: 'An overpair at low SPR',
    topic: 'bet-sizing-and-spr',
    difficulty: 'core',
    question:
      'The stack-to-pot ratio is under 2 and you hold an overpair. What does that ratio decide for you before you have thought about the opponent at all?',
    smallBlind: 10,
    bigBlind: 20,
    buttonSeat: 1,
    seats: [
      {
        seat: 0,
        label: 'You',
        stack: 520,
        isHero: true,
        holeCards: 'Qs Qd',
      },
      {
        seat: 1,
        label: 'Maniac',
        stack: 520,
        profile: 'maniac',
      },
    ],
    board: 'Jh 7c 4d',
    potBeforeStreet: 280,
    committedThisStreet: {},
    street: 'flop',
    facingAction: 'Maniac checks. The pot is 280 and you both have 520 behind.',
    toCall: 0,
    opponentRange: {
      kind: 'notation',
      notation: 'JJ, 77, 44, AJ, KJs, QJs, JTs, 98s, 65s, A5s, KQo',
      label: 'a loose continuing range on this board',
    },
    assumptions: [
      'Maniac continues with the stated range and folds everything else. A maniac will in practice do things no range describes, which is exactly why the range is written down rather than assumed.',
      'The stack-to-pot ratio is computed from the smaller of the two stacks, which is what "effective" means.',
      'There is nothing to call, so no pot-odds figure applies to you yet. The break-even number below is what a pot-sized bet would demand of a caller.',
      'Every bet and raise below is priced against an assumed 15% chance that the remaining opponents fold to it. That figure is an input chosen from the stated opponent profile, not a measurement of anybody: move it and the aggressive rows move with it, while the fold and call rows do not move at all.',
    ],
    reasoning:
      'With 520 behind and 280 in the middle the stack-to-pot ratio is 1.9. That single number decides the shape of the hand before the cards get a say: one bet and one raise puts the stacks in, so there is no such thing as a small mistake left in this pot.\n\nAn overpair at this depth is a hand that wants the stacks in. Not because it is unbeatable — the board has a jack on it and the range below contains sets — but because at SPR under 2 there is no line that gets to the river cheaply. Checking does not save chips, it just moves the same all-in decision to a street where you know less.\n\nThe general rule worth taking away is that SPR is a property of the pot, not of your hand, and it is fixed before the flop by how much went in preflop. If you want a low-SPR hand, you build it preflop.',
    expectedInsight: [
      {
        kind: 'sprBetween',
        min: 1.5,
        max: 2.2,
      },
    ],
    commonMistakes: [
      'Treating an overpair as a hand that needs protecting with a small bet. At SPR under 2 a small bet does not protect anything; it just prices in the draws it was meant to fold out.',
      'Computing SPR from your own stack rather than the effective one. The number you can actually lose is the smaller stack.',
      'Deciding SPR on the flop. It was decided preflop, by the size of the raise and the number of callers.',
    ],
    glossaryTerms: ['spr', 'effective-stack', 'board-texture', 'value-bet'],
  },
  {
    id: 'river-bluff-catch-range',
    title: 'Bluff-catching on a blank river',
    topic: 'ranges',
    difficulty: 'advanced',
    question:
      'The river is a blank, you hold second pair, and the bet is bigger than the pot. How often does that bet have to be a bluff before calling is worth it?',
    smallBlind: 10,
    bigBlind: 20,
    buttonSeat: 0,
    seats: [
      {
        seat: 0,
        label: 'You',
        stack: 900,
        isHero: true,
        holeCards: '9h 9c',
      },
      {
        seat: 1,
        label: 'Ledger',
        stack: 540,
        profile: 'tight-aggressive',
      },
    ],
    board: 'Js 8d 3c 6h 2s',
    potBeforeStreet: 360,
    committedThisStreet: {
      '1': 540,
    },
    street: 'river',
    facingAction: 'Ledger overbets 540 into 360 on a river that changed nothing.',
    toCall: 540,
    opponentRange: {
      kind: 'notation',
      notation: 'JJ, 66, 33, AJs, KJs, QJs, JTs, T9s, 88, 76s, 54s, A5s',
      label: 'the value hands and missed draws that get here betting',
    },
    assumptions: [
      'Ledger arrives at the river with the stated range and bets all of it. That is the strong assumption in this spot and it is doing most of the work: shift the proportion of missed draws in it and the answer flips.',
      'There are no cards to come, so there is no draw and no equity to improve. Your hand either beats what they hold or it does not.',
      'The overbet is 1.5 times the pot, which is a deliberately awkward price — it is the size that makes the count below matter.',
      'Every bet and raise below is priced against an assumed 25% chance that the remaining opponents fold to it. That figure is an input chosen from the stated opponent profile, not a measurement of anybody: move it and the aggressive rows move with it, while the fold and call rows do not move at all.',
    ],
    reasoning:
      'On the river the arithmetic gets simpler and the reading gets harder. Calling 540 into a pot that already holds 900 risks 540 to win 1,440, so the call breaks even at 540 / 1,440 — three times in eight, a shade under 38%. There is no draw, no implied odds and nothing to come; the only question is how much of that range you beat.\n\nA pair of nines is under the jack on the board, so it beats the missed draws and the smaller pairs and loses to every jack, to trip sixes and to the one straight. The count is mechanical once the range is written down: add up the combinations you beat, divide by the total, and compare with the break-even figure. That is exactly what the equity number below is, which is why the method reads exact enumeration rather than sampling — on a complete board there is nothing left to sample.\n\nWhat makes this advanced is not the maths. It is that the answer is a property of the range you assigned, and you assigned it. Read the two numbers together: you beat about a quarter of the range and the price is asking for three eighths, so this is a fold by a clear thirteen points. Closing that gap would take a materially looser bettor — several more combinations of missed draw in the range, not one. Writing the assumption down is what lets you argue with it.',
    expectedInsight: [
      {
        kind: 'breakEvenEquityBetween',
        min: 0.37,
        max: 0.38,
      },
    ],
    commonMistakes: [
      'Calling because "he could be bluffing". Could is not a frequency, and the price is asking for a frequency.',
      'Counting hands instead of combinations. There are six ways to hold a pair and four ways to hold a specific suited hand; treating them as equal weights the range wrong.',
      'Forgetting that the board and your own cards block part of the range. The jack of spades on the board removes the ace-jack of spades from it, and your two nines remove two of the ten-nine combinations.',
      'Reading an overbet as a bigger bluff. A bet larger than the pot demands MORE from your hand, not less: the price moved against you at the same time as the story got louder.',
    ],
    glossaryTerms: ['range', 'combos', 'blocker', 'break-even-equity'],
  },
  {
    id: 'preflop-squeeze-fold-equity',
    title: 'Squeezing with a suited ace',
    topic: 'fold-equity-and-bluffing',
    difficulty: 'advanced',
    question:
      'An open and a call in front of you. How much of a squeeze is paid for by the folds, and how much by the hand?',
    smallBlind: 10,
    bigBlind: 20,
    buttonSeat: 3,
    seats: [
      {
        seat: 0,
        label: 'You',
        stack: 1000,
        isHero: true,
        holeCards: 'As 5s',
      },
      {
        seat: 1,
        label: 'Ledger',
        stack: 1000,
        profile: 'tight-aggressive',
      },
      {
        seat: 2,
        label: 'Station',
        stack: 1000,
        profile: 'calling-station',
      },
      {
        seat: 3,
        label: 'Quartile',
        stack: 1000,
        profile: 'nit',
      },
    ],
    board: '',
    potBeforeStreet: 30,
    committedThisStreet: {
      '1': 60,
      '2': 60,
    },
    street: 'preflop',
    facingAction:
      'Ledger opens to 60, Station calls. You are in the big blind with the ace of spades and the five of spades.',
    toCall: 40,
    opponentRange: {
      kind: 'topPercent',
      percent: 22,
      label: 'the top 22% of hands',
    },
    assumptions: [
      'Both opponents are modelled with the same top-22% range. They are not the same player and would not have the same range in practice; one range for both is a simplification, and it is the one most likely to be wrong here.',
      'The fold equity used in the raise candidates is an ASSUMPTION, not a measurement. Nothing in this app can know how often a particular opponent folds.',
      'The equity figure is a three-way pot. Three-way equity is not two-way equity: the same hand is worth less when there are two hands to beat instead of one.',
      'Every bet and raise below is priced against an assumed 40% chance that the remaining opponents fold to it. That figure is an input chosen from the stated opponent profile, not a measurement of anybody: move it and the aggressive rows move with it, while the fold and call rows do not move at all.',
    ],
    reasoning:
      'A squeeze earns its money in two separate ways and it is worth keeping them apart. The first is the pot on the table right now — 150, with 40 more owed by you — which you collect whenever both opponents fold. The second is the equity your hand has when somebody does not fold. The first is fold equity and it is an assumption; the second is a computed number and it is below.\n\nThe suited ace is chosen deliberately. Its raw three-way equity is unremarkable, but it holds the ace of the suit, so when it does continue it is rarely dominated in the way a suited king would be, and it makes the nut flush rather than the second-nut one. That is a property that only pays off in the hands that go on, which is the half of the argument fold equity does not cover.\n\nSo read the two candidate rows below as two different bets. The raise row assumes a fold frequency; the call row does not. If you disagree with the assumed frequency — and you should have an opinion — the raise row moves and the call row stays where it is.',
    expectedInsight: [
      {
        kind: 'breakEvenEquityBetween',
        min: 0.2,
        max: 0.22,
      },
    ],
    commonMistakes: [
      'Squeezing because the hand is "good enough to play". A squeeze is a bet on folds; the hand is what happens when the bet loses.',
      'Assuming a fold frequency and then forgetting it was assumed. Every raise EV in this app names the frequency it used for exactly this reason.',
      'Using two-way equity in a three-way pot. Against two ranges the same hand needs a different number to be worth the same call.',
    ],
    glossaryTerms: ['fold-equity', 'three-bet', 'range', 'expected-value'],
  },
];

/**
 * Which scenarios this fixture presents as already attempted.
 *
 * `attempted` is a fact about the reader, not about the scenario, so in production it comes from
 * `prl.scenario_attempts`. Two of the six are marked here purely so the index has both states to
 * render. It is NOT progress: there is no count, no percentage and no streak anywhere in the Lab,
 * and `ScenarioSummary` deliberately carries a boolean rather than a score.
 */
const ATTEMPTED: readonly ContentId[] = ['flop-flush-draw-price', 'flop-spr-commitment'];

/**
 * The analysis for each scenario, keyed by id.
 *
 * Generated — see the header. A figure edited by hand in here is a figure that disagrees with the
 * engine, which is the one failure mode this whole arrangement exists to prevent.
 */
export const LAB_SCENARIO_ANALYSIS: Readonly<Record<ContentId, CoachReport>> = {
  'flop-flush-draw-price': {
    street: 'flop',
    potTotal: 195,
    toCall: 65,
    outs: {
      clean: 9,
      dirty: 0,
      total: 9,
      cleanCards: ['3h', '4h', '6h', '7h', 'Th', 'Jh', 'Qh', '2h', 'Kh'],
      dirtyCards: [],
      explanation:
        "On Ah 5h 2c hero holds 9h 8h — high card ace, nine eight kickers — for 38% equity against exactly AsKd. Of the 45 cards that can come next, 9 are clean and 0 are dirty, which is 9 outs in total. Clean means hero's equity after that card is at least 90%; dirty means at least 50% but below 90%.",
    },
    equity: {
      heroEquity: 0.3843434343434343,
      method: 'exact-enumeration',
      trials: 990,
      confidenceHalfWidthPoints: null,
      ruleOfThumb: {
        estimate: 0.36,
        errorPoints: 1.0323774283071216,
        note: "9 outs with two cards to come, times 4, is roughly 36% — the rule of 2 and 4. It works because one card off a stub of about 46 cards is worth a little over 2%, so 2% per out per card is close enough to do in your head. Count clean outs only: a card that improves hero but hands an opponent a better hand at the same time is not an out, and counting it is a bigger error than anything the shortcut itself does. The shortcut overstates by 1.0 points here — 36% against an exact 35.0%. Fine as a rough read, but do not hang a marginal call on it. The comparison is against the exact chance of one of those 9 clean cards arriving (Two cards to come, 9 outs, 47 cards unseen. Count the misses instead of the hits: 38 cards do not help. The turn misses 38/47 of the time, and with one miss now gone the river misses 37/46 of the time, so both cards miss (38/47) x (37/46) = 65.0% of the time. Hitting at least one is whatever is left: 1 - 65.0% = 35.0%. Adding 9/47 + 9/46 instead would count every run-out that hits twice twice over, and overstate the chance.), not against hero's equity: hitting and winning are different questions, and the dirty-out count is zero here only because every out is clean. The shortcut is an approximation and this is its error, stated rather than hidden.",
      },
      perPlayer: [
        {
          label: 'you',
          equity: 0.3843434343434343,
          win: 0.3797979797979798,
          tie: 0.00909090909090909,
        },
        {
          label: 'the opponent',
          equity: 0.6156565656565657,
          win: 0.6111111111111112,
          tie: 0.00909090909090909,
        },
      ],
    },
    potOdds: {
      pot: 195,
      toCall: 65,
      breakEvenEquity: 0.25,
      oddsRatio: 3,
      equitySurplus: 0.13434343434343432,
      explanation:
        "Hero risks 65 to win the 195 already in the middle, a price of 3 to 1. Calling breaks even at 65 / (195 + 65) = 25.0% equity: with less than that, calling loses units over many repetitions of this spot; with more, it gains them. The 195 is what is in the middle before hero's own 65 goes in — counting the call inside the pot understates the equity a call needs. You clear that with 38.4% equity, a 13.4 point surplus.",
    },
    candidates: [
      {
        action: 'fold',
        cost: 0,
        ev: 0,
        derivation:
          'EV(fold) = 0 chips. Folding is the baseline every other action is measured against: it costs nothing further and risks nothing further. Everything already in the pot is spent either way, so folding is the zero point every other action is measured against.',
      },
      {
        action: 'call',
        to: 65,
        cost: 65,
        ev: 34.92929292929293,
        derivation: 'EV(call) = equity x (pot + toCall) - toCall = 0.3843 x (195 + 65) - 65 = 34.93 chips.',
        potShareIfCalled: 0.3843434343434343,
      },
      {
        action: 'raise',
        to: 130,
        cost: 130,
        ev: 81.1810606060606,
        derivation:
          'EV(raise) = f x pot + (1 - f) x [ e x (pot + c + 2r) - (c + r) ] = 0.35 x 195 + 0.65 x [ 0.3843 x (195 + 65 + 2 x 65) - 130 ] = 68.25 + 12.93 = 81.18 chips. Risks 130 to win 195. Raising by 65 is one quarter pot of the 260 that would be in the middle once you call. A caller needs 16.7% equity to break even on the extra 65, and has to continue with 80% of their range for a raise of this size not to print automatically.',
        foldEquityAssumed: 0.35,
        potShareIfCalled: 0.3843434343434343,
      },
      {
        action: 'raise',
        to: 238,
        cost: 238,
        ev: 64.94287878787878,
        derivation:
          'EV(raise) = f x pot + (1 - f) x [ e x (pot + c + 2r) - (c + r) ] = 0.35 x 195 + 0.65 x [ 0.3843 x (195 + 65 + 2 x 173) - 238 ] = 68.25 + (-3.31) = 64.94 chips. Risks 238 to win 195. Raising by 173 is two thirds pot of the 260 that would be in the middle once you call. A caller needs 28.5% equity to break even on the extra 173, and has to continue with 60% of their range for a raise of this size not to print automatically.',
        foldEquityAssumed: 0.35,
        potShareIfCalled: 0.3843434343434343,
      },
      {
        action: 'raise',
        to: 935,
        cost: 935,
        ev: -39.85353535353542,
        derivation:
          'EV(raise) = f x pot + (1 - f) x [ e x (pot + c + 2r) - (c + r) ] = 0.35 x 195 + 0.65 x [ 0.3843 x (195 + 65 + 2 x 870) - 935 ] = 68.25 + (-108.1) = -39.85 chips. Risks 935 to win 195. Raising by 870 puts your whole remaining stack in. A caller needs 43.5% equity to break even on the extra 870, and has to continue with 23% of their range for a raise of this size not to print automatically.',
        foldEquityAssumed: 0.35,
        potShareIfCalled: 0.3843434343434343,
      },
    ],
    suggestion: {
      action: 'raise',
      sizeRange: {
        min: 130,
        max: 238,
      },
      confidence: 'moderate',
      reason:
        'raise has the highest expected value against the stated range, by 16.2 chips over the next-best action.',
      whatWouldChangeIt: [
        'This assumes the line wins uncontested 35% of the time. An opponent who folds less often makes it worse.',
        'Being raised is not modelled here, so treat the figure as optimistic.',
        'The gap to the next-best action is only 16.2 chips, well under a big blind — this is close to indifferent.',
      ],
    },
    stackContext: {
      effectiveStack: 870,
      spr: 4.461538461538462,
      potOddsOfferedByPotSizedBet: 0.3333333333333333,
      explanation:
        'The deepest opponent has only 870, so at most 870 can change hands even though you have 935. The 65 above that is not in play this hand — nobody can pay you for it and nobody can take it. SPR = effective stack / pot = 870 / 195 = 4.46. There are 4.46 pots behind, which is the "medium" band. A bet and a raise, or two streets of betting, gets the stacks in. There is room for about one more decision after this one and not much more. SPR describes the shape of the decision, not the answer to it: your hand, their range and position all still apply.',
    },
    assumptions: [
      'The hand is played to the river with no further betting — this is raw equity, not the value of the spot.',
      'you holds exactly 9h8h.',
      'the opponent holds exactly AsKd.',
      'Computed by enumerating every remaining board — there is no sampling error.',
      'Bet and raise figures assume the line wins uncontested 35% of the time. That is an input you can change, not something measured.',
      'A half-pot bet of 98 is already break-even or better here purely on the equity you have when called — it does not need to win uncontested at all.',
      'Expected values are measured against folding, which is treated as zero. Chips already in the pot are spent either way.',
    ],
    uncertainty: {
      method: 'exact-enumeration',
      summary:
        'Computed exactly by enumerating every remaining board (990 run-outs). There is no sampling error.',
      confidenceInterval: null,
      limitations: [
        'This is raw equity: the hand is treated as running to the river with no further betting. Real hands have more streets and more decisions.',
        'Every hand in the opponent range is weighted equally. Real opponents do not play every hand in a range the same way.',
        'The clean/dirty split for outs uses documented equity thresholds. They are a modelling choice, not a law of the game.',
        'No implied odds, reverse implied odds or future-street play are modelled.',
      ],
    },
    teachingNotes: [
      'The pot is laying you 3.0 to 1, so you need 25.0% to break even on a call. That number depends only on the price — not on your cards.',
      'The rule of 2 and 4 gives 36% on your 9 cards of clean outs, overstating the exact chance of hitting one of them by 1.0 points. Your equity here is 38.4%, which is a different question again: hitting is not the same as winning.',
      'A profitable call still loses more often than it wins whenever the break-even point is under 50%. Losing this hand would not make the call wrong.',
    ],
  },
  'turn-gutshot-price': {
    street: 'turn',
    potTotal: 300,
    toCall: 100,
    outs: {
      clean: 4,
      dirty: 0,
      total: 4,
      cleanCards: ['9c', '9d', '9h', '9s'],
      dirtyCards: [],
      explanation:
        "On Jc Ts 3d 2c hero holds 8h 7h — high card jack, ten eight kickers — for 9.1% equity against exactly AcJd. Of the 44 cards that can come next, 4 are clean and 0 are dirty, which is 4 outs in total. Clean means hero's equity after that card is at least 90%; dirty means at least 50% but below 90%.",
    },
    equity: {
      heroEquity: 0.09090909090909091,
      method: 'exact-enumeration',
      trials: 44,
      confidenceHalfWidthPoints: null,
      ruleOfThumb: {
        estimate: 0.08,
        errorPoints: -0.695652173913043,
        note: "4 outs with one card to come, times 2, is roughly 8% — the rule of 2 and 4. It works because one card off a stub of about 46 cards is worth a little over 2%, so 2% per out per card is close enough to do in your head. Count clean outs only: a card that improves hero but hands an opponent a better hand at the same time is not an out, and counting it is a bigger error than anything the shortcut itself does. The shortcut understates by 0.7 points here — 8% against an exact 8.7%. Fine as a rough read, but do not hang a marginal call on it. The comparison is against the exact chance of one of those 4 clean cards arriving (One card to come. 4 of the 46 unseen cards win the hand, so the chance is 4/46 = 8.7%. With a single card there is nothing to correct for: the count of outs over the count of unseen cards is the probability.), not against hero's equity: hitting and winning are different questions, and the dirty-out count is zero here only because every out is clean. The shortcut is an approximation and this is its error, stated rather than hidden.",
      },
      perPlayer: [
        {
          label: 'you',
          equity: 0.09090909090909091,
          win: 0.09090909090909091,
          tie: 0,
        },
        {
          label: 'the opponent',
          equity: 0.9090909090909091,
          win: 0.9090909090909091,
          tie: 0,
        },
      ],
    },
    potOdds: {
      pot: 300,
      toCall: 100,
      breakEvenEquity: 0.25,
      oddsRatio: 3,
      equitySurplus: -0.1590909090909091,
      explanation:
        "Hero risks 100 to win the 300 already in the middle, a price of 3 to 1. Calling breaks even at 100 / (300 + 100) = 25.0% equity: with less than that, calling loses units over many repetitions of this spot; with more, it gains them. The 300 is what is in the middle before hero's own 100 goes in — counting the call inside the pot understates the equity a call needs. You clear that with 9.1% equity, a -15.9 point shortfall.",
    },
    candidates: [
      {
        action: 'fold',
        cost: 0,
        ev: 0,
        derivation:
          'EV(fold) = 0 chips. Folding is the baseline every other action is measured against: it costs nothing further and risks nothing further. Everything already in the pot is spent either way, so folding is the zero point every other action is measured against.',
      },
      {
        action: 'call',
        to: 100,
        cost: 100,
        ev: -63.63636363636363,
        derivation:
          'EV(call) = equity x (pot + toCall) - toCall = 0.0909 x (300 + 100) - 100 = -63.64 chips.',
        potShareIfCalled: 0.09090909090909091,
      },
      {
        action: 'raise',
        to: 200,
        cost: 200,
        ev: 10.454545454545467,
        derivation:
          'EV(raise) = f x pot + (1 - f) x [ e x (pot + c + 2r) - (c + r) ] = 0.35 x 300 + 0.65 x [ 0.0909 x (300 + 100 + 2 x 100) - 200 ] = 105 + (-94.55) = 10.45 chips. Risks 200 to win 300. Raising by 100 is one quarter pot of the 400 that would be in the middle once you call. A caller needs 16.7% equity to break even on the extra 100, and has to continue with 80% of their range for a raise of this size not to print automatically.',
        foldEquityAssumed: 0.35,
        potShareIfCalled: 0.09090909090909091,
      },
      {
        action: 'raise',
        to: 366,
        cost: 366,
        ev: -77.82727272727271,
        derivation:
          'EV(raise) = f x pot + (1 - f) x [ e x (pot + c + 2r) - (c + r) ] = 0.35 x 300 + 0.65 x [ 0.0909 x (300 + 100 + 2 x 266) - 366 ] = 105 + (-182.83) = -77.83 chips. Risks 366 to win 300. Raising by 266 is two thirds pot of the 400 that would be in the middle once you call. A caller needs 28.5% equity to break even on the extra 266, and has to continue with 60.1% of their range for a raise of this size not to print automatically.',
        foldEquityAssumed: 0.35,
        potShareIfCalled: 0.09090909090909091,
      },
      {
        action: 'raise',
        to: 800,
        cost: 800,
        ev: -308.6363636363637,
        derivation:
          'EV(raise) = f x pot + (1 - f) x [ e x (pot + c + 2r) - (c + r) ] = 0.35 x 300 + 0.65 x [ 0.0909 x (300 + 100 + 2 x 700) - 800 ] = 105 + (-413.64) = -308.64 chips. Risks 800 to win 300. Raising by 700 puts your whole remaining stack in. A caller needs 38.9% equity to break even on the extra 700, and has to continue with 36.4% of their range for a raise of this size not to print automatically.',
        foldEquityAssumed: 0.35,
        potShareIfCalled: 0.09090909090909091,
      },
    ],
    suggestion: {
      action: 'raise',
      sizeRange: {
        min: 200,
        max: 200,
      },
      confidence: 'moderate',
      reason:
        'raise has the highest expected value against the stated range, by 10.5 chips over the next-best action.',
      whatWouldChangeIt: [
        'This assumes the line wins uncontested 35% of the time. An opponent who folds less often makes it worse.',
        'Being raised is not modelled here, so treat the figure as optimistic.',
        'The gap to the next-best action is only 10.5 chips, well under a big blind — this is close to indifferent.',
      ],
    },
    stackContext: {
      effectiveStack: 700,
      spr: 2.3333333333333335,
      potOddsOfferedByPotSizedBet: 0.3333333333333333,
      explanation:
        'The deepest opponent has only 700, so at most 700 can change hands even though you have 800. The 100 above that is not in play this hand — nobody can pay you for it and nobody can take it. SPR = effective stack / pot = 700 / 300 = 2.33. There are 2.33 pots behind, which is the "low" band. One pot-sized bet and a call puts the stacks in. The live question on this street is whether you are committing, not what happens on the next one. SPR describes the shape of the decision, not the answer to it: your hand, their range and position all still apply.',
    },
    assumptions: [
      'The hand is played to the river with no further betting — this is raw equity, not the value of the spot.',
      'you holds exactly 8h7h.',
      'the opponent holds exactly AcJd.',
      'Computed by enumerating every remaining board — there is no sampling error.',
      'Bet and raise figures assume the line wins uncontested 35% of the time. That is an input you can change, not something measured.',
      'For a half-pot bet of 150 to break even here it would need to win uncontested 24% of the time.',
      'Expected values are measured against folding, which is treated as zero. Chips already in the pot are spent either way.',
    ],
    uncertainty: {
      method: 'exact-enumeration',
      summary:
        'Computed exactly by enumerating every remaining board (44 run-outs). There is no sampling error.',
      confidenceInterval: null,
      limitations: [
        'This is raw equity: the hand is treated as running to the river with no further betting. Real hands have more streets and more decisions.',
        'Every hand in the opponent range is weighted equally. Real opponents do not play every hand in a range the same way.',
        'The clean/dirty split for outs uses documented equity thresholds. They are a modelling choice, not a law of the game.',
        'No implied odds, reverse implied odds or future-street play are modelled.',
      ],
    },
    teachingNotes: [
      'The pot is laying you 3.0 to 1, so you need 25.0% to break even on a call. That number depends only on the price — not on your cards.',
      'The rule of 2 and 4 gives 8% on your 4 cards of clean outs, understating the exact chance of hitting one of them by 0.7 points. Your equity here is 9.1%, which is a different question again: hitting is not the same as winning.',
      'At an SPR of 2.3 the stacks are shallow enough that one more bet commits them. Decisions like that are effectively made now rather than later.',
    ],
  },
  'preflop-set-mining-odds': {
    street: 'preflop',
    potTotal: 90,
    toCall: 60,
    outs: null,
    equity: {
      heroEquity: 0.3850875,
      method: 'monte-carlo',
      trials: 40000,
      confidenceHalfWidthPoints: 0.4757743658795817,
      ruleOfThumb: null,
      perPlayer: [
        {
          label: 'you',
          equity: 0.3850875,
          win: 0.382875,
          tie: 0.004425,
        },
        {
          label: 'a tight early-position opening range',
          equity: 0.6149125,
          win: 0.6127,
          tie: 0.004425,
        },
      ],
    },
    potOdds: {
      pot: 90,
      toCall: 60,
      breakEvenEquity: 0.4,
      oddsRatio: 1.5,
      equitySurplus: -0.014912499999999995,
      explanation:
        "Hero risks 60 to win the 90 already in the middle, a price of 1.50 to 1. Calling breaks even at 60 / (90 + 60) = 40.0% equity: with less than that, calling loses units over many repetitions of this spot; with more, it gains them. The 90 is what is in the middle before hero's own 60 goes in — counting the call inside the pot understates the equity a call needs. You clear that with 38.5% equity, a -1.5 point shortfall.",
    },
    candidates: [
      {
        action: 'fold',
        cost: 0,
        ev: 0,
        derivation:
          'EV(fold) = 0 chips. Folding is the baseline every other action is measured against: it costs nothing further and risks nothing further. Everything already in the pot is spent either way, so folding is the zero point every other action is measured against.',
      },
      {
        action: 'call',
        to: 60,
        cost: 60,
        ev: -2.2368749999999977,
        derivation: 'EV(call) = equity x (pot + toCall) - toCall = 0.3851 x (90 + 60) - 60 = -2.24 chips.',
        potShareIfCalled: 0.3850875,
      },
      {
        action: 'raise',
        to: 135,
        cost: 135,
        ev: 18.842062499999997,
        derivation:
          'EV(raise) = f x pot + (1 - f) x [ e x (pot + c + 2r) - (c + r) ] = 0.35 x 90 + 0.65 x [ 0.3851 x (90 + 60 + 2 x 75) - 135 ] = 31.5 + (-12.66) = 18.84 chips. Risks 135 to win 90. Raising by 75 is half pot of the 150 that would be in the middle once you call. A caller needs 25% equity to break even on the extra 75, and has to continue with 66.7% of their range for a raise of this size not to print automatically.',
        foldEquityAssumed: 0.35,
        potShareIfCalled: 0.3850875,
      },
      {
        action: 'raise',
        to: 172,
        cost: 172,
        ev: 13.31477125,
        derivation:
          'EV(raise) = f x pot + (1 - f) x [ e x (pot + c + 2r) - (c + r) ] = 0.35 x 90 + 0.65 x [ 0.3851 x (90 + 60 + 2 x 112) - 172 ] = 31.5 + (-18.19) = 13.31 chips. Risks 172 to win 90. Raising by 112 is three quarters pot of the 150 that would be in the middle once you call. A caller needs 29.9% equity to break even on the extra 112, and has to continue with 57.3% of their range for a raise of this size not to print automatically.',
        foldEquityAssumed: 0.35,
        potShareIfCalled: 0.3850875,
      },
      {
        action: 'raise',
        to: 1000,
        cost: 1000,
        ev: -110.37704374999993,
        derivation:
          'EV(raise) = f x pot + (1 - f) x [ e x (pot + c + 2r) - (c + r) ] = 0.35 x 90 + 0.65 x [ 0.3851 x (90 + 60 + 2 x 940) - 1000 ] = 31.5 + (-141.88) = -110.38 chips. Risks 1000 to win 90. Raising by 940 puts your whole remaining stack in. A caller needs 46.3% equity to break even on the extra 940, and has to continue with 13.8% of their range for a raise of this size not to print automatically.',
        foldEquityAssumed: 0.35,
        potShareIfCalled: 0.3850875,
      },
    ],
    suggestion: {
      action: 'raise',
      sizeRange: {
        min: 135,
        max: 172,
      },
      confidence: 'moderate',
      reason:
        'raise has the highest expected value against the stated range, by 5.5 chips over the next-best action.',
      whatWouldChangeIt: [
        'This assumes the line wins uncontested 35% of the time. An opponent who folds less often makes it worse.',
        'Being raised is not modelled here, so treat the figure as optimistic.',
        'The equity figure is sampled, ±0.48 points at 95% confidence. A close decision could sit either side of that.',
        'The gap to the next-best action is only 5.5 chips, well under a big blind — this is close to indifferent.',
      ],
    },
    stackContext: {
      effectiveStack: 1000,
      spr: 11.11111111111111,
      potOddsOfferedByPotSizedBet: 0.3333333333333333,
      explanation:
        'Yours is the shorter stack: you have 1000 and the deepest opponent has 1000, so at most 1000 can change hands. You can neither win nor lose more than you brought to the hand. With 2 opponents each one has its own effective stack, the smaller of yours and theirs. 1000 is the largest of them, so it is the most that can move against any single player and not the most you can lose across all of them. SPR = effective stack / pot = 1000 / 90 = 11.11. There are 11.11 pots behind, which is the "high" band. Several streets of betting fit before the stacks are in, so this decision mostly sets up the next one rather than settling the hand. SPR describes the shape of the decision, not the answer to it: your hand, their range and position all still apply.',
    },
    assumptions: [
      'The hand is played to the river with no further betting — this is raw equity, not the value of the spot.',
      'you holds exactly 5c5d.',
      'a tight early-position opening range holds any of 70 combinations from "TT+, AJs+, KQs, AQo+", each equally likely.',
      'Every hand in a range is weighted equally. Real opponents do not play every hand in a range the same way, so treat this as the range assumption, not a prediction.',
      'Estimated by sampling 40,000 random run-outs, not by exhaustive enumeration.',
      'No community cards are known yet, so five more cards are still to come.',
      'Bet and raise figures assume the line wins uncontested 35% of the time. That is an input you can change, not something measured.',
      'A half-pot bet of 45 is already break-even or better here purely on the equity you have when called — it does not need to win uncontested at all.',
      'Expected values are measured against folding, which is treated as zero. Chips already in the pot are spent either way.',
    ],
    uncertainty: {
      method: 'monte-carlo',
      summary:
        'Estimated by sampling 40,000 run-outs. The 95% confidence interval is ±0.48 percentage points.',
      confidenceInterval: {
        level: 0.95,
        halfWidthPoints: 0.4757743658795817,
      },
      limitations: [
        'This is raw equity: the hand is treated as running to the river with no further betting. Real hands have more streets and more decisions.',
        'Every hand in the opponent range is weighted equally. Real opponents do not play every hand in a range the same way.',
        'Equity was estimated from 40,000 sampled run-outs, not enumerated exhaustively.',
        'No implied odds, reverse implied odds or future-street play are modelled.',
      ],
    },
    teachingNotes: [
      'The pot is laying you 1.5 to 1, so you need 40.0% to break even on a call. That number depends only on the price — not on your cards.',
      'At an SPR of 11.1 there is a lot of money left behind, so hands that can keep improving are worth more than their current strength suggests.',
    ],
  },
  'flop-spr-commitment': {
    street: 'flop',
    potTotal: 280,
    toCall: 0,
    outs: {
      clean: 2,
      dirty: 38,
      total: 40,
      cleanCards: ['Qh', 'Qc'],
      dirtyCards: [
        '7s',
        '4s',
        '7h',
        '4h',
        '7d',
        '4c',
        '2s',
        '2h',
        '5s',
        '5h',
        '2d',
        '9s',
        '6s',
        '2c',
        '9h',
        '6h',
        '5d',
        '5c',
        '9d',
        '6d',
        '9c',
        '6c',
        '3s',
        '3h',
        '8s',
        '8h',
        '3d',
        '3c',
        '8d',
        '8c',
        'Ks',
        'Ts',
        'Td',
        'Kd',
        'Th',
        'Tc',
        'Kh',
        'Kc',
      ],
      explanation:
        'On Jh 7c 4d hero holds Qs Qd — a pair of queens, jack kicker — for 65% equity against "JJ, 77, 44, AJ, KJs, QJs, JTs, 98s, 65s, A5s, KQo" (46 combinations still possible). Of the 47 cards that can come next, 2 are clean and 38 are dirty, which is 40 outs in total. Clean means hero\'s equity after that card is at least 90%; dirty means at least 50% but below 90%. Hero is already in front before any card arrives — equity now is above the same threshold a card has to clear to count as an out — so read the counts as cards that keep hero ahead rather than as the size of a draw.',
    },
    equity: {
      heroEquity: 0.6450812472551603,
      method: 'exact-enumeration',
      trials: 45540,
      confidenceHalfWidthPoints: null,
      ruleOfThumb: null,
      perPlayer: [
        {
          label: 'you',
          equity: 0.6450812472551603,
          win: 0.6450812472551603,
          tie: 0,
        },
        {
          label: 'a loose continuing range on this board',
          equity: 0.3549187527448397,
          win: 0.3549187527448397,
          tie: 0,
        },
      ],
    },
    potOdds: {
      pot: 280,
      toCall: 0,
      breakEvenEquity: 0,
      oddsRatio: null,
      equitySurplus: 0.6450812472551603,
      explanation: 'Nothing to call, so there is no price to beat — checking keeps you in for free.',
    },
    candidates: [
      {
        action: 'check',
        cost: 0,
        ev: 180.62274923144486,
        derivation:
          'EV(check) = equity x pot = 0.6451 x 280 = 180.62 chips. Checking costs nothing and keeps the hand, so it is a call priced at zero: it risks nothing and still holds a share of what is already in the middle. That share is what folding gives up, which is why a free check is never worse than a fold.',
      },
      {
        action: 'fold',
        cost: 0,
        ev: 0,
        derivation:
          'EV(fold) = 0 chips. Folding is the baseline every other action is measured against: it costs nothing further and risks nothing further. Everything already in the pot is spent either way, so folding is the zero point every other action is measured against.',
      },
      {
        action: 'bet',
        to: 70,
        cost: 70,
        ev: 228.60718050065876,
        derivation:
          'EV(bet) = f x pot + (1 - f) x [ e x (pot + 2b) - b ] = 0.35 x 280 + 0.65 x [ 0.6451 x (280 + 2 x 70) - 70 ] = 98 + 130.61 = 228.61 chips. Risks 70 to win 280. A caller needs 16.7% equity to break even, and as a pure bluff it would have to work 20% of the time. For bluffs of this size not to print automatically, the player facing it has to continue with 80% of their range.',
        foldEquityAssumed: 0.35,
        potShareIfCalled: 0.6450812472551603,
      },
      {
        action: 'bet',
        to: 186,
        cost: 186,
        ev: 250.48543258673692,
        derivation:
          'EV(bet) = f x pot + (1 - f) x [ e x (pot + 2b) - b ] = 0.35 x 280 + 0.65 x [ 0.6451 x (280 + 2 x 186) - 186 ] = 98 + 152.49 = 250.49 chips. Risks 186 to win 280. A caller needs 28.5% equity to break even, and as a pure bluff it would have to work 39.9% of the time. For bluffs of this size not to print automatically, the player facing it has to continue with 60.1% of their range.',
        foldEquityAssumed: 0.35,
        potShareIfCalled: 0.6450812472551603,
      },
      {
        action: 'bet',
        to: 520,
        cost: 520,
        ev: 313.4797101449275,
        derivation:
          'EV(bet) = f x pot + (1 - f) x [ e x (pot + 2b) - b ] = 0.35 x 280 + 0.65 x [ 0.6451 x (280 + 2 x 520) - 520 ] = 98 + 215.48 = 313.48 chips. Risks 520 to win 280. A caller needs 39.4% equity to break even, and as a pure bluff it would have to work 65% of the time. For bluffs of this size not to print automatically, the player facing it has to continue with 35% of their range. Betting this is your whole stack, so it is also an all-in.',
        foldEquityAssumed: 0.35,
        potShareIfCalled: 0.6450812472551603,
      },
    ],
    suggestion: {
      action: 'bet',
      sizeRange: {
        min: 520,
        max: 520,
      },
      confidence: 'reasonable',
      reason:
        'bet has the highest expected value against the stated range, by 63.0 chips over the next-best action.',
      whatWouldChangeIt: [
        'This assumes the line wins uncontested 35% of the time. An opponent who folds less often makes it worse.',
        'Being raised is not modelled here, so treat the figure as optimistic.',
        '38 of your 40 outs are dirty — they improve you without making you safe, so counting all of them would overstate your chances.',
      ],
    },
    stackContext: {
      effectiveStack: 520,
      spr: 1.8571428571428572,
      potOddsOfferedByPotSizedBet: 0.3333333333333333,
      explanation:
        'Yours is the shorter stack: you have 520 and the deepest opponent has 520, so at most 520 can change hands. You can neither win nor lose more than you brought to the hand. SPR = effective stack / pot = 520 / 280 = 1.86. There are 1.86 pots behind, which is the "low" band. One pot-sized bet and a call puts the stacks in. The live question on this street is whether you are committing, not what happens on the next one. SPR describes the shape of the decision, not the answer to it: your hand, their range and position all still apply.',
    },
    assumptions: [
      'The hand is played to the river with no further betting — this is raw equity, not the value of the spot.',
      'you holds exactly QsQd.',
      'a loose continuing range on this board holds any of 46 combinations from "JJ, 77, 44, AJ, KJs, QJs, JTs, 98s, 65s, A5s, KQo", each equally likely.',
      'Every hand in a range is weighted equally. Real opponents do not play every hand in a range the same way, so treat this as the range assumption, not a prediction.',
      'Computed by enumerating every remaining board — there is no sampling error.',
      'Bet and raise figures assume the line wins uncontested 35% of the time. That is an input you can change, not something measured.',
      'A half-pot bet of 140 is already break-even or better here purely on the equity you have when called — it does not need to win uncontested at all.',
      'Expected values are measured against folding, which is treated as zero. Chips already in the pot are spent either way.',
    ],
    uncertainty: {
      method: 'exact-enumeration',
      summary:
        'Computed exactly by enumerating every remaining board (45,540 run-outs). There is no sampling error.',
      confidenceInterval: null,
      limitations: [
        'This is raw equity: the hand is treated as running to the river with no further betting. Real hands have more streets and more decisions.',
        'Every hand in the opponent range is weighted equally. Real opponents do not play every hand in a range the same way.',
        'The clean/dirty split for outs uses documented equity thresholds. They are a modelling choice, not a law of the game.',
        'No implied odds, reverse implied odds or future-street play are modelled.',
      ],
    },
    teachingNotes: [
      'Notice the split: 2 clean and 38 dirty, out of 40 outs in total. A card that improves you is not the same as a card that wins you the hand — an opponent who is behind after it lands can still draw out on the last card.',
      'No rule-of-2-and-4 figure here, deliberately: at 64.5% you are already ahead, so you are not drawing to anything. The shortcut counts the cards that rescue a hand that is behind; applied to a hand that is already winning it counts cards that change nothing and returns a number that is not a probability of anything.',
      'At an SPR of 1.9 the stacks are shallow enough that one more bet commits them. Decisions like that are effectively made now rather than later.',
    ],
  },
  'river-bluff-catch-range': {
    street: 'river',
    potTotal: 900,
    toCall: 540,
    outs: null,
    equity: {
      heroEquity: 0.24324324324324326,
      method: 'exact-enumeration',
      trials: 37,
      confidenceHalfWidthPoints: null,
      ruleOfThumb: null,
      perPlayer: [
        {
          label: 'you',
          equity: 0.24324324324324326,
          win: 0.24324324324324326,
          tie: 0,
        },
        {
          label: 'the value hands and missed draws that get here betting',
          equity: 0.7567567567567568,
          win: 0.7567567567567568,
          tie: 0,
        },
      ],
    },
    potOdds: {
      pot: 900,
      toCall: 540,
      breakEvenEquity: 0.375,
      oddsRatio: 1.6666666666666667,
      equitySurplus: -0.13175675675675674,
      explanation:
        "Hero risks 540 to win the 900 already in the middle, a price of 1.67 to 1. Calling breaks even at 540 / (900 + 540) = 37.5% equity: with less than that, calling loses units over many repetitions of this spot; with more, it gains them. The 900 is what is in the middle before hero's own 540 goes in — counting the call inside the pot understates the equity a call needs. You clear that with 24.3% equity, a -13.2 point shortfall.",
    },
    candidates: [
      {
        action: 'fold',
        cost: 0,
        ev: 0,
        derivation:
          'EV(fold) = 0 chips. Folding is the baseline every other action is measured against: it costs nothing further and risks nothing further. Everything already in the pot is spent either way, so folding is the zero point every other action is measured against.',
      },
      {
        action: 'call',
        to: 540,
        cost: 540,
        ev: -189.72972972972968,
        derivation:
          'EV(call) = equity x (pot + toCall) - toCall = 0.2432 x (900 + 540) - 540 = -189.73 chips.',
        potShareIfCalled: 0.24324324324324326,
      },
      {
        action: 'raise',
        to: 900,
        cost: 900,
        ev: 71.51351351351352,
        derivation:
          'EV(raise) = f x pot + (1 - f) x [ e x (pot + c + 2r) - (c + r) ] = 0.35 x 900 + 0.65 x [ 0.2432 x (900 + 540 + 2 x 360) - 900 ] = 315 + (-243.49) = 71.51 chips. Risks 900 to win 900. Raising by 360 is one quarter pot of the 1440 that would be in the middle once you call. A caller needs 16.7% equity to break even on the extra 360, and has to continue with 80% of their range for a raise of this size not to print automatically. That size is also your whole remaining stack.',
        foldEquityAssumed: 0.35,
        potShareIfCalled: 0.24324324324324326,
      },
    ],
    suggestion: {
      action: 'raise',
      sizeRange: {
        min: 900,
        max: 900,
      },
      confidence: 'reasonable',
      reason:
        'raise has the highest expected value against the stated range, by 71.5 chips over the next-best action.',
      whatWouldChangeIt: [
        'This assumes the line wins uncontested 35% of the time. An opponent who folds less often makes it worse.',
        'Being raised is not modelled here, so treat the figure as optimistic.',
      ],
    },
    stackContext: {
      effectiveStack: 540,
      spr: 0.6,
      potOddsOfferedByPotSizedBet: 0.3333333333333333,
      explanation:
        'The deepest opponent has only 540, so at most 540 can change hands even though you have 900. The 360 above that is not in play this hand — nobody can pay you for it and nobody can take it. SPR = effective stack / pot = 540 / 900 = 0.6. There are 0.6 pots behind, which is the "very-low" band. The pot is already larger than what is behind, so a single bet gets the rest of the stack in. There is no later street to hold chips back for: at this depth the decision is effectively made now. SPR describes the shape of the decision, not the answer to it: your hand, their range and position all still apply.',
    },
    assumptions: [
      'The hand is played to the river with no further betting — this is raw equity, not the value of the spot.',
      'you holds exactly 9h9c.',
      'the value hands and missed draws that get here betting holds any of 37 combinations from "JJ, 66, 33, AJs, KJs, QJs, JTs, T9s, 88, 76s, 54s, A5s", each equally likely.',
      'Every hand in a range is weighted equally. Real opponents do not play every hand in a range the same way, so treat this as the range assumption, not a prediction.',
      'Computed by enumerating every remaining board — there is no sampling error.',
      'Bet and raise figures assume the line wins uncontested 35% of the time. That is an input you can change, not something measured.',
      'For a half-pot bet of 450 to break even here it would need to win uncontested 1% of the time.',
      'Expected values are measured against folding, which is treated as zero. Chips already in the pot are spent either way.',
    ],
    uncertainty: {
      method: 'exact-enumeration',
      summary:
        'Computed exactly by enumerating every remaining board (37 run-outs). There is no sampling error.',
      confidenceInterval: null,
      limitations: [
        'This is raw equity: the hand is treated as running to the river with no further betting. Real hands have more streets and more decisions.',
        'Every hand in the opponent range is weighted equally. Real opponents do not play every hand in a range the same way.',
        'No implied odds, reverse implied odds or future-street play are modelled.',
      ],
    },
    teachingNotes: [
      'The pot is laying you 1.7 to 1, so you need 37.5% to break even on a call. That number depends only on the price — not on your cards.',
      'At an SPR of 0.6 the stacks are shallow enough that one more bet commits them. Decisions like that are effectively made now rather than later.',
    ],
  },
  'preflop-squeeze-fold-equity': {
    street: 'preflop',
    potTotal: 150,
    toCall: 40,
    outs: null,
    equity: {
      heroEquity: 0.4458,
      method: 'monte-carlo',
      trials: 40000,
      confidenceHalfWidthPoints: 0.46694767003076876,
      ruleOfThumb: null,
      perPlayer: [
        {
          label: 'you',
          equity: 0.4458,
          win: 0.405725,
          tie: 0.08015,
        },
        {
          label: 'the top 22% of hands',
          equity: 0.5542,
          win: 0.514125,
          tie: 0.08015,
        },
      ],
    },
    potOdds: {
      pot: 150,
      toCall: 40,
      breakEvenEquity: 0.21052631578947367,
      oddsRatio: 3.75,
      equitySurplus: 0.2352736842105263,
      explanation:
        "Hero risks 40 to win the 150 already in the middle, a price of 3.75 to 1. Calling breaks even at 40 / (150 + 40) = 21.1% equity: with less than that, calling loses units over many repetitions of this spot; with more, it gains them. The 150 is what is in the middle before hero's own 40 goes in — counting the call inside the pot understates the equity a call needs. You clear that with 44.6% equity, a 23.5 point surplus.",
    },
    candidates: [
      {
        action: 'fold',
        cost: 0,
        ev: 0,
        derivation:
          'EV(fold) = 0 chips. Folding is the baseline every other action is measured against: it costs nothing further and risks nothing further. Everything already in the pot is spent either way, so folding is the zero point every other action is measured against.',
      },
      {
        action: 'call',
        to: 40,
        cost: 40,
        ev: 44.702,
        derivation: 'EV(call) = equity x (pot + toCall) - toCall = 0.4458 x (150 + 40) - 40 = 44.7 chips.',
        potShareIfCalled: 0.4458,
      },
      {
        action: 'raise',
        to: 87,
        cost: 87,
        ev: 78.24467999999999,
        derivation:
          'EV(raise) = f x pot + (1 - f) x [ e x (pot + c + 2r) - (c + r) ] = 0.35 x 150 + 0.65 x [ 0.4458 x (150 + 40 + 2 x 47) - 87 ] = 52.5 + 25.74 = 78.24 chips. Risks 87 to win 150. Raising by 47 is one quarter pot of the 190 that would be in the middle once you call. A caller needs 16.5% equity to break even on the extra 47, and has to continue with 80.2% of their range for a raise of this size not to print automatically.',
        foldEquityAssumed: 0.35,
        potShareIfCalled: 0.4458,
      },
      {
        action: 'raise',
        to: 166,
        cost: 166,
        ev: 72.67833999999999,
        derivation:
          'EV(raise) = f x pot + (1 - f) x [ e x (pot + c + 2r) - (c + r) ] = 0.35 x 150 + 0.65 x [ 0.4458 x (150 + 40 + 2 x 126) - 166 ] = 52.5 + 20.18 = 72.68 chips. Risks 166 to win 150. Raising by 126 is two thirds pot of the 190 that would be in the middle once you call. A caller needs 28.5% equity to break even on the extra 126, and has to continue with 60.1% of their range for a raise of this size not to print automatically.',
        foldEquityAssumed: 0.35,
        potShareIfCalled: 0.4458,
      },
      {
        action: 'raise',
        to: 1000,
        cost: 1000,
        ev: 13.914699999999947,
        derivation:
          'EV(raise) = f x pot + (1 - f) x [ e x (pot + c + 2r) - (c + r) ] = 0.35 x 150 + 0.65 x [ 0.4458 x (150 + 40 + 2 x 960) - 1000 ] = 52.5 + (-38.59) = 13.91 chips. Risks 1000 to win 150. Raising by 960 puts your whole remaining stack in. A caller needs 45.5% equity to break even on the extra 960, and has to continue with 16.5% of their range for a raise of this size not to print automatically.',
        foldEquityAssumed: 0.35,
        potShareIfCalled: 0.4458,
      },
    ],
    suggestion: {
      action: 'raise',
      sizeRange: {
        min: 87,
        max: 166,
      },
      confidence: 'moderate',
      reason:
        'raise has the highest expected value against the stated range, by 5.6 chips over the next-best action.',
      whatWouldChangeIt: [
        'This assumes the line wins uncontested 35% of the time. An opponent who folds less often makes it worse.',
        'Being raised is not modelled here, so treat the figure as optimistic.',
        'The equity figure is sampled, ±0.47 points at 95% confidence. A close decision could sit either side of that.',
        'The gap to the next-best action is only 5.6 chips, well under a big blind — this is close to indifferent.',
      ],
    },
    stackContext: {
      effectiveStack: 1000,
      spr: 6.666666666666667,
      potOddsOfferedByPotSizedBet: 0.3333333333333333,
      explanation:
        'Yours is the shorter stack: you have 1000 and the deepest opponent has 1000, so at most 1000 can change hands. You can neither win nor lose more than you brought to the hand. With 3 opponents each one has its own effective stack, the smaller of yours and theirs. 1000 is the largest of them, so it is the most that can move against any single player and not the most you can lose across all of them. SPR = effective stack / pot = 1000 / 150 = 6.67. There are 6.67 pots behind, which is the "high" band. Several streets of betting fit before the stacks are in, so this decision mostly sets up the next one rather than settling the hand. SPR describes the shape of the decision, not the answer to it: your hand, their range and position all still apply.',
    },
    assumptions: [
      'The hand is played to the river with no further betting — this is raw equity, not the value of the spot.',
      'you holds exactly As5s.',
      'the top 22% of hands holds any of 255 combinations from "AA, KK, QQ, JJ, TT, 99, 88, AKs, AQs, 77, AKo, AJs, ATs, AQo, 66, AJo, KQs, ATo, KJs, A9s, KTs, A8s, KQo, A7s, 55, A9o, KJo, QJs, KTo, K9s, A6s, A5s, QTs, A8o, A4s, A7o, QJo, A3s, JTs, K8s, K7s, K9o, A6o", each equally likely.',
      'Every hand in a range is weighted equally. Real opponents do not play every hand in a range the same way, so treat this as the range assumption, not a prediction.',
      'Estimated by sampling 40,000 random run-outs, not by exhaustive enumeration.',
      'No community cards are known yet, so five more cards are still to come.',
      'Bet and raise figures assume the line wins uncontested 35% of the time. That is an input you can change, not something measured.',
      'A half-pot bet of 75 is already break-even or better here purely on the equity you have when called — it does not need to win uncontested at all.',
      'Expected values are measured against folding, which is treated as zero. Chips already in the pot are spent either way.',
    ],
    uncertainty: {
      method: 'monte-carlo',
      summary:
        'Estimated by sampling 40,000 run-outs. The 95% confidence interval is ±0.47 percentage points.',
      confidenceInterval: {
        level: 0.95,
        halfWidthPoints: 0.46694767003076876,
      },
      limitations: [
        'This is raw equity: the hand is treated as running to the river with no further betting. Real hands have more streets and more decisions.',
        'Every hand in the opponent range is weighted equally. Real opponents do not play every hand in a range the same way.',
        'Equity was estimated from 40,000 sampled run-outs, not enumerated exhaustively.',
        'No implied odds, reverse implied odds or future-street play are modelled.',
      ],
    },
    teachingNotes: [
      'The pot is laying you 3.8 to 1, so you need 21.1% to break even on a call. That number depends only on the price — not on your cards.',
      'A profitable call still loses more often than it wins whenever the break-even point is under 50%. Losing this hand would not make the call wrong.',
    ],
  },
};

/**
 * Indexes built once at module scope rather than per render.
 *
 * Six entries is not a performance problem; doing it here is about there being one lookup path, so
 * a screen cannot find a scenario the summary list does not know about.
 */
const SCENARIOS_BY_ID: ReadonlyMap<ContentId, Scenario> = new Map(
  LAB_SCENARIOS.map((scenario) => [scenario.id, scenario]),
);

const GLOSSARY_BY_ID: ReadonlyMap<ContentId, GlossaryEntry> = new Map(
  LEARN_GLOSSARY.map((entry) => [entry.id, entry]),
);

/**
 * The summary rows the index renders.
 *
 * Derived from the scenarios rather than authored separately, because a summary that could
 * disagree with its scenario is a filter that lies: a card claiming "turn" that opens onto a flop
 * would be worse than no filter at all.
 */
export const LAB_SCENARIO_SUMMARIES: readonly ScenarioSummary[] = LAB_SCENARIOS.map((scenario) => ({
  id: scenario.id,
  title: scenario.title,
  topic: scenario.topic,
  difficulty: scenario.difficulty,
  question: scenario.question,
  street: scenario.street,
  attempted: ATTEMPTED.includes(scenario.id),
}));

/** The list response, in the shape `GET /api/scenarios` will return. */
export function scenarioListFixture(): ScenarioListResponse {
  return { scenarios: LAB_SCENARIO_SUMMARIES };
}

/** Glossary entries for a scenario's terms. Missing ids are dropped rather than faked. */
function glossaryFor(terms: readonly ContentId[]): readonly GlossaryEntry[] {
  const entries: GlossaryEntry[] = [];
  for (const term of terms) {
    const entry = GLOSSARY_BY_ID.get(term);
    if (entry !== undefined) entries.push(entry);
  }
  return entries;
}

/**
 * One scenario, in the shape `GET /api/scenarios/:id` will return. Null for an unknown id, so the
 * page can render a real 404 instead of an empty analysis.
 */
export function scenarioFixture(id: ContentId): ScenarioResponse | null {
  const scenario = SCENARIOS_BY_ID.get(id);
  const analysis = LAB_SCENARIO_ANALYSIS[id];
  if (scenario === undefined || analysis === undefined) return null;
  return { scenario, analysis, glossary: glossaryFor(scenario.glossaryTerms) };
}

/**
 * The attempt response, computed rather than stored.
 *
 * The verdict comes from `judgeConsistency` in `src/lib/consistency.ts`, which is a thin shape over
 * the one rule in `@prl/poker-math` that `apps/api` grades with — so a fixture-backed reveal, an
 * API-backed one and the row written to `scenario_attempts` cannot disagree about what "consistent"
 * means. The scenario's own big blind is passed because the margin is denominated in it.
 *
 * `reasoning` is the scenario's own authored prose, returned identically whichever action was
 * chosen. The reasoning for a spot does not depend on what the learner did, and returning different
 * prose for a "right" and a "wrong" answer is the shape that turns an explanation into a verdict.
 */
export function scenarioAttemptFixture(
  id: ContentId,
  action: ScenarioAction,
  to?: number,
): ScenarioAttemptResponse | null {
  const scenario = SCENARIOS_BY_ID.get(id);
  const analysis = LAB_SCENARIO_ANALYSIS[id];
  if (scenario === undefined || analysis === undefined) return null;
  const judgement = judgeConsistency(analysis, action, to, scenario.bigBlind);
  return {
    consistentWithAnalysis: judgement.consistent,
    reasoning: scenario.reasoning,
    analysis,
    commonMistakes: scenario.commonMistakes,
  };
}

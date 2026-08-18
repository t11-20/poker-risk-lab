/**
 * Fixture: the quiz attached to each of the eight fixture lessons.
 *
 * Between them these cover all three question kinds — `multipleChoice`,
 * `numeric` and `decision` — and every `field` a numeric question asks for
 * (`breakEvenEquity`, `oddsRatio`, `heroEquity`, `cleanCount`, `estimatePercent`, `ev`,
 * `spr`, `probabilityOfLoss`, `standardDeviationBb`, `probability`).
 *
 * Note what a `Quiz` has no field for: a score, a pass mark, a streak. That absence is
 * deliberate in the contract and `QuizRunner` does not reintroduce it.
 *
 * Every string here is copied verbatim from `packages/content/data`, which is the real
 * teaching material. Nothing is paraphrased and nothing is invented, because a fixture that
 * drifts from the content it stands in for is a screen that was reviewed against fiction.
 *
 * NO COMPUTED FIGURE APPEARS ANYWHERE IN THIS FILE. Every number a learner reads is computed
 * in the browser from the `liveCalculation` and `calculation` parameters below — see
 * ADR 0006 and `src/lib/learn-calculations.ts`. Search this file for a percentage and you
 * will only find the ones that are *inputs* (a fold probability, an assumed win rate).
 */

import type { Quiz } from '@prl/contracts';

export const LEARN_QUIZZES: readonly Quiz[] = [
  {
    id: 'quiz-hand-flow',
    title: 'How a hand unfolds',
    topic: 'rules-and-flow',
    lessonId: 'hand-flow',
    questions: [
      {
        kind: 'multipleChoice',
        id: 'hand-flow-q1',
        prompt:
          "A hand of no-limit hold'em has reached the river with two players still in. How many cards has each player been dealt face down, and how many community cards are showing?",
        options: [
          'Two face down, five community cards',
          'Two face down, four community cards',
          'Three face down, five community cards',
          'Two face down, three community cards',
        ],
        correctIndex: 0,
        explanation:
          'Each player is dealt two private cards at the start, and the community cards arrive in three instalments: three at once on the flop, one on the turn, one on the river. By the river there are five community cards on the table, and each player makes their best five-card hand from the seven cards available to them.',
        optionNotes: [
          'Correct: two private cards plus five community cards, which is seven cards to choose five from.',
          'Four community cards is the turn, one street earlier. This is a natural slip because the turn and river are both single cards.',
          "Three face down is a different game entirely. Hold'em always deals exactly two private cards.",
          'Three community cards is the flop. Tempting if you are counting the cards that arrive together and forgetting the two single cards that follow.',
        ],
      },
      {
        kind: 'multipleChoice',
        id: 'hand-flow-q2',
        prompt: 'How many betting rounds are there in a hand that runs all the way to showdown?',
        options: ['Three', 'Four', 'Five', 'Two'],
        correctIndex: 1,
        explanation:
          'There is a betting round before the flop, one after the flop, one after the turn and one after the river: four in total. The pattern is that every time new information arrives, the players get to act on it.',
        optionNotes: [
          'Three counts the postflop streets and forgets that the preflop round is a betting round too.',
          'Correct: preflop, flop, turn and river.',
          'Five would require a fifth street. There are only three community-card deals and one preflop round.',
          'Two undercounts badly; each of the three community-card deals is followed by its own round of betting.',
        ],
      },
      {
        kind: 'multipleChoice',
        id: 'hand-flow-q3',
        prompt: 'Preflop, the action starts to the left of the big blind. Who acts first on the flop?',
        options: [
          'The player who bet last on the previous street',
          'The first player still in the hand to the left of the button',
          'The player on the button',
          'Whoever was dealt in first',
        ],
        correctIndex: 1,
        explanation:
          'From the flop onwards, action begins with the first remaining player to the left of the button and ends with the button, which is why the button acts last on every postflop street. Preflop is the exception, because the blinds have already put money in and act at the end of that round instead.',
        optionNotes: [
          'Who bet last does not set the order. Order is fixed by seat relative to the button, not by what happened before.',
          'Correct: the button always acts last after the flop, so action starts with the nearest active player on its left.',
          'The button acts last postflop, not first. This is worth remembering precisely because it is the seat everyone wants.',
          'Deal order has no effect on betting order at all.',
        ],
      },
      {
        kind: 'multipleChoice',
        id: 'hand-flow-q4',
        prompt: 'On the turn, one player bets and everybody else folds. What happens next?',
        options: [
          'The bettor wins the pot immediately and does not have to show their cards',
          'The bettor wins the pot but must show their cards',
          'The river is dealt anyway to settle the hand',
          'The pot is split between everyone who was still in on the flop',
        ],
        correctIndex: 0,
        explanation:
          'A hand ends the moment only one player remains. That player takes the pot, and because there was no showdown, nobody is entitled to see their cards. This is the reason a bet has two ways to win: at showdown, or by everyone else giving up.',
        optionNotes: [
          'Correct: no showdown means no obligation to reveal anything.',
          'Showing is only required when two or more players reach a showdown and the pot is contested.',
          'There is nothing left to settle once one player remains, so no further cards are dealt.',
          'Folding forfeits any claim on the pot, whatever street it happened on.',
        ],
      },
    ],
    reviewAdvice:
      'If any of these felt uncertain, reread the order of streets and the acting order. It is worth being able to say out loud, without hesitation, how many cards arrive on each street and who acts first, because every later idea in this course is built on that sequence. There is no score here: the point is to notice which parts you had to think twice about.',
  },
  {
    id: 'quiz-counting-outs',
    title: 'Counting and discounting outs',
    topic: 'hand-reading-and-outs',
    lessonId: 'counting-outs',
    questions: [
      {
        kind: 'multipleChoice',
        id: 'counting-outs-q1',
        prompt:
          'You hold two hearts and exactly two hearts are on the flop. How many cards in the deck complete your flush?',
        options: ['Nine', 'Eleven', 'Thirteen', 'Four'],
        correctIndex: 0,
        explanation:
          'There are thirteen cards of each suit. You can see four of them: two in your hand and two on the board. That leaves the rest of the suit unaccounted for, and every one of them makes five hearts. This subtraction is the whole method for counting outs, and it is worth doing rather than remembering.',
        optionNotes: [
          'Correct: thirteen in the suit, minus the four you can see.',
          'Eleven would mean only two hearts were accounted for. All four visible hearts have to come out of the count.',
          'Thirteen is the number in the suit before removing the ones you can already see.',
          'Four is how many hearts you can see, not how many are left.',
        ],
      },
      {
        kind: 'multipleChoice',
        id: 'counting-outs-q2',
        prompt:
          'You have both a flush draw and a straight draw, and one particular card would complete both at once. How should that card be counted?',
        options: [
          'As two outs, since it makes two different hands',
          'As one out, because one card can only arrive once',
          'As half an out, since you cannot use both hands',
          'It should not be counted at all',
        ],
        correctIndex: 1,
        explanation:
          'Outs are cards, not hands. You are counting how many of the unseen cards help you, and a single card is a single card however many ways it improves you. Double counting overlapping outs is one of the most common ways a count comes out too high.',
        optionNotes: [
          'Two outs would mean two cards can arrive, and there is only one of that card left in the deck.',
          'Correct: one card is one out, no matter how many draws it completes.',
          'There is nothing fractional about it; the card either arrives or it does not.',
          'It is certainly an out, and often one of your best ones, since it makes the stronger of the two hands.',
        ],
      },
      {
        kind: 'multipleChoice',
        id: 'counting-outs-q3',
        prompt:
          'Some of the cards that improve your hand would leave you with the second-best hand against the holdings your opponent is most likely to have. What should you do with those cards?',
        options: [
          'Count them fully; an improvement is an improvement',
          'Discount them, and be explicit that you are doing so and why',
          'Ignore all outs unless they make the best possible hand',
          "Count them twice, because they also make your opponent's hand less likely",
        ],
        correctIndex: 1,
        explanation:
          "An out is only useful if it wins. A card that improves you into second place costs you money rather than saving you, because you will happily pay off the rest of the hand with it. Discounting is unavoidably a judgement call, which is exactly why you should say the judgement out loud: 'I am counting these as half, because I think a third of their range has me beaten even when this card comes'.",
        optionNotes: [
          'Counting every improvement is how a drawing hand ends up looking far better than it is.',
          'Correct: discount them, and state the assumption you are discounting on.',
          'Requiring the best possible hand is too strict and throws away plenty of genuine outs.',
          'Cards that help you do not make their hand less likely; that is a different idea called blockers, and it applies to cards you already hold.',
        ],
      },
      {
        kind: 'numeric',
        id: 'counting-outs-q4',
        prompt:
          'You hold Th 9h, the board is Ah 7h 2c 4d, and your opponent has turned over As Ks - so only the river is left. How many of the remaining cards give you the winning hand?',
        calculation: {
          kind: 'outs',
          heroCards: 'Th9h',
          board: 'Ah7h2c4d',
          opponentCards: 'AsKs',
        },
        field: 'cleanCount',
        unit: 'count',
        tolerance: 0.5,
        explanation:
          'Work it out in two steps. First, what do you need to beat a pair of aces? Second, how many cards deliver it, once you have removed every card you can already see. Be careful with the near misses: pairing one of your own cards does not get you there, so those cards are not outs at all, whatever they may feel like. Because there is exactly one card to come, an out here is simply a card that wins - there is no later street for the picture to change on.',
      },
      {
        kind: 'decision',
        id: 'counting-outs-q5',
        prompt:
          "Hero holds two of a suit and two more of that suit are on the board, which looks like a routine flush draw - except the opponent's cards are face up and they hold two higher cards of the same suit. Decide whether hero should call or fold, and then ask where hero's genuine chances are actually coming from.",
        scenarioId: 'eq-dominated-flush-draw-turn',
        explanation:
          "This spot is built to punish the reflex 'I have a flush draw, so I have nine outs'. The cards that complete hero's flush hand the opponent a better one, so they are not outs at all - they are the most expensive cards in the deck for hero, because hero will happily pay off with a hand that cannot win. Hero's real chances come from somewhere else entirely, and the app counts them for you once you look. Two habits to take from it. Count outs against what your opponent can hold rather than against your own hand in isolation. And notice that being face up is a teaching convenience: away from a lesson you would be estimating how often their range contains two of your suit, and that estimate is exactly what makes drawing to a second-best flush so costly.",
      },
    ],
    reviewAdvice:
      'Counting outs is subtraction and honesty in equal parts: the subtraction is easy, and deciding which cards actually win is where the work is. If your instinct was to count everything that improved your hand, that is the habit worth attacking, and the discounting question is the one to reread. Try recounting the last question as though your opponent held two black aces instead, and notice how the count moves.',
  },
  {
    id: 'quiz-rule-of-2-and-4',
    title: 'The rule of 2 and 4',
    topic: 'probability-and-equity',
    lessonId: 'rule-of-2-and-4',
    questions: [
      {
        kind: 'multipleChoice',
        id: 'rule24-q1',
        prompt: 'Why does multiplying your outs by 2 approximate your chance of hitting on the next card?',
        options: [
          'Because roughly fifty cards are unseen, so each single out is worth about two percent of them',
          'Because probabilities double on each street',
          "Because half of your outs will already be in another player's hand",
          'Because two cards are dealt on every street',
        ],
        correctIndex: 0,
        explanation:
          'After a flop there are around fifty cards you cannot see, so any one specific card is close to one in fifty, which is about two percent. Multiply by how many cards help you and you have a workable estimate. The rule is arithmetic on the size of the deck, which is why it is stable and easy to remember.',
        optionNotes: [
          'Correct: one unseen card out of roughly fifty is about two percent, so outs times two is a chance.',
          'Nothing doubles between streets. Doubling appears in the rule because there are two cards to come, not because probability grows.',
          "Cards in other players' hands are unknown to you and are correctly treated as part of the unseen deck.",
          'One card is dealt on the turn and one on the river; the flop is three at once.',
        ],
      },
      {
        kind: 'numeric',
        id: 'rule24-q2',
        prompt:
          'You have nine cards that would win you the hand, and both the turn and the river are still to come. What percentage does the rule of 2 and 4 estimate?',
        calculation: {
          kind: 'ruleOf24',
          outs: 9,
          cardsToCome: 2,
        },
        field: 'estimatePercent',
        unit: 'percent',
        tolerance: 1,
        explanation:
          'Apply the rule as stated: with two cards to come, multiply the outs by four. This is deliberately an estimate you can do at a table in a second, and the next question is about where it goes wrong. Enter the estimate the rule gives, not a more exact figure you may know from elsewhere.',
      },
      {
        kind: 'numeric',
        id: 'rule24-q3',
        prompt:
          'Same hand one street later: you still have nine winning cards, but only the river is to come. What does the rule estimate now?',
        calculation: {
          kind: 'ruleOf24',
          outs: 9,
          cardsToCome: 1,
        },
        field: 'estimatePercent',
        unit: 'percent',
        tolerance: 1,
        explanation:
          'With one card to come the multiplier is two rather than four. Compare this with your previous answer and notice that seeing one card instead of two costs you about half your chances, which is why the price you are willing to pay on the flop and on the turn are not the same. Nothing about your hand changed between the two questions.',
      },
      {
        kind: 'multipleChoice',
        id: 'rule24-q4',
        prompt: 'When is the times-four version of the rule most likely to mislead you?',
        options: [
          'When you have very few outs',
          'When you have many outs, or when you will probably face another bet on the turn',
          'When your opponent is bluffing',
          'When the pot is small',
        ],
        correctIndex: 1,
        explanation:
          'Two separate problems appear together. Arithmetically, multiplying by four drifts upwards as the out count rises, so with a large draw the estimate is too generous. Strategically, times four assumes you get to see both cards, which is only true if you are all in or the betting stops - and if another bet is coming on the turn, you are paying now for one card, not two.',
        optionNotes: [
          'With few outs the estimate is quite close, which is where the rule is at its most reliable.',
          'Correct: large out counts overstate, and unpaid streets are not guaranteed.',
          'Whether they are bluffing changes what you are drawing against, not the accuracy of an arithmetic shortcut.',
          'Pot size changes the price you are comparing against, not the estimate itself.',
        ],
      },
      {
        kind: 'numeric',
        id: 'rule24-q5',
        prompt:
          'You hold Th 9h, the flop is Ah 7h 2c, and your opponent shows you As Ks. Estimate your equity with the rule of 4 first, then compute it exactly: what share of the pot is your hand worth?',
        calculation: {
          kind: 'equity',
          heroCards: 'Th9h',
          board: 'Ah7h2c',
          opponents: ['AsKs'],
        },
        field: 'heroEquity',
        unit: 'percent',
        tolerance: 5,
        explanation:
          'Count your winning cards first, apply the rule, write your estimate down, and only then look at the computed figure. The gap between them, in whichever direction it falls, is the useful part of this question, so pay attention to the sign of your error rather than just its size. The estimate can come out too high, because some cards that look like outs do not actually win and because your opponent can improve too. It can also come out too low, because a simple out count misses the runouts where you get there in a way you were not counting - pairing up twice, or two cards arriving that make a hand you never listed. The rule is a tool for one second of thinking at the table, not a claim about the deck.',
      },
    ],
    reviewAdvice:
      "The rule is worth trusting for what it is: a fast estimate whose error you should be able to describe. If you can say in one sentence why the times-four version drifts high with big draws, and why it assumes a street you may have to pay for, you have got everything from this quiz that matters. The exact figures are the app's job; the estimate and its known biases are yours.",
  },
  {
    id: 'quiz-pot-odds',
    title: 'Reading the price',
    topic: 'pot-odds-and-ev',
    lessonId: 'pot-odds',
    questions: [
      {
        kind: 'multipleChoice',
        id: 'pot-odds-q1',
        prompt: 'Which of these describes break-even equity correctly?',
        options: [
          'The chance that you currently hold the best hand',
          'The share of the time you must end up with the pot for calling to be no better or worse than folding',
          'The share of the pot that already belongs to you',
          'The chance that your opponent is bluffing',
        ],
        correctIndex: 1,
        explanation:
          'Break-even equity is the price translated into a required frequency. It comes entirely from the chips - what you must call, against what the pot will hold once you have called - and it makes no reference to your cards, their cards, or their intentions.',
        optionNotes: [
          'Whether you are ahead now is a separate question, and you can be behind while comfortably clearing the price.',
          'Correct: it is the frequency at which calling and folding come out level.',
          'None of the pot belongs to you until you win it, which is why folding is worth exactly zero.',
          'Their bluffing frequency affects your equity, but break-even equity is computed from chips alone.',
        ],
      },
      {
        kind: 'numeric',
        id: 'pot-odds-q2',
        prompt:
          'There was 50 in the middle on the river and your opponent bet 50, so the pot now stands at 100 and calling costs you 50. What share of the time do you need to end up with the pot for calling to break even?',
        calculation: {
          kind: 'potOdds',
          pot: 100,
          toCall: 50,
        },
        field: 'breakEvenEquity',
        unit: 'percent',
        tolerance: 1.5,
        explanation:
          'Take what you must put in and divide it by what the pot contains once you have put it in - which means your own call belongs in the denominator, because your call comes back to you out of the pot you take down. Deriving it beats remembering it, since the same derivation handles every size.',
      },
      {
        kind: 'numeric',
        id: 'pot-odds-q3',
        prompt:
          'Same river, different size: there was 60 in the middle and your opponent bet 120, so the pot stands at 180 and calling costs 120. What share of the time do you now need to end up with the pot?',
        calculation: {
          kind: 'potOdds',
          pot: 180,
          toCall: 120,
        },
        field: 'breakEvenEquity',
        unit: 'percent',
        tolerance: 1.5,
        explanation:
          'Use the same fraction as the previous question, with the new numbers. Then compare the two answers: your cards and the board did not change between them, only their choice of size did. That comparison is the entire reason bet sizing is a lever, and it is worth feeling it as a single moving quantity rather than two separate sums.',
      },
      {
        kind: 'numeric',
        id: 'pot-odds-q4',
        prompt:
          "On the turn the pot stands at 90 including your opponent's bet, and calling costs 30. Expressed as 'how many to one', what price is the pot laying you?",
        calculation: {
          kind: 'potOdds',
          pot: 90,
          toCall: 30,
        },
        field: 'oddsRatio',
        unit: 'ratio',
        tolerance: 0.2,
        explanation:
          'The ratio compares what is in the middle with what you must put in. Enter it as a single number - a price of two and a half to one would be entered as 2.5. Both forms of the price carry the same information, and being able to move between them quickly is worth more than preferring one.',
      },
      {
        kind: 'multipleChoice',
        id: 'pot-odds-q5',
        prompt:
          'You work out that the price is asking for about a quarter, and you estimate your equity against their range at about a third. What follows?',
        options: [
          'Calling is the optimal play',
          'Under your range assumption, calling gains chips compared with folding - though raising might do better still, and the assumption could be wrong',
          'Your hand is a favourite to win the pot',
          'You should call every time you are in this spot',
        ],
        correctIndex: 1,
        explanation:
          'Clearing the price means calling beats folding, and that is genuinely all it means. Two limits come with it. Your equity estimate rests on an assumed range, so a wrong assumption makes the comparison wrong. And the comparison was call against fold: it says nothing at all about raising, which sometimes beats both.',
        optionNotes: [
          'Optimal is a claim about every available action. You have compared two of them.',
          'Correct: it beats folding under the stated assumption, with raising uncompared and the assumption still open to challenge.',
          'A third of the time is not a favourite; you will lose this pot far more often than you win it, and the call still gains chips.',
          'Always is too strong. Change their range or their sizing and the comparison changes with it.',
        ],
      },
    ],
    reviewAdvice:
      'Watch which half of the comparison you are least comfortable with. The price is exact arithmetic and should become automatic; the equity is an estimate that depends on a range you chose, and that is where the real thinking lives. If you found yourself wanting a table of numbers to memorise, resist it - the fraction is faster than the table and works at every size.',
  },
  {
    id: 'quiz-expected-value',
    title: 'What a decision is worth',
    topic: 'pot-odds-and-ev',
    lessonId: 'expected-value',
    questions: [
      {
        kind: 'numeric',
        id: 'ev-q1',
        prompt:
          "The pot stands at 120 including your opponent's bet, and calling costs 40. Assume that against the range you have put them on, you end up with the pot 40 times in 100. In chips, what is the expected value of calling rather than folding?",
        calculation: {
          kind: 'callEv',
          pot: 120,
          toCall: 40,
          equity: 0.4,
        },
        field: 'ev',
        unit: 'chips',
        tolerance: 3,
        explanation:
          'Two outcomes, each with a weight. When you win, you collect the middle plus your own call coming back; when you lose, you are out the call. Weight each by how often it happens and add them. Folding is the zero point, so the answer is how many chips calling gains or loses relative to giving up. Remember that the equity here was assumed rather than measured, and the answer is only as good as that assumption.',
      },
      {
        kind: 'numeric',
        id: 'ev-q2',
        prompt:
          'A different spot: the pot stands at 80 including their bet, calling costs 40, and this time your hand only gets there 20 times in 100. In chips, what is the expected value of calling? The answer may be negative.',
        calculation: {
          kind: 'callEv',
          pot: 80,
          toCall: 40,
          equity: 0.2,
        },
        field: 'ev',
        unit: 'chips',
        tolerance: 3,
        explanation:
          'Same two outcomes, same weighting, worse numbers on both sides: a bigger bet relative to the pot and less equity. A negative result means folding is the better of those two options by that many chips on average. Note that it does not mean the call loses every time - it means the wins are not large or frequent enough to pay for the losses.',
      },
      {
        kind: 'multipleChoice',
        id: 'ev-q3',
        prompt: 'Why is folding treated as expected value of zero?',
        options: [
          'Because folding costs you the pot',
          'Because the chips already in the pot are not yours, so folding neither wins nor loses them',
          'Because folding costs you the chips you put in earlier in the hand',
          'Because folding is always the safest option',
        ],
        correctIndex: 1,
        explanation:
          'The pot is not yours until you win it. Folding declines a chance at it without paying anything further, so it is the natural baseline every other option is measured against. Chips you committed earlier are already in the pot and cannot be recovered by any decision except winning it.',
        optionNotes: [
          'You cannot lose something you never owned; declining a chance at the pot is not the same as paying for it.',
          'Correct: folding is the do-nothing option, so it is the zero that other actions are compared with.',
          'Those chips are already spent whatever you do next, which is why they should not enter this decision at all.',
          'Safety is not the measure. Folding can be the worst available option in chips terms and still feel safest.',
        ],
      },
      {
        kind: 'multipleChoice',
        id: 'ev-q4',
        prompt:
          'You made a call your arithmetic said gained chips, and you lost the pot. What does that tell you about the call?',
        options: [
          'It was a mistake, since it lost',
          'Almost nothing on its own; a call that gains chips on average can lose most of the individual times you make it',
          'It was correct, because you did the arithmetic',
          'That your equity estimate was too high',
        ],
        correctIndex: 1,
        explanation:
          'One result carries almost no information about a decision. A call needing a quarter and delivering a third loses two times in three and still gains chips every time it is made. What can be reviewed is the input: was the price computed correctly, and was the range you assumed defensible? Those you can check. The outcome you cannot.',
        optionNotes: [
          'This is the single most expensive habit of thought in poker: grading decisions by their results.',
          'Correct: the result is nearly uninformative, and the inputs are what can be reviewed.',
          'Doing arithmetic is not the same as doing correct arithmetic on defensible assumptions, so this is too comfortable a conclusion.',
          'It might have been, but a single loss is no evidence either way. Test the estimate against the range, not against the river card.',
        ],
      },
      {
        kind: 'multipleChoice',
        id: 'ev-q5',
        prompt:
          'Your calculation shows that calling gains chips. Which further step is worth taking before you act?',
        options: [
          'Compute the alternatives too, since call versus fold says nothing about raising',
          'Nothing; a positive result settles the decision',
          'Increase your estimate of your equity to be sure',
          'Check whether you have lost with this hand before',
        ],
        correctIndex: 0,
        explanation:
          'EV ranks the options you actually compute. A profitable call can be the second-best action, and raising is a genuinely different decision with different mechanics - it can win the pot immediately, which calling never does. Comparing two options and announcing a best one is the most common gap between arithmetic and decision-making.',
        optionNotes: [
          'Correct: you have compared two options out of three, so you know less than the conclusion suggests.',
          'It settles the comparison you performed, not the decision in front of you.',
          'Adjusting an estimate to support a conclusion inverts the whole method.',
          'Previous hands with these cards are irrelevant; the deck has no memory and neither should your reasoning.',
        ],
      },
    ],
    reviewAdvice:
      "Two ideas here do most of the work: folding is zero, and a decision is graded on its inputs rather than its result. If the negative answer in the second question felt strange, sit with it - being able to say 'on average this call loses chips, even though it sometimes wins the pot' is exactly the fluency you are building. Nothing here is scored, so the questions you hesitated on are the useful output.",
  },
  {
    id: 'quiz-fold-equity',
    title: 'Betting for two reasons',
    topic: 'fold-equity-and-bluffing',
    lessonId: 'fold-equity',
    questions: [
      {
        kind: 'multipleChoice',
        id: 'fold-equity-q1',
        prompt: 'What makes betting a semi-bluff different from calling with the same drawing hand?',
        options: [
          'The bet builds a bigger pot for when you hit',
          'The bet can win immediately when they fold, and can still win at showdown when they call',
          'The bet tells you where you stand',
          'The bet gives you better odds on your draw',
        ],
        correctIndex: 1,
        explanation:
          'Calling has one way to win: the better hand at the end. Betting has two, and they add together. That is why the same hand at the same price can be a poor call and a good bet.',
        optionNotes: [
          'A bigger pot is a real consequence and it cuts both ways, since you have put more in to build it.',
          'Correct: folds now plus equity later, which is a sum that calling can never collect.',
          'Information from a bet is expensive and often false, so it is a weak justification on its own.',
          'Betting does not improve the odds on your draw; the deck is unaffected by what you wager.',
        ],
      },
      {
        kind: 'numeric',
        id: 'fold-equity-q2',
        prompt:
          'The pot is 100 and you bet 50. Assume your opponent folds 50 times in 100, and that when they call, you end up with the pot 30 times in 100. Counting only chips won or lost from this point on, what is the expected value of the bet in chips?',
        calculation: {
          kind: 'foldEquity',
          pot: 100,
          betSize: 50,
          foldProbability: 0.5,
          equityWhenCalled: 0.3,
        },
        field: 'ev',
        unit: 'chips',
        tolerance: 6,
        explanation:
          'Split it into the two branches and weight them. When they fold, you collect the pot as it stands. When they call, you are playing a showdown for the pot plus their call, and losing your bet when you miss. Add the two branches in proportion to how often each happens. Treat the assumption that the hand ends here as part of the model: in a real hand there is another street, and it can cut either way.',
      },
      {
        kind: 'numeric',
        id: 'fold-equity-q3',
        prompt:
          'Identical spot and identical cards, but your opponent is far more stubborn: assume they now fold only 20 times in 100, with your equity when called unchanged. What is the expected value of the same bet in chips?',
        calculation: {
          kind: 'foldEquity',
          pot: 100,
          betSize: 50,
          foldProbability: 0.2,
          equityWhenCalled: 0.3,
        },
        field: 'ev',
        unit: 'chips',
        tolerance: 6,
        explanation:
          'The only input that changed is a claim about a person. Compute it and compare with your previous answer, then ask which of the two fold frequencies you could actually defend at a table - because that, and not the arithmetic, is where the uncertainty in this decision lives. Running the numbers twice like this is the honest way to handle an input you are guessing at.',
      },
      {
        kind: 'multipleChoice',
        id: 'fold-equity-q4',
        prompt:
          'You increase your bet size with a pure bluff. What happens to how often the bluff needs to work?',
        options: [
          'It needs to work less often, because the bet is scarier',
          'It needs to work more often, because you are risking more to win the same pot',
          'It is unchanged, because the pot is unchanged',
          'It depends only on your opponent',
        ],
        correctIndex: 1,
        explanation:
          'The break-even fold frequency is your bet divided by the pot plus your bet. Increasing the bet increases the numerator faster than it increases the pot you stand to win, so the required success rate rises. A bigger bluff may well get more folds in practice, but it also has to.',
        optionNotes: [
          'Larger bets may get more folds, but the question is how many folds are needed, and that requirement goes up.',
          'Correct: risking more for the same prize raises the frequency at which the bluff breaks even.',
          'The pot is unchanged, which is precisely why risking more changes the requirement.',
          'Your opponent determines how often they actually fold; the arithmetic determines how often they need to.',
        ],
      },
      {
        kind: 'multipleChoice',
        id: 'fold-equity-q5',
        prompt: 'Which input in a fold-equity calculation deserves the most scepticism?',
        options: [
          'The size of the pot',
          'The size of your bet',
          'How often your opponent folds',
          'The arithmetic of the formula',
        ],
        correctIndex: 2,
        explanation:
          'The pot is a fact and your bet is your own choice. Your equity when called is an estimate, but at least it is an estimate about cards. The fold frequency is a claim about how a particular person will respond to a particular bet, and there is no way to look it up. That is why the useful habit is to compute the decision twice, with a pessimistic and an optimistic figure, and see whether your conclusion survives both.',
        optionNotes: [
          'The pot is countable and not in dispute.',
          'Your bet is whatever you decide to make it.',
          'Correct: it is a guess about a human being, and it usually carries the whole conclusion.',
          'The arithmetic is the most reliable part; the inputs are where the risk is.',
        ],
      },
    ],
    reviewAdvice:
      'The pair of numeric questions is the point of this quiz: same cards, same size, different assumption about a person, and possibly a different conclusion. If that lands, you have the habit worth having - state the fold frequency you are assuming, out loud, and check whether your play still makes sense if you are wrong about it. Betting because a bet feels strong is the alternative, and it is much more expensive.',
  },
  {
    id: 'quiz-stack-to-pot-ratio',
    title: 'Depth changes the hand',
    topic: 'bet-sizing-and-spr',
    lessonId: 'stack-to-pot-ratio',
    questions: [
      {
        kind: 'multipleChoice',
        id: 'spr-q1',
        prompt:
          'You have 500 behind and your opponent has 120 behind. Which figure belongs in the stack-to-pot ratio?',
        options: ['500', '120', '620', 'The average of the two'],
        correctIndex: 1,
        explanation:
          'The effective stack is the smaller of the two, because neither player can win or lose more than the shorter stack holds. Your extra chips are not in play in this hand, however comforting they look.',
        optionNotes: [
          'Your own stack only matters up to what your opponent can match.',
          'Correct: the smaller stack is the effective one and the only one that can change hands.',
          'The total of both stacks is never at risk; each of you can only lose what you have.',
          'Averaging has no basis. The binding constraint is the smaller number.',
        ],
      },
      {
        kind: 'numeric',
        id: 'spr-q2',
        prompt:
          'You reach the flop with a pot of 20, and the shorter of the two stacks has 60 behind. What is the stack-to-pot ratio?',
        calculation: {
          kind: 'spr',
          effectiveStack: 60,
          pot: 20,
        },
        field: 'spr',
        unit: 'ratio',
        tolerance: 0.2,
        explanation:
          'Divide what is left behind by what is already in the middle. Then translate the answer into bets: roughly how many pot-sized bets fit into what remains? That translation is what makes the number useful, because it tells you how many real decisions are still ahead.',
      },
      {
        kind: 'numeric',
        id: 'spr-q3',
        prompt:
          'Same flop and the same pot of 20, but this time the shorter stack has 260 behind. What is the stack-to-pot ratio now?',
        calculation: {
          kind: 'spr',
          effectiveStack: 260,
          pot: 20,
        },
        field: 'spr',
        unit: 'ratio',
        tolerance: 0.5,
        explanation:
          'Compare with the previous answer, then ask what changes about a hand like top pair between the two. Nothing about the cards or the board differs; what differs is how many streets of pressure the hand has to survive and how large the eventual mistake can be. That is why stack depth belongs in any sentence about how strong a hand is.',
      },
      {
        kind: 'multipleChoice',
        id: 'spr-q4',
        prompt:
          'Assuming the stacks can realistically all go in, which type of hand gains the most as the stack-to-pot ratio rises?',
        options: [
          'Top pair with a weak kicker',
          'A hand that rarely makes something, but makes something enormous when it does',
          'Any two high cards',
          'Hands that are already the best hand on the flop',
        ],
        correctIndex: 1,
        explanation:
          'Deeper stacks mean a larger payoff when a hand does arrive, which is exactly what a hand with big implied odds needs: it must lose small most of the time and win large occasionally, and only a deep stack makes the large win possible. The stated assumption matters, though - if the money will never actually go in, the implied odds are imaginary.',
        optionNotes: [
          'Top pair with a weak kicker gets worse as depth rises, since it must survive more streets against a range that includes better versions of itself.',
          'Correct: a big payoff needs chips behind to be paid from.',
          'High cards without connectivity often make second-best hands, which is what deep stacks punish.',
          'Being best on the flop is worth most when the hand is nearly over, which is a low ratio, not a high one.',
        ],
      },
      {
        kind: 'multipleChoice',
        id: 'spr-q5',
        prompt: 'What mainly determines the stack-to-pot ratio you will play the flop with?',
        options: [
          'The board texture',
          'How large the preflop pot became relative to the stacks, which comes from raise sizes and the number of callers',
          'Who has position',
          'Whether anyone has a made hand',
        ],
        correctIndex: 1,
        explanation:
          'The ratio is arithmetic on the preflop pot and the remaining stacks, so it is decided by preflop raise sizing and by how many players came along. That makes it a choice rather than an accident: raise more and you are choosing a simpler, more committed postflop game, and keep the pot small and you are choosing one with more decisions left in it.',
        optionNotes: [
          'Texture changes how much your hand is worth on the flop, not how much money is behind.',
          'Correct: preflop pot size against stack size, which you influence directly.',
          'Position changes how you use the ratio, not what the ratio is.',
          'Made hands are unrelated to the arithmetic of chips behind versus chips in the middle.',
        ],
      },
    ],
    reviewAdvice:
      'The habit worth building is translating the ratio into bets: about one pot-sized bet left, or about four, or about twelve. That translation tells you what the hand is going to feel like before it happens. If the fourth question required a guess, revisit the deep-stack section of the lesson and pay attention to how the stated assumption - that the money can actually go in - carries the whole argument.',
  },
  {
    id: 'quiz-sample-size-and-risk-of-ruin',
    title: 'Samples, bankrolls and buffers',
    topic: 'variance-and-bankroll',
    lessonId: 'sample-size-and-risk-of-ruin',
    questions: [
      {
        kind: 'multipleChoice',
        id: 'ror-q1',
        prompt:
          'You want to halve the uncertainty around your measured win rate. Roughly how many more hands does that take?',
        options: ['Twice as many', 'Four times as many', 'Ten times as many', 'It cannot be reduced'],
        correctIndex: 1,
        explanation:
          "Uncertainty shrinks with the square root of the sample, so cutting it in half requires four times the hands, and dividing it by ten requires a hundred times as many. This is the arithmetic behind every honest statement about sample size, and it is why the answer to 'am I a winning player' is so often 'not enough hands yet'.",
        optionNotes: [
          'Twice the hands reduces uncertainty by a factor of about 1.4, not 2.',
          'Correct: the square root means halving the uncertainty costs a fourfold sample.',
          'Ten times the hands divides uncertainty by a bit over three, which is much better than halving and much more expensive.',
          'It does reduce, just slowly, which is a different and more frustrating problem than being impossible.',
        ],
      },
      {
        kind: 'numeric',
        id: 'ror-q2',
        prompt:
          "Using the standard risk-of-ruin model with a fixed win rate of 3 big blinds per 100 hands, a standard deviation of 90 big blinds per 100 hands, and a bankroll of 1000 big blinds played without ever changing stakes: what is the probability of losing the entire bankroll? Use the lesson's calculator if the exponential is awkward by hand.",
        calculation: {
          kind: 'riskOfRuin',
          bankrollBb: 1000,
          winRateBbPer100: 3,
          standardDeviationBbPer100: 90,
        },
        field: 'probability',
        unit: 'percent',
        tolerance: 5,
        explanation:
          'The model puts twice the win rate times the bankroll over the squared standard deviation into a negative exponential, so the whole answer turns on how the edge compares with the square of the swings. Before reading the result, guess whether a bankroll of that size sounds safe to you, then see what the model says. The gap between the two is the lesson. Remember that every assumption behind the formula - fixed edge, normal results, no stake changes, no tilt - pushes the real risk higher than the figure shown.',
      },
      {
        kind: 'numeric',
        id: 'ror-q3',
        prompt:
          'Same edge and same standard deviation, but with three times the bankroll: 3000 big blinds. What is the probability of ruin now?',
        calculation: {
          kind: 'riskOfRuin',
          bankrollBb: 3000,
          winRateBbPer100: 3,
          standardDeviationBbPer100: 90,
        },
        field: 'probability',
        unit: 'percent',
        tolerance: 3,
        explanation:
          'Bankroll sits in the exponent, so tripling it does not divide the risk by three - it does something considerably more dramatic. Compare with your previous answer, and note that tripling the win rate instead would have produced exactly the same figure, because bankroll and win rate enter the exponent in precisely the same way. One of those two is usually much easier to arrange than the other.',
      },
      {
        kind: 'multipleChoice',
        id: 'ror-q4',
        prompt:
          'In the risk-of-ruin formula, doubling which quantity has the largest effect on the answer, with the other two held fixed?',
        options: ['The bankroll', 'The win rate', 'The standard deviation', 'All three have equal effect'],
        correctIndex: 2,
        explanation:
          'Bankroll and win rate both appear linearly in the exponent, so doubling either has the same effect and both reduce risk. The standard deviation appears squared, so doubling it changes the exponent by a factor of four - and in the harmful direction. That is why choosing a lower-variance game can do more for survival than improving your edge, which is an unglamorous conclusion that most players would rather not reach.',
        optionNotes: [
          "Doubling the bankroll doubles the exponent's magnitude in the helpful direction, which is powerful but not the largest effect here.",
          'Doubling the win rate does exactly what doubling the bankroll does, no more.',
          'Correct: the standard deviation is squared, so it moves the exponent by a factor of four.',
          'They are not equal, and the inequality is the most useful fact in the formula.',
        ],
      },
      {
        kind: 'multipleChoice',
        id: 'ror-q5',
        prompt: 'Which statement about the risk-of-ruin model is honest?',
        options: [
          'It gives the probability that you will go broke',
          'It gives a probability under strong assumptions - fixed edge, normally distributed results, no change of stakes, no tilt, and playing for ever - each of which makes the real risk higher',
          'It proves that bankroll management is unnecessary with a big enough edge',
          'It applies only to tournaments',
        ],
        correctIndex: 1,
        explanation:
          "The model's value is in its shape rather than its decimals: risk falls exponentially with bankroll and edge, and rises with the square of the variance. Its assumptions are all optimistic ones, so treat the output as a lower bound on risk and a way of comparing scenarios, not as a forecast about you.",
        optionNotes: [
          'It gives a probability inside a model, which is a narrower and more useful claim.',
          'Correct: strong assumptions, all of them flattering.',
          'The formula says the opposite - the buffer is one of only two levers, and the more available one.',
          'The same arithmetic applies to any repeated wager with an edge and a spread, cards or otherwise.',
        ],
      },
    ],
    reviewAdvice:
      'The two numeric questions are meant to be run as a pair, because the interesting thing is not either figure but how much the second differs from the first. If the square-root rule for sample size and the squared standard deviation in the exponent both feel solid, you have the two facts that matter. And keep the framing in view: nothing here involves money, so this is a model of how edges and swings interact, which happens to describe a great many decisions that have nothing to do with cards.',
  },
];

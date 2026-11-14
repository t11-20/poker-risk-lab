/**
 * The whole curriculum as `LessonListResponse.lessons`. Two are marked `completed` so the index renders
 * both states; nothing else about progress is fabricated.
 * Copied verbatim from `packages/content/data`, with no computed figure: see `learn-glossary.ts`.
 */

import type { LessonSummary } from '@prl/contracts';

export const LEARN_LESSON_SUMMARIES: readonly LessonSummary[] = [
  {
    id: 'pot-odds',
    title: 'Pot odds: the price the pot is offering',
    summary:
      'A bet turns the pot into a price, and break-even equity is that same price rewritten as the share of the time you need to end up with the pot.',
    topic: 'pot-odds-and-ev',
    difficulty: 'core',
    estimatedMinutes: 10,
    prerequisites: ['betting-actions', 'counting-outs'],
    quizId: 'quiz-pot-odds',
    completed: false,
  },
  {
    id: 'expected-value',
    title: 'Expected value: what a decision is worth',
    summary:
      'EV is the average result of a decision repeated for ever, computed per decision rather than per hand, which is why a hand that is losing can still be a call worth making.',
    topic: 'pot-odds-and-ev',
    difficulty: 'core',
    estimatedMinutes: 11,
    prerequisites: ['pot-odds'],
    quizId: 'quiz-expected-value',
    completed: false,
  },
  {
    id: 'fold-equity',
    title: 'Fold equity: a bet that can win twice',
    summary:
      'Betting can profit two different ways - they fold now, or you improve later - and a semi-bluff is the hand that collects from both at once.',
    topic: 'fold-equity-and-bluffing',
    difficulty: 'core',
    estimatedMinutes: 11,
    prerequisites: ['pot-odds', 'expected-value'],
    quizId: 'quiz-fold-equity',
    completed: false,
  },
  {
    id: 'bet-sizing',
    title: 'Bet sizing: what a size is trying to do',
    summary:
      'A size is a plan expressed in chips: it sets the price your opponent is offered, how often a bluff must work, and how big the pot will be on the next street.',
    topic: 'bet-sizing-and-spr',
    difficulty: 'core',
    estimatedMinutes: 11,
    prerequisites: ['pot-odds', 'fold-equity'],
    quizId: 'quiz-bet-sizing',
    completed: false,
  },
  {
    id: 'stack-to-pot-ratio',
    title: 'Stack-to-pot ratio: why depth changes the hand',
    summary:
      'The same cards on the same board play completely differently depending on how much is behind relative to the pot, and preflop sizing is what chooses that ratio.',
    topic: 'bet-sizing-and-spr',
    difficulty: 'core',
    estimatedMinutes: 10,
    prerequisites: ['bet-sizing'],
    quizId: 'quiz-stack-to-pot-ratio',
    completed: false,
  },
  {
    id: 'ranges-and-combos',
    title: 'Ranges: what they can have, not what they have',
    summary:
      'Replace guessing at one holding with counting all the holdings consistent with the action, and see how your own cards change those counts.',
    topic: 'ranges',
    difficulty: 'advanced',
    estimatedMinutes: 12,
    prerequisites: ['reading-the-board', 'expected-value'],
    quizId: 'quiz-ranges-and-combos',
    completed: false,
  },
  {
    id: 'variance',
    title: 'Variance: when a correct decision loses',
    summary:
      'Why good decisions lose often, what a downswing actually is, and the only reliable way to tell a broken process from an unlucky one.',
    topic: 'variance-and-bankroll',
    difficulty: 'core',
    estimatedMinutes: 12,
    prerequisites: ['expected-value'],
    quizId: 'quiz-variance',
    completed: false,
  },
  {
    id: 'sample-size-and-risk-of-ruin',
    title: 'Sample size and risk of ruin',
    summary:
      'How many hands it takes before results mean anything, and how bankroll, edge and variance combine to decide whether a bad stretch ends the experiment.',
    topic: 'variance-and-bankroll',
    difficulty: 'advanced',
    estimatedMinutes: 12,
    prerequisites: ['variance'],
    quizId: 'quiz-sample-size-and-risk-of-ruin',
    completed: false,
  },
  {
    id: 'tournament-chips-and-icm',
    title: 'Tournaments: chips stop being units of value',
    summary:
      'Once a payout schedule exists, chips convert to prize equity along a curve rather than a line, and that single fact reshapes stack depth, pressure and short-stack play.',
    topic: 'tournaments',
    difficulty: 'advanced',
    estimatedMinutes: 12,
    prerequisites: ['expected-value', 'stack-to-pot-ratio'],
    quizId: 'quiz-tournament-chips-and-icm',
    completed: false,
  },
  {
    id: 'hand-flow',
    title: "How a hand of Hold'em runs",
    summary:
      'Follow one hand from the posted blinds to the showdown: what gets dealt, who acts when, and the four chances to bet.',
    topic: 'rules-and-flow',
    difficulty: 'intro',
    estimatedMinutes: 8,
    prerequisites: [],
    quizId: 'quiz-hand-flow',
    completed: true,
  },
  {
    id: 'betting-actions',
    title: 'Actions, and what each one commits you to',
    summary:
      'Check, call, bet, raise, fold and all-in — what each one costs, the minimum-raise rule, and why every raise should be stated as a total.',
    topic: 'rules-and-flow',
    difficulty: 'intro',
    estimatedMinutes: 9,
    prerequisites: ['hand-flow'],
    quizId: 'quiz-betting-actions',
    completed: true,
  },
  {
    id: 'all-ins-and-side-pots',
    title: 'All-ins and side pots',
    summary:
      "Why a short stack can never win more than it risked, how pot layers are built from each player's commitment, and the all-in that does not reopen the betting.",
    topic: 'rules-and-flow',
    difficulty: 'core',
    estimatedMinutes: 10,
    prerequisites: ['hand-flow', 'betting-actions'],
    quizId: 'quiz-all-ins-and-side-pots',
    completed: false,
  },
  {
    id: 'position-basics',
    title: 'Position: the value of acting last',
    summary:
      'Position is a count of how many players act after you — and it changes what a hand is worth without changing what the cards are worth.',
    topic: 'positions-and-blinds',
    difficulty: 'intro',
    estimatedMinutes: 9,
    prerequisites: ['hand-flow'],
    quizId: 'quiz-position-basics',
    completed: false,
  },
  {
    id: 'blinds-and-the-option',
    title: 'Blinds, the option, and the heads-up reversal',
    summary:
      'What the blinds actually buy, why the big blind still has an action left, and the rule inversion that catches almost everybody heads-up.',
    topic: 'positions-and-blinds',
    difficulty: 'core',
    estimatedMinutes: 9,
    prerequisites: ['hand-flow', 'position-basics'],
    quizId: 'quiz-blinds-and-the-option',
    completed: false,
  },
  {
    id: 'reading-the-board',
    title: 'Reading the board',
    summary:
      'How to find your actual best five cards, what beats what, and the traps that make a strong-looking hand worth nothing.',
    topic: 'hand-reading-and-outs',
    difficulty: 'intro',
    estimatedMinutes: 11,
    prerequisites: ['hand-flow'],
    quizId: 'quiz-reading-the-board',
    completed: false,
  },
  {
    id: 'counting-outs',
    title: 'Outs: clean, dirty and imaginary',
    summary:
      'Counting the cards that improve you, and the difference between an out that wins the pot and one that merely improves your hand.',
    topic: 'hand-reading-and-outs',
    difficulty: 'core',
    estimatedMinutes: 12,
    prerequisites: ['reading-the-board'],
    quizId: 'quiz-counting-outs',
    completed: false,
  },
  {
    id: 'rule-of-2-and-4',
    title: 'The rule of 2 and 4',
    summary:
      'The table-friendly shortcut from outs to a percentage: what it approximates, why it works, and where it drifts.',
    topic: 'probability-and-equity',
    difficulty: 'core',
    estimatedMinutes: 10,
    prerequisites: ['counting-outs'],
    quizId: 'quiz-rule-of-2-and-4',
    completed: false,
  },
];

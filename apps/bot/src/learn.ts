/**
 * The learning half's figures: what a lesson's live calculation shows, what a numeric answer is
 * checked against, how close it has to be, and what a decision question's spot computes to.
 *
 * Content comes only from `@prl/content`, which validates it at load. Every number here is
 * computed from the situation a question stores (ADR 0006); nothing in this file or in the content
 * is an answer to read off.
 *
 * ## What is duplicated, and from where
 *
 * An app must not depend on an app (ADR 0014), so three pieces are copied with their originals
 * named beside them. The grading rule is not one of them: `withinTolerance` is `@prl/contracts`'s,
 * the same function the API grades a web reader's answer with.
 *
 *
 *   - the field table a numeric question's `field` is read from: `potOddsFields` through
 *     `outsFields`, `closedFormTable` and `expectedValueFor` in `apps/api/src/routes/content.ts`.
 *     The API's copy is the one that grades a web reader's answer, so it is the one to agree with.
 *     The web's own `computeCalculation` (`apps/web/src/lib/learn-calculations.ts`) cannot be the
 *     source: it imports runtime values from `@prl/ui`, which is React.
 *   - the equity spec for a calculation: `equitySpec` in `apps/web/src/lib/learn-calculations.ts`,
 *     every opponent an exact holding. All three equity questions name a flop and exact cards, so
 *     `equity()` enumerates exactly and needs no sampling or worker. Every lesson's opponents are
 *     exact holdings too; three are preflop, and enumerate 1.4 to 1.7 million run-outs exactly,
 *     measured at 285 to 334 ms each on first use, once per process (`calculate` caches).
 *   - the unit words and the decimals: `apps/web/src/lib/quiz-tolerance.ts`.
 */

import { analyseScenario, quizzes, type ScenarioAnalysis, scenarioById } from '@prl/content';
import {
  type LiveCalculation,
  type Quiz,
  type QuizQuestion,
  type RangeSpec,
  TOPICS,
  type Topic,
} from '@prl/contracts';
import { parseCards } from '@prl/poker-engine';
import {
  computeOuts,
  equity,
  evOfCall,
  evOfSemiBluff,
  exactRange,
  icmEquity,
  potOdds,
  probabilityOfHitting,
  projectResults,
  riskOfRuin,
  ruleOf24,
  stackToPotRatio,
} from '@prl/poker-math';

export type NumericQuestion = Extract<QuizQuestion, { kind: 'numeric' }>;
export type DecisionQuestion = Extract<QuizQuestion, { kind: 'decision' }>;
export type QuizUnit = NumericQuestion['unit'];

// ---------------------------------------------------------------------------
// Topics and quizzes
// ---------------------------------------------------------------------------

/** `TOPIC_LABELS` in `apps/web/src/lib/lab-labels.ts`, which says why a slug transform cannot work. */
const TOPIC_LABELS: Readonly<Record<Topic, string>> = {
  'rules-and-flow': 'Rules and flow',
  'positions-and-blinds': 'Positions and blinds',
  'hand-reading-and-outs': 'Hand reading and outs',
  'probability-and-equity': 'Probability and equity',
  'pot-odds-and-ev': 'Pot odds and EV',
  'bet-sizing-and-spr': 'Bet sizing and SPR',
  'fold-equity-and-bluffing': 'Fold equity and bluffing',
  ranges: 'Ranges',
  'variance-and-bankroll': 'Variance and bankroll',
  tournaments: 'Tournaments',
  'risk-psychology': 'Risk psychology',
};

export function topicLabel(topic: Topic): string {
  return TOPIC_LABELS[topic];
}

/** Topics that have at least one quiz, in the syllabus order `TOPICS` declares. */
export function quizTopics(): readonly Topic[] {
  return TOPICS.filter((topic) => quizzes().some((quiz) => quiz.topic === topic));
}

export function quizzesIn(topic: Topic): readonly Quiz[] {
  return quizzes().filter((quiz) => quiz.topic === topic);
}

export function isTopic(value: string): value is Topic {
  return (TOPICS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Calculations: one computation for a lesson's figures and a quiz's target
// ---------------------------------------------------------------------------

export interface Figure {
  readonly label: string;
  readonly value: number;
  /** The unit a numeric question asking for this field must declare. Grading only. */
  readonly unit: QuizUnit;
  /**
   * What follows the number when a reader is shown it, where the grading unit's own word would be
   * false: an expected result in big blinds is graded as `chips` and would print as "units", a
   * multiplier is a `count` and would print as "4 cards". Empty for a bare number.
   */
  readonly words?: string;
  /** A parameter the content stated rather than a result. The caption already says it. */
  readonly input?: true;
}

/**
 * A calculation's figures, how they were obtained, and the arithmetic in words.
 *
 * The web computes a lesson's figure and a quiz's target with one function so that a quiz cannot
 * mark a reader wrong for following the lesson (`learn-calculations.ts`, "That is not
 * code-sharing for tidiness"). This is that function here. A quiz field reads one figure; a lesson
 * shows all of them, which is why some kinds carry figures the API's table does not have (every
 * player's equity, the exact figure beside the rule of 2 and 4, the bounds of the 95% interval):
 * the captions ask the reader to look at those numbers.
 */
export interface Calculation {
  /** One sentence: exact or approximate, and how much work it took. A sampled figure's interval. */
  readonly method: string;
  readonly working: string;
  readonly figures: Readonly<Record<string, Figure>>;
}

export interface Expected {
  /** The target, in the question's own unit. */
  readonly value: number;
  readonly unit: QuizUnit;
  readonly tolerance: number;
  /** The arithmetic in words, from the maths package, and the method. */
  readonly working: string;
}

/** A fraction in 0..1 as percentage POINTS, which is how a learner answers. */
function asPercent(fraction: number): number {
  return fraction * 100;
}

function exactCards(text: string): ReturnType<typeof exactRange> {
  return exactRange(parseCards(text));
}

const ARITHMETIC = 'Exact arithmetic: nothing is sampled or estimated.';
const CLOSED_FORM = 'Closed form: exact given the inputs, and the inputs are assumptions.';

/** One card to come is the turn, with 46 cards unseen; two is the flop, with 47. */
const UNSEEN_BY_CARDS_TO_COME = { 1: 46, 2: 47 } as const;

function compute(calculation: LiveCalculation): Calculation {
  switch (calculation.kind) {
    case 'potOdds': {
      const odds = potOdds(calculation.pot, calculation.toCall);
      return {
        method: ARITHMETIC,
        working: odds.explanation,
        figures: {
          breakEvenEquity: {
            label: 'Break-even equity',
            value: asPercent(odds.breakEvenEquity),
            unit: 'percent',
          },
          // No "X to 1" exists for a free call, so the field is absent and a question asking for
          // it fails at `expectedAnswer`, not by grading a reader against a 0.
          ...(odds.oddsRatio === null
            ? {}
            : { oddsRatio: { label: 'Price offered', value: odds.oddsRatio, unit: 'ratio' as const } }),
          pot: { label: 'Pot before the call', value: odds.pot, unit: 'chips', input: true },
          toCall: { label: 'Cost to call', value: odds.toCall, unit: 'chips', input: true },
        },
      };
    }
    case 'ruleOf24': {
      const estimate = ruleOf24(calculation.outs, calculation.cardsToCome);
      const unseen = UNSEEN_BY_CARDS_TO_COME[calculation.cardsToCome];
      const hit = probabilityOfHitting(calculation.outs, unseen, calculation.cardsToCome);
      return {
        method:
          'The estimate is a mental shortcut, multiplication rather than probability. The exact ' +
          `figure beside it is counted from the ${unseen} unseen cards.`,
        working: `${estimate.explanation} ${estimate.caveat} ${hit.derivation}`,
        figures: {
          // Already in percentage points: scaling it again would turn 36% into 3,600%.
          estimatePercent: {
            label: 'Rule-of-thumb estimate',
            value: estimate.estimatePercent,
            unit: 'percent',
          },
          exactPercent: {
            label: `Exact chance of hitting, from ${unseen} unseen cards`,
            value: asPercent(hit.probability),
            unit: 'percent',
          },
          multiplier: {
            label: 'Multiplier per out',
            value: estimate.multiplier,
            unit: 'count',
            words: '',
            input: true,
          },
        },
      };
    }
    case 'callEv': {
      const call = evOfCall({ pot: calculation.pot, toCall: calculation.toCall, equity: calculation.equity });
      return {
        method: 'Exact arithmetic on an equity that is assumed, not measured.',
        working: call.derivation,
        figures: { ev: { label: 'EV of calling, against 0 for folding', value: call.ev, unit: 'chips' } },
      };
    }
    case 'foldEquity': {
      const bet = evOfSemiBluff({
        pot: calculation.pot,
        betSize: calculation.betSize,
        foldProbability: calculation.foldProbability,
        equityWhenCalled: calculation.equityWhenCalled,
      });
      return {
        method: 'Exact arithmetic on two probabilities that are forecasts about a person.',
        working: bet.derivation,
        figures: {
          ev: { label: 'EV of betting', value: bet.ev, unit: 'chips' },
          foldEquityShare: {
            label: 'Of which, from them folding',
            value: bet.foldEquityShare,
            unit: 'chips',
          },
          showdownShare: { label: 'Of which, from showdowns', value: bet.showdownShare, unit: 'chips' },
        },
      };
    }
    case 'icm': {
      const result = icmEquity(calculation.stacks, calculation.payouts);
      const pool = result.totalPrizePool;
      const shareOf = (index: number): number =>
        pool === 0 ? 0 : asPercent((result.equities[index] ?? 0) / pool);
      const label = (index: number): string =>
        `Prize share of the stack of ${(calculation.stacks[index] ?? 0).toLocaleString('en-US')}`;
      const others = Object.fromEntries(
        result.equities
          .slice(1)
          .map((_, offset) => [
            `prizeShare${offset + 1}`,
            { label: label(offset + 1), value: shareOf(offset + 1), unit: 'percent' as const },
          ]),
      );
      return {
        method: `${CLOSED_FORM} Malmuth–Harville.`,
        working: result.explanation,
        figures: {
          // The API's name for the first stack's share, which in every shipped situation is the
          // largest. A quiz question reads it by this name.
          chipLeaderShare: { label: label(0), value: shareOf(0), unit: 'percent' },
          ...others,
        },
      };
    }
    case 'spr': {
      const spr = stackToPotRatio(calculation.effectiveStack, calculation.pot);
      return {
        method: ARITHMETIC,
        working: `${spr.explanation} ${spr.implication}`,
        figures: {
          spr: {
            label: `Stack-to-pot ratio (${spr.band.replace('-', ' ')})`,
            value: spr.spr,
            unit: 'ratio',
            words: '',
          },
          effectiveStack: { label: 'Effective stack', value: spr.effectiveStack, unit: 'chips', input: true },
        },
      };
    }
    case 'variance': {
      const projection = projectResults({
        hands: calculation.hands,
        winRateBbPer100: calculation.winRateBbPer100,
        standardDeviationBbPer100: calculation.standardDeviationBbPer100,
      });
      const bb = 'big blinds';
      return {
        method: 'Normal approximation: a sum of many independent hands is close to normally distributed.',
        working: projection.explanation,
        figures: {
          probabilityOfLoss: {
            label: 'Chance of being down after all of them',
            value: asPercent(projection.probabilityOfLoss),
            unit: 'percent',
          },
          expectedBb: { label: 'Expected result', value: projection.expectedBb, unit: 'chips', words: bb },
          standardDeviationBb: {
            label: 'Standard deviation over the sample',
            value: projection.standardDeviationBb,
            unit: 'chips',
            words: bb,
          },
          lowerBb: {
            label: 'Middle 95% of outcomes, low end',
            value: projection.interval95.lowerBb,
            unit: 'chips',
            words: bb,
          },
          upperBb: {
            label: 'Middle 95% of outcomes, high end',
            value: projection.interval95.upperBb,
            unit: 'chips',
            words: bb,
          },
        },
      };
    }
    case 'riskOfRuin': {
      const ruin = riskOfRuin({
        bankrollBb: calculation.bankrollBb,
        winRateBbPer100: calculation.winRateBbPer100,
        standardDeviationBbPer100: calculation.standardDeviationBbPer100,
      });
      return {
        method: CLOSED_FORM,
        working: `${ruin.formula} ${ruin.explanation}`,
        figures: {
          probability: { label: 'Risk of ruin', value: asPercent(ruin.probability), unit: 'percent' },
        },
      };
    }
    case 'outs': {
      // The web refuses an outs breakdown with no opponent holding, and so does this: "how many
      // outs" has no answer without saying what hero is trying to beat.
      if (calculation.opponentCards === undefined) {
        throw new Error('an outs calculation needs the opponent holding it is counted against');
      }
      const outs = computeOuts({
        heroCards: parseCards(calculation.heroCards),
        board: parseCards(calculation.board),
        opponent: exactCards(calculation.opponentCards),
      });
      return {
        method: `Exact, card by card: each of the ${outs.cardsConsidered} unseen cards was dealt in turn.`,
        working: `${outs.explanation} ${outs.assumptions.join(' ')}`,
        figures: {
          cleanCount: { label: 'Clean outs', value: outs.cleanCount, unit: 'count' },
          dirtyCount: { label: 'Dirty outs', value: outs.dirtyCount, unit: 'count' },
          totalOuts: { label: 'Cards counted', value: outs.totalOuts, unit: 'count' },
          equityNow: { label: 'Equity as things stand', value: asPercent(outs.equityNow), unit: 'percent' },
        },
      };
    }
    case 'equity': {
      const result = equity({
        players: [
          { label: 'you', range: exactCards(calculation.heroCards) },
          ...calculation.opponents.map((cards, index) => ({
            label: calculation.opponents.length === 1 ? 'opponent' : `opponent ${index + 1}`,
            range: exactCards(cards),
          })),
        ],
        board: calculation.board === undefined ? [] : parseCards(calculation.board),
      });
      const [hero, ...opponents] = result.players;
      if (hero === undefined) throw new Error('an equity result with no players');
      // A sampled figure always carries its interval, `equity.ts`'s own rule: the
      // bare percentage reads as exact, and at 100,000 run-outs it is not.
      const method =
        result.method === 'exact-enumeration'
          ? `Exact: every one of ${result.trials.toLocaleString('en-US')} run-outs was played out.`
          : `Sampled: ${result.trials.toLocaleString('en-US')} random run-outs from a fixed seed` +
            (result.confidence === null
              ? '.'
              : `, ±${result.confidence.halfWidthPoints.toFixed(1)} points on your equity at 95%.`);
      return {
        method,
        working: result.assumptions.join(' '),
        figures: {
          heroEquity: { label: 'Your equity', value: asPercent(hero.equity), unit: 'percent' },
          heroWin: { label: 'You win outright', value: asPercent(hero.win), unit: 'percent' },
          heroTie: { label: 'You split the pot', value: asPercent(hero.tie), unit: 'percent' },
          ...Object.fromEntries(
            opponents.map((player, index) => [
              `opponentEquity${index + 1}`,
              {
                label: `Equity of ${calculation.opponents[index] ?? player.label}`,
                value: asPercent(player.equity),
                unit: 'percent' as const,
              },
            ]),
          ),
        },
      };
    }
    default: {
      const unreachable: never = calculation;
      return unreachable;
    }
  }
}

const calculationCache = new Map<string, Calculation>();

/**
 * The calculation's figures, computed once per process: the content does not change while it
 * runs, and a preflop equity enumerates 1.7 million run-outs.
 */
export function calculate(calculation: LiveCalculation): Calculation {
  const key = JSON.stringify(calculation);
  const cached = calculationCache.get(key);
  if (cached !== undefined) return cached;
  const computed = compute(calculation);
  calculationCache.set(key, computed);
  return computed;
}

/**
 * The figure a numeric answer is checked against, computed from the question's calculation.
 *
 * Throws on the two content bugs the API also refuses: a field the calculation does not produce,
 * and a unit that disagrees with the field's. The second is the one that would mark every reader
 * wrong: a `percent` question over a fraction accepts 0.333 and refuses 33.3.
 */
export function expectedAnswer(question: NumericQuestion): Expected {
  const computed = calculate(question.calculation);
  const field = computed.figures[question.field];
  if (field === undefined) {
    throw new Error(
      `quiz question ${question.id} asks for "${question.field}" of a ${question.calculation.kind} ` +
        `calculation, which produces: ${Object.keys(computed.figures).join(', ')}`,
    );
  }
  if (field.unit !== question.unit) {
    throw new Error(
      `quiz question ${question.id} declares unit "${question.unit}" but "${question.field}" is in "${field.unit}"`,
    );
  }
  return {
    value: field.value,
    unit: question.unit,
    tolerance: question.tolerance,
    working: `${computed.working} ${computed.method}`,
  };
}

/** A figure as a lesson shows it: `Break-even equity: 33.3%`, `Expected result: 500.0 big blinds`. */
export function figureLine(figure: Figure): string {
  if (figure.words === undefined) return `${figure.label}: ${figureText(figure.value, figure.unit)}`;
  const number = figure.value.toLocaleString('en-US', {
    minimumFractionDigits: UNIT_DECIMALS[figure.unit],
    maximumFractionDigits: UNIT_DECIMALS[figure.unit],
  });
  return `${figure.label}: ${figure.words === '' ? number : `${number} ${figure.words}`}`;
}

/** `QUIZ_UNIT_WORDS` in `apps/web/src/lib/quiz-tolerance.ts`. */
const UNIT_WORDS: Readonly<Record<QuizUnit, string>> = {
  percent: '%',
  chips: 'units',
  ratio: 'to 1',
  count: 'cards',
  hands: 'hands',
};

/** `QUIZ_UNIT_DECIMALS` in the same file: how many decimals a FIGURE in this unit is worth. */
const UNIT_DECIMALS: Readonly<Record<QuizUnit, number>> = {
  percent: 1,
  chips: 1,
  ratio: 1,
  count: 0,
  hands: 0,
};

/** `toleranceDecimals` in the same file: a tolerance is often a fraction of its unit's step. */
function toleranceDecimals(tolerance: number, unitDecimals: number): number {
  const scaled = Math.abs(tolerance) * 10 ** unitDecimals;
  if (!Number.isFinite(scaled)) return unitDecimals;
  return Number.isInteger(Math.round(scaled * 1e6) / 1e6) ? unitDecimals : unitDecimals + 1;
}

/** `33.3%`, `2.0 to 1`, `12.5 units`, `9 cards`. */
export function figureText(value: number, unit: QuizUnit, decimals = UNIT_DECIMALS[unit]): string {
  const number = value.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return unit === 'percent' ? `${number}%` : `${number} ${UNIT_WORDS[unit]}`;
}

/**
 * The tolerance as a reader is told it, at enough decimals to be true: `counting-outs-q4` declares
 * 0.5 cards, and at the unit's own zero decimals that would print "1 cards", which is twice the band
 * the grader applies. The defect `apps/web/src/lib/quiz-tolerance.ts` exists for.
 */
export function toleranceText(tolerance: number, unit: QuizUnit): string {
  return figureText(tolerance, unit, toleranceDecimals(tolerance, UNIT_DECIMALS[unit]));
}

/**
 * A typed number, or null for anything that is not plainly one.
 *
 * Accepts `33.3`, `-12`, `.5`, `1,200`, and a trailing unit a reader might add (`33.3%`, `2.5 to 1`,
 * `9 cards`). Refuses everything else rather than pulling a number out of a sentence: "about 30,
 * maybe 35" is not an answer of 30.
 */
export function parseNumber(text: string): number | null {
  const match =
    /^\s*([+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|[+-]?\.\d+)\s*(?:%|units?|to 1|:1|cards?|hands?|bb)?\s*$/i.exec(
      text,
    );
  if (match === null) return null;
  const value = Number((match[1] ?? '').replace(/,/g, ''));
  return Number.isFinite(value) ? value : null;
}

// ---------------------------------------------------------------------------
// Decision questions
// ---------------------------------------------------------------------------

/**
 * The two actions a decision question offers. Both shipped decision questions ask "call or fold"
 * of a spot with a price, and the analysis prices exactly those two. A raise would need a size,
 * and the API refuses to grade a size its analysis did not price, so none is offered.
 */
export const DECISION_ACTIONS = ['fold', 'call'] as const;
export type DecisionAction = (typeof DECISION_ACTIONS)[number];

export interface DecisionSpot {
  readonly facingAction: string;
  /** The opponent range as the scenario states it: the assumption every figure rests on. */
  readonly range: string;
  readonly analysis: ScenarioAnalysis;
  readonly assumptions: readonly string[];
}

function rangeText(range: RangeSpec): string {
  if (range.kind === 'exact') return `exactly ${range.cards}`;
  if (range.kind === 'notation') return `${range.label} (${range.notation})`;
  return range.label;
}

const spotCache = new Map<string, DecisionSpot>();

/** The scenario a decision question points at, computed. Measured at 2 and 4 ms, exact. */
export function decisionSpot(question: DecisionQuestion): DecisionSpot {
  const cached = spotCache.get(question.scenarioId);
  if (cached !== undefined) return cached;
  const scenario = scenarioById(question.scenarioId);
  if (scenario === null) {
    throw new Error(`quiz question ${question.id} points at missing scenario ${question.scenarioId}`);
  }
  if (scenario.toCall <= 0) {
    throw new Error(
      `quiz question ${question.id} is a decision with nothing to call; this client offers fold or call`,
    );
  }
  const spot = {
    facingAction: scenario.facingAction,
    range: rangeText(scenario.opponentRange),
    analysis: analyseScenario(scenario),
    assumptions: scenario.assumptions,
  };
  spotCache.set(question.scenarioId, spot);
  return spot;
}

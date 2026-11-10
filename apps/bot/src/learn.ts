/**
 * The learning half's figures: what a numeric answer is checked against, how close it has to be,
 * and what a decision question's spot computes to.
 *
 * Content comes only from `@prl/content`, which validates it at load. Every number here is
 * computed from the situation a question stores (ADR 0006); nothing in this file or in the content
 * is an answer to read off.
 *
 * ## What is duplicated, and from where
 *
 * An app must not depend on an app (ADR 0014), so three pieces are copied with their originals
 * named beside them:
 *
 *   - the field table a numeric question's `field` is read from: `potOddsFields` through
 *     `outsFields`, `closedFormTable` and `expectedValueFor` in `apps/api/src/routes/content.ts`.
 *     The API's copy is the one that grades a web reader's answer, so it is the one to agree with.
 *     The web's own `computeCalculation` (`apps/web/src/lib/learn-calculations.ts`) cannot be the
 *     source: it imports runtime values from `@prl/ui`, which is React.
 *   - the equity spec for a calculation: `equitySpec` in `apps/web/src/lib/learn-calculations.ts`,
 *     every opponent an exact holding. All three equity questions name a flop and exact cards, so
 *     `equity()` enumerates exactly and needs no sampling or worker.
 *   - the tolerance rule, the unit words and the decimals: `apps/web/src/lib/quiz-tolerance.ts`.
 *     The web's rule rather than the API's: the API compares `Math.abs(answer - value) <= tolerance`,
 *     which that file documents as refusing an answer at exactly the stated tolerance for some
 *     magnitudes (`|3.2 − 3.0| = 0.20000000000000018`).
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
// Numeric answers
// ---------------------------------------------------------------------------

export interface Expected {
  /** The target, in the question's own unit. */
  readonly value: number;
  readonly unit: QuizUnit;
  readonly tolerance: number;
  /** The arithmetic in words, from the maths package. */
  readonly working: string;
}

interface FieldTable {
  readonly working: string;
  readonly fields: Readonly<Record<string, { readonly value: number; readonly unit: QuizUnit }>>;
}

/** A fraction in 0..1 as percentage POINTS, which is how a learner answers. */
function asPercent(fraction: number): number {
  return fraction * 100;
}

function exactCards(text: string): ReturnType<typeof exactRange> {
  return exactRange(parseCards(text));
}

function fieldTable(calculation: LiveCalculation): FieldTable {
  switch (calculation.kind) {
    case 'potOdds': {
      const odds = potOdds(calculation.pot, calculation.toCall);
      return {
        working: odds.explanation,
        fields: {
          breakEvenEquity: { value: asPercent(odds.breakEvenEquity), unit: 'percent' },
          // No "X to 1" exists for a free call, so the field is absent and a question asking for
          // it fails at `expectedAnswer`, not by grading a reader against a 0.
          ...(odds.oddsRatio === null
            ? {}
            : { oddsRatio: { value: odds.oddsRatio, unit: 'ratio' as const } }),
          pot: { value: odds.pot, unit: 'chips' },
          toCall: { value: odds.toCall, unit: 'chips' },
        },
      };
    }
    case 'ruleOf24': {
      const estimate = ruleOf24(calculation.outs, calculation.cardsToCome);
      return {
        working: `${estimate.explanation} ${estimate.caveat}`,
        fields: {
          // Already in percentage points: scaling it again would turn 36% into 3,600%.
          estimatePercent: { value: estimate.estimatePercent, unit: 'percent' },
          multiplier: { value: estimate.multiplier, unit: 'count' },
        },
      };
    }
    case 'callEv': {
      const call = evOfCall({ pot: calculation.pot, toCall: calculation.toCall, equity: calculation.equity });
      return { working: call.derivation, fields: { ev: { value: call.ev, unit: 'chips' } } };
    }
    case 'foldEquity': {
      const bet = evOfSemiBluff({
        pot: calculation.pot,
        betSize: calculation.betSize,
        foldProbability: calculation.foldProbability,
        equityWhenCalled: calculation.equityWhenCalled,
      });
      return {
        working: bet.derivation,
        fields: {
          ev: { value: bet.ev, unit: 'chips' },
          foldEquityShare: { value: bet.foldEquityShare, unit: 'chips' },
          showdownShare: { value: bet.showdownShare, unit: 'chips' },
        },
      };
    }
    case 'icm': {
      const result = icmEquity(calculation.stacks, calculation.payouts);
      const pool = result.totalPrizePool;
      const share = pool === 0 ? 0 : (result.equities[0] ?? 0) / pool;
      return {
        working: result.explanation,
        fields: { chipLeaderShare: { value: asPercent(share), unit: 'percent' } },
      };
    }
    case 'spr': {
      const spr = stackToPotRatio(calculation.effectiveStack, calculation.pot);
      return {
        working: `${spr.explanation} ${spr.implication}`,
        fields: {
          spr: { value: spr.spr, unit: 'ratio' },
          effectiveStack: { value: spr.effectiveStack, unit: 'chips' },
        },
      };
    }
    case 'variance': {
      const projection = projectResults({
        hands: calculation.hands,
        winRateBbPer100: calculation.winRateBbPer100,
        standardDeviationBbPer100: calculation.standardDeviationBbPer100,
      });
      return {
        working: projection.explanation,
        fields: {
          probabilityOfLoss: { value: asPercent(projection.probabilityOfLoss), unit: 'percent' },
          standardDeviationBb: { value: projection.standardDeviationBb, unit: 'chips' },
          expectedBb: { value: projection.expectedBb, unit: 'chips' },
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
        working: `${ruin.formula} ${ruin.explanation}`,
        fields: { probability: { value: asPercent(ruin.probability), unit: 'percent' } },
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
        working: `${outs.explanation} ${outs.assumptions.join(' ')}`,
        fields: {
          cleanCount: { value: outs.cleanCount, unit: 'count' },
          dirtyCount: { value: outs.dirtyCount, unit: 'count' },
          totalOuts: { value: outs.totalOuts, unit: 'count' },
          equityNow: { value: asPercent(outs.equityNow), unit: 'percent' },
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
      const hero = result.players[0];
      if (hero === undefined) throw new Error('an equity result with no players');
      const method =
        result.method === 'exact-enumeration'
          ? `Exact: every one of ${result.trials.toLocaleString('en-US')} run-outs was played out.`
          : `Sampled: ${result.trials.toLocaleString('en-US')} random run-outs from a fixed seed.`;
      return {
        working: `${result.assumptions.join(' ')} ${method}`,
        fields: { heroEquity: { value: asPercent(hero.equity), unit: 'percent' } },
      };
    }
    default: {
      const unreachable: never = calculation;
      return unreachable;
    }
  }
}

const expectedCache = new Map<string, Expected>();

/**
 * The figure a numeric answer is checked against, computed from the question's calculation.
 *
 * Throws on the two content bugs the API also refuses: a field the calculation does not produce,
 * and a unit that disagrees with the field's. The second is the one that would mark every reader
 * wrong: a `percent` question over a fraction accepts 0.333 and refuses 33.3.
 */
export function expectedAnswer(question: NumericQuestion): Expected {
  const cached = expectedCache.get(question.id);
  if (cached !== undefined) return cached;
  const table = fieldTable(question.calculation);
  const field = table.fields[question.field];
  if (field === undefined) {
    throw new Error(
      `quiz question ${question.id} asks for "${question.field}" of a ${question.calculation.kind} ` +
        `calculation, which produces: ${Object.keys(table.fields).join(', ')}`,
    );
  }
  if (field.unit !== question.unit) {
    throw new Error(
      `quiz question ${question.id} declares unit "${question.unit}" but "${question.field}" is in "${field.unit}"`,
    );
  }
  const expected = {
    value: field.value,
    unit: question.unit,
    tolerance: question.tolerance,
    working: table.working,
  };
  expectedCache.set(question.id, expected);
  return expected;
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
 * Whether an answer falls inside the stated tolerance, inclusive. `withinTolerance` in
 * `apps/web/src/lib/quiz-tolerance.ts`: the band is widened by eight ulps at the numbers' scale, the
 * size of the arithmetic error and nothing more, so the accepted band is the stated band.
 */
export function withinTolerance(answer: number, expected: Expected): boolean {
  if (!Number.isFinite(answer)) return false;
  const tolerance = Math.abs(expected.tolerance);
  const difference = Math.abs(answer - expected.value);
  if (difference <= tolerance) return true;
  const scale = Math.max(1, Math.abs(answer), Math.abs(expected.value), tolerance);
  return difference <= tolerance + 8 * Number.EPSILON * scale;
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

/**
 * Every figure a lesson or quiz shows, computed from the situation the content stored (ADR 0006).
 * Content never stores an answer, so this is the only source of a number on the Learn screens, and a
 * quiz's expected answer comes from the same function as the lesson's worked example.
 * A result always carries inputs, method, working and assumptions (design system §6.2).
 * Units: probabilities are 0..1, `estimatePercent` is percentage points, chips are chips, and
 * `toQuizUnit` is the one conversion. Nothing here throws. A content defect becomes a sentence, never
 * a fallback number.
 */

import type { LiveCalculation, QuizQuestion } from '@prl/contracts';
import { parseCards } from '@prl/poker-engine';
import type { CardOutcome, EquityResult, EvTerm } from '@prl/poker-math';
import {
  computeOuts,
  equity,
  estimateExactWork,
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
import type { MetricFormat } from '@prl/ui';
import { formatChips, formatPoints, formatProbability, formatUnits, NOT_A_PROBABILITY } from '@prl/ui';
import type { QuizUnit as LeafQuizUnit } from './quiz-tolerance.ts';
import {
  toleranceDecimals,
  QUIZ_UNIT_DECIMALS as UNIT_DECIMALS,
  QUIZ_UNIT_WORDS as UNIT_WORDS,
} from './quiz-tolerance.ts';

/** What unit a computed figure is natively in. See the module comment. */
export type CalculationScale = 'fraction' | 'points' | 'chips' | 'ratio' | 'count' | 'hands';

/** How a scale renders when nothing overrides it. One table, so no call site guesses. */
const SCALE_FORMAT: Readonly<Record<CalculationScale, MetricFormat>> = {
  fraction: 'percent',
  points: 'percent',
  chips: 'units',
  ratio: 'number',
  count: 'number',
  hands: 'number',
};

export interface CalculationFigure {
  /** The quiz question's `field`. Library field names, so no translation table is needed. */
  readonly key: string;
  readonly label: string;
  readonly value: number;
  readonly scale: CalculationScale;
  /** Overrides `SCALE_FORMAT`, for the two figures whose scale and rendering disagree. */
  readonly format?: MetricFormat;
  /** `null` renders no unit. Otherwise overrides the format's default word. */
  readonly unit?: string | null;
  readonly decimals?: number;
  /** Pre-formatted error bar, e.g. `"± 0.4 points"`. Present on every sampled figure. */
  readonly interval?: string;
  /** One line: the caveat, the comparison, the thing the number does not say. */
  readonly note?: string;
  readonly emphasis?: 'lead' | 'support';
}

/** A parameter the content stored. Rendered so a reader can see the situation, not just the answer. */
export interface CalculationInput {
  readonly label: string;
  readonly text: string;
  /**
   * Cards to draw instead of `text`, one group per holding or board, so a reader not yet taught wire
   * notation sees suit glyphs. `text` stays as the row's identity and the fallback.
   */
  readonly cards?: readonly (readonly number[])[];
}

export interface CalculationMethod {
  readonly label: string;
  /** `=` for a figure that is exactly this, `≈` for one that is approximately this. §6.2. */
  readonly glyph: string;
  readonly note: string;
}

export type CalculationDetail =
  | {
      readonly kind: 'outs';
      readonly clean: readonly CardOutcome[];
      readonly dirty: readonly CardOutcome[];
      readonly neutral: readonly CardOutcome[];
    }
  | {
      readonly kind: 'equity';
      readonly players: readonly {
        readonly label: string;
        readonly equity: number;
        readonly win: number;
        readonly tie: number;
      }[];
    }
  | { readonly kind: 'evTerms'; readonly terms: readonly EvTerm[] }
  | {
      readonly kind: 'range';
      readonly label: string;
      readonly lower: number;
      readonly upper: number;
      readonly unit: string;
    };

export interface CalculationResult {
  readonly kind: LiveCalculation['kind'];
  readonly title: string;
  readonly inputs: readonly CalculationInput[];
  readonly figures: readonly CalculationFigure[];
  readonly method: CalculationMethod;
  readonly formula: { readonly expression: string; readonly explanation: string } | null;
  /** The arithmetic written out, from the library. Never re-derived here. */
  readonly derivation: string | null;
  /** Where and by how much this figure is wrong. Rendered as a warning, never hidden. */
  readonly caveat: string | null;
  readonly assumptions: readonly string[];
  readonly detail: CalculationDetail | null;
}

export type CalculationOutcome =
  | { readonly ok: true; readonly result: CalculationResult }
  | { readonly ok: false; readonly reason: string };

/**
 * Work (`estimateExactWork(...).total`) above which a calculation runs after mount, not in render.
 * Measured: a flop is 990 run-outs in under 1ms, preflop is 1,712,304 in about 260ms. 20,000 sits
 * well clear of both, and inline figures stay in the server HTML.
 */
export const INLINE_WORK_BUDGET = 20_000;

/**
 * Only `equity` can be expensive, and only by how much board is known. `outs` is bounded (measured 2ms).
 * An unparseable calculation reports `false` so its error surfaces during render.
 */
export function isDeferred(calculation: LiveCalculation): boolean {
  if (calculation.kind !== 'equity') return false;
  try {
    return estimateExactWork(equitySpec(calculation)).total > INLINE_WORK_BUDGET;
  } catch {
    return false;
  }
}

function equitySpec(calculation: Extract<LiveCalculation, { kind: 'equity' }>): {
  players: { label: string; range: ReturnType<typeof exactRange> }[];
  board: readonly number[];
} {
  const players = [{ label: 'you', range: exactRange(parseCards(calculation.heroCards)) }];
  calculation.opponents.forEach((cards, index) => {
    players.push({
      label: calculation.opponents.length === 1 ? 'opponent' : `opponent ${index + 1}`,
      range: exactRange(parseCards(cards)),
    });
  });
  return { players, board: calculation.board === undefined ? [] : parseCards(calculation.board) };
}

/**
 * Through the probability domain, so an out-of-range input reads as refused rather than "160.0%". It
 * is still listed, because an EV with hidden inputs cannot be checked.
 */
function percentInput(label: string, fraction: number): CalculationInput {
  return { label, text: formatProbability(fraction) ?? NOT_A_PROBABILITY };
}

function unitsInput(label: string, chips: number): CalculationInput {
  return { label, text: formatUnits(chips) };
}

const ARITHMETIC: CalculationMethod = {
  label: 'exact arithmetic',
  glyph: '=',
  note: 'One division. There is nothing to sample and nothing to estimate.',
};

const CLOSED_FORM: CalculationMethod = {
  label: 'closed form',
  glyph: '=',
  note: 'Evaluated from the formula below, so the figure is exact given the inputs — which are not.',
};

/**
 * A free call has no "X to 1", so the price figure is dropped and the note says so. A figure of `0`
 * would claim the worst possible price, and `CalculationFigure.value` stays a number for `Metric`.
 */
function resolvePotOdds(calculation: Extract<LiveCalculation, { kind: 'potOdds' }>): CalculationResult {
  const odds = potOdds(calculation.pot, calculation.toCall);
  const priceFigures: readonly CalculationFigure[] =
    odds.oddsRatio === null
      ? []
      : [
          {
            key: 'oddsRatio',
            label: 'Price offered',
            value: odds.oddsRatio,
            scale: 'ratio',
            format: 'odds',
            emphasis: 'support',
          },
        ];
  return {
    kind: 'potOdds',
    title: 'The price of this call',
    inputs: [unitsInput('Pot before your call', odds.pot), unitsInput('Cost to call', odds.toCall)],
    figures: [
      {
        key: 'breakEvenEquity',
        label: 'Break-even equity',
        value: odds.breakEvenEquity,
        scale: 'fraction',
        emphasis: 'lead',
        note:
          odds.oddsRatio === null
            ? 'There is nothing to call, so there is no price to beat and no "X to 1" to quote. Any chance of winning is enough to continue.'
            : 'Win at least this often and calling neither gains nor loses. It says nothing about whether you do.',
      },
      ...priceFigures,
    ],
    method: ARITHMETIC,
    formula: {
      expression: 'break-even equity = call / (pot + call)',
      explanation:
        'The call is in the denominator as well as the numerator, because the money you put in is also money you win back when the hand holds up. The pot here excludes your own call.',
    },
    derivation: odds.explanation,
    caveat: null,
    assumptions: [],
    detail: null,
  };
}

function resolveRuleOf24(calculation: Extract<LiveCalculation, { kind: 'ruleOf24' }>): CalculationResult {
  const estimate = ruleOf24(calculation.outs, calculation.cardsToCome);
  return {
    kind: 'ruleOf24',
    title: 'The shortcut',
    inputs: [
      { label: 'Outs', text: formatChips(estimate.outs) },
      { label: 'Cards to come', text: formatChips(estimate.cardsToCome) },
      { label: 'Multiplier', text: `× ${formatChips(estimate.multiplier)}` },
    ],
    figures: [
      {
        key: 'estimatePercent',
        label: 'Rule-of-thumb estimate',
        value: estimate.estimatePercent,
        scale: 'points',
        emphasis: 'lead',
        note: 'A number you can do in your head at the table. Not the exact figure — see below.',
      },
    ],
    method: {
      label: 'mental shortcut',
      glyph: '≈',
      note: 'Multiplication, not probability. The exact figure needs the number of unseen cards, which this deliberately does not take.',
    },
    formula: {
      expression: 'estimate = outs × 2 (one card to come)\nestimate = outs × 4 (two cards to come)',
      explanation:
        'Each unseen card is roughly one in fifty of the cards left in the deck, so each out is worth about two points per card still to come.',
    },
    derivation: estimate.explanation,
    caveat: estimate.caveat,
    assumptions: [],
    detail: null,
  };
}

function resolveCallEv(calculation: Extract<LiveCalculation, { kind: 'callEv' }>): CalculationResult {
  const breakdown = evOfCall({
    pot: calculation.pot,
    toCall: calculation.toCall,
    equity: calculation.equity,
  });
  return {
    kind: 'callEv',
    title: 'What calling is worth',
    inputs: [
      unitsInput('Pot before your call', calculation.pot),
      unitsInput('Cost to call', calculation.toCall),
      percentInput('Equity assumed', calculation.equity),
    ],
    figures: [
      {
        key: 'ev',
        label: 'EV of calling',
        value: breakdown.ev,
        scale: 'chips',
        emphasis: 'lead',
        note: 'Folding is worth exactly 0 by definition, so this figure is already the comparison.',
      },
    ],
    method: {
      label: 'exact arithmetic',
      glyph: '=',
      note: 'A weighted average over the two outcomes below. The equity it is weighted with is an assumption, not a measurement.',
    },
    formula: {
      expression: 'EV(call) = equity × pot - (1 - equity) × call',
      explanation:
        'You win the pot as it stands when you are ahead at the end, and you lose only what you put in when you are not.',
    },
    derivation: breakdown.derivation,
    caveat: null,
    assumptions: breakdown.assumptions,
    detail: { kind: 'evTerms', terms: breakdown.terms },
  };
}

function resolveFoldEquity(calculation: Extract<LiveCalculation, { kind: 'foldEquity' }>): CalculationResult {
  const breakdown = evOfSemiBluff({
    pot: calculation.pot,
    betSize: calculation.betSize,
    foldProbability: calculation.foldProbability,
    equityWhenCalled: calculation.equityWhenCalled,
  });
  return {
    kind: 'foldEquity',
    title: 'What the bet is worth',
    inputs: [
      unitsInput('Pot before your bet', calculation.pot),
      unitsInput('Bet', calculation.betSize),
      percentInput('Assumed chance they fold', calculation.foldProbability),
      percentInput('Equity assumed when called', calculation.equityWhenCalled),
    ],
    figures: [
      {
        key: 'ev',
        label: 'EV of betting',
        value: breakdown.ev,
        scale: 'chips',
        emphasis: 'lead',
      },
      {
        key: 'foldEquityShare',
        label: 'From them folding',
        value: breakdown.foldEquityShare,
        scale: 'chips',
        emphasis: 'support',
      },
      {
        key: 'showdownShare',
        label: 'From winning at showdown',
        value: breakdown.showdownShare,
        scale: 'chips',
        emphasis: 'support',
      },
    ],
    method: {
      label: 'exact arithmetic',
      glyph: '=',
      note: 'Exact given the two probabilities it was handed. Both of those are forecasts about a person.',
    },
    formula: {
      expression: 'EV(bet) = fold% × pot + (1 - fold%) × (equity × (pot + bet) - (1 - equity) × bet)',
      explanation:
        'Two ways the bet makes money: they fold and you take the pot as it stands, or they call and you win a bigger one often enough to cover the times you do not.',
    },
    derivation: breakdown.derivation,
    caveat:
      'Splitting the figure into these two sources is the point: a bet can be worth making on fold equity alone, and the same bet against a player who never folds can be worth nothing.',
    assumptions: breakdown.assumptions,
    detail: { kind: 'evTerms', terms: breakdown.terms },
  };
}

function resolveIcm(calculation: Extract<LiveCalculation, { kind: 'icm' }>): CalculationResult {
  const result = icmEquity(calculation.stacks, calculation.payouts);
  const pool = result.totalPrizePool;
  const leader = result.equities[0] ?? 0;
  const share = pool === 0 ? 0 : leader / pool;
  return {
    kind: 'icm',
    title: 'Prize equity, not chip share',
    inputs: [
      { label: 'Stacks', text: calculation.stacks.join(' / ') },
      { label: 'Payouts', text: calculation.payouts.join(' / ') },
    ],
    figures: [
      {
        key: 'chipLeaderShare',
        label: 'Largest stack’s prize share',
        value: share,
        scale: 'fraction',
        emphasis: 'lead',
        note: 'Malmuth–Harville. Not chip share, and not a cash-out.',
      },
      ...result.equities.map((equity, index) => ({
        key: `equity${index}`,
        label: `Stack ${calculation.stacks[index] ?? index} — expected prize`,
        value: equity,
        scale: 'chips' as const,
        format: 'number' as const,
        unit: null,
        decimals: 1,
        emphasis: 'support' as const,
      })),
    ],
    method: CLOSED_FORM,
    formula: {
      expression: 'expected prize = sum over places of P(finish there) × prize(there)',
      explanation:
        'Chance of finishing first is your share of the chips. Later places apply the same rule to whoever is left. That is a model, not a cash-out.',
    },
    derivation: result.explanation,
    caveat:
      'ICM ignores position, skill and blind pressure. Trust the shape — chips won are worth less each than chips lost — not the decimal.',
    assumptions: result.assumptions,
    detail: null,
  };
}

function resolveSpr(calculation: Extract<LiveCalculation, { kind: 'spr' }>): CalculationResult {
  const result = stackToPotRatio(calculation.effectiveStack, calculation.pot);
  return {
    kind: 'spr',
    title: 'How much room is left',
    inputs: [unitsInput('Effective stack', result.effectiveStack), unitsInput('Pot', result.pot)],
    figures: [
      {
        key: 'spr',
        label: `Stack-to-pot ratio — ${result.band.replace('-', ' ')}`,
        value: result.spr,
        scale: 'ratio',
        format: 'number',
        unit: null,
        decimals: 1,
        emphasis: 'lead',
        note: result.implication,
      },
    ],
    method: ARITHMETIC,
    formula: {
      expression: 'SPR = effective stack / pot',
      explanation:
        'How many pot-sized bets fit behind. It is a measure of how many decisions are left, which is why the same hand plays differently at 1 and at 13.',
    },
    derivation: result.explanation,
    caveat: null,
    assumptions: [],
    detail: null,
  };
}

function resolveVariance(calculation: Extract<LiveCalculation, { kind: 'variance' }>): CalculationResult {
  const projection = projectResults({
    hands: calculation.hands,
    winRateBbPer100: calculation.winRateBbPer100,
    standardDeviationBbPer100: calculation.standardDeviationBbPer100,
  });
  return {
    kind: 'variance',
    title: 'What this many hands could look like',
    inputs: [
      { label: 'Hands', text: formatChips(projection.hands) },
      {
        label: 'Assumed win rate',
        text: `${formatChips(projection.winRateBbPer100, { decimals: 1 })} bb/100`,
      },
      {
        label: 'Assumed standard deviation',
        text: `${formatChips(projection.standardDeviationBbPer100, { decimals: 1 })} bb/100`,
      },
    ],
    figures: [
      {
        key: 'probabilityOfLoss',
        label: 'Chance of being down after all of them',
        value: projection.probabilityOfLoss,
        scale: 'fraction',
        emphasis: 'lead',
        note: 'With a genuine edge. This is variance, not a mistake.',
      },
      {
        key: 'expectedBb',
        label: 'Expected result',
        value: projection.expectedBb,
        scale: 'chips',
        unit: 'big blinds',
        emphasis: 'support',
      },
      {
        key: 'standardDeviationBb',
        label: 'Standard deviation over the sample',
        value: projection.standardDeviationBb,
        scale: 'chips',
        unit: 'big blinds',
        emphasis: 'support',
      },
    ],
    method: {
      label: 'normal approximation',
      glyph: '≈',
      note: 'A sum of many independent hands is approximately normal. The approximation is the method, not an error in it.',
    },
    formula: {
      expression: 'sd(sample) = sd(per 100) × sqrt(hands / 100)',
      explanation:
        'The spread grows with the square root of the sample while the expected result grows linearly, which is the whole reason a long enough sample eventually separates skill from luck.',
    },
    derivation: projection.explanation,
    caveat: null,
    assumptions: projection.assumptions,
    detail: {
      kind: 'range',
      label: '95% of outcomes',
      lower: projection.interval95.lowerBb,
      upper: projection.interval95.upperBb,
      unit: 'big blinds',
    },
  };
}

function resolveRiskOfRuin(calculation: Extract<LiveCalculation, { kind: 'riskOfRuin' }>): CalculationResult {
  const result = riskOfRuin({
    bankrollBb: calculation.bankrollBb,
    winRateBbPer100: calculation.winRateBbPer100,
    standardDeviationBbPer100: calculation.standardDeviationBbPer100,
  });
  return {
    kind: 'riskOfRuin',
    title: 'The chance of losing it all',
    inputs: [
      { label: 'Bankroll', text: `${formatChips(result.bankrollBb)} big blinds` },
      { label: 'Assumed win rate', text: `${formatChips(result.winRateBbPer100, { decimals: 1 })} bb/100` },
      {
        label: 'Assumed standard deviation',
        text: `${formatChips(result.standardDeviationBbPer100, { decimals: 1 })} bb/100`,
      },
    ],
    figures: [
      {
        key: 'probability',
        label: 'Risk of ruin',
        value: result.probability,
        scale: 'fraction',
        emphasis: 'lead',
        note: 'The chance of going broke at some point, playing for ever at these figures.',
      },
    ],
    method: CLOSED_FORM,
    formula: { expression: result.formula, explanation: result.explanation },
    derivation: null,
    caveat: null,
    assumptions: result.assumptions,
    detail: null,
  };
}

function cardInput(label: string, notation: string): CalculationInput {
  return { label, text: notation, cards: [parseCards(notation)] };
}

function resolveEquity(calculation: Extract<LiveCalculation, { kind: 'equity' }>): CalculationResult {
  const spec = equitySpec(calculation);
  const result: EquityResult = equity(spec);
  const hero = result.players[0];
  if (hero === undefined) throw new Error('an equity result with no players cannot be rendered');
  const interval =
    result.confidence === null ? undefined : `± ${formatPoints(result.confidence.halfWidthPoints)}`;
  const inputs: CalculationInput[] = [cardInput('Your cards', calculation.heroCards)];
  if (calculation.board !== undefined) inputs.push(cardInput('Board', calculation.board));
  inputs.push({
    label: calculation.opponents.length === 1 ? 'Opponent' : 'Opponents',
    text: calculation.opponents.join(', '),
    cards: calculation.opponents.map((holding) => parseCards(holding)),
  });

  return {
    kind: 'equity',
    title: 'Your share of this pot',
    inputs,
    figures: [
      {
        key: 'heroEquity',
        label: 'Your equity',
        value: hero.equity,
        scale: 'fraction',
        emphasis: 'lead',
        ...(interval === undefined ? {} : { interval }),
        note: 'Your share of the pot if the hand ran to the end from here every time, ties split.',
      },
      {
        key: 'win',
        label: 'You hold the best hand',
        value: hero.win,
        scale: 'fraction',
        emphasis: 'support',
      },
      { key: 'tie', label: 'You split it', value: hero.tie, scale: 'fraction', emphasis: 'support' },
    ],
    method:
      result.method === 'exact-enumeration'
        ? {
            label: 'exact enumeration',
            glyph: '=',
            note: `Every one of ${formatChips(result.trials)} remaining run-outs was played out, so there is no sampling error.`,
          }
        : {
            label: 'Monte Carlo sampling',
            glyph: '≈',
            note: `${formatChips(result.trials)} random run-outs from a fixed seed, so every learner reproduces this figure exactly.`,
          },
    formula: null,
    derivation: null,
    caveat: null,
    assumptions: result.assumptions,
    detail: {
      kind: 'equity',
      players: result.players.map((player) => ({
        label: player.label,
        equity: player.equity,
        win: player.win,
        tie: player.tie,
      })),
    },
  };
}

function resolveOuts(calculation: Extract<LiveCalculation, { kind: 'outs' }>): CalculationResult {
  if (calculation.opponentCards === undefined) {
    throw new Error(
      'an outs breakdown sorts each card into clean or dirty against a specific opponent holding, and this calculation did not name one',
    );
  }
  const result = computeOuts({
    heroCards: parseCards(calculation.heroCards),
    board: parseCards(calculation.board),
    opponent: exactRange(parseCards(calculation.opponentCards)),
  });
  return {
    kind: 'outs',
    title: 'Which cards actually help',
    inputs: [
      cardInput('Your cards', calculation.heroCards),
      cardInput('Board', calculation.board),
      cardInput('Opponent', calculation.opponentCards),
    ],
    figures: [
      {
        key: 'cleanCount',
        label: 'Clean outs',
        value: result.cleanCount,
        scale: 'count',
        unit: 'cards',
        emphasis: 'lead',
        note: 'Cards that win the pot against this holding if they arrive.',
      },
      {
        key: 'dirtyCount',
        label: 'Dirty outs',
        value: result.dirtyCount,
        scale: 'count',
        unit: 'cards',
        emphasis: 'lead',
        note: 'Cards that improve your hand and can still lose. Counting these as outs is how a draw gets overvalued.',
      },
      {
        key: 'equityNow',
        label: 'Equity as things stand',
        value: result.equityNow,
        scale: 'fraction',
        emphasis: 'support',
      },
      {
        key: 'totalOuts',
        label: 'Cards counted',
        value: result.totalOuts,
        scale: 'count',
        unit: 'cards',
        emphasis: 'support',
      },
    ],
    method: {
      label: 'exact, card by card',
      glyph: '=',
      note: `Each of the ${formatChips(result.cardsConsidered)} unseen cards was dealt in turn and the hand played out, so the split is enumerated rather than judged.`,
    },
    formula: null,
    derivation: result.explanation,
    caveat: null,
    assumptions: result.assumptions,
    detail: { kind: 'outs', clean: result.clean, dirty: result.dirty, neutral: result.neutral },
  };
}

/** A `switch` with a `never` default, so a new `LiveCalculation` kind is a compile error here. */
function resolve(calculation: LiveCalculation): CalculationResult {
  switch (calculation.kind) {
    case 'potOdds':
      return resolvePotOdds(calculation);
    case 'ruleOf24':
      return resolveRuleOf24(calculation);
    case 'callEv':
      return resolveCallEv(calculation);
    case 'foldEquity':
      return resolveFoldEquity(calculation);
    case 'spr':
      return resolveSpr(calculation);
    case 'variance':
      return resolveVariance(calculation);
    case 'riskOfRuin':
      return resolveRiskOfRuin(calculation);
    case 'equity':
      return resolveEquity(calculation);
    case 'outs':
      return resolveOuts(calculation);
    case 'icm':
      return resolveIcm(calculation);
    default: {
      const unreachable: never = calculation;
      return unreachable;
    }
  }
}

/** `@prl/poker-math` errors are teaching text, so a failure returns that sentence for the reader. */
export function computeCalculation(calculation: LiveCalculation): CalculationOutcome {
  try {
    return { ok: true, result: resolve(calculation) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

type QuizUnit = LeafQuizUnit;

/** `null` for any pairing that is not a real conversion. That is a content defect, not a target. */
function toQuizUnit(value: number, scale: CalculationScale, unit: QuizUnit): number | null {
  if (unit === 'percent') {
    if (scale === 'fraction') return value * 100;
    if (scale === 'points') return value;
    return null;
  }
  if (unit === 'chips') return scale === 'chips' ? value : null;
  if (unit === 'ratio') return scale === 'ratio' ? value : null;
  if (unit === 'count') return scale === 'count' ? value : null;
  return scale === 'hands' ? value : null;
}

export interface ExpectedAnswer {
  /** The target, in the question's own declared unit. */
  readonly value: number;
  readonly unit: QuizUnit;
  readonly tolerance: number;
  readonly figure: CalculationFigure;
  readonly result: CalculationResult;
}

export type ExpectedAnswerOutcome =
  | { readonly ok: true; readonly expected: ExpectedAnswer }
  | { readonly ok: false; readonly reason: string };

/** Split out so `QuizRunner` can pass a result from the deferred hook. Both paths end here. */
export function expectedFromResult(
  result: CalculationResult,
  question: Extract<QuizQuestion, { kind: 'numeric' }>,
): ExpectedAnswerOutcome {
  const figure = result.figures.find((candidate) => candidate.key === question.field);
  if (figure === undefined) {
    const available = result.figures.map((candidate) => candidate.key).join(', ');
    return {
      ok: false,
      reason: `this question asks for "${question.field}", which this calculation does not produce (it produces ${available})`,
    };
  }

  const value = toQuizUnit(figure.value, figure.scale, question.unit);
  if (value === null) {
    return {
      ok: false,
      reason: `"${question.field}" is measured in ${figure.scale} and this question asks for an answer in ${question.unit}, which is not a conversion`,
    };
  }

  return {
    ok: true,
    expected: { value, unit: question.unit, tolerance: question.tolerance, figure, result },
  };
}

/** Never read from the content, which does not contain it (ADR 0006). */
export function expectedAnswerFor(
  question: Extract<QuizQuestion, { kind: 'numeric' }>,
): ExpectedAnswerOutcome {
  const outcome = computeCalculation(question.calculation);
  if (!outcome.ok) return { ok: false, reason: outcome.reason };
  return expectedFromResult(outcome.result, question);
}

/**
 * Defined in the leaf `lib/quiz-tolerance.ts` so `node --test` can load them. This file imports
 * `@prl/ui`, which re-exports `.tsx`.
 */
export { QUIZ_UNIT_DECIMALS, QUIZ_UNIT_WORDS, withinTolerance } from './quiz-tolerance.ts';

/** A figure rendered for reading, in the unit the question declared. */
export function formatQuizValue(value: number, unit: QuizUnit): string {
  return `${formatChips(value, { decimals: UNIT_DECIMALS[unit] })} ${UNIT_WORDS[unit]}`;
}

/**
 * One more decimal than the unit when the unit cannot represent the tolerance. `0.5` at zero decimals
 * would print "within 1 cards", twice the rule `withinTolerance` applies.
 */
export function formatTolerance(tolerance: number, unit: QuizUnit): string {
  return formatChips(tolerance, {
    decimals: toleranceDecimals(tolerance, UNIT_DECIMALS[unit]),
  });
}

/** Metric props for a figure: the one place a scale becomes a rendering. */
export function figureFormat(figure: CalculationFigure): MetricFormat {
  return figure.format ?? SCALE_FORMAT[figure.scale];
}

/**
 * `Metric` expects a fraction for `percent`. A `points` figure is divided back so the rule of 2 and 4
 * reads as a percentage beside the exact equity, since both estimate the same quantity.
 */
export function figureValue(figure: CalculationFigure): number {
  return figure.scale === 'points' ? figure.value / 100 : figure.value;
}

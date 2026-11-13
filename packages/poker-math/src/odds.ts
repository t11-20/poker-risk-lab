/**
 * Pot odds, the rule of 2 and 4, implied odds and defence frequency for a call.
 * Every figure comes back with the words that make it safe to use.
 * `pot` never includes hero's call, so `potOdds(100, 50)` needs 50/150, not 50/200.
 * A bet B into P lays the caller `B / (P + 2B)`. `B / (P + B)` is `alpha`, the bettor's figure.
 * Equities are fractions in 0..1. Rule-of-thumb fields are percentage points and say so in the name.
 * Chips may be fractional, because later-street winnings are an expectation. Card counts are whole.
 * A free call has no price, so `oddsRatio` is `null`. `Infinity` reached the browser as null and
 * crashed `/play`, because JSON has no `Infinity`.
 */

import { DECK_SIZE } from '@prl/poker-engine';

export class OddsError extends Error {
  override readonly name = 'OddsError';
}

/** Hero's two cards and a three-card flop are known, so at most 52 - 5 = 47 cards are unseen. */
const MAX_UNSEEN_WITH_CARDS_TO_COME = DECK_SIZE - 5;

/** Chips are finite and not negative. Fractions are allowed. */
function requireAmount(value: number, what: string, hint: string): void {
  if (!Number.isFinite(value)) {
    throw new OddsError(`${what} must be a finite number of units, received ${value}. ${hint}`);
  }
  if (value < 0) {
    throw new OddsError(`${what} cannot be negative, received ${value}. ${hint}`);
  }
}

/** A bet of 0 is a check, and lays nobody a price. */
function requirePositiveAmount(value: number, what: string, hint: string): void {
  requireAmount(value, what, hint);
  if (value === 0) {
    throw new OddsError(`${what} must be greater than 0, received 0. ${hint}`);
  }
}

function requireCardCount(value: number, what: string, hint: string): void {
  if (!Number.isInteger(value)) {
    throw new OddsError(`${what} must be a whole number of cards, received ${value}. ${hint}`);
  }
  if (value < 0) {
    throw new OddsError(`${what} cannot be negative, received ${value}. ${hint}`);
  }
}

/** The type says `1 | 2`, but the value arrives as JSON over HTTP, so a 3 must be refused here. */
function requireCardsToCome(cardsToCome: number): 1 | 2 {
  if (cardsToCome !== 1 && cardsToCome !== 2) {
    throw new OddsError(
      `cardsToCome must be 1 (the river only) or 2 (the turn and the river), received ${cardsToCome}`,
    );
  }
  return cardsToCome;
}

function units(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/** 0.33333 becomes "33.3%". */
function percent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

/** Percentage points, already scaled. 5.8834 becomes "5.9". */
function points(value: number): string {
  return value.toFixed(1);
}

/**
 * "2 to 1", "3.33 to 1". `null` is accepted so a caller can pass `oddsRatio` where it already
 * knows there is a price. Reaching here without one is a bug in this file.
 */
function ratioText(ratio: number | null): string {
  if (ratio === null) {
    throw new OddsError('internal: a free call has no "X to 1" form and should have been handled');
  }
  if (!Number.isFinite(ratio)) {
    throw new OddsError(`internal: a price of ${ratio} has no "X to 1" form and should have been handled`);
  }
  return Number.isInteger(ratio) ? `${ratio} to 1` : `${ratio.toFixed(2)} to 1`;
}

export interface PotOdds {
  /** Chips in the middle BEFORE hero's call. Never includes the call itself. */
  readonly pot: number;
  readonly toCall: number;
  /** `toCall / (pot + toCall)`, the equity at which calling neither gains nor loses. */
  readonly breakEvenEquity: number;
  /** `pot / toCall`, "getting X to 1". `null` when the call is free. */
  readonly oddsRatio: number | null;
  readonly explanation: string;
}

/** `pot` excludes hero's call. `toCall` is 0 when checking is free. */
export function potOdds(pot: number, toCall: number): PotOdds {
  requireAmount(
    pot,
    'pot',
    'Pass the chips already in the middle, excluding the call hero is about to make.',
  );
  requireAmount(toCall, 'toCall', 'Pass what the call costs hero, or 0 when there is nothing to call.');

  // A pot of 0 with nothing to call would be 0/0, so the free call is its own branch.
  const breakEvenEquity = toCall === 0 ? 0 : toCall / (pot + toCall);
  const oddsRatio = toCall === 0 ? null : pot / toCall;

  const explanation =
    toCall === 0
      ? 'Checking is free. There is nothing to call, so nothing to lose by continuing: the ' +
        `break-even equity is 0% and any chance of winning the ${units(pot)} in the middle is enough. ` +
        'There is no "X to 1" price because you are not paying a price, which is why the ratio is ' +
        'reported as no price at all rather than as a number.'
      : `You risk ${units(toCall)} to win the ${units(pot)} already in the middle, a price of ` +
        `${ratioText(oddsRatio)}. Calling breaks even at ${units(toCall)} / (${units(pot)} + ` +
        `${units(toCall)}) = ${percent(breakEvenEquity)} equity: with less than that, calling loses ` +
        'units over many repetitions of this spot; with more, it gains them. The ' +
        `${units(pot)} is what is in the middle before your own ${units(toCall)} goes in — counting ` +
        'the call inside the pot understates the equity a call needs.';

  return { pot, toCall, breakEvenEquity, oddsRatio, explanation };
}

export interface RuleOfThumbEstimate {
  readonly outs: number;
  readonly cardsToCome: 1 | 2;
  readonly multiplier: 2 | 4;
  /** `outs * multiplier`, in percentage POINTS (9 outs, 2 cards to come reads 36). */
  readonly estimatePercent: number;
  readonly explanation: string;
  /** Specifically where and by how much this shortcut is wrong. Never vague. */
  readonly caveat: string;
}

/**
 * The largest out count whose shortcut stays at or below 100%. 25 with two cards to come, 50 with one.
 * Exported so a caller can ask before `ruleOf24` refuses.
 */
export function maximumOutsForRuleOf24(cardsToCome: 1 | 2): number {
  const streets = requireCardsToCome(cardsToCome);
  return streets === 2 ? 25 : 50;
}

/**
 * The rule of 2 and 4. `caveat` names the direction and size of the error, because the error is
 * the lesson. It takes no `unseen`, since the shortcut is head arithmetic. `ruleOf24Accuracy`
 * compares it with the exact figure. Above `maximumOutsForRuleOf24` it throws rather than clamp,
 * because a clamped 100% would be a made-up certainty.
 */
export function ruleOf24(outs: number, cardsToCome: 1 | 2): RuleOfThumbEstimate {
  requireCardCount(outs, 'outs', 'Pass the number of cards that would win the hand for hero.');
  const streets = requireCardsToCome(cardsToCome);
  if (outs > MAX_UNSEEN_WITH_CARDS_TO_COME) {
    throw new OddsError(
      `outs cannot exceed ${MAX_UNSEEN_WITH_CARDS_TO_COME}, received ${outs}. With cards still to come, ` +
        "hero's two cards and at least three board cards are already known, so at most " +
        `${MAX_UNSEEN_WITH_CARDS_TO_COME} cards remain unseen.`,
    );
  }
  const ceiling = maximumOutsForRuleOf24(streets);
  if (outs > ceiling) {
    const multiplierAtCeiling = streets === 2 ? 4 : 2;
    throw new OddsError(
      `the rule of 2 and 4 cannot be applied to ${outs} outs with ${streets === 2 ? 'two cards' : 'one card'} ` +
        `to come: ${outs} x ${multiplierAtCeiling} is ${outs * multiplierAtCeiling}%, which is not a ` +
        'probability. The shortcut is a straight line through a curve that flattens towards certainty, so ' +
        `above ${ceiling} outs it stops approximating anything. Use probabilityOfHitting for a hand with ` +
        'this many cards to improve it — and check whether "outs" is still the right frame, because a hand ' +
        'with that many is usually already the best hand rather than drawing to one.',
    );
  }

  const multiplier: 2 | 4 = streets === 2 ? 4 : 2;
  const estimatePercent = outs * multiplier;

  const explanation =
    `${outs} out${outs === 1 ? '' : 's'} with ${streets === 2 ? 'two cards' : 'one card'} to come, ` +
    `times ${multiplier}, is roughly ${estimatePercent}% — the rule of 2 and 4. It works because one ` +
    'card out of the 46 or so you have not seen is worth a little over 2%, so 2% per out per card is ' +
    'close enough to do in your head. Count clean outs only: a card that improves your hand but hands ' +
    'an opponent a better one at the same time is not an out, and counting it is a bigger error than ' +
    'anything the shortcut itself does.';

  const caveat =
    streets === 2
      ? 'The x4 form counts BOTH the turn and the river, which you only get to see for this price ' +
        'if there is no more betting. Call this bet and then face another on the turn and you have ' +
        'paid for one card, not two, so x4 overstates what the call is buying. The error also grows ' +
        'with the out count: at 15 outs x4 says 60% where the exact figure with 47 cards unseen is ' +
        '54.1%, an overstatement of 5.9 points, while at 4 outs it slightly understates (16% against ' +
        '16.5%). Use it to sanity-check a decision, never to settle a close one.'
      : 'The x2 form charges 2% per out where one card out of 46 unseen is worth about 2.17%, so it ' +
        'understates, and always in the same direction: 9 outs is 19.6%, not 18%. The gap grows with ' +
        "the out count — 15 outs is 32.6% against the shortcut's 30%. It also assumes every out is " +
        'clean and that hitting wins, which on a board where you are drawing to second best is the ' +
        'larger error by far.';

  return { outs, cardsToCome: streets, multiplier, estimatePercent, explanation, caveat };
}

export interface RuleOfThumbAccuracy {
  readonly estimate: RuleOfThumbEstimate;
  /** The exact figure in percentage POINTS, for comparison with `estimatePercent`. */
  readonly exactPercent: number;
  /** `estimatePercent - exactPercent`. Positive means the shortcut overstates. */
  readonly errorPoints: number;
  readonly verdict: string;
}

/**
 * The shortcut next to the exact figure. `exactEquity` is a fraction in 0..1, usually
 * `probabilityOfHitting(...).probability` or hero's enumerated equity when the draw is not clean.
 */
export function ruleOf24Accuracy(outs: number, cardsToCome: 1 | 2, exactEquity: number): RuleOfThumbAccuracy {
  // First, so a bad `outs` reports itself as a bad `outs`.
  const estimate = ruleOf24(outs, cardsToCome);
  if (!Number.isFinite(exactEquity)) {
    throw new OddsError(`exactEquity must be a finite probability between 0 and 1, received ${exactEquity}`);
  }
  if (exactEquity < 0 || exactEquity > 1) {
    throw new OddsError(
      `exactEquity must be a probability between 0 and 1, received ${exactEquity}. It is a fraction, ` +
        'not a percentage: pass 0.35, not 35.',
    );
  }

  const exactPercent = exactEquity * 100;
  const errorPoints = estimate.estimatePercent - exactPercent;
  const magnitude = Math.abs(errorPoints);
  const comparison = `${estimate.estimatePercent}% against an exact ${points(exactPercent)}%`;

  let verdict: string;
  if (errorPoints === 0) {
    verdict =
      `The shortcut happens to land exactly on the true figure here, ${estimate.estimatePercent}%. ` +
      'That is a coincidence of this out count, not a property of the shortcut.';
  } else if (magnitude < 0.5) {
    verdict = `The shortcut is within half a point here — ${comparison} — so it is safe to use at the table.`;
  } else if (magnitude < 2) {
    const direction = errorPoints > 0 ? 'overstates' : 'understates';
    verdict =
      `The shortcut ${direction} by ${points(magnitude)} points here — ${comparison}. Fine as a rough ` +
      'read, but do not hang a marginal call on it.';
  } else {
    const direction = errorPoints > 0 ? 'overstates' : 'understates';
    verdict =
      `The shortcut ${direction} by ${points(magnitude)} points here — ${comparison}. That is enough ` +
      'to flip a marginal call into a fold or the other way round, so use the exact figure for this ' +
      'decision.';
  }

  return { estimate, exactPercent, errorPoints, verdict };
}

export interface HitProbability {
  readonly outs: number;
  readonly unseen: number;
  readonly cardsToCome: 1 | 2;
  /** A fraction in 0..1. */
  readonly probability: number;
  readonly derivation: string;
}

/**
 * The chance at least one out arrives, by complement (1 minus the chance every card misses).
 * Adding the per-card chances double counts run-outs that hit twice (9 outs reads 38.7%, not 35.0%).
 * It is the chance of a card arriving, not of winning.
 */
export function probabilityOfHitting(outs: number, unseen: number, cardsToCome: 1 | 2): HitProbability {
  requireCardCount(outs, 'outs', 'Pass the number of unseen cards that would win the hand for hero.');
  requireCardCount(unseen, 'unseen', 'Pass the number of cards hero cannot see, usually 47 on the flop.');
  const streets = requireCardsToCome(cardsToCome);
  if (unseen > DECK_SIZE) {
    throw new OddsError(`unseen cannot exceed the ${DECK_SIZE} cards in a deck, received ${unseen}`);
  }
  if (unseen < streets) {
    throw new OddsError(
      `unseen must be at least cardsToCome, received unseen=${unseen} with cardsToCome=${streets}. ` +
        `There is no way to deal ${streets} cards from ${unseen}.`,
    );
  }
  if (outs > unseen) {
    throw new OddsError(
      `outs cannot exceed unseen, received outs=${outs} with unseen=${unseen}. An out has to be a card ` +
        'that is still in the stub — a card hero can see is not an out.',
    );
  }

  const misses = unseen - outs;

  if (streets === 1) {
    const probability = outs / unseen;
    return {
      outs,
      unseen,
      cardsToCome: streets,
      probability,
      derivation:
        `One card to come. ${outs} of the ${unseen} unseen cards win the hand, so the chance is ` +
        `${outs}/${unseen} = ${percent(probability)}. With a single card there is nothing to correct ` +
        'for: the count of outs over the count of unseen cards is the probability.',
    };
  }

  // With `misses === 0` the general formula multiplies by `-1/(unseen-1)`, so fewer than two misses
  // is certain and answered directly.
  if (misses < 2) {
    return {
      outs,
      unseen,
      cardsToCome: streets,
      probability: 1,
      derivation:
        misses === 0
          ? `Two cards to come with ${outs} outs and ${unseen} cards unseen: every card left in the ` +
            'deck is an out, so there is nothing that can miss and hitting is certain — 100%.'
          : `Two cards to come, ${outs} outs, ${unseen} cards unseen. Exactly one card misses, and two ` +
            'cards cannot both be that one card, so at least one out has to arrive — 100%.',
    };
  }

  const missBoth = (misses / unseen) * ((misses - 1) / (unseen - 1));
  const probability = 1 - missBoth;

  return {
    outs,
    unseen,
    cardsToCome: streets,
    probability,
    derivation:
      `Two cards to come, ${outs} outs, ${unseen} cards unseen. Count the misses instead of the hits: ` +
      `${misses} cards do not help. The turn misses ${misses}/${unseen} of the time, and with one ` +
      `miss now gone the river misses ${misses - 1}/${unseen - 1} of the time, so both cards miss ` +
      `(${misses}/${unseen}) x (${misses - 1}/${unseen - 1}) = ${percent(missBoth)} of the time. ` +
      `Hitting at least one is whatever is left: 1 - ${percent(missBoth)} = ${percent(probability)}. ` +
      `Adding ${outs}/${unseen} + ${outs}/${unseen - 1} instead would count every run-out that hits ` +
      'twice twice over, and overstate the chance.',
  };
}

export interface ImpliedOdds {
  readonly pot: number;
  readonly toCall: number;
  /** Extra chips hero expects to win on LATER streets when the draw comes in. */
  readonly expectedAdditionalWinnings: number;
  /** `toCall / (pot + toCall + expectedAdditionalWinnings)`. */
  readonly effectiveBreakEvenEquity: number;
  readonly explanation: string;
  readonly assumptions: readonly string[];
}

/**
 * Pot odds with later-street winnings added. `expectedAdditionalWinnings` is a forecast about a
 * person, not a count off the table, which is why `assumptions` travels with the figure.
 */
export function impliedOdds(input: {
  pot: number;
  toCall: number;
  expectedAdditionalWinnings: number;
}): ImpliedOdds {
  const { pot, toCall, expectedAdditionalWinnings } = input;
  requireAmount(pot, 'pot', "Pass the chips already in the middle, excluding hero's call.");
  requireAmount(toCall, 'toCall', 'Pass what the call costs hero, or 0 when there is nothing to call.');
  requireAmount(
    expectedAdditionalWinnings,
    'expectedAdditionalWinnings',
    'Pass the extra chips hero expects to win on later streets when the draw comes in, or 0 for none.',
  );

  const denominator = pot + toCall + expectedAdditionalWinnings;
  // As in `potOdds`, a free call needs no equity, and an empty pot would be 0/0.
  const effectiveBreakEvenEquity = toCall === 0 ? 0 : toCall / denominator;
  const potPrice = potOdds(pot, toCall);

  const explanation =
    toCall === 0
      ? 'There is nothing to call, so there is no price to improve on: checking is free and the ' +
        'break-even equity stays at 0%. Implied odds only ever change the arithmetic of a call.'
      : `On the pot alone, calling ${units(toCall)} into ${units(pot)} needs ` +
        `${percent(potPrice.breakEvenEquity)}. If making the hand is worth another ` +
        `${units(expectedAdditionalWinnings)} from later streets, the same call is playing for ` +
        `${units(denominator)} in total, so the equity it needs falls to ${units(toCall)} / ` +
        `(${units(pot)} + ${units(toCall)} + ${units(expectedAdditionalWinnings)}) = ` +
        `${percent(effectiveBreakEvenEquity)}. That is a drop of ` +
        `${points((potPrice.breakEvenEquity - effectiveBreakEvenEquity) * 100)} points, bought entirely ` +
        'with money that is not in the middle yet.';

  return {
    pot,
    toCall,
    expectedAdditionalWinnings,
    effectiveBreakEvenEquity,
    explanation,
    assumptions: [
      `The ${units(expectedAdditionalWinnings)} is an estimate about future streets, not a fact. It is ` +
        'the one figure here that cannot be counted off the table.',
      'It assumes you get paid when the draw comes in. An opponent who shuts down, or a card obvious ' +
        'enough to scare them, pays less than the estimate.',
      'It assumes that extra money only moves when you hit. Chips lost on the streets where you ' +
        'miss, or hit and are still second best, belong in reverse implied odds instead.',
      'It assumes the stacks contain it: nobody can pay you more than they have behind, so the ' +
        'estimate can never exceed the effective stack.',
      'It says nothing about how often the opponent raises you off the draw before the last card, ' +
        'which is the usual reason a call priced on implied odds never gets to collect them.',
    ],
  };
}

export interface ReverseImpliedOdds {
  readonly pot: number;
  readonly toCall: number;
  /** Extra chips hero expects to LOSE on later streets in this spot. */
  readonly expectedAdditionalLosses: number;
  /** `(toCall + expectedAdditionalLosses) / (pot + toCall + expectedAdditionalLosses)`. */
  readonly effectiveBreakEvenEquity: number;
  readonly explanation: string;
  readonly assumptions: readonly string[];
}

/**
 * Pot odds with later-street losses added. The losses go into both the numerator (hero pays them)
 * and the denominator (they end up in the pot), so any positive estimate worsens the break-even.
 */
export function reverseImpliedOdds(input: {
  pot: number;
  toCall: number;
  expectedAdditionalLosses: number;
}): ReverseImpliedOdds {
  const { pot, toCall, expectedAdditionalLosses } = input;
  requireAmount(pot, 'pot', "Pass the chips already in the middle, excluding hero's call.");
  requireAmount(toCall, 'toCall', 'Pass what the call costs hero, or 0 when there is nothing to call.');
  requireAmount(
    expectedAdditionalLosses,
    'expectedAdditionalLosses',
    'Pass the extra chips hero expects to lose on later streets in this spot, or 0 for none.',
  );

  const numerator = toCall + expectedAdditionalLosses;
  const denominator = pot + numerator;
  // Any nonzero numerator makes the denominator positive, because the pot is never negative.
  const effectiveBreakEvenEquity = numerator === 0 ? 0 : numerator / denominator;
  const potPrice = potOdds(pot, toCall);
  const potPriceText = percent(potPrice.breakEvenEquity);

  const explanation =
    expectedAdditionalLosses === 0
      ? `With nothing extra expected to go in, this is just the pot price: ${potPriceText}. Setting ` +
        'the estimate to 0 is a claim that the hand is never going to cost you more than this call.'
      : `On the pot alone, calling ${units(toCall)} into ${units(pot)} needs ${potPriceText}. If this ` +
        `hand tends to cost another ${units(expectedAdditionalLosses)} on later streets — paying off ` +
        'a better hand, or improving into second best — then the call is really ' +
        `${units(numerator)} to win ${units(denominator)}, and it needs ${units(numerator)} / ` +
        `(${units(pot)} + ${units(toCall)} + ${units(expectedAdditionalLosses)}) = ` +
        `${percent(effectiveBreakEvenEquity)}. The price is worse than the pot advertises, by ` +
        `${points((effectiveBreakEvenEquity - potPrice.breakEvenEquity) * 100)} points.`;

  return {
    pot,
    toCall,
    expectedAdditionalLosses,
    effectiveBreakEvenEquity,
    explanation,
    assumptions: [
      `The ${units(expectedAdditionalLosses)} is an estimate about future streets, not a fact. Nothing ` +
        'on the table tells you what this hand will cost after the call.',
      'It counts two different futures at once: the times you miss and pay anyway, and the times ' +
        'you improve and are still beaten by the hands that pay off.',
      'Second-best hands are where this bites hardest. A hand that can only win small pots and lose ' +
        'big ones has reverse implied odds no pot price can rescue.',
      'Position changes the size of it. Out of position you have to guess more often, and the cost of ' +
        'guessing wrong is what this estimate is trying to measure.',
      'Implied and reverse implied odds are estimates about the same future streets. Applying one and ' +
        'ignoring the other is how a call gets talked into existence.',
    ],
  };
}

export interface DefenceFrequency {
  readonly pot: number;
  readonly betSize: number;
  /** `pot / (pot + betSize)`, how often the bet must be called or raised. */
  readonly minimumDefenceFrequency: number;
  /** `betSize / (pot + betSize)`, how often a pure bluff must work. */
  readonly alpha: number;
  readonly explanation: string;
  readonly caveat: string;
}

/**
 * Minimum defence frequency and alpha, which always sum to 1. Alpha is not the price the bet lays
 * the caller. A pot-sized bet gives alpha 50% and a caller's break-even of 33.3% (`priceLaidByBet`).
 */
export function defenceFrequency(pot: number, betSize: number): DefenceFrequency {
  requireAmount(pot, 'pot', 'Pass the chips in the middle before the bet.');
  requirePositiveAmount(
    betSize,
    'betSize',
    'A bet of 0 is a check, and a check lays nobody a price and demands no defence.',
  );

  const total = pot + betSize;
  const minimumDefenceFrequency = pot / total;
  const alpha = betSize / total;

  const explanation =
    `A bet of ${units(betSize)} into ${units(pot)} risks ${units(betSize)} to win ${units(pot)}, so a ` +
    `pure bluff breaks even when it works ${units(betSize)} / (${units(pot)} + ${units(betSize)}) = ` +
    `${percent(alpha)} of the time. That share is alpha. If you fold more often than ` +
    `${percent(alpha)} here, any two cards can bet at a profit; defending — calling or raising — at ` +
    `least ${percent(minimumDefenceFrequency)} of the time takes that away. The two figures are the ` +
    'two halves of one whole, which is why they always add to 1.';

  const caveat =
    "This figure comes from the bettor's arithmetic, not from your hand. It assumes the bettor's " +
    'range is polarised into hands that want a call and hands that want a fold, that the hand ends ' +
    'here with no further betting, and that every hand you defend with is worth defending. Against ' +
    'someone who never bluffs, folding far more than alpha is right and costs nothing; against ' +
    'someone who bluffs constantly, defending far more is. It also says nothing about WHICH hands to ' +
    'defend, which is the part that actually decides the spot. Treat it as a reference point, never ' +
    'as a quota to hit and never as the optimal frequency.';

  return { pot, betSize, minimumDefenceFrequency, alpha, explanation, caveat };
}

/**
 * The caller's break-even against a bet is `betSize / (pot + 2 * betSize)`. A pot-sized bet lays
 * 2 to 1 (a third), a half-pot bet 3 to 1 (a quarter). It delegates to `potOdds` so the two cannot
 * disagree, so the returned `pot` is `pot + betSize` and `toCall` is `betSize`.
 */
export function priceLaidByBet(pot: number, betSize: number): PotOdds {
  requireAmount(pot, 'pot', 'Pass the chips in the middle before the bet.');
  requirePositiveAmount(
    betSize,
    'betSize',
    'A bet of 0 is a check, which lays no price at all — use potOdds(pot, 0) for that.',
  );

  const middle = pot + betSize;
  const asCall = potOdds(middle, betSize);

  return {
    ...asCall,
    explanation:
      `A bet of ${units(betSize)} into a pot of ${units(pot)} leaves ${units(middle)} in the middle ` +
      `and costs ${units(betSize)} to call, so the caller is getting ${ratioText(asCall.oddsRatio)} and ` +
      `needs ${units(betSize)} / (${units(pot)} + 2 x ${units(betSize)}) = ` +
      `${percent(asCall.breakEvenEquity)} to break even. The bet is counted twice in that denominator ` +
      'on purpose: once inside the money the caller can win, and once as the money they have to put ' +
      'up. Check the shape against the case everyone knows — a pot-sized bet lays 2 to 1, so the ' +
      'caller needs a third.',
  };
}

/**
 * The price of a call: pot odds, the rule of 2 and 4, implied odds, and how often a
 * bet has to be defended against.
 *
 * Every function here answers one shape of question — "what would this call have to
 * be worth for it to be worth making?" — and every one returns its figure together
 * with the words that make the figure safe to use. A bare number is what makes a
 * learner confident and wrong, so nothing in this file returns a bare number.
 *
 * ## The convention that prevents the commonest error
 *
 * `pot` NEVER includes hero's own call. `potOdds(100, 50)` means "there are 100 in
 * the middle and it costs 50 to call", and the break-even equity is 50/150 = 33.3%.
 * Fold hero's call into the pot and every figure in this file is quietly wrong (that
 * same spot would read 50/200 = 25% and turn a fold into a call), so the exclusion is
 * restated in every doc comment and in the explanation strings the learner reads.
 *
 * ## The formula that gets misquoted most often
 *
 * A bet of B into a pot of P lays the caller `B / (P + 2B)`, not `B / (P + B)`. The
 * bet appears twice on purpose: once inside the money the caller stands to win, and
 * once as the money they have to put up. `B / (P + B)` is a real number — it is
 * `alpha`, the answer to the *bettor's* question of how often a bluff has to work —
 * and swapping the two is how "a pot-sized bet means the caller needs half the pot"
 * finds its way into print. The anchor to check any implementation against: a
 * pot-sized bet lays 2 to 1, so the caller needs a third, and a half-pot bet lays
 * 3 to 1, so the caller needs a quarter. `priceLaidByBet` is therefore written by
 * delegating to `potOdds` with a middle that already contains the bet, so the two
 * cannot drift apart as this file is edited.
 *
 * ## Units: fractions versus percentage points
 *
 * Probabilities and equities are fractions in 0..1 (`breakEvenEquity`,
 * `probability`, `alpha`). The rule-of-thumb figures are in percentage POINTS,
 * because that is how the shortcut is taught and how it is said out loud ("nine outs
 * is about thirty-six"). Field names carry the unit — `estimatePercent`,
 * `exactPercent`, `errorPoints` — because a silent factor of 100 between two values
 * both typed `number` is a bug nobody catches by reading.
 *
 * ## Money may be fractional; cards may not
 *
 * Chip amounts are validated as finite and not negative, but deliberately NOT as
 * integers. A pot of 150 is real chips, but `expectedAdditionalWinnings` is an
 * expectation over future streets, and 47.5 is a perfectly sensible estimate of one.
 * Card counts (`outs`, `unseen`, `cardsToCome`) must be whole numbers, because half a
 * card cannot come.
 *
 * ## Nothing here returns NaN, and nothing is silently clamped
 *
 * Bad input throws `OddsError` naming what arrived and what was expected. The one
 * division that cannot be dodged is the free call: with `toCall === 0` there is no
 * "X to 1" price at all, so `oddsRatio` is `null`.
 *
 * Three representations of "there is no price" were considered, and the history is
 * kept here because two of them are still the obvious-looking answer:
 *
 *  - **`NaN`** — rejected. It is what 0/0 produces, it poisons every arithmetic step
 *    downstream, and it compares false against itself, so even a caller that thinks
 *    to check for it usually checks wrongly.
 *  - **`0`** — rejected. A ratio of 0 reads as "the worst price there is" when the
 *    truth is "there is no price", and it is a *number*, so nothing forces a caller
 *    to notice. Two test helpers in `@prl/poker-ai` independently invented it and
 *    quietly asserted against a price that does not exist.
 *  - **`Infinity`** — tried, shipped, and wrong for a reason that has nothing to do
 *    with arithmetic: **JSON has no `Infinity`**. `JSON.stringify(Infinity)` is the
 *    string `"null"`, so the sentinel could not survive its own wire format. Every
 *    free-call spot reached the browser as `"oddsRatio": null` against a contract
 *    that declared `number`; `formatOdds` in `@prl/ui` threw `FormatError` inside
 *    `CoachPanel` and the error boundary replaced the whole `/play` route. Measured,
 *    not inferred: `in process: Infinity` / `on the wire: {"oddsRatio":null}`.
 *
 * `null` is what remains, and it is the better answer on its own merits rather than
 * by elimination. It is exactly what JSON already produces, so the declared type is
 * the type that crosses the wire; it reads as "no price" rather than as a bad price;
 * it can never be mistaken for 0 by a formatter; and — the part that matters most —
 * `number | null` makes TypeScript force every consumer to say what it does about a
 * free call, which is the thing nobody had done. The explanation string says the same
 * in words, because a learner does not read the type.
 */

import { DECK_SIZE } from '@prl/poker-engine';

export class OddsError extends Error {
  override readonly name = 'OddsError';
}

/**
 * The most cards that can still be unseen while 1 or 2 cards are to come.
 *
 * With two cards to come the board holds three cards, and hero holds two, so five
 * cards are already known: 52 - 5 = 47. With one card to come it is 46. Deriving the
 * bound rather than writing `47` is what makes it obvious why an out count of 50 is
 * not a tight-fisted validation rule but an impossibility.
 */
const MAX_UNSEEN_WITH_CARDS_TO_COME = DECK_SIZE - 5;

/** Chips: finite and not negative. Fractions are allowed — see the file header. */
function requireAmount(value: number, what: string, hint: string): void {
  if (!Number.isFinite(value)) {
    throw new OddsError(`${what} must be a finite number of units, received ${value}. ${hint}`);
  }
  if (value < 0) {
    throw new OddsError(`${what} cannot be negative, received ${value}. ${hint}`);
  }
}

/** Chips that must actually exist: a bet of 0 is a check, and lays nobody a price. */
function requirePositiveAmount(value: number, what: string, hint: string): void {
  requireAmount(value, what, hint);
  if (value === 0) {
    throw new OddsError(`${what} must be greater than 0, received 0. ${hint}`);
  }
}

/** A count of cards: a whole number, not negative. */
function requireCardCount(value: number, what: string, hint: string): void {
  if (!Number.isInteger(value)) {
    throw new OddsError(`${what} must be a whole number of cards, received ${value}. ${hint}`);
  }
  if (value < 0) {
    throw new OddsError(`${what} cannot be negative, received ${value}. ${hint}`);
  }
}

/**
 * Validates `cardsToCome` and narrows it.
 *
 * The parameter is typed `1 | 2`, so this looks redundant — it is not. These
 * functions sit behind an HTTP API where the value arrives as JSON, and a 3 that
 * TypeScript never saw would otherwise sail through and produce a figure for a
 * street that does not exist. Returning the narrowed value lets callers use the
 * result instead of the argument, with no cast anywhere.
 */
function requireCardsToCome(cardsToCome: number): 1 | 2 {
  if (cardsToCome !== 1 && cardsToCome !== 2) {
    throw new OddsError(
      `cardsToCome must be 1 (the river only) or 2 (the turn and the river), received ${cardsToCome}`,
    );
  }
  return cardsToCome;
}

/** Units, printed without inventing precision the caller never supplied. */
function units(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/** A fraction in 0..1 as a percentage with one decimal: 0.33333 becomes "33.3%". */
function percent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

/** Percentage points, already scaled: 5.8834 becomes "5.9". */
function points(value: number): string {
  return value.toFixed(1);
}

/**
 * "2 to 1", "3.33 to 1". Never reached without a price — see `potOdds`.
 *
 * `null` is accepted by the signature only so that callers holding a `PotOdds` can
 * pass its `oddsRatio` straight in where they have already established that there is
 * a price (`priceLaidByBet` requires a positive bet, so its ratio is always one).
 * Reaching here with no price is a bug in this file, and it says so.
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
  /** `toCall / (pot + toCall)` — the equity at which calling neither gains nor loses. */
  readonly breakEvenEquity: number;
  /**
   * `pot / toCall` — "getting X to 1". `null` when the call is free, because there is
   * no price to quote rather than a price of zero or an infinite one. See the file
   * header for why it is `null` and not `Infinity`, `NaN` or `0`.
   */
  readonly oddsRatio: number | null;
  readonly explanation: string;
}

/**
 * The price hero is being laid on a call.
 *
 * @param pot chips already in the middle, EXCLUDING hero's call
 * @param toCall what hero must put in to continue; 0 when checking is free
 */
export function potOdds(pot: number, toCall: number): PotOdds {
  requireAmount(
    pot,
    'pot',
    'Pass the chips already in the middle, excluding the call hero is about to make.',
  );
  requireAmount(toCall, 'toCall', 'Pass what the call costs hero, or 0 when there is nothing to call.');

  // Both branches are written out rather than leaning on IEEE behaviour: with a pot
  // of 0 and nothing to call, `toCall / (pot + toCall)` is 0/0, and returning NaN
  // from a teaching tool is worse than returning nothing at all.
  const breakEvenEquity = toCall === 0 ? 0 : toCall / (pot + toCall);
  const oddsRatio = toCall === 0 ? null : pot / toCall;

  const explanation =
    toCall === 0
      ? 'Checking is free. There is nothing to call, so nothing to lose by continuing: the ' +
        `break-even equity is 0% and any chance of winning the ${units(pot)} in the middle is enough. ` +
        'There is no "X to 1" price because hero is not paying a price, which is why the ratio is ' +
        'reported as no price at all rather than as a number.'
      : `Hero risks ${units(toCall)} to win the ${units(pot)} already in the middle, a price of ` +
        `${ratioText(oddsRatio)}. Calling breaks even at ${units(toCall)} / (${units(pot)} + ` +
        `${units(toCall)}) = ${percent(breakEvenEquity)} equity: with less than that, calling loses ` +
        'units over many repetitions of this spot; with more, it gains them. The ' +
        `${units(pot)} is what is in the middle before hero's own ${units(toCall)} goes in — counting ` +
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
 * The largest out count for which the shortcut still lands on something that could be
 * a probability: 25 with two cards to come, 50 with one.
 *
 * `outs * multiplier` is a straight line; the quantity it approximates is a curve that
 * flattens as it approaches certainty. The line crosses 100 while the curve never does,
 * so past this count the shortcut stops being an approximation and starts being a
 * category error — 45 outs x 4 is "180%", which is not a bad estimate of a probability,
 * it is not a probability at all.
 *
 * Exported rather than inlined because `ruleOf24` refuses above it and callers have to
 * be able to ask *before* calling whether the shortcut applies at all, without catching
 * an exception to find out.
 */
export function maximumOutsForRuleOf24(cardsToCome: 1 | 2): number {
  const streets = requireCardsToCome(cardsToCome);
  return streets === 2 ? 25 : 50;
}

/**
 * The rule of 2 and 4: outs times 2 for one card to come, times 4 for two.
 *
 * The inaccuracy IS the teaching content here, so `caveat` names the direction and
 * the size of the error rather than hedging. Two things go wrong with the x4 form and
 * they are unrelated: it assumes hero gets to see both cards for the price being
 * quoted now (untrue as soon as a turn bet is coming), and the closed form it
 * approximates is not linear in the out count, so it drifts high as outs grow.
 *
 * This function deliberately does not take `unseen`, because that is the whole point
 * of a shortcut — it is the number a player can do in their head. `ruleOf24Accuracy`
 * is the function that puts it next to the truth.
 *
 * ## It refuses rather than returning a number above 100
 *
 * `outs * multiplier` is a line and the probability it stands in for is a curve that
 * flattens towards 1, so the two part company as the out count grows and the line
 * eventually leaves the unit interval altogether. A hand with 45 cards that improve it
 * is not a 180% favourite; it is a hand for which this shortcut has no meaning. Callers
 * that might be holding such a count check `maximumOutsForRuleOf24` first — the Coach
 * does, and refuses to publish the figure at all rather than clamping it, because a
 * clamped 100% would be a fabricated certainty rather than an honest silence.
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
    'card off a stub of about 46 cards is worth a little over 2%, so 2% per out per card is close ' +
    'enough to do in your head. Count clean outs only: a card that improves hero but hands an ' +
    'opponent a better hand at the same time is not an out, and counting it is a bigger error than ' +
    'anything the shortcut itself does.';

  const caveat =
    streets === 2
      ? 'The x4 form counts BOTH the turn and the river, which hero only gets to see for this price ' +
        'if there is no more betting. Call this bet and then face another on the turn and hero has ' +
        'paid for one card, not two, so x4 overstates what the call is buying. The error also grows ' +
        'with the out count: at 15 outs x4 says 60% where the exact figure with 47 cards unseen is ' +
        '54.1%, an overstatement of 5.9 points, while at 4 outs it slightly understates (16% against ' +
        '16.5%). Use it to sanity-check a decision, never to settle a close one.'
      : 'The x2 form charges 2% per out where one card off a 46-card stub is worth about 2.17%, so it ' +
        'understates, and always in the same direction: 9 outs is 19.6%, not 18%. The gap grows with ' +
        "the out count — 15 outs is 32.6% against the shortcut's 30%. It also assumes every out is " +
        'clean and that hitting wins, which on a board where hero is drawing to second best is the ' +
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
 * The shortcut next to the truth, so the UI can show a learner the real error
 * instead of asserting that the shortcut is fine.
 *
 * @param exactEquity the exact figure as a FRACTION in 0..1, not a percentage.
 *   Typically `probabilityOfHitting(...).probability` for a pure draw, or hero's
 *   enumerated equity when the draw is not clean.
 */
export function ruleOf24Accuracy(outs: number, cardsToCome: 1 | 2, exactEquity: number): RuleOfThumbAccuracy {
  // Validating the shortcut's own inputs first means a bad `outs` reports itself as
  // a bad `outs`, not as a mismatch against the exact figure.
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
  /** The arithmetic, written out, so the learner can follow it rather than trust it. */
  readonly derivation: string;
}

/**
 * The exact probability of hitting at least one of `outs` cards with `cardsToCome`
 * still to come, from `unseen` cards.
 *
 * Closed form by complementary counting: work out the chance of missing EVERY card
 * and subtract it from 1. The direct route — adding `outs/unseen` for the turn to
 * `outs/(unseen-1)` for the river — double counts every run-out that hits twice and
 * overstates the result (9 outs on the flop comes out 38.7% instead of 35.0%), which
 * is why the complement is the form worth writing down.
 *
 * Note what this is NOT: it is the chance of a card arriving, not the chance of
 * winning. It assumes every out wins and that no out hands an opponent something
 * better, which is an assumption about the hand rather than about the arithmetic.
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

  // Two cards. `misses < 2` is handled on its own rather than left to the general
  // formula: with `misses === 0` the second factor would be `-1/(unseen-1)`, and
  // getting the right answer out of a negative probability multiplied by zero is
  // luck, not arithmetic.
  if (misses < 2) {
    return {
      outs,
      unseen,
      cardsToCome: streets,
      probability: 1,
      derivation:
        misses === 0
          ? `Two cards to come with ${outs} outs and ${unseen} cards unseen: every card left in the ` +
            'stub is an out, so there is nothing that can miss and hitting is certain — 100%.'
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
 * Pot odds with future streets folded in: the call is cheaper than it looks if
 * hitting wins more chips later.
 *
 * The `assumptions` array is not decoration. `pot` and `toCall` can be read off the
 * table; `expectedAdditionalWinnings` is a forecast about a person, and it is the
 * term that turns a fold into a call. Presenting the three as one number without
 * saying which of them is a guess is exactly the habit this app exists to break.
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
  // `toCall === 0` short-circuits for the same reason as in `potOdds`: a free call
  // needs no equity at all, and with an empty pot the ratio would be 0/0.
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
      'It assumes hero gets paid when the draw comes in. An opponent who shuts down, or a card obvious ' +
        'enough to scare them, pays less than the estimate.',
      'It assumes that extra money only moves when hero hits. Chips lost on the streets where hero ' +
        'misses, or hits and is still second best, belong in reverse implied odds instead.',
      'It assumes the stacks contain it: nobody can pay hero more than they have behind, so the ' +
        'estimate can never exceed the effective stack.',
      'It says nothing about how often the opponent raises hero off the draw before the last card, ' +
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
 * The other half of the ledger: some hands keep costing money after the call.
 *
 * A dominated ace or a weak flush draw can arrive on the river and still be second
 * best, and the chips that go in on the way there are as real as the call itself.
 * The extra amount is added to BOTH sides — it is money hero pays (numerator) and
 * money that ends up in the pot hero is playing for (denominator) — which is what
 * makes the effective break-even equity strictly worse than the pot price whenever
 * the estimate is above zero.
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
  // `numerator === 0` means a free call with nothing expected to go wrong; anything
  // else makes the denominator positive, since the pot is never negative.
  const effectiveBreakEvenEquity = numerator === 0 ? 0 : numerator / denominator;
  const potPrice = potOdds(pot, toCall);
  const potPriceText = percent(potPrice.breakEvenEquity);

  const explanation =
    expectedAdditionalLosses === 0
      ? `With nothing extra expected to go in, this is just the pot price: ${potPriceText}. Setting ` +
        'the estimate to 0 is a claim that the hand is never going to cost hero more than this call.'
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
        'on the table tells hero what this hand will cost after the call.',
      'It counts two different futures at once: the times hero misses and pays anyway, and the times ' +
        'hero improves and is still beaten by the hands that pay off.',
      'Second-best hands are where this bites hardest. A hand that can only win small pots and lose ' +
        'big ones has reverse implied odds no pot price can rescue.',
      'Position changes the size of it. Out of position hero has to guess more often, and the cost of ' +
        'guessing wrong is what this estimate is trying to measure.',
      'Implied and reverse implied odds are estimates about the same future streets. Applying one and ' +
        'ignoring the other is how a call gets talked into existence.',
    ],
  };
}

export interface DefenceFrequency {
  readonly pot: number;
  readonly betSize: number;
  /** `pot / (pot + betSize)` — how often the bet must be called or raised. */
  readonly minimumDefenceFrequency: number;
  /** `betSize / (pot + betSize)` — the share of the time a pure bluff must work. */
  readonly alpha: number;
  readonly explanation: string;
  readonly caveat: string;
}

/**
 * Minimum defence frequency and alpha, the two halves of the bettor's indifference.
 *
 * A bluff of `betSize` into `pot` risks the bet to win the pot, so it breaks even
 * when it works `betSize / (pot + betSize)` of the time — that is `alpha`. Defending
 * the rest of the time, `pot / (pot + betSize)`, is what stops any two cards betting
 * at a profit. The two are complements by construction and always sum to 1.
 *
 * Note carefully that alpha is NOT the price the bet lays the caller. Same pot, same
 * bet, different questions: alpha asks how often a bluff needs to succeed, while
 * `priceLaidByBet` asks what equity a call needs. A pot-sized bet gives alpha = 50%
 * and a caller's break-even of 33.3%. Confusing the two is the single most common
 * error in poker writing about this arithmetic.
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
    `${percent(alpha)} of the time. That share is alpha. If hero folds more often than ` +
    `${percent(alpha)} here, any two cards can bet at a profit; defending — calling or raising — at ` +
    `least ${percent(minimumDefenceFrequency)} of the time takes that away. The two figures are the ` +
    'two halves of one whole, which is why they always add to 1.';

  const caveat =
    "This figure comes from the bettor's arithmetic, not from hero's hand. It assumes the bettor's " +
    'range is polarised into hands that want a call and hands that want a fold, that the hand ends ' +
    'here with no further betting, and that every hand hero defends with is worth defending. Against ' +
    'someone who never bluffs, folding far more than alpha is right and costs nothing; against ' +
    'someone who bluffs constantly, defending far more is. It also says nothing about WHICH hands to ' +
    'defend, which is the part that actually decides the spot. Treat it as a reference point, never ' +
    'as a quota to hit and never as the optimal frequency.';

  return { pot, betSize, minimumDefenceFrequency, alpha, explanation, caveat };
}

/**
 * The price a bet of `betSize` into `pot` lays the caller.
 *
 * The caller has to put in `betSize` to win the pot plus the bet, so their
 * break-even equity is `betSize / (pot + 2 * betSize)`. The bet is in the
 * denominator twice, and that is the whole trick: once as part of the money on
 * offer, once as the money the caller has to risk. Sanity anchor: a pot-sized bet
 * lays 2 to 1 and asks the caller for a third of the pot; a half-pot bet lays 3 to 1
 * and asks for a quarter.
 *
 * Implemented by handing `potOdds` a middle that already contains the bet, so the
 * two functions cannot disagree. In the returned value, `pot` is therefore the money
 * in the middle AFTER the bet and BEFORE the call (`pot + betSize`), and `toCall` is
 * `betSize`.
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

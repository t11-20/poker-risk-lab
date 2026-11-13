/**
 * Expected value of each action, in chips, measured against folding now.
 *
 * Folding is exactly 0, so chips already in the pot drop out of every branch.
 *
 *     EV(fold)  = 0
 *     EV(check) = e x pot
 *     EV(call)  = e x (pot + toCall) - toCall
 *     EV(bet)   = f x pot + (1 - f) x [ e x (pot + 2b) - b ]
 *     EV(raise) = f x pot + (1 - f) x [ e x (pot + c + 2r) - (c + r) ]
 *
 * `pot` is the chips in the middle before the action, including any bet being called. `e` is the
 * share of the pot won at showdown, `f` the opponent's fold frequency, `b` the bet, `c` what a
 * raiser must call first and `r` the raise on top of it.
 *
 * Each result carries `terms`, the branches with joint probabilities that sum to 1 over the action.
 * A term's `value` is net of the player's own chips. Contributions sum to `ev` to 1e-9.
 *
 * One action, then showdown. No raises, later streets, implied odds or rake. Each gap is named in
 * `assumptions` instead of being guessed.
 *
 * Pot odds, break-even call equity, MDF and alpha live in `odds.ts`. `breakEvenBluffFrequency`
 * reads alpha from there, and the tests assert it equals `requiredFoldEquity` at zero equity.
 */

import { chips, frac, percent, signedChips } from './format.ts';
import { defenceFrequency } from './odds.ts';

export class EvError extends Error {
  override readonly name = 'EvError';
}

/** One branch of an action: how often it happens and what it is worth. */
export interface EvTerm {
  readonly label: string;
  /** Joint probability of this branch. Term probabilities sum to 1. */
  readonly probability: number;
  /** Net chips this branch swings, relative to folding. */
  readonly value: number;
  /** `probability x value` — this branch's share of the EV. */
  readonly contribution: number;
}

export interface EvBreakdown {
  /** In chips, relative to folding. Folding is 0. */
  readonly ev: number;
  readonly terms: readonly EvTerm[];
  /** The formula with the numbers substituted in. */
  readonly derivation: string;
  readonly assumptions: readonly string[];
}

// Inputs arrive from HTTP bodies and scenario files, so every call validates them.

function requireFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new EvError(`${name} must be a finite number, received ${String(value)}`);
  }
}

function requireChips(name: string, value: number): void {
  requireFinite(name, value);
  if (value < 0) {
    throw new EvError(`${name} must be 0 or more chips, received ${value}`);
  }
}

function requirePositiveChips(name: string, value: number): void {
  requireFinite(name, value);
  if (value <= 0) {
    throw new EvError(`${name} must be more than 0 chips, received ${value} — a bet of 0 is a check`);
  }
}

function requireProbability(name: string, value: number): void {
  requireFinite(name, value);
  if (value < 0 || value > 1) {
    throw new EvError(`${name} must be a probability from 0 to 1 inclusive, received ${value}`);
  }
}

const ZERO_POINT_NOTE =
  'Folding is the zero point. Chips already in the pot are gone whatever you do, so every figure here is measured against folding right now, not against your stack at the start of the hand.';

const SHOWDOWN_NOTE =
  'One action, then the hand is assumed to run to showdown with no more betting — no later streets, no implied odds, nothing won or lost after this decision.';

const ESTIMATE_NOTE =
  'Equity and fold frequency are estimates you supplied. This EV is exactly as reliable as they are and no more, so treat it as the consequence of your read rather than as a measurement.';

const NO_RAKE_NOTE =
  'No rake or fee is taken. This is a play-money lab; a raked game would price slightly worse.';

const INDEPENDENCE_NOTE =
  'The fold frequency and the equity-when-called are treated as independent. Real opponents call with their stronger hands, so a genuine equity-when-called is usually lower than your equity against their whole range.';

const RAISE_WARNING_NOTE =
  'You have flagged that this opponent can raise, but the model ignores raises completely: it never charges you for being raised off a hand that had equity, and never charges you the extra chips you would pay when you are behind. Read the figure as optimistic — an upper bound on this bet, not a prediction.';

/** Folding, the baseline. It returns a full breakdown so the UI lays out every action in one shape. */
export function evOfFold(): EvBreakdown {
  return {
    ev: 0,
    terms: [
      {
        label: 'you fold and the hand is over for you',
        probability: 1,
        value: 0,
        contribution: 0,
      },
    ],
    derivation:
      'EV(fold) = 0 chips. Folding is the baseline every other action is measured against: it costs nothing further and risks nothing further.',
    assumptions: [
      ZERO_POINT_NOTE,
      'What you have already put in stays in the pot. Folding does not lose it again — it was lost when it went in.',
    ],
  };
}

/**
 * EV of calling. Pot 100, toCall 50 and equity 1/3 give exactly 0 (asserted in the tests).
 * `toCall = 0` is a check and is allowed. A free showdown is worth `e x pot`.
 */
export function evOfCall(input: { pot: number; toCall: number; equity: number }): EvBreakdown {
  requireChips('pot', input.pot);
  requireChips('toCall', input.toCall);
  requireProbability('equity', input.equity);

  const { pot, toCall, equity } = input;
  const ev = equity * (pot + toCall) - toCall;

  // The win branch is worth `pot`, not `pot + toCall`, because the call comes back out of the pot.
  const terms: EvTerm[] = [
    {
      label: 'you call and win the pot',
      probability: equity,
      value: pot,
      contribution: equity * pot,
    },
    {
      label: 'you call and lose',
      probability: 1 - equity,
      value: -toCall,
      contribution: -(1 - equity) * toCall,
    },
  ];

  return {
    ev,
    terms,
    derivation: `EV(call) = equity x (pot + toCall) - toCall = ${frac(equity)} x (${chips(pot)} + ${chips(toCall)}) - ${chips(toCall)} = ${chips(ev)} chips.`,
    assumptions: [
      ZERO_POINT_NOTE,
      `"Pot" is the ${chips(pot)} in the middle before your call, including the bet you are calling.`,
      SHOWDOWN_NOTE,
      `Equity of ${percent(equity)} is your share of the pot at showdown, ties included, against the hands they can actually hold here.`,
      ESTIMATE_NOTE,
      NO_RAKE_NOTE,
    ],
  };
}

/**
 * EV of checking, `e x pot`, which is `evOfCall` at `toCall = 0`. A check is never a literal 0,
 * because that would rank a fold level with a free look. The losing branch swings 0 since nothing
 * was risked.
 */
export function evOfCheck(input: { pot: number; equity: number }): EvBreakdown {
  const asFreeCall = evOfCall({ pot: input.pot, toCall: 0, equity: input.equity });
  const { pot, equity } = input;

  return {
    ...asFreeCall,
    terms: [
      {
        label: 'you check, see the hand out and win the pot',
        probability: equity,
        value: pot,
        contribution: equity * pot,
      },
      {
        label: 'you check, see the hand out and lose',
        probability: 1 - equity,
        value: 0,
        contribution: 0,
      },
    ],
    derivation:
      `EV(check) = equity x pot = ${frac(equity)} x ${chips(pot)} = ${chips(asFreeCall.ev)} chips. ` +
      'Checking costs nothing and keeps the hand, so it is a call priced at zero: it risks nothing and ' +
      'still holds a share of what is already in the middle. That share is what folding gives up, which ' +
      'is why a free check is never worse than a fold.',
    assumptions: [
      ZERO_POINT_NOTE,
      `"Pot" is the ${chips(pot)} in the middle right now. Nothing is added by checking.`,
      SHOWDOWN_NOTE,
      `Equity of ${percent(equity)} is your share of the pot at showdown, ties included, against the hands they can actually hold here.`,
      ESTIMATE_NOTE,
      NO_RAKE_NOTE,
    ],
  };
}

/**
 * `S = e x (pot + 2b) - b`, the EV of the branch where the bet is called. `betParts` and
 * `requiredFoldEquity` share this one copy, so the tested identity (S = 0 needs no folds) holds.
 * S is 0 at `e = b / (pot + 2b)`, the price the bet lays a caller.
 */
function calledBranchEv(pot: number, betSize: number, equityWhenCalled: number): number {
  return equityWhenCalled * (pot + 2 * betSize) - betSize;
}

/** The pieces of a bet's EV, shared by `evOfBet` and `evOfSemiBluff` so the two cannot drift apart. */
interface BetParts {
  /** `f x pot` — value that exists only because they sometimes fold. */
  readonly foldShare: number;
  /** `(1 - f) x showdownEv` — value from the times they call and it plays out. */
  readonly showdownShare: number;
  /** `e x (pot + 2b) - b` — EV of the called branch on its own. Signed. */
  readonly showdownEv: number;
  readonly ev: number;
  readonly terms: readonly EvTerm[];
}

function betParts(pot: number, betSize: number, foldProbability: number, equityWhenCalled: number): BetParts {
  const showdownEv = calledBranchEv(pot, betSize, equityWhenCalled);
  const foldShare = foldProbability * pot;
  const showdownShare = (1 - foldProbability) * showdownEv;
  const called = 1 - foldProbability;

  return {
    foldShare,
    showdownShare,
    showdownEv,
    // Summing the shares keeps `foldEquityShare + showdownShare === ev` exact for `evOfSemiBluff`.
    ev: foldShare + showdownShare,
    terms: [
      {
        label: 'they fold and you take the pot',
        probability: foldProbability,
        value: pot,
        contribution: foldShare,
      },
      {
        label: 'they call and you win at showdown',
        probability: called * equityWhenCalled,
        // You win the pot plus their call; your own bet comes back out of it.
        value: pot + betSize,
        contribution: called * equityWhenCalled * (pot + betSize),
      },
      {
        label: 'they call and you lose',
        probability: called * (1 - equityWhenCalled),
        value: -betSize,
        contribution: -called * (1 - equityWhenCalled) * betSize,
      },
    ],
  };
}

function betAssumptions(input: {
  pot: number;
  betSize: number;
  foldProbability: number;
  equityWhenCalled: number;
  callerCanRaise?: boolean;
}): string[] {
  const notes = [
    ZERO_POINT_NOTE,
    `"Pot" is the ${chips(input.pot)} in the middle before your bet of ${chips(input.betSize)}.`,
    `They fold ${percent(input.foldProbability)} of the time and otherwise call exactly ${chips(input.betSize)} — they never raise, and they always have enough chips to call in full.`,
    `When they call, your share of the pot at showdown is ${percent(input.equityWhenCalled)}.`,
    INDEPENDENCE_NOTE,
    SHOWDOWN_NOTE,
    ESTIMATE_NOTE,
    NO_RAKE_NOTE,
  ];
  if (input.callerCanRaise === true) notes.push(RAISE_WARNING_NOTE);
  return notes;
}

/**
 * EV of betting. f = 1 gives exactly `pot` and f = 0 gives the called branch (both asserted in the
 * tests). The EV is linear in f, which is why `requiredFoldEquity` has a closed form.
 */
export function evOfBet(input: {
  pot: number;
  betSize: number;
  foldProbability: number;
  equityWhenCalled: number;
  callerCanRaise?: boolean;
}): EvBreakdown {
  requireChips('pot', input.pot);
  requirePositiveChips('betSize', input.betSize);
  requireProbability('foldProbability', input.foldProbability);
  requireProbability('equityWhenCalled', input.equityWhenCalled);

  const { pot, betSize, foldProbability, equityWhenCalled } = input;
  const parts = betParts(pot, betSize, foldProbability, equityWhenCalled);

  return {
    ev: parts.ev,
    terms: parts.terms,
    derivation: `EV(bet) = f x pot + (1 - f) x [ e x (pot + 2b) - b ] = ${frac(foldProbability)} x ${chips(pot)} + ${frac(1 - foldProbability)} x [ ${frac(equityWhenCalled)} x (${chips(pot)} + 2 x ${chips(betSize)}) - ${chips(betSize)} ] = ${chips(parts.foldShare)} + ${signedChips(parts.showdownShare)} = ${chips(parts.ev)} chips.`,
    assumptions: betAssumptions(input),
  };
}

/**
 * EV of raising. The raiser risks `c + r`, the caller adds only `r`, and the final pot is
 * `pot + c + 2r`. Charging only `r` would overstate the EV by `(1 - f) x c x (1 - e)`.
 * Tested endpoints: `c = 0` equals `evOfBet(pot, r)`, `f = 1` gives `pot`, `f = 0` gives the called
 * branch. `risk` is returned so a learner can check the figure against it.
 */
export function evOfRaise(input: {
  /** Chips in the middle before the raise, including the bet being called. */
  pot: number;
  /** What must be called before raising. 0 is allowed and degenerates to a bet. */
  toCall: number;
  /** The raise on top of the call. Whole chips, more than 0. */
  raiseBy: number;
  foldProbability: number;
  equityWhenCalled: number;
  callerCanRaise?: boolean;
}): EvBreakdown & { readonly risk: number } {
  requireChips('pot', input.pot);
  requireChips('toCall', input.toCall);
  requirePositiveChips('raiseBy', input.raiseBy);
  requireProbability('foldProbability', input.foldProbability);
  requireProbability('equityWhenCalled', input.equityWhenCalled);

  const { pot, toCall, raiseBy, foldProbability, equityWhenCalled } = input;
  const risk = toCall + raiseBy;
  const finalPot = pot + toCall + 2 * raiseBy;
  const showdownEv = equityWhenCalled * finalPot - risk;
  const called = 1 - foldProbability;
  const foldShare = foldProbability * pot;
  const showdownShare = called * showdownEv;

  const terms: EvTerm[] = [
    {
      label: 'they fold and you take the pot',
      probability: foldProbability,
      value: pot,
      contribution: foldShare,
    },
    {
      label: 'they call the raise and you win at showdown',
      // The pot is `pot + c + 2r` and `c + r` of it was the raiser's, so the net swing is `pot + r`.
      probability: called * equityWhenCalled,
      value: pot + raiseBy,
      contribution: called * equityWhenCalled * (pot + raiseBy),
    },
    {
      label: 'they call the raise and you lose',
      probability: called * (1 - equityWhenCalled),
      value: -risk,
      contribution: -called * (1 - equityWhenCalled) * risk,
    },
  ];

  const notes = [
    ZERO_POINT_NOTE,
    `"Pot" is the ${chips(pot)} in the middle before you act, including the ${chips(toCall)} you have been asked to call.`,
    `Raising by ${chips(raiseBy)} while facing ${chips(toCall)} puts ${chips(risk)} of your own chips at risk, not ${chips(raiseBy)}. The call is part of the cost of raising.`,
    `They fold ${percent(foldProbability)} of the time and otherwise add exactly ${chips(raiseBy)} to match — they never re-raise, and they always have enough chips to call in full.`,
    `When they call, your share of the ${chips(finalPot)} pot at showdown is ${percent(equityWhenCalled)}.`,
    INDEPENDENCE_NOTE,
    SHOWDOWN_NOTE,
    ESTIMATE_NOTE,
    NO_RAKE_NOTE,
  ];
  if (input.callerCanRaise === true) notes.push(RAISE_WARNING_NOTE);

  return {
    ev: foldShare + showdownShare,
    risk,
    terms,
    derivation:
      'EV(raise) = f x pot + (1 - f) x [ e x (pot + c + 2r) - (c + r) ] = ' +
      `${frac(foldProbability)} x ${chips(pot)} + ${frac(called)} x [ ${frac(equityWhenCalled)} x (${chips(pot)} + ${chips(toCall)} + 2 x ${chips(raiseBy)}) - ${chips(risk)} ] = ` +
      `${chips(foldShare)} + ${signedChips(showdownShare)} = ${chips(foldShare + showdownShare)} chips. ` +
      `Risks ${chips(risk)} to win ${chips(pot)}.`,
    assumptions: notes,
  };
}

/**
 * How often they must fold for a bet to break even. With S the called-branch EV,
 * `EV(f) = S + f x (pot - S)`, so `f* = -S / (pot - S)`. At e = 0 this is alpha, `b / (pot + b)`,
 * and the tests check it against `breakEvenBluffFrequency`.
 *
 * The code branches on the sign of S, not on the fraction. S >= 0 needs no folds, and for S > pot
 * the fraction would exceed 1 on the most profitable bet. S < 0 gives a result in (0, 1] for any
 * non-negative pot. A value above 1 is reported unclamped.
 */
export function requiredFoldEquity(input: { pot: number; betSize: number; equityWhenCalled: number }): {
  readonly foldEquityNeeded: number;
  readonly explanation: string;
  readonly assumptions: readonly string[];
} {
  requireChips('pot', input.pot);
  requirePositiveChips('betSize', input.betSize);
  requireProbability('equityWhenCalled', input.equityWhenCalled);

  const { pot, betSize, equityWhenCalled } = input;
  const showdownEv = calledBranchEv(pot, betSize, equityWhenCalled);
  const assumptions = [
    ZERO_POINT_NOTE,
    `"Pot" is the ${chips(pot)} in the middle before your bet of ${chips(betSize)}.`,
    'This is the break-even point of the bet, not a claim about how often this opponent actually folds. Comparing the two is the decision; the number on its own is not.',
    'They only ever fold or call the exact bet — the model has no raise in it, and being raised would raise the fold frequency you need.',
    INDEPENDENCE_NOTE,
    SHOWDOWN_NOTE,
    NO_RAKE_NOTE,
  ];

  if (showdownEv >= 0) {
    const extra =
      showdownEv > pot
        ? ` In fact the called branch is worth ${chips(showdownEv)}, more than the ${chips(pot)} you win when they fold, so folds cost you value here — a call is the branch you want.`
        : '';
    return {
      foldEquityNeeded: 0,
      explanation: `This bet needs no fold equity. Called, it is worth ${frac(equityWhenCalled)} x (${chips(pot)} + 2 x ${chips(betSize)}) - ${chips(betSize)} = ${chips(showdownEv)} chips, which already breaks even, so the break-even fold frequency is 0.${extra}`,
      assumptions,
    };
  }

  // S < 0, so the slope (pot - S) is positive.
  const needed = -showdownEv / (pot - showdownEv);

  if (needed > 1) {
    return {
      foldEquityNeeded: needed,
      explanation: `This bet cannot break even at any fold frequency. Solving f x ${chips(pot)} + (1 - f) x ${signedChips(showdownEv)} = 0 gives f = ${frac(needed)}, which is above 1 — there is no fold frequency that reaches it, so no read on this opponent makes the bet break even. The figure is reported unclamped so the size of the gap is visible.`,
      assumptions,
    };
  }

  const certainty =
    needed === 1
      ? ' That is a certainty: with nothing in the pot to win there is no reward for a fold, so only folding every single time makes the bet break even, and even then it only breaks even.'
      : '';

  return {
    foldEquityNeeded: needed,
    explanation: `They must fold at least ${percent(needed)} of the time for this bet to break even. Called, the bet is worth ${chips(showdownEv)} chips, and a fold wins ${chips(pot)}, so f x ${chips(pot)} + (1 - f) x ${signedChips(showdownEv)} = 0 at f = ${frac(needed)}.${certainty}`,
    assumptions,
  };
}

/**
 * The same model as `evOfBet`, with the fold share (`f x pot`) and the showdown share
 * (`(1 - f) x S`) returned separately. They sum to `ev` exactly. A pure bluff has a negative
 * showdown share.
 */
export function evOfSemiBluff(input: {
  pot: number;
  betSize: number;
  foldProbability: number;
  equityWhenCalled: number;
}): EvBreakdown & { readonly foldEquityShare: number; readonly showdownShare: number } {
  requireChips('pot', input.pot);
  requirePositiveChips('betSize', input.betSize);
  requireProbability('foldProbability', input.foldProbability);
  requireProbability('equityWhenCalled', input.equityWhenCalled);

  const { pot, betSize, foldProbability, equityWhenCalled } = input;
  const parts = betParts(pot, betSize, foldProbability, equityWhenCalled);

  const shape =
    parts.showdownShare < 0
      ? `The showdown half is negative: ${percent(1 - foldProbability)} of the time they call and the hand is worth ${chips(parts.showdownEv)} chips, so the folds are paying for the calls.`
      : `Both halves are positive: the folds are worth ${chips(parts.foldShare)} and getting called is worth ${chips(parts.showdownShare)}, so this bet earns whether or not it works as a bluff.`;

  return {
    ev: parts.ev,
    foldEquityShare: parts.foldShare,
    showdownShare: parts.showdownShare,
    terms: parts.terms,
    derivation: `EV(semi-bluff) = [fold equity] + [showdown value] = f x pot + (1 - f) x [ e x (pot + 2b) - b ] = ${frac(foldProbability)} x ${chips(pot)} + ${frac(1 - foldProbability)} x ${signedChips(parts.showdownEv)} = ${chips(parts.foldShare)} + ${signedChips(parts.showdownShare)} = ${chips(parts.ev)} chips. ${shape}`,
    assumptions: [
      ...betAssumptions(input),
      "Equity when called is the draw's share of the pot once the board runs out — not the chance of hitting it on the next card, and not its equity against their whole range.",
      'Splitting the EV into fold equity and showdown value is a way of reading one number, not two separate bets. Neither half is available on its own.',
    ],
  };
}

/** How often a pure bluff must work to break even, `b / (pot + b)`. */
export function breakEvenBluffFrequency(
  pot: number,
  betSize: number,
): { readonly frequency: number; readonly explanation: string } {
  requireChips('pot', pot);
  requirePositiveChips('betSize', betSize);

  // Validated here so a bad input throws EvError, not OddsError. Alpha itself comes from odds.ts.
  const frequency = defenceFrequency(pot, betSize).alpha;
  return {
    frequency,
    explanation: `A pure bluff of ${chips(betSize)} into ${chips(pot)} risks ${chips(betSize)} to win ${chips(pot)}, so it must work ${percent(frequency)} of the time to break even: ${chips(betSize)} / (${chips(pot)} + ${chips(betSize)}) = ${frac(frequency)}. Larger bluffs must work more often. Whether this one does is a read on the opponent, which this figure does not contain.`,
  };
}

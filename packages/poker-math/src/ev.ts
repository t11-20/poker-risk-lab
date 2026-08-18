/**
 * Expected value of each action, measured against folding.
 *
 * ## Folding is the zero point
 *
 * Every figure in this file is the gain or loss compared with folding right now,
 * and folding is exactly 0. That is not a presentation choice — it is what makes
 * the chips already in the middle vanish from the arithmetic. They are gone
 * whichever action you pick, so charging them to one branch and not to another
 * double-counts money that is no longer yours. "I have already put in half my
 * stack, so I have to call" is the most expensive sentence in poker, and this zero
 * point is the smallest change that makes the sentence obviously wrong.
 *
 * ## The formulas
 *
 *     EV(fold)  = 0
 *     EV(check) = e x pot
 *     EV(call)  = e x (pot + toCall) - toCall
 *     EV(bet)   = f x pot + (1 - f) x [ e x (pot + 2b) - b ]
 *     EV(raise) = f x pot + (1 - f) x [ e x (pot + c + 2r) - (c + r) ]
 *
 * `EV(check)` is `EV(call)` at `toCall = 0`, and it is written on its own line because
 * the number it produces is the point: a check is never worth 0, it is worth whatever
 * share of the pot the hand still has. Fold and check are both "put no more chips in",
 * and only one of them keeps a claim on the middle.
 *
 * `pot` is what is in the middle BEFORE the action — for a call, and for a raise,
 * that already includes the bet being called. `e` is the share of the pot the hand
 * wins if the chips go in, `f` is how often the opponent folds, `b` is the bet, `c`
 * is what a raiser must call before raising and `r` is the raise on top of it.
 *
 * The bet formula is the call formula wearing a hat, and seeing that is worth more
 * than memorising either. Set f = 0 and what is left is `e x (pot + 2b) - b`, which
 * is precisely `EV(call)` for someone facing a bet of `b` into a pot of `pot + b`.
 * Betting and getting called costs what calling costs and pays what calling pays.
 * The only thing a bet adds is the fold branch — which is the entire reason to bet
 * a hand that cannot win a showdown.
 *
 * The raise formula is the bet formula with the call charged. A raiser risks `c + r`
 * to win `pot`, but the opponent only ever matches the `r`: the `c` was already
 * owed. So the risk grows by `c` while the pot on the called branch grows by only
 * `c + r`, and `EV(raise) = EV(bet at r) - (1 - f) x c x (1 - e)` exactly. Set
 * `c = 0` and the two formulas are the same expression — an opening bet is the
 * special case of a raise with nothing to call, which is why there is one function
 * per action and not one function pretending to cover both.
 *
 * ## Why every result carries `terms`
 *
 * A lone EV number is unfalsifiable to a learner: there is nothing in it to
 * disagree with. `terms` is the same figure split into the branches that actually
 * happen, each with the probability it happens, the net chips it swings, and its
 * contribution to the total, so a reader can point at the one line they think is
 * wrong. Term probabilities are joint (they sum to 1 across the whole action, not
 * to 1 within a branch) and `value` is always net of your own chips: when they fold
 * you win `pot` rather than `pot + b`, because `b` came back out of your own stack.
 *
 * Contributions sum to `ev`. `ev` is computed from the closed form above and the
 * terms are that same expression regrouped, so the two agree exactly in real
 * arithmetic and to floating-point rounding here — tests assert the identity to
 * 1e-9 rather than bit-for-bit, deliberately.
 *
 * ## What is deliberately not modelled
 *
 * One action, then the hand is assumed to run to showdown. No raise, no further
 * streets, no implied odds, no rake (this lab takes none). Each of those is a real
 * effect, and each would need an assumption about how the opponent plays. Burying
 * such a guess inside a number is how a guess becomes a fact, so instead the model
 * stays simple and every gap is named in `assumptions`. `callerCanRaise: true` is
 * the one place a caller can say "I know the raise is missing" and get the warning
 * attached to the figure; the model still does not attempt the raise, because a
 * number that came from an invented raising range teaches worse than a simple
 * number with an honest limitation printed next to it.
 *
 * ## Where prices live
 *
 * Prices live in `odds.ts` and expected values live here. Pot odds, break-even
 * equity for a call, minimum defence frequency and alpha all belong over there, so
 * that the package has exactly one definition of each and one place to be wrong.
 *
 * `breakEvenBluffFrequency` sits in this file because the Coach reads it next to a
 * bet's EV, but it does not restate the formula: it reads alpha from
 * `defenceFrequency` and explains it in the language of the bet rather than the
 * language of the defender. That it is *also* the f-intercept of the bet formula
 * above — `requiredFoldEquity` evaluated at zero equity — is a genuine identity
 * between two independent derivations, one solved out of the EV line here and one
 * computed from the price there, and the tests assert it holds.
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

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

// Inputs arrive from HTTP bodies and from scenario files, so these run on every
// call rather than being trusted from the type signature. Each one says what was
// wrong AND what was expected: a message like "invalid equity" sends the caller
// back to the source to find out what "valid" means.

function requireFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new EvError(`${name} must be a finite number, received ${String(value)}`);
  }
}

/** A chip amount: finite and not negative. Zero is allowed and is meaningful. */
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

// ---------------------------------------------------------------------------
// Shared assumption text
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Fold
// ---------------------------------------------------------------------------

/**
 * Folding, the baseline. Exactly 0, by construction rather than by calculation.
 *
 * It returns a full breakdown rather than a bare `0` so the UI can lay every
 * candidate action out in the same shape, and so the reason folding is zero is
 * carried with the zero instead of living in a comment somewhere else.
 */
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

// ---------------------------------------------------------------------------
// Call
// ---------------------------------------------------------------------------

/**
 * EV of calling: `e x (pot + toCall) - toCall`.
 *
 * Sanity check that must hold, and is asserted in the tests: pot 100, toCall 50,
 * equity 1/3 gives (1/3) x 150 - 50 = 0. A third of the time you win a 150 pot of
 * which 50 was yours; the rest of the time you are out 50. Break-even, exactly as
 * the price implies.
 *
 * `toCall` of 0 is allowed. It is not a call in the rules sense — it is a check —
 * but the arithmetic is still correct and useful: it says a free showdown is worth
 * `e x pot`, which is why giving up a hand you could see for free is never right.
 */
export function evOfCall(input: { pot: number; toCall: number; equity: number }): EvBreakdown {
  requireChips('pot', input.pot);
  requireChips('toCall', input.toCall);
  requireProbability('equity', input.equity);

  const { pot, toCall, equity } = input;
  const ev = equity * (pot + toCall) - toCall;

  // The win branch is worth `pot`, not `pot + toCall`: your own call comes back to
  // you out of the pot you win, so the net swing is the chips that were not yours.
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

// ---------------------------------------------------------------------------
// Check
// ---------------------------------------------------------------------------

/**
 * EV of checking: `e x pot`.
 *
 * A check is a call of nothing, so this is `evOfCall` with `toCall = 0` and it
 * delegates rather than restating the arithmetic. It exists as its own function for
 * one reason: a check is worth something, and writing it as a literal zero is how a
 * tool ends up ranking a fold above a free continuation.
 *
 * Zero is what *folding* is worth. Checking keeps the hand, and a hand kept is a claim
 * on the pot proportional to its equity, bought for nothing — so it is `e x pot`, which
 * is 0 only when the hand is drawing stone dead into an empty pot. There is no spot in
 * which folding beats checking, and this is the arithmetic that says so rather than a
 * rule bolted on afterwards.
 *
 * Both of the terms in the breakdown are net of nothing, because nothing was risked:
 * the losing branch swings 0 rather than a negative, which is exactly the difference
 * between this and a call.
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

// ---------------------------------------------------------------------------
// Bet
// ---------------------------------------------------------------------------

/**
 * `S = e x (pot + 2b) - b`, the EV of the branch where the bet gets called.
 *
 * `betParts` weights it by how often the bet is called; `requiredFoldEquity` solves
 * for the fold frequency that cancels it. Both had their own copy of the expression,
 * and one copy is enough: the identity the tests pin — a bet whose called branch
 * already breaks even needs no fold equity at all — is only meaningful if the two
 * functions are talking about the same S.
 *
 * The equity that makes this zero is exactly `b / (pot + 2b)`, the price the bet lays
 * a caller. That figure belongs to `odds.ts` and is not restated here; this is the
 * chips the bettor gains or loses on the called branch, which is a different
 * question about the same money.
 */
function calledBranchEv(pot: number, betSize: number, equityWhenCalled: number): number {
  return equityWhenCalled * (pot + 2 * betSize) - betSize;
}

/**
 * The pieces of a bet's EV, shared by `evOfBet` and `evOfSemiBluff` so the two can
 * never drift apart. `evOfSemiBluff` is not a different model, it is the same model
 * reported with its two halves named.
 */
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
    // Summing the two shares rather than re-evaluating the closed form keeps
    // `foldEquityShare + showdownShare === ev` exact for `evOfSemiBluff`, which is
    // the decomposition that whole function exists to show.
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
 * EV of betting: `f x pot + (1 - f) x [ e x (pot + 2b) - b ]`.
 *
 * Two endpoints worth holding on to, both asserted in the tests:
 *   * f = 1 gives exactly `pot` — they always fold, you always win what is there.
 *   * f = 0 gives exactly the called branch, which is the EV of calling `b` into a
 *     pot of `pot + b`.
 *
 * Between them the EV is a straight line in f, because the two branches do not
 * interact. That linearity is what makes `requiredFoldEquity` a closed form rather
 * than a search.
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

// ---------------------------------------------------------------------------
// Raise
// ---------------------------------------------------------------------------

/**
 * EV of raising: `f x pot + (1 - f) x [ e x (pot + c + 2r) - (c + r) ]`.
 *
 * ## Why this is not `evOfBet`
 *
 * A raise is not an opening bet with a different name, and treating it as one is the
 * single easiest way to make every aggressive line look better than it is. Facing `c`
 * and raising by `r`:
 *
 *   * the raiser puts `c + r` in, not `r` — the call is part of the price of raising;
 *   * the opponent, if they continue, adds only `r`, because their own `c` is already
 *     in the middle and counted inside `pot`;
 *   * so the final pot is `pot + (c + r) + r = pot + c + 2r`, of which `c + r` came
 *     out of the raiser's own stack.
 *
 * Winning it is therefore worth `pot + r` net, losing it costs `c + r`, and folding
 * them out wins `pot`. Weight those three by their probabilities and the closed form
 * above falls out. Charging only `r` — the mistake this function exists to make
 * impossible — overstates the EV by exactly `(1 - f) x c x (1 - e)`: always upward,
 * larger the bigger the bet faced and the *weaker* the hand, which is precisely where
 * a learner most needs the figure to be right.
 *
 * ## The endpoints, all asserted in the tests
 *
 *   * `c = 0` reproduces `evOfBet(pot, r)` exactly. An opening bet is a raise with
 *     nothing to call.
 *   * `f = 1` gives exactly `pot`: they always fold, the raise never gets matched,
 *     and the chips put out come straight back.
 *   * `f = 0` gives the called branch `e x (pot + c + 2r) - (c + r)`, which is
 *     `EV(call)` for someone calling `c + r` into a pot of `pot + r`.
 *
 * `risk` is returned alongside the breakdown because it is the number a learner
 * checks the figure against: a size label that says 133 next to a risk of 433 is how
 * a wrong EV hides in plain sight.
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
  // The called branch, written in the same shape as `calledBranchEv`: what the pot
  // pays when the chips go in, less what went in from this stack.
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
      // The pot is `pot + c + 2r` and `c + r` of it was yours, so the net swing is
      // `pot + r` — the money that was never yours to begin with.
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

// ---------------------------------------------------------------------------
// Required fold equity
// ---------------------------------------------------------------------------

/**
 * How often they must fold for a bet to break even.
 *
 * ## The derivation
 *
 * Write S for the EV of the called branch, S = e(pot + 2b) - b. Then
 *
 *     EV(f) = f x pot + (1 - f) x S
 *           = S + f x (pot - S)
 *
 * a straight line in f with intercept S and slope (pot - S). Setting it to zero:
 *
 *     f x (pot - S) = -S
 *     f* = -S / (pot - S)
 *
 * and substituting S back gives the closed form in terms of the inputs:
 *
 *     f* = ( b - e(pot + 2b) ) / ( pot + b - e(pot + 2b) )
 *
 * Two checks on that form:
 *   * e = 0, a pure bluff, gives f* = b / (pot + b) — alpha, which is what
 *     `breakEvenBluffFrequency` returns from its own separate formula. The tests
 *     assert the two agree, which is a real cross-check because neither is derived
 *     from the other in code.
 *   * e = b / (pot + 2b), exactly the price the bet lays a caller, makes S = 0 and
 *     therefore f* = 0: a bet that breaks even when called needs no folds at all.
 *
 * ## The degenerate branches, and why the code tests the sign of S
 *
 * The sign of S decides everything, so that — not the fraction — is what the code
 * branches on:
 *
 *   S >= 0. The bet already breaks even or better when it gets called, so it needs
 *     NO fold equity: return 0 and say so. If S is above `pot` this goes further:
 *     the called branch is worth more than the pot itself, so folds actively cost
 *     you value and "how often must they fold" is the wrong question about this
 *     bet. Note what the fraction above does in that case — the slope (pot - S)
 *     turns negative, the line crosses zero on the far side of f = 1, and the
 *     formula returns something above 1. Printing that as "impossible" would be
 *     exactly backwards for the most profitable bet in the model, which is why the
 *     sign of S is the test and the fraction is not.
 *
 *   S < 0. Then f* = |S| / (pot + |S|), which lands in (0, 1] for any pot that is
 *     not negative, and reaches 1 only when the pot is empty. So whenever there is
 *     something in the middle to win, enough folds always rescue a bet: the honest
 *     question is never "can this break even" but "is that fold frequency remotely
 *     plausible against this opponent". The above-1 case is still computed and
 *     reported plainly instead of being clamped — it is unreachable while the pot
 *     is not negative, and it is precisely what a caller must handle if this model
 *     is ever extended to a cost a fold does not cap, such as being raised off the
 *     hand.
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

  // S < 0, so the slope (pot - S) is strictly positive and the root is the honest
  // break-even fold frequency.
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

// ---------------------------------------------------------------------------
// Semi-bluff
// ---------------------------------------------------------------------------

/**
 * The same model as `evOfBet`, reported with its two halves named.
 *
 * The split is the entire lesson, so it is a return value rather than a comment:
 *
 *     foldEquityShare = f x pot                 value that exists only because
 *                                               they sometimes fold
 *     showdownShare   = (1 - f) x S             value from the times they call and
 *                                               the hand plays out
 *
 * and the two sum to `ev` exactly, because that is how `ev` is computed. A pure
 * bluff has `showdownShare` negative — it is the price of getting called — and all
 * of its value in the fold share. A hand with a real draw earns from both, which is
 * why a draw is so often worth more as a bet than as a call: the call branch buys
 * only the showdown share, and the bet branch buys both.
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

// ---------------------------------------------------------------------------
// Break-even bluff frequency (alpha)
// ---------------------------------------------------------------------------

/**
 * How often a pure bluff must work to break even: `b / (pot + b)`.
 *
 * Risk `b` to win `pot`; when it works you end up `pot` better off and when it does
 * not you are `b` worse off, so `f x pot = (1 - f) x b` and f = b / (pot + b).
 *
 * 50 into 100 must work a third of the time. A pot-sized bluff must work half the
 * time. A bluff of twice the pot must work two thirds of the time. That monotonic
 * relationship — bigger bluffs need to work more often — is the whole content of
 * the number, and it says nothing whatever about how often this opponent folds.
 */
export function breakEvenBluffFrequency(
  pot: number,
  betSize: number,
): { readonly frequency: number; readonly explanation: string } {
  requireChips('pot', pot);
  requirePositiveChips('betSize', betSize);

  // Validated here first, so a bad input reports an EvError from the function the
  // caller actually called rather than an OddsError from one it has never heard of.
  // The figure itself is alpha, and alpha belongs to odds.ts — this reads it from
  // there rather than restating `betSize / (pot + betSize)` and giving the package a
  // second place for that formula to be wrong.
  const frequency = defenceFrequency(pot, betSize).alpha;
  return {
    frequency,
    explanation: `A pure bluff of ${chips(betSize)} into ${chips(pot)} risks ${chips(betSize)} to win ${chips(pot)}, so it must work ${percent(frequency)} of the time to break even: ${chips(betSize)} / (${chips(pot)} + ${chips(betSize)}) = ${frac(frequency)}. Larger bluffs must work more often. Whether this one does is a read on the opponent, which this figure does not contain.`,
  };
}

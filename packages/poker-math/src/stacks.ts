/**
 * Stack depth: what can actually change hands, and what that does to the decision.
 *
 * ## Effective stack — the only stack that matters
 *
 * Table stakes cut both ways. Nobody can bet you off a hand by wagering more than
 * you can cover, and you cannot win more from an opponent than you yourself risked.
 * So the number that governs a hand is not your stack and not theirs, it is the
 * smaller of the two: `min(hero, deepest opponent)`. Chips above that line are not
 * in play, and counting them is how a player talks themselves into a decision the
 * chips could not have paid for.
 *
 * ## SPR, and why it is a shape rather than an answer
 *
 * `SPR = effective stack / pot`, read at the start of a street. It says how much
 * room is left to manoeuvre, and therefore *when* the commitment decision arrives —
 * at SPR 1 it has already arrived, at SPR 20 it is several streets away. What it
 * never says is what to do, and the `implication` strings here are written with that
 * constraint in mind: they describe what the depth does to the decision, and they do
 * not tell anybody which action to pick, because that depends on the hand, the
 * opponent's range and position, none of which SPR knows about.
 *
 * The band edges (1, 3, 6, 13) are conventional teaching landmarks, not thresholds
 * that anything discontinuous happens at. They are lower-inclusive and
 * upper-exclusive, with the top band opening strictly above 13, so every ratio lands
 * in exactly one band and the boundaries are pinned by tests rather than left to
 * whoever reads the comment next.
 *
 * ## The sizing ladder
 *
 * One bet size produces three numbers a learner needs side by side:
 *
 *     amount                = the chips you put out
 *     priceLaidToCaller     = b / (pot + 2b)   the equity a caller needs to break even
 *     minimumDefenceFrequency = pot / (pot + b) the share of their range that has to
 *                                               continue for a bluff not to print
 *
 * A pot-sized bet lays the caller exactly 1/3 and has an MDF of exactly 1/2 — those
 * two identities are asserted in the tests and are the anchors for reading the rest
 * of the ladder.
 *
 * Rung amounts are computed as `floor((pot x numerator) / denominator)`. The exact
 * fraction is taken first so an integral pot does not drift by a hundredth of a chip,
 * and the floor is then applied because **chips are integers everywhere in this app**
 * — the engine rejects a fractional bet, so a ladder rung that is not a whole number
 * is not a submittable action. `priceLaidToCaller` is derived from the rounded amount
 * rather than the ideal fraction, so the price shown is the price of the bet the
 * player can actually make. Rounding can collapse two rungs onto the same amount in a
 * very small pot; duplicates are dropped rather than shown twice.
 *
 * Neither price is worked out in this file. Both come from `odds.ts`, which owns
 * pricing for the whole package: `priceLaidByBet` for the caller's break-even equity
 * and `defenceFrequency` for MDF and alpha. Restating either formula here would give
 * the app two places to be right and two places to drift.
 *
 * ## Big blinds and M
 *
 * Both convert a raw stack into a unit that survives the blinds going up. Big blinds
 * measure buying power, M measures time: how many orbits a stack could sit out
 * before the forced bets ate it. M falls as blinds rise even when the stack does
 * not, which is the pressure a tournament applies and a cash game does not.
 *
 * The ante is where M implementations quietly disagree, so this one refuses to
 * guess. A traditional ante is posted by everyone at the table; a big-blind ante is
 * posted once by one player for the whole table. Those give M values a table-size
 * apart, so an ante supplied without `playersAtTable` throws instead of picking a
 * convention on the caller's behalf.
 */

import { chips, percent, ratio } from './format.ts';
import { type DefenceFrequency, defenceFrequency, priceLaidByBet } from './odds.ts';

export class StackError extends Error {
  override readonly name = 'StackError';
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function requireFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new StackError(`${name} must be a finite number, received ${String(value)}`);
  }
}

/** A chip amount: finite and not negative. Zero is allowed. */
function requireChips(name: string, value: number): void {
  requireFinite(name, value);
  if (value < 0) throw new StackError(`${name} must be 0 or more chips, received ${value}`);
}

/** A denominator: finite and strictly positive, so nothing here divides by zero. */
function requirePositiveChips(name: string, value: number): void {
  requireFinite(name, value);
  if (value <= 0) throw new StackError(`${name} must be more than 0 chips, received ${value}`);
}

// ---------------------------------------------------------------------------
// Effective stack
// ---------------------------------------------------------------------------

/**
 * The most that can change hands: `min(heroStack, max(opponentStacks))`.
 *
 * The `max` over opponents is not a typo. Against one opponent the effective stack
 * is the smaller of the two stacks; multiway, every opponent gives you a different
 * pair and therefore a different effective stack, and the single figure everyone
 * means by "the effective stack" is the deepest of those — the most that can move
 * against any one player. The explanation says so, because a learner reading one
 * number off a three-way pot needs to know it does not apply to the short stack in
 * the middle.
 */
export function effectiveStack(
  heroStack: number,
  opponentStacks: readonly number[],
): { readonly effective: number; readonly explanation: string } {
  requireChips('heroStack', heroStack);
  if (opponentStacks.length === 0) {
    throw new StackError('effectiveStack needs at least 1 opponent stack, received an empty list');
  }
  for (const [index, stack] of opponentStacks.entries()) {
    requireChips(`opponentStacks[${index}]`, stack);
  }

  let deepest = 0;
  for (const stack of opponentStacks) {
    if (stack > deepest) deepest = stack;
  }
  const effective = Math.min(heroStack, deepest);

  const core =
    heroStack <= deepest
      ? `Yours is the shorter stack: you have ${chips(heroStack)} and the deepest opponent has ${chips(deepest)}, so at most ${chips(effective)} can change hands. You can neither win nor lose more than you brought to the hand.`
      : `The deepest opponent has only ${chips(deepest)}, so at most ${chips(deepest)} can change hands even though you have ${chips(heroStack)}. The ${chips(heroStack - deepest)} above that is not in play this hand — nobody can pay you for it and nobody can take it.`;
  const multiway =
    opponentStacks.length > 1
      ? ` With ${opponentStacks.length} opponents each one has its own effective stack, the smaller of yours and theirs. ${chips(effective)} is the largest of them, so it is the most that can move against any single player and not the most you can lose across all of them.`
      : '';

  return { effective, explanation: `${core}${multiway}` };
}

// ---------------------------------------------------------------------------
// Stack-to-pot ratio
// ---------------------------------------------------------------------------

export type SprBand = 'very-low' | 'low' | 'medium' | 'high' | 'very-high';

export interface SprResult {
  readonly effectiveStack: number;
  readonly pot: number;
  readonly spr: number;
  readonly band: SprBand;
  readonly explanation: string;
  readonly implication: string;
}

/**
 * Band edges as documented at the top of the file: lower-inclusive,
 * upper-exclusive, with the top band opening strictly above 13. Written as a plain
 * chain rather than a table because a table with an inclusive top edge needs a
 * "nextAfter(13)" to express, and the chain is what the tests can pin exactly.
 */
function bandOf(spr: number): SprBand {
  if (spr < 1) return 'very-low';
  if (spr < 3) return 'low';
  if (spr < 6) return 'medium';
  if (spr <= 13) return 'high';
  return 'very-high';
}

/**
 * What the depth does to the decision. Deliberately free of instructions: each one
 * says when the commitment decision arrives and what room is left, and none of them
 * names an action, because SPR does not know your hand, their range or your
 * position. A test asserts these strings stay free of prescriptive language.
 */
const BAND_IMPLICATIONS: Record<SprBand, string> = {
  'very-low':
    'The pot is already larger than what is behind, so a single bet gets the rest of the stack in. There is no later street to hold chips back for: at this depth the decision is effectively made now.',
  low: 'One pot-sized bet and a call puts the stacks in. The live question on this street is whether you are committing, not what happens on the next one.',
  medium:
    'A bet and a raise, or two streets of betting, gets the stacks in. There is room for about one more decision after this one and not much more.',
  high: 'Several streets of betting fit before the stacks are in, so this decision mostly sets up the next one rather than settling the hand.',
  'very-high':
    'Almost all of the money is still behind. The pot in front of you is small compared with what can still go in, so the cost of a later error dwarfs what is at stake right now.',
};

const SPR_CAVEAT =
  ' SPR describes the shape of the decision, not the answer to it: your hand, their range and position all still apply.';

export function stackToPotRatio(effectiveStackSize: number, pot: number): SprResult {
  requireChips('effectiveStack', effectiveStackSize);
  requirePositiveChips('pot', pot);

  const spr = effectiveStackSize / pot;
  const band = bandOf(spr);

  return {
    effectiveStack: effectiveStackSize,
    pot,
    spr,
    band,
    explanation: `SPR = effective stack / pot = ${chips(effectiveStackSize)} / ${chips(pot)} = ${ratio(spr)}. There are ${ratio(spr)} pots behind, which is the "${band}" band.`,
    implication: `${BAND_IMPLICATIONS[band]}${SPR_CAVEAT}`,
  };
}

// ---------------------------------------------------------------------------
// Sizing ladder
// ---------------------------------------------------------------------------

export interface SizingOption {
  /** How a player would say it: "one third pot", "pot", "all-in". */
  readonly label: string;
  /**
   * `amount / pot` — the fraction this rung ACTUALLY is, after rounding to whole
   * chips, not the ideal fraction in its label. A "one third pot" rung in a pot of 100
   * is 33 chips and so reports 0.33, because the price beside it is the price of 33.
   */
  readonly fractionOfPot: number;
  /** Whole chips. Every figure on this rung is derived from this amount. */
  readonly amount: number;
  /** The caller's break-even equity: `b / (pot + 2b)`. */
  readonly priceLaidToCaller: number;
  /** `pot / (pot + b)`: the share of their range that has to continue. */
  readonly minimumDefenceFrequency: number;
  readonly note: string;
}

/**
 * Rungs as exact fractions rather than decimals, so the amount is
 * `floor((pot x numerator) / denominator)`. Taking the fraction exactly before
 * flooring is what makes an integral pot land where it should: `pot x 0.3333...` can
 * fall a hundredth of a chip short and then floor to one chip less than a third.
 */
const SIZING_RUNGS = [
  { numerator: 1, denominator: 4, label: 'one quarter pot' },
  { numerator: 1, denominator: 3, label: 'one third pot' },
  { numerator: 1, denominator: 2, label: 'half pot' },
  { numerator: 2, denominator: 3, label: 'two thirds pot' },
  { numerator: 3, denominator: 4, label: 'three quarters pot' },
  { numerator: 1, denominator: 1, label: 'pot' },
  { numerator: 3, denominator: 2, label: 'one and a half times pot' },
] as const;

function sizingNote(
  pot: number,
  amount: number,
  price: number,
  defence: DefenceFrequency,
  alsoAllIn: boolean,
): string {
  const allIn = alsoAllIn ? ' Betting this is your whole stack, so it is also an all-in.' : '';
  return `Risks ${chips(amount)} to win ${chips(pot)}. A caller needs ${percent(price)} equity to break even, and as a pure bluff it would have to work ${percent(defence.alpha)} of the time. For bluffs of this size not to print automatically, the player facing it has to continue with ${percent(defence.minimumDefenceFrequency)} of their range.${allIn}`;
}

function buildOption(
  pot: number,
  amount: number,
  fractionOfPot: number,
  label: string,
  alsoAllIn: boolean,
): SizingOption {
  // Both prices come from odds.ts rather than being restated here. That is the whole
  // point of having a pricing module: the ladder cannot drift away from the pot-odds
  // arithmetic the rest of the app quotes, because it is not doing its own.
  const price = priceLaidByBet(pot, amount);
  const defence = defenceFrequency(pot, amount);
  return {
    label,
    fractionOfPot,
    amount,
    priceLaidToCaller: price.breakEvenEquity,
    minimumDefenceFrequency: defence.minimumDefenceFrequency,
    note: sizingNote(pot, amount, price.breakEvenEquity, defence, alsoAllIn),
  };
}

/**
 * The usable bet sizes at this pot, each with the price it lays and the defence it
 * demands.
 *
 * Rungs above `maxBet` are dropped — offering a size the stack cannot pay for would
 * be worse than useless — and an all-in rung is appended. If the all-in happens to
 * land exactly on a fraction rung (a pot-sized bet with exactly a pot behind, say)
 * the two are not listed twice: the fraction rung keeps its more informative label
 * and its note records that the size is also an all-in. Exact equality is the right
 * test for that coincidence, because every rung amount is a whole number of chips.
 *
 * Two more rungs get dropped, both for the same reason — a rung has to be a bet
 * somebody could actually make. A fraction that rounds down to 0 chips is not a bet
 * at all (a quarter of a 3-chip pot), and a fraction that rounds onto an amount
 * already on the ladder is the same bet under a second name.
 *
 * A `maxBet` below every fraction leaves the all-in as the only rung, which is
 * itself worth seeing: at that depth there is no sizing decision left to make.
 */
export function sizingLadder(pot: number, maxBet: number): readonly SizingOption[] {
  requirePositiveChips('pot', pot);
  requirePositiveChips('maxBet', maxBet);

  const options: SizingOption[] = [];
  let allInAlreadyListed = false;

  const seenAmounts = new Set<number>();
  for (const rung of SIZING_RUNGS) {
    // Chips are integers everywhere in this app — the engine rejects a fractional bet
    // — so a ladder rung must round to a real, submittable amount. Rounding down keeps
    // the option inside `maxBet` and inside the pot fraction it claims to be, which
    // matters because the displayed price is computed from this amount.
    const amount = Math.floor((pot * rung.numerator) / rung.denominator);
    if (amount <= 0 || amount > maxBet) continue;
    // Rounding can collapse two rungs onto the same amount in a small pot.
    if (seenAmounts.has(amount)) continue;
    seenAmounts.add(amount);
    const isAllIn = amount === maxBet;
    if (isAllIn) allInAlreadyListed = true;
    options.push(buildOption(pot, amount, amount / pot, rung.label, isAllIn));
  }

  // Every rung kept above is at most maxBet, so if none of them WAS maxBet the
  // all-in is strictly larger than all of them and belongs at the end of the ladder.
  if (!allInAlreadyListed) {
    options.push(buildOption(pot, maxBet, maxBet / pot, 'all-in', true));
  }

  return options;
}

// ---------------------------------------------------------------------------
// Commitment
// ---------------------------------------------------------------------------

/**
 * What is left behind after one pot-sized bet is called.
 *
 * Bet the pot and get called and the pot is `3 x pot` with `effectiveStack - pot`
 * behind, so
 *
 *     SPR after = (effectiveStack - pot) / (3 x pot)
 *
 * The identity worth knowing falls straight out of that: at an SPR of exactly 4 the
 * figure is `(4p - p) / 3p = 1`, and an SPR of 1 is the depth at which the next
 * pot-sized bet is the whole stack. Two pot-sized bets, called, commit a stack that
 * started four pots deep — which is why "SPR 4" gets talked about as a commitment
 * threshold, and it is arithmetic rather than doctrine.
 *
 * When the pot is already at least as large as the effective stack, a pot-sized bet
 * does not exist: the stack goes in first and nothing is behind. That returns 0
 * rather than a negative SPR, and the note says why — clamping is only dishonest
 * when it is silent.
 */
export function commitmentThreshold(input: { effectiveStack: number; pot: number }): {
  readonly sprAfterPotSizedBet: number;
  readonly note: string;
  readonly assumptions: readonly string[];
} {
  requireChips('effectiveStack', input.effectiveStack);
  requirePositiveChips('pot', input.pot);

  const { effectiveStack: stack, pot } = input;
  const assumptions = [
    'One pot-sized bet and one call, on this street only. They do not raise, and they have enough chips to call in full.',
    'Nothing else goes in first — the pot given is the pot at the moment of the bet.',
    'A pot-sized bet is the yardstick here because it turns one pot into three and asks the caller for a third of the equity. A smaller sizing leaves more behind and pushes the commitment decision further out.',
    'This describes when the commitment decision arrives, not which action to take when it does.',
  ];

  if (stack <= pot) {
    return {
      sprAfterPotSizedBet: 0,
      note: `A pot-sized bet here is ${chips(pot)} but the effective stack is only ${chips(stack)}, so betting the pot means betting everything: there is no "after" to measure, and the SPR behind is 0. The commitment decision is this one.`,
      assumptions,
    };
  }

  const behind = stack - pot;
  const potAfter = 3 * pot;
  const sprAfter = behind / potAfter;
  const landmark =
    sprAfter <= 1
      ? ' That is 1 or below, so one more pot-sized bet puts the rest in: the stacks are two called bets from being all-in.'
      : ' That is above 1, so even a second pot-sized bet leaves chips behind: the stacks are at least three called bets from being all-in.';

  return {
    sprAfterPotSizedBet: sprAfter,
    note: `Bet the pot (${chips(pot)}) and get called: the pot becomes ${chips(potAfter)} and you have ${chips(behind)} behind, an SPR of ${ratio(sprAfter)}.${landmark}`,
    assumptions,
  };
}

// ---------------------------------------------------------------------------
// Stack depth in big blinds, and M
// ---------------------------------------------------------------------------

/** Stack depth in big blinds — buying power, in a unit that survives a blind rise. */
export function stackInBigBlinds(
  stack: number,
  bigBlind: number,
): { readonly bb: number; readonly note: string } {
  requireChips('stack', stack);
  requirePositiveChips('bigBlind', bigBlind);

  const bb = stack / bigBlind;
  return {
    bb,
    note: `${chips(stack)} with a big blind of ${chips(bigBlind)} is ${ratio(bb)} big blinds. Counting in big blinds rather than chips is what makes two stacks comparable across different blind levels: the same 2000 chips is a deep stack at 10/20 and a short one at 200/400.`,
  };
}

/**
 * The tournament M-ratio: how many orbits a stack could sit out before the forced
 * bets ate it.
 *
 *     M = stack / (smallBlind + bigBlind + ante x playersAtTable)
 *
 * `playersAtTable` is how many players post `ante` each orbit. For a traditional
 * ante that is everyone at the table. For a big-blind ante, where one player posts
 * for the whole table, pass the total as `ante` with `playersAtTable: 1`.
 *
 * With no ante the ante term is 0 and M is `stack / (smallBlind + bigBlind)`. With
 * an ante and no `playersAtTable` this throws rather than guessing: the two
 * conventions differ by a factor of the table size, so a default here would silently
 * change every M in the app by up to 9x.
 */
export function mRatio(input: {
  stack: number;
  smallBlind: number;
  bigBlind: number;
  ante?: number;
  playersAtTable?: number;
}): { readonly m: number; readonly explanation: string } {
  requireChips('stack', input.stack);
  requireChips('smallBlind', input.smallBlind);
  requirePositiveChips('bigBlind', input.bigBlind);

  const ante = input.ante;
  const playersAtTable = input.playersAtTable;
  if (ante !== undefined) requireChips('ante', ante);
  if (playersAtTable !== undefined) {
    requireFinite('playersAtTable', playersAtTable);
    if (!Number.isInteger(playersAtTable) || playersAtTable < 1) {
      throw new StackError(`playersAtTable must be a whole number of 1 or more, received ${playersAtTable}`);
    }
  }
  if (ante !== undefined && ante > 0 && playersAtTable === undefined) {
    throw new StackError(
      `an ante of ${ante} was given without playersAtTable, so the antes collected each orbit are unknown: a traditional ante is posted by every player, a big-blind ante by one player for the table, and the two give M values a table-size apart. Pass playersAtTable (use 1 for a big-blind ante posted as a single total).`,
    );
  }

  const antesPerOrbit = ante === undefined || ante === 0 ? 0 : ante * (playersAtTable ?? 0);
  const perOrbit = input.smallBlind + input.bigBlind + antesPerOrbit;
  const m = input.stack / perOrbit;

  const anteClause =
    antesPerOrbit > 0
      ? playersAtTable === 1
        ? ` The ${chips(antesPerOrbit)} of antes is a single total posted once for the table, which is how a big-blind ante is entered here.`
        : ` The ${chips(antesPerOrbit)} of antes is ${chips(ante ?? 0)} from each of ${String(playersAtTable ?? 0)} players.`
      : ' There is no ante, so the ante term is 0.';

  return {
    m,
    explanation: `M = stack / (small blind + big blind + antes per orbit) = ${chips(input.stack)} / (${chips(input.smallBlind)} + ${chips(input.bigBlind)} + ${chips(antesPerOrbit)}) = ${chips(input.stack)} / ${chips(perOrbit)} = ${ratio(m)}.${anteClause} The stack could sit out ${ratio(m)} full orbits before the forced bets consumed it. M measures time pressure, so it falls as the blinds rise even when the stack does not change, and it says nothing on its own about which hands to play.`,
  };
}

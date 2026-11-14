/**
 * Stack depth: effective stack, SPR, the sizing ladder, big blinds and M.
 *
 * SPR bands have edges 1, 3, 6, 13 (conventional teaching landmarks). They are lower-inclusive and
 * upper-exclusive, with the top band strictly above 13, and the tests pin the boundaries. The
 * `implication` strings describe what depth does to the decision and never name an action.
 *
 * Chips are integers everywhere in this app, so ladder rungs are `floor((pot x num) / den)` and each
 * price is computed from the rounded amount. Prices come from `odds.ts`, never restated here.
 * A pot-sized bet lays the caller exactly 1/3 with an MDF of exactly 1/2 (asserted in the tests).
 */

import { chips, percent, ratio } from './format.ts';
import { type DefenceFrequency, defenceFrequency, priceLaidByBet } from './odds.ts';

export class StackError extends Error {
  override readonly name = 'StackError';
}

function requireFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new StackError(`${name} must be a finite number, received ${String(value)}`);
  }
}

function requireChips(name: string, value: number): void {
  requireFinite(name, value);
  if (value < 0) throw new StackError(`${name} must be 0 or more chips, received ${value}`);
}

/** A denominator: finite and strictly positive, so nothing here divides by zero. */
function requirePositiveChips(name: string, value: number): void {
  requireFinite(name, value);
  if (value <= 0) throw new StackError(`${name} must be more than 0 chips, received ${value}`);
}

/**
 * The most that can change hands, `min(heroStack, max(opponentStacks))`. Multiway, each opponent has
 * its own effective stack, and this is the deepest of them. The explanation says so.
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

  // With every opponent all in, `deepest` is 0. The general sentence would call hero's chips "not in
  // play" while the Coach prices a call from them, so the betting being over gets its own sentence.
  const core =
    deepest === 0
      ? `Every opponent is already all in, so there is no more betting: the only chips that can still move are the ones in front of you now. Your remaining ${chips(heroStack)} is not a betting stack this hand, it is what you would call from.`
      : heroStack <= deepest
        ? `Yours is the shorter stack: you have ${chips(heroStack)} and the deepest opponent has ${chips(deepest)}, so at most ${chips(effective)} can change hands. You can neither win nor lose more than you brought to the hand.`
        : `The deepest opponent has only ${chips(deepest)}, so at most ${chips(deepest)} can change hands even though you have ${chips(heroStack)}. The ${chips(heroStack - deepest)} above that is not in play this hand — nobody can pay you for it and nobody can take it.`;
  const multiway =
    opponentStacks.length > 1
      ? ` With ${opponentStacks.length} opponents each one has its own effective stack, the smaller of yours and theirs. ${chips(effective)} is the largest of them, so it is the most that can move against any single player and not the most you can lose across all of them.`
      : '';

  return { effective, explanation: `${core}${multiway}` };
}

export type SprBand = 'very-low' | 'low' | 'medium' | 'high' | 'very-high';

export interface SprResult {
  readonly effectiveStack: number;
  readonly pot: number;
  readonly spr: number;
  readonly band: SprBand;
  readonly explanation: string;
  readonly implication: string;
}

/** The band for a ratio, and the only classifier, so no panel can show two bands for one SPR. */
export function sprBandFor(spr: number): SprBand {
  return bandOf(spr);
}

function bandOf(spr: number): SprBand {
  if (spr < 1) return 'very-low';
  if (spr < 3) return 'low';
  if (spr < 6) return 'medium';
  if (spr <= 13) return 'high';
  return 'very-high';
}

/** What the depth does to the decision. A test asserts these strings name no action. */
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

export interface SizingOption {
  /** How a player would say it: "one third pot", "pot", "all-in". */
  readonly label: string;
  /** `amount / pot` after rounding to whole chips, not the ideal fraction in the label. */
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
 * Rungs as exact fractions, so `pot x 0.3333...` cannot fall short and floor to one chip under a third.
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
 * One size, priced the same way as a ladder rung. The Coach uses it for the sizes the table's bar
 * offers (`offeredSizes` in `./table-sizing.ts`). `fractionOfPot` is the fraction the amount is.
 */
export function sizingOptionAt(pot: number, amount: number, label: string, isAllIn: boolean): SizingOption {
  requirePositiveChips('pot', pot);
  requirePositiveChips('amount', amount);
  return buildOption(pot, amount, amount / pot, label, isAllIn);
}

/**
 * The usable bet sizes at this pot, each with the price it lays and the defence it demands.
 *
 * Rungs above `maxBet`, rungs that round to 0 chips and rungs that duplicate an amount are dropped.
 * An all-in rung is appended, unless it equals a fraction rung exactly. That rung keeps its label and
 * its note records the all-in.
 */
export function sizingLadder(pot: number, maxBet: number): readonly SizingOption[] {
  requirePositiveChips('pot', pot);
  requirePositiveChips('maxBet', maxBet);

  const options: SizingOption[] = [];
  let allInAlreadyListed = false;

  const seenAmounts = new Set<number>();
  for (const rung of SIZING_RUNGS) {
    // Rounding down keeps the rung inside `maxBet` and inside the fraction it claims.
    const amount = Math.floor((pot * rung.numerator) / rung.denominator);
    if (amount <= 0 || amount > maxBet) continue;
    if (seenAmounts.has(amount)) continue;
    seenAmounts.add(amount);
    const isAllIn = amount === maxBet;
    if (isAllIn) allInAlreadyListed = true;
    options.push(buildOption(pot, amount, amount / pot, rung.label, isAllIn));
  }

  // No kept rung was maxBet, so the all-in is larger than all of them and goes last.
  if (!allInAlreadyListed) {
    options.push(buildOption(pot, maxBet, maxBet / pot, 'all-in', true));
  }

  return options;
}

/**
 * SPR left after one pot-sized bet is called, `(effectiveStack - pot) / (3 x pot)`. At SPR 4 this is
 * exactly 1, so two called pot-sized bets commit the stack. When the pot is at least the effective
 * stack this returns 0, and the note says why.
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

/** Stack depth in big blinds. */
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
 * The tournament M-ratio, `M = stack / (smallBlind + bigBlind + ante x playersAtTable)`.
 *
 * For a traditional ante `playersAtTable` is everyone. For a big-blind ante pass the total as `ante`
 * with `playersAtTable: 1`. An ante without `playersAtTable` throws, because the two conventions
 * differ by up to 9x.
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

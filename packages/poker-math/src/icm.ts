/**
 * Tournament equity by Malmuth–Harville. A player's chance of each place is their share of the chips
 * still in play, applied place by place. With a prize ladder a chip won is worth less than a chip lost.
 * With a single prize, equity is exactly stack share times the prize, and `assumptions` says which.
 * The recursion is memoised on the set of finished players as a bitmask (the set's size implies the
 * place), so it costs 2^n x n, 512 x 9 at the cap. A zero stack has already finished, takes the lowest
 * open places, and shares their prizes equally with any other zero stack.
 */

import { assertDistinctCards, type Card, cardsToString, DECK_SIZE, popCount13 } from '@prl/poker-engine';
import { choose, equity } from './equity.ts';
import { exactRange, parseRange } from './ranges.ts';

export class IcmError extends Error {
  override readonly name = 'IcmError';
}

/**
 * The model ignores blind pressure, skill and future structure, which is a stretch at a final table
 * and false across a large field. That binds long before the 2^n cost does.
 */
export const MAX_ICM_PLAYERS = 9;

export interface IcmResult {
  readonly stacks: readonly number[];
  readonly payouts: readonly number[];
  /** Expected prize per player, in prize units, same order as `stacks`. */
  readonly equities: readonly number[];
  readonly totalPrizePool: number;
  readonly method: 'malmuth-harville';
  readonly explanation: string;
  readonly assumptions: readonly string[];
}

function validateNumbers(values: readonly number[], what: string): void {
  for (const [index, value] of values.entries()) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new IcmError(`${what}[${index}] must be a finite number, received ${String(value)}`);
    }
    if (value < 0) {
      throw new IcmError(`${what}[${index}] must not be negative, received ${value}`);
    }
  }
}

function sum(values: readonly number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

function validateIcmInput(stacks: readonly number[], payouts: readonly number[]): void {
  if (stacks.length < 2) {
    throw new IcmError(`ICM needs at least 2 players, received ${stacks.length}`);
  }
  if (stacks.length > MAX_ICM_PLAYERS) {
    throw new IcmError(
      `ICM is capped at ${MAX_ICM_PLAYERS} players, received ${stacks.length}. The cap is deliberate: ` +
        "the recursion grows with the number of paid places, and the model's assumptions (no blind " +
        'pressure, no skill edge) stop being defensible in a large field.',
    );
  }
  validateNumbers(stacks, 'stacks');
  validateNumbers(payouts, 'payouts');
  if (payouts.length === 0) {
    throw new IcmError('payouts must list at least one paid place');
  }
  if (payouts.length > stacks.length) {
    throw new IcmError(
      `payouts lists ${payouts.length} paid places but only ${stacks.length} players are in the model; ` +
        'drop the places that have already been decided so the prize pool matches the players left',
    );
  }
  if (sum(stacks) <= 0) {
    throw new IcmError('at least one player must have chips; every stack was zero');
  }
}

/** Every stack must be positive. `payouts[k]` pays place k+1, and later places pay nothing. */
function malmuthHarville(stacks: readonly number[], payouts: readonly number[]): number[] {
  const playerCount = stacks.length;
  const total = sum(stacks);
  const subsetCount = 1 << playerCount;

  // Each subset's chip total is its lowest member plus the total of the rest.
  const subsetStack = new Float64Array(subsetCount);
  for (let mask = 1; mask < subsetCount; mask++) {
    const lowestBit = mask & -mask;
    const lowestIndex = 31 - Math.clz32(lowestBit);
    const stack = stacks[lowestIndex];
    if (stack === undefined) throw new IcmError(`stack index ${lowestIndex} is missing`);
    subsetStack[mask] = stack + (subsetStack[mask ^ lowestBit] ?? 0);
  }

  // Q(mask) is the probability that exactly the players in `mask` take the top |mask| places.
  // Q(S) = sum over j in S of Q(S \ j) x stack_j / (total - stack(S \ j)).
  const memo = new Float64Array(subsetCount);
  const memoFilled = new Uint8Array(subsetCount);

  const topSetProbability = (mask: number): number => {
    if (mask === 0) return 1;
    if (memoFilled[mask] === 1) return memo[mask] ?? 0;
    let accumulated = 0;
    let remainingBits = mask;
    while (remainingBits !== 0) {
      const bit = remainingBits & -remainingBits;
      remainingBits ^= bit;
      const finisher = 31 - Math.clz32(bit);
      const without = mask ^ bit;
      // Positive, because `finisher` is not in `without` and holds chips.
      const pool = total - (subsetStack[without] ?? 0);
      if (pool <= 0) throw new IcmError('ICM recursion reached an empty chip pool; stacks must be positive');
      const stack = stacks[finisher];
      if (stack === undefined) throw new IcmError(`stack index ${finisher} is missing`);
      accumulated += topSetProbability(without) * (stack / pool);
    }
    memo[mask] = accumulated;
    memoFilled[mask] = 1;
    return accumulated;
  };

  const paidPlaces = Math.min(payouts.length, playerCount);
  const equities = new Array<number>(playerCount).fill(0);

  for (let mask = 0; mask < subsetCount; mask++) {
    // A 9-bit mask fits the engine's 13-bit popcount.
    const placeIndex = popCount13(mask);
    if (placeIndex >= paidPlaces) continue;
    const prize = payouts[placeIndex] ?? 0;
    if (prize === 0) continue;
    const alreadyFinished = topSetProbability(mask);
    if (alreadyFinished === 0) continue;
    const pool = total - (subsetStack[mask] ?? 0);
    if (pool <= 0) continue;
    for (let player = 0; player < playerCount; player++) {
      if (((mask >> player) & 1) === 1) continue;
      const stack = stacks[player];
      if (stack === undefined) throw new IcmError(`stack index ${player} is missing`);
      equities[player] = (equities[player] ?? 0) + alreadyFinished * (stack / pool) * prize;
    }
  }
  return equities;
}

function icmAssumptions(bustedCount: number, playerCount: number, payouts: readonly number[]): string[] {
  // With one paid place ICM is linear in chips, so the concavity note would be false there.
  const onlyFirstPlacePays = payouts.slice(1).every((prize) => prize === 0);
  const notes = [
    "Finish probabilities come straight from chip counts: a player's chance of winning is taken as " +
      'their share of the chips in play, and nothing else is modelled.',
    'No skill, position, table image or reads. Two players with equal stacks are given equal equity ' +
      'regardless of how well either plays.',
    'No blind pressure and no future structure: the model does not know that a 3-big-blind stack must ' +
      'commit within an orbit while a 40-big-blind stack can wait.',
    'Malmuth–Harville is a well-known approximation, not a solved answer. Other ICM models disagree ' +
      'with it, and all of them disagree with what actually happens at a table.',
    onlyFirstPlacePays
      ? 'This structure pays a single place, and that is the one case where ICM equity is exactly ' +
        'proportional to chips: doubling a stack doubles its equity, chips won are worth exactly what ' +
        'chips lost are worth, and there is no survival premium at all. Chip EV and prize EV agree here — ' +
        'add a second paid place and they stop agreeing.'
      : 'The practical consequence, which is the reason to look at these numbers at all: with a prize ' +
        'ladder, chips won are worth LESS per chip than chips lost. Doubling a stack gains less than ' +
        'double the equity, while busting takes all of it. That is why survival gains value near the ' +
        'money, and why a coinflip that breaks even in chips is usually a loss in prize equity.',
    'Every figure assumes the tournament is played to the end with these stacks and this structure; no ' +
      'deal, no rebuy, no late registration.',
    'Stacks and prizes are the same free, valueless practice units used everywhere in this app. Nothing ' +
      'here converts to money.',
  ];
  if (bustedCount > 0) {
    notes.push(
      bustedCount === 1
        ? 'One player has no chips and is treated as already finished, taking the lowest place still available.'
        : `${bustedCount} of the ${playerCount} players have no chips. They are treated as already ` +
            'finished in the lowest available places, and because the model has nothing to separate them ' +
            "they share those places' prizes equally.",
    );
  }
  return notes;
}

/**
 * `payouts[0]` is first place. It may not list more places than players, because that would pool
 * prizes for finishes already decided.
 */
export function icmEquity(stacks: readonly number[], payouts: readonly number[]): IcmResult {
  validateIcmInput(stacks, payouts);

  const playerCount = stacks.length;
  const totalChips = sum(stacks);
  const totalPrizePool = sum(payouts);

  const aliveIndices: number[] = [];
  const bustedIndices: number[] = [];
  for (const [index, stack] of stacks.entries()) {
    if (stack > 0) aliveIndices.push(index);
    else bustedIndices.push(index);
  }

  const equities = new Array<number>(playerCount).fill(0);

  if (bustedIndices.length > 0) {
    // Zero stacks take places aliveCount..playerCount-1 and share them, since nothing orders them.
    let bottomPrizes = 0;
    for (let place = aliveIndices.length; place < playerCount; place++) {
      bottomPrizes += payouts[place] ?? 0;
    }
    const perBusted = bottomPrizes / bustedIndices.length;
    for (const index of bustedIndices) equities[index] = perBusted;
  }

  if (aliveIndices.length === 1) {
    const winner = aliveIndices[0];
    if (winner === undefined) throw new IcmError('alive player index is missing');
    equities[winner] = payouts[0] ?? 0;
  } else {
    const aliveStacks: number[] = [];
    for (const index of aliveIndices) {
      const stack = stacks[index];
      if (stack === undefined) throw new IcmError(`stack index ${index} is missing`);
      aliveStacks.push(stack);
    }
    const alivePayouts = payouts.slice(0, aliveIndices.length);
    const aliveEquities = malmuthHarville(aliveStacks, alivePayouts);
    for (const [position, index] of aliveIndices.entries()) {
      equities[index] = aliveEquities[position] ?? 0;
    }
  }

  const shareLines = stacks.map((stack, index) => {
    const chipShare = totalChips === 0 ? 0 : (stack / totalChips) * 100;
    const prizeShare = totalPrizePool === 0 ? 0 : ((equities[index] ?? 0) / totalPrizePool) * 100;
    return `player ${index} holds ${chipShare.toFixed(1)}% of the chips and ${prizeShare.toFixed(1)}% of the prize pool`;
  });

  const explanation =
    `${playerCount} players, ${totalChips.toLocaleString('en-US')} chips in play and a prize pool of ` +
    `${totalPrizePool.toLocaleString('en-US')} units across ${payouts.length} paid ` +
    `${payouts.length === 1 ? 'place' : 'places'}. Malmuth–Harville takes each player's chance of ` +
    'finishing first to be their share of the chips, then repeats that with the winner and their chips ' +
    `removed for second place, and so on down the ladder. The result: ${shareLines.join('; ')}. Where a ` +
    'chip share is larger than the matching prize share, those chips are worth less than their face ' +
    'value; that gap is the whole of tournament chip value.';

  return {
    stacks: [...stacks],
    payouts: [...payouts],
    equities,
    totalPrizePool,
    method: 'malmuth-harville',
    explanation,
    assumptions: icmAssumptions(bustedIndices.length, playerCount, payouts),
  };
}

export interface IcmDecision {
  /** Expected chips gained by taking the spot, relative to hero's stack now. */
  readonly chipEv: number;
  /** Expected prize equity gained, in prize units, relative to hero's equity now. */
  readonly icmEv: number;
  /**
   * `icmEv` minus `chipEv` converted at `prizePool / totalChips`. Negative means the spot is worth
   * less than its chips at face value, the usual case for a marginal all-in.
   */
  readonly divergence: number;
  readonly explanation: string;
}

/**
 * One spot in chips and in prize equity. The outcomes are full stack vectors in `stacks` order, and
 * each must total the same chips as `stacks` or it throws. The two EVs stay in their own units, and
 * `divergence` alone compares them, at the flat prize-pool-per-chip rate.
 */
export function icmVsChipEv(input: {
  stacks: readonly number[];
  payouts: readonly number[];
  heroIndex: number;
  outcomeIfWin: readonly number[];
  outcomeIfLose: readonly number[];
  winProbability: number;
}): IcmDecision {
  const { stacks, payouts, heroIndex, outcomeIfWin, outcomeIfLose, winProbability } = input;
  validateIcmInput(stacks, payouts);
  if (!Number.isInteger(heroIndex) || heroIndex < 0 || heroIndex >= stacks.length) {
    throw new IcmError(`heroIndex must be an integer in 0..${stacks.length - 1}, received ${heroIndex}`);
  }
  if (typeof winProbability !== 'number' || !Number.isFinite(winProbability)) {
    throw new IcmError(`winProbability must be a finite number, received ${String(winProbability)}`);
  }
  if (winProbability < 0 || winProbability > 1) {
    throw new IcmError(`winProbability must be between 0 and 1, received ${winProbability}`);
  }

  const totalChips = sum(stacks);
  for (const [label, outcome] of [
    ['outcomeIfWin', outcomeIfWin],
    ['outcomeIfLose', outcomeIfLose],
  ] as const) {
    if (outcome.length !== stacks.length) {
      throw new IcmError(
        `${label} must list one stack per player (${stacks.length}), received ${outcome.length}`,
      );
    }
    validateNumbers(outcome, label);
    const outcomeTotal = sum(outcome);
    // Relative, because chip counts can be large and a split pot leaves fractions.
    if (Math.abs(outcomeTotal - totalChips) > 1e-9 * Math.max(1, totalChips)) {
      throw new IcmError(
        `${label} totals ${outcomeTotal} chips but the table holds ${totalChips}; chips are neither ` +
          'created nor destroyed by a hand, so one of the two is wrong',
      );
    }
  }

  const now = icmEquity(stacks, payouts);
  const ifWin = icmEquity(outcomeIfWin, payouts);
  const ifLose = icmEquity(outcomeIfLose, payouts);

  const stackNow = stacks[heroIndex] ?? 0;
  const stackIfWin = outcomeIfWin[heroIndex] ?? 0;
  const stackIfLose = outcomeIfLose[heroIndex] ?? 0;
  const equityNow = now.equities[heroIndex] ?? 0;
  const equityIfWin = ifWin.equities[heroIndex] ?? 0;
  const equityIfLose = ifLose.equities[heroIndex] ?? 0;

  const loseProbability = 1 - winProbability;
  const chipEv = winProbability * (stackIfWin - stackNow) + loseProbability * (stackIfLose - stackNow);
  const icmEv = winProbability * equityIfWin + loseProbability * equityIfLose - equityNow;

  const prizePerChip = totalChips === 0 ? 0 : now.totalPrizePool / totalChips;
  const divergence = icmEv - chipEv * prizePerChip;

  const explanation =
    `You (player ${heroIndex}) win this spot ${(winProbability * 100).toFixed(1)}% of the time, going ` +
    `from ${stackNow.toLocaleString('en-US')} chips to ${stackIfWin.toLocaleString('en-US')}, and loses it ` +
    `${(loseProbability * 100).toFixed(1)}% of the time, going to ` +
    `${stackIfLose.toLocaleString('en-US')}. In chips that is ${chipEv >= 0 ? '+' : ''}${chipEv.toFixed(2)} ` +
    `on average. In prize equity it moves you from ${equityNow.toFixed(2)} units to an average of ` +
    `${(equityNow + icmEv).toFixed(2)}, a change of ${icmEv >= 0 ? '+' : ''}${icmEv.toFixed(2)} units. ` +
    `Converting the chip figure at the flat rate of ${prizePerChip.toFixed(5)} units per chip would have ` +
    `predicted ${(chipEv * prizePerChip).toFixed(2)} units, so the prize ladder is worth ` +
    `${divergence >= 0 ? '+' : ''}${divergence.toFixed(2)} units ${divergence >= 0 ? 'more' : 'less'} than ` +
    'treating chips as money. Both figures rest on the ICM assumptions listed with the equities.';

  return { chipEv, icmEv, divergence, explanation };
}

export interface PushFoldResult {
  /** Hero's two cards, e.g. "As Kh". */
  readonly heroCards: string;
  readonly stackBb: number;
  readonly callerRange: string;
  /** Expected chips, in big blinds, relative to hero's stack before posting. */
  readonly chipEvOfPush: number;
  /** Also relative to hero's stack before posting, so it is negative by construction. */
  readonly chipEvOfFold: number;
  readonly pushIsBetterInChips: boolean;
  /** Hero's pot share when the shove is called. */
  readonly equityWhenCalled: number;
  readonly foldProbability: number;
  readonly explanation: string;
  readonly assumptions: readonly string[];
}

/**
 * 20,000 trials put the 95% interval on hero's pot share at ±0.5 to ±0.7 points, about ±0.27 big
 * blinds of chip EV at 20 big blinds against a range that always calls. The floor refuses a figure
 * too noisy to act on. The ceiling keeps one call from holding a request handler.
 */
const DEFAULT_PUSH_FOLD_SAMPLES = 20_000;
const MIN_PUSH_FOLD_SAMPLES = 1_000;
const MAX_PUSH_FOLD_SAMPLES = 200_000;
const DEFAULT_PUSH_FOLD_SEED = 20_260_817;

function bigBlinds(amount: number): string {
  return `${amount} big blind${amount === 1 ? '' : 's'}`;
}

/**
 * Chip EV of a heads-up small-blind shove against a stated calling range, with no prize ladder.
 * The shove ends the betting, so there are three outcomes and no postflop play.
 * Bad cards and ranges throw the engine's `CardParseError` and `RangeParseError` unwrapped, because
 * those messages name the offending token.
 */
export function pushFoldChipEv(input: {
  heroCards: readonly Card[];
  stackBb: number;
  smallBlindBb: number;
  bigBlindBb: number;
  callerRangeNotation: string;
  anteBb?: number;
  samples?: number;
  seed?: number;
}): PushFoldResult {
  const { heroCards, stackBb, smallBlindBb, bigBlindBb, callerRangeNotation } = input;
  const anteBb = input.anteBb ?? 0;
  const samples = input.samples ?? DEFAULT_PUSH_FOLD_SAMPLES;
  const seed = input.seed ?? DEFAULT_PUSH_FOLD_SEED;

  if (heroCards.length !== 2) {
    throw new IcmError(`heroCards must be exactly 2 cards, received ${heroCards.length}`);
  }
  assertDistinctCards(heroCards, 'heroCards');
  for (const [label, value] of [
    ['stackBb', stackBb],
    ['smallBlindBb', smallBlindBb],
    ['bigBlindBb', bigBlindBb],
    ['anteBb', anteBb],
  ] as const) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new IcmError(`${label} must be a finite number, received ${String(value)}`);
    }
  }
  if (smallBlindBb <= 0 || bigBlindBb <= 0) {
    throw new IcmError(
      `blinds must be positive, received smallBlind ${smallBlindBb}, bigBlind ${bigBlindBb}`,
    );
  }
  if (smallBlindBb > bigBlindBb) {
    throw new IcmError(`the small blind (${smallBlindBb}) cannot exceed the big blind (${bigBlindBb})`);
  }
  if (anteBb < 0) throw new IcmError(`anteBb must not be negative, received ${anteBb}`);
  if (stackBb < bigBlindBb + anteBb) {
    throw new IcmError(
      `stackBb must be at least the big blind plus the ante (${bigBlindBb + anteBb}), received ${stackBb}. ` +
        'Below that the big blind has already put in more than hero has, so shoving is not a decision.',
    );
  }
  if (!Number.isInteger(samples)) {
    throw new IcmError(`samples must be an integer, received ${samples}`);
  }
  if (samples < MIN_PUSH_FOLD_SAMPLES || samples > MAX_PUSH_FOLD_SAMPLES) {
    throw new IcmError(
      `samples must be between ${MIN_PUSH_FOLD_SAMPLES} and ${MAX_PUSH_FOLD_SAMPLES}, received ${samples}`,
    );
  }
  if (!Number.isInteger(seed)) {
    throw new IcmError(`seed must be an integer so the figure is reproducible, received ${seed}`);
  }

  // Hero's cards are removed from the calling range, or its strong combinations are overcounted.
  const callerRange = parseRange(callerRangeNotation, heroCards);
  if (callerRange.combos.length === 0) {
    throw new IcmError(
      `the calling range "${callerRangeNotation}" has no combinations left once hero's cards are removed`,
    );
  }

  // The share of the caller's possible holdings the assumed range excludes.
  const availableCombos = choose(DECK_SIZE - heroCards.length, 2);
  const callingCombos = callerRange.combos.length;
  const foldProbability = 1 - callingCombos / availableCombos;
  const callProbability = 1 - foldProbability;

  const equityResult = equity(
    {
      players: [
        { label: 'you', range: exactRange(heroCards) },
        { label: "the big blind's calling range", range: callerRange },
      ],
      board: [],
    },
    { samples, seed },
  );
  const hero = equityResult.players[0];
  if (hero === undefined) throw new IcmError('equity result carried no players');
  const equityWhenCalled = hero.equity;

  // Both EVs are against hero's stack before posting, so the posted blind and ante cost both
  // branches. Called, hero wins `equityWhenCalled` of 2 x stackBb against the stackBb put in.
  const wonWhenFoldedTo = bigBlindBb + anteBb;
  const netWhenCalled = 2 * stackBb * equityWhenCalled - stackBb;
  const chipEvOfPush = foldProbability * wonWhenFoldedTo + callProbability * netWhenCalled;
  const chipEvOfFold = -(smallBlindBb + anteBb);

  const sampled = equityResult.method === 'monte-carlo';
  const halfWidth = equityResult.confidence?.halfWidthPoints ?? 0;

  const explanation =
    `You hold ${cardsToString(heroCards)} and shove ${bigBlinds(stackBb)} from the small blind. The big ` +
    `blind is assumed to call with "${callerRangeNotation}" — ${callingCombos} of the ` +
    `${availableCombos} two-card combinations they can hold — so they fold ` +
    `${(foldProbability * 100).toFixed(1)}% of the time. When they fold, you win the ` +
    `${bigBlinds(wonWhenFoldedTo)} already posted by the big blind. Called, you take ` +
    `${(equityWhenCalled * 100).toFixed(1)}% of a ${2 * stackBb} big blind pot, worth ` +
    `${(2 * stackBb * equityWhenCalled).toFixed(2)}, against the ${stackBb} put in — a net of ` +
    `${netWhenCalled >= 0 ? '+' : ''}${netWhenCalled.toFixed(2)}. Weighting those: pushing is worth ` +
    `${chipEvOfPush >= 0 ? '+' : ''}${chipEvOfPush.toFixed(3)} big blinds and folding is worth ` +
    `${chipEvOfFold.toFixed(3)} (the posted small blind and ante are gone either way), so ` +
    `${chipEvOfPush > chipEvOfFold ? 'pushing' : 'folding'} is better in chips by ` +
    `${Math.abs(chipEvOfPush - chipEvOfFold).toFixed(3)} big blinds.`;

  const assumptions = [
    'Chip EV only. No prize ladder, no ICM, no later hands — pass the same spot to icmVsChipEv to see ' +
      'what a payout structure does to it, because it often reverses the answer.',
    'Heads-up: you in the small blind, one big blind behind, nobody else in the hand.',
    `The big blind has at least as many chips as you, so a call makes the pot exactly ${2 * stackBb} big blinds with nothing ` +
      'returned.',
    `The caller's hand is uniform over the ${availableCombos} combinations that exclude your two cards. ` +
      `They call with all ${callingCombos} combinations in the stated range and fold every other one, so ` +
      `the ${(foldProbability * 100).toFixed(1)}% fold frequency is a property of that assumed range — ` +
      'not a read on any person, and not what a real opponent does.',
    'The stated range is the whole of the opponent model. A tighter or looser caller changes the answer, ' +
      'so treat the range as the input it is.',
    'The shove is all-in, so there is no postflop play and no further betting to model.',
    sampled
      ? `Your equity when called is estimated from ${equityResult.trials.toLocaleString('en-US')} sampled ` +
        `run-outs, 95% within ±${halfWidth.toFixed(2)} percentage points, which moves the chip EV of the ` +
        `push by at most ±${((2 * stackBb * callProbability * halfWidth) / 100).toFixed(3)} big blinds.`
      : 'Your equity when called is computed by enumerating every remaining board, so it carries no ' +
        'sampling error.',
    'Blinds, antes and stacks are free, valueless practice units. Nothing here converts to money.',
  ];

  return {
    heroCards: cardsToString(heroCards),
    stackBb,
    callerRange: callerRangeNotation,
    chipEvOfPush,
    chipEvOfFold,
    pushIsBetterInChips: chipEvOfPush > chipEvOfFold,
    equityWhenCalled,
    foldProbability,
    explanation,
    assumptions,
  };
}

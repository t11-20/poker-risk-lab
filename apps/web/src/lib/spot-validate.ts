/**
 * The one way from a draft to a `Spot`. Every rule answers with a plain sentence keyed to the field it
 * is about, and a draft with any error yields no spot, so the editor never prices a half-valid one.
 * `test/lab-spot-validate.test.ts` holds each rule to its message, and holds that a spot this passes
 * makes `buildCoachReport` throw only when its ranges overlap too much to sample, which
 * `reportForSpot` names.
 */

import { type ParsedRange, parseRange } from '@prl/poker-math';
import { formatChips } from '@prl/ui/format';
import {
  BOARD_SLOTS,
  type Board,
  type CardSlotId,
  cardName,
  handKey,
  MAX_CHIPS,
  MAX_NAME_LENGTH,
  MAX_OPPONENTS,
  MAX_RANGE_LENGTH,
  type OpponentDraft,
  type OpponentHand,
  type Spot,
  type SpotDraft,
  type SpotOpponent,
} from './spot.ts';

export type OpponentField = 'name' | 'stack' | 'bet' | 'range' | 'cards';

/** `opponent.<key>.<field>` for a seat's own fields, so an error survives a seat being removed above it. */
export type FieldKey =
  | 'name'
  | 'hole'
  | 'board'
  | 'heroStack'
  | 'heroBet'
  | 'potBefore'
  | 'bigBlind'
  | 'foldRate'
  | 'opponents'
  | `opponent.${string}.${OpponentField}`;

export function opponentField(key: string, field: OpponentField): FieldKey {
  return `opponent.${key}.${field}`;
}

export type FieldErrors = ReadonlyMap<FieldKey, string>;

export type Validation =
  /** `dealChecked` is false when the ranges overlap too much to check quickly that all can be dealt. */
  | { readonly ok: true; readonly spot: Spot; readonly dealChecked: boolean }
  | { readonly ok: false; readonly errors: FieldErrors };

const TOP_PERCENT = /^top:(\d{1,3})$/iu;

/** `top:NN` as a percentage, `null` for any other text. Expanding it is left to the analysis thread. */
export function topPercentOf(text: string): number | null {
  const match = TOP_PERCENT.exec(text.trim());
  return match?.[1] === undefined ? null : Number(match[1]);
}

type Parsed<T> = { readonly value: T } | { readonly error: string };

function chips(text: string, missing: string): Parsed<number> {
  const trimmed = text.trim();
  if (trimmed === '') return { error: missing };
  if (!/^\d+$/u.test(trimmed)) return { error: 'Use a whole number of chips, like 250.' };
  const value = Number(trimmed);
  if (value > MAX_CHIPS) return { error: `Keep it to ${formatChips(MAX_CHIPS)} chips or fewer.` };
  return { value };
}

/**
 * Through the decimal string rather than `/ 100`, which turns 33.3 into 0.33299999999999996, so a
 * stated rate reaches the analysis as the number its author wrote.
 */
function percent(text: string): Parsed<number | null> {
  const trimmed = text.trim();
  if (trimmed === '') return { value: null };
  const match = /^(\d{1,3})(?:\.(\d))?$/u.exec(trimmed);
  const tenths = match?.[1] === undefined ? null : Number(match[1]) * 10 + Number(match[2] ?? 0);
  if (tenths === null || tenths > 1000)
    return { error: 'Enter a percentage from 0 to 100, or leave it blank.' };
  return { value: Number(`${tenths}e-3`) };
}

function label(text: string, what: 'spot' | 'opponent'): Parsed<string> {
  const trimmed = text.trim();
  if (trimmed === '')
    return { error: what === 'spot' ? 'Give the spot a name.' : 'Give this opponent a name.' };
  if (trimmed.length > MAX_NAME_LENGTH) return { error: `Keep the name to ${MAX_NAME_LENGTH} characters.` };
  // The analysis words hero as "you", so an opponent called that would read as the reader.
  if (what === 'opponent' && trimmed.toLowerCase() === 'you') {
    return { error: 'Use another name. The analysis calls you "you".' };
  }
  return { value: trimmed };
}

/** The board in street order, or why the slots do not make one. */
function readBoard(cards: SpotDraft['cards']): Parsed<Board> {
  const [f1, f2, f3, turn, river] = BOARD_SLOTS.map((slot) => cards[slot]);
  const flop = [f1, f2, f3].filter((card) => card !== null && card !== undefined);
  if (flop.length > 0 && flop.length < 3) return { error: 'The flop needs all three cards, or none.' };
  if (turn != null && flop.length < 3) return { error: 'Add the flop before the turn.' };
  if (river != null && turn == null) return { error: 'Add the turn before the river.' };
  if (f1 == null || f2 == null || f3 == null) return { value: [] };
  if (turn == null) return { value: [f1, f2, f3] };
  if (river == null) return { value: [f1, f2, f3, turn] };
  return { value: [f1, f2, f3, turn, river] };
}

interface RangeCheck {
  readonly hand: OpponentHand | null;
  readonly error: string | null;
  /** Combinations, for the dealability check. `null` for `top:NN`, which the analysis thread expands. */
  readonly combos: ParsedRange['combos'] | null;
}

function readHand(opponent: OpponentDraft, dead: readonly number[], name: string): RangeCheck {
  if (opponent.handKind === 'none') return { hand: { kind: 'none' }, error: null, combos: [] };
  if (opponent.handKind === 'cards') {
    const [a, b] = opponent.cards;
    if (a === null || b === null) return { hand: null, error: `Pick both of ${name}'s cards.`, combos: null };
    return { hand: { kind: 'cards', cards: [a, b] }, error: null, combos: [[a, b]] };
  }
  const text = opponent.range.trim();
  if (text === '') return { hand: null, error: 'Enter a range, like QQ+, AKs.', combos: null };
  if (text.length > MAX_RANGE_LENGTH) {
    return { hand: null, error: `Keep the range to ${MAX_RANGE_LENGTH} characters.`, combos: null };
  }
  if (/^top:/iu.test(text)) {
    const share = topPercentOf(text);
    if (share === null || share < 1 || share > 100) {
      return { hand: null, error: 'Use top: with a whole number from 1 to 100, like top:20.', combos: null };
    }
    return { hand: { kind: 'range', text }, error: null, combos: null };
  }
  let parsed: ParsedRange;
  try {
    parsed = parseRange(text, dead);
  } catch {
    return {
      hand: null,
      error:
        'This range could not be read. Write hands like AA, KQs, T9o, 22-66 or A2s+, with commas between.',
      combos: null,
    };
  }
  if (parsed.combos.length === 0) {
    return { hand: null, error: 'Every hand in this range uses a card already in play.', combos: null };
  }
  return { hand: { kind: 'range', text }, error: null, combos: parsed.combos };
}

type Combo = readonly [number, number];

/** The search's running count of combos looked at, by the walk and by the cover bound alike. */
interface Meter {
  work: number;
}

/**
 * At most one hand per card of `cover`, when every combo holds one of its cards, so fewer cover cards
 * than opponents proves no deal exists. Greedy, which can only overstate the cover: never a false refusal.
 */
function coverSize(open: readonly (readonly Combo[])[], enough: number, meter: Meter): number {
  let left = open.flat();
  let size = 0;
  while (left.length > 0 && size < enough) {
    meter.work += 2 * left.length + 52;
    const counts = new Uint16Array(52);
    for (const [a, b] of left) {
      counts[a] = (counts[a] ?? 0) + 1;
      counts[b] = (counts[b] ?? 0) + 1;
    }
    const card = counts.indexOf(Math.max(...counts));
    left = left.filter(([a, b]) => a !== card && b !== card);
    size += 1;
  }
  return size;
}

/**
 * Work, counted as `Meter` counts it, before the search gives up and says so. Five seats of
 * "A2s+, A2o+, KK, QQ" behind AhAs on Kc Qd 7h, which neither bound refuses, reach it in 15 ms warm
 * and 18 ms on a first call, on an M-series laptop. Answers are cached, so only a range change pays.
 */
export const DEAL_SEARCH_BUDGET = 1_000_000;

export interface DealSearch {
  /** `null` when the budget ran out first. */
  readonly answer: boolean | null;
  /** Combos looked at by this call, so 0 for an answer from the cache. */
  readonly work: number;
}

/** Keyed on the combos themselves, so a keystroke in a name or a stack never searches again. */
const answers = new Map<string, boolean | null>();
const ANSWERS_KEPT = 64;

/**
 * Whether one hand per opponent can be dealt with no card twice. Smallest range first, and the cover
 * bound cuts a branch before it is walked.
 */
export function dealSearch(hands: readonly (readonly Combo[])[]): DealSearch {
  const key = hands.map((combos) => combos.map(([a, b]) => a * 52 + b).join(',')).join('|');
  const known = answers.get(key);
  if (known !== undefined) return { answer: known, work: 0 };
  const used = new Uint8Array(52);
  const meter: Meter = { work: 0 };
  const search = (left: readonly (readonly Combo[])[]): boolean | null => {
    if (left.length === 0) return true;
    if (meter.work > DEAL_SEARCH_BUDGET) return null;
    const open = left.map((combos) => combos.filter(([a, b]) => used[a] === 0 && used[b] === 0));
    for (const combos of left) meter.work += combos.length;
    if (open.some((combos) => combos.length === 0)) return false;
    if (coverSize(open, open.length, meter) < open.length) return false;
    let pick = 0;
    for (const [index, combos] of open.entries()) if (combos.length < (open[pick]?.length ?? 0)) pick = index;
    const rest = open.filter((_combos, index) => index !== pick);
    for (const [a, b] of open[pick] ?? []) {
      used[a] = 1;
      used[b] = 1;
      const found = search(rest);
      used[a] = 0;
      used[b] = 0;
      if (found !== false) return found;
    }
    return false;
  };
  const answer = search(hands);
  if (answers.size >= ANSWERS_KEPT) answers.delete(answers.keys().next().value ?? '');
  answers.set(key, answer);
  return { answer, work: meter.work };
}

export function canDealAll(hands: readonly (readonly Combo[])[]): boolean | null {
  return dealSearch(hands).answer;
}

/** A seat the dealability check reads: its name and number, for a sentence naming seats, and its hands. */
export interface DealSeat {
  readonly name: string;
  /** From 1, in the editor's order, for when two seats share a name. */
  readonly seat: number;
  readonly combos: readonly Combo[];
}

export type Dealability =
  | { readonly kind: 'dealable' }
  | { readonly kind: 'undealable'; readonly sentence: string }
  /** The search ran out of budget, so the analysis is left to find out. */
  | { readonly kind: 'unchecked' };

/** "Villain and Villain" tells the reader nothing, so a name two seats share gives way to the seat number. */
function listed(seats: readonly DealSeat[]): string {
  const names = seats.map(({ name, seat }) =>
    seats.filter((other) => other.name === name).length > 1 ? `Opponent ${seat}` : name,
  );
  return names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/**
 * Whether these seats can all be dealt a hand at once. `everyone` is false when some seat with a hand
 * is not among them, and the sentence then names the seats it counted. Ported from the API's thread,
 * where an unchecked five-way `top:1` held a thread for 9.4 s before failing; a deal no blocker allows
 * otherwise reaches the sampler, which spends 1.6 s before refusing with no reason.
 */
export function dealability(seats: readonly DealSeat[], everyone: boolean): Dealability {
  if (seats.length === 0) return { kind: 'dealable' };
  const support = new Set<number>();
  for (const { combos } of seats) {
    for (const [a, b] of combos) {
      support.add(a);
      support.add(b);
    }
  }
  const needed = seats.length * 2;
  const who = everyone ? `${seats.length} opponents` : listed(seats);
  if (support.size < needed) {
    const sentence =
      `These hands cannot all be dealt at once: ${who} need ${needed} different cards, ` +
      `and their ranges hold only ${support.size}.`;
    return { kind: 'undealable', sentence };
  }
  const { answer } = dealSearch(seats.map((seat) => seat.combos));
  if (answer === true) return { kind: 'dealable' };
  if (answer === null) return { kind: 'unchecked' };
  return {
    kind: 'undealable',
    sentence: everyone
      ? 'These ranges cannot all be dealt at once. Whatever one opponent holds, another is left with no hand. Widen a range.'
      : `The ranges of ${who} cannot all be dealt at once. Whatever one of them holds, another is left with no hand. Widen a range.`,
  };
}

/** Keeps the first error per field, because the first rule broken is the one to fix first. */
class Collector {
  readonly errors = new Map<FieldKey, string>();

  fail(field: FieldKey, message: string): void {
    if (!this.errors.has(field)) this.errors.set(field, message);
  }

  take<T>(field: FieldKey, parsed: Parsed<T>): T | null {
    if ('error' in parsed) {
      this.fail(field, parsed.error);
      return null;
    }
    return parsed.value;
  }
}

/** Every card on the table once. The picker refuses a used card, so this catches stored data. */
function checkDuplicates(draft: SpotDraft, out: Collector): void {
  const seen = new Set<number>();
  const place = (card: number | null, field: FieldKey): void => {
    if (card === null) return;
    if (seen.has(card)) out.fail(field, `The ${cardName(card)} is used twice. Each card can appear once.`);
    seen.add(card);
  };
  for (const slot of ['hole1', 'hole2', ...BOARD_SLOTS] as const satisfies readonly CardSlotId[]) {
    place(draft.cards[slot], slot === 'hole1' || slot === 'hole2' ? 'hole' : 'board');
  }
  for (const opponent of draft.opponents) {
    if (opponent.handKind !== 'cards') continue;
    for (const card of opponent.cards) place(card, opponentField(opponent.key, 'cards'));
  }
}

function readHero(draft: SpotDraft, out: Collector): { stack: number | null; bet: number | null } {
  const stack = out.take('heroStack', chips(draft.heroStack, 'Enter your stack.'));
  const bet = out.take('heroBet', chips(draft.heroBet, 'Enter what you have put in, or 0.'));
  if (stack === null || bet === null) return { stack, bet };
  if (bet > stack) {
    out.fail('heroBet', `You cannot have put in more than your stack of ${formatChips(stack)}.`);
  } else if (bet === stack) {
    out.fail(
      'heroStack',
      'You need chips left to decide with. Make your stack larger than what you have put in.',
    );
  }
  return { stack, bet };
}

interface OpponentsRead {
  /** Only when every seat read cleanly. */
  readonly opponents: readonly SpotOpponent[] | null;
  /** Seats whose hand expanded here: not `top:NN`, which the analysis thread expands. */
  readonly modelled: readonly DealSeat[];
  /** Seats meant to hold a hand, whether or not it could be read or expanded. */
  readonly withHand: number;
  readonly allIn: string | null;
}

function readOpponent(
  opponent: OpponentDraft,
  dead: readonly number[],
  out: Collector,
): { readonly seat: SpotOpponent | null; readonly allIn: boolean; readonly hand: RangeCheck } {
  const field = (name: OpponentField): FieldKey => opponentField(opponent.key, name);
  const name = out.take(field('name'), label(opponent.name, 'opponent'));
  const shown = name ?? 'this opponent';
  const stack = out.take(field('stack'), chips(opponent.stack, `Enter ${shown}'s stack.`));
  const bet = out.take(field('bet'), chips(opponent.bet, 'Enter the bet, or 0.'));
  if (stack !== null && bet !== null && bet > stack) {
    out.fail(field('bet'), `${shown} cannot bet more than their stack of ${formatChips(stack)}.`);
  }
  const hand = readHand(opponent, dead, shown);
  if (hand.error !== null) out.fail(field(opponent.handKind === 'cards' ? 'cards' : 'range'), hand.error);
  const named = opponent.handLabel !== null && opponent.handLabel.hand === handKey(opponent);
  const seat =
    name === null || stack === null || bet === null || hand.hand === null
      ? null
      : { name, label: named ? (opponent.handLabel?.label ?? name) : name, stack, bet, hand: hand.hand };
  return { seat, allIn: stack !== null && stack === bet, hand };
}

function readOpponents(draft: SpotDraft, dead: readonly number[], out: Collector): OpponentsRead {
  const seats: SpotOpponent[] = [];
  const modelled: DealSeat[] = [];
  let allIn: string | null = null;
  for (const [index, opponent] of draft.opponents.entries()) {
    const read = readOpponent(opponent, dead, out);
    if (read.seat !== null) seats.push(read.seat);
    if (read.allIn) allIn ??= read.seat?.name ?? 'An opponent';
    if (read.hand.hand?.kind === 'none' || read.hand.combos === null) continue;
    const seat = index + 1;
    modelled.push({ name: opponent.name.trim() || `Opponent ${seat}`, seat, combos: read.hand.combos });
  }
  const withHand = draft.opponents.filter((opponent) => opponent.handKind !== 'none').length;
  return { opponents: seats.length === draft.opponents.length ? seats : null, modelled, withHand, allIn };
}

/** Rules about the seats together rather than any one field. False when dealability went unchecked. */
function checkTable(draft: SpotDraft, read: OpponentsRead, out: Collector): boolean {
  const count = draft.opponents.length;
  if (count === 0) out.fail('opponents', 'Add at least one opponent.');
  if (count > MAX_OPPONENTS) out.fail('opponents', `The analysis handles up to ${MAX_OPPONENTS} opponents.`);
  if (count > 0 && draft.opponents.every((opponent) => opponent.handKind === 'none')) {
    out.fail(
      'opponents',
      'At least one opponent needs a range or cards, so there is a hand to compare against.',
    );
  }
  // The Coach prices the pots an all-in seat can win only when every seat has a hand.
  if (read.allIn !== null && draft.opponents.some((opponent) => opponent.handKind === 'none')) {
    out.fail('opponents', `${read.allIn} is all in, so every opponent needs a range or cards.`);
  }
  // The seats that expanded here are checked even beside a `top:NN` one: if they cannot be dealt, no
  // table that includes them can. The analysis checks every seat once `top:NN` is expanded.
  const dealt = dealability(read.modelled, read.modelled.length === read.withHand);
  if (dealt.kind === 'undealable') out.fail('opponents', dealt.sentence);
  return dealt.kind !== 'unchecked';
}

function checkPot(
  money: {
    readonly potBefore: number | null;
    readonly heroBet: number | null;
    readonly bigBlind: number | null;
  },
  board: Board | null,
  read: OpponentsRead,
  out: Collector,
): void {
  const { potBefore, heroBet, bigBlind } = money;
  if (heroBet === null || read.opponents === null || read.opponents.length === 0) return;
  const bets = read.opponents.map((opponent) => opponent.bet);
  // As content's `checkPreflopPosting`, less its pot rule: here a folded blind is part of the pot.
  if (board?.length === 0 && bigBlind !== null && bigBlind > 0 && Math.max(heroBet, ...bets) < bigBlind) {
    out.fail(
      'bigBlind',
      `Before the flop, someone has put in the big blind of ${formatChips(bigBlind)}. Enter it as your bet or an opponent's.`,
    );
  }
  if (heroBet > Math.max(...bets)) {
    out.fail(
      'heroBet',
      'You have put in more than any opponent has bet. Lower this, or raise a bet to match it.',
    );
  }
  if (potBefore !== null && potBefore + heroBet + bets.reduce((sum, bet) => sum + bet, 0) === 0) {
    out.fail('potBefore', 'The pot is empty. Add the blinds or earlier bets.');
  }
}

export function validateDraft(draft: SpotDraft): Validation {
  const out = new Collector();
  const name = out.take('name', label(draft.name, 'spot'));
  const { hole1, hole2 } = draft.cards;
  if (hole1 === null || hole2 === null) out.fail('hole', 'Pick both of your hole cards.');
  const board = out.take('board', readBoard(draft.cards));
  checkDuplicates(draft, out);

  const hero = readHero(draft, out);
  const potBefore = out.take('potBefore', chips(draft.potBefore, 'Enter the pot, or 0.'));
  const bigBlind = out.take('bigBlind', chips(draft.bigBlind, 'Enter the big blind.'));
  if (bigBlind === 0) out.fail('bigBlind', 'The big blind must be at least 1 chip.');
  const foldRate = out.take('foldRate', percent(draft.foldRate));
  // The Coach reads a stated rate ahead of "never folds", so the pair would drop one without a word.
  if (draft.neverFolds && foldRate !== null) {
    out.fail('foldRate', 'The opponent never folds, so leave the fold rate blank.');
  }

  const dead = [hole1, hole2, ...BOARD_SLOTS.map((slot) => draft.cards[slot])].filter(
    (card): card is number => card !== null,
  );
  const read = readOpponents(draft, dead, out);
  const dealChecked = checkTable(draft, read, out);
  checkPot({ potBefore, heroBet: hero.bet, bigBlind }, board, read, out);

  if (out.errors.size > 0) return { ok: false, errors: out.errors };
  // Every value below is non-null when no error was recorded; the checks satisfy the compiler.
  if (name === null || hole1 === null || hole2 === null || board === null || read.opponents === null) {
    return { ok: false, errors: out.errors };
  }
  if (hero.stack === null || hero.bet === null || potBefore === null || bigBlind === null) {
    return { ok: false, errors: out.errors };
  }
  return {
    ok: true,
    spot: {
      name,
      hero: { cards: [hole1, hole2], stack: hero.stack, bet: hero.bet },
      board,
      potBefore,
      bigBlind,
      opponents: read.opponents,
      neverFolds: draft.neverFolds,
      foldRate,
    },
    dealChecked,
  };
}

/**
 * The one way from a draft to a `Spot`. Every rule answers with a plain sentence keyed to the field it
 * is about, and a draft with any error yields no spot, so the editor never prices a half-valid one.
 * `test/lab-spot-validate.test.ts` holds each rule to its message, and holds that a spot this passes
 * never makes `buildCoachReport` throw.
 */

import { type ParsedRange, parseRange } from '@prl/poker-math';
import { formatChips } from '@prl/ui/format';
import {
  BOARD_SLOTS,
  type Board,
  type CardSlotId,
  cardName,
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
  | { readonly ok: true; readonly spot: Spot }
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

/**
 * `k` opponents need `2k` distinct cards between their hands. Ported from the API's thread, where an
 * unchecked five-way `top:1` held a thread for 9.4 s before failing.
 */
export function undealableSentence(
  hands: readonly (readonly (readonly [number, number])[])[],
): string | null {
  const support = new Set<number>();
  for (const combos of hands) {
    for (const [a, b] of combos) {
      support.add(a);
      support.add(b);
    }
  }
  const needed = hands.length * 2;
  if (hands.length === 0 || support.size >= needed) return null;
  return (
    `These hands cannot all be dealt at once: ${hands.length} opponents need ${needed} different cards, ` +
    `and their ranges hold only ${support.size}.`
  );
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
  readonly modelled: readonly (readonly (readonly [number, number])[])[];
  readonly unexpanded: boolean;
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
  const seat =
    name === null || stack === null || bet === null || hand.hand === null
      ? null
      : { name, stack, bet, hand: hand.hand };
  return { seat, allIn: stack !== null && stack === bet, hand };
}

function readOpponents(draft: SpotDraft, dead: readonly number[], out: Collector): OpponentsRead {
  const seats: SpotOpponent[] = [];
  const modelled: (readonly (readonly [number, number])[])[] = [];
  let unexpanded = false;
  let allIn: string | null = null;
  for (const opponent of draft.opponents) {
    const read = readOpponent(opponent, dead, out);
    if (read.seat !== null) seats.push(read.seat);
    if (read.allIn) allIn ??= read.seat?.name ?? 'An opponent';
    if (read.hand.hand === null || read.hand.hand.kind === 'none') continue;
    if (read.hand.combos === null) unexpanded = true;
    else modelled.push(read.hand.combos);
  }
  return { opponents: seats.length === draft.opponents.length ? seats : null, modelled, unexpanded, allIn };
}

/** Rules about the seats together rather than any one field. */
function checkTable(draft: SpotDraft, read: OpponentsRead, out: Collector): void {
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
  const undealable = read.unexpanded ? null : undealableSentence(read.modelled);
  if (undealable !== null) out.fail('opponents', undealable);
}

function checkPot(
  potBefore: number | null,
  heroBet: number | null,
  read: OpponentsRead,
  out: Collector,
): void {
  if (heroBet === null || read.opponents === null || read.opponents.length === 0) return;
  const bets = read.opponents.map((opponent) => opponent.bet);
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

  const dead = [hole1, hole2, ...BOARD_SLOTS.map((slot) => draft.cards[slot])].filter(
    (card): card is number => card !== null,
  );
  const read = readOpponents(draft, dead, out);
  checkTable(draft, read, out);
  checkPot(potBefore, hero.bet, read, out);

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
  };
}

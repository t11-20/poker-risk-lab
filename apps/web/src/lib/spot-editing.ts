/**
 * The edits the editor makes to a draft, as pure functions: the picker's slots and back, clearing the
 * board, a random hand, and adding or removing an opponent. The component only wires these to clicks.
 */

import type { CardPickerGroup } from '@prl/ui';
import type { PickerSlot } from '@prl/ui/card-picker';
import type { CardValue } from '@prl/ui/cards';
import {
  BOARD_SLOTS,
  blankOpponent,
  CARD_SLOTS,
  type CardSlotId,
  fillRandom,
  HERO_SLOTS,
  MAX_OPPONENTS,
  type OpponentDraft,
  opponentSlotIds,
  type RandomBytes,
  SLOT_LABELS,
  type SpotDraft,
  type TablePrice,
  tablePrice,
} from './spot.ts';
import { type FieldErrors, type FieldKey, opponentField } from './spot-validate.ts';

function opponentLabel(opponent: OpponentDraft, index: number): string {
  return opponent.name.trim() === '' ? `Opponent ${index + 1}` : opponent.name.trim();
}

/** Hero's hand, the board, then each exact-hand opponent: the order "next open slot" follows. */
export function pickerGroups(draft: SpotDraft): readonly CardPickerGroup[] {
  const slot = (id: CardSlotId): PickerSlot => ({ id, label: SLOT_LABELS[id], card: draft.cards[id] });
  const groups: CardPickerGroup[] = [
    { label: 'Your hand', slots: HERO_SLOTS.map(slot) },
    { label: 'Board', slots: BOARD_SLOTS.map(slot) },
  ];
  for (const [index, opponent] of draft.opponents.entries()) {
    if (opponent.handKind !== 'cards') continue;
    const name = opponentLabel(opponent, index);
    const [first, second] = opponentSlotIds(opponent.key);
    const seat = `Opp ${index + 1}`;
    groups.push({
      label: `${name}'s hand`,
      slots: [
        {
          id: first,
          label: `${name}, card 1`,
          card: opponent.cards[0],
          short: `${seat} · 1st`,
          deckShort: seat,
        },
        {
          id: second,
          label: `${name}, card 2`,
          card: opponent.cards[1],
          short: `${seat} · 2nd`,
          deckShort: seat,
        },
      ],
    });
  }
  return groups;
}

export function allSlots(draft: SpotDraft): readonly PickerSlot[] {
  return pickerGroups(draft).flatMap((group) => group.slots);
}

/** One slot set or emptied. An id that names no slot leaves the draft as it was. */
export function withSlotCard(draft: SpotDraft, id: string, card: CardValue | null): SpotDraft {
  if ((CARD_SLOTS as readonly string[]).includes(id)) {
    return { ...draft, cards: { ...draft.cards, [id]: card } };
  }
  return {
    ...draft,
    opponents: draft.opponents.map((opponent) => {
      const [first, second] = opponentSlotIds(opponent.key);
      if (id === first) return { ...opponent, cards: [card, opponent.cards[1]] };
      if (id === second) return { ...opponent, cards: [opponent.cards[0], card] };
      return opponent;
    }),
  };
}

export function clearBoard(draft: SpotDraft): SpotDraft {
  const cards = { ...draft.cards };
  for (const slot of BOARD_SLOTS) cards[slot] = null;
  return { ...draft, cards };
}

/** Rejection sampling, because `byte % n` favours the low cards whenever 256 is not a multiple of n. */
function uniformIndex(n: number, random: RandomBytes): number {
  const limit = 256 - (256 % n);
  for (;;) {
    const [byte] = random(new Uint8Array(1));
    if (byte !== undefined && byte < limit) return byte % n;
  }
}

/**
 * Two new hole cards from the cards nobody else holds. The board and any opponent's exact hand stay
 * as they are; `crypto.getRandomValues` by default, never the engine's shuffler.
 */
export function randomHand(draft: SpotDraft, random: RandomBytes = fillRandom): SpotDraft {
  const held = new Set(
    allSlots(draft)
      .filter((slot) => slot.id !== 'hole1' && slot.id !== 'hole2')
      .flatMap((slot) => (slot.card === null ? [] : [slot.card])),
  );
  const free = Array.from({ length: 52 }, (_unused, card) => card).filter((card) => !held.has(card));
  const first = free.splice(uniformIndex(free.length, random), 1)[0] ?? null;
  const second = free.splice(uniformIndex(free.length, random), 1)[0] ?? null;
  return { ...draft, cards: { ...draft.cards, hole1: first, hole2: second } };
}

export function addOpponent(draft: SpotDraft): SpotDraft {
  if (draft.opponents.length >= MAX_OPPONENTS) return draft;
  const used = new Set(draft.opponents.map((opponent) => opponent.key));
  let n = draft.opponents.length + 1;
  while (used.has(`o${n}`)) n += 1;
  return { ...draft, opponents: [...draft.opponents, blankOpponent(`o${n}`, draft.opponents.length)] };
}

export function removeOpponent(draft: SpotDraft, key: string): SpotDraft {
  if (draft.opponents.length <= 1) return draft;
  return { ...draft, opponents: draft.opponents.filter((opponent) => opponent.key !== key) };
}

export function updateOpponent(
  draft: SpotDraft,
  key: string,
  change: Partial<Omit<OpponentDraft, 'key'>>,
): SpotDraft {
  return {
    ...draft,
    opponents: draft.opponents.map((opponent) =>
      opponent.key === key ? { ...opponent, ...change } : opponent,
    ),
  };
}

/** Derived figures shown beside the fields, or `null` while an amount does not parse. */
export function priceLine(draft: SpotDraft): Omit<TablePrice, 'winnable'> | null {
  const whole = (text: string): number | null => (/^\d+$/u.test(text.trim()) ? Number(text.trim()) : null);
  const potBefore = whole(draft.potBefore);
  const heroStack = whole(draft.heroStack);
  const heroBet = whole(draft.heroBet);
  const bets = draft.opponents.map((opponent) => whole(opponent.bet));
  if (potBefore === null || heroStack === null || heroBet === null || heroBet > heroStack) return null;
  if (bets.length === 0 || bets.some((bet) => bet === null)) return null;
  const { pot, toCall, allIn } = tablePrice({
    potBefore,
    heroStack,
    heroBet,
    bets: bets.filter((bet): bet is number => bet !== null),
  });
  return { pot, toCall, allIn };
}

/** Rules about the seats together, shown once the reader has touched any seat. */
const TABLE_KEYS: readonly FieldKey[] = ['opponents'];

/**
 * The errors to mark. None on a field the reader has not touched, so a new spot does not open in red;
 * all of them once Save has been pressed. Card errors wait for Save, because picking the first hole
 * card would otherwise mark the second before the reader could reach it.
 */
export function errorsToShow(
  errors: FieldErrors,
  touched: ReadonlySet<FieldKey>,
  submitted: boolean,
): FieldErrors {
  if (submitted) return errors;
  const seatTouched = [...touched].some((key) => key.startsWith('opponent.'));
  return new Map(
    [...errors].filter(([key]) => touched.has(key) || (seatTouched && TABLE_KEYS.includes(key))),
  );
}

/** The slot Save focuses when the first problem is a card: the first empty or doubled one at fault. */
export function focusSlotFor(errors: FieldErrors, draft: SpotDraft): string | null {
  const groups: readonly (readonly [FieldKey, readonly string[]])[] = [
    ['hole', HERO_SLOTS],
    ['board', BOARD_SLOTS],
    ...draft.opponents.map(
      (opponent) => [opponentField(opponent.key, 'cards'), opponentSlotIds(opponent.key)] as const,
    ),
  ];
  const cards = new Map(allSlots(draft).map((slot) => [slot.id, slot.card]));
  for (const [key, slots] of groups) {
    if (!errors.has(key)) continue;
    const open = key === 'board' ? boardGap(draft) : slots.find((id) => cards.get(id) == null);
    return open ?? slots[0] ?? null;
  }
  return null;
}

/** The first board slot out of street order: an empty flop card, or the turn missing before a river. */
function boardGap(draft: SpotDraft): string | undefined {
  const filled = BOARD_SLOTS.map((slot) => draft.cards[slot] !== null);
  const last = filled.lastIndexOf(true);
  return BOARD_SLOTS.find((_slot, index) => index < Math.max(3, last + 1) && !filled[index]);
}

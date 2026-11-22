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
} from './spot.ts';

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
    groups.push({
      label: `${name}'s hand`,
      slots: [
        { id: first, label: `${name} 1`, card: opponent.cards[0] },
        { id: second, label: `${name} 2`, card: opponent.cards[1] },
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
export function priceLine(draft: SpotDraft): { readonly pot: number; readonly toCall: number } | null {
  const whole = (text: string): number | null => (/^\d+$/u.test(text.trim()) ? Number(text.trim()) : null);
  const before = whole(draft.potBefore);
  const heroBet = whole(draft.heroBet);
  const bets = draft.opponents.map((opponent) => whole(opponent.bet));
  if (before === null || heroBet === null || bets.length === 0 || bets.some((bet) => bet === null))
    return null;
  const counted = bets.filter((bet): bet is number => bet !== null);
  return {
    pot: before + heroBet + counted.reduce((sum, bet) => sum + bet, 0),
    toCall: Math.max(0, Math.max(...counted) - heroBet),
  };
}

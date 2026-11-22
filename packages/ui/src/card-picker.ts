/**
 * The card picker's model: named slots filled from one deck, so a card can sit in one slot at most.
 * Pure, so the rules a reader relies on (a used card cannot be picked, picking fills the next open
 * slot, removing frees the card) are tested without a DOM.
 */

import { type CardValue, describeCard } from './cards.ts';

export interface PickerSlot {
  readonly id: string;
  /** Spoken, and shown unless `short` is given, e.g. "Flop 1". */
  readonly label: string;
  readonly card: CardValue | null;
  /** Shown in place of `label` where a long one, such as an opponent's name, would not fit. */
  readonly short?: string;
}

const RANKS_HIGH_FIRST = [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0] as const;
/** Spades, hearts, diamonds, clubs: the engine's suit indices in the order a deck is usually laid out. */
const SUITS_IN_DECK_ORDER = [3, 2, 1, 0] as const;

export const DECK_RANKS = RANKS_HIGH_FIRST.length;
export const DECK_SUITS = SUITS_IN_DECK_ORDER.length;

/** Suit by suit, ace down to two. The picker's DOM order, whichever way the grid flows. */
export const PICKER_DECK: readonly CardValue[] = SUITS_IN_DECK_ORDER.flatMap((suit) =>
  RANKS_HIGH_FIRST.map((rank) => rank * 4 + suit),
);

/** Which slot holds each card. A card in two slots keeps the first, which is the one a reader sees first. */
export function cardOwners(slots: readonly PickerSlot[]): ReadonlyMap<CardValue, PickerSlot> {
  const owners = new Map<CardValue, PickerSlot>();
  for (const slot of slots) {
    if (slot.card !== null && !owners.has(slot.card)) owners.set(slot.card, slot);
  }
  return owners;
}

/** The first empty slot after `after` in fill order, then from the start. `null` when all are full. */
export function nextOpenSlot(slots: readonly PickerSlot[], after: string | null): string | null {
  const start = after === null ? 0 : slots.findIndex((slot) => slot.id === after) + 1;
  for (let step = 0; step < slots.length; step++) {
    const slot = slots[(start + step) % slots.length];
    if (slot !== undefined && slot.card === null) return slot.id;
  }
  return null;
}

export interface PickResult {
  readonly slots: readonly PickerSlot[];
  /** The slot the next pick goes into. */
  readonly active: string | null;
  /** Where the card went, or `null` when nothing changed. */
  readonly placed: PickerSlot | null;
}

/**
 * Puts `card` into the active slot, replacing what was there, or into the first open slot. A card
 * already in another slot is refused rather than moved, because moving it would empty a slot the
 * reader did not touch.
 */
export function pickCard(slots: readonly PickerSlot[], active: string | null, card: CardValue): PickResult {
  const unchanged = { slots, active, placed: null };
  if (describeCard(card) === null) return unchanged;
  const owner = cardOwners(slots).get(card);
  if (owner !== undefined) return unchanged;
  const target =
    active !== null && slots.some((slot) => slot.id === active) ? active : nextOpenSlot(slots, null);
  if (target === null) return unchanged;
  const next = slots.map((slot) => (slot.id === target ? { ...slot, card } : slot));
  const placed = next.find((slot) => slot.id === target) ?? null;
  return { slots: next, active: nextOpenSlot(next, target), placed };
}

/** Empties one slot and makes it the active one, so the next pick refills it. */
export function removeCard(slots: readonly PickerSlot[], id: string): PickResult {
  const removed = slots.find((slot) => slot.id === id);
  if (removed === undefined || removed.card === null) return { slots, active: id, placed: null };
  return {
    slots: slots.map((slot) => (slot.id === id ? { ...slot, card: null } : slot)),
    active: id,
    placed: null,
  };
}

/**
 * `rows` is four suit rows of thirteen; `columns` is four suit columns of thirteen, used when the
 * picker is too narrow for thirteen targets across. The DOM order is `PICKER_DECK` in both.
 */
export type DeckFlow = 'rows' | 'columns';

/** Where an arrow, Home or End key moves focus from `index`, or `null` for any other key. Never wraps. */
export function moveInDeck(index: number, key: string, flow: DeckFlow): number | null {
  const suit = Math.floor(index / DECK_RANKS);
  const rank = index % DECK_RANKS;
  const along =
    flow === 'rows'
      ? { next: 'ArrowRight', previous: 'ArrowLeft' }
      : { next: 'ArrowDown', previous: 'ArrowUp' };
  const across =
    flow === 'rows'
      ? { next: 'ArrowDown', previous: 'ArrowUp' }
      : { next: 'ArrowRight', previous: 'ArrowLeft' };
  const at = (s: number, r: number): number => s * DECK_RANKS + r;
  if (key === along.next) return at(suit, Math.min(DECK_RANKS - 1, rank + 1));
  if (key === along.previous) return at(suit, Math.max(0, rank - 1));
  if (key === across.next) return at(Math.min(DECK_SUITS - 1, suit + 1), rank);
  if (key === across.previous) return at(Math.max(0, suit - 1), rank);
  if (key === 'Home') return at(suit, 0);
  if (key === 'End') return at(suit, DECK_RANKS - 1);
  return null;
}

/** The deck button's accessible name. A used card says where it is, because greying it says nothing to a screen reader. */
export function deckCardName(card: CardValue, owner: PickerSlot | undefined): string {
  const name = describeCard(card)?.accessibleName ?? 'unknown card';
  return owner === undefined ? name : `${name}, in use as ${owner.label}`;
}

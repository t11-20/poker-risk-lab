/**
 * The player's spots in this browser: one versioned `localStorage` key, never sent anywhere. `/privacy`
 * names the key. Everything read is checked field by field, so corrupt or foreign data becomes a notice
 * and an empty list rather than a thrown error, and storage that throws (Safari private mode, blocked
 * site data) leaves the editor working with nothing saved.
 * Built-in scenarios are never written here. An edit of one is the player's own spot with `from` set,
 * one per scenario, and "Reset to original" deletes it.
 */

import { type CardValue, parseCardText } from '@prl/ui/cards';
import {
  CARD_SLOTS,
  type CardSlotId,
  cardToText,
  EMPTY_CARDS,
  fillRandom,
  type HandKind,
  MAX_NAME_LENGTH,
  MAX_OPPONENTS,
  type OpponentDraft,
  type RandomBytes,
  type SavedSpot,
  type SpotDraft,
} from './spot.ts';

export const SPOTS_STORAGE_KEY = 'prl.lab.spots';
export const SPOTS_STORAGE_VERSION = 1;

/** The narrow part of `Storage` this needs, so a test can hand it one that throws. */
export interface SpotStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type StorageNotice =
  /** Reading threw. Nothing can be saved in this browser. */
  | { readonly kind: 'unavailable' }
  /** Not JSON, or not this page's shape. Saving replaces it. */
  | { readonly kind: 'unreadable' }
  /** Written by a later version of this page. Left untouched, so nothing here can destroy it. */
  | { readonly kind: 'newer'; readonly version: number }
  /** Some entries were not spots and were left out. */
  | { readonly kind: 'skipped'; readonly count: number };

export interface SpotLibrary {
  readonly spots: readonly SavedSpot[];
  readonly notice: StorageNotice | null;
  /** False when a write would fail or would overwrite data this version cannot read. */
  readonly writable: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length <= max ? value : null;
}

/** A card as storage keeps it, `"Ah"`, or `null` for an empty slot. `undefined` means not a card. */
function storedCard(value: unknown): CardValue | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  return parseCardText(value) ?? undefined;
}

const HAND_KINDS: readonly HandKind[] = ['range', 'cards', 'none'];
/** Amount fields hold what was typed. Bounded so a stored megabyte cannot reach a text box. */
const FIELD_MAX = 32;

function readOpponent(value: unknown): OpponentDraft | null {
  if (!isRecord(value)) return null;
  const key = text(value['key'], 40);
  const name = text(value['name'], MAX_NAME_LENGTH * 2);
  const stack = text(value['stack'], FIELD_MAX);
  const bet = text(value['bet'], FIELD_MAX);
  const range = text(value['range'], 400);
  const handKind = HAND_KINDS.find((kind) => kind === value['hand']);
  const cards = value['cards'];
  if (
    key === null ||
    name === null ||
    stack === null ||
    bet === null ||
    range === null ||
    handKind === undefined
  ) {
    return null;
  }
  if (!Array.isArray(cards) || cards.length !== 2) return null;
  const first = storedCard(cards[0]);
  const second = storedCard(cards[1]);
  if (first === undefined || second === undefined) return null;
  return { key, name, stack, bet, handKind, range, cards: [first, second] };
}

function readSpot(value: unknown): SavedSpot | null {
  if (!isRecord(value)) return null;
  const id = text(value['id'], 64);
  const from = value['from'] === null ? null : text(value['from'], 120);
  const updatedAt = value['updatedAt'];
  const name = text(value['name'], MAX_NAME_LENGTH * 2);
  const stored = value['cards'];
  const fields = ['heroStack', 'heroBet', 'potBefore', 'bigBlind', 'foldRate'].map((field) =>
    text(value[field], FIELD_MAX),
  );
  const [heroStack, heroBet, potBefore, bigBlind, foldRate] = fields;
  if (id === null || typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return null;
  if (value['from'] !== null && from === null) return null;
  if (name === null || !isRecord(stored) || typeof value['neverFolds'] !== 'boolean') return null;
  if (heroStack == null || heroBet == null || potBefore == null || bigBlind == null || foldRate == null)
    return null;

  const cards: Record<CardSlotId, CardValue | null> = { ...EMPTY_CARDS };
  for (const slot of CARD_SLOTS) {
    const card = storedCard(stored[slot] ?? null);
    if (card === undefined) return null;
    cards[slot] = card;
  }
  const rawOpponents = value['opponents'];
  if (!Array.isArray(rawOpponents) || rawOpponents.length > MAX_OPPONENTS) return null;
  const opponents = rawOpponents.map(readOpponent);
  if (opponents.some((opponent) => opponent === null)) return null;

  const draft: SpotDraft = {
    name,
    cards,
    heroStack,
    heroBet,
    potBefore,
    bigBlind,
    opponents: opponents.filter((opponent): opponent is OpponentDraft => opponent !== null),
    neverFolds: value['neverFolds'],
    foldRate,
  };
  return { id, from, updatedAt, draft };
}

/** Pure, so every shape of bad data is a unit test. */
export function parseLibrary(
  raw: string | null,
): Pick<SpotLibrary, 'spots' | 'notice'> & { readonly newer: boolean } {
  if (raw === null) return { spots: [], notice: null, newer: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { spots: [], notice: { kind: 'unreadable' }, newer: false };
  }
  if (!isRecord(parsed) || typeof parsed['version'] !== 'number' || !Array.isArray(parsed['spots'])) {
    return { spots: [], notice: { kind: 'unreadable' }, newer: false };
  }
  const version = parsed['version'];
  if (version > SPOTS_STORAGE_VERSION && Number.isInteger(version)) {
    return { spots: [], notice: { kind: 'newer', version }, newer: true };
  }
  if (version !== SPOTS_STORAGE_VERSION) return { spots: [], notice: { kind: 'unreadable' }, newer: false };
  const unique = new Map<string, SavedSpot>();
  for (const entry of parsed['spots']) {
    const spot = readSpot(entry);
    if (spot !== null && !unique.has(spot.id)) unique.set(spot.id, spot);
  }
  const spots = [...unique.values()];
  const skipped = parsed['spots'].length - spots.length;
  return { spots, notice: skipped > 0 ? { kind: 'skipped', count: skipped } : null, newer: false };
}

function storedDraft(spot: SavedSpot): Record<string, unknown> {
  const { draft } = spot;
  const cards: Record<string, string | null> = {};
  for (const slot of CARD_SLOTS) {
    const card = draft.cards[slot];
    cards[slot] = card === null ? null : cardToText(card);
  }
  return {
    id: spot.id,
    from: spot.from,
    updatedAt: spot.updatedAt,
    name: draft.name,
    cards,
    heroStack: draft.heroStack,
    heroBet: draft.heroBet,
    potBefore: draft.potBefore,
    bigBlind: draft.bigBlind,
    opponents: draft.opponents.map((opponent) => ({
      key: opponent.key,
      name: opponent.name,
      stack: opponent.stack,
      bet: opponent.bet,
      hand: opponent.handKind,
      range: opponent.range,
      cards: opponent.cards.map((card) => (card === null ? null : cardToText(card))),
    })),
    neverFolds: draft.neverFolds,
    foldRate: draft.foldRate,
  };
}

export function serialiseLibrary(spots: readonly SavedSpot[]): string {
  return JSON.stringify({ version: SPOTS_STORAGE_VERSION, spots: spots.map(storedDraft) });
}

export function readLibrary(store: SpotStore | null): SpotLibrary {
  if (store === null) return { spots: [], notice: { kind: 'unavailable' }, writable: false };
  let raw: string | null;
  try {
    raw = store.getItem(SPOTS_STORAGE_KEY);
  } catch {
    return { spots: [], notice: { kind: 'unavailable' }, writable: false };
  }
  const { spots, notice, newer } = parseLibrary(raw);
  return { spots, notice, writable: !newer };
}

export type WriteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'unavailable' | 'newer' };

/** Reports failure, unlike `writeStorage`, because the editor has to say that a save did not happen. */
export function writeLibrary(
  store: SpotStore | null,
  library: SpotLibrary,
  spots: readonly SavedSpot[],
): WriteResult {
  if (library.notice?.kind === 'newer') return { ok: false, reason: 'newer' };
  if (store === null) return { ok: false, reason: 'unavailable' };
  try {
    store.setItem(SPOTS_STORAGE_KEY, serialiseLibrary(spots));
    return { ok: true };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

/** Twelve hex digits from `crypto.getRandomValues`, prefixed so an id never reads as a scenario's. */
export function newSpotId(random: RandomBytes = fillRandom): string {
  const bytes = random(new Uint8Array(6));
  return `spot-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export function editOf(spots: readonly SavedSpot[], scenarioId: string): SavedSpot | undefined {
  return spots.find((spot) => spot.from === scenarioId);
}

export interface SaveRequest {
  /** The spot being edited, or `null` for one not saved yet. */
  readonly id: string | null;
  readonly from: string | null;
  readonly draft: SpotDraft;
}

/**
 * Creates or replaces one spot. A first save of a built-in's copy replaces the existing edit of that
 * scenario, so there is at most one edit per built-in for "Reset to original" to remove.
 */
export function saveSpot(
  spots: readonly SavedSpot[],
  request: SaveRequest,
  now: number,
  makeId: () => string,
): { readonly spots: readonly SavedSpot[]; readonly saved: SavedSpot } {
  const existing =
    (request.id === null ? undefined : spots.find((spot) => spot.id === request.id)) ??
    (request.from === null ? undefined : editOf(spots, request.from));
  const saved: SavedSpot = {
    id: existing?.id ?? makeId(),
    from: existing?.from ?? request.from,
    updatedAt: now,
    draft: request.draft,
  };
  if (existing === undefined) return { spots: [...spots, saved], saved };
  return { spots: spots.map((spot) => (spot.id === saved.id ? saved : spot)), saved };
}

/** A new spot of the player's own, never linked to a built-in, so it has no original to reset to. */
export function duplicateDraft(
  spots: readonly SavedSpot[],
  draft: SpotDraft,
  now: number,
  makeId: () => string,
): { readonly spots: readonly SavedSpot[]; readonly saved: SavedSpot } {
  const name = `${draft.name.trim()} (copy)`.slice(0, MAX_NAME_LENGTH);
  const saved: SavedSpot = { id: makeId(), from: null, updatedAt: now, draft: { ...draft, name } };
  return { spots: [...spots, saved], saved };
}

export function deleteSpot(spots: readonly SavedSpot[], id: string): readonly SavedSpot[] {
  return spots.filter((spot) => spot.id !== id);
}

/** Removes the edit of `scenarioId`, which is all resetting needs: the original was never written. */
export function resetToOriginal(spots: readonly SavedSpot[], scenarioId: string): readonly SavedSpot[] {
  return spots.filter((spot) => spot.from !== scenarioId);
}

export function noticeSentence(notice: StorageNotice): string {
  switch (notice.kind) {
    case 'unavailable':
      return 'This browser is not letting the page save anything, so spots you make here last only until you leave the page.';
    case 'unreadable':
      return 'Spots saved in this browser could not be read, so none are shown. Saving a spot will replace them.';
    case 'newer':
      return 'Your saved spots were written by a newer version of this page. They are left untouched, and nothing can be saved until you reload.';
    case 'skipped':
      return `${notice.count === 1 ? 'One saved spot' : `${notice.count} saved spots`} could not be read and ${notice.count === 1 ? 'is' : 'are'} left out. Saving will remove ${notice.count === 1 ? 'it' : 'them'}.`;
  }
}

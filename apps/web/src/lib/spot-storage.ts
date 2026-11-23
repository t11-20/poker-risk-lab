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
  type HandLabel,
  handKey,
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
/** The furthest a `Date` reaches either side of 1970. Beyond it, formatting the time throws. */
export const MAX_TIME = 8.64e15;
/** Amount fields hold what was typed. Bounded so a stored megabyte cannot reach a text box. */
const FIELD_MAX = 32;

function readOpponent(value: unknown): OpponentDraft | null {
  if (!isRecord(value)) return null;
  const key = text(value['key'], 40);
  const name = text(value['name'], MAX_NAME_LENGTH * 2);
  const stack = text(value['stack'], FIELD_MAX);
  const bet = text(value['bet'], FIELD_MAX);
  // Absent when the hand does not use them; spots saved before that rule carry both.
  const range = value['range'] === undefined ? '' : text(value['range'], 400);
  const handKind = HAND_KINDS.find((kind) => kind === value['hand']);
  const cards = value['cards'] === undefined ? [null, null] : value['cards'];
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
  const handLabel = readHandLabel(value['handLabel']);
  if (handLabel === undefined) return null;
  return { key, name, stack, bet, handKind, range, cards: [first, second], handLabel };
}

/** Absent in spots saved before it existed, which read as having none. `undefined` means not a label. */
function readHandLabel(value: unknown): HandLabel | null | undefined {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) return undefined;
  const label = text(value['label'], 400);
  const hand = text(value['hand'], 420);
  return label === null || hand === null ? undefined : { label, hand };
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
  if (id === null || typeof updatedAt !== 'number' || !(Math.abs(updatedAt) <= MAX_TIME)) return null;
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
    opponents: opponents
      .filter((opponent): opponent is OpponentDraft => opponent !== null)
      .map((opponent) => (from === null ? { ...opponent, handLabel: null } : opponent)),
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
      ...(opponent.handKind === 'range' ? { range: opponent.range } : {}),
      ...(opponent.handKind === 'cards'
        ? { cards: opponent.cards.map((card) => (card === null ? null : cardToText(card))) }
        : {}),
      ...(opponent.handLabel === null ? {} : { handLabel: opponent.handLabel }),
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

export type WriteRefusal = 'unavailable' | 'full' | 'newer' | 'unreadable';

export type WriteResult = { readonly ok: true } | { readonly ok: false; readonly reason: WriteRefusal };

/** Safari and Chrome name it; Firefox's older name is kept because the error crosses no API boundary. */
function isQuotaError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED')
  );
}

/**
 * Reports failure, unlike `writeStorage`, because the editor has to say that a save did not happen.
 * Refuses a list that would not read back whole, since the next save would drop the entry unannounced.
 */
export function writeLibrary(
  store: SpotStore | null,
  library: SpotLibrary,
  spots: readonly SavedSpot[],
): WriteResult {
  if (library.notice?.kind === 'newer') return { ok: false, reason: 'newer' };
  if (store === null) return { ok: false, reason: 'unavailable' };
  const text = serialiseLibrary(spots);
  if (parseLibrary(text).spots.length !== spots.length) return { ok: false, reason: 'unreadable' };
  try {
    store.setItem(SPOTS_STORAGE_KEY, text);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: isQuotaError(error) ? 'full' : 'unavailable' };
  }
}

export function refusalSentence(reason: WriteRefusal): string {
  switch (reason) {
    case 'unavailable':
      return 'Not saved: this browser is not letting the page store anything.';
    case 'full':
      return "Not saved: this browser's storage for this site is full. Delete a spot you no longer need and save again.";
    case 'newer':
      return 'Not saved: your saved spots come from a newer version of this page. Reload first.';
    case 'unreadable':
      return 'Not saved: this spot has a field too long to keep. Shorten the longest name or range and save again.';
  }
}

const wholeChips = (text: string): string => {
  const trimmed = text.trim();
  return /^\d+$/u.test(trimmed) ? String(Number(trimmed)) : trimmed;
};

/**
 * The draft as it is stored and read back: trimmed, and amounts without leading zeros, because the
 * validator reads `"000…1000"` as 1000 while storage bounds the text it keeps. Only the hand a seat
 * uses is kept, and a built-in's label only on a spot linked to it and while it still names that hand,
 * as `/privacy` says.
 */
export function storedForm(draft: SpotDraft, from: string | null): SpotDraft {
  return {
    ...draft,
    name: draft.name.trim(),
    heroStack: wholeChips(draft.heroStack),
    heroBet: wholeChips(draft.heroBet),
    potBefore: wholeChips(draft.potBefore),
    bigBlind: wholeChips(draft.bigBlind),
    foldRate: draft.foldRate.trim(),
    opponents: draft.opponents.map((opponent) => {
      const hand = {
        handKind: opponent.handKind,
        range: opponent.handKind === 'range' ? opponent.range.trim() : '',
        cards: opponent.handKind === 'cards' ? opponent.cards : ([null, null] as const),
      };
      const label = opponent.handLabel;
      return {
        ...opponent,
        ...hand,
        name: opponent.name.trim(),
        stack: wholeChips(opponent.stack),
        bet: wholeChips(opponent.bet),
        handLabel: from !== null && label !== null && label.hand === handKey(hand) ? label : null,
      };
    }),
  };
}

/** Twelve hex digits from `crypto.getRandomValues`, prefixed so an id never reads as a scenario's. */
export function newSpotId(random: RandomBytes = fillRandom): string {
  const bytes = random(new Uint8Array(6));
  return `spot-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export function editOf(spots: readonly SavedSpot[], scenarioId: string): SavedSpot | undefined {
  return spots.find((spot) => spot.from === scenarioId);
}

/** An edit of a built-in this page still has. One whose built-in is gone is the player's own spot. */
export function isEditOfBuiltIn(spot: SavedSpot, isBuiltIn: (id: string) => boolean): boolean {
  return spot.from !== null && isBuiltIn(spot.from);
}

export function spotHref(spot: SavedSpot, isBuiltIn: (id: string) => boolean): string {
  return isEditOfBuiltIn(spot, isBuiltIn) && spot.from !== null
    ? `/lab/spots/edit?from=${encodeURIComponent(spot.from)}`
    : `/lab/spots/edit?id=${encodeURIComponent(spot.id)}`;
}

/**
 * Where a save of this tab would land: its own id, else the one edit of its built-in. The fallback is
 * what finds another tab's new edit after a reset there gave that edit a new id.
 */
export function storedCopy(
  spots: readonly SavedSpot[],
  editing: { readonly id: string | null; readonly from: string | null },
): SavedSpot | undefined {
  const own = editing.id === null ? undefined : spots.find((spot) => spot.id === editing.id);
  return own ?? (editing.from === null ? undefined : editOf(spots, editing.from));
}

/** What a tab last read or wrote where its spot is kept: nothing read yet, nothing there, or that copy. */
export type HeldCopy =
  | { readonly kind: 'unread' }
  | { readonly kind: 'none' }
  | { readonly kind: 'copy'; readonly spot: SavedSpot };

/** The whole entry as storage writes it, so two saves in one millisecond are still told apart. */
function holds(held: HeldCopy, stored: SavedSpot): boolean {
  return held.kind === 'copy' && serialiseLibrary([held.spot]) === serialiseLibrary([stored]);
}

export type StoredSync =
  | { readonly kind: 'same' }
  /** Saved in another tab, and this tab has no change of its own to lose. */
  | { readonly kind: 'adopt'; readonly spot: SavedSpot }
  /** Saved in another tab while this tab has changes, so the reader chooses. */
  | { readonly kind: 'changed'; readonly spot: SavedSpot }
  | { readonly kind: 'deleted' };

/** How the stored copy relates to the one this tab holds. Another tab's write arrives as `storage`. */
export function syncWithStored(held: HeldCopy, stored: SavedSpot | undefined, edited: boolean): StoredSync {
  // The first read is where this tab starts, so nothing in it is another tab's change.
  if (held.kind === 'unread') return { kind: 'same' };
  if (stored === undefined) return held.kind === 'none' ? { kind: 'same' } : { kind: 'deleted' };
  if (holds(held, stored)) return { kind: 'same' };
  return edited ? { kind: 'changed', spot: stored } : { kind: 'adopt', spot: stored };
}

export interface SaveRequest {
  /** The spot being edited, or `null` for one not saved yet. */
  readonly id: string | null;
  readonly from: string | null;
  readonly held: HeldCopy;
  readonly draft: SpotDraft;
}

export type SaveResult =
  | { readonly spots: readonly SavedSpot[]; readonly saved: SavedSpot }
  /** A copy this tab never held is where the save would land, so nothing is written. */
  | { readonly conflict: SavedSpot };

/**
 * Creates or replaces one spot, and replaces only the copy this tab holds. A first save of a
 * built-in's copy lands on that scenario's edit, so there is one edit per built-in to reset.
 */
export function saveSpot(
  spots: readonly SavedSpot[],
  request: SaveRequest,
  now: number,
  makeId: () => string,
): SaveResult {
  const existing = storedCopy(spots, request);
  if (existing !== undefined && !holds(request.held, existing)) return { conflict: existing };
  const from = existing?.from ?? request.from;
  const saved: SavedSpot = {
    id: existing?.id ?? makeId(),
    from,
    updatedAt: now,
    draft: storedForm(request.draft, from),
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
  const saved: SavedSpot = { id: makeId(), from: null, updatedAt: now, draft: storedForm(draft, null) };
  return { spots: [...spots, saved], saved };
}

export interface RemoveRequest {
  readonly id: string | null;
  readonly from: string | null;
  readonly held: HeldCopy;
}

export type RemoveResult =
  | { readonly spots: readonly SavedSpot[] }
  /** The stored copy is not the one this tab holds, so nothing is removed. */
  | { readonly conflict: SavedSpot };

/**
 * Delete, and Reset to original, which deletes the edit because the original was never written.
 * Removes only the copy this tab holds; a copy already gone leaves the list as it is.
 */
export function removeSpot(spots: readonly SavedSpot[], request: RemoveRequest): RemoveResult {
  const existing = storedCopy(spots, request);
  if (existing === undefined) return { spots };
  if (!holds(request.held, existing)) return { conflict: existing };
  return { spots: spots.filter((spot) => spot.id !== existing.id) };
}

/** How the copy an open Delete or Reset prompt asked about stands in storage now. */
export type AskedCopy =
  | { readonly kind: 'same' | 'changed'; readonly spot: SavedSpot }
  | { readonly kind: 'gone' };

/**
 * A prompt keeps the request it was opened on and confirms that, never what a later render drew,
 * because every render reads storage again and would otherwise hand the confirm another tab's copy.
 */
export function askedCopy(spots: readonly SavedSpot[], asked: RemoveRequest): AskedCopy {
  const stored = storedCopy(spots, asked);
  if (stored === undefined) return { kind: 'gone' };
  return { kind: holds(asked.held, stored) ? 'same' : 'changed', spot: stored };
}

export type GuardedWrite = 'save' | 'delete' | 'reset';
export type Removal = Exclude<GuardedWrite, 'save'>;

const AGAIN: Readonly<Record<Removal, string>> = { delete: 'Delete', reset: 'Reset' };

export function changedSincePrompt(write: Removal): string {
  return `This spot changed in another tab. ${AGAIN[write]} will not remove the new copy.`;
}

/**
 * What a write refused by `saveSpot` or `removeSpot` says. `choose` when the reader has changes and is
 * offered Load or Keep; `shown` when the page now shows the other copy; `kept` when the reader already
 * chose to keep theirs over it; `open` when the page only links to it.
 */
export function conflictSentence(write: GuardedWrite, next: 'choose' | 'shown' | 'kept' | 'open'): string {
  const done = { save: 'Not saved', delete: 'Not deleted', reset: 'Not reset' }[write];
  const tail = {
    choose:
      write === 'save'
        ? 'Load that copy, or keep yours to save over it.'
        : `Load that copy or keep yours, then ${write} again.`,
    shown:
      write === 'save'
        ? 'That copy is shown now.'
        : `That copy is shown now. ${AGAIN[write]} again to remove it.`,
    kept: `You kept yours, so ${write} again to ${write === 'save' ? 'replace' : 'remove'} it.`,
    open: `Open it to see that copy, or ${write} again.`,
  }[next];
  return `${done}. This spot changed in another tab. ${tail}`;
}

/** What a refused write says, and whether the tab now shows the copy that refused it. */
export function refusal(
  write: GuardedWrite,
  held: HeldCopy,
  conflict: SavedSpot,
  edited: boolean,
): { readonly show: boolean; readonly sentence: string } {
  const now = syncWithStored(held, conflict, edited);
  if (now.kind === 'changed') return { show: false, sentence: conflictSentence(write, 'choose') };
  // "Keep mine" was pressed after the prompt opened, so there is no choice left to offer.
  if (now.kind === 'same' && edited) return { show: false, sentence: conflictSentence(write, 'kept') };
  return { show: true, sentence: conflictSentence(write, 'shown') };
}

/**
 * "Keep mine" holds whatever is stored when it is pressed, which may be newer than the copy the notice
 * drew, so the sentence it says is true and the next save replaces exactly that.
 */
export function keepMine(
  spots: readonly SavedSpot[],
  editing: { readonly id: string | null; readonly from: string | null },
): {
  readonly editing: { readonly id: string | null; readonly from: string | null };
  readonly held: HeldCopy;
  readonly sentence: string;
} {
  const stored = storedCopy(spots, editing);
  if (stored === undefined) {
    return {
      editing,
      held: { kind: 'none' },
      sentence: 'Kept your changes. The other tab deleted this spot, so saving keeps yours.',
    };
  }
  return {
    editing: { id: stored.id, from: stored.from },
    held: { kind: 'copy', spot: stored },
    sentence: 'Kept your changes. Saving replaces the copy from the other tab.',
  };
}

/** An identical sentence twice is not spoken again, so a repeat gets an invisible difference. */
export function repeated(current: string, message: string): string {
  return current === message ? `${message}\u00a0` : message;
}

/** A copy keeps its name as typed, so the time it was saved is what tells two of them apart. */
const SAVED_AT = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

/** `null` for a time no `Date` holds, which formatting would throw on and take the whole list with it. */
export function savedAt(time: number): { readonly iso: string; readonly text: string } | null {
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) return null;
  return { iso: date.toISOString(), text: SAVED_AT.format(date) };
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

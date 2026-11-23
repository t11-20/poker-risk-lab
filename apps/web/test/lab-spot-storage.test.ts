/**
 * The player's spots in browser storage: create, edit, duplicate, delete one's own, reset an edit of a
 * built-in, and every way stored data or storage itself can be bad. Bad data is a notice and an empty
 * list, never a throw, and data from a newer version is never overwritten.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseCardText } from '@prl/ui/cards';
import { blankDraft, type SavedSpot, type SpotDraft } from '../src/lib/spot.ts';
import {
  askedCopy,
  changedSincePrompt,
  conflictSentence,
  duplicateDraft,
  editOf,
  type HeldCopy,
  isEditOfBuiltIn,
  keepMine,
  MAX_TIME,
  newSpotId,
  noticeSentence,
  parseLibrary,
  type RemoveRequest,
  readLibrary,
  refusal,
  refusalSentence,
  removeSpot,
  repeated,
  type SaveRequest,
  SPOTS_STORAGE_KEY,
  type SpotStore,
  savedAt,
  saveSpot,
  serialiseLibrary,
  spotHref,
  storedCopy,
  syncWithStored,
  writeLibrary,
} from '../src/lib/spot-storage.ts';

function c(text: string): number {
  const card = parseCardText(text);
  assert.ok(card !== null, text);
  return card;
}

function draft(name: string): SpotDraft {
  return {
    ...blankDraft(),
    name,
    cards: { ...blankDraft().cards, hole1: c('Ah'), hole2: c('Kd'), flop1: c('2c') },
  };
}

let counter = 0;
function ids(): string {
  counter += 1;
  return `spot-${String(counter).padStart(12, '0')}`;
}

class MemoryStore implements SpotStore {
  readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
}

/** A save that must go through: a new spot unless `held` names the copy it replaces. */
function put(
  spots: readonly SavedSpot[],
  request: Omit<SaveRequest, 'held'> & { readonly held?: HeldCopy },
  now: number,
): { readonly spots: readonly SavedSpot[]; readonly saved: SavedSpot } {
  const result = saveSpot(spots, { held: { kind: 'none' }, ...request }, now, ids);
  assert.ok(!('conflict' in result), 'the save was refused');
  return result;
}

const THROWING: SpotStore = {
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('QuotaExceededError');
  },
};

describe('create, edit, duplicate, delete, reset', () => {
  it('creates a spot of the player own, with a fresh id', () => {
    const { spots, saved } = put([], { id: null, from: null, draft: draft('Mine') }, 10);
    assert.equal(spots.length, 1);
    assert.equal(saved.from, null);
    assert.match(saved.id, /^spot-/u);
    assert.equal(saved.updatedAt, 10);
  });

  it('edits in place: the same id, the new draft, nothing added', () => {
    const first = put([], { id: null, from: null, draft: draft('Mine') }, 10);
    const second = put(
      first.spots,
      { id: first.saved.id, from: null, held: { kind: 'copy', spot: first.saved }, draft: draft('Renamed') },
      20,
    );
    assert.equal(second.spots.length, 1);
    assert.equal(second.saved.id, first.saved.id);
    assert.equal(second.spots[0]?.draft.name, 'Renamed');
  });

  it('keeps one edit per built-in, linked to it', () => {
    const first = put([], { id: null, from: 'fl-a', draft: draft('Edit one') }, 10);
    const blind = saveSpot(
      first.spots,
      { id: null, from: 'fl-a', held: { kind: 'none' }, draft: draft('Two') },
      20,
      ids,
    );
    assert.deepEqual(blind, { conflict: first.saved }, 'a copy this tab never held is not replaced');
    const held = { kind: 'copy', spot: first.saved } as const;
    const again = put(first.spots, { id: null, from: 'fl-a', held, draft: draft('Edit two') }, 20);
    assert.equal(again.spots.length, 1);
    assert.equal(editOf(again.spots, 'fl-a')?.draft.name, 'Edit two');
  });

  it('duplicates as a new spot of the player own, never linked to the built-in', () => {
    const edit = put([], { id: null, from: 'fl-a', draft: draft('Edit') }, 10);
    const copy = duplicateDraft(edit.spots, edit.saved.draft, 20, ids);
    assert.equal(copy.spots.length, 2);
    assert.equal(copy.saved.from, null);
    assert.equal(copy.saved.draft.name, 'Edit', 'the name is kept as typed, with nothing added');
    assert.notEqual(copy.saved.id, edit.saved.id);
  });

  it('deletes one spot and leaves the others', () => {
    const a = put([], { id: null, from: null, draft: draft('A') }, 1);
    const b = put(a.spots, { id: null, from: null, draft: draft('B') }, 2);
    const left = removeSpot(b.spots, { id: a.saved.id, from: null, held: { kind: 'copy', spot: a.saved } });
    assert.ok('spots' in left);
    assert.deepEqual(
      left.spots.map((spot) => spot.draft.name),
      ['B'],
    );
  });

  it('reset to original removes the edit of that built-in only', () => {
    const a = put([], { id: null, from: 'fl-a', draft: draft('Edit A') }, 1);
    const b = put(a.spots, { id: null, from: 'fl-b', draft: draft('Edit B') }, 2);
    const mine = put(b.spots, { id: null, from: null, draft: draft('Mine') }, 3);
    const reset = removeSpot(mine.spots, {
      id: a.saved.id,
      from: 'fl-a',
      held: { kind: 'copy', spot: a.saved },
    });
    assert.ok('spots' in reset);
    assert.equal(editOf(reset.spots, 'fl-a'), undefined);
    assert.equal(reset.spots.length, 2);
  });

  it('makes ids from the random source, prefixed so none reads as a scenario id', () => {
    const id = newSpotId((bytes) => bytes.fill(0xab));
    assert.equal(id, 'spot-abababababab');
  });
});

describe('what storage holds', () => {
  it('round-trips a saved spot exactly', () => {
    const { spots } = put([], { id: null, from: 'fl-a', draft: draft('Round trip') }, 5);
    const parsed = parseLibrary(serialiseLibrary(spots));
    assert.equal(parsed.notice, null);
    assert.deepEqual(parsed.spots, spots);
  });

  it('keeps cards as text, never as engine integers', () => {
    const { spots } = put([], { id: null, from: null, draft: draft('Text') }, 5);
    const stored = JSON.parse(serialiseLibrary(spots));
    assert.equal(stored.spots[0].cards.hole1, 'Ah');
    assert.equal(stored.version, 1);
  });

  it('nothing stored is an empty list with no notice', () => {
    assert.deepEqual(parseLibrary(null), { spots: [], notice: null, newer: false });
  });

  it('corrupt JSON and foreign shapes are a notice, never a throw', () => {
    for (const raw of [
      '{not json',
      '"a string"',
      '[]',
      '{"version":1}',
      '{"version":"1","spots":[]}',
      'null',
    ]) {
      const parsed = parseLibrary(raw);
      assert.deepEqual(parsed.spots, [], raw);
      assert.equal(parsed.notice?.kind, 'unreadable', raw);
    }
  });

  it('an older or unknown version is unreadable; a newer one is left untouched', () => {
    assert.equal(parseLibrary('{"version":0,"spots":[]}').notice?.kind, 'unreadable');
    const newer = parseLibrary('{"version":2,"spots":[{"anything":true}]}');
    assert.deepEqual(newer.notice, { kind: 'newer', version: 2 });
    const store = new MemoryStore();
    store.setItem(SPOTS_STORAGE_KEY, '{"version":2,"spots":[]}');
    const library = readLibrary(store);
    assert.equal(library.writable, false);
    assert.deepEqual(writeLibrary(store, library, []), { ok: false, reason: 'newer' });
    assert.equal(store.getItem(SPOTS_STORAGE_KEY), '{"version":2,"spots":[]}');
  });

  it('drops entries that are not spots, counts them, and keeps the rest', () => {
    const { spots } = put([], { id: null, from: null, draft: draft('Good') }, 5);
    const stored = JSON.parse(serialiseLibrary(spots));
    const good = stored.spots[0];
    stored.spots.push(
      { ...good, id: 'spot-badcard', cards: { ...good.cards, hole1: 'Xx' } },
      { ...good, id: 'spot-badopp', opponents: 'none' },
      { ...good, id: good.id },
      42,
    );
    const parsed = parseLibrary(JSON.stringify(stored));
    assert.equal(parsed.spots.length, 1);
    assert.deepEqual(parsed.notice, { kind: 'skipped', count: 4 });
    assert.match(noticeSentence({ kind: 'skipped', count: 4 }), /4 saved spots could not be read/u);
  });

  it('storage that throws leaves an empty, unwritable library and a failed write, never a throw', () => {
    const library = readLibrary(THROWING);
    assert.deepEqual(library, { spots: [], notice: { kind: 'unavailable' }, writable: false });
    assert.doesNotThrow(() => writeLibrary(THROWING, library, []));
    assert.deepEqual(writeLibrary(THROWING, { ...library, notice: null }, []), {
      ok: false,
      reason: 'unavailable',
    });
    assert.deepEqual(readLibrary(null).notice, { kind: 'unavailable' });
  });

  it('saves the form it reads back: padded amounts, spaced names and an unused long range', () => {
    const base = draft('  Padded  ');
    const padded: SpotDraft = {
      ...base,
      heroStack: `${'0'.repeat(30)}1000`,
      heroBet: ' 0 ',
      opponents: base.opponents.map((o) => ({
        ...o,
        name: `   ${o.name}   `,
        stack: ' 0900',
        handKind: 'cards' as const,
        range: 'x'.repeat(1000),
      })),
    };
    const { spots } = put([], { id: null, from: null, draft: padded }, 5);
    const back = parseLibrary(serialiseLibrary(spots));
    assert.equal(back.notice, null);
    assert.equal(back.spots.length, 1);
    const stored = back.spots[0]?.draft;
    assert.equal(stored?.heroStack, '1000');
    assert.equal(stored?.heroBet, '0');
    assert.equal(stored?.name, 'Padded');
    assert.equal(stored?.opponents[0]?.name, 'Big blind');
    assert.equal(stored?.opponents[0]?.stack, '900');
    assert.deepEqual(back.spots, spots, 'what is kept in memory is what storage gives back');
  });

  it('keeps a range only for a range, cards only for exact cards, and neither for an unmodelled seat', () => {
    const base = draft('Kinds').opponents[0];
    assert.ok(base !== undefined);
    const seat = (key: string, handKind: 'range' | 'cards' | 'none') => ({
      ...base,
      key,
      handKind,
      range: 'my private read: JJ+, AK',
      cards: [c('Qs'), c('Qc')] as const,
      handLabel: { label: 'a built-in name', hand: 'range:QQ+' },
    });
    const kinds: SpotDraft = {
      ...draft('Kinds'),
      opponents: [seat('o1', 'range'), seat('o2', 'cards'), seat('o3', 'none')],
    };
    const { spots } = put([], { id: null, from: null, draft: kinds }, 5);
    const [range, cards, none] = JSON.parse(serialiseLibrary(spots)).spots[0].opponents;
    assert.equal(range.range, 'my private read: JJ+, AK');
    assert.equal('cards' in range, false, 'a range seat keeps no cards');
    assert.deepEqual(cards.cards, ['Qs', 'Qc']);
    assert.equal('range' in cards, false, 'an exact-cards seat keeps no range');
    assert.equal('range' in none, false, 'an unmodelled seat keeps no range');
    assert.equal('cards' in none, false, 'an unmodelled seat keeps no cards');
    for (const opponent of [range, cards, none]) {
      assert.equal('handLabel' in opponent, false, 'a label for a hand the seat no longer has is dropped');
    }
    assert.deepEqual(
      parseLibrary(serialiseLibrary(spots)).spots,
      spots,
      'and memory holds what storage does',
    );
  });

  it('keeps a built-in label while it still names the seat hand', () => {
    const base = draft('Label').opponents[0];
    assert.ok(base !== undefined);
    const opponent = { ...base, range: 'QQ+', handLabel: { label: 'a tight range', hand: 'range:QQ+' } };
    const { spots } = put(
      [],
      { id: null, from: 'fl-a', draft: { ...draft('Label'), opponents: [opponent] } },
      5,
    );
    const stored = JSON.parse(serialiseLibrary(spots)).spots[0].opponents[0];
    assert.deepEqual(stored.handLabel, { label: 'a tight range', hand: 'range:QQ+' });
  });

  it('reads a spot saved with the fields an unused hand used to keep, and drops them on the next save', () => {
    const { spots } = put([], { id: null, from: null, draft: draft('Old') }, 5);
    const old = JSON.parse(serialiseLibrary(spots));
    old.spots[0].opponents[0] = {
      ...old.spots[0].opponents[0],
      hand: 'none',
      range: 'my secret read: JJ+, AK',
      cards: ['Qs', 'Qc'],
      handLabel: null,
    };
    const read = parseLibrary(JSON.stringify(old));
    assert.equal(read.notice, null);
    const spot = read.spots[0];
    assert.ok(spot !== undefined);
    const held = { kind: 'copy', spot } as const;
    const again = put(read.spots, { id: spot.id, from: null, held, draft: spot.draft }, 6);
    const rewritten = serialiseLibrary(again.spots);
    assert.doesNotMatch(rewritten, /secret|"Qs"/u);
    assert.equal(JSON.parse(rewritten).version, 1);
  });

  it('refuses a write that would not read back, and leaves storage as it was', () => {
    const store = new MemoryStore();
    store.setItem(SPOTS_STORAGE_KEY, serialiseLibrary([]));
    const before = store.getItem(SPOTS_STORAGE_KEY);
    const broken: SavedSpot = {
      id: ids(),
      from: null,
      updatedAt: 1,
      draft: { ...draft('B'), heroStack: 'x'.repeat(40) },
    };
    assert.deepEqual(writeLibrary(store, readLibrary(store), [broken]), { ok: false, reason: 'unreadable' });
    assert.equal(store.getItem(SPOTS_STORAGE_KEY), before);
    assert.match(refusalSentence('unreadable'), /^Not saved/u);
  });

  it('names a full store as full, not as a browser that stores nothing', () => {
    const full: SpotStore = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      },
    };
    assert.deepEqual(writeLibrary(full, readLibrary(full), []), { ok: false, reason: 'full' });
    assert.match(refusalSentence('full'), /full/u);
    assert.doesNotMatch(refusalSentence('full'), /not letting/u);
  });

  it('writes what it reads back', () => {
    const store = new MemoryStore();
    const { spots } = put([], { id: null, from: null, draft: draft('Stored') }, 5);
    assert.deepEqual(writeLibrary(store, readLibrary(store), spots), { ok: true });
    const back: readonly SavedSpot[] = readLibrary(store).spots;
    assert.deepEqual(back, spots);
  });
});

describe('a spot whose built-in is gone, and a spot changed in another tab', () => {
  const known = (id: string): boolean => id === 'eq-flush-draw-turn-small-bet';
  const spot = (from: string | null): SavedSpot => ({
    id: 'spot-00000000000a',
    from,
    updatedAt: 7,
    draft: draft('S'),
  });

  it('opens an edit of a built-in this page no longer has by its own id, as the player own spot', () => {
    assert.equal(spotHref(spot('gone-scenario'), known), '/lab/spots/edit?id=spot-00000000000a');
    assert.equal(isEditOfBuiltIn(spot('gone-scenario'), known), false);
    assert.equal(
      spotHref(spot('eq-flush-draw-turn-small-bet'), known),
      '/lab/spots/edit?from=eq-flush-draw-turn-small-bet',
    );
    assert.equal(isEditOfBuiltIn(spot('eq-flush-draw-turn-small-bet'), known), true);
    assert.equal(spotHref(spot(null), known), '/lab/spots/edit?id=spot-00000000000a');
  });

  it('takes another tab save quietly only when there is nothing here to lose', () => {
    const stored = spot(null);
    const held = { kind: 'copy', spot: stored } as const;
    const older = { kind: 'copy', spot: { ...stored, updatedAt: 3 } } as const;
    const none = { kind: 'none' } as const;
    assert.deepEqual(syncWithStored(held, stored, true), { kind: 'same' });
    assert.deepEqual(syncWithStored(older, stored, false), { kind: 'adopt', spot: stored });
    assert.deepEqual(syncWithStored(older, stored, true), { kind: 'changed', spot: stored });
    assert.deepEqual(syncWithStored(none, stored, false), { kind: 'adopt', spot: stored });
    assert.deepEqual(syncWithStored(none, stored, true), { kind: 'changed', spot: stored });
    assert.deepEqual(syncWithStored(older, undefined, true), { kind: 'deleted' });
    assert.deepEqual(syncWithStored(none, undefined, true), { kind: 'same' });
  });

  it('compares the whole copy, so two saves in the same millisecond are still told apart', () => {
    const stored = spot(null);
    const held = { kind: 'copy', spot: { ...stored, draft: draft('Other') } } as const;
    assert.deepEqual(syncWithStored(held, stored, true), { kind: 'changed', spot: stored });
  });

  it('the first read of storage is where a tab starts, never a change from another tab', () => {
    // A built-in opened with ?from= used to announce its own saved edit as "updated in another tab".
    const unread = { kind: 'unread' } as const;
    assert.deepEqual(syncWithStored(unread, spot('eq-flush-draw-turn-small-bet'), false), { kind: 'same' });
    assert.deepEqual(syncWithStored(unread, undefined, false), { kind: 'same' });
  });
});

/** One editor tab, driven only through the storage functions the editor calls. */
interface Tab {
  editing: { id: string | null; from: string | null };
  held: Parameters<typeof syncWithStored>[0];
  draft: SpotDraft;
  saved: SpotDraft | null;
}

const ORIGINAL = draft('The built-in');
const FROM = 'eq-flush-draw-turn-small-bet';
const entries = (store: SpotStore): readonly SavedSpot[] => readLibrary(store).spots;
const same = (a: SavedSpot, b: SavedSpot): boolean => serialiseLibrary([a]) === serialiseLibrary([b]);

function take(tab: Tab, saved: SavedSpot): void {
  tab.editing = { id: saved.id, from: saved.from };
  tab.held = { kind: 'copy', spot: saved };
  tab.draft = saved.draft;
  tab.saved = saved.draft;
}

function openTab(store: SpotStore, from: string): Tab {
  const tab: Tab = { editing: { id: null, from }, held: { kind: 'unread' }, draft: ORIGINAL, saved: null };
  const found = editOf(entries(store), from);
  if (found === undefined) tab.held = { kind: 'none' };
  else take(tab, found);
  return tab;
}

const edited = (tab: Tab): boolean => JSON.stringify(tab.saved ?? ORIGINAL) !== JSON.stringify(tab.draft);

/** The `storage` event: a tab with nothing to lose takes the newer copy, as the editor does. */
function settle(tab: Tab, store: SpotStore): ReturnType<typeof syncWithStored> {
  const sync = syncWithStored(tab.held, storedCopy(entries(store), tab.editing), edited(tab));
  if (sync.kind === 'adopt') take(tab, sync.spot);
  return sync;
}

/** A refused write re-renders the editor, and a tab with nothing to lose then shows the other copy. */
function refuse(tab: Tab, conflict: SavedSpot): 'refused' {
  if (!edited(tab)) take(tab, conflict);
  return 'refused';
}

function save(tab: Tab, store: SpotStore, now: number): 'saved' | 'refused' {
  const library = readLibrary(store);
  const result = saveSpot(library.spots, { ...tab.editing, held: tab.held, draft: tab.draft }, now, ids);
  if ('conflict' in result) return refuse(tab, result.conflict);
  assert.deepEqual(writeLibrary(store, library, result.spots), { ok: true });
  take(tab, result.saved);
  return 'saved';
}

/** The editor's Delete, or its Reset to original for an edit of the built-in, on what its prompt asked. */
function remove(
  tab: Tab,
  store: SpotStore,
  asked: RemoveRequest = { ...tab.editing, held: tab.held },
): 'removed' | 'refused' {
  const library = readLibrary(store);
  const result = removeSpot(library.spots, asked);
  if ('conflict' in result) return refuse(tab, result.conflict);
  assert.deepEqual(writeLibrary(store, library, result.spots), { ok: true });
  if (tab.editing.from === FROM) {
    tab.editing = { id: null, from: FROM };
    tab.held = { kind: 'none' };
    tab.draft = ORIGINAL;
    tab.saved = null;
  }
  return 'removed';
}

/** The list's Delete or Reset to original, aimed at the entry as the list last drew it. */
function removeListed(target: SavedSpot, store: SpotStore): 'removed' | 'refused' {
  const library = readLibrary(store);
  const held = { kind: 'copy', spot: target } as const;
  const result = removeSpot(library.spots, { id: target.id, from: target.from, held });
  if ('conflict' in result) return 'refused';
  assert.deepEqual(writeLibrary(store, library, result.spots), { ok: true });
  return 'removed';
}

/** A tab opened with `?id=`, on a spot another tab may have open too. */
function openSpot(spot: SavedSpot): Tab {
  const tab: Tab = {
    editing: { id: null, from: null },
    held: { kind: 'unread' },
    draft: ORIGINAL,
    saved: null,
  };
  take(tab, spot);
  return tab;
}

const rename = (tab: Tab, name: string): void => {
  tab.draft = { ...tab.draft, name };
};

describe('two tabs: no save, reset or delete removes a copy its tab has not seen', () => {
  it('a reset in tab B before tab A save reaches it removes nothing, and B is told', () => {
    for (const dirty of [false, true]) {
      const store = new MemoryStore();
      const a = openTab(store, FROM);
      rename(a, 'E1');
      assert.equal(save(a, store, 1), 'saved');
      const b = openTab(store, FROM);
      if (dirty) rename(b, 'B edit');
      rename(a, 'E2');
      assert.equal(save(a, store, 2), 'saved');
      assert.equal(remove(b, store), 'refused', 'B never saw E2, so its reset is refused');
      assert.deepEqual(
        entries(store).map((spot) => spot.draft.name),
        ['E2'],
      );
      const sync = settle(b, store);
      if (dirty) {
        assert.equal(sync.kind, 'changed', 'B has changes, so it is offered Load or Keep');
        if (sync.kind === 'changed') b.held = { kind: 'copy', spot: sync.spot };
      } else assert.equal(b.draft.name, 'E2', 'B had nothing to lose, so it shows E2');
      assert.equal(remove(b, store), 'removed', 'after being told, B resets E2');
      assert.deepEqual(entries(store), []);
    }
  });

  it('a delete in tab B before tab A save of the same spot reaches it removes nothing', () => {
    const store = new MemoryStore();
    const own = put([], { id: null, from: null, draft: draft('S1') }, 1);
    writeLibrary(store, readLibrary(store), own.spots);
    const a = openSpot(own.saved);
    const b = openSpot(own.saved);
    rename(a, 'S2');
    assert.equal(save(a, store, 2), 'saved');
    assert.equal(remove(b, store), 'refused');
    assert.deepEqual(
      entries(store).map((spot) => spot.draft.name),
      ['S2'],
    );
    assert.equal(b.draft.name, 'S2', 'B had nothing to lose, so it shows S2');
    assert.equal(remove(b, store), 'removed');
    assert.deepEqual(entries(store), []);
  });

  it('the list removes only the entry as it drew it', () => {
    const store = new MemoryStore();
    const a = openTab(store, FROM);
    rename(a, 'E1');
    assert.equal(save(a, store, 1), 'saved');
    const drawn = entries(store)[0] as SavedSpot;
    assert.equal(remove(a, store), 'removed');
    rename(a, 'E2');
    assert.equal(save(a, store, 2), 'saved');
    assert.equal(removeListed(drawn, store), 'refused', 'a reset and a new edit elsewhere is not removed');
    assert.equal(removeListed(entries(store)[0] as SavedSpot, store), 'removed');
    assert.equal(removeListed(drawn, store), 'removed', 'a copy already gone leaves the list as it is');
  });

  it('says a refused write was not done, and keeps the sentence a refused save always had', () => {
    assert.equal(
      conflictSentence('save', 'choose'),
      'Not saved. This spot changed in another tab. Load that copy, or keep yours to save over it.',
    );
    assert.equal(
      conflictSentence('reset', 'choose'),
      'Not reset. This spot changed in another tab. Load that copy or keep yours, then reset again.',
    );
    assert.equal(
      conflictSentence('delete', 'shown'),
      'Not deleted. This spot changed in another tab. That copy is shown now. Delete again to remove it.',
    );
    assert.equal(
      conflictSentence('reset', 'open'),
      'Not reset. This spot changed in another tab. Open it to see that copy, or reset again.',
    );
  });

  it('a reset and a new edit in tab A are not overwritten by tab B, dirty or clean when A reset', () => {
    for (const cleanAtReset of [false, true]) {
      const store = new MemoryStore();
      const a = openTab(store, FROM);
      rename(a, 'E by A');
      assert.equal(save(a, store, 1), 'saved');
      const b = openTab(store, FROM);
      assert.equal(b.draft.name, 'E by A');
      if (!cleanAtReset) rename(b, 'B edit');
      assert.equal(remove(a, store), 'removed');
      settle(b, store);
      if (cleanAtReset) rename(b, 'B edit');
      rename(a, 'E2 by A');
      assert.equal(save(a, store, 2), 'saved');
      const sync = settle(b, store);
      assert.equal(sync.kind, 'changed', 'B is told the copy changed, not that it was deleted');
      assert.equal(save(b, store, 3), 'refused', 'B cannot save over E2 without choosing');
      assert.deepEqual(
        entries(store).map((spot) => spot.draft.name),
        ['E2 by A'],
      );
      settle(a, store);
      assert.equal(a.draft.name, 'E2 by A', 'A keeps its own edit');
      // "Keep mine" is the reader choosing: B now holds E2, so its save replaces it.
      if (sync.kind === 'changed') b.held = { kind: 'copy', spot: sync.spot };
      assert.equal(save(b, store, 4), 'saved');
      assert.deepEqual(
        entries(store).map((spot) => spot.draft.name),
        ['B edit'],
      );
    }
  });

  it('holds for every order of saves, resets, duplicates, deletes and reloads (seeded)', () => {
    let seed = 20_261_123;
    const next = (n: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return Math.floor((seed / 2_147_483_648) * n);
    };
    const OPS = ['edit', 'save', 'reset', 'duplicate', 'delete', 'keep', 'load', 'reload', 'list'] as const;
    const counts = { saves: 0, resets: 0, deletes: 0, listed: 0, refusedResets: 0, refusedDeletes: 0 };
    let refusedList = 0;
    const copyIn = (held: HeldCopy) => (entry: SavedSpot) => held.kind === 'copy' && same(held.spot, entry);
    for (let run = 0; run < 3000; run += 1) {
      const store = new MemoryStore();
      // Every other run starts with both tabs on one spot of the player's own, where Delete applies.
      const own = run % 2 === 0 ? undefined : put([], { id: null, from: null, draft: draft('Own') }, 0).saved;
      if (own !== undefined) writeLibrary(store, readLibrary(store), [own]);
      const tabs =
        own === undefined ? [openTab(store, FROM), openTab(store, FROM)] : [openSpot(own), openSpot(own)];
      let listed = entries(store);
      for (let step = 0; step < 16; step += 1) {
        const index = next(2);
        const tab = tabs[index] as Tab;
        const op = OPS[next(OPS.length)];
        const now = run * 100 + step;
        // Another tab's write reaches this one as a `storage` event some time later, or not yet.
        const arrived = next(2) === 0;
        const sync = arrived ? settle(tab, store) : null;
        if (arrived) listed = entries(store);
        const before = entries(store);
        let holds = copyIn(tab.held);
        if (op === 'edit') rename(tab, `${index}-${now}`);
        else if (op === 'save') {
          if (save(tab, store, now) === 'saved') counts.saves += 1;
        } else if (op === 'reset' && tab.editing.from === FROM && tab.editing.id !== null) {
          if (remove(tab, store) === 'refused') counts.refusedResets += 1;
          else counts.resets += 1;
        } else if (op === 'duplicate') {
          const copy = duplicateDraft(before, tab.draft, now, ids);
          writeLibrary(store, readLibrary(store), copy.spots);
          take(tab, copy.saved);
        } else if (op === 'delete' && tab.editing.from !== FROM && tab.editing.id !== null) {
          if (remove(tab, store) === 'refused') counts.refusedDeletes += 1;
          else {
            counts.deletes += 1;
            tabs[index] = openTab(store, FROM);
          }
        } else if (op === 'keep' && sync?.kind === 'changed') {
          const kept = keepMine(entries(store), tab.editing);
          tab.editing = kept.editing;
          tab.held = kept.held;
        } else if (op === 'load' && sync?.kind === 'changed') take(tab, sync.spot);
        else if (op === 'reload') {
          // Half the time onto the spot the other tab has open, so two tabs share one of the player's own.
          const other = (tabs[1 - index] as Tab).editing.id;
          const spot = next(2) === 0 ? entries(store).find((entry) => entry.id === other) : undefined;
          tabs[index] = spot === undefined ? openTab(store, FROM) : openSpot(spot);
        } else if (op === 'list' && listed.length > 0) {
          const target = listed[next(listed.length)] as SavedSpot;
          holds = copyIn({ kind: 'copy', spot: target });
          if (removeListed(target, store) === 'refused') refusedList += 1;
          else counts.listed += 1;
          listed = entries(store);
        }
        const after = entries(store);
        for (const entry of before) {
          if (after.some((candidate) => same(candidate, entry))) continue;
          assert.ok(
            holds(entry),
            `run ${run} step ${step}: ${op} in tab ${index} removed "${entry.draft.name}" without holding it`,
          );
        }
        const edits = after.filter((entry) => entry.from === FROM);
        assert.ok(edits.length <= 1, `run ${run} step ${step}: ${edits.length} edits of one built-in`);
      }
    }
    assert.ok(counts.saves > 4000, `only ${counts.saves} saves went through: a sweep of nothing`);
    const ran = JSON.stringify({ ...counts, refusedList });
    assert.ok(counts.resets > 500 && counts.deletes > 500 && counts.listed > 500, ran);
    // The run's guards each fired; the counts are read off seed 20261123 (28, 67 and 105 refused).
    assert.ok(counts.refusedResets > 20 && counts.refusedDeletes > 40 && refusedList > 60, ran);
  });
});

describe('a Delete or Reset prompt removes only the copy it asked about', () => {
  const copy = (spot: SavedSpot) => ({ kind: 'copy', spot }) as const;

  it('sees the copy behind an open prompt change, move to a new id, or go', () => {
    const s1 = put([], { id: null, from: null, draft: draft('S1') }, 1);
    const asked = { id: s1.saved.id, from: null, held: copy(s1.saved) };
    assert.deepEqual(askedCopy(s1.spots, asked), { kind: 'same', spot: s1.saved });
    const s2 = put(s1.spots, { id: s1.saved.id, from: null, held: copy(s1.saved), draft: draft('S2') }, 2);
    assert.deepEqual(askedCopy(s2.spots, asked), { kind: 'changed', spot: s2.saved });
    assert.ok('conflict' in removeSpot(s2.spots, asked), 'confirming after the change removes nothing');
    assert.deepEqual(askedCopy([], asked), { kind: 'gone' });

    const e1 = put([], { id: null, from: FROM, draft: draft('E1') }, 1);
    const reset = { id: e1.saved.id, from: FROM, held: copy(e1.saved) };
    const e2 = put([], { id: null, from: FROM, draft: draft('E2') }, 2);
    assert.notEqual(e2.saved.id, e1.saved.id);
    assert.deepEqual(askedCopy(e2.spots, reset), { kind: 'changed', spot: e2.saved });
  });

  it('says on the prompt that the copy changed, and what pressing on will do', () => {
    assert.equal(
      changedSincePrompt('delete'),
      'This spot changed in another tab. Delete will not remove the new copy.',
    );
    assert.equal(
      changedSincePrompt('reset'),
      'This spot changed in another tab. Reset will not remove the new copy.',
    );
    assert.equal(
      conflictSentence('delete', 'kept'),
      'Not deleted. This spot changed in another tab. You kept yours, so delete again to remove it.',
    );
  });

  it('a refusal says what the tab can do next, from what it holds when the refusal lands', () => {
    const s1 = put([], { id: null, from: null, draft: draft('S1') }, 1);
    const s2 = put(s1.spots, { id: s1.saved.id, from: null, held: copy(s1.saved), draft: draft('S2') }, 2);
    const older = copy(s1.saved);
    assert.deepEqual(refusal('delete', older, s2.saved, true), {
      show: false,
      sentence: conflictSentence('delete', 'choose'),
    });
    assert.deepEqual(refusal('delete', older, s2.saved, false), {
      show: true,
      sentence: conflictSentence('delete', 'shown'),
    });
    // "Keep mine" pressed while the prompt was open: the tab holds the newer copy and has changes.
    assert.deepEqual(refusal('reset', copy(s2.saved), s2.saved, true), {
      show: false,
      sentence: conflictSentence('reset', 'kept'),
    });
    assert.deepEqual(refusal('delete', copy(s2.saved), s2.saved, false), {
      show: true,
      sentence: conflictSentence('delete', 'shown'),
    });
  });

  it('a prompt opened before another tab saved stays on the copy it asked about (seeded)', () => {
    let seed = 20_261_124;
    const next = (n: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return Math.floor((seed / 2_147_483_648) * n);
    };
    let refused = 0;
    let removed = 0;
    for (let run = 0; run < 400; run += 1) {
      const store = new MemoryStore();
      const own = run % 2 === 0;
      const first = own
        ? put([], { id: null, from: null, draft: draft('Own') }, 0).saved
        : put([], { id: null, from: FROM, draft: draft('Edit') }, 0).saved;
      writeLibrary(store, readLibrary(store), [first]);
      const a = openSpot(first);
      const b = openSpot(first);
      if (next(2) === 0) rename(b, 'B edit');
      const asked = { ...b.editing, held: b.held };
      if (next(3) > 0) {
        if (!own && next(2) === 0) {
          assert.equal(remove(a, store), 'removed');
          rename(a, `A ${run}`);
        } else rename(a, `A ${run}`);
        assert.equal(save(a, store, 1), 'saved');
      }
      // The render after the press reads storage again, which is how a newer copy reached the confirm.
      settle(b, store);
      const before = entries(store);
      const result = remove(b, store, asked);
      if (result === 'refused') refused += 1;
      else removed += 1;
      for (const entry of before) {
        if (entries(store).some((left) => same(left, entry))) continue;
        assert.ok(same(entry, first), `run ${run}: confirm removed "${entry.draft.name}", not what it asked`);
      }
    }
    assert.ok(refused > 100 && removed > 100, `${refused} refused, ${removed} removed`);
  });

  it('"Keep mine" holds the copy stored when it is pressed, not the one the notice drew', () => {
    const other = put([], { id: null, from: null, draft: draft('Other') }, 0);
    const s1 = put(other.spots, { id: null, from: FROM, draft: draft('K1') }, 1);
    const s2 = put(s1.spots, { id: s1.saved.id, from: FROM, held: copy(s1.saved), draft: draft('K2') }, 2);
    const s3 = put(s2.spots, { id: s1.saved.id, from: FROM, held: copy(s2.saved), draft: draft('K3') }, 3);
    const editing = { id: s1.saved.id, from: FROM };
    const kept = keepMine(s3.spots, editing);
    assert.deepEqual(kept.held, copy(s3.saved), 'the newest copy, which a save then replaces');
    assert.deepEqual(kept.editing, { id: s3.saved.id, from: FROM });
    assert.equal(kept.sentence, 'Kept your changes. Saving replaces the copy from the other tab.');
    const gone = keepMine([], editing);
    assert.deepEqual(gone.held, { kind: 'none' });
    assert.equal(gone.sentence, 'Kept your changes. The other tab deleted this spot, so saving keeps yours.');
  });

  it('says a repeated sentence again, with a difference only a screen reader notices', () => {
    const first = repeated('', 'Not saved.');
    const second = repeated(first, 'Not saved.');
    const third = repeated(second, 'Not saved.');
    assert.equal(first, 'Not saved.');
    assert.notEqual(second, first);
    assert.equal(second.trim(), 'Not saved.');
    assert.notEqual(third, second);
    assert.equal(repeated('Saved.', 'Not saved.'), 'Not saved.');
  });
});

describe('a saved time no Date can hold', () => {
  const at = (updatedAt: number): string => {
    const { spots } = put([], { id: null, from: null, draft: draft('Time') }, 5);
    const stored = JSON.parse(serialiseLibrary(spots));
    stored.spots[0].updatedAt = updatedAt;
    return JSON.stringify(stored);
  };

  it('is an unreadable entry, counted with the rest, on either side of the range', () => {
    for (const edge of [MAX_TIME, -MAX_TIME, 0]) {
      assert.equal(parseLibrary(at(edge)).spots.length, 1, String(edge));
    }
    for (const beyond of [MAX_TIME + 1, -MAX_TIME - 1, 9e15]) {
      const parsed = parseLibrary(at(beyond));
      assert.deepEqual(parsed.spots, [], String(beyond));
      assert.deepEqual(parsed.notice, { kind: 'skipped', count: 1 }, String(beyond));
    }
  });

  it('formats to nothing rather than throw', () => {
    assert.equal(savedAt(9e15), null);
    assert.equal(savedAt(Number.NaN), null);
    assert.equal(savedAt(MAX_TIME + 1), null);
    // Every time readSpot accepts formats, so an entry that reads back is never a blank row.
    for (const edge of [MAX_TIME, -MAX_TIME]) assert.notEqual(savedAt(edge), null, String(edge));
    assert.deepEqual(savedAt(Date.UTC(2026, 10, 23, 9, 5)), {
      iso: '2026-11-23T09:05:00.000Z',
      text: new Intl.DateTimeFormat('en-GB', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      }).format(Date.UTC(2026, 10, 23, 9, 5)),
    });
  });
});

describe('a spot not linked to a built-in keeps no built-in name for a hand', () => {
  const labelled = (): SpotDraft => {
    const base = draft('Label');
    const opponent = base.opponents[0];
    assert.ok(opponent !== undefined);
    const handLabel = { label: 'a tight range', hand: 'range:QQ+' };
    return { ...base, opponents: [{ ...opponent, range: 'QQ+', handLabel }] };
  };
  const storedLabel = (spots: readonly SavedSpot[]): unknown =>
    JSON.parse(serialiseLibrary(spots)).spots.at(-1).opponents[0].handLabel;

  it('drops the label on a duplicate, and on a save of a spot of the player own', () => {
    const copied = duplicateDraft([], labelled(), 5, ids);
    assert.equal(copied.saved.from, null);
    assert.equal(copied.saved.draft.opponents[0]?.handLabel, null);
    assert.equal(storedLabel(copied.spots), undefined);
    const own = put([], { id: null, from: null, draft: labelled() }, 5);
    assert.equal(storedLabel(own.spots), undefined);
    const linked = put([], { id: null, from: 'fl-a', draft: labelled() }, 5);
    assert.deepEqual(storedLabel(linked.spots), { label: 'a tight range', hand: 'range:QQ+' });
  });

  it('reads a label stored on an unlinked spot as none, so the next write drops it', () => {
    const linked = put([], { id: null, from: 'fl-a', draft: labelled() }, 5);
    const stored = JSON.parse(serialiseLibrary(linked.spots));
    stored.spots[0].from = null;
    const read = parseLibrary(JSON.stringify(stored));
    assert.equal(read.notice, null);
    assert.equal(read.spots[0]?.draft.opponents[0]?.handLabel, null);
    assert.equal(storedLabel(read.spots), undefined);
  });
});

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
  deleteSpot,
  duplicateDraft,
  editOf,
  newSpotId,
  noticeSentence,
  parseLibrary,
  readLibrary,
  resetToOriginal,
  SPOTS_STORAGE_KEY,
  type SpotStore,
  saveSpot,
  serialiseLibrary,
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
    const { spots, saved } = saveSpot([], { id: null, from: null, draft: draft('Mine') }, 10, ids);
    assert.equal(spots.length, 1);
    assert.equal(saved.from, null);
    assert.match(saved.id, /^spot-/u);
    assert.equal(saved.updatedAt, 10);
  });

  it('edits in place: the same id, the new draft, nothing added', () => {
    const first = saveSpot([], { id: null, from: null, draft: draft('Mine') }, 10, ids);
    const second = saveSpot(
      first.spots,
      { id: first.saved.id, from: null, draft: draft('Renamed') },
      20,
      ids,
    );
    assert.equal(second.spots.length, 1);
    assert.equal(second.saved.id, first.saved.id);
    assert.equal(second.spots[0]?.draft.name, 'Renamed');
  });

  it('keeps one edit per built-in, linked to it', () => {
    const first = saveSpot([], { id: null, from: 'fl-a', draft: draft('Edit one') }, 10, ids);
    const again = saveSpot(first.spots, { id: null, from: 'fl-a', draft: draft('Edit two') }, 20, ids);
    assert.equal(again.spots.length, 1);
    assert.equal(editOf(again.spots, 'fl-a')?.draft.name, 'Edit two');
  });

  it('duplicates as a new spot of the player own, never linked to the built-in', () => {
    const edit = saveSpot([], { id: null, from: 'fl-a', draft: draft('Edit') }, 10, ids);
    const copy = duplicateDraft(edit.spots, edit.saved.draft, 20, ids);
    assert.equal(copy.spots.length, 2);
    assert.equal(copy.saved.from, null);
    assert.equal(copy.saved.draft.name, 'Edit (copy)');
    assert.notEqual(copy.saved.id, edit.saved.id);
  });

  it('deletes one spot and leaves the others', () => {
    const a = saveSpot([], { id: null, from: null, draft: draft('A') }, 1, ids);
    const b = saveSpot(a.spots, { id: null, from: null, draft: draft('B') }, 2, ids);
    const left = deleteSpot(b.spots, a.saved.id);
    assert.deepEqual(
      left.map((spot) => spot.draft.name),
      ['B'],
    );
  });

  it('reset to original removes the edit of that built-in only', () => {
    const a = saveSpot([], { id: null, from: 'fl-a', draft: draft('Edit A') }, 1, ids);
    const b = saveSpot(a.spots, { id: null, from: 'fl-b', draft: draft('Edit B') }, 2, ids);
    const mine = saveSpot(b.spots, { id: null, from: null, draft: draft('Mine') }, 3, ids);
    const reset = resetToOriginal(mine.spots, 'fl-a');
    assert.equal(editOf(reset, 'fl-a'), undefined);
    assert.equal(reset.length, 2);
  });

  it('makes ids from the random source, prefixed so none reads as a scenario id', () => {
    const id = newSpotId((bytes) => bytes.fill(0xab));
    assert.equal(id, 'spot-abababababab');
  });
});

describe('what storage holds', () => {
  it('round-trips a saved spot exactly', () => {
    const { spots } = saveSpot([], { id: null, from: 'fl-a', draft: draft('Round trip') }, 5, ids);
    const parsed = parseLibrary(serialiseLibrary(spots));
    assert.equal(parsed.notice, null);
    assert.deepEqual(parsed.spots, spots);
  });

  it('keeps cards as text, never as engine integers', () => {
    const { spots } = saveSpot([], { id: null, from: null, draft: draft('Text') }, 5, ids);
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
    const { spots } = saveSpot([], { id: null, from: null, draft: draft('Good') }, 5, ids);
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

  it('writes what it reads back', () => {
    const store = new MemoryStore();
    const { spots } = saveSpot([], { id: null, from: null, draft: draft('Stored') }, 5, ids);
    assert.deepEqual(writeLibrary(store, readLibrary(store), spots), { ok: true });
    const back: readonly SavedSpot[] = readLibrary(store).spots;
    assert.deepEqual(back, spots);
  });
});

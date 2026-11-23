/**
 * The Delete and Reset prompt of the editor, the list and the scenario page, driven through the machine
 * and the real storage functions the way `use-spot-prompt.ts` drives them, while other tabs write. There
 * is no DOM (ADR 0008), so what a page draws is modelled from its component's render rules in `renders`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseCardText } from '@prl/ui/cards';
import { blankDraft, type SavedSpot, type SpotDraft } from '../src/lib/spot.ts';
import {
  CLOSED,
  displayName,
  type Focus,
  type Prompt,
  type Removal,
  type Said,
  type Step,
  type Surface,
  step,
  stillTrue,
} from '../src/lib/spot-prompt.ts';
import {
  editOf,
  type HeldCopy,
  keepMine,
  readLibrary,
  type SpotStore,
  sameCopy,
  saveRefusal,
  saveSpot,
  storedCopy,
  syncWithStored,
  writeLibrary,
} from '../src/lib/spot-storage.ts';

const FROM = 'eq-flush-draw-turn-small-bet';

function card(text: string): number {
  const parsed = parseCardText(text);
  assert.ok(parsed !== null, text);
  return parsed;
}

function draft(name: string): SpotDraft {
  return {
    ...blankDraft(),
    name,
    cards: { ...blankDraft().cards, hole1: card('Ah'), hole2: card('Kd'), flop1: card('2c') },
  };
}

const ORIGINAL = draft('The built-in');

let counter = 0;
function ids(): string {
  counter += 1;
  return `spot-${String(counter).padStart(12, '0')}`;
}

class MemoryStore implements SpotStore {
  readonly items = new Map<string, string>();
  failing = false;
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.failing) throw new Error('SecurityError');
    this.items.set(key, value);
  }
}

const entries = (store: SpotStore): readonly SavedSpot[] => readLibrary(store).spots;

function seed(store: SpotStore, ...spots: readonly SavedSpot[]): void {
  assert.deepEqual(writeLibrary(store, readLibrary(store), spots), { ok: true });
}

function spot(name: string, from: string | null = null, at = 1): SavedSpot {
  return { id: ids(), from, updatedAt: at, draft: draft(name) };
}

/** Another tab's save over what is stored where `copy` is kept. */
function saveElsewhere(store: SpotStore, copy: SavedSpot, name: string, at: number): SavedSpot {
  const stored = storedCopy(entries(store), copy);
  const held: HeldCopy = stored === undefined ? { kind: 'none' } : { kind: 'copy', spot: stored };
  const result = saveSpot(
    entries(store),
    { id: copy.id, from: copy.from, held, draft: draft(name) },
    at,
    ids,
  );
  assert.ok(!('conflict' in result));
  seed(store, ...result.spots);
  return result.saved;
}

function deleteElsewhere(store: SpotStore, copy: SavedSpot): void {
  const stored = storedCopy(entries(store), copy);
  seed(store, ...entries(store).filter((entry) => entry.id !== stored?.id));
}

/** One page in one tab, wired the way `useSpotPrompt` wires it: every event reads storage first. */
class Page {
  prompt: Prompt = CLOSED;
  said: Said | null = null;
  focus: Focus | null = null;
  readonly heard: string[] = [];
  readonly surface: Surface;
  readonly store: MemoryStore;
  constructor(surface: Surface, store: MemoryStore) {
    this.surface = surface;
    this.store = store;
  }
  apply(next: Step): Step {
    this.prompt = next.prompt;
    if (next.said !== null) {
      this.said = next.said;
      this.heard.push(next.said.sentence);
    }
    if (next.focus !== null) this.focus = next.focus;
    return next;
  }
  open(write: Removal, copy: SavedSpot, yours = false): Step {
    const spots = entries(this.store);
    return this.apply(step(this.prompt, { type: 'open', surface: this.surface, write, copy, spots, yours }));
  }
  /** The render a `storage` event or the page's own state change causes. */
  render(yours = false): Step {
    const next = step(this.prompt, { type: 'stored', spots: entries(this.store), yours });
    return next.prompt === this.prompt ? next : this.apply(next);
  }
  cancel(): Step {
    return this.apply(step(this.prompt, { type: 'cancel', spots: entries(this.store) }));
  }
  confirm(yours = false): Step {
    const library = readLibrary(this.store);
    const asked = this.apply(step(this.prompt, { type: 'confirm', spots: library.spots, yours }));
    if (asked.write === null) return asked;
    const result = writeLibrary(this.store, library, asked.write);
    return this.apply(step(asked.prompt, { type: 'written', result }));
  }
}

describe('after its copy changes, a prompt closes and removes nothing (REGRESSION)', () => {
  it('the editor: after Keep it no stale line is left, and the next Delete removes only the copy shown', () => {
    const store = new MemoryStore();
    const s1 = spot('S1');
    seed(store, s1);
    const editor = new Page('editor', store);
    assert.equal(editor.open('delete', s1).prompt.kind, 'asking');
    const s2 = saveElsewhere(store, s1, 'S2', 2);
    const closed = editor.render();
    assert.equal(
      closed.prompt.kind,
      'closed',
      'the prompt does not stay open on a copy it never asked about',
    );
    assert.equal(closed.write, null);
    assert.deepEqual(closed.shown, s2, 'a clean editor takes the newer copy');
    assert.equal(
      closed.said?.sentence,
      'This spot changed in another tab, so nothing was deleted. The new copy is shown.',
    );
    const heard = editor.heard.length;
    assert.equal(editor.cancel().prompt.kind, 'closed');
    assert.equal(editor.heard.length, heard, 'nothing is left to cancel, and nothing more is said');
    assert.ok(editor.heard.every((sentence) => !/will not remove/u.test(sentence)));
    assert.deepEqual(entries(store), [s2], 'the newer copy is still stored');

    assert.equal(editor.open('delete', s2).prompt.kind, 'asking', 'Delete now asks about the copy shown');
    editor.confirm();
    assert.deepEqual(entries(store), []);
  });

  it('with its events held, the confirm itself sees the change and removes nothing', () => {
    const store = new MemoryStore();
    const s1 = spot('S1');
    seed(store, s1);
    const editor = new Page('editor', store);
    editor.open('delete', s1);
    const s2 = saveElsewhere(store, s1, 'S2', 2);
    const confirmed = editor.confirm();
    assert.equal(confirmed.write, null);
    assert.equal(confirmed.prompt.kind, 'closed');
    assert.deepEqual(entries(store), [s2]);
  });

  it('a prompt opened on a copy storage no longer holds never opens', () => {
    const store = new MemoryStore();
    const s1 = spot('S1');
    seed(store, s1);
    saveElsewhere(store, s1, 'S2', 2);
    for (const surface of ['editor', 'list', 'scenario'] as const) {
      const opened = new Page(surface, store).open('delete', s1);
      assert.equal(opened.prompt.kind, 'closed', surface);
      assert.equal(opened.focus?.onlyIfLost, false, `${surface}: a press always moves the caret`);
    }
  });

  it('a dirty editor keeps its changes on screen and says so, rather than claiming the new copy', () => {
    const store = new MemoryStore();
    const s1 = spot('S1');
    seed(store, s1);
    const editor = new Page('editor', store);
    editor.open('delete', s1, true);
    saveElsewhere(store, s1, 'S2', 2);
    const closed = editor.render(true);
    assert.equal(closed.shown, null);
    assert.equal(
      closed.said?.sentence,
      'This spot changed in another tab, so nothing was deleted. Your changes are still here.',
    );
  });

  it('every surface closes when its copy is deleted, the editor too', () => {
    const gone: Readonly<Record<Surface, string>> = {
      editor: 'This spot was deleted in another tab, so there is nothing to reset.',
      list: '"L1" was removed in another tab.',
      scenario: 'Your edit was removed in another tab.',
    };
    for (const surface of ['editor', 'list', 'scenario'] as const) {
      const store = new MemoryStore();
      const edit = spot('L1', FROM);
      seed(store, edit);
      const page = new Page(surface, store);
      page.open('reset', edit);
      deleteElsewhere(store, edit);
      const closed = page.render();
      assert.equal(closed.prompt.kind, 'closed', surface);
      assert.equal(closed.said?.sentence, gone[surface]);
      assert.deepEqual(closed.focus, { on: 'stable', onlyIfLost: true }, surface);
    }
  });
});

describe('a sentence claims only what happened (REGRESSION)', () => {
  it('"kept" is said by Keep mine and by nothing else, and Delete after it removes the kept copy', () => {
    const store = new MemoryStore();
    const s1 = spot('S1');
    seed(store, s1);
    const editor = new Page('editor', store);
    editor.open('delete', s1, true);
    const s2 = saveElsewhere(store, s1, 'S2', 2);
    editor.render(true);
    editor.confirm(true);
    assert.ok(editor.heard.length > 0);
    assert.ok(
      editor.heard.every((sentence) => !/kept|keep/iu.test(sentence)),
      editor.heard.join(' | '),
    );
    const kept = keepMine(entries(store), { id: s1.id, from: null });
    assert.equal(kept.sentence, 'Kept your changes. Saving replaces the copy from the other tab.');
    assert.deepEqual(kept.held, { kind: 'copy', spot: s2 });
    editor.open('delete', s2, true);
    editor.confirm(true);
    assert.deepEqual(entries(store), []);
  });

  it('the list names the copy it drew and the copy it shows now', () => {
    const store = new MemoryStore();
    const l1 = spot('L1');
    const other = spot('Other');
    seed(store, l1, other);
    const list = new Page('list', store);
    list.open('delete', l1);
    const l1b = saveElsewhere(store, l1, 'L1b', 2);
    const changed = list.render();
    assert.equal(
      changed.said?.sentence,
      '"L1" changed in another tab, so nothing was deleted. The new copy is shown as "L1b".',
    );
    assert.deepEqual(changed.focus, { on: 'action', id: l1b.id, onlyIfLost: true });
    list.open('delete', l1b);
    deleteElsewhere(store, l1b);
    assert.equal(
      list.render().said?.sentence,
      '"L1b" was deleted in another tab.',
      'not the name it had before',
    );
  });

  it('the scenario page says changed when its edit changed, and removed only when gone', () => {
    for (const at of [2, 3]) {
      const store = new MemoryStore();
      const first = spot('S1', FROM, 1);
      seed(store, first);
      const scenario = new Page('scenario', store);
      scenario.open('reset', first);
      const next = saveElsewhere(store, first, 'S2', at);
      const changed = scenario.render();
      assert.equal(
        changed.said?.sentence,
        'Your edit changed in another tab, so nothing was reset. Open it to see the new copy.',
        String(at),
      );
      assert.deepEqual(changed.focus, { on: 'action', id: next.id, onlyIfLost: true }, String(at));
      scenario.open('reset', next);
      deleteElsewhere(store, next);
      assert.equal(scenario.render().said?.sentence, 'Your edit was removed in another tab.', String(at));
    }
  });

  it('a change and a deletion seen in one read name the copy that was on screen', () => {
    const store = new MemoryStore();
    const l1 = spot('L1');
    seed(store, l1);
    const list = new Page('list', store);
    list.open('delete', l1);
    deleteElsewhere(store, saveElsewhere(store, l1, 'L1b', 2));
    assert.equal(list.render().said?.sentence, '"L1" was deleted in another tab.');
  });

  it('a sentence is shown only while storage still holds what it describes', () => {
    const store = new MemoryStore();
    const l1 = spot('L1');
    seed(store, l1);
    const list = new Page('list', store);
    list.open('delete', l1);
    const l1b = saveElsewhere(store, l1, 'L1b', 2);
    const said = list.render().said;
    assert.ok(said !== null && stillTrue(said, entries(store)));
    saveElsewhere(store, l1b, 'L1c', 3);
    assert.equal(stillTrue(said, entries(store)), false, '"shown as L1b" is no longer true');
  });

  it('a prompt that closed has no confirm left in it', () => {
    const store = new MemoryStore();
    const l1 = spot('L1');
    seed(store, l1);
    const list = new Page('list', store);
    list.open('delete', l1);
    const l1b = saveElsewhere(store, l1, 'L1b', 2);
    list.render();
    const heard = list.heard.length;
    const pressed = list.confirm();
    assert.equal(pressed.write, null);
    assert.equal(list.heard.length, heard, 'no refusal is invented for a prompt that is gone');
    assert.deepEqual(entries(store), [l1b]);
  });
});

describe('the caret lands on a control the page still draws (REGRESSION)', () => {
  it('deleting the last row sends it to the list heading, never to a line the next write unmounts', () => {
    const store = new MemoryStore();
    const only = spot('Only');
    seed(store, only);
    const list = new Page('list', store);
    list.open('delete', only);
    const done = list.confirm();
    assert.deepEqual(entries(store), []);
    assert.deepEqual(done.focus, { on: 'stable', onlyIfLost: false });
  });

  it('a press moves the caret, and a close nobody pressed moves it only off a control that vanished', () => {
    const store = new MemoryStore();
    const l1 = spot('L1');
    seed(store, l1);
    const list = new Page('list', store);
    assert.deepEqual(list.open('delete', l1).focus, { on: 'keep', onlyIfLost: false });
    assert.deepEqual(list.cancel().focus, { on: 'action', id: l1.id, onlyIfLost: false });
    list.open('delete', l1);
    saveElsewhere(store, l1, 'L1b', 2);
    assert.equal(list.render().focus?.onlyIfLost, true);
  });
});

describe('a confirm on an unchanged copy removes exactly that copy', () => {
  it('and leaves every other entry as it was, on every surface', () => {
    for (const [surface, write] of [
      ['editor', 'delete'],
      ['editor', 'reset'],
      ['list', 'delete'],
      ['list', 'reset'],
      ['scenario', 'reset'],
    ] as const) {
      const store = new MemoryStore();
      const own = spot('Own');
      const edit = spot('Edit', FROM);
      const other = spot('Other', 'fl-other');
      seed(store, own, edit, other);
      const target = write === 'delete' ? own : edit;
      const page = new Page(surface, store);
      page.open(write, target);
      const done = page.confirm();
      assert.deepEqual(done.removed?.copy, target, `${surface} ${write}`);
      assert.deepEqual(
        entries(store),
        [own, edit, other].filter((entry) => entry !== target),
      );
    }
  });

  it('a write the browser refuses says so, keeps the copy, and leaves the caret on its button', () => {
    const store = new MemoryStore();
    const own = spot('Own');
    seed(store, own);
    store.failing = true;
    const said: string[] = [];
    for (const surface of ['editor', 'list'] as const) {
      const page = new Page(surface, store);
      page.open('delete', own);
      const refused = page.confirm();
      assert.equal(refused.prompt.kind, 'closed');
      assert.deepEqual(refused.focus, { on: 'action', id: own.id, onlyIfLost: false });
      said.push(refused.said?.sentence ?? '');
    }
    const scenario = new Page('scenario', store);
    const edit = spot('Edit', FROM);
    store.failing = false;
    seed(store, own, edit);
    store.failing = true;
    scenario.open('reset', edit);
    said.push(scenario.confirm().said?.sentence ?? '');
    assert.deepEqual(said, [
      'Not deleted: this browser is not letting the page store anything.',
      'Not deleted: this browser is not letting the page store anything.',
      'Not reset: this browser is not letting the page store anything.',
    ]);
    store.failing = false;
    assert.deepEqual(entries(store), [own, edit]);
  });
});

/** An editor tab: what it holds and shows, on top of its prompt. */
interface EditorTab {
  readonly kind: 'editor';
  readonly page: Page;
  editing: { id: string | null; from: string | null };
  held: HeldCopy;
  draft: SpotDraft;
  saved: SpotDraft | null;
  status: { readonly text: string; readonly said: Said | null; readonly keep: boolean } | null;
}

interface ListTab {
  readonly kind: 'list';
  readonly page: Page;
}

interface ScenarioTab {
  readonly kind: 'scenario';
  readonly page: Page;
}

type Tab = (EditorTab | ListTab | ScenarioTab) & {
  /** Storage as this tab last read it, which is all it draws. */
  seen: readonly SavedSpot[];
  /** The copy the test itself saw the prompt open on, kept apart from the machine's own record. */
  openedOn: SavedSpot | null;
  /** The copy each sentence was about, keyed by the sentence's object. */
  readonly about: Map<Said, SavedSpot | null>;
};

const editedTab = (tab: EditorTab): boolean =>
  JSON.stringify(tab.saved ?? ORIGINAL) !== JSON.stringify(tab.draft);

function take(tab: EditorTab, saved: SavedSpot): void {
  tab.editing = { id: saved.id, from: saved.from };
  tab.held = { kind: 'copy', spot: saved };
  tab.draft = saved.draft;
  tab.saved = saved.draft;
}

function editorOn(store: MemoryStore, found: SavedSpot | undefined): Tab {
  const tab: Tab = {
    kind: 'editor',
    page: new Page('editor', store),
    editing: { id: null, from: FROM },
    held: { kind: 'none' },
    draft: ORIGINAL,
    saved: null,
    status: null,
    seen: entries(store),
    openedOn: null,
    about: new Map(),
  };
  if (found !== undefined) take(tab, found);
  return tab;
}

const yoursOf = (tab: Tab): boolean => tab.kind === 'editor' && editedTab(tab);

function note(tab: Tab, step: Step): void {
  if (step.said === null) return;
  tab.about.set(step.said, tab.openedOn);
  if (tab.kind === 'editor') tab.status = { text: step.said.sentence, said: step.said, keep: false };
}

/** The render after a `storage` event or a press: the prompt's check, then the editor's own adopt. */
function render(tab: Tab, store: MemoryStore): Step {
  tab.seen = entries(store);
  const checked = tab.page.render(yoursOf(tab));
  note(tab, checked);
  if (tab.kind !== 'editor') return checked;
  if (checked.shown !== null) take(tab, checked.shown);
  if (tab.page.prompt.kind === 'asking') return checked;
  const sync = syncWithStored(tab.held, storedCopy(tab.seen, tab.editing), editedTab(tab));
  if (sync.kind === 'adopt') {
    take(tab, sync.spot);
    tab.status = { text: 'Updated with the copy saved in another tab.', said: null, keep: false };
  }
  return checked;
}

type Target = 'keep' | 'stable' | `action:${string}` | 'action';

/** What each component draws for the caret to land on, read off its render rules. */
function renders(tab: Tab): ReadonlySet<Target> {
  const { prompt } = tab.page;
  const asking = prompt.kind === 'asking' ? prompt.asked.copy.id : null;
  const targets = new Set<Target>(['stable']);
  if (asking !== null) targets.add('keep');
  if (tab.kind === 'editor') {
    // SpotEditor: the bar is the prompt, or Save with Delete or Reset whenever the tab edits a stored id.
    if (asking !== null) return new Set(['keep']);
    if (tab.editing.id !== null) targets.add('action');
  } else if (tab.kind === 'list') {
    // SpotList: every row drawn has its removal button, except the row whose prompt is open.
    for (const row of tab.seen) if (row.id !== asking) targets.add(`action:${row.id}`);
  } else {
    // ScenarioSpotLinks: Reset sits beside the edit while no prompt is open.
    const edit = editOf(tab.seen, FROM);
    if (edit !== undefined && asking === null) targets.add(`action:${edit.id}`);
  }
  return targets;
}

function targetOf(tab: Tab, focus: Focus): Target {
  if (focus.on !== 'action') return focus.on;
  return tab.kind === 'editor' ? 'action' : `action:${focus.id}`;
}

const quoted = (sentence: string): string[] => [...sentence.matchAll(/"([^"]*)"/gu)].map((m) => m[1] ?? '');

/** Every sentence a tab shows is true of what that tab draws, checked from the test's own records. */
function assertTrue(tab: Tab, where: string): void {
  const said = tab.kind === 'editor' ? (tab.status?.said ?? null) : tab.page.said;
  if (tab.kind === 'editor' && tab.status !== null && /kept/iu.test(tab.status.text)) {
    assert.ok(tab.status.keep, `${where}: "${tab.status.text}" without Keep mine`);
  }
  if (said === null || !stillTrue(said, tab.seen)) return;
  const text = said.sentence;
  const asked = tab.about.get(said);
  assert.ok(asked !== undefined && asked !== null, `${where}: "${text}" about no prompt`);
  assert.doesNotMatch(text, /kept|keep yours|will not remove/iu, where);
  const now = storedCopy(tab.seen, asked);
  const fail = `${where}: "${text}" is not true of what the page draws`;
  if (/ changed in another tab, so nothing was (deleted|reset)\./u.test(text)) {
    assert.ok(now !== undefined && !sameCopy(now, asked), fail);
    if (tab.kind === 'editor') {
      if (/The new copy is shown\.$/u.test(text)) assert.deepEqual(tab.draft, said.stored?.draft, fail);
      else assert.ok(/Your changes are still here\.$/u.test(text) && editedTab(tab), fail);
    } else if (tab.kind === 'list') {
      const names = quoted(text);
      assert.equal(names[0], displayName(asked), fail);
      assert.equal(
        names[1] ?? displayName(asked),
        displayName(now),
        `${fail}: the row drawn has another name`,
      );
      assert.ok(tab.seen.some((row) => row.id === now.id));
    }
  } else if (
    / (deleted|removed) in another tab|^Deleted |[Bb]ack to the original|^Your edit is removed/u.test(text)
  ) {
    assert.equal(now, undefined, fail);
    if (tab.kind === 'list') assert.deepEqual(quoted(text), [displayName(asked)], fail);
  } else if (/^Not (deleted|reset): /u.test(text)) {
    assert.ok(now !== undefined && sameCopy(now, asked), fail);
  } else assert.fail(`${where}: a sentence the checks do not know: "${text}"`);
}

describe('every order of opens, confirms, cancels and other tabs writing (seeded)', () => {
  it('removes only the copy confirmed, says only what is true, and lands the caret on what is drawn', () => {
    let state = 20_261_125;
    const next = (n: number): number => {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
      return Math.floor((state / 2_147_483_648) * n);
    };
    const counts = {
      asked: { editor: 0, list: 0, scenario: 0 },
      removed: { editor: 0, list: 0, scenario: 0 },
      changed: { editor: 0, list: 0, scenario: 0 },
      gone: { editor: 0, list: 0, scenario: 0 },
      refused: 0,
      kept: 0,
      checked: 0,
    };
    for (let run = 0; run < 1000; run += 1) {
      const store = new MemoryStore();
      const own = spot('Own', null, 0);
      const edit = spot('Edit', FROM, 0);
      seed(store, own, edit);
      const tabs: Tab[] = [
        editorOn(store, edit),
        editorOn(store, own),
        {
          kind: 'list',
          page: new Page('list', store),
          seen: entries(store),
          openedOn: null,
          about: new Map(),
        },
        {
          kind: 'scenario',
          page: new Page('scenario', store),
          seen: entries(store),
          openedOn: null,
          about: new Map(),
        },
      ];
      for (let at = 1; at <= 24; at += 1) {
        const index = next(tabs.length);
        const tab = tabs[index] as Tab;
        const where = `run ${run} step ${at} tab ${index} (${tab.kind})`;
        const before = entries(store);
        const asking = tab.page.prompt.kind === 'asking';
        let focusMoved = null as { readonly focus: Focus; readonly rendered: boolean } | null;
        const roll = next(10);
        const record = (taken: Step, rendered = false): Step => {
          note(tab, taken);
          if (taken.focus !== null) focusMoved = { focus: taken.focus, rendered };
          if (taken.prompt.kind === 'closed' && taken.said !== null && taken.removed === null) {
            const kind = taken.said.stored === undefined ? 'gone' : 'changed';
            if (!/^Not /u.test(taken.said.sentence)) counts[kind][tab.page.surface] += 1;
          }
          return taken;
        };

        if (roll === 0) {
          // Another tab, not one of these: a save, a delete, or a reset and a new edit.
          const target = before[next(Math.max(before.length, 1))];
          const kind = next(3);
          if (target !== undefined && kind === 0) saveElsewhere(store, target, `X${run}.${at}`, at);
          else if (target !== undefined && kind === 1) deleteElsewhere(store, target);
          else {
            const edits = before.filter((entry) => entry.from === FROM);
            seed(store, ...before.filter((entry) => entry.from !== FROM));
            if (edits.length > 0) saveElsewhere(store, { ...edit, id: 'spot-gone' }, `R${run}.${at}`, at);
          }
          continue;
        }
        if (roll === 1 || roll === 2) {
          record(render(tab, store), true);
        } else if ((!asking || tab.kind === 'list') && roll <= 5) {
          let write: Removal = 'delete';
          let copy: SavedSpot | undefined;
          if (tab.kind === 'editor') {
            if (tab.editing.id === null || tab.held.kind !== 'copy') continue;
            write = tab.editing.from === FROM ? 'reset' : 'delete';
            copy = tab.held.spot;
          } else if (tab.kind === 'list') {
            copy = tab.seen[next(Math.max(tab.seen.length, 1))];
            if (copy === undefined) continue;
            write = copy.from === FROM ? 'reset' : 'delete';
          } else {
            copy = editOf(tab.seen, FROM);
            if (copy === undefined) continue;
            write = 'reset';
            tab.page.said = null;
          }
          if (tab.kind === 'list') tab.page.said = null;
          tab.openedOn = copy;
          const opened = record(tab.page.open(write, copy, yoursOf(tab)));
          if (tab.kind === 'editor' && opened.shown !== null) take(tab, opened.shown);
          if (opened.prompt.kind === 'asking') counts.asked[tab.page.surface] += 1;
          assert.deepEqual(entries(store), before, `${where}: opening wrote`);
          record(render(tab, store), true);
        } else if (asking && roll <= 7) {
          const failing = next(6) === 0;
          store.failing = failing;
          const done = record(tab.page.confirm(yoursOf(tab)));
          store.failing = false;
          if (tab.kind === 'editor' && done.shown !== null) take(tab, done.shown);
          const after = entries(store);
          if (done.removed === null) {
            assert.deepEqual(after, before, `${where}: a confirm that removed nothing wrote`);
            if (failing && done.said !== null && /^Not /u.test(done.said.sentence)) counts.refused += 1;
          } else {
            const opened = tab.openedOn;
            assert.ok(opened !== null);
            const left = before.filter((entry) => !after.some((kept) => sameCopy(kept, entry)));
            assert.equal(left.length, 1, `${where}: removed ${left.length} entries`);
            assert.ok(sameCopy(left[0] as SavedSpot, opened), `${where}: removed a copy it did not open on`);
            assert.equal(after.length, before.length - 1, `${where}: wrote more than the removal`);
            counts.removed[tab.page.surface] += 1;
            if (tab.kind === 'editor') {
              if (done.removed.write === 'reset') {
                Object.assign(tab, { editing: { id: null, from: FROM }, held: { kind: 'none' } });
                Object.assign(tab, { draft: ORIGINAL, saved: null });
              } else tabs[index] = editorOn(store, editOf(after, FROM));
            }
          }
          record(render(tabs[index] as Tab, store), true);
        } else if (asking && roll === 8) {
          record(tab.page.cancel());
          assert.deepEqual(entries(store), before, `${where}: cancelling wrote`);
          record(render(tab, store), true);
        } else if (tab.kind === 'editor' && !asking) {
          // The editor's own writes and choices, which other tabs see as another tab's.
          const sync = syncWithStored(tab.held, storedCopy(tab.seen, tab.editing), editedTab(tab));
          const choice = next(4);
          if (choice === 0) {
            tab.draft = { ...tab.draft, name: `B${run}.${at}` };
            tab.status = null;
          } else if (choice === 1 && sync.kind === 'changed') {
            const kept = keepMine(entries(store), tab.editing);
            tab.editing = kept.editing;
            tab.held = kept.held;
            tab.status = { text: kept.sentence, said: null, keep: true };
            counts.kept += 1;
          } else if (choice === 2 && sync.kind === 'changed') {
            take(tab, sync.spot);
            tab.status = { text: 'Loaded the copy saved in another tab.', said: null, keep: false };
          } else if (choice === 3) {
            const request = { ...tab.editing, held: tab.held, draft: tab.draft };
            const saved = saveSpot(entries(store), request, run * 100 + at, ids);
            if ('conflict' in saved) {
              const refused = saveRefusal(editedTab(tab));
              if (refused.show) take(tab, saved.conflict);
              tab.status = { text: refused.sentence, said: null, keep: false };
            } else {
              seed(store, ...saved.spots);
              take(tab, saved.saved);
              tab.status = { text: 'Saved in this browser.', said: null, keep: false };
            }
          }
          record(render(tab, store), true);
        } else if (tab.kind === 'editor' && asking && roll === 9) {
          // Fields stay editable under an open prompt, and typing clears the status.
          tab.draft = { ...tab.draft, name: `T${run}.${at}` };
          tab.status = null;
          record(render(tab, store), true);
        } else continue;

        const now = tabs[index] as Tab;
        if (focusMoved !== null) {
          const { focus: moved, rendered } = focusMoved;
          assert.equal(
            moved.onlyIfLost,
            rendered,
            `${where}: only a close nobody pressed waits for a lost caret`,
          );
          const target = targetOf(now, moved);
          assert.ok(renders(now).has(target), `${where}: the caret goes to ${target}, which is not drawn`);
        }
        for (const [n, each] of tabs.entries()) {
          if (each.kind === 'editor') {
            const holding = each.held.kind === 'copy';
            assert.equal(
              each.editing.id !== null,
              holding,
              `${where}: tab ${n} offers a removal of nothing held`,
            );
          }
          const prompt = each.page.prompt;
          if (prompt.kind === 'asking') {
            assert.ok(
              each.openedOn !== null && sameCopy(prompt.asked.copy, each.openedOn),
              `${where}: tab ${n}`,
            );
            const stored = storedCopy(each.seen, each.openedOn);
            assert.ok(
              stored !== undefined && sameCopy(stored, each.openedOn),
              `${where}: tab ${n} asks on a copy it no longer draws`,
            );
          }
          assertTrue(each, `${where}: tab ${n}`);
          counts.checked += 1;
        }
      }
    }
    // Seed 20261125 gives at least 120 removals and 319 closes on each surface, 215 refused writes, 33 keeps.
    const ran = JSON.stringify(counts);
    for (const surface of ['editor', 'list', 'scenario'] as const) {
      assert.ok(counts.asked[surface] > 400 && counts.removed[surface] > 80, `${surface}: ${ran}`);
      assert.ok(counts.changed[surface] > 200 && counts.gone[surface] > 200, `${surface}: ${ran}`);
    }
    assert.ok(counts.refused > 100 && counts.kept > 20 && counts.checked > 60_000, ran);
  });
});

/**
 * Each page runs its Delete or Reset prompt through `useSpotPrompt`, so the decisions driven for real in
 * `lab-spot-prompt-flow.test.ts` are the ones the pages make. Held over source text, because `apps/web`
 * tests run with no DOM (ADR 0008).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** Source with comments removed, so a sentence ABOUT a call cannot satisfy or trip a check. */
function code(file: string): string {
  return readFileSync(join(SRC, file), 'utf8')
    .replace(/\{\/\*[\s\S]*?\*\/\}/gu, '')
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/^\s*\/\/.*$/gmu, '');
}

const editor = code('components/SpotEditor.tsx');
const list = code('components/SpotList.tsx');
const scenario = code('components/ScenarioSpotLinks.tsx');
const hook = code('lib/use-spot-prompt.ts');
const PAGES = [
  ['SpotEditor', editor, 'editor'],
  ['SpotList', list, 'list'],
  ['ScenarioSpotLinks', scenario, 'scenario'],
] as const;

describe('every page asks the prompt machine, and writes only what it hands back (REGRESSION)', () => {
  it('opens a prompt on the copy the page drew, never on a fresh read of storage', () => {
    assert.match(editor, /if \(held\.kind === 'copy'\) ask\.open\(write, held\.spot\);/u);
    assert.match(list, /ask\.open\(own \? 'delete' : 'reset', spot\);/u);
    assert.match(scenario, /ask\.open\('reset', edit\);/u);
    for (const [name, source] of PAGES) {
      const opens = [...source.matchAll(/ask\.open\(([^;]*)\);/gu)].map((match) => match[1] ?? '');
      assert.ok(opens.length > 0, `${name} opens no prompt: a sweep of nothing`);
      for (const args of opens) {
        assert.doesNotMatch(args, /read\(|storedCopy\(|editOf\(|library\./u, `${name}: ask.open(${args})`);
      }
    }
  });

  for (const [name, source, surface] of PAGES) {
    it(`${name} confirms and cancels through the hook, and builds no removal of its own`, () => {
      assert.match(source, new RegExp(`useSpotPrompt\\(\\{\\s*surface: '${surface}',`, 'u'));
      assert.match(source, /ask\.cancel/u);
      assert.match(source, /(=\{ask\.confirm\}|= ask\.confirm\(\);)/u);
      assert.doesNotMatch(source, /removeSpot|\bstep\(|spot\.id !==/u, `${name} decides a removal itself`);
    });
  }

  it('the hook reads storage at every event and commits only the list a step returns', () => {
    for (const type of ['open', 'cancel', 'confirm']) {
      assert.match(
        hook,
        new RegExp(`step\\(prompt, \\{ type: '${type}',[^}]*spots: read\\(\\)\\.spots`, 'u'),
      );
    }
    for (const type of ['open', 'confirm']) {
      assert.match(hook, new RegExp(`step\\(prompt, \\{ type: '${type}',[^}]*\\byours\\b`, 'u'));
    }
    assert.match(editor, /useSpotPrompt\(\{[\s\S]*?\byours: edited\b[\s\S]*?\bshow: take\b/u);
    assert.match(hook, /step\(asked\.prompt, \{ type: 'written', result: commit\(asked\.write\) \}\)/u);
    assert.equal(hook.match(/commit\(/gu)?.length, 1, 'one write, and it is the step’s');
    // No dependency list: storage is read on every render, so the check runs after every render too.
    assert.match(
      hook,
      /useEffect\(\(\) => \{\s*if \(!library\.ready\) return;\s*const next = step\(prompt, \{ type: 'stored', spots: library\.spots, yours \}\);\s*if \(next\.prompt !== prompt\) apply\(next\);\s*\}\);/u,
    );
  });
});

describe("a closed prompt's caret is lost, not handed to the button drawn in its place (REGRESSION)", () => {
  // React kept "Keep it" and redrew it as Duplicate, so a background close moved the caret unseen.
  for (const [name, source] of [
    ['SpotEditor', editor],
    ['SpotList', list],
  ] as const) {
    it(`${name} keys its prompt row apart from the buttons that replace it`, () => {
      assert.match(source, /key="ask"/u);
      assert.match(source, /key="actions"/u);
    });
  }

  it('SpotEditor rescues a lost caret when another tab unmounts SyncNotice buttons or adopted fields', () => {
    assert.match(editor, /const rescue = useFocusRescue\(\);/u);
    assert.match(editor, /onBlurCapture=\{rescue\.onBlurCapture\}/u);
    assert.match(editor, /onFocusCapture=\{rescue\.onFocusCapture\}/u);
    assert.match(
      editor,
      /if \(library\.ready && held\.kind !== 'unread' && !leaving\) rescue\.rescue\(saveRef\.current\);/u,
    );
  });
});

describe('what the pages say is true when it is said (REGRESSION)', () => {
  it('SpotEditor clears held and keeps its live region mounted on delete so slow navigation never claims another tab deleted it', () => {
    assert.match(
      editor,
      /if \(done\.write === 'delete' \|\| back === undefined\) \{\s*setLeaving\(true\);\s*setHeld\(\{ kind: 'none' \}\);\s*setEditing\(\{ id: null, from: null \}\);\s*window\.location\.assign\('\/lab\/spots'\);\s*return;\s*\}/u,
    );
    assert.match(
      editor,
      /role="status" aria-live="polite">\s*\{saveStatus\}\s*<\/p>\s*\{leaving \? \(\s*<LeavingBody/u,
    );
  });
  for (const [name, source] of PAGES) {
    it(`${name} speaks a repeated sentence again`, () => {
      const sets = [...source.matchAll(/set(?:Save)?Status\(([^;]*)\);/gu)].map((match) => match[1] ?? '');
      assert.ok(sets.length > 0, `${name} sets no status: a sweep of nothing`);
      for (const value of sets) {
        assert.match(value, /^(''|\(current\) => repeated\(current, )/u, `${name}: set…Status(${value})`);
      }
    });

    it(`${name} shows a prompt's sentence only while storage still holds what it describes`, () => {
      assert.match(source, /stillTrue\(said, (library\.)?spots\)/u);
    });
  }

  it('"Keep mine" reads storage when it is pressed', () => {
    assert.match(editor, /const kept = keepMine\(read\(\)\.spots, editing\);/u);
    assert.doesNotMatch(editor, /onKeep\(sync\.spot\)/u);
  });

  it('the list formats a saved time through the guard that cannot throw', () => {
    assert.match(list, /const time = savedAt\(spot\.updatedAt\);/u);
    assert.doesNotMatch(list, /toISOString|\.format\(/u);
  });
});

/**
 * The editor, the list and the scenario page each remove a stored spot only through a prompt, and every
 * render reads storage again. Held over source text, because `apps/web` tests run with no DOM (ADR 0008);
 * the storage decisions they call are driven for real in `lab-spot-storage.test.ts`.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const COMPONENTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components');

/** Source with comments removed, so a sentence ABOUT a call cannot satisfy or trip a check. */
function code(file: string): string {
  return readFileSync(join(COMPONENTS, file), 'utf8')
    .replace(/\{\/\*[\s\S]*?\*\/\}/gu, '')
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/^\s*\/\/.*$/gmu, '');
}

const editor = code('SpotEditor.tsx');
const list = code('SpotList.tsx');
const scenario = code('ScenarioSpotLinks.tsx');
const ALL = [
  ['SpotEditor', editor],
  ['SpotList', list],
  ['ScenarioSpotLinks', scenario],
] as const;

describe('a prompt confirms the copy it was opened on (REGRESSION)', () => {
  it('captures the request in the press that opens the prompt, from what that render drew', () => {
    assert.match(
      editor,
      /const ask = \(write: Removal\): void => setConfirming\(\{ write, asked: \{ \.\.\.editing, held \} \}\);/u,
    );
    assert.match(
      list,
      /onAsk=\{\(\) =>\s*setAsked\(\{\s*request: \{ id: spot\.id, from: spot\.from, held: \{ kind: 'copy', spot \} \},/u,
    );
    assert.match(scenario, /onClick=\{\(\) => setAsked\(edit\)\}/u);
  });

  for (const [name, source] of ALL) {
    it(`${name} never builds the request when the confirm is pressed`, () => {
      const calls = [...source.matchAll(/removeSpot\(([\s\S]*?)\);/gu)].map((match) => match[1] ?? '');
      assert.ok(calls.length > 0, `${name} calls removeSpot nowhere: a sweep of nothing`);
      for (const args of calls) {
        assert.doesNotMatch(args, /\{/u, `${name}: removeSpot(${args}) builds its request from this render`);
      }
    });

    it(`${name} says on the prompt that the copy behind it changed`, () => {
      assert.match(source, /askedCopy\(library\.spots, /u);
      assert.match(source, /className="prl-note prl-spot-prompt__changed"/u);
      assert.match(
        source,
        /repeated\(current, (changedLine|line)\)/u,
        `${name} does not announce the change`,
      );
    });
  }
});

describe('the caret lands on a named control after a press removes the one it was on (REGRESSION)', () => {
  it('the editor returns to Delete or Reset after a refusal or Keep it, and to Save after Reset or Keep mine', () => {
    assert.match(editor, /if \(write !== 'save'\) setFocusTo\(\{ on: 'removal' \}\);/u);
    assert.match(editor, /setConfirming\(null\);\s*setFocusTo\(\{ on: 'removal' \}\);/u);
    assert.match(
      editor,
      /setActive\(nextOpenSlot\(allSlots\(back\.draft\), null\)\);\s*setFocusTo\(\{ on: 'save' \}\);/u,
    );
    assert.equal(editor.match(/setFocusTo\(\{ on: confirming === null \? 'save' : 'keep' \}\)/gu)?.length, 2);
    assert.match(editor, /<Button ref=\{refs\.removal\} onClick=\{\(\) => onAsk\('reset'\)\}>/u);
    assert.match(editor, /<Button ref=\{refs\.removal\} onClick=\{\(\) => onAsk\('delete'\)\}>/u);
  });

  it('the list goes to the refused row by where it is drawn, not to a node React happened to keep', () => {
    assert.match(
      list,
      /setFocusTo\(\{ row: before\.findIndex\(\(spot\) => spot\.id === conflict\.id\), part: 'removal' \}\);/u,
    );
    assert.match(list, /setFocusTo\(\{ row: Math\.max\(row, 0\), part: 'title' \}\);/u);
    assert.match(
      list,
      /<p ref=\{emptyRef\} tabIndex=\{-1\}>/u,
      'the last row deleted leaves the empty-list sentence',
    );
  });

  it('the scenario page goes to Reset after a refusal and to Edit a copy after a reset', () => {
    assert.match(scenario, /say\(conflictSentence\('reset', 'open'\)\);\s*setFocusTo\(\{ on: 'reset' \}\);/u);
    assert.match(scenario, /setFocusTo\(\{ on: result\.ok \? 'edit' : 'reset' \}\);/u);
    assert.match(scenario, /href=\{href\} ref=\{editRef\}/u);
  });
});

describe('what the pages say is true when it is said (REGRESSION)', () => {
  for (const [name, source] of ALL) {
    it(`${name} speaks a repeated sentence again`, () => {
      const sets = [...source.matchAll(/set(?:Save)?Status\(([^;]*)\);/gu)].map((match) => match[1] ?? '');
      assert.ok(sets.length > 0, `${name} sets no status: a sweep of nothing`);
      for (const value of sets) {
        assert.match(value, /^(''|\(current\) => repeated\(current, )/u, `${name}: set…Status(${value})`);
      }
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

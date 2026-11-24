/**
 * `/record` numbers the panels that are actually on the page. A signed-out render used to label its
 * only panel 02. The pages import CSS and a client component, so this holds the source to the
 * numbers rather than rendering them.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const RECORD = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'app', 'record');

const read = (name: string): string => {
  const text = readFileSync(join(RECORD, name), 'utf8');
  assert.ok(text.length > 0, `${name} was empty`);
  return text;
};

/** `showsCovered ? whenShown : whenAbsent`, the two numbers a panel is given. */
function branches(source: string, name: string): readonly [number, number] {
  const match = new RegExp(String.raw`const ${name} = showsCovered \? (\d+) : (\d+);`, 'u').exec(source);
  assert.ok(match !== null, `${name} is not numbered from whether the counts panel is shown`);
  return [Number(match[1]), Number(match[2])];
}

describe('record panels are numbered from what is shown', () => {
  const page = read('page.tsx');
  const deletion = read('DeleteAccount.tsx');

  it('reads a number for every panel the page can show (REGRESSION)', () => {
    assert.match(page, /const showsCovered = record\.state === 'ready';/u);
    const reset = branches(page, 'resetIndex');
    const account = branches(page, 'deletionIndex');
    assert.ok(reset.every((index) => index > 0) && account.every((index) => index > 0));

    const coveredTag = /<Panel\b[^>]*title="What you have covered"[^>]*>/u.exec(page);
    assert.ok(coveredTag !== null, 'the counts panel is gone');
    const covered = Number(/index=\{(\d+)\}/u.exec(coveredTag[0])?.[1]);
    assert.ok(covered > 0, 'the counts panel has no numeric index');

    const gate = page.indexOf('{showsCovered ? (');
    const titleAt = page.indexOf('title="What you have covered"');
    const gateClose = page.indexOf(') : null}', titleAt);
    const resetAt = page.indexOf('<ResetPanel index={resetIndex} />');
    assert.ok(gate >= 0 && gate < titleAt && gateClose > titleAt && gateClose < resetAt);

    // The deletion panel hides itself when there is no account, except the receipt, which has to stay.
    assert.match(deletion, /if \(!deletable && deletion\.state !== 'done'\) return null;/u);
    assert.match(page, /<AccountDeletion\b[^>]*index=\{deletionIndex\}/u);
    assert.match(deletion, /<Panel\b[^>]*index=\{index\}/u);
    assert.doesNotMatch(page, /index=\{[23]\}/u);
    assert.doesNotMatch(deletion, /index=\{[23]\}/u);

    // Signed out with no receipt, signed out after deletion, unavailable, and a full record.
    const cases = [
      { name: 'signed out', covered: false, deletionShown: false },
      { name: 'signed out, receipt kept', covered: false, deletionShown: true },
      { name: 'unavailable', covered: false, deletionShown: true },
      { name: 'ready', covered: true, deletionShown: true },
    ] as const;
    assert.equal(cases.length, 4, 'a state was dropped, so a skip could pass');

    for (const item of cases) {
      const shown = [
        ...(item.covered ? [covered] : []),
        item.covered ? reset[0] : reset[1],
        ...(item.deletionShown ? [item.covered ? account[0] : account[1]] : []),
      ];
      assert.ok(shown.length > 0, `${item.name} shows no panel`);
      assert.deepEqual(
        shown,
        shown.map((_, index) => index + 1),
        `${item.name} numbers ${shown.join(', ')}`,
      );
    }
  });
});

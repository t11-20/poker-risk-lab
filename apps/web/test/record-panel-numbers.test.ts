/**
 * `/record` numbers the panels that are actually on the page. A signed-out render used to label
 * its reset panel 02. The numbers come from one function, so a state cannot leave a gap.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { type RecordViewState, recordPanelNumbers } from '../src/lib/record-panels.ts';

const page = readFileSync(new URL('../src/app/record/page.tsx', import.meta.url), 'utf8');

const STATES = ['signedOut', 'unavailable', 'ready'] as const satisfies readonly RecordViewState[];

describe('record panels are numbered from what is shown', () => {
  it('numbers every rendered panel from 1 with no gap', () => {
    assert.equal(STATES.length, 3, 'a state was dropped, so a skip could pass');
    const expected = {
      signedOut: { covered: null, reset: 1, deletion: 2 },
      unavailable: { covered: null, reset: 1, deletion: 2 },
      ready: { covered: 1, reset: 2, deletion: 3 },
    } as const satisfies Record<RecordViewState, ReturnType<typeof recordPanelNumbers>>;
    for (const state of STATES) {
      const numbers = recordPanelNumbers(state);
      assert.deepEqual(numbers, expected[state], state);
      const shown =
        numbers.covered === null
          ? [numbers.reset, numbers.deletion]
          : [numbers.covered, numbers.reset, numbers.deletion];
      assert.ok(shown.length > 0, `${state} shows no panel`);
      assert.deepEqual(
        shown,
        shown.map((_, index) => index + 1),
        `${state} numbers ${shown.join(', ')}`,
      );
    }
  });

  it('the page asks that function for the numbers', () => {
    assert.ok(page.length > 0, 'page.tsx was empty');
    assert.match(page, /recordPanelNumbers\(record\.state\)/u);
  });
});

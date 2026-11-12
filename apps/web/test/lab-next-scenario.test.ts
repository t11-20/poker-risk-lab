/**
 * "Next scenario" must point somewhere for every scenario but the last.
 *
 * ## The failure this is written against
 *
 * `nextHrefAfter` on the scenario page looked the current id up in `LAB_SCENARIO_SUMMARIES`, the
 * bundled fixture's six scenarios, whose ids (`flop-flush-draw-price`, …) are not ids the API
 * serves. So for every one of the thirty-six real scenarios the lookup missed, the function returned
 * null, and the "Next scenario" button never rendered — measured on the running app at commit
 * 308fadf: zero `Next scenario` links after committing on `fl-small-straight-beats-trips`, at 360
 * and at 1440.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { content } from '@prl/content';
import { nextScenarioHref } from '../src/lib/lab-next.ts';

const BUNDLED = content().scenarios.map((scenario) => scenario.id);

describe('the next scenario', () => {
  it('reads a non-empty bundle', () => {
    assert.ok(BUNDLED.length >= 30, `only ${BUNDLED.length} id(s); a sweep of nothing is not a pass`);
  });

  it('exists for every bundled scenario but the last when the live list is unavailable (REGRESSION)', () => {
    const missing: string[] = [];
    BUNDLED.forEach((id, at) => {
      const expected = at + 1 < BUNDLED.length ? `/lab/${BUNDLED[at + 1]}` : null;
      const actual = nextScenarioHref(id, null);
      if (actual !== expected) missing.push(`${id}: expected ${expected}, got ${actual}`);
    });
    assert.deepEqual(missing, [], missing.join('\n'));
  });

  it('follows the live list, in the order the Lab index shows it', () => {
    const live = [{ id: 'c' }, { id: 'a' }, { id: 'b' }];
    assert.equal(nextScenarioHref('c', live), '/lab/a');
    assert.equal(nextScenarioHref('a', live), '/lab/b');
    assert.equal(nextScenarioHref('b', live), null, 'the last one has no next');
  });

  it('offers nothing rather than a guess for an id the list does not carry, or an empty list', () => {
    assert.equal(nextScenarioHref('not-a-scenario', [{ id: 'a' }, { id: 'b' }]), null);
    assert.equal(nextScenarioHref('a', []), null);
  });

  it('escapes the id into the path', () => {
    assert.equal(nextScenarioHref('a', [{ id: 'a' }, { id: 'b c' }]), '/lab/b%20c');
  });
});

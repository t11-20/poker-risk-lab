/**
 * Tests for the React key helper.
 *
 * Small, but worth testing: the whole point of `withKeys` is that duplicate values still
 * get distinct keys and that the same input always produces the same keys. Both of those
 * are silent when broken — React does not warn about a *stable-looking* wrong key, it just
 * reuses the wrong DOM node — so the guarantees are pinned here rather than trusted.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { withKeys } from '../src/keys.ts';

describe('withKeys', () => {
  it('pairs each item with its value untouched', () => {
    const keyed = withKeys(['alpha', 'beta'], 'note');
    assert.deepEqual(
      keyed.map((entry) => entry.value),
      ['alpha', 'beta'],
    );
  });

  it('derives keys from content, not position', () => {
    const keyed = withKeys(['alpha', 'beta'], 'note');
    assert.equal(keyed[0]?.key, 'note:alpha#0');
    assert.equal(keyed[1]?.key, 'note:beta#0');
  });

  it('keeps duplicates distinct', () => {
    const keyed = withKeys(['same', 'same', 'same'], 'note');
    assert.deepEqual(
      keyed.map((entry) => entry.key),
      ['note:same#0', 'note:same#1', 'note:same#2'],
    );
  });

  it('produces unique keys for every input it is given', () => {
    const inputs: readonly (readonly unknown[])[] = [
      [],
      ['one'],
      ['a', 'a', 'b', 'a'],
      [0, 0, 1, 51],
      ['', '', 'x'],
      [1, '1', 1],
    ];
    for (const input of inputs) {
      const keys = withKeys(input, 'p').map((entry) => entry.key);
      assert.equal(new Set(keys).size, keys.length, `duplicate key for ${JSON.stringify(input)}`);
    }
  });

  it('namespaces by prefix, so two lists in one component cannot collide', () => {
    const left = withKeys(['x'], 'clean');
    const right = withKeys(['x'], 'dirty');
    assert.notEqual(left[0]?.key, right[0]?.key);
  });

  it('is stable: the same array yields the same keys every time', () => {
    const input = ['a', 'b', 'a'];
    assert.deepEqual(
      withKeys(input, 'p').map((entry) => entry.key),
      withKeys(input, 'p').map((entry) => entry.key),
    );
  });

  it('returns an empty array for empty input', () => {
    assert.deepEqual(withKeys([], 'p'), []);
  });

  it('handles numbers, which is what card rows pass', () => {
    const keyed = withKeys([42, 22, 42], 'card');
    assert.deepEqual(
      keyed.map((entry) => entry.key),
      ['card:42#0', 'card:22#0', 'card:42#1'],
    );
  });
});

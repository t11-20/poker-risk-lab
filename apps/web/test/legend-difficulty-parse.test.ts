/**
 * Two readings of one query value. The Legends pages fall back to `educational`, so a hand-edited URL
 * still renders; `/play` takes only an exact difficulty, because anything else must deal the bot table.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LegendDifficulty } from '@prl/contracts';
import { DIFFICULTIES, knownDifficulty, parseDifficulty } from '../src/lib/legend-links.ts';

const UNKNOWN: readonly (string | undefined)[] = [
  undefined,
  '',
  ' ',
  'novice',
  'Educational',
  'REALISTIC',
  'Expert',
  ' expert',
  'expert ',
  'expert,realistic',
];

/** The rows `/play` is held to. */
const MATCH_ROWS: readonly (readonly [string | undefined, LegendDifficulty | null])[] = [
  ...DIFFICULTIES.map((difficulty) => [difficulty, difficulty] as const),
  ...UNKNOWN.map((value) => [value, null] as const),
];

describe('a difficulty read from the URL', () => {
  it('names the three the contract defines', () => {
    assert.deepEqual([...DIFFICULTIES].sort(), ['educational', 'expert', 'realistic']);
  });

  it('parseDifficulty keeps each known value and falls back to educational for anything else', () => {
    for (const difficulty of DIFFICULTIES) {
      assert.equal(parseDifficulty(difficulty), difficulty);
      assert.equal(parseDifficulty([difficulty, 'novice']), difficulty, 'the first of a repeated key');
    }
    for (const value of UNKNOWN) assert.equal(parseDifficulty(value), 'educational', String(value));
    assert.equal(parseDifficulty([]), 'educational');
    assert.equal(parseDifficulty(['novice', 'expert']), 'educational', 'only the first value is read');
  });

  it('knownDifficulty keeps each known value and answers null for anything else', () => {
    for (const [value, want] of MATCH_ROWS) assert.equal(knownDifficulty(value), want, String(value));
  });
});

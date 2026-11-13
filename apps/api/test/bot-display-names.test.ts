// Two bots of one profile at one table get distinct names. The narration names a seat by name alone.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { botDisplayName, botDisplayNames, LEGACY_PROFILE_IDS } from '../src/rooms/bots.ts';

const MAX_BOT_NAME = 24;

/** Matches `BOT_TABLE` in apps/web/src/lib/table-rooms.ts. */
const BOT_TABLE_PROFILES = [
  'tight-aggressive',
  'tight-aggressive',
  'calling-station',
  'loose-aggressive',
  'nit',
].map((legacy) => LEGACY_PROFILE_IDS[legacy] ?? legacy);

describe('bot display names', () => {
  it('gives every seat at the bot table a different name', () => {
    const names = botDisplayNames(BOT_TABLE_PROFILES);
    assert.equal(names.length, 5);
    assert.equal(new Set(names).size, names.length, `duplicate plates: ${names.join(', ')}`);
    assert.deepEqual(names.slice(0, 2), ['Patient Technician 1', 'Patient Technician 2']);
  });

  it('leaves a profile that sits once exactly as it was', () => {
    const names = botDisplayNames(BOT_TABLE_PROFILES);
    assert.deepEqual(names.slice(2), BOT_TABLE_PROFILES.slice(2).map(botDisplayName));
  });

  it('keeps the number inside the length rule when the name is long', () => {
    const id = 'reading-pressure-specialist';
    const names = botDisplayNames([id, id]);
    for (const name of names)
      assert.ok(name.length <= MAX_BOT_NAME, `"${name}" is ${String(name.length)} long`);
    assert.deepEqual(names, ['Reading Pressure 1', 'Reading Pressure 2']);
  });
});

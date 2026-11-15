// Two bots of one profile at one table get distinct names. The narration names a seat by name alone.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PATTERNS } from '@prl/contracts';
import { PROFILES } from '@prl/poker-ai';
import { botDisplayName, botDisplayNames, LEGACY_PROFILE_IDS, planLegendSeats } from '../src/rooms/bots.ts';

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

describe('legend seat names', () => {
  it('names the seat from the archetype, not the profile id', () => {
    assert.equal(
      planLegendSeats(['vocal-aggressor'], 'archetype', 6)[0]?.displayName,
      'High-Variance Aggressor',
    );
  });

  it('fits every profile, seated once or twice, into the display-name rule in its own words', () => {
    assert.ok(PROFILES.length > 0, 'there are profiles to check');
    for (const { naming } of PROFILES) {
      const words = naming.archetypeName.split(' ');
      for (const { displayName } of planLegendSeats([naming.id, naming.id], 'archetype', 6)) {
        assert.match(displayName, new RegExp(PATTERNS.DISPLAY_NAME, 'u'), `${naming.id}: "${displayName}"`);
        for (const word of displayName.replace(/ \d$/u, '').split(' ')) {
          assert.ok(words.includes(word), `${naming.id}: "${word}" is not in "${naming.archetypeName}"`);
        }
      }
    }
  });
});

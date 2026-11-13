/**
 * A legend match names the style the reader chose, at the setting they chose, and has a way back.
 * The page once showed a placeholder heading and the six-handed table's lede, never named the
 * archetype, and left no link back to `/legends` after "Stand up".
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { LegendDifficultyDto } from '@prl/contracts';
import { legendMatchCopy } from '../src/lib/legend-match-copy.ts';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (...parts: readonly string[]): string => readFileSync(join(SRC, ...parts), 'utf8');

const EXPERT: LegendDifficultyDto = {
  id: 'expert',
  label: 'Expert',
  description: 'The style is fully expressed.',
  coachAvailable: false,
};

describe('legendMatchCopy', () => {
  const copy = legendMatchCopy({
    profileId: 'vocal-aggressor',
    archetypeName: 'High-Variance Tournament Aggressor',
    difficulty: 'expert',
    setting: EXPERT,
  });

  it('names the archetype the reader picked and the setting', () => {
    assert.equal(copy.heading, 'Heads-up against High-Variance Tournament Aggressor');
    assert.match(copy.eyebrow, /Expert setting/u);
    assert.match(copy.lede, /Expert setting/u);
  });

  it('describes a heads-up match, not the six-handed table', () => {
    for (const text of [copy.heading, copy.lede]) assert.doesNotMatch(text, /five bots|six-handed/iu);
    assert.match(copy.lede, /one modelled style/u);
  });

  it('says what the seat plate is, so a reader is not left thinking they got another opponent', () => {
    assert.match(copy.lede, /vocal-aggressor/u);
    assert.match(copy.lede, /same style/u);
  });

  it('states the coach rule of the setting', () => {
    assert.match(copy.lede, /held back until the hand is over/u);
    const educational = legendMatchCopy({
      profileId: 'calling-station',
      archetypeName: 'Passive Calling Station',
      difficulty: 'educational',
      setting: { ...EXPERT, id: 'educational', label: 'Educational', coachAvailable: true },
    });
    assert.match(educational.lede, /Coach stays beside the table/u);
  });

  it('always carries the framing, and falls back to a generic heading for an unknown id', () => {
    assert.match(copy.framing, /not a real person/u);
    const unknown = legendMatchCopy({
      profileId: 'nope',
      archetypeName: null,
      difficulty: 'realistic',
      setting: null,
    });
    assert.equal(unknown.heading, 'Heads-up against a modelled style');
    assert.match(unknown.eyebrow, /Realistic setting/u);
    assert.match(unknown.framing, /not a real person/u);
  });
});

describe('the play page and the table use it', () => {
  it('the play page no longer ships the placeholder heading, and names only the archetype', () => {
    const page = read('app', 'play', 'page.tsx');
    assert.doesNotMatch(page, /Heads-up against this style/u);
    assert.match(page, /legendMatchCopy\(/u);
    assert.match(page, /disclosure\.archetypeName/u);
    // The attributed name must travel with its disclaimers, and a page heading is where they drop.
    assert.doesNotMatch(page, /disclosure\.displayName/u);
  });

  it('after standing up in a legend match the table offers a way back to /legends', () => {
    const table = read('app', 'play', 'LiveTable.tsx');
    assert.match(
      table,
      /\{isLive && !seated && inLegendMatch \? \(\s*<Link[^>]*href=\{LEGENDS_PATH\}>\s*Choose another opponent/u,
    );
    assert.match(table, /inLegendMatch=\{legendMatch !== undefined\}/u);
  });

  it('the Legends hand review links back to the profile the server named', () => {
    const page = read('app', 'legends', 'hand-review', 'page.tsx');
    assert.match(page, /profileHref\(result\.comparison\.profileId\)/u);
  });
});

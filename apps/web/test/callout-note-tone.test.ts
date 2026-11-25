/**
 * Receipts, statuses, measured results and pointers are notes. Two callouts stay insights: each one
 * says what a comparison is telling the reader, which is the teaching point the marker names.
 * The tone is read off the opening tag, so a moved title has to stay on that line.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const read = (...parts: readonly string[]): string => {
  const text = readFileSync(join(REPO, ...parts), 'utf8');
  assert.ok(text.length > 0, `${parts.join('/')} was empty`);
  return text;
};

/** The opening tag. Tone and title share a line in every callout this guards. */
function calloutLine(source: string, title: string): string {
  const line = source.split('\n').find((row) => row.includes('tone=') && row.includes(title));
  assert.ok(line !== undefined, `no callout opening contains ${title}`);
  return line;
}

const MOVED = [
  {
    file: ['apps', 'web', 'src', 'app', 'record', 'DeleteAccount.tsx'],
    title: 'Your account has been deleted',
    notes: 1,
  },
  {
    file: ['apps', 'web', 'src', 'components', 'TableStage.tsx'],
    title: 'How the hand ended',
    notes: 1,
  },
  {
    file: ['apps', 'web', 'src', 'components', 'QuizRunner.tsx'],
    title: 'This one is not marked',
    notes: 1,
  },
  {
    file: ['apps', 'web', 'src', 'components', 'CommitmentVerifier.tsx'],
    title: 'proved against the published root',
    notes: 2,
  },
  {
    file: ['apps', 'web', 'src', 'components', 'CommitmentVerifier.tsx'],
    title: 'Nothing became public in this hand, so there is nothing to prove',
    notes: 2,
  },
  {
    file: ['apps', 'web', 'src', 'components', 'Onboarding.tsx'],
    title: 'Suggested first lesson',
    notes: 1,
  },
  {
    file: ['apps', 'web', 'src', 'components', 'ScenarioStage.tsx'],
    title: 'This is a comparison, not a mark',
    notes: 1,
  },
] as const;

const STAY = [
  {
    file: ['apps', 'web', 'src', 'app', 'legends', 'compare', 'page.tsx'],
    title: 'What the disagreement is telling you',
  },
  {
    file: ['apps', 'web', 'src', 'components', 'PostHandComparison.tsx'],
    title: 'The result and the reasoning point in opposite directions',
  },
] as const;

describe('callouts that are not insights use the note tone', () => {
  it('reads every moved callout and both insights that stay (REGRESSION)', () => {
    assert.equal(MOVED.length, 7, 'a candidate dropped out of the list, so this can pass over one');
    assert.equal(STAY.length, 2, 'an insight dropped out of the list, so this can pass over one');
    const seen = new Set<string>();
    for (const item of MOVED) {
      const source = read(...item.file);
      seen.add(item.file.join('/'));
      const line = calloutLine(source, item.title);
      assert.match(line, /tone="note"/u, `${item.title} is not a note`);
      assert.doesNotMatch(line, /tone="insight"/u, `${item.title} still says insight`);
      assert.equal(
        [...source.matchAll(/tone="note"/gu)].length,
        item.notes,
        `${item.file.join('/')} note count`,
      );
      assert.equal(
        [...source.matchAll(/tone="insight"/gu)].length,
        0,
        `${item.file.join('/')} still has an insight`,
      );
    }
    assert.equal(seen.size, 6, 'the moved callouts are not in six files');
    for (const item of STAY) {
      const source = read(...item.file);
      const line = calloutLine(source, item.title);
      assert.match(line, /tone="insight"/u, `${item.title} lost its insight`);
      assert.doesNotMatch(line, /tone="note"/u);
      assert.equal([...source.matchAll(/tone="note"/gu)].length, 0, `${item.title} became a note`);
    }
  });
});

describe('a measured result on a Legends profile is a note, and a mismatch still warns', () => {
  it('"The card and the play agree" uses the note tone', () => {
    const page = read('apps', 'web', 'src', 'app', 'legends', '[profileId]', 'page.tsx');
    assert.match(page, /tone=\{stats\.stats\.divergences\.length === 0 \? 'note' : 'warning'\}/u);
  });
});

describe('status receipts on the table are notes; a table that cannot be reached warns', () => {
  it('a quiet close and a sent or applied decision use the note tone', () => {
    const live = read('apps', 'web', 'src', 'app', 'play', 'LiveTable.tsx');
    assert.match(
      live,
      /tone=\{closeIsQuiet\(closed\) \? 'note' : 'warning'\}/u,
      'a dropped or refused table is not a warning',
    );
    const stage = read('apps', 'web', 'src', 'components', 'TableStage.tsx');
    assert.match(
      stage,
      /tone=\{isLive && submission\.status !== 'held' \? 'note' : 'warning'\}/u,
      'a sent or applied decision is not a note',
    );
  });
});

/**
 * A hand replay's title says what the page found, including "not found", from the same load the page
 * renders. The page imports CSS and cannot load here, so the mapping lives in `lib/review-titles.ts`.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { HAND_NOT_FOUND_TITLE, reviewPageMetadata } from '../src/lib/review-titles.ts';

const PAGE = readFileSync(new URL('../src/app/review/[handId]/page.tsx', import.meta.url), 'utf8');

describe('the hand replay title', () => {
  it('says "not found" when the API said there is no such hand (REGRESSION)', () => {
    assert.deepEqual(reviewPageMetadata({ state: 'missing' }), { title: 'Hand not found' });
    assert.equal(HAND_NOT_FOUND_TITLE, 'Hand not found');
  });

  it('names the hand when there is one, live or sampled', () => {
    for (const state of ['live', 'sampled'] as const) {
      const metadata = reviewPageMetadata({ state, handNumber: 12 });
      assert.equal(metadata.title, 'Hand 12');
      assert.match(metadata.description ?? '', /^Replay of hand 12,/u);
    }
  });

  it('repeats the unavailable screen’s own headline, and never claims the hand is missing', () => {
    const signedOut = reviewPageMetadata({ state: 'unavailable', cause: 'signedOut' }).title;
    const unreachable = reviewPageMetadata({ state: 'unavailable', cause: 'unreachable' }).title;
    assert.equal(signedOut, 'This replay needs a session');
    assert.equal(unreachable, 'This hand could not be loaded');
    for (const title of [signedOut, unreachable]) {
      assert.ok(PAGE.includes(`'${title}'`), `the page's headline no longer reads "${title}"`);
      assert.doesNotMatch(title, /not found/iu, 'nothing established that this hand does not exist');
    }
  });

  it('is what the page uses, from the same load the page renders (REGRESSION)', () => {
    assert.match(PAGE, /const loadReviewOnce = cache\(loadReview\);/u);
    const metadata = /export async function generateMetadata[\s\S]*?\n\}\n/u.exec(PAGE)?.[0] ?? '';
    assert.ok(metadata.length > 0, 'generateMetadata has moved; this assertion needs updating');
    assert.match(metadata, /await loadReviewOnce\(handId\)/u);
    assert.match(metadata, /reviewPageMetadata\(/u);
    assert.doesNotMatch(metadata, /handReviewFixture\(/u, 'the title is being read off the fixtures again');
    assert.match(PAGE, /const data = await loadReviewOnce\(handId\);/u, 'the page loads it a second time');
  });
});

// The hand list arrives a page at a time with no total, so the caption counts a page as a page.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { historyCaption } from '../src/lib/hand-history-caption.ts';

const order = 'most recent first';

describe('the hand history caption', () => {
  it('calls a first page with more behind it the first of them', () => {
    assert.equal(
      historyCaption({ count: 6, firstPage: true, more: true, order }),
      'The first 6 hands, ordered by most recent first, with more on the next page.',
    );
  });

  it('counts a whole history as the whole history', () => {
    assert.equal(
      historyCaption({ count: 1, firstPage: true, more: false, order }),
      '1 hand, ordered by most recent first.',
    );
    assert.equal(
      historyCaption({ count: 5, firstPage: true, more: false, order }),
      '5 hands, ordered by most recent first.',
    );
  });

  it('calls a later page more hands', () => {
    assert.equal(
      historyCaption({ count: 1, firstPage: false, more: false, order }),
      '1 more hand, ordered by most recent first.',
    );
    assert.match(
      historyCaption({ count: 6, firstPage: false, more: true, order }),
      /^6 more hands, .*next page\.$/u,
    );
  });

  it('is what the page shows, and the next page is not called older under every ordering', () => {
    const page = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'app', 'review', 'page.tsx'),
      'utf8',
    );
    assert.match(page, /historyCaption\(\{/u);
    assert.doesNotMatch(page, /Older hands/u);
  });
});

/**
 * Two empty states used to wear the Insight marker. An empty state is `prl-empty`: a box and a
 * sentence, with the title kept as an h2 so the page still has one h1 and its sections stay at h2.
 * Held to source, and the sentences are pinned because the record copy is owner-held.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(WEB, '..', '..');

const read = (...parts: readonly string[]): string => {
  const text = readFileSync(join(...parts), 'utf8');
  assert.ok(text.length > 0, `${parts.join('/')} was empty`);
  return text;
};

/** What a reader sees: JSX space expressions dropped, tags stripped, whitespace collapsed. */
function readerProse(source: string): string {
  return source
    .replace(/\{\/\*[\s\S]*?\*\/\}/gu, '')
    .replace(/\{' '\}/gu, ' ')
    .replace(/<[^>]*>/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

const CASES = [
  {
    file: ['apps', 'web', 'src', 'app', 'record', 'page.tsx'],
    title: 'This browser has no record yet',
    links: ['href="/play"', 'href={LEARN_PATH}'],
    sentences: [
      'A record belongs to one learner, and this browser has not started one — so there is nothing to show ' +
        'you here, and an empty page would look like a record of having done nothing, which is a different ' +
        'claim. Opening a table starts a guest session straight away, with no email and no password, and ' +
        'everything you do from then on is counted here. Open a table, or start reading.',
    ],
  },
  {
    file: ['apps', 'web', 'src', 'app', 'legends', 'hand-review', 'page.tsx'],
    title: 'Choose a hand to review',
    links: ['href={REVIEW_PATH}', 'href={HAND_REVIEW_DEMO_PATH}'],
    sentences: [
      'This page reviews one of your own finished hands, so it needs to know which. Open a hand from your ' +
        'hand history and it will arrive here with the hand id in the address.',
      'Hands played against an AI Legends profile are the ones this page has most to say about, because it ' +
        'can name the style you were up against at every decision.',
      "If you have not played one yet, there is a worked example — somebody else's hand, clearly labelled " +
        'as such.',
    ],
  },
] as const;

function emptyBlock(source: string, title: string, where: string): string {
  const titleAt = source.indexOf(`<h2>${title}</h2>`);
  assert.ok(titleAt >= 0, `${where} does not head "${title}" with an h2`);
  const open = source.lastIndexOf('<div className="prl-empty">', titleAt);
  assert.ok(open >= 0 && titleAt - open < 80, `${where} puts "${title}" outside prl-empty`);
  const close = source.indexOf('</div>', titleAt);
  assert.ok(close > titleAt, `${where} empty state never closes`);
  return source.slice(open, close);
}

describe('the two empty states are empty states', () => {
  it('reads both, keeps every word and both links, and does not use an insight callout (REGRESSION)', () => {
    assert.equal(CASES.length, 2, 'an empty state was dropped from the list, so this can pass over one');
    for (const item of CASES) {
      const where = item.file.join('/');
      const source = read(REPO, ...item.file);
      assert.equal([...source.matchAll(/<h1\b/gu)].length, 1, `${where} does not have exactly one h1`);
      const block = emptyBlock(source, item.title, where);
      assert.doesNotMatch(block, /Callout|tone="insight"|prl-callout|role="note"/u);
      assert.doesNotMatch(source, new RegExp(`tone="insight" title="${item.title}"`, 'u'));
      const prose = readerProse(block);
      assert.ok(prose.length > item.title.length, `${where} empty state has no prose`);
      for (const sentence of item.sentences) {
        assert.ok(prose.includes(sentence), `${where} is missing “${sentence}”`);
      }
      for (const link of item.links) {
        assert.ok(block.includes(link), `${where} lost ${link}`);
      }
    }
  });

  it('sizes the empty heading with the panel titles, not the display h2', () => {
    const css = read(REPO, 'packages', 'ui', 'src', 'styles', 'components.css');
    assert.match(css, /\.prl-empty > h2 \{[^}]*font-size: var\(--prl-type-heading\);/u);
    assert.match(css, /\.prl-empty > h2 \{[^}]*margin: 0;/u);
  });

  it('keeps a gap between the record empty state and the panel after it', () => {
    const css = read(WEB, 'src', 'styles', 'page.css');
    assert.match(css, /\.prl-record > \.prl-empty \+ \.prl-panel\s*\{/u);
    // The warning callout is still a callout, so its gap has to stay too.
    assert.match(css, /\.prl-record > \.prl-callout \+ \.prl-panel/u);
  });
});

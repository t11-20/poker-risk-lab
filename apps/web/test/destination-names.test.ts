/**
 * A destination is called the same thing in the nav, on its own page, and in the links into it.
 *
 * The audit at 6b3886e: the nav said "Legends", the page's h1 said "Opponent profiles" and the
 * Lab's footer link said "AI opponent profiles"; the nav said "Review", the h1 said "Hand history"
 * and the links said "Your hand history". A reader following the nav lands on a page whose heading
 * does not say they arrived where they asked to go.
 *
 * The rule held here is the one a reader can check: each h1 contains its nav word. Learn and Play
 * are not in it — "The curriculum" and "Six-handed table" are pages the audit did not flag, and the
 * Learn index belongs to other work in flight. The pages import CSS, so they are held to source.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { NAV_DESTINATIONS } from '../src/lib/nav.ts';

const read = (path: string): string => readFileSync(new URL(`../src/app/${path}`, import.meta.url), 'utf8');

function labelOf(href: string): string {
  const destination = NAV_DESTINATIONS.find((candidate) => candidate.href === href);
  assert.ok(destination !== undefined, `${href} is no longer a nav destination; this needs updating`);
  return destination.label;
}

/** The text of the page's one `<h1>`, with any markup inside it removed. */
function h1Of(source: string): string {
  const all = [...source.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gu)];
  assert.equal(all.length, 1, 'expected exactly one h1 in the page source');
  return (all[0]?.[1] ?? '').replace(/<[^>]+>/gu, '').trim();
}

describe('the nav word is on the page it leads to', () => {
  for (const [href, page] of [
    ['/legends', 'legends/page.tsx'],
    ['/review', 'review/page.tsx'],
  ] as const) {
    it(`${href}: the h1 contains the nav label (REGRESSION)`, () => {
      const label = labelOf(href);
      const h1 = h1Of(read(page));
      assert.ok(h1.length > 0, `no h1 text in ${page}`);
      assert.ok(h1.toLowerCase().includes(label.toLowerCase()), `nav says "${label}", the h1 says "${h1}"`);
    });
  }

  it('the Lab’s links out name the Legends the way the nav does', () => {
    const lab = read('lab/[scenarioId]/page.tsx');
    const link = /<a href="\/legends">([^<]+)<\/a>/u.exec(lab)?.[1];
    assert.ok(link !== undefined, 'the scenario page no longer links to /legends; this needs updating');
    assert.ok(link.includes(labelOf('/legends')), `the link says "${link}"`);
  });
});

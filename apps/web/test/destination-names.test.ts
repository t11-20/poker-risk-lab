/**
 * A destination is called the same thing in the nav, on its own page, and in the links into it. The
 * rule held is that each h1 contains its nav word. Learn and Play are not checked; their headings
 * were not flagged. The pages import CSS, so they are held to source.
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

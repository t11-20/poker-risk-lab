/**
 * `/record` is reachable from the navigation without becoming a sixth numbered step: from the bar's
 * figure, the explanation's reset, the sheet, the footer's site map and the 404 page. That the five
 * stay five is `legal-pages.test.ts`'s assertion. The components import CSS or Next and cannot load
 * under `node --test`, so they are held to their source.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { NAV_DESTINATIONS, RECORD_DESTINATION } from '../src/lib/nav.ts';
import { RECORD_PATH } from '../src/lib/record-data.ts';

const read = (path: string): string => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');

/** Source without comment lines, so a sentence about a link cannot stand in for one. */
const code = (path: string): string =>
  read(path)
    .split('\n')
    .filter((line) => !/^\s*(?:\*|\/\/|\/\*|\{\/\*)/u.test(line))
    .join('\n');

describe('the reader’s record is in the navigation', () => {
  it('is a destination of its own, at /record, and not one of the numbered five', () => {
    assert.equal(RECORD_DESTINATION.href, RECORD_PATH);
    assert.equal(RECORD_PATH, '/record');
    assert.ok(RECORD_DESTINATION.label.length > 0 && RECORD_DESTINATION.summary.length > 0);
    assert.equal(NAV_DESTINATIONS.length, 5);
    assert.ok(!NAV_DESTINATIONS.some((destination) => destination.href === RECORD_PATH));
  });

  it('is linked from the bar’s units figure and from the explanation’s reset (REGRESSION)', () => {
    const header = code('components/SiteHeader.tsx');
    const badge = /<UnitsBadge\b[\s\S]*?\/>/u.exec(header)?.[0];
    assert.ok(badge !== undefined, 'no <UnitsBadge> in the header');
    assert.match(badge, /recordHref=\{RECORD_DESTINATION\.href\}/u);
    assert.match(badge, /resetHref=\{RECORD_DESTINATION\.href\}/u);
    // A client navigation, not a document load, from the one control that is on every page.
    assert.match(badge, /linkAs=\{Link\}/u);
    // The badge has no router of its own, so the route closes the explanation when the reader moves on.
    assert.match(badge, /route=\{pathname\}/u);
  });

  for (const [where, path] of [
    ['the menu sheet', 'components/MobileNav.tsx'],
    ['the footer’s site map', 'components/SiteFooter.tsx'],
    ['the 404 page', 'app/not-found.tsx'],
  ] as const) {
    it(`is listed after the five in ${where} (REGRESSION)`, () => {
      const source = code(path);
      const five = source.indexOf('NAV_DESTINATIONS.map(');
      const record = source.indexOf('href={RECORD_DESTINATION.href}');
      assert.ok(five >= 0, `${path} no longer renders the five; this assertion needs updating`);
      assert.ok(record > five, `${path} does not link RECORD_DESTINATION after the five`);
      assert.match(source, /\{RECORD_DESTINATION\.label\}/u);
      // The slot holds no suit and is there for alignment.
      assert.match(source, /<SuitMark area=\{null\}/u);
    });
  }
});

describe('the destinations are described in a learner’s words', () => {
  it('does not describe the opponents as "trait vectors"', () => {
    for (const destination of [...NAV_DESTINATIONS, RECORD_DESTINATION]) {
      assert.doesNotMatch(destination.summary, /vector/iu, destination.href);
    }
  });
});

/**
 * `/record` is reachable from the navigation, without becoming a sixth numbered step.
 *
 * ## The defect this exists for
 *
 * The audit at 6b3886e: `/record` holds the reader's progress, the units reset and account
 * deletion, and it was in neither the header nor the menu sheet. On every page the only way in was
 * a phrase inside the footer's prose ("reset to the starting amount whenever you like"), and the
 * "1,000 UNITS" figure in the bar was not a link.
 *
 * ## What is held here
 *
 * The bar's figure and the explanation's reset both lead to it; it is listed, after the five and
 * unnumbered, in the sheet, the footer's site map and the 404 page. That the five stay five is
 * `legal-pages.test.ts`'s assertion and is not repeated here. The components import CSS or Next and
 * cannot be loaded under `node --test`, so they are held to their source.
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
    // A client navigation, not a document load from the one control that is on every page.
    assert.match(badge, /linkAs=\{Link\}/u);
    // What closes the explanation when the reader moves on: the badge has no router of its own.
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
      // Unnumbered: the slot is there for alignment and holds no figure.
      assert.match(source, /className="[^"]*prl-index prl-index--blank" \/>/u);
    });
  }
});

describe('the destinations are described in a learner’s words', () => {
  it('does not describe the opponents as "trait vectors"', () => {
    // Seen in the menu, the footer and the 404 page: a data-structure term on the one line a
    // newcomer reads to decide whether to open the section.
    for (const destination of [...NAV_DESTINATIONS, RECORD_DESTINATION]) {
      assert.doesNotMatch(destination.summary, /vector/iu, destination.href);
    }
  });
});

/**
 * A card on `/legends` points at the page's universal disclaimer instead of repeating it (it was 27%
 * of the page at 360px), and that is the ONLY thing it may stop printing. ADR 0011: a profile is never
 * shown without its framing, so an entry is replaced only when byte-identical to the text above, by a
 * visible pointer. The real disclaimer constants are used, because the property is about those strings.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ATTRIBUTION_DISCLAIMER,
  COURSE_PROFILE_DISCLAIMER,
  UNIVERSAL_DISCLAIMER,
} from '../../../packages/poker-ai/src/labelling.ts';
import { disclaimerFraming } from '../src/lib/disclaimer-framing.ts';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (...parts: readonly string[]): string => readFileSync(join(SRC, ...parts), 'utf8');

describe('disclaimerFraming', () => {
  it('replaces the universal text with a pointer when the page printed it above', () => {
    const framing = disclaimerFraming([UNIVERSAL_DISCLAIMER], UNIVERSAL_DISCLAIMER);
    assert.equal(framing.pointer, true);
    assert.deepEqual(framing.inFull, []);
  });

  it('keeps every card-specific disclaimer in full, in order', () => {
    const all = [UNIVERSAL_DISCLAIMER, ATTRIBUTION_DISCLAIMER, COURSE_PROFILE_DISCLAIMER];
    const framing = disclaimerFraming(all, UNIVERSAL_DISCLAIMER);
    assert.equal(framing.pointer, true);
    assert.deepEqual(framing.inFull, [ATTRIBUTION_DISCLAIMER, COURSE_PROFILE_DISCLAIMER]);
  });

  it('prints everything when nothing was printed above (profile page, compare columns)', () => {
    const all = [UNIVERSAL_DISCLAIMER, COURSE_PROFILE_DISCLAIMER];
    assert.deepEqual(disclaimerFraming(all, undefined), { pointer: false, inFull: all });
    assert.deepEqual(disclaimerFraming(all, ''), { pointer: false, inFull: all });
  });

  it('a universal text that differs by one character from the page’s is not the same, and is printed', () => {
    const reworded = `${UNIVERSAL_DISCLAIMER} `;
    const framing = disclaimerFraming([reworded], UNIVERSAL_DISCLAIMER);
    assert.equal(framing.pointer, false);
    assert.deepEqual(framing.inFull, [reworded]);
  });

  it('never leaves a non-empty list with neither a pointer nor an entry', () => {
    const inputs: (readonly string[])[] = [
      [UNIVERSAL_DISCLAIMER],
      [ATTRIBUTION_DISCLAIMER],
      [UNIVERSAL_DISCLAIMER, UNIVERSAL_DISCLAIMER],
      [UNIVERSAL_DISCLAIMER, COURSE_PROFILE_DISCLAIMER],
    ];
    assert.ok(inputs.length > 0);
    for (const input of inputs) {
      const framing = disclaimerFraming(input, UNIVERSAL_DISCLAIMER);
      assert.ok(framing.pointer || framing.inFull.length > 0, JSON.stringify(input));
    }
  });
});

describe('the screens use the exception only where the full text is above them', () => {
  it('/legends prints the universal disclaimer once, gives it a fragment, and passes it to the cards', () => {
    const page = read('app', 'legends', 'page.tsx');
    assert.match(page, /\{universalDisclaimer\}/u);
    assert.match(page, /id=\{FRAMING_ID\}/u);
    assert.match(page, /shownAbove=\{\{ text: universalDisclaimer, href: `#\$\{FRAMING_ID\}` \}\}/u);
  });

  it('the pointer is visible text and a link, inside the same list', () => {
    // Comments removed: the component's header names `<details>` and tooltips as things it refuses.
    const component = read('components', 'ProfileDisclaimers.tsx')
      .replace(/\/\*[\s\S]*?\*\//gu, '')
      .replace(/^\s*\/\/.*$/gmu, '');
    assert.match(component, /not a real person/u);
    assert.match(component, /<a href=\{shownAbove\.href\}>/u);
    assert.doesNotMatch(component, /<details|\stitle=\{|line-clamp/u);
  });

  it('the profile page and the compare columns do not pass shownAbove', () => {
    for (const parts of [
      ['app', 'legends', '[profileId]', 'page.tsx'],
      ['app', 'legends', 'compare', 'page.tsx'],
      ['components', 'PostHandComparison.tsx'],
    ] as const) {
      assert.doesNotMatch(read(...parts), /shownAbove/u, parts.join('/'));
    }
  });
});

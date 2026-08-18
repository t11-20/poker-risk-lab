/**
 * The claims this product makes about itself have to survive being checked.
 *
 * ## What went wrong
 *
 * The footer told every learner on every page: *"There is no stored odds table anywhere in this
 * product, so there is no table that can be quietly wrong."* The home page said "No odds table,
 * anywhere", the metrics band counted "Hard-coded odds: 0", and the curriculum index said "There is
 * no odds table in this repository to go stale."
 *
 * `apps/web/src/fixtures/*.ts` ships eighteen stored `ruleOfThumb` blocks and twenty-one stored
 * `heroEquity` values — stored odds tables by any reading — as the offline fallback every screen in
 * this app is built to survive on. A release audit found four of them disagreeing with the live
 * calculation. So the product's own honesty statement was falsified by the exact defect it
 * disclaimed, in four places, and nothing could have noticed: it is prose.
 *
 * ## What is asserted, and what deliberately is not
 *
 * This does not try to decide whether a sentence is true — no test can. It pins the specific
 * unqualified phrasings that were checked and found false, so that "simplifying" the wording back
 * to them fails rather than shipping. The honest claim is narrower and is still worth making: no
 * figure is PRODUCED by a lookup, and where a bundled copy is shown the page says so.
 *
 * The fixtures themselves are read here and never edited. They are the evidence for why the
 * unqualified claim is false, and if they are ever genuinely removed from the product this file
 * should be revisited rather than deleted — at that point the strong claim becomes true again.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (...parts: readonly string[]): string => readFileSync(join(SRC, ...parts), 'utf8');

/** Every file that states, in prose a reader sees, where the numbers come from. */
const CLAIM_FILES: readonly (readonly string[])[] = [
  ['components', 'SiteFooter.tsx'],
  ['components', 'MetricsBand.tsx'],
  ['app', 'page.tsx'],
  ['app', 'learn', 'page.tsx'],
];

/**
 * Phrasings that assert an ABSENCE the product cannot demonstrate.
 *
 * Each was on screen, and each is falsified by the bundled fallback. The narrower claim — nothing
 * is *looked up* — is fine and is what these were replaced with.
 */
const FALSIFIED: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  {
    pattern: /no stored odds table anywhere in this product/iu,
    why: 'src/fixtures/*.ts ships stored equity figures as the offline fallback',
  },
  {
    pattern: /no odds table,? anywhere/iu,
    why: 'the same fixtures are an odds table by any reading, and four entries were found wrong',
  },
  {
    pattern: /no odds table in (?:this|the) repository/iu,
    why: 'the fixtures are in this repository',
  },
  {
    pattern: /there is no odds table in this product/iu,
    why: 'there is one; it is the labelled offline fallback',
  },
];

describe('nothing on screen claims an absence the fixtures contradict', () => {
  for (const parts of CLAIM_FILES) {
    const name = parts.join('/');
    it(`${name} makes no unqualified "no odds table" claim`, () => {
      const text = read(...parts);
      for (const { pattern, why } of FALSIFIED) {
        // A block comment may quote the old wording to explain why it was changed; the assertion is
        // about what a reader is shown, so only non-comment lines are checked.
        const prose = text
          .split('\n')
          .filter((line) => !/^\s*(?:\*|\/\/|\/\*)/u.test(line))
          .join('\n');
        assert.doesNotMatch(
          prose,
          pattern,
          `${name} states "${pattern.source}" as fact, and it is false: ${why}. Say what is actually ` +
            'true instead — no figure is produced by a lookup, and the fallback is labelled on the ' +
            'page that shows it.',
        );
      }
    });
  }

  it('the footer still makes the honest version of the claim rather than saying nothing', () => {
    // Deleting the statement would be the other way to pass this file, and it would be a worse
    // product: the claim is the reason to trust the figures, and a narrower true one is still a
    // claim. This asserts the replacement exists.
    const footer = read('components', 'SiteFooter.tsx');
    assert.match(footer, /Nothing is looked up/u);
    assert.match(footer, /bundled copy/u);
    assert.match(footer, /says so at the top/u);
  });

  it('the fallback really is labelled on the page, which is what makes the footer true', () => {
    // The footer's second paragraph rests on this. If the on-page labelling is ever removed, the
    // paragraph becomes false and has to change with it.
    assert.match(read('app', 'learn', '[lessonId]', 'page.tsx'), /This lesson is the bundled copy/u);
    assert.match(read('app', 'play', 'page.tsx'), /Fixture — no server is connected/u);
  });
});

describe('the fixtures the claim has to account for are still there', () => {
  it('still ships stored equity figures, so the narrow wording is still the correct one', () => {
    const fixtures = resolve(SRC, 'fixtures');
    const stored = readdirSync(fixtures)
      .filter((file) => file.endsWith('.ts'))
      .map((file) => readFileSync(join(fixtures, file), 'utf8'))
      .join('\n');
    assert.match(
      stored,
      /heroEquity|ruleOfThumb/u,
      'If the bundled fallback figures have genuinely gone, the strong claim is true again and the ' +
        'wording in CLAIM_FILES can be revisited — deliberately, with this file, rather than by ' +
        'somebody tightening a sentence they thought read better.',
    );
  });
});

/**
 * The content asks the learner and explains to the learner, not to a character nobody introduced.
 *
 * Twenty-four of the Lab's prompts read "Should hero call, fold, or raise?", and "hero" was in none
 * of the ninety glossary terms (UX audit at 6b3886e, Minor 7). 63c84db moved the question and the
 * situation line to "you" and kept "hero" in the reasoning, on the grounds that it is the usual poker
 * word and the learner had by then been asked the question in the second person.
 *
 * That left one reader with two names. Since PR #33 the live table narrates the reader's own seat as
 * "You", the question says "you", and the paragraph that answers it said "hero's five and four extend
 * that run downwards, so hero's best five cards are..." — 121 times in 62 strings across the three
 * scenario files, and eight more in three quiz strings ("Decide whether hero should call or fold").
 * The word is not defined anywhere a learner can look it up, so the rule is now the whole bundle:
 * every string a lesson, quiz, scenario or glossary entry carries. Identifiers are not strings here —
 * `isHero` is a key.
 *
 * Negative control: the scenario and quiz JSON at b05ab96, copied back over these files, fails "no
 * string ... says hero" on exactly those 65 strings; restored, it passes.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { content } from '../src/index.ts';

const HERO = /\bhero\b/iu;

/** Every string value reachable from `value`, each with the path it was found at. */
function* stringsIn(value: unknown, path: string): Generator<readonly [string, string]> {
  if (typeof value === 'string') {
    yield [path, value];
  } else if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) yield* stringsIn(item, `${path}[${index}]`);
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) yield* stringsIn(item, `${path}.${key}`);
  }
}

test('reads every scenario, so this cannot pass over an empty set', () => {
  assert.ok(content().scenarios.length >= 30, `${content().scenarios.length} scenarios`);
});

test('no string in the lessons, quizzes, scenarios or glossary says "hero"', () => {
  const bundle = content();
  const strings = (['lessons', 'quizzes', 'scenarios', 'glossary'] as const).flatMap((part) => [
    ...stringsIn(bundle[part], part),
  ]);
  // Measured at 4,095 when this was written. A floor well under that still fails if a part of the
  // bundle stops being read — a renamed key, a loader that returns [] — rather than passing over it.
  assert.ok(strings.length >= 3_500, `read ${strings.length} strings: a sweep of nothing is not a pass`);
  const offenders = strings.filter(([, text]) => HERO.test(text)).map(([path, text]) => `${path}: ${text}`);
  assert.deepEqual(offenders, [], `"hero" is never defined for a learner:\n  ${offenders.join('\n  ')}`);
});

test('the prompts still ask the learner a question', () => {
  for (const scenario of content().scenarios) {
    assert.match(scenario.question, /\?$/u, `${scenario.id}: the question does not end in a question mark`);
  }
});

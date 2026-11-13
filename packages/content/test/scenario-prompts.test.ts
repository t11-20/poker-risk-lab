/**
 * Every string a lesson, quiz, scenario or glossary entry carries addresses the learner as "you".
 * "hero" is defined nowhere a learner can look it up. Identifiers such as `isHero` are keys, not strings.
 * Negative control. The scenario and quiz JSON at b05ab96 fails on exactly 65 strings.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { content } from '../src/index.ts';

const HERO = /\bhero\b/iu;

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
  // Measured at 4,095. The floor fails if a part of the bundle stops being read.
  assert.ok(strings.length >= 3_500, `read ${strings.length} strings: a sweep of nothing is not a pass`);
  const offenders = strings.filter(([, text]) => HERO.test(text)).map(([path, text]) => `${path}: ${text}`);
  assert.deepEqual(offenders, [], `"hero" is never defined for a learner:\n  ${offenders.join('\n  ')}`);
});

test('the prompts still ask the learner a question', () => {
  for (const scenario of content().scenarios) {
    assert.match(scenario.question, /\?$/u, `${scenario.id}: the question does not end in a question mark`);
  }
});

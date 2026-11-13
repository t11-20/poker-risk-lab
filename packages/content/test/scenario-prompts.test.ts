/**
 * A scenario's prompt asks the learner, not a character nobody introduced.
 *
 * Twenty-four of the Lab's prompts read "Should hero call, fold, or raise?", and "hero" was in none
 * of the ninety glossary terms (UX audit at 6b3886e, Minor 7). A first-time learner meets the word
 * in the question and in the line describing the situation, which are the two things on screen
 * before they decide — so those two fields now say "you". The reasoning and the analysis keep
 * "hero", which is the usual poker word for the player whose decision it is, and which a learner
 * reading them has by then been asked the question in the second person.
 *
 * Negative control: the scenario JSON at 37057ad put back fails "never says hero" on 36 questions
 * and 17 situation lines.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { content } from '../src/index.ts';

const HERO = /\bhero\b/iu;

test('reads every scenario, so this cannot pass over an empty set', () => {
  assert.ok(content().scenarios.length >= 30, `${content().scenarios.length} scenarios`);
});

test('a scenario’s question and situation line never say "hero"', () => {
  const offenders = content().scenarios.flatMap((scenario) =>
    (['question', 'facingAction'] as const)
      .filter((field) => HERO.test(scenario[field]))
      .map((field) => `${scenario.id}.${field}: ${scenario[field]}`),
  );
  assert.deepEqual(offenders, [], `"hero" is never defined for a learner:\n  ${offenders.join('\n  ')}`);
});

test('the prompts still ask the learner a question', () => {
  for (const scenario of content().scenarios) {
    assert.match(scenario.question, /\?$/u, `${scenario.id}: the question does not end in a question mark`);
  }
});

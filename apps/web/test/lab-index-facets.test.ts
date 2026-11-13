/**
 * The Lab index's facet counts and option order. Every option is counted against the other two
 * filters, so the "any" option must be too (it once read 36 with 6 shown). Difficulty and street run
 * in learning and dealing order, not `localeCompare` on the label.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { content } from '@prl/content';
import type { ScenarioSummary } from '@prl/contracts';
import { anyCountFor, FILTER_ANY, type LabSelection, optionsFor } from '../src/lib/lab-filters.ts';
import { difficultyLabel, streetLabel, topicLabel } from '../src/lib/lab-labels.ts';

/** The live list's shape, built from the same bundle the API serves. */
const SUMMARIES: readonly ScenarioSummary[] = content().scenarios.map((scenario) => ({
  id: scenario.id,
  title: scenario.title,
  topic: scenario.topic,
  difficulty: scenario.difficulty,
  question: scenario.question,
  street: scenario.street,
  attempted: false,
}));

const UNFILTERED: LabSelection = { topic: FILTER_ANY, difficulty: FILTER_ANY, street: FILTER_ANY };
const INTRO: LabSelection = { ...UNFILTERED, difficulty: 'intro' };

describe('the Lab facet options', () => {
  it('reads a non-empty bundle', () => {
    assert.ok(
      SUMMARIES.length >= 30,
      `only ${SUMMARIES.length} scenario(s); a sweep of nothing is not a pass`,
    );
  });

  it('counts the "any" option against the other filters, not the whole list (REGRESSION)', () => {
    const intro = SUMMARIES.filter((scenario) => scenario.difficulty === 'intro').length;
    assert.ok(intro > 0 && intro < SUMMARIES.length, 'the bundle needs some Intro scenarios and some not');
    assert.equal(anyCountFor(SUMMARIES, INTRO, 'topic'), intro);
    assert.equal(anyCountFor(SUMMARIES, INTRO, 'street'), intro);
    // Relaxing the facet's own filter makes it a prediction, so "Every level" with Intro counts everything.
    assert.equal(anyCountFor(SUMMARIES, INTRO, 'difficulty'), SUMMARIES.length);
    for (const facet of ['topic', 'difficulty', 'street'] as const) {
      const options = optionsFor(SUMMARIES, INTRO, facet, (id) => id);
      const sum = options.reduce((total, option) => total + option.count, 0);
      assert.equal(anyCountFor(SUMMARIES, INTRO, facet), sum, `${facet}: "any" disagrees with its options`);
    }
  });

  it('orders difficulty by progression and streets by the order they are dealt (REGRESSION)', () => {
    assert.deepEqual(
      optionsFor(SUMMARIES, UNFILTERED, 'difficulty', difficultyLabel).map((option) => option.label),
      ['Intro', 'Core', 'Advanced'],
    );
    assert.deepEqual(
      optionsFor(SUMMARIES, UNFILTERED, 'street', streetLabel).map((option) => option.label),
      ['Preflop', 'Flop', 'Turn', 'River'],
    );
  });

  it('keeps topics alphabetical and puts a value with no rank last rather than dropping it', () => {
    const topics = optionsFor(SUMMARIES, UNFILTERED, 'topic', topicLabel).map((option) => option.label);
    assert.deepEqual(
      topics,
      [...topics].sort((a, b) => a.localeCompare(b, 'en')),
    );
    const withStray = [
      ...SUMMARIES,
      { ...SUMMARIES[0], id: 'stray', difficulty: 'expert' } as ScenarioSummary,
    ];
    const labels = optionsFor(withStray, UNFILTERED, 'difficulty', difficultyLabel).map(
      (option) => option.value,
    );
    assert.deepEqual(labels, ['intro', 'core', 'advanced', 'expert']);
  });
});

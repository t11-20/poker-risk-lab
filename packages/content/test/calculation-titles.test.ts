/**
 * The optional `title` on a live calculation. It exists because /learn/pot-odds showed three
 * calculators all headed "The price of this call".
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RawContent } from '../src/index.ts';
import { collectContentProblems, content, readRawContent } from '../src/index.ts';

interface RawLesson {
  readonly id: string;
  readonly blocks: Record<string, unknown>[];
}

function withPotOddsTitle(title: unknown): RawContent {
  const raw = structuredClone(readRawContent());
  const lessons = raw.lessons as unknown as RawLesson[];
  const lesson = lessons.find((entry) => entry.id === 'pot-odds');
  assert.ok(lesson !== undefined, 'the pot-odds lesson is in the bundle');
  const block = lesson.blocks.find((entry) => entry['kind'] === 'liveCalculation');
  assert.ok(block !== undefined, 'the pot-odds lesson has a live calculation');
  block['title'] = title;
  return raw;
}

describe('a live calculation title', () => {
  it('names each of the pot-odds calculators differently', () => {
    const lesson = content().lessons.find((entry) => entry.id === 'pot-odds');
    const titles = (lesson?.blocks ?? []).flatMap((block) =>
      block.kind === 'liveCalculation' && block.calculation.kind === 'potOdds' ? [block.title] : [],
    );
    assert.deepEqual(titles, ['A pot-sized bet', 'A half-pot bet', 'An overbet']);
  });

  it('is accepted as a short string', () => {
    assert.deepEqual(collectContentProblems(withPotOddsTitle('A pot-sized bet')), []);
  });

  it('is refused when it is not one', () => {
    for (const bad of [42, '', 'x'.repeat(81)]) {
      const problems = collectContentProblems(withPotOddsTitle(bad));
      assert.ok(
        problems.some((problem) => problem.includes('.title')),
        `${JSON.stringify(bad).slice(0, 20)} was not refused: ${problems.join('; ')}`,
      );
    }
  });

  it('stays absent where a block sets none', () => {
    const untitled = content()
      .lessons.flatMap((lesson) => lesson.blocks)
      .filter((block) => block.kind === 'liveCalculation' && block.calculation.kind !== 'potOdds');
    assert.ok(untitled.length > 0, 'a sweep of nothing is not a pass');
    for (const block of untitled) assert.ok(!('title' in block), 'an untitled block grew a title');
  });
});

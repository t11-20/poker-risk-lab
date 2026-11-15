/**
 * Prose that names cards in shared notation ("Ah Kh"), rendered, read twice: what is painted and what a
 * screen reader hears. Swept over every quiz string a learner reads and every Lab assumption and
 * reasoning paragraph. Expected names are hand-derived, not from `describeCard`.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadComponent } from './support/render-component.ts';

const RUN = /(?<![A-Za-z0-9])[2-9TJQKA][shdc](?: ?[2-9TJQKA][shdc])+(?![A-Za-z0-9])/;
const DATA = new URL('../../content/data/', import.meta.url);
const json = (path: string): unknown => JSON.parse(readFileSync(new URL(path, DATA), 'utf8'));

interface QuizData {
  readonly reviewAdvice: string;
  readonly questions: readonly {
    readonly prompt: string;
    readonly explanation: string;
    readonly options?: readonly string[];
    readonly optionNotes?: readonly string[];
  }[];
}

const QUIZ_TEXT = (json('quizzes.json') as QuizData[]).flatMap((quiz) => [
  quiz.reviewAdvice,
  ...quiz.questions.flatMap((q) => [q.prompt, q.explanation, ...(q.options ?? []), ...(q.optionNotes ?? [])]),
]);
const LAB_ASSUMPTIONS = readdirSync(new URL('scenarios/', DATA)).flatMap((file) =>
  (json(`scenarios/${file}`) as { readonly assumptions: readonly string[] }[]).flatMap((s) => s.assumptions),
);
const LAB_REASONING = readdirSync(new URL('scenarios/', DATA)).flatMap((file) =>
  (json(`scenarios/${file}`) as { readonly reasoning: string }[]).flatMap((s) => s.reasoning.split('\n\n')),
);

const ENTITIES: Readonly<Record<string, string>> = {
  '&amp;': '&',
  '&quot;': '"',
  '&#x27;': "'",
  '&lt;': '<',
};

/** An `aria-hidden` subtree is only painted, a `prl-visually-hidden` one only heard. */
function read(markup: string): { readonly painted: string; readonly heard: string } {
  let painted = '';
  let heard = '';
  const open: ('painted' | 'heard' | 'both')[] = [];
  for (const [, close, attributes, raw] of markup.matchAll(/<(\/?)[a-z][a-z0-9]*([^>]*)>|([^<]+)/g)) {
    if (raw !== undefined) {
      const text = raw.replace(/&[#a-z0-9]+;/g, (entity) => ENTITIES[entity] ?? entity);
      if (!open.includes('painted')) heard += text;
      if (!open.includes('heard')) painted += text;
    } else if (close === '/') open.pop();
    else if (attributes?.includes('aria-hidden="true"')) open.push('painted');
    else open.push(attributes?.includes('prl-visually-hidden') ? 'heard' : 'both');
  }
  return { painted: painted.replaceAll('︎', ''), heard };
}

async function cardText(text: string): Promise<{ readonly painted: string; readonly heard: string }> {
  const CardText = await loadComponent<{ readonly text: string }>('components/CardText', 'CardText');
  return read(renderToStaticMarkup(createElement(CardText, { text })));
}

test('a run of cards is painted as the table paints it and heard by name, with a comma between', async () => {
  const { painted, heard } = await cardText('You hold Ah Kh and the flop is Th 7c 2s.');
  assert.equal(painted, 'You hold A♥ K♥ and the flop is 10♥ 7♣ 2♠.');
  assert.equal(
    heard,
    'You hold ace of hearts, king of hearts and the flop is ten of hearts, seven of clubs, two of spades.',
  );
});

test('one card alone and range notation stay words, because "As" is English and "AKs" is a range', async () => {
  for (const text of ['As two outs', 'AKs or T9s', 'and you hold Qs.']) {
    assert.deepEqual(await cardText(text), { painted: text, heard: text });
  }
  assert.equal((await cardText('7c7d')).painted, '7♣ 7♦', 'a run written without spaces is still a run');
});

test('no quiz string and no Lab paragraph reaches the page or the reader as "Ah Kh"', async () => {
  const quizRuns = QUIZ_TEXT.filter((text) => RUN.test(text));
  // Eight quiz prompts carry runs today. Zero would be a sweep of nothing.
  assert.ok(quizRuns.length >= 8, `only ${String(quizRuns.length)} quiz strings with card runs were found`);
  const withRuns = [...quizRuns, ...LAB_REASONING.filter((text) => RUN.test(text))];
  for (const text of withRuns) {
    const { painted, heard } = await cardText(text);
    assert.doesNotMatch(painted, RUN, `painted: ${painted}`);
    assert.doesNotMatch(heard, RUN, `heard: ${heard}`);
    assert.doesNotMatch(heard, /[♠♥♦♣]/, `a suit glyph is read aloud as "black heart suit": ${heard}`);
  }
});

test('a Lab assumption list paints cards, not notation', async () => {
  const AssumptionList = await loadComponent<{ readonly items: readonly string[] }>(
    'components/AssumptionList',
    'AssumptionList',
  );
  assert.ok(
    LAB_ASSUMPTIONS.some((text) => RUN.test(text)),
    'no Lab assumption names a card run any more',
  );
  const { painted, heard } = read(
    renderToStaticMarkup(createElement(AssumptionList, { items: LAB_ASSUMPTIONS })),
  );
  assert.doesNotMatch(painted, RUN, `painted "${painted.match(RUN)?.[0] ?? ''}"`);
  assert.match(heard, /king of clubs, eight of diamonds, three of spades/);
});

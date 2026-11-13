/**
 * A multiple-choice answer is given by "Check answer", never by the radio group changing, because a
 * radio group changes on every arrow key and each change posted an attempt. With no renderer
 * (ADR 0008) this reads `QuizRunner.tsx`. The radio may only select, and the one `onAnswer` call in
 * the branch is the Check button's. `test:ax` J2.5 covers it in a browser.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const runner = readFileSync(join(SRC, 'components', 'QuizRunner.tsx'), 'utf8');

/** The multiple-choice component's source, from its declaration to the numeric section's banner. */
const multipleChoice = (() => {
  const start = runner.indexOf('function MultipleChoice(');
  const end = runner.indexOf('// Numeric', start);
  assert.ok(
    start >= 0 && end > start,
    'MultipleChoice was not found in QuizRunner.tsx; point this test at it',
  );
  return runner.slice(start, end);
})();

/** The JSX of the radio input itself, so the handler read is the radio's and nobody else's. */
const radio = /<input\s[^>]*type="radio"[\s\S]*?\/>/u.exec(multipleChoice)?.[0] ?? '';

describe('a multiple-choice question is answered by pressing Check answer', () => {
  it('finds the radio, so this cannot pass by failing to look', () => {
    assert.match(radio, /type="radio"/u);
    assert.match(radio, /onChange=/u);
  });

  it('only selects when the radio changes', () => {
    assert.doesNotMatch(
      radio,
      /onAnswer/u,
      'the radio answers on change: arrowing through the group answers and posts every option passed',
    );
    assert.match(radio, /onChange=\{\(\) => setSelected\(index\)\}/u);
  });

  it('answers from the Check button, with the selected option', () => {
    const calls = multipleChoice.match(/onAnswer\(/gu) ?? [];
    assert.equal(calls.length, 1, 'exactly one place in the multiple-choice branch gives an answer');
    assert.match(
      multipleChoice,
      /className="prl-learn-quiz__check"[\s\S]*?disabled=\{selected === null\}[\s\S]*?onAnswer\(\{ kind: 'choice', index: selected \}\)[\s\S]*?'Check answer'/u,
    );
  });
});

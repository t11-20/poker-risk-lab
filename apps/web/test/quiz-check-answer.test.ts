/**
 * A multiple-choice answer is given by "Check answer", never by the radio group changing.
 *
 * ## The defect (UX audit at 6b3886e, Minor 2)
 *
 * `MultipleChoice` answered on the radio's `onChange`. A radio group changes on every arrow key, so a
 * keyboard reader moving through four options answered, and posted to the attempts endpoint, each
 * one on the way — measured: Space → "not the answer", Down → "matches", Down → "not the answer" —
 * and one stray tap on a phone revealed which option is "the answer this lesson gives".
 *
 * ## What is asserted, and where the rest is
 *
 * This app has no component renderer in its tests (ADR 0008: `node --test`, no framework), so this
 * reads `QuizRunner.tsx` the way `y2-quiz-recording-note.test.ts` does: the radio's change handler
 * may only select, and the one call to `onAnswer` in the multiple-choice branch is the Check
 * button's. The behaviour in a browser is `test:ax`'s J2.5, which reads the verdict region between
 * selecting and pressing and fails if anything was written there.
 *
 * Negative control: the old `QuizRunner.tsx` put back fails both behaviour cases.
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

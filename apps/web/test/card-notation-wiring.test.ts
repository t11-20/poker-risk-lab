/**
 * Every quiz string a learner reads, and the Lab and lesson prose that names cards, goes through
 * `CardText`, so "Ah Kh" is painted "A♥ K♥" and heard "ace of hearts, king of hearts". With no renderer
 * (ADR 0008) this reads the source. `packages/ui/test/card-text-render.test.ts` renders `CardText`.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components');

const SITES: Readonly<Record<string, readonly string[]>> = {
  'QuizRunner.tsx': [
    'question.prompt',
    'entry.value',
    'note',
    'question.explanation',
    'props.explanation',
    'quiz.reviewAdvice',
    'result.derivation',
    'assumption',
  ],
  'ScenarioStage.tsx': ['paragraph'],
  'LiveCalculation.tsx': ['result.derivation', 'outcome.note'],
};

for (const [file, expressions] of Object.entries(SITES)) {
  it(`${file} renders its prose through CardText`, () => {
    const source = readFileSync(join(SRC, file), 'utf8');
    for (const expression of expressions) {
      assert.ok(source.includes(`<CardText text={${expression}} />`), `${expression} is not wrapped`);
      assert.doesNotMatch(source, new RegExp(`>\\s*\\{${expression.replace('.', '\\.')}\\}\\s*<`));
    }
  });
}

/**
 * Copy a learner reads is written for a learner, not for whoever maintains the code. The listed files
 * are read with comments removed, and the phrases below are shapes of the defect, not the exact old
 * sentences. It is a list, not a sweep, because `/privacy` and `/terms` are a data inventory and a legal
 * document, where naming tables is the point. The twelve files at 37057ad fail all twelve cases.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

const FILES: readonly string[] = [
  'app/record/page.tsx',
  'app/record/UnitsReset.tsx',
  'app/record/DeleteAccount.tsx',
  'lib/record-data.ts',
  'lib/quiz-attempts.ts',
  'lib/lesson-reads.ts',
  'components/LessonRead.tsx',
  'components/QuizRunner.tsx',
  'components/ScenarioStage.tsx',
  'app/legends/page.tsx',
  'app/lab/page.tsx',
  'app/lab/[scenarioId]/page.tsx',
];

/** Developer-facing shapes. Each is something a learner was shown, or its near neighbour. */
const DEVELOPER_LANGUAGE: readonly RegExp[] = [
  /\bdatabase\b/iu,
  /\bserver[’']s\b/iu,
  /\bthe server (could not|stamped|said)/iu,
  /\bendpoint\b/iu,
  /\bsecurity token\b/iu,
  /\bthis deployment\b/iu,
  /\bcontent bundle\b/iu,
  /\bcrawler\b/iu,
  /\bprefetch\b/iu,
  /\bsigned in\b/iu,
  /\bone row\b/iu,
  /\bcolumn\b/iu,
  /Naming: /u,
  /src\/fixtures\//u,
  /\bAPI is not reachable\b/u,
  /\bcontent bug\b/iu,
];

function withoutComments(source: string): string {
  return source
    .replace(/\{\/\*[\s\S]*?\*\/\}/gu, '')
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/^\s*\/\/.*$/gmu, '')
    .replace(/\s\/\/ .*$/gmu, '');
}

describe('learner-facing copy carries no developer language', () => {
  it('reads every file in the list, so this cannot pass by reading nothing', () => {
    for (const file of FILES) {
      assert.ok(withoutComments(readFileSync(join(SRC, file), 'utf8')).length > 500, `${file} is empty`);
    }
  });

  for (const file of FILES) {
    it(file, () => {
      const copy = withoutComments(readFileSync(join(SRC, file), 'utf8'));
      for (const shape of DEVELOPER_LANGUAGE) {
        const found = shape.exec(copy);
        assert.equal(
          found,
          null,
          `${file} shows a learner "${found?.input.slice(Math.max(0, found.index - 50), found.index + 60).replace(/\s+/gu, ' ')}". ` +
            'Say what it means for them, and put the implementation reason in a comment beside it.',
        );
      }
    });
  }
});

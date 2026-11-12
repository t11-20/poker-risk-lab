/**
 * Copy a learner reads is written for a learner, not for whoever maintains the code.
 *
 * ## The defect (UX audit at 6b3886e, M5)
 *
 * First-time learners were shown, among others: "because the database has no column one could be
 * stored in and the response type has no field one could be sent in" (/record); "This is the
 * server’s own comparison, made against a figure it computed when you answered" (after every quiz
 * answer); "a prefetch, a crawler and a back-button all look the same to the server" (every lesson);
 * "Naming: archetype" and "This deployment shows archetype names only" (/legends); "could not get a
 * security token" (/record); and "If you are signed in" in a product with no sign-in for a learner.
 * Every one was true, and the reasoning behind it now lives in a comment beside the copy.
 *
 * ## What is asserted
 *
 * The files those sentences came from are read with their comments removed, so what is left is code
 * and copy, and none of the phrases below may appear in it. The phrases are the shapes of the
 * defect rather than the exact old sentences, so a new sentence about "the server's verdict" fails
 * too. It is a list of files, not a sweep of the app: `/privacy` and `/terms` are a data inventory and
 * a legal document, and naming tables and deployments there is the point of them.
 *
 * Negative control: the twelve files at 37057ad put back fail all twelve cases.
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

/** The source with every comment removed, so what remains is code and the copy it renders. */
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

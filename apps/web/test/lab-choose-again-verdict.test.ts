/**
 * "Choose again" in the Lab, then a second commit. The reveal rendered once with the first commit's
 * server verdict before the grading effect reset it, so a stale verdict flashed beside the new choice.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const STAGE = readFileSync(join(SRC, 'components', 'ScenarioStage.tsx'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//gu, '')
  .replace(/^\s*\/\/.*$/gmu, '');

describe('"Choose again" forgets the previous verdict (REGRESSION)', () => {
  it('resets the server verdict in the same handler that clears the choice', () => {
    assert.match(
      STAGE,
      /choseAgain\.current = true;\s*setCommitted\(null\);\s*setServer\(\{ state: 'pending' \}\);/u,
    );
  });

  it('drops a session lookup the reset aborted, which resolves as a failure', () => {
    assert.match(
      STAGE,
      /await fetchSession\(\{ signal: controller\.signal \}\);\s*if \(controller\.signal\.aborted\) return;/u,
    );
  });
});

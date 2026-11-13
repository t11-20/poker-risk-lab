/** Production dependencies. Bot decisions use a CSPRNG too, since a chat table has no replay to seed. */

import { randomBytes } from 'node:crypto';
import { createSecureRandom } from '@prl/poker-engine';
import { coachReportFor } from './coach.ts';
import type { Deps } from './step.ts';

export function productionDeps(): Deps {
  return {
    dealRandom: () => createSecureRandom(),
    decisionRandom: () => createSecureRandom(),
    coach: coachReportFor,
    // 48 bits, so a stale button matches a new tag with probability 2^-48.
    newTag: () => randomBytes(6).toString('base64url'),
  };
}

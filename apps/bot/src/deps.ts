/**
 * The dependencies a real session runs on. Tests build their own; nothing else does.
 *
 * Cards are dealt from `createSecureRandom()`, a fresh CSPRNG per hand. Bot decisions draw from
 * one too: the web seeds its bots so a Legends match replays, and a chat table has no replay to
 * keep, so there is nothing a seed would buy.
 */

import { randomBytes } from 'node:crypto';
import { createSecureRandom } from '@prl/poker-engine';
import { coachReportFor } from './coach.ts';
import type { Deps } from './step.ts';

export function productionDeps(): Deps {
  return {
    dealRandom: () => createSecureRandom(),
    decisionRandom: () => createSecureRandom(),
    coach: coachReportFor,
    // 48 bits: a stale button from an earlier table matching this one's tag is a 1 in 2^48 event.
    newTag: () => randomBytes(6).toString('base64url'),
  };
}

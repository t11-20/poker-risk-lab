/**
 * What a bot seat writes down so a different process can put the same opponent back.
 * A seat is `(profileId, difficulty, seed)`, and all three change how it plays. The seed stored is
 * the resolved one the runner was given, so a rehydrated seat replays the stream even if `seedFor` changes.
 * `unknown` marks rows from before migration `0003`, whose profile was lost. Such a seat, or one
 * naming a retired profile, is re-taken as an ordinary seat with no bot, and the reason is logged.
 * Never substitute the nearest style.
 */

import { DIFFICULTIES, type Difficulty, PROFILES, type StrategyProfile } from '@prl/poker-ai';
import { AppError } from '../errors.ts';

/** Never written by this build. Kept so the CHECK admits the pre-`0003` rows. */
export const UNRECOVERABLE_BOT_PROFILE = 'unknown';

/** `scripts/verify-schema.mjs` asserts the database CHECK admits exactly this set. */
export const PERSISTABLE_BOT_PROFILES: readonly string[] = Object.freeze([
  ...PROFILES.map((profile) => profile.naming.id),
  UNRECOVERABLE_BOT_PROFILE,
]);

/** Everything a rehydrated seat needs to become the same opponent again. */
export interface DurableBotSeat {
  readonly profileId: string;
  readonly difficulty: Difficulty;
  /** The resolved seed the runner was given, not the caller's base. `0 .. 2^32 - 1`. */
  readonly seed: number;
}

/** Largest value `bot_seed` accepts: `seedFor` produces a uint32. */
export const MAX_BOT_SEED = 0xffffffff;

/**
 * Throws rather than substituting. Every caller already resolved the profile, so an unknown id is
 * a programming error, and a row naming the wrong opponent is worse than a 500.
 */
export function durableProfile(profileId: string): string {
  if (!PROFILES.some((profile) => profile.naming.id === profileId)) {
    throw new AppError('internal_error', {
      logDetail: `refusing to persist bot profile "${profileId}": not a strategy profile this build carries`,
    });
  }
  return profileId;
}

/** Rejects a seed the column will not take, before Postgres does. */
export function durableSeed(seed: number): number {
  if (!Number.isInteger(seed) || seed < 0 || seed > MAX_BOT_SEED) {
    throw new AppError('internal_error', {
      logDetail: `refusing to persist bot seed ${String(seed)}: not a uint32`,
    });
  }
  return seed;
}

/** Why a persisted seat could not be turned back into a bot. Null when it can. */
export type RehydrationRefusal =
  | { readonly kind: 'unrecoverable-profile' }
  | { readonly kind: 'unknown-profile'; readonly profileId: string }
  | { readonly kind: 'incomplete-configuration'; readonly missing: readonly string[] };

export type Rehydration =
  | { readonly ok: true; readonly seat: DurableBotSeat; readonly profile: StrategyProfile }
  | { readonly ok: false; readonly refusal: RehydrationRefusal };

/** Non-throwing: `ensureOpen` calls this per seat, and one bad row must not take the room down. */
export function rehydrateBotSeat(row: {
  readonly botProfile: string | null;
  readonly botDifficulty: string | null;
  readonly botSeed: number | null;
}): Rehydration {
  if (row.botProfile === null || row.botProfile === UNRECOVERABLE_BOT_PROFILE) {
    return { ok: false, refusal: { kind: 'unrecoverable-profile' } };
  }
  const profile = PROFILES.find((candidate) => candidate.naming.id === row.botProfile);
  if (profile === undefined) {
    return { ok: false, refusal: { kind: 'unknown-profile', profileId: row.botProfile } };
  }
  const missing: string[] = [];
  if (row.botDifficulty === null || !isDifficulty(row.botDifficulty)) missing.push('bot_difficulty');
  if (
    row.botSeed === null ||
    !Number.isInteger(row.botSeed) ||
    row.botSeed < 0 ||
    row.botSeed > MAX_BOT_SEED
  ) {
    missing.push('bot_seed');
  }
  if (missing.length > 0) {
    return { ok: false, refusal: { kind: 'incomplete-configuration', missing } };
  }
  return {
    ok: true,
    profile,
    seat: {
      profileId: profile.naming.id,
      difficulty: row.botDifficulty as Difficulty,
      seed: row.botSeed as number,
    },
  };
}

/** A sentence for the log. Every refusal names the seat's own reason rather than a generic one. */
export function describeRefusal(refusal: RehydrationRefusal): string {
  switch (refusal.kind) {
    case 'unrecoverable-profile':
      return 'the row predates migration 0003 and its strategy profile was destroyed at write time';
    case 'unknown-profile':
      return `"${refusal.profileId}" is not a strategy profile this build carries`;
    case 'incomplete-configuration':
      return `the row is missing ${refusal.missing.join(' and ')}`;
  }
}

export function isDifficulty(value: string): value is Difficulty {
  return (DIFFICULTIES as readonly string[]).includes(value);
}

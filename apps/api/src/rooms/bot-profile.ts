/**
 * What a bot seat has to write down so that a *different process* can put the same opponent back.
 *
 * ## The defect this module exists to close
 *
 * `room_members.bot_profile` used to be CHECK-constrained to the contract's five
 * `OPPONENT_PROFILES` — `nit`, `tight-aggressive`, `loose-aggressive`, `calling-station`,
 * `maniac` — which are *scenario range labels*, not the twelve strategy profiles
 * `@prl/poker-ai` actually plays. A Legends seat was therefore persisted through a lossy
 * mapping that returned the literal string `unknown` for anything the five names could not
 * express: seven of the twelve. The live registry held the truth and the durable row did not,
 * so the truth lived exactly as long as the process did.
 *
 * Restarting the API then produced a table that looked right and was not. `ensureOpen` re-took
 * every recorded seat and re-registered no bots at all, on the stated reasoning that an inert
 * seat which times out is more honest than one playing a different style. That reasoning is
 * sound about *strategy substitution* and wrong about the remedy: the fix for "the row cannot
 * name the opponent" is to make the row name the opponent, not to stop putting opponents back.
 *
 * ## Three facts, because a profile id alone does not reproduce a seat
 *
 * A bot seat is `(profile, difficulty, seed)` and all three change how it plays:
 *
 *   - `profileId`   which of the twelve strategies. Now stored verbatim.
 *   - `difficulty`  `expressTraits` scales every trait by it, so the same profile at
 *                   `educational` and at `expert` are different opponents.
 *   - `seed`        fixes the decision stream. `seedFor(roomId, seat, base)` is stable across
 *                   restarts for a given base, but the *base* was a request field that nothing
 *                   persisted, so a seeded Legends match could not be resumed reproducibly.
 *
 * Storing the resolved seed rather than the base is deliberate: it is the value the runner was
 * actually given, so a rehydrated seat reproduces the stream even if `seedFor` is ever changed.
 *
 * ## What `unknown` means now, and why it is still permitted
 *
 * It is no longer a fallback — nothing writes it. It is the residue of rows written before
 * migration `0003`, whose true profile was destroyed at write time and cannot be recovered by
 * any amount of later cleverness. Such a seat is re-taken as an ordinary occupied seat and is
 * NOT registered with the bot runner, and the reason is logged. That is the one honest outcome:
 * substituting a strategy would be inventing an opponent, and refusing the whole room would
 * strand a table over a seat.
 *
 * The same refusal covers a profile id this build no longer carries — a retired Legend. Failing
 * explicitly is the requirement; guessing the nearest surviving style is the bug.
 */

import { DIFFICULTIES, type Difficulty, PROFILES, type StrategyProfile } from '@prl/poker-ai';
import { AppError } from '../errors.ts';

/**
 * The value stored for a bot seat whose true profile is not recoverable.
 *
 * Never written by this build. Retained so migration `0003` has something to leave in the rows
 * it cannot repair, and so the CHECK constraint accepts them.
 */
export const UNRECOVERABLE_BOT_PROFILE = 'unknown';

/**
 * Every value `room_members.bot_profile` may hold.
 *
 * Derived from `PROFILES` rather than written out, so adding or retiring a strategy moves this
 * list automatically. `apps/api/scripts/verify-schema.mjs` asserts the database CHECK admits
 * exactly this set, which is what stops the schema and the runtime drifting apart again — the
 * drift being the whole of the original defect.
 */
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
 * The durable name for a strategy profile, or a refusal.
 *
 * Throws rather than substituting, because every caller here is seating a bot it has *already*
 * resolved through `resolveProfile` — so an unknown id at this point is a programming error, and
 * writing a row that names the wrong opponent is worse than a 500.
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

/**
 * Turns three persisted columns back into a bot seat, or says exactly why it will not.
 *
 * Total and non-throwing: `ensureOpen` calls this once per seat while opening a room, and one
 * unrepairable row must not take the room down with it.
 */
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

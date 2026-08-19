-- =============================================================================
-- 0003 — a bot seat that survives the process that created it
-- =============================================================================
--
-- ## What was wrong
--
-- `room_members.bot_profile` was CHECK-constrained to the five values of
-- `OPPONENT_PROFILES` in packages/contracts/src/content-types.ts. Those five are
-- *scenario range labels* — the vocabulary a Scenario Lab spot uses to say what
-- an opponent might hold — and they were reused here for a different job: naming
-- which of the twelve `@prl/poker-ai` strategy profiles is sitting in the seat.
--
-- The two vocabularies are not the same size, so the write path went through a
-- lossy mapping (`persistableProfile`) that answered the literal string
-- `unknown` for every profile the five names could not express. Seven of the
-- twelve. `vocal-aggressor`, `adaptive-exploiter`, `old-school-pressure`,
-- `mixed-game-generalist`, `foundational-reader`, `range-narrator` and
-- `fundamentals-coach` all persisted as `unknown`.
--
-- The live registry held the real id, so nothing looked wrong until the process
-- ended. After a restart the roster said `unknown` and `ensureOpen` re-took the
-- seats without registering any bot at all, so an AI Legends table came back as
-- a row of seats that do nothing until the turn clock folds them.
--
-- ## What this migration changes
--
-- 1. `bot_profile` now holds the strategy profile's own id. The CHECK lists the
--    twelve, plus `unknown` for the rows below that cannot be repaired.
-- 2. The five legacy names are converted to the profile ids they always meant.
--    The mapping is `LEGACY_PROFILE_IDS` in apps/api/src/rooms/bots.ts and is
--    reproduced here verbatim rather than referenced, because a migration has to
--    be readable and re-runnable years after the constant moves.
-- 3. Two new columns, `bot_difficulty` and `bot_seed`. A profile id alone does
--    not reproduce an opponent: `expressTraits` scales every trait by the
--    difficulty, and the seed fixes the decision stream. Both were request
--    fields that nothing wrote down, so even the five profiles that *could* be
--    named could not be put back as the same player.
--
-- ## What it deliberately does NOT do
--
-- It does not invent a difficulty or a seed for existing rows, and it does not
-- guess a profile for a row that says `unknown`. Those facts were destroyed at
-- write time. `rehydrateBotSeat` refuses such a seat explicitly and the reason
-- reaches the log; the seat is still re-taken as an occupied seat, so the table
-- is consistent, it simply has nobody deciding for it until somebody stands the
-- bot up. Substituting the nearest surviving style would be inventing an
-- opponent, which is the failure mode this whole change exists to remove.
--
-- Forward-compatibility is enforced in the application, not by a NOT NULL that
-- would have required inventing values here: `addMember` refuses a bot seat
-- without all three fields, `room_members_bot_config_requires_bot` below stops a
-- human seat carrying them, and `apps/api/scripts/verify-schema.mjs` asserts the
-- CHECK's value set is exactly the runtime profile list — which is what stops
-- the schema and the code drifting apart the way they did the first time.
--
-- prl:irreversible: the old CHECK is dropped and the five legacy bot_profile
-- names are rewritten in place to the strategy profile ids they stood for. The
-- rewrite is information-preserving in one direction only — the mapping is
-- many-to-one at the vocabulary level, so a restore is the only way back to a
-- row that literally said 'nit'. Nothing reads those five names any more:
-- OPPONENT_PROFILES remains the Scenario Lab's range vocabulary and is no longer
-- the bot seat's. Rows already saying 'unknown' are left untouched and stay
-- unrecoverable, which they were before this file as well.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Convert the five legacy names to the profile ids they stood for.
--
-- Runs BEFORE the constraint is swapped, while the old CHECK still admits the
-- source values and the new one does not yet reject them. `unknown` is left
-- exactly as it is: there is nothing to convert it to.
-- -----------------------------------------------------------------------------
ALTER TABLE prl.room_members
  DROP CONSTRAINT room_members_bot_profile_allowed;

UPDATE prl.room_members
   SET bot_profile = CASE bot_profile
                       WHEN 'nit'              THEN 'disciplined-specialist'
                       WHEN 'tight-aggressive' THEN 'patient-technician'
                       WHEN 'loose-aggressive' THEN 'reading-pressure-specialist'
                       WHEN 'calling-station'  THEN 'calling-station'
                       WHEN 'maniac'           THEN 'volume-grinder'
                       ELSE bot_profile
                     END
 WHERE bot_profile IN ('nit', 'tight-aggressive', 'loose-aggressive', 'calling-station', 'maniac');

-- -----------------------------------------------------------------------------
-- 2. The twelve strategy profiles, plus the irreparable-row marker.
--
-- Kept in the order `PROFILE_LIST` declares them in packages/poker-ai/src/profiles.ts
-- so a diff against that file is a single visual scan.
-- -----------------------------------------------------------------------------
ALTER TABLE prl.room_members
  ADD CONSTRAINT room_members_bot_profile_allowed CHECK (
    bot_profile IS NULL
    OR bot_profile IN (
      'vocal-aggressor',
      'adaptive-exploiter',
      'patient-technician',
      'reading-pressure-specialist',
      'old-school-pressure',
      'mixed-game-generalist',
      'volume-grinder',
      'disciplined-specialist',
      'foundational-reader',
      'range-narrator',
      'fundamentals-coach',
      'calling-station',
      'unknown'
    )
  );

COMMENT ON COLUMN prl.room_members.bot_profile IS
  'The @prl/poker-ai strategy profile id playing this seat. ''unknown'' marks a row written before '
  'migration 0003, whose profile is unrecoverable; such a seat is re-taken but never re-registered '
  'with the bot runner. NULL for a human seat.';

-- -----------------------------------------------------------------------------
-- 3. The rest of the seat's configuration.
--
-- `bot_seed` is a bigint rather than an int because `seedFor` produces a uint32
-- and Postgres' `int` is signed — half the range would not fit.
-- -----------------------------------------------------------------------------
ALTER TABLE prl.room_members
  ADD COLUMN bot_difficulty text NULL
    CONSTRAINT room_members_bot_difficulty_allowed CHECK (
      bot_difficulty IS NULL
      OR bot_difficulty IN ('educational', 'realistic', 'expert')
    ),
  ADD COLUMN bot_seed bigint NULL
    CONSTRAINT room_members_bot_seed_uint32 CHECK (
      bot_seed IS NULL OR (bot_seed >= 0 AND bot_seed <= 4294967295)
    ),
  -- A human seat has no strategy configuration. The converse is deliberately NOT
  -- asserted: a bot row from before this migration legitimately has neither.
  ADD CONSTRAINT room_members_bot_config_requires_bot CHECK (
    is_bot OR (bot_difficulty IS NULL AND bot_seed IS NULL)
  );

COMMENT ON COLUMN prl.room_members.bot_difficulty IS
  'How far expressTraits scales this profile''s traits. NULL only on rows written before migration '
  '0003, which cannot be rehydrated.';
COMMENT ON COLUMN prl.room_members.bot_seed IS
  'The resolved uint32 seed the bot runner was given, so a rehydrated seat reproduces the same '
  'decision stream. Never seeds a deal — cards come from the CSPRNG. NULL only on pre-0003 rows.';

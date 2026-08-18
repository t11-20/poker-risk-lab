-- =============================================================================
-- 0002_indexes_and_constraints.sql - the query patterns, and the uniqueness
-- rules that need an index to exist at all.
--
-- 0001 describes the shape of the data. This file makes the shape queryable and
-- adds the three rules PostgreSQL can only enforce through a partial unique
-- index: one live member per seat, one live membership per user, and one applied
-- action per client action id.
--
-- ## Two things this file deliberately does not do
--
-- It does not create an index per column "just in case". Every index below has a
-- named query behind it, written next to it. An unused index is not free: it
-- slows every INSERT and UPDATE on a table that this app writes to on every
-- single player action, and it makes the planner's job harder rather than
-- easier.
--
-- It does not create a descending twin of an ascending index. A B-tree scans
-- backwards just as cheaply, so (room_id, hand_number) already serves
-- `ORDER BY hand_number DESC LIMIT 1`. Column *order* within an index is what
-- matters, and direction only matters when a query mixes ASC and DESC across
-- columns - which none of these do.
--
-- Indexes here are created without CONCURRENTLY on purpose: the migration runner
-- wraps each file in a transaction, and CREATE INDEX CONCURRENTLY cannot run in
-- one. On a fresh or small database that is the right trade. The day a table here
-- is large enough for an exclusive build to matter, its index belongs in its own
-- migration file that the runner is told not to wrap - which is a decision worth
-- making explicitly rather than inheriting from this file.
-- =============================================================================

SET ROLE prl_migrator;

-- -----------------------------------------------------------------------------
-- users
-- -----------------------------------------------------------------------------

-- Authentication lookup: "is there already an account for this issuer+subject?"
--
-- Partial rather than a plain UNIQUE constraint for two reasons. It keeps the
-- index to federated accounts only, so the guest majority costs nothing. And it
-- states the intent: the pair identifies a user, a subject alone does not, and
-- guests (both columns NULL) are outside the rule entirely. PostgreSQL's default
-- NULLS DISTINCT would already permit many all-NULL rows, but relying on that
-- reads as an accident. NULLS NOT DISTINCT would be actively wrong here: it would
-- allow exactly one guest in the whole table.
CREATE UNIQUE INDEX users_oidc_identity_key
  ON prl.users (oidc_issuer, oidc_subject)
  WHERE oidc_issuer IS NOT NULL AND oidc_subject IS NOT NULL;

-- Guest reaping: "which guest accounts have not been seen since <cutoff>?"
CREATE INDEX users_guest_last_seen_idx
  ON prl.users (last_seen_at)
  WHERE kind = 'guest';

-- -----------------------------------------------------------------------------
-- sessions
-- -----------------------------------------------------------------------------

-- The hot path: every authenticated request resolves sha256(cookie token) to a
-- session. Unique because two sessions sharing a token hash would make
-- authentication ambiguous, and the digest of a fresh random token colliding
-- means the token generator is broken and should fail loudly.
CREATE UNIQUE INDEX sessions_token_hash_key
  ON prl.sessions (token_hash);

-- "Show me my sessions" and "revoke every session for this user".
CREATE INDEX sessions_user_id_idx
  ON prl.sessions (user_id);

-- The expiry sweep. Partial on the live rows so the index shrinks as sessions
-- are revoked, and ordered by expires_at so the sweep reads only what it deletes.
CREATE INDEX sessions_expiry_sweep_idx
  ON prl.sessions (expires_at)
  WHERE revoked_at IS NULL;

-- -----------------------------------------------------------------------------
-- oidc_login_attempts
-- -----------------------------------------------------------------------------

-- The callback looks the attempt up by state digest. Unique across all rows,
-- including consumed ones: if it were partial on `consumed_at IS NULL`, a
-- replayed state could be inserted again the moment the original was consumed,
-- which is the replay this table exists to prevent.
CREATE UNIQUE INDEX oidc_login_attempts_state_hash_key
  ON prl.oidc_login_attempts (state_hash);

-- Sweep of attempts that were never completed.
CREATE INDEX oidc_login_attempts_expiry_sweep_idx
  ON prl.oidc_login_attempts (expires_at)
  WHERE consumed_at IS NULL;

-- -----------------------------------------------------------------------------
-- rooms
-- -----------------------------------------------------------------------------

-- Joining by invite code: the client sends the code, the server hashes it and
-- looks it up here. Unique so a code can never resolve to two rooms; a collision
-- must make the code generator retry, never pick a winner.
CREATE UNIQUE INDEX rooms_invite_code_hash_key
  ON prl.rooms (invite_code_hash);

-- "Rooms I own", and the ON DELETE RESTRICT check on prl.users.
CREATE INDEX rooms_owner_user_id_idx
  ON prl.rooms (owner_user_id);

-- Housekeeping: rooms still open, oldest first, for idle-room cleanup.
CREATE INDEX rooms_live_created_at_idx
  ON prl.rooms (created_at)
  WHERE status <> 'closed';

-- -----------------------------------------------------------------------------
-- room_members
-- -----------------------------------------------------------------------------

-- Seat occupancy. Two seated players in seat 3 is not a display bug: the engine
-- would deal to a seat list containing the same index twice, and no amount of
-- application locking is a substitute for the database refusing.
--
-- Partial on `left_at IS NULL` so that the history of who sat where is kept: the
-- same seat can be occupied by many people over a room's life, just never by two
-- at once. A live member with seat NULL is waiting rather than seated, and
-- NULLS DISTINCT is what lets several of those coexist.
CREATE UNIQUE INDEX room_members_live_seat_key
  ON prl.room_members (room_id, seat)
  WHERE left_at IS NULL;

-- One live membership per user per room, so a double-tapped "join" cannot seat
-- the same learner twice and let them act out of two seats.
CREATE UNIQUE INDEX room_members_live_user_key
  ON prl.room_members (room_id, user_id)
  WHERE left_at IS NULL;

-- "Which rooms am I currently in?", and the ON DELETE RESTRICT check on
-- prl.users.
--
-- Not partial on `left_at IS NULL`, which it was worth being deliberate about.
-- The obvious version of this index covers only live memberships, and it would
-- serve the query above slightly better - but the foreign key needs to find
-- *every* row referencing a user, departed ones included, and a partial index
-- cannot answer that. Without a full index, deleting a learner (a right the
-- grant matrix at the bottom of 0001 explicitly gives them) sequentially scans
-- every membership row this room ever had. Every other user-referencing key in
-- this schema has a covering index; this one is not the exception.
--
-- The cost of dropping the predicate is that "rooms I'm in" reads a handful of
-- extra index entries per learner and filters them, which is nothing, against
-- one index on the table instead of two on every write.
CREATE INDEX room_members_user_id_idx
  ON prl.room_members (user_id);

-- The full roster of a room, including seats that have left, for history views.
CREATE INDEX room_members_room_id_idx
  ON prl.room_members (room_id);

-- -----------------------------------------------------------------------------
-- hands
-- -----------------------------------------------------------------------------

-- Hand numbering within a room. Unique because "hand 12" must name one hand
-- forever, and because it is what makes `max(hand_number) + 1` a safe way to
-- number the next deal: a concurrent second deal fails on this index instead of
-- creating a duplicate.
--
-- This index also serves hand history paging in both directions, including
-- `WHERE room_id = $1 ORDER BY hand_number DESC LIMIT n` via a backward scan, so
-- there is no separate descending index.
CREATE UNIQUE INDEX hands_room_hand_number_key
  ON prl.hands (room_id, hand_number);

-- "Is there a hand in progress in this room?" - one row at most, and the partial
-- predicate keeps the index tiny however long the history grows.
CREATE INDEX hands_live_by_room_idx
  ON prl.hands (room_id)
  WHERE completed_at IS NULL;

-- -----------------------------------------------------------------------------
-- hand_seats
-- -----------------------------------------------------------------------------

-- One row per seat per hand. Also the lookup for "my cards in this hand", which
-- is the read that must always carry the hole_cards predicate described on
-- prl.hand_seats.hole_cards.
CREATE UNIQUE INDEX hand_seats_hand_seat_key
  ON prl.hand_seats (hand_id, seat);

-- A learner's own hand history, newest hands first via the join to prl.hands.
-- Partial because seats whose user was deleted are detached, not deleted, and
-- nobody queries for them.
CREATE INDEX hand_seats_user_id_idx
  ON prl.hand_seats (user_id)
  WHERE user_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- hand_actions
-- -----------------------------------------------------------------------------

-- Replaying a hand: every action for a hand, in order. `sequence` second means
-- one index serves both "all actions for this hand, ordered" and "the action at
-- this sequence", and unique means the engine's monotonic actionSequence cannot
-- be written twice.
CREATE UNIQUE INDEX hand_actions_hand_sequence_key
  ON prl.hand_actions (hand_id, sequence);

-- ###########################################################################
-- # The database-level idempotency guarantee.                               #
-- ###########################################################################
--
-- A client generates an action_id per decision and reuses it on every retry.
-- This partial unique index means a retried action can never be applied twice,
-- even when two requests carrying the same action_id arrive concurrently on
-- different connections: both may pass every application-level check, and the
-- second INSERT still fails on a unique violation, which the repository layer
-- translates into "already applied, here is the current state".
--
-- Why that matters more here than in most CRUD: a duplicated "raise to 400" is
-- not a duplicated row, it is chips that left a player's stack twice. No
-- application-level check-then-insert can close that window, because the check
-- and the insert are two statements and the race lives between them. This index
-- closes it in one.
--
-- Partial on `action_id IS NOT NULL` because server-generated actions - the
-- automatic check-or-fold when a timer expires - have no client id, and there may
-- be many of them in one hand.
CREATE UNIQUE INDEX hand_actions_client_action_id_key
  ON prl.hand_actions (hand_id, action_id)
  WHERE action_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- Learning progress
-- -----------------------------------------------------------------------------

-- One progress row per learner per lesson. This index is also what makes the
-- write an upsert: `INSERT ... ON CONFLICT (user_id, lesson_id) DO UPDATE SET
-- last_viewed_at = ...` needs exactly this unique index to have a conflict
-- target, so opening a lesson twice updates rather than duplicating.
CREATE UNIQUE INDEX lesson_progress_user_lesson_key
  ON prl.lesson_progress (user_id, lesson_id);

-- "Pick up where I left off."
CREATE INDEX lesson_progress_recent_idx
  ON prl.lesson_progress (user_id, last_viewed_at);

-- A learner reviewing their own attempts at one quiz, most recent last.
CREATE INDEX quiz_attempts_user_quiz_idx
  ON prl.quiz_attempts (user_id, quiz_id, created_at);

-- "Have I tried this question before, and what did I say?"
CREATE INDEX quiz_attempts_user_question_idx
  ON prl.quiz_attempts (user_id, question_id, created_at);

-- A learner's history on one Scenario Lab spot.
CREATE INDEX scenario_attempts_user_scenario_idx
  ON prl.scenario_attempts (user_id, scenario_id, created_at);

-- -----------------------------------------------------------------------------
-- audit_log
-- -----------------------------------------------------------------------------

-- Reading the log during an incident: by time, by event type over time, and by
-- the account involved. The user index is partial because a large share of
-- security events (rejected logins, unknown invite codes) have no account.
CREATE INDEX audit_log_created_at_idx
  ON prl.audit_log (created_at);

CREATE INDEX audit_log_event_created_at_idx
  ON prl.audit_log (event, created_at);

CREATE INDEX audit_log_user_created_at_idx
  ON prl.audit_log (user_id, created_at)
  WHERE user_id IS NOT NULL;

-- =============================================================================
-- Constraints that finish the rules above.
--
-- Each of these is the half of a rule that an index cannot express. They sit here
-- rather than in 0001 so that both halves of one rule - the index and the check -
-- can be read together instead of six hundred lines apart.
-- =============================================================================

-- Finishes the showdown rule. `showed_down` is the flag that opens hole_cards to
-- every player at the table (see the read rule on prl.hand_seats.hole_cards), so
-- a seat cannot claim to have shown cards it has no record of holding - the
-- reveal proofs on prl.hands would have nothing to prove against.
ALTER TABLE prl.hand_seats
  ADD CONSTRAINT hand_seats_showdown_requires_hole_cards
  CHECK (NOT showed_down OR hole_cards IS NOT NULL);

-- Finishes the idempotency rule. 0001 already requires 8-64 characters,
-- so an empty id is impossible; this rejects a padded one. "abc12345" and
-- "abc12345 " are two index entries but one decision, and a retry whose id
-- picked up whitespace somewhere in transport would be applied a second time.
ALTER TABLE prl.hand_actions
  ADD CONSTRAINT hand_actions_action_id_not_blank
  CHECK (action_id IS NULL OR btrim(action_id) = action_id);

RESET ROLE;

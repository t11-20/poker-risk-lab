-- =============================================================================
-- 0004_account_deletion.sql - making it possible for a learner to leave.
--
-- ## What was wrong
--
-- There was no way to delete an account. Not a missing route: a schema that
-- refuses. Eight foreign keys reference `prl.users`, and two of them are
-- `ON DELETE RESTRICT` - `prl.rooms.owner_user_id` and `prl.room_members.user_id`.
-- So `DELETE FROM prl.users` succeeded for exactly one kind of learner: one who
-- had never created a table and never sat at one. Every learner who had actually
-- used the product was undeletable, and the failure arrived as a raw 23503 that
-- nothing mapped.
--
-- `room_members` was the worse of the two, because a foreign key has no
-- predicate: a membership the learner ended months ago (`left_at` set) restricts
-- exactly as hard as one they are sitting in right now.
--
-- ## The policy this file implements, in one paragraph
--
-- The learner's own record goes. Everything that is a record of somebody ELSE's
-- play survives, with the learner's identity detached from it. Concretely:
--
--   DELETED       sessions, lesson_progress, quiz_attempts, scenario_attempts
--                 (all already ON DELETE CASCADE), and room_members - the
--                 learner's seats at every table, live or departed.
--   ANONYMISED    hand_seats.user_id and audit_log.user_id, both already
--                 ON DELETE SET NULL; and, as of this file, rooms.owner_user_id.
--                 The hand, its actions, its board, its commitment root and its
--                 reveal proofs are untouched. The seat stops naming anybody.
--   RETAINED      every hand, in full, including hands the departing learner
--                 played. A hand is a shared record: four other people were in
--                 it, it is in their history, and deleting it would edit theirs.
--   TOLD          the learner is told exactly this, in as many words, before
--                 they confirm - see `apps/web/src/app/record/DeleteAccount.tsx`
--                 and the doc comment on `POST /me/delete` in
--                 `apps/api/src/routes/auth.ts`.
--
-- This is a statement about engineering behaviour. It is not a legal conclusion
-- and nothing here should be read as one.
--
-- ## Why rooms.owner_user_id becomes SET NULL rather than CASCADE or RESTRICT
--
-- CASCADE is the one option that is definitely wrong. `prl.hands` references
-- `prl.rooms` ON DELETE CASCADE, so cascading a room would delete every hand
-- played at it - which is precisely the other people's history this policy
-- exists to protect. The comment on the column in 0001 says the same thing:
-- "a room holds other learners' hand history, so removing the owner must be an
-- explicit, ordered operation that decides what happens to that history".
--
-- Keeping RESTRICT and deleting the room instead would need `DELETE` on
-- `prl.rooms` for the runtime role, and that grant reaches further than it
-- looks: rooms cascade to hands, hands cascade to hand_actions, and
-- `prl.hand_actions` is one of the two genuinely append-only tables in this
-- schema (SELECT and INSERT only, deliberately - "a role that can edit the audit
-- log has no audit log"). Granting DELETE on rooms would hand the request path a
-- route to empty it. That is a bigger loss than the problem is worth, so the
-- grant is not made and the room is not deleted.
--
-- SET NULL is the shape the schema already uses for exactly this question.
-- `prl.hand_seats.user_id` has been SET NULL since 0001, with the comment
-- "deleting an account must not delete the other seats' record of the hand. The
-- seat survives with its identity detached." A room is the same kind of object:
-- it survives, and it stops naming a creator. `DROP NOT NULL` is what makes that
-- expressible.
--
-- The cost, stated plainly: a room can now exist with no owner, and nothing in
-- the product can transfer ownership of it. The deletion path therefore CLOSES
-- every room it detaches, in the same transaction, so an ownerless table cannot
-- be joined, re-opened after a restart, or left waiting for an owner who no
-- longer exists to close it.
--
-- ## Why room_members.user_id becomes CASCADE
--
-- A membership row is a record of one learner and nothing else: which chair they
-- took, how many units are in front of them, when they joined and when they
-- left. Nobody else's history is in it - the hands are in `prl.hands` and
-- `prl.hand_seats`, which are untouched by this. So it goes with the account.
--
-- CASCADE rather than an explicit DELETE in the repository, and that is a
-- least-privilege decision rather than a stylistic one. A referential action is
-- executed by the constraint's owner, not by the connected role: measured on
-- this schema on 2026-08-22, `prl_app` - which holds no DELETE on
-- `prl.quiz_attempts` - deleted a user row and the dependent attempt rows went
-- with it. So CASCADE lets the account deletion remove memberships WITHOUT
-- granting `prl_app` DELETE on `prl.room_members`, which would also have let it
-- remove any other learner's seat at any time. The narrower capability is the
-- one that is wanted: the request path can remove a membership only by removing
-- the whole account that owns it.
--
-- ## Grants
--
-- None are added or removed, and that is a finding rather than an omission.
-- `prl.users` already carries `DELETE` for `prl_app` - 0001's own grant matrix
-- says why, in as many words: "sign-up, rename, guest sweep, and a learner's
-- right to delete". Everything else this policy touches happens through a
-- referential action, which runs with the constraint owner's privileges. The
-- measurements are in the paragraph above and in `apps/api/scripts/verify-schema.mjs`
-- check 9, which now asserts the referential actions themselves.
--
-- ## Deployment ordering (docs/RUNBOOK.md section 11.3)
--
-- The two-release rule applies to `rooms.owner_user_id` and is satisfied by the
-- ordering the RUNBOOK already mandates - migrate, then roll the API:
--
--   1. This migration widens what the column may hold. It writes no NULL and
--      changes no row, so the API image still serving while it runs sees exactly
--      the data it saw before and keeps working.
--   2. `POST /me/delete` arrives with the API image rolled afterwards, and it is
--      the only thing in the product that can put a NULL there. There is
--      therefore no moment at which a build that cannot read a NULL owner is
--      running against a database that contains one.
--
-- Rolling the API back after step 2 is also safe in the direction that matters:
-- the previous build reads `owner_user_id` in three places and all three treat a
-- non-matching owner as "not yours", which is the correct answer for a room
-- whose owner has gone.
--
-- The FK swap is not additive and cannot be, which is what the marker below is
-- for. It is not split across two releases because there is no intermediate
-- state to ship: the runner applies each file in one transaction, so the
-- constraint is replaced rather than absent, and no window exists in which a row
-- could be written that the new constraint would reject.
--
-- Both `ALTER TABLE`s take an ACCESS EXCLUSIVE lock and the re-added foreign
-- keys are validated against existing rows - an index scan on
-- `rooms_owner_user_id_idx` and `room_members_user_id_idx`, both of which have
-- existed since 0002. `NOT VALID` was considered and rejected: the data is
-- already valid by construction (the old constraints were enforcing the same
-- reference), so skipping validation would buy nothing and leave a constraint
-- the planner cannot rely on.
--
-- prl:irreversible: the two RESTRICT foreign keys on prl.rooms.owner_user_id and
-- prl.room_members.user_id are dropped and re-added with different referential
-- actions, and prl.rooms.owner_user_id loses its NOT NULL. No row is read,
-- rewritten or removed by this file, so nothing is lost from the DATA - what
-- cannot be rolled forward past is the CONSTRAINT: once an account deletion has
-- run, the rooms it detached hold NULL owners and the memberships it removed are
-- gone, so re-imposing NOT NULL or RESTRICT is no longer possible without
-- inventing an owner or restoring a backup.
-- =============================================================================

SET ROLE prl_migrator;

-- -----------------------------------------------------------------------------
-- 1. rooms.owner_user_id - a table that outlives its creator.
--
-- The NOT NULL is dropped FIRST. `ON DELETE SET NULL` against a NOT NULL column
-- is accepted by `ALTER TABLE` and then fails at run time, on the delete, with a
-- not-null violation - which would turn this whole change into a defect that
-- only appears the first time a learner who owns a table tries to leave.
-- -----------------------------------------------------------------------------
ALTER TABLE prl.rooms
  ALTER COLUMN owner_user_id DROP NOT NULL;

ALTER TABLE prl.rooms
  DROP CONSTRAINT rooms_owner_user_id_fkey;

-- Re-added under its own name rather than letting PostgreSQL generate one. The
-- name is what `VIOLATION_CODES` in apps/api/src/repositories/sql.ts maps to
-- `account_deletion_blocked`, so a database on which this migration has NOT been
-- applied answers a deletion attempt with a truthful 409 instead of a 500.
ALTER TABLE prl.rooms
  ADD CONSTRAINT rooms_owner_user_id_fkey
  FOREIGN KEY (owner_user_id) REFERENCES prl.users (id) ON DELETE SET NULL;

COMMENT ON COLUMN prl.rooms.owner_user_id IS
  'The learner who created this table, or NULL once that account has been erased. NULL is not an '
  'anonymous owner and confers nothing: no session ever matches it, so a detached room cannot be '
  'closed or administered by anybody. The account deletion path closes every room it detaches, in '
  'the same transaction, which is what stops one being left open with no owner to close it.';

-- -----------------------------------------------------------------------------
-- 2. room_members.user_id - a seat belongs to the learner in it.
--
-- The foreign key carries no predicate and cannot: a departed membership
-- (`left_at` set) restricted a delete exactly as hard as a live one, which is
-- why a learner who had ever sat at a table could not be removed even after
-- leaving it.
-- -----------------------------------------------------------------------------
ALTER TABLE prl.room_members
  DROP CONSTRAINT room_members_user_id_fkey;

ALTER TABLE prl.room_members
  ADD CONSTRAINT room_members_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES prl.users (id) ON DELETE CASCADE;

COMMENT ON COLUMN prl.room_members.user_id IS
  'The learner occupying this seat. ON DELETE CASCADE: a membership describes one learner and no '
  'other, so it goes when the account does. The room and every hand played at it survive - those '
  'live in prl.rooms, prl.hands and prl.hand_seats and are not touched by an account deletion.';

RESET ROLE;

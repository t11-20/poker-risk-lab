-- =============================================================================
-- 0008_room_members_first_seated.sql - recording that a membership has been sat
-- at, so a learner's units do not depend on whether a hand was dealt.
--
-- ## What was wrong
--
-- `users.readUnits` counts a membership's stack only if the learner has sat at
-- that table. That rule is what stops units growing by a stack for every room a
-- learner creates or joins: a membership is created holding the room's
-- `starting_stack` before anybody sits (`rooms.addMember`), and summing those
-- minted 1,000 per click (PR #25).
--
-- Nothing in the schema said "has sat at". The query approximated it with two
-- facts it could see - seated now, or dealt into a hand at that room since the
-- membership began - and the two leave a hole. Devin Review on PR #25: a learner
-- sits at a room whose starting stack is 5,000, stands before the first deal,
-- and reads the 1,000 allowance; sitting again gives them their 5,000. Standing
-- up before a deal leaves a row that is byte-for-byte a never-sat one (seat
-- NULL, stack = starting_stack, no hand), so no predicate over the existing
-- columns can tell them apart. This column is the fact the rule needed.
--
-- ## What it is
--
-- The first time THIS membership took a seat. Written once by `rooms.recordFirstSit`
-- (`coalesce(first_seated_at, now())`), which the registry calls only after the
-- live table has accepted the sit, so a sit the table refuses is never recorded
-- (Devin Review on #25). Never cleared: standing up, being
-- busted and resetting all leave it as it is. Per row, so a learner who leaves
-- and rejoins gets a new membership with no first sit - the boundary the
-- dealt-in evidence has to draw by hand with `hands.started_at >= joined_at`.
--
-- A timestamp and not a boolean because the instant is free and a boolean
-- would have to be re-derived the first time anybody asked "when". It is not an
-- amount and holds nothing a learner could spend.
--
-- ## No backfill, and why the old evidence still counts
--
-- `readUnits` counts a membership when this is set OR by the evidence the old
-- rule used (seated now, or dealt in since joining). The RUNBOOK's order is
-- migrate, then roll the API, so between the two the previous build is still
-- seating learners without writing this column; a row it seated must keep
-- counting under the new build. The union also covers every row written before
-- this file, so there is nothing to backfill, and this migration changes no
-- existing value: it adds a NULL column and a CHECK every NULL satisfies.
-- =============================================================================

ALTER TABLE prl.room_members
  ADD COLUMN first_seated_at timestamptz NULL,
  ADD CONSTRAINT room_members_first_seated_after_joined
    CHECK (first_seated_at IS NULL OR first_seated_at >= joined_at);

COMMENT ON COLUMN prl.room_members.first_seated_at IS
  'When this membership first took a seat; NULL until it has. Never cleared. Once set, the '
  'membership counts toward the learner''s units (apps/api/src/repositories/users.ts readUnits).';

-- =============================================================================
-- 0005_room_ownership.sql - making "one API process per room" an ENFORCED
-- invariant instead of a documented one.
--
-- ## What was wrong
--
-- `apps/api/src/rooms/registry.ts` holds the authoritative state of a hand in
-- progress - the deck, the commitment salts, the pot, whose turn it is - in
-- process memory, and it says so in its header. `docker-compose.staging.yml`
-- repeats it beside `deploy.replicas: 1`: "two API processes serving one room
-- deal two different hands", a correctness constraint rather than a sizing
-- choice.
--
-- Nothing enforced it. Not one line of code anywhere refused a second process
-- that opened the same room. The constraint lived in two comments and a compose
-- key, and every one of the following silently violated it:
--
--   * an operator scaling to `replicas: 2` for capacity, reading the number as a
--     sizing knob because that is what `replicas` means everywhere else;
--   * ANY rolling deploy - the new container is healthy and serving before the
--     old one has finished draining, and both hold the same rooms for those few
--     seconds;
--   * a restart where the supervisor starts the replacement before the previous
--     process has exited;
--   * two operators each running a local API against the same database.
--
-- What that does is not a display glitch. Both processes deal from their own
-- deck, both settle their own pot, both write to `prl.hands`, and the seats hold
-- different cards in each. Whichever settlement lands second overwrites
-- `room_members.stack`, so the chips of everybody who won in the other process
-- are gone with no error anywhere. A learner sees a hand they did not play.
--
-- ## What this table is
--
-- A lease. One row per room, held by exactly one process at a time, renewed on a
-- timer, and taken over only when the current holder has stopped renewing for
-- longer than the lease TTL. The mechanism is the ordinary one - it is what
-- `kube-controller-manager` does with `coordination.k8s.io/Lease` and what etcd
-- and Consul sessions do - and it is written out here rather than imported
-- because the supply-chain policy (ADR 0007) is hostile to a new runtime
-- dependency and this is four statements.
--
--   room_id       the room the lease is over. CASCADE, because a lease over a
--                 deleted room is not a lease over anything. (Nothing deletes a
--                 room today - `prl_app` holds no DELETE on `prl.rooms` and
--                 closing is a status change - so this is the correct action for
--                 a path that does not yet exist rather than a live one.)
--   owner_id      WHICH PROCESS holds it. Minted once per process at boot; see
--                 `apps/api/src/rooms/ownership.ts`. Deliberately NOT a user id
--                 and deliberately not a foreign key: it names a process, and the
--                 processes that have held a lease are not a table.
--   fence         a monotonically increasing takeover counter, incremented on
--                 every acquisition INCLUDING a renewal-free re-acquire by the
--                 same owner. It is the standard fencing token: a holder can
--                 always tell whether the room has changed hands since it last
--                 looked, and any later change that wants to stamp a write with
--                 "the ownership generation that produced it" has the number to
--                 stamp. What it does NOT do today is stated plainly in
--                 `ownership.ts`: no hand row carries it, so the database will
--                 not refuse a write from a fenced process. The eviction path in
--                 the registry is what stops those writes, and it stops them in
--                 the process rather than at the row.
--   acquired_at   when this owner took it. Never touched by a renewal, so "how
--                 long has this process held this room" is readable.
--   heartbeat_at  when this owner last proved it was alive. This is the only
--                 column the takeover predicate reads, and it is written with
--                 the DATABASE's `now()` rather than a timestamp from the
--                 application: two processes with skewed clocks must compare
--                 liveness against one clock or the comparison means nothing.
--
-- ## Why there is no unique index on owner_id, and no attempt at one
--
-- One process legitimately holds many rooms. The invariant is per room - one
-- owner per ROOM - and that is exactly what `room_id PRIMARY KEY` says. A
-- constraint over `owner_id` would be a different and wrong statement.
--
-- ## Grants
--
-- `prl_app` gets SELECT, INSERT, UPDATE, DELETE, which is the widest verb set in
-- this schema and needs the argument 0001's grant matrix demands.
--
-- DELETE is the one that has to be justified, because 0001 refuses it on
-- `prl.rooms`, `prl.hands` and `prl.hand_seats` with the reasoning that those
-- rows are HISTORY - "closing a room is a status change, and its hands are
-- history", "a role that can edit the audit log has no audit log". None of that
-- applies here. A lease row is not a record of anything that happened; it is a
-- statement about the present that stops being true the moment the holder lets
-- go. Releasing a lease by deleting the row is what makes a graceful shutdown
-- hand the room over IMMEDIATELY instead of stranding it for a whole TTL, and
-- that is the single biggest practical benefit of this table: a rolling deploy
-- becomes seamless rather than a lease-TTL-long refusal.
--
-- What the grant is worth to an attacker who reaches it through an injection is
-- bounded and worth stating: they can steal or drop leases, which causes the
-- owning process to evict rooms - a denial of service on live tables that
-- self-heals on the next open. They cannot use it to read a card, move a chip or
-- edit a hand, because the table holds none of those. Given that the alternative
-- (no DELETE, release by expiry only) makes every deploy strand every live room
-- for the TTL, the trade is clearly the right way round.
--
-- INSERT and UPDATE are both needed because acquisition is one `INSERT ... ON
-- CONFLICT DO UPDATE`; SELECT because `ON CONFLICT ... WHERE` and `RETURNING`
-- are read by the same statement and because the runbook has to be able to look.
--
-- ## Deployment ordering (docs/RUNBOOK.md section 11.3)
--
-- Purely additive: one new table, no column changed, no constraint altered, no
-- row rewritten. An API image that predates this file runs against a database
-- that has it and behaves exactly as it did, because nothing it runs mentions
-- the table. An API image that postdates it, running against a database WITHOUT
-- it, fails every room open with an undefined-table error - which is the correct
-- direction for this particular change (refusing to serve is the safe failure for
-- a guard whose absence means silent chip loss) but is still a reason to keep the
-- documented order: migrate, then roll the API.
--
-- No `prl:irreversible` marker, and that is a claim rather than an omission.
-- This file creates one table and grants on it, reads no row, rewrites no row and
-- drops nothing. Everything it adds is ephemeral by construction - the rows are
-- leases, and a lease nobody renews is meaningless within a TTL - so `DROP TABLE
-- prl.room_ownership` would lose no fact about the product. The migration runner
-- still refuses `down`; this note is here so that a person reading the file knows
-- the refusal is policy and not a property of what is written below.
-- =============================================================================

SET ROLE prl_migrator;

CREATE TABLE prl.room_ownership (
  room_id       prl.prefixed_id PRIMARY KEY
                  REFERENCES prl.rooms (id) ON DELETE CASCADE,

  -- Bounded so that a caller cannot write an unbounded blob into a column the
  -- runbook prints, and shaped so an owner id is recognisably one. The generator
  -- in `apps/api/src/rooms/ownership.ts` produces `api_<hostname-ish>_<random>`;
  -- the CHECK is deliberately looser than that so a future generator does not
  -- need a migration, and deliberately not open, so a blank or whitespace owner -
  -- which would compare equal to another blank owner and break the whole
  -- ownership comparison - cannot be stored at all.
  owner_id      text NOT NULL
                  CONSTRAINT room_ownership_owner_id_shape CHECK (
                    char_length(owner_id) BETWEEN 8 AND 128
                    AND owner_id = btrim(owner_id)
                  ),

  -- bigint rather than int: it increments on every takeover for the life of the
  -- room, and a counter that can wrap is a fencing token that can go backwards.
  fence         bigint NOT NULL
                  CONSTRAINT room_ownership_fence_positive CHECK (fence > 0),

  acquired_at   timestamptz NOT NULL DEFAULT now(),
  heartbeat_at  timestamptz NOT NULL DEFAULT now(),

  -- A heartbeat that predates the acquisition is not a clock skew this table can
  -- absorb, it is a statement that the row was written by something that is not
  -- the acquire/renew pair below. Both are written with the database's `now()`,
  -- so on a healthy path this cannot fire.
  CONSTRAINT room_ownership_heartbeat_after_acquire CHECK (heartbeat_at >= acquired_at)
);

COMMENT ON TABLE prl.room_ownership IS
  'One lease per room: which API process is authoritative for that room''s in-flight hand state. '
  'Not history - a row is a statement about the present, and the release path deletes it. See '
  'apps/api/src/rooms/ownership.ts for the TTL, the heartbeat interval and the ratio between them.';

COMMENT ON COLUMN prl.room_ownership.owner_id IS
  'The API PROCESS holding this room, minted once at boot. Not a user id and not a foreign key: it '
  'names a process, and processes are not a table here.';
COMMENT ON COLUMN prl.room_ownership.fence IS
  'Takeover counter, incremented on every acquisition. Monotonic per room, so a holder can tell '
  'whether the room changed hands since it last looked. No hand row carries it today.';
COMMENT ON COLUMN prl.room_ownership.acquired_at IS
  'When the CURRENT owner took the lease. Untouched by renewals, so the holding time is readable.';
COMMENT ON COLUMN prl.room_ownership.heartbeat_at IS
  'When the current owner last proved it was alive, written with the database''s now(). The only '
  'column the takeover predicate reads: two processes with skewed clocks have to compare liveness '
  'against one clock.';

-- -----------------------------------------------------------------------------
-- The one index that is not the primary key.
--
-- `room_id` is already unique and is how every acquire, renew and release finds
-- its row, so nothing on the request path needs this. What needs it is the
-- operator question the runbook asks first - "which leases are stale right now?"
-- - which is a range scan over `heartbeat_at` across every room. That is a
-- sequential scan of a table with one row per live room, so this index buys
-- little today and costs one B-tree entry per room; it exists so that the answer
-- does not get slower in the shape that makes it matter (many rooms, one of them
-- wrong) and so the query in the runbook is the one that will still be right.
-- -----------------------------------------------------------------------------
CREATE INDEX room_ownership_heartbeat_at_idx ON prl.room_ownership (heartbeat_at);

-- -----------------------------------------------------------------------------
-- Least privilege. The argument for DELETE is in the header.
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON prl.room_ownership TO prl_app;

RESET ROLE;

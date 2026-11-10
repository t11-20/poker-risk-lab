-- =============================================================================
-- 0007_audit_forbidden_keys.sql - widening the audit log's forbidden-key CHECK
-- to the names this codebase actually uses for a card.
--
-- ## What was wrong
--
-- `audit_log_detail_has_no_forbidden_keys` (0001) refuses fourteen top-level
-- keys, and its list was written in the spelling the API used at the time:
-- `holeCards`, `deck`, `salt`, `salts`. The check is `?|`, which is BYTE-EXACT.
--
-- A hidden-information sweep on 2026-08-27 measured what that list actually
-- covers. `hole_cards` - the column name in `prl.hand_seats`, and the spelling
-- anybody writing SQL reaches for first - passes it. So do `cards`, `board` and
-- `reveal`. So do `deckSalts`, `deckCursor`, `holeCardPositions` and
-- `boardPositions`, which are the four fields `packages/poker-engine/src/types.ts`
-- calls "the hand's secrets" and the exact names on a live `HandState`.
--
-- The same sweep found the app-layer log scrub in `apps/api/src/logging.ts`
-- censoring `deck` while passing `deckSalts` through byte for byte, for exactly
-- the same reason: an exact-match list written against names nobody uses. That
-- one was a live leak and is fixed. This one is a backstop that was narrower
-- than it looked, and no call site has ever carried one of these keys - measured
-- on the development database, 3,102 audit rows, 49 with a detail object, and
-- the distinct keys in use are: by, cohortId, cohortKey, enrolmentId, expiresAt,
-- handId, issuer, kind, maxSeats, reason, reference, refusal, roomId, startsAt,
-- supersededId, visibility. Zero would violate the wider list.
--
-- ## Why the audit log is the wrong place for any of them
--
-- `prl.audit_log` is append-only, is never swept - `docs/production/legal-register.md`
-- says its rows survive an account deletion with `user_id` set to NULL and that
-- nothing ever removes them - and is readable by `prl_app`. A card written here
-- is a card kept for ever, detached from the person it belonged to but still
-- joinable to a hand id sitting in the same row. There is no audit question that
-- needs one.
--
-- ## A SECOND constraint, not a rewritten one - and the runner is why
--
-- The first draft of this file did `DROP CONSTRAINT` then `ADD CONSTRAINT` with
-- a wider list, and `apps/api/scripts/migrate.mjs` refused it: a drop needs a
-- `prl:irreversible` marker because roll-forward-only means nothing can put it
-- back but a restore. The runner was right and the draft's claim that it was
-- "purely additive" was wrong - between the DROP and the ADD there is a moment
-- with no constraint at all, and an ADD that failed would leave the table with
-- less protection than it started with.
--
-- So 0001's constraint is left exactly as it is and this adds a second one
-- beside it. Both are enforced; a key in either is refused. Nothing is dropped,
-- nothing is irreversible, and the guarantee only grows.
--
-- ## NOT VALID, deliberately, and this is the safe direction
--
-- The constraint is added `NOT VALID`: PostgreSQL enforces it on every INSERT
-- and UPDATE from this moment, and does NOT scan the existing table.
--
-- A validating ADD would have to read every row, and on a deployment that did
-- hold a violating row it would ABORT THE MIGRATION - which, with roll-forward
-- only migrations, means that deployment cannot deploy anything at all until
-- somebody edits history in an append-only table. The forward guarantee is what
-- matters here and `NOT VALID` gives it in full. Auditing history is a separate
-- question with a separate answer, and `docs/production/legal-register.md` §2.10
-- carries the query.
--
-- ## The app layer moves with it
--
-- `AUDIT_FORBIDDEN_KEYS` in `apps/api/src/repositories/audit.ts` is a lower-cased
-- copy of this list, and it refuses a write before it reaches the database.
-- Until today the copy was paired with this CHECK by a comment claiming a test
-- held them together - and that test did not exist, so the two could drift in
-- silence. `apps/api/test/audit-forbidden-keys.test.ts` now reads
-- `pg_get_constraintdef` off the live database and holds the app's set to what
-- PostgreSQL actually enforces, which survives any number of migrations
-- redefining this constraint.
--
-- ## Deployment ordering
--
-- Purely additive to the guarantees: no column changes, no row is rewritten, no
-- existing row is read. An API image that predates this file writes exactly what
-- it wrote before, because no call site uses any of the new names. An API image
-- that postdates it against a database without it is also fine - the app-layer
-- set refuses these keys first.
--
-- No `prl:irreversible` marker, and this time the claim is true: one CHECK
-- constraint is ADDED, nothing is dropped, no column changes and no row is read
-- or rewritten.
-- =============================================================================

SET ROLE prl_migrator;

ALTER TABLE prl.audit_log
  ADD CONSTRAINT audit_log_detail_has_no_card_keys CHECK (
    detail IS NULL
    OR NOT (detail ?| array[
      -- The card itself, in every spelling this repository uses. `hole_cards` is
      -- the column name in `prl.hand_seats`; the rest are the fields on a live
      -- `HandState` that `poker-engine`'s types.ts calls the hand's secrets.
      'holeCard', 'hole_cards', 'hole_card', 'cards',
      'holeCardPositions', 'hole_card_positions',
      -- The board is public once dealt and is still not an audit fact, and
      -- `boardPositions` names deck indices rather than cards.
      'board', 'boardPositions', 'board_positions',
      -- The commitment secrets. `deck`, `salt` and `salts` are already refused
      -- by 0001's constraint; these are the ones that travel with them and that
      -- its list did not name.
      'deckSalts', 'deck_salts', 'deckCursor', 'deck_cursor',
      'deckOrder', 'deck_order',
      -- A whole reveal, which carries every salt and every position at once.
      'reveal'
    ])
  ) NOT VALID;

COMMENT ON CONSTRAINT audit_log_detail_has_no_card_keys ON prl.audit_log IS
  'Byte-exact top-level key refusal, beside audit_log_detail_has_no_forbidden_keys rather than '
  'replacing it: the spellings this codebase actually uses for a card and for the deck secrets. '
  'NOT VALID, so it binds every future write and does not scan history. The lower-cased mirror of '
  'both lists is AUDIT_FORBIDDEN_KEYS in repositories/audit.ts, held to them by '
  'apps/api/test/audit-forbidden-keys.test.ts.';

RESET ROLE;

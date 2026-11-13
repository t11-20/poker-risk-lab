-- =============================================================================
-- 0009_hand_actions_automatic_reason.sql - recording WHY the server made a
-- decision for a seat, so the hand review can say so instead of guessing.
--
-- ## What was wrong
--
-- `hand_actions.was_automatic` (0001) is true for every action nobody
-- submitted, and its column comment says that means a timer expired. There
-- are two such actions in `apps/api/src/rooms/table.ts`, and only one of them
-- is a timer: `applyTimeout` checks-or-folds for a seat whose clock ran out,
-- and `runAutomaticActions` folds for a player who has ALREADY stood up, left
-- the room or started another practice table while still holding cards here.
-- Both wrote the same `true`, so the hand review (`HandReplay.tsx`) printed
-- "The clock ran out and the server acted" beside a fold the reader had asked
-- for by pressing "Stand up". The live table had already stopped saying that,
-- because it can see the `seatTimedOut` event that precedes a timeout; the
-- review reads these rows back later and had nothing to tell the two apart.
-- No predicate over the existing columns can: both are a fold, `action_id`
-- NULL, `amount_paid` 0.
--
-- ## What it is
--
-- `automatic_reason`: 'timeout' or 'departed', written with the row by
-- `handsRepository.appendAction` from the reason the live table applied the
-- action for. The value list is `AUTOMATIC_REASONS` in
-- `packages/contracts/src/api-types.ts`; `apps/api/test/repositories.test.ts`
-- writes every value in it through this CHECK and has one refused, so the two
-- cannot drift apart unnoticed.
--
-- Not an amount and nothing a learner could spend: it says who decided, and
-- why, about a decision already in the log.
--
-- ## No backfill, and NULL on an automatic row is a meaning, not a gap
--
-- Every automatic row written before this file is left NULL, deliberately.
-- Nothing recorded which path wrote it, so any value put there now would be
-- the same guess this column exists to stop. The RUNBOOK's order is migrate,
-- then roll the API, so the previous build also writes NULL here for a while.
-- A NULL on a row with `was_automatic` therefore reads "the server acted, and
-- the reason was not recorded", and the review says exactly that. The CHECKs
-- below admit every existing row: a NULL satisfies both, which is also why
-- this cannot require a reason on every automatic row.
--
-- The one thing it does refuse is a reason on a decision a person made, which
-- would be a contradiction in the log rather than a missing fact.
-- =============================================================================

ALTER TABLE prl.hand_actions
  ADD COLUMN automatic_reason text NULL,
  ADD CONSTRAINT hand_actions_automatic_reason_allowed
    CHECK (automatic_reason IS NULL OR automatic_reason IN ('timeout', 'departed')),
  ADD CONSTRAINT hand_actions_automatic_reason_only_if_automatic
    CHECK (automatic_reason IS NULL OR was_automatic);

COMMENT ON COLUMN prl.hand_actions.automatic_reason IS
  'Why the server acted, when was_automatic: timeout (the seat''s clock expired) or departed (the '
  'player had stood up or left while holding cards). NULL on a person''s own decision, and on an '
  'automatic row written before 0009, which recorded no reason.';

-- 0001's comment on `was_automatic` said a timer expired, which was never the
-- whole of it. 0001 is applied and checksummed by `migrate.mjs`, so editing it
-- would stop migrations on every deployment; the correction goes here.
COMMENT ON COLUMN prl.hand_actions.was_automatic IS
  'True when the server acted for a seat rather than its player: either the seat''s timer expired '
  '(check if legal, otherwise fold) or the player had already stood up holding cards (fold). '
  'automatic_reason says which, from 0009 on.';

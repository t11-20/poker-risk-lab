-- =============================================================================
-- 0006_cohort_enrolments.sql - somewhere to record that a person is entitled,
-- and on whose authority.
--
-- ## What was wrong
--
-- A compliance audit established, by exhaustive search, that this repository
-- held NO record of entitlement of any kind: no enrolment, no grant, no
-- expiry, no revocation, and nothing that named an authority. `prl.users.kind`
-- is `'guest'` or `'oidc'` and nothing else, there is no instructor concept and
-- no operator concept, and so a person who had been admitted to a taught cohort
-- and a person who had wandered in off the internet were, to every query this
-- system can run, the same person.
--
-- That is not a missing feature. It is the absence of the fact that every later
-- decision has to rest on. "Has this cohort member's access ended?" had no
-- answer, "who admitted them?" had no answer, and "was their access withdrawn,
-- when, and why?" had no answer - so an operator asked to withdraw access could
-- only do it by deleting the account, which under 0004 also detaches their name
-- from every hand four other people played.
--
-- ## What this file is NOT, stated first because it is the easier half to get
-- ## wrong
--
-- There is no amount column, no currency column, no processor, no receipt and
-- no refund arithmetic anywhere in this file, and adding one is a product
-- decision rather than a migration. 0001 opens by saying that this schema
-- deliberately contains "no balance, currency, price, purchase, payout, prize
-- or transfer column anywhere ... and no table that could serve as a ledger of
-- value", and that sentence is still true after this migration.
--
-- What an enrolment records is that somebody IS entitled and WHO SAID SO. The
-- `reference` column is the seam: it holds an opaque external string - a
-- purchase-order number, a row id in a finance system nobody here can read, a
-- registry entry, or the literal word `scholarship` - and this schema does not
-- know, and must never learn, which of those it is. Everything about what was
-- exchanged lives in whatever system produced that string.
--
-- ## prl.cohorts - an identified class
--
--   key         the stable handle an operator types: `spring-2026-risk-lab`.
--               Unique, lowercase, hyphenated. It exists because the alternative
--               is pasting a 30-character `coh_` id into every command, and an
--               operator tool that is unpleasant to use is one people work
--               around.
--   name        what a human calls it. Not unique - two institutions may both
--               run "Spring 2026" - and never used for lookup.
--   starts_at   when the class begins.
--   ends_at     when it ends, or NULL for one with no scheduled end. Not
--               decoration: see the entitlement window below.
--
-- ## prl.enrolments - one person's place in one cohort
--
--   cohort_id   ON DELETE RESTRICT. A cohort with enrolments in it is not a
--               row anybody may remove, because removing it would silently
--               destroy the record of everybody who was in it. Nothing in the
--               product deletes a cohort and no role is granted DELETE on the
--               table, so this is the correct action for a path that does not
--               exist rather than a live one - and RESTRICT is what keeps it
--               that way if somebody later grants DELETE without thinking about
--               this sentence.
--   user_id     ON DELETE CASCADE. Argued at length below.
--   granted_at  when the entitlement was created.
--   granted_by  ON WHOSE AUTHORITY. Free text, bounded and trimmed, because the
--               authority for a grant is not a row in this database: there is no
--               instructor table, no admin role and deliberately no privileged
--               HTTP surface (see apps/api/scripts/enrolments.mjs). It names a
--               person or a process to a human reading an audit trail.
--   reference   the opaque external string described above. NOT NULL: a grant
--               with no stated basis at all is the record that is worth least
--               later, and "scholarship" costs one word to type.
--   starts_at   when this person's access begins. Defaults to now(), and exists
--               so that a class can be enrolled in advance of the day it opens.
--   expires_at  when it ends, or NULL for an entitlement this row does not
--               time-limit. NULL does NOT mean forever - the cohort's own
--               `ends_at` still applies.
--   revoked_at / revoked_by / revoked_reason
--               withdrawal, as a triple that is either wholly absent or wholly
--               present. A revocation with no reason recorded is the one an
--               operator cannot defend six months later, so the CHECK below
--               refuses it rather than trusting the caller.
--
-- ## The entitlement window is the INTERSECTION of two periods
--
-- A person is entitled at an instant when their enrolment is not revoked and
-- that instant falls inside BOTH the enrolment's window and the cohort's:
--
--   from   greatest(enrolment.starts_at, cohort.starts_at)
--   until  least(enrolment.expires_at, cohort.ends_at)     -- NULL = unbounded
--
-- `least` and `greatest` ignore NULLs in PostgreSQL and return NULL only when
-- every argument is NULL, which is exactly the arithmetic wanted: an enrolment
-- with no expiry in a cohort that ends in June is entitled until June.
--
-- The alternative - treating the cohort period as documentation and letting the
-- enrolment decide alone - was rejected because it makes the most likely
-- operator mistake unrecoverable in the quiet direction. Enrol thirty people
-- with no `--expires`, and every one of them is entitled forever, with nothing
-- anywhere saying so. Under the rule above the class ends when the class ends.
--
-- ## Two enrolments in one cohort, over time: YES, and the index says so
--
-- ############################################################################
-- ## THE UNIQUE INDEX IS PARTIAL ON `revoked_at IS NULL`. IT MUST STAY THAT  ##
-- ## WAY. A PLAIN UNIQUE (cohort_id, user_id) WOULD MAKE A REVOCATION        ##
-- ## PERMANENT AND UNDOABLE, AND NOTHING WOULD SAY SO UNTIL SOMEBODY TRIED.  ##
-- ############################################################################
--
-- The sequence that has to work: a student's access is withdrawn (a dispute, a
-- transfer, an administrative error), the matter is resolved, and they are
-- enrolled again. Under a full unique index the second grant fails with a
-- duplicate-key error naming an index, weeks after the revocation, to an
-- operator who has no way to fix it except by editing the revoked row - which
-- destroys the record of the revocation, which is the one thing that must not
-- happen. So the constraint is exactly the invariant and nothing more: **at
-- most one UNREVOKED enrolment per person per cohort**. The history of the
-- revoked ones stays, in full, as rows.
--
-- This is the same shape, for the same reason, as `room_members_live_seat_key`
-- in 0002: partial on `left_at IS NULL`, "so that the history of who sat where
-- is kept".
--
-- ## Expiry does not free the slot, and the grant path handles that explicitly
--
-- An index predicate cannot say "not currently effective", because `now()` is
-- not immutable and cannot appear in one. So an enrolment that has merely
-- EXPIRED is still, to the index, live - and a second grant to the same person
-- in the same cohort would be refused with `already_enrolled` even though they
-- are entitled to nothing. That is the same silent bug in a different disguise,
-- and it is closed in `apps/api/src/repositories/enrolments.ts`: a grant first
-- closes out an expired predecessor as `superseded by a later grant`, in the
-- same transaction, and then inserts. Both rows survive; the index is satisfied
-- because the predecessor is now revoked; and the operator sees one command do
-- the obvious thing.
--
-- An EXCLUDE constraint over `tstzrange(starts_at, expires_at)` would express
-- all of this in the schema and was the first design. It needs `btree_gist` for
-- the equality members, `btree_gist` is not a trusted extension, and installing
-- it needs a superuser at deploy time - which 0001 already refused once, for
-- `citext`, on exactly these grounds. One migration that cannot be applied by
-- the documented deploy identity is worse than one paragraph of prose.
--
-- ## Grants: SELECT and nothing else, for both tables
--
-- This is the narrowest verb set any table in this schema has, narrower than
-- the append-only ledgers, and it is a deliberate statement about where the
-- write path is.
--
-- `prl_app` is the role the REQUEST PATH connects as. The request path needs to
-- ask "is this person entitled right now, and until when" and needs nothing
-- else. It must not be able to create an entitlement, extend one, or withdraw
-- one, because there is no user of this product who is allowed to do those
-- things - the operator tool connects as the migrating identity instead, and
-- that identity is not reachable from any HTTP handler. So an injection that
-- reaches the runtime role can read who is enrolled; it cannot enrol anybody,
-- cannot extend its own access, and cannot erase a revocation.
--
-- The consequence to be aware of when reading the repository: `grant` and
-- `revoke` in `repositories/enrolments.ts` WILL fail with `permission denied`
-- if they are ever called on a request-path handle. That is the design working,
-- and it is asserted by a test that calls them as `prl_app` and expects the
-- refusal.
--
-- Neither table gets `updated_at`, following 0001's rule that the column exists
-- on "exactly the tables the runtime role may UPDATE" - and there is no
-- `set_updated_at` trigger for the same reason.
--
-- ## What an account deletion does to an enrolment (db/migrations/0004)
--
-- `user_id` is ON DELETE CASCADE, so the enrolment row goes with the account.
-- The reasoning is 0004's own, applied unchanged: "A membership row is a record
-- of one learner and nothing else ... Nobody else's history is in it. So it goes
-- with the account." An enrolment is precisely that - one person, one cohort,
-- one authority - and unlike a hand it is nobody else's record. An entitlement
-- naming an account that no longer exists also entitles nobody, so keeping it
-- would preserve a row whose only remaining content is that SOMEBODY was in this
-- cohort.
--
-- The record-keeping half is not lost, and this is the half of the decision that
-- matters: every grant and every revocation writes an append-only entry to
-- `prl.audit_log` in the same transaction, and `audit_log.user_id` is ON DELETE
-- SET NULL. So after an erasure the operator's record still says that on this
-- date, on this authority, against this external reference, an enrolment in this
-- cohort was granted and later revoked - with the person no longer named. That
-- is the same trade the schema already makes for `hand_seats` and for the audit
-- trail itself, and it is written into `docs/production/legal-register.md` as a
-- decision rather than left to be inferred from a referential action.
--
-- CASCADE rather than an explicit DELETE in the erasure path, for 0004's
-- least-privilege reason: a referential action runs with the constraint owner's
-- privileges, so the account deletion removes the enrolment WITHOUT `prl_app`
-- holding DELETE on `prl.enrolments` - which it must not, or any request path
-- could remove anybody's entitlement.
--
-- ## Deployment ordering (docs/RUNBOOK.md section 11.3)
--
-- Purely additive: two new tables, no column changed, no constraint altered, no
-- row rewritten. An API image that predates this file runs against a database
-- that has it and behaves exactly as it did, because nothing it runs mentions
-- either table. An API image that postdates it, running against a database
-- WITHOUT it, fails any entitlement read with an undefined-table error; nothing
-- in this release reads one, so the usual order (migrate, then roll the API) has
-- nothing to catch here and is still the order to use.
--
-- No `prl:irreversible` marker, and that is a claim rather than an omission.
-- This file creates two tables, three indexes and four grants; it reads no row,
-- rewrites no row and drops nothing. The runner still refuses `down`.
-- =============================================================================

SET ROLE prl_migrator;

-- -----------------------------------------------------------------------------
-- cohorts
-- -----------------------------------------------------------------------------
CREATE TABLE prl.cohorts (
  id          prl.prefixed_id PRIMARY KEY
                CONSTRAINT cohorts_id_prefix CHECK (id ~ '^coh_'),

  -- The operator-facing handle. Lowercase and hyphenated so it can be typed,
  -- pasted into a runbook and used as a shell argument without quoting, and
  -- bounded so it cannot become a paragraph.
  key         text NOT NULL
                CONSTRAINT cohorts_key_shape CHECK (
                  char_length(key) BETWEEN 3 AND 64
                  AND key ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
                ),

  name        text NOT NULL
                CONSTRAINT cohorts_name_shape CHECK (
                  char_length(name) BETWEEN 2 AND 120
                  AND name = btrim(name)
                ),

  starts_at   timestamptz NOT NULL,
  -- NULL is a cohort with no scheduled end, not a cohort that never ends for
  -- entitlement purposes - an enrolment's own expiry still bounds it.
  ends_at     timestamptz NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),

  -- A period that ends before it begins would make every entitlement in the
  -- cohort dead on arrival, silently, because the window is an intersection.
  CONSTRAINT cohorts_period_ordered CHECK (ends_at IS NULL OR ends_at > starts_at)
);

COMMENT ON TABLE prl.cohorts IS
  'An identified class: a stable operator-facing key, a display name and a period. Holds nothing '
  'about any person and nothing about what anything cost.';

COMMENT ON COLUMN prl.cohorts.key IS
  'The handle an operator types, e.g. spring-2026-risk-lab. Unique; this is what the enrolment CLI '
  'resolves a cohort by, so that no command needs a coh_ id pasted into it.';
COMMENT ON COLUMN prl.cohorts.ends_at IS
  'When the class ends, or NULL for one with no scheduled end. Load-bearing: an entitlement runs '
  'until least(enrolment.expires_at, cohort.ends_at), so a cohort that has ended entitles nobody '
  'however its enrolments are written.';

CREATE UNIQUE INDEX cohorts_key_key ON prl.cohorts (key);

-- -----------------------------------------------------------------------------
-- enrolments
-- -----------------------------------------------------------------------------
CREATE TABLE prl.enrolments (
  id              prl.prefixed_id PRIMARY KEY
                    CONSTRAINT enrolments_id_prefix CHECK (id ~ '^enr_'),

  cohort_id       prl.prefixed_id NOT NULL
                    REFERENCES prl.cohorts (id) ON DELETE RESTRICT,

  user_id         prl.prefixed_id NOT NULL
                    REFERENCES prl.users (id) ON DELETE CASCADE,

  granted_at      timestamptz NOT NULL DEFAULT now(),

  -- On whose authority. Bounded and trimmed for the reason room_ownership.owner_id
  -- is: a blank or whitespace value compares equal to another blank one and turns
  -- an accountability record into a row that names nobody.
  granted_by      text NOT NULL
                    CONSTRAINT enrolments_granted_by_shape CHECK (
                      char_length(granted_by) BETWEEN 2 AND 128
                      AND granted_by = btrim(granted_by)
                    ),

  -- The opaque external string. This schema does not parse it, index it for
  -- meaning, or care what system it points into.
  reference       text NOT NULL
                    CONSTRAINT enrolments_reference_shape CHECK (
                      char_length(reference) BETWEEN 1 AND 200
                      AND reference = btrim(reference)
                    ),

  starts_at       timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NULL,

  revoked_at      timestamptz NULL,
  revoked_by      text NULL
                    CONSTRAINT enrolments_revoked_by_shape CHECK (
                      revoked_by IS NULL
                      OR (char_length(revoked_by) BETWEEN 2 AND 128 AND revoked_by = btrim(revoked_by))
                    ),
  revoked_reason  text NULL
                    CONSTRAINT enrolments_revoked_reason_shape CHECK (
                      revoked_reason IS NULL
                      OR (
                        char_length(revoked_reason) BETWEEN 1 AND 200
                        AND revoked_reason = btrim(revoked_reason)
                      )
                    ),

  -- An enrolment that expires before it starts is entitled to nothing for its
  -- whole life, which is never what anybody meant to type.
  CONSTRAINT enrolments_expiry_after_start CHECK (expires_at IS NULL OR expires_at > starts_at),

  -- All three or none. A revocation timestamp with no reason and no authority is
  -- the row an operator cannot account for later, and it is exactly the row a
  -- half-written UPDATE produces.
  CONSTRAINT enrolments_revocation_is_complete CHECK (
    (revoked_at IS NULL AND revoked_by IS NULL AND revoked_reason IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revoked_reason IS NOT NULL)
  ),

  CONSTRAINT enrolments_revoked_after_grant CHECK (revoked_at IS NULL OR revoked_at >= granted_at)
);

COMMENT ON TABLE prl.enrolments IS
  'One person''s place in one cohort: when it was granted, on whose authority, against which opaque '
  'external reference, until when, and whether it was withdrawn and why. Records THAT somebody is '
  'entitled, never what anything cost - there is no amount and no currency column here or anywhere '
  'in this schema.';

COMMENT ON COLUMN prl.enrolments.granted_by IS
  'Who authorised this. Free text and deliberately not a foreign key: there is no instructor table '
  'and no admin role in this product, and the authority for a grant lives outside it.';
COMMENT ON COLUMN prl.enrolments.reference IS
  'An opaque external identifier supplied by the operator - a purchase-order number, a row id in a '
  'finance system, a registry entry, or the word scholarship. Never parsed here.';
COMMENT ON COLUMN prl.enrolments.expires_at IS
  'When this person''s access ends, or NULL for an enrolment this row does not time-limit. NULL is '
  'not "forever": the cohort''s ends_at still bounds it.';
COMMENT ON COLUMN prl.enrolments.revoked_at IS
  'When the entitlement was withdrawn. Withdrawal is an UPDATE and never a delete: the row, its '
  'authority and its reason stay, which is what makes "was their access withdrawn, when, and why?" '
  'answerable.';

-- -----------------------------------------------------------------------------
-- At most one UNREVOKED enrolment per person per cohort.
--
-- Partial, and the header says at length why the partiality is the whole point:
-- a revoked enrolment must not stop a later re-grant. Same shape and same
-- argument as room_members_live_seat_key in 0002.
--
-- This index is also what the grant path infers its ON CONFLICT target from, so
-- its column list and its predicate are load-bearing in two places.
-- -----------------------------------------------------------------------------
CREATE UNIQUE INDEX enrolments_live_cohort_user_key
  ON prl.enrolments (cohort_id, user_id)
  WHERE revoked_at IS NULL;

-- -----------------------------------------------------------------------------
-- The request-path read: "is THIS user entitled right now".
--
-- The unique index above cannot serve it - `cohort_id` leads, and the request
-- path has a user and no cohort. Partial on `revoked_at IS NULL` so the index
-- holds only rows that can still entitle somebody, which is the majority case
-- shrinking rather than growing: revoked rows accumulate and are never read by
-- a request.
--
-- This is the index that decides whether the entitlement check is cheap enough
-- to sit in a request path. Without it the read is a sequential scan of every
-- enrolment ever granted, on every request that asks.
-- -----------------------------------------------------------------------------
CREATE INDEX enrolments_live_user_idx
  ON prl.enrolments (user_id)
  WHERE revoked_at IS NULL;

-- -----------------------------------------------------------------------------
-- The operator read: "who is in this cohort", newest first.
--
-- Not partial: listing a cohort has to be able to show the revoked rows, which
-- are most of what an operator is looking for when something has gone wrong.
-- -----------------------------------------------------------------------------
CREATE INDEX enrolments_cohort_granted_at_idx
  ON prl.enrolments (cohort_id, granted_at DESC);

-- -----------------------------------------------------------------------------
-- Least privilege. SELECT only, for both tables, argued in the header.
-- -----------------------------------------------------------------------------
GRANT SELECT ON prl.cohorts    TO prl_app;
GRANT SELECT ON prl.enrolments TO prl_app;

RESET ROLE;

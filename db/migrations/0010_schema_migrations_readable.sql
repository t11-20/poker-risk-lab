-- =============================================================================
-- 0010_schema_migrations_readable.sql - the API may read the migration ledger,
-- so it can refuse to serve a schema that is behind its own build.
--
-- ## What was wrong
--
-- The API neither migrated at boot nor checked whether anybody had. Twice in
-- one day an open PR added a migration (#25's 0008, then #32's 0009) and the
-- development database stayed behind it until somebody ran `migrate.mjs up`.
-- The API booted green and `/ready` answered 200 against it; the only symptom
-- was archive writes failing with `column "automatic_reason" does not exist`,
-- so units silently stopped moving. `apps/api/src/schema-guard.ts` now compares
-- the files this build shipped with `prl.schema_migrations` at boot and refuses
-- to start when the database is behind. The request path connects as a member
-- of `prl_app`, which could not read the ledger at all - this is the grant.
--
-- ## The grant, and what it does not give
--
-- SELECT, and nothing else. The ledger holds a filename, a sha256 of a file in
-- a public repository and a timestamp per migration; an injection that reaches
-- it learns which schema version is deployed, which the API's own behaviour
-- already gives away. The runtime role still cannot INSERT, UPDATE or DELETE a
-- row, so it cannot mark a migration applied, hide one, or forge a checksum -
-- `migrate.mjs` stays the ledger's only writer.
--
-- This supersedes one sentence in 0001's privilege matrix ("prl_app is granted
-- nothing at all on prl.schema_migrations"), which cannot be edited: 0001 is
-- applied everywhere and its checksum is in every ledger. `verify-schema.mjs`'s
-- APP_TABLE_GRANTS now says SELECT for this table, and `db:verify` fails on any
-- other set of verbs.
--
-- ## Why there is no SET ROLE prl_migrator here
--
-- Every other grant in this directory is made as prl_migrator, because it owns
-- the tables. It does not always own this one. The ledger is created by
-- `migrate.mjs` (`ensureLedger`), not by a migration, as whichever identity runs
-- `up` first, and it is handed to prl_migrator only AFTER the pending files have
-- been applied (`alignLedgerOwnership`). On a fresh database - every CI job, every
-- restore rehearsal - this file runs while the connecting identity owns the
-- ledger and prl_migrator holds nothing on it, so a GRANT made as prl_migrator
-- would be refused there. Made as the connecting identity, it works in both
-- states: that identity is the owner on a first run, and a member of the owner
-- (prl_deployer, per RUNBOOK §5) afterwards. When the ledger later changes owner,
-- PostgreSQL rewrites the grantor of every ACL entry to the new owner, so the
-- grant survives the handover.
--
-- The DO block refuses rather than trusting that. A GRANT issued by a role that
-- holds some privilege on the table but no grant option is not an error in
-- PostgreSQL: it is `WARNING: no privileges were granted` and a successful
-- statement, and this runner would then record the file as applied while the
-- API refuses every boot for a reason the ledger says was fixed.
--
-- Additive: one ACL entry, no row read or written, nothing to roll back.
-- =============================================================================

GRANT SELECT ON prl.schema_migrations TO prl_app;

DO $$
BEGIN
  IF NOT has_table_privilege('prl_app', 'prl.schema_migrations', 'SELECT') THEN
    RAISE EXCEPTION 'prl_app still cannot read prl.schema_migrations after GRANT SELECT; the identity running this migration is neither the ledger''s owner nor a member of it (see the header of 0010_schema_migrations_readable.sql)';
  END IF;
END
$$;

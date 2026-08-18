-- =============================================================================
-- 0001_privilege_roles.sql - the two cluster-wide privilege containers.
--
-- Applied by `node apps/api/scripts/migrate.mjs roles`. NOT a migration: it is
-- not recorded in prl.schema_migrations, and it is written to be re-run.
--
-- ## Why this exists when 0001_initial.sql already creates these roles
--
-- Because of the one path where no migration will ever run: restoring a backup.
--
-- `pg_dump` of a single database does not contain roles - roles are cluster-wide,
-- and only `pg_dumpall --globals-only` carries them. A dump of this database DOES
-- contain, in its table of contents, an `ALTER SCHEMA prl OWNER TO prl_migrator`,
-- a `GRANT ... TO prl_app` for every table, and a DEFAULT ACL entry for
-- prl_migrator. Restoring it into a cluster where those roles do not exist fails
-- with `role "prl_migrator" does not exist`; restoring it with --no-owner
-- --no-privileges "succeeds" and produces a database the API cannot read, because
-- prl_app ends up with no USAGE on the schema and no grant on any table. That
-- second outcome is the dangerous one: it looks like a successful restore.
--
-- So the restore procedure needs the roles to exist BEFORE pg_restore runs, and
-- 0001_initial.sql cannot provide them: applied migrations are immutable and the
-- migration runner will not be executing at that point in the procedure anyway.
-- The duplication below is two CREATE ROLE statements, deliberately, and it is
-- the smaller cost. docs/RUNBOOK.md §11.4 has the full procedure.
--
-- ## What is deliberately not here
--
-- No password, and no LOGIN. Both roles are privilege containers; the identities
-- that actually connect (prl_api, prl_deployer - RUNBOOK §5) are created per
-- environment from a secret manager and granted membership. A file in version
-- control must not be able to set a credential. db/seeds/0002_dev_login_roles.sql
-- creates the development equivalents, because a seed cannot reach production.
--
-- No GRANTs on any object either. Object privileges belong to the migration that
-- creates the object, and they arrive with the dump on the restore path.
-- =============================================================================

DO $$
BEGIN
  -- Guarded rather than `CREATE ROLE IF NOT EXISTS` (which PostgreSQL does not
  -- have) so this file is safe to run against a cluster that already has them -
  -- including the ordinary development cluster, where 0001_initial.sql created
  -- them long ago. Nothing here ALTERs an existing role: this file must never be
  -- able to widen a role somebody else narrowed.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'prl_migrator') THEN
    -- The negatives are spelled out rather than left to CREATE ROLE's defaults.
    -- They ARE the defaults, and INHERIT is deliberately left as one, so a role
    -- created here is attribute-for-attribute the role 0001_initial.sql creates -
    -- two files that make "the same" role differently is exactly the drift this
    -- project refuses elsewhere. Spelling them out means the privileges this file
    -- is responsible for can be read here rather than in the manual.
    CREATE ROLE prl_migrator NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    RAISE NOTICE 'created role prl_migrator';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'prl_app') THEN
    CREATE ROLE prl_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    RAISE NOTICE 'created role prl_app';
  END IF;

  -- pg_restore replays `ALTER ... OWNER TO prl_migrator`, which requires the
  -- restoring identity to be a member of prl_migrator (or a superuser). Granting
  -- it here means the restore does not fail two thousand objects in.
  IF NOT pg_catalog.pg_has_role(current_user, 'prl_migrator', 'USAGE') THEN
    EXECUTE format('GRANT prl_migrator TO %I', current_user);
    RAISE NOTICE 'granted prl_migrator to %', current_user;
  END IF;
END
$$;

-- The two cluster-wide privilege containers, applied by `migrate.mjs roles`. Not a migration: it is not
-- recorded in prl.schema_migrations and is safe to re-run.
--
-- 0001_initial.sql also creates these roles, but a restore runs no migration. A single-database pg_dump
-- carries no roles yet references prl_migrator and prl_app, so a restore into a cluster without them
-- fails, or with --no-owner --no-privileges "succeeds" with no grant prl_app can use. The roles must
-- exist before pg_restore runs (docs/RUNBOOK.md §11.4).
--
-- No password and no LOGIN: the identities that connect are created per environment from a secret
-- manager (RUNBOOK §5), and a file in version control must not be able to set a credential. No object
-- GRANTs either: they belong to the migration that creates the object and arrive with the dump.

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

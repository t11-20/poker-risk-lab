-- =============================================================================
-- 0002_dev_login_roles.sql - the two DEVELOPMENT login identities.
--
-- Applied by `pnpm db:seed`, which refuses to run when NODE_ENV=production.
-- That refusal is the reason this file can exist at all: it sets passwords, and a
-- password in version control must never be able to reach a real deployment.
-- Seeds are not recorded in prl.schema_migrations, so every statement below is
-- guarded and safe to re-run.
--
-- ## Why a seed creates roles
--
-- 0001_initial.sql creates `prl_migrator` and `prl_app` NOLOGIN and with no
-- password, on purpose: they are privilege containers, not identities. Nothing
-- connects AS prl_app; something connects as a login role that is a MEMBER of it
-- and inherits its privileges (docs/RUNBOOK.md §5).
--
-- Until this file existed, nothing outside the documentation ever did that.
-- Development connected as the cluster superuser, so every query ran with
-- rolsuper and rolbypassrls, and the least-privilege path - the one that bounds
-- what an injection can reach in production - was exercised for the first time in
-- production. A missing GRANT does not surface locally when the local identity
-- has every privilege there is. Now `.env.example` points DATABASE_URL at
-- prl_api, so the development API, the test suite and `pnpm db:verify` all run
-- against exactly the privileges the deployment gives them.
--
-- The names match §5 of the runbook deliberately: development should rehearse the
-- deployment's shape, not a parallel one with different role names.
--
-- ## The password
--
-- "poker-dev-only", the same value docker-compose.yml uses for POSTGRES_PASSWORD
-- and .env.example uses for the superuser. One dev credential rather than three
-- is one thing to remember and, more usefully, one thing to recognise instantly
-- as not a secret. A real deployment creates these two roles by hand, once, with
-- a password from a secret manager - the SQL for that is in RUNBOOK §5 and it is
-- not this file.
--
-- ## Why the whole thing is conditional
--
-- Creating a role needs CREATEROLE or superuser, and granting membership in
-- prl_app needs admin of it. `pnpm db:seed` may legitimately be run by an
-- identity with neither (prl_deployer owns the schema but administers no role),
-- and a seed that aborted there would take the fixture data down with it. So the
-- block below checks first and says what it skipped instead of failing.
-- =============================================================================

DO $$
DECLARE
  -- Not a secret, and deliberately written once rather than four times: two
  -- CREATE ROLEs and two ALTER ROLEs disagreeing about the password is a failure
  -- mode with a very confusing symptom (28P01 against a healthy container).
  dev_password CONSTANT text := 'poker-dev-only';
  -- coalesce, not a bare bool_or: an aggregate over no rows is NULL, and `IF NOT
  -- NULL` is not taken, so the unknown case would fall through into the role
  -- creation it is meant to skip.
  can_manage_roles CONSTANT boolean := coalesce((
    SELECT bool_or(rolsuper OR rolcreaterole)
    FROM pg_catalog.pg_roles
    WHERE rolname = current_user
  ), false);
BEGIN
  IF NOT can_manage_roles THEN
    RAISE NOTICE
      'skipping the development login roles: % may not create roles. Re-run db:seed as the cluster owner if you want prl_api and prl_deployer.',
      current_user;
    RETURN;
  END IF;

  -- prl_api: what the API connects as. It holds NO privilege of its own - every
  -- table grant it has comes from membership in prl_app, which is what makes
  -- `REVOKE prl_app FROM prl_api` a complete revocation.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'prl_api') THEN
    EXECUTE format('CREATE ROLE prl_api LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', dev_password);
    RAISE NOTICE 'created development login role prl_api';
  ELSE
    -- Re-runnable: a developer who has forgotten the password gets it reset
    -- rather than a role they cannot use. Only ever to the value above, and only
    -- ever outside production.
    EXECUTE format('ALTER ROLE prl_api PASSWORD %L', dev_password);
  END IF;

  -- prl_deployer: what the migration job connects as. Owns the schema through
  -- prl_migrator; the API must never use it.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'prl_deployer') THEN
    EXECUTE format('CREATE ROLE prl_deployer LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', dev_password);
    RAISE NOTICE 'created development login role prl_deployer';
  ELSE
    EXECUTE format('ALTER ROLE prl_deployer PASSWORD %L', dev_password);
  END IF;

  -- Membership is the whole mechanism, so it is checked every run rather than
  -- only at creation: a role that exists without its membership is an identity
  -- that authenticates and can then read nothing, which reads like a broken app.
  -- Guarded rather than re-granted because an unconditional GRANT raises a notice
  -- on every single re-run, and a seed that always prints a warning is a seed
  -- whose warnings stop being read.
  IF NOT pg_catalog.pg_has_role('prl_api', 'prl_app', 'MEMBER') THEN
    GRANT prl_app TO prl_api;
    RAISE NOTICE 'granted prl_app to prl_api';
  END IF;
  IF NOT pg_catalog.pg_has_role('prl_deployer', 'prl_migrator', 'MEMBER') THEN
    GRANT prl_migrator TO prl_deployer;
    RAISE NOTICE 'granted prl_migrator to prl_deployer';
  END IF;

  -- CONNECT comes from PUBLIC by default. Named here so that a cluster which has
  -- revoked it from PUBLIC - a reasonable hardening step - does not turn into a
  -- development environment that cannot open a connection.
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO prl_api, prl_deployer', current_database());
END
$$;

-- A statement, not a comment, so the check is real: if the two identities cannot
-- reach the schema through their membership, the seed fails here rather than
-- leaving a developer to discover it as a permission-denied error at request time.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'prl_api') THEN
    IF NOT pg_catalog.has_schema_privilege('prl_api', 'prl', 'USAGE') THEN
      RAISE EXCEPTION
        'prl_api exists but has no USAGE on schema prl. Its membership in prl_app is missing, or 0001_initial.sql has not been applied to this database.';
    END IF;
    IF pg_catalog.has_schema_privilege('prl_api', 'prl', 'CREATE') THEN
      RAISE EXCEPTION
        'prl_api holds CREATE on schema prl. The development identity must have exactly the runtime privileges and no more.';
    END IF;
  END IF;
END
$$;

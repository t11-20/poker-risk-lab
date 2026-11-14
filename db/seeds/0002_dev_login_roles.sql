-- The two development login identities, applied by `pnpm db:seed`. That command refuses
-- NODE_ENV=production, which is the only reason this file may set a password. Every statement is
-- guarded and safe to re-run.
--
-- prl_migrator and prl_app are NOLOGIN privilege containers; what connects is a login role that is a
-- member of one (docs/RUNBOOK.md §5, whose names these match). `.env.example` points DATABASE_URL at
-- prl_api so development and the tests run with the deployment's privileges, not as a superuser that
-- hides a missing GRANT.
--
-- The password is "poker-dev-only", the value docker-compose.yml and .env.example use, so it is
-- recognisable as not a secret. A real deployment creates these roles from a secret manager.
--
-- Creating a role needs CREATEROLE or superuser and granting prl_app needs admin of it; db:seed may run
-- as prl_deployer, which has neither, so the block skips with a notice instead of failing.

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

-- Fails the seed if the identities cannot reach the schema through their membership, rather than at
-- request time.
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

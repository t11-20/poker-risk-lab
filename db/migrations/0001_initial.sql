-- =============================================================================
-- 0001_initial.sql - Poker Risk Lab: schema, roles, domains, tables.
--
-- Poker Risk Lab is an educational play-money app. Chips are "units": free,
-- resettable and valueless. That is not just a product statement, it is visible
-- in this file - there is deliberately no balance, currency, price, purchase,
-- payout, prize or transfer column anywhere in the schema, and no table that
-- could serve as a ledger of value. Adding one would be a product decision, not
-- a migration.
--
-- ## Design decisions
--
-- 1. Everything lives in schema `prl` and every reference is schema-qualified.
--    Nothing here depends on `search_path`, so a wrong or hostile search_path
--    cannot silently resolve `users` to some other table.
--
-- 2. Primary keys are application-generated prefixed text (`usr_`, `room_`,
--    `hand_`, ...) rather than serials or UUIDs. Three reasons: an id is
--    self-describing in a log or a URL, so a room id can never be mistaken for a
--    user id and passed to the wrong lookup; there is no shared sequence to leak
--    how many users or hands exist; and the server can mint an id before it
--    writes, which is what lets the engine build a whole HandState (with its
--    handId already inside the commitment context) before any row exists.
--    Domain `prl.prefixed_id` enforces the shape, and each table adds a CHECK
--    for its own prefix, so a mis-wired insert fails at the database rather than
--    quietly creating an orphan.
--
-- 3. Timestamps are `timestamptz`, never `timestamp`. `created_at` everywhere;
--    `updated_at` on exactly the tables the runtime role may UPDATE. The tables
--    without `updated_at` are append-only ledgers, and the grants at the bottom
--    of this file enforce that: no UPDATE, no DELETE, insert and read only.
--
-- 4. Secrets are stored as sha256 digests and nothing else - session tokens,
--    room invite codes, OIDC state, nonce and PKCE verifier. A database read
--    must not hand the reader a working credential. Domain `prl.sha256_hash`
--    makes the intent part of the column type.
--
-- 5. There is no raw IP address and no raw user agent anywhere, only optional
--    salted digests, so "which sessions are mine" still works while the database
--    holds no directly identifying network data.
--
-- 6. The deck and the commitment salts are never persisted. The only salts that
--    ever reach a row are the per-position ones inside a proof for a card that is
--    already public, because a proof nobody can check is not a proof; the salt of
--    an unrevealed position has no column and no path to one, and two CHECK
--    constraints on `prl.hands` bound what a reveal may contain. See the comment
--    on that table - this is the single most important decision in the file.
--
-- 7. No computed poker number is ever stored. There is no equity, pot_odds,
--    break_even, ev or outs column. The database records what happened - cards,
--    chips moved, pot sizes, who acted - and every derived figure the learner
--    sees is computed at runtime by @prl/poker-math from that situation. A
--    cached equity is a number that can silently disagree with the maths that
--    produced it, and the learner would never know which one was wrong.
--
-- 8. CHECK constraints mirror the TypeScript unions exactly, including their
--    casing (`allIn`, `sittingOut`, `tight-aggressive`). The sources of truth
--    are packages/poker-engine/src/types.ts (Street, SeatStatus, ActionType,
--    TableConfig, HandResult), packages/poker-engine/src/cards.ts (card
--    notation), packages/poker-engine/src/commitment.ts (DeckReveal) and
--    packages/contracts/src/content-types.ts (OpponentProfile, ContentId). If a
--    union gains a member, this file has to change too - which is the point.
--
-- 9. Least privilege: `prl_migrator` owns the schema, `prl_app` is the runtime
--    role and gets USAGE plus the narrowest per-table verb set that the API
--    actually needs. Not CREATE, not DROP, not TRUNCATE, not REFERENCES, not
--    TRIGGER, and no ownership of anything.
--
-- Requires PostgreSQL 14 or newer. Verified against 14, 16 (the version
-- docker-compose.yml pins) and 18, including a pg_dump/pg_restore round trip.
-- Run by apps/api/scripts/migrate.mjs, which wraps this file in one transaction.
-- =============================================================================

DO $$
BEGIN
  IF current_setting('server_version_num')::int < 140000 THEN
    RAISE EXCEPTION 'Poker Risk Lab needs PostgreSQL 14 or newer, found %', current_setting('server_version');
  END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- Roles.
--
-- Both roles are created NOLOGIN and hold no password. They are privilege
-- containers: the real login identities (a CI deploy identity, the API's
-- database user) are granted membership out of band, by whatever manages
-- secrets. A migration that set a password would put that password in version
-- control, so this file deliberately cannot.
--
-- Guarded by pg_roles so the migration is idempotent and works on a cluster
-- where the roles already exist - roles are cluster-wide, unlike everything else
-- here, so they may well predate this database.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'prl_migrator') THEN
    CREATE ROLE prl_migrator NOLOGIN;
    RAISE NOTICE 'created role prl_migrator';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'prl_app') THEN
    CREATE ROLE prl_app NOLOGIN;
    RAISE NOTICE 'created role prl_app';
  END IF;

  -- Handing ownership to prl_migrator requires being a member of it. If this
  -- GRANT fails because the roles pre-exist and the migrating identity has no
  -- authority over them, a DBA needs to run `GRANT prl_migrator TO <identity>`
  -- once; that is a deliberate privilege decision, not something a migration
  -- should be able to force.
  IF NOT pg_catalog.pg_has_role(current_user, 'prl_migrator', 'USAGE') THEN
    EXECUTE format('GRANT prl_migrator TO %I', current_user);
    RAISE NOTICE 'granted prl_migrator to %', current_user;
  END IF;
END
$$;

CREATE SCHEMA IF NOT EXISTS prl;
ALTER SCHEMA prl OWNER TO prl_migrator;

-- Every object below is created while acting as prl_migrator, so the schema
-- owner owns all of it regardless of which identity ran the migration. Plain
-- SET (not SET LOCAL) so this also behaves when the file is applied by hand
-- outside a transaction; PostgreSQL rolls a SET back if the transaction aborts,
-- so the migration runner's transaction still cleans up after a failure.
SET ROLE prl_migrator;

-- -----------------------------------------------------------------------------
-- Domains. Types that carry their own rules, so the rule cannot be forgotten at
-- the seventeenth column that needs it.
-- -----------------------------------------------------------------------------

-- An application-generated identifier: a short lowercase type prefix, an
-- underscore, then 8-64 URL-safe characters of randomness.
CREATE DOMAIN prl.prefixed_id AS text
  CONSTRAINT prefixed_id_shape CHECK (VALUE ~ '^[a-z]{3,6}_[A-Za-z0-9_-]{8,64}$');

-- A sha256 digest, exactly 32 bytes. Used for every secret this schema knows
-- about, so `bytea` never has to be read as "some bytes, hopefully a hash".
CREATE DOMAIN prl.sha256_hash AS bytea
  CONSTRAINT sha256_hash_length CHECK (octet_length(VALUE) = 32);

-- A content identifier: the slug form of ContentId in
-- packages/contracts/src/content-types.ts. Content ships in code, not in the
-- database (see the comment on prl.lesson_progress), so these are validated but
-- not foreign keys.
CREATE DOMAIN prl.content_id AS text
  CONSTRAINT content_id_shape CHECK (VALUE ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$');

COMMENT ON DOMAIN prl.prefixed_id IS
  'Application-generated primary key: <type prefix>_<8-64 URL-safe chars>.';
COMMENT ON DOMAIN prl.sha256_hash IS
  'A 32-byte sha256 digest. Secrets are stored hashed; the plaintext is never stored.';
COMMENT ON DOMAIN prl.content_id IS
  'Slug form of ContentId from packages/contracts/src/content-types.ts.';

-- -----------------------------------------------------------------------------
-- Helpers.
-- -----------------------------------------------------------------------------

-- Keeps updated_at honest. An application that forgets to set it cannot leave a
-- stale value behind, which matters because session and room sweeps read it.
CREATE FUNCTION prl.set_updated_at() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$fn$;

-- True when `cards` is a JSON array of `min_cards`..`max_cards` distinct cards
-- in the notation used by packages/poker-engine/src/cards.ts: rank in
-- 2-9,T,J,Q,K,A followed by suit in c,d,h,s, e.g. "Ah", "Td", "2c".
--
-- Cards are stored as notation rather than as the engine's 0..51 integers on
-- purpose: the integer form is an in-memory encoding, and a row a human cannot
-- read while debugging a disputed hand is a row that hides bugs. The distinctness
-- check mirrors assertDistinctCards() - a board or a holding containing the same
-- card twice is corrupt data, and the database is the last place that can still
-- say no.
--
-- The parameter is `cards`, and each element is aliased to `element(card)`, for a
-- reason worth knowing: jsonb_array_elements() emits a column literally named
-- `value`, so a parameter of that name would be silently shadowed by the column
-- inside the sub-selects. Naming both explicitly is what makes the references
-- below mean what they look like.
CREATE FUNCTION prl.is_card_notation_array(cards jsonb, min_cards int, max_cards int)
  RETURNS boolean
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  RETURNS NULL ON NULL INPUT
  SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT jsonb_typeof(cards) = 'array'
     AND jsonb_array_length(cards) BETWEEN min_cards AND max_cards
     AND NOT EXISTS (
           SELECT 1
             FROM jsonb_array_elements(cards) AS element(card)
            WHERE jsonb_typeof(element.card) <> 'string'
               OR element.card #>> '{}' !~ '^[2-9TJQKA][cdhs]$'
         )
     AND (
           SELECT count(DISTINCT element.card) = jsonb_array_length(cards)
             FROM jsonb_array_elements(cards) AS element(card)
         );
$fn$;

COMMENT ON FUNCTION prl.is_card_notation_array(jsonb, int, int) IS
  'Validates a jsonb array of distinct cards in "Ah"/"Td"/"2c" notation. Used by CHECK constraints.';

-- -----------------------------------------------------------------------------
-- users
--
-- A guest is a first-class account, not a lesser one: it has a row, an id, and
-- its own progress. Signing in with OIDC later is an upgrade path, not a
-- prerequisite for learning anything.
--
-- display_name is text with length and trim checks rather than citext. citext
-- would need an extension installed by a superuser at deploy time, and it buys
-- nothing here: display names are deliberately NOT unique (two learners may both
-- be "Sam"), so nothing ever compares them case-insensitively. If a future
-- feature needs case-insensitive search, an expression index on
-- lower(display_name) is enough and needs no extension.
-- -----------------------------------------------------------------------------
CREATE TABLE prl.users (
  id            prl.prefixed_id PRIMARY KEY
                  CONSTRAINT users_id_prefix CHECK (id ~ '^usr_'),
  kind          text NOT NULL
                  CONSTRAINT users_kind_allowed CHECK (kind IN ('guest', 'oidc')),
  display_name  text NOT NULL
                  CONSTRAINT users_display_name_shape CHECK (
                    char_length(display_name) BETWEEN 2 AND 24
                    AND display_name = btrim(display_name)
                  ),
  -- OpenID Connect requires an https issuer; the loopback exception exists only
  -- so a local identity provider can be run during development.
  oidc_issuer   text NULL
                  CONSTRAINT users_oidc_issuer_shape CHECK (
                    oidc_issuer IS NULL
                    OR (
                      char_length(oidc_issuer) BETWEEN 8 AND 255
                      AND (
                        oidc_issuer ~ '^https://'
                        OR oidc_issuer ~ '^http://(localhost|127[.]0[.]0[.]1)([:/]|$)'
                      )
                    )
                  ),
  oidc_subject  text NULL
                  CONSTRAINT users_oidc_subject_shape CHECK (
                    oidc_subject IS NULL OR char_length(oidc_subject) BETWEEN 1 AND 255
                  ),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  -- The identity columns are tied to `kind`, not merely to each other. "Both
  -- null or both set" would allow a row claiming kind 'oidc' with no issuer,
  -- which an authentication lookup would then never find and no code path would
  -- ever notice.
  CONSTRAINT users_kind_matches_identity CHECK (
    (kind = 'guest' AND oidc_issuer IS NULL AND oidc_subject IS NULL)
    OR (kind = 'oidc' AND oidc_issuer IS NOT NULL AND oidc_subject IS NOT NULL)
  )
);

COMMENT ON TABLE prl.users IS
  'A learner. kind ''guest'' has no OIDC identity; kind ''oidc'' has both issuer and subject.';
COMMENT ON COLUMN prl.users.oidc_issuer IS
  'Issuer URL. Unique together with oidc_subject (partial unique index in 0002); the pair, never the '
  'subject alone, identifies a federated user.';

-- -----------------------------------------------------------------------------
-- sessions
--
-- `id` is an opaque handle for the row, NOT the session token. The token lives
-- only in the client's cookie; the database holds sha256(token) so that a
-- database dump, a backup, or a SELECT by a compromised read-only role yields no
-- usable credential. Lookup is by token_hash, which is why 0002 makes it unique.
-- -----------------------------------------------------------------------------
CREATE TABLE prl.sessions (
  id               prl.prefixed_id PRIMARY KEY
                     CONSTRAINT sessions_id_prefix CHECK (id ~ '^ses_'),
  user_id          prl.prefixed_id NOT NULL
                     REFERENCES prl.users (id) ON DELETE CASCADE,
  token_hash       prl.sha256_hash NOT NULL,
  expires_at       timestamptz NOT NULL,
  revoked_at       timestamptz NULL,
  user_agent_hash  prl.sha256_hash NULL,
  ip_hash          prl.sha256_hash NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT sessions_expires_after_creation CHECK (expires_at > created_at)
);

COMMENT ON TABLE prl.sessions IS
  'One signed-in browser. Stores sha256(token) only: the session token itself is never persisted, so '
  'reading this table cannot log anyone in.';
COMMENT ON COLUMN prl.sessions.ip_hash IS
  'Optional salted sha256 of the client IP. The raw IP is never stored. Used only to show a learner '
  'their own sessions and to rate-limit abuse.';
COMMENT ON COLUMN prl.sessions.user_agent_hash IS
  'Optional salted sha256 of the user agent. The raw user agent is never stored.';
COMMENT ON COLUMN prl.sessions.updated_at IS
  'Doubles as "last touched": bumped by the trigger whenever the session is refreshed or revoked.';

-- -----------------------------------------------------------------------------
-- oidc_login_attempts
--
-- One row per outbound authorization request, holding only digests of the three
-- single-use secrets: state (CSRF), nonce (ID-token replay) and the PKCE code
-- verifier. Storing the verifier itself would mean a database read could
-- complete somebody else's login, so the callback re-derives the digest from the
-- value it holds in the cookie and compares.
--
-- Single use is enforced by the consume UPDATE, not by trust:
--   UPDATE prl.oidc_login_attempts SET consumed_at = now()
--    WHERE state_hash = $1 AND consumed_at IS NULL AND expires_at > now()
--   RETURNING id;
-- No row returned means the state was unknown, expired or already used, and the
-- callback fails closed. state_hash is globally unique (0002), so a replayed
-- state cannot create a second attempt to consume.
-- -----------------------------------------------------------------------------
CREATE TABLE prl.oidc_login_attempts (
  id                  prl.prefixed_id PRIMARY KEY
                        CONSTRAINT oidc_login_attempts_id_prefix CHECK (id ~ '^oidc_'),
  state_hash          prl.sha256_hash NOT NULL,
  nonce_hash          prl.sha256_hash NOT NULL,
  pkce_verifier_hash  prl.sha256_hash NOT NULL,

  -- Where to send the learner after a successful login. Constrained to a
  -- site-relative path that does not start with "//" or "/\", because those are
  -- read as scheme-relative URLs by browsers and turn a stored redirect into an
  -- open redirect. The character class excludes both backslash and colon, so a
  -- full URL cannot be smuggled in either.
  redirect_after      text NULL
                        CONSTRAINT oidc_login_attempts_redirect_is_local CHECK (
                          redirect_after IS NULL
                          OR (
                            char_length(redirect_after) <= 512
                            AND redirect_after ~ '^/[A-Za-z0-9/_.~%?&=+,;@!$*()-]*$'
                            AND redirect_after NOT LIKE '//%'
                          )
                        ),
  expires_at          timestamptz NOT NULL,
  consumed_at         timestamptz NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT oidc_login_attempts_expires_after_creation CHECK (expires_at > created_at),
  CONSTRAINT oidc_login_attempts_consumed_after_creation CHECK (
    consumed_at IS NULL OR consumed_at >= created_at
  )
);

COMMENT ON TABLE prl.oidc_login_attempts IS
  'Single-use CSRF and replay protection for an OIDC login. Holds digests only: state, nonce and PKCE '
  'verifier plaintext are never stored. Rows are swept once expires_at has passed.';

-- -----------------------------------------------------------------------------
-- rooms
--
-- A room is a private table of 2-6 seats. `visibility` has exactly one allowed
-- value, 'invite_only'. That is not an oversight and not a placeholder: there is
-- no public matchmaking in this product until moderation and anti-abuse review
-- pass, and a CHECK with a single member means shipping public rooms requires a
-- migration, a review and a decision rather than one UPDATE.
--
-- invite_code_hash stores sha256(code). The code is shown to the room owner once
-- and never stored, so a database read cannot join a stranger's room.
-- -----------------------------------------------------------------------------
CREATE TABLE prl.rooms (
  id                      prl.prefixed_id PRIMARY KEY
                            CONSTRAINT rooms_id_prefix CHECK (id ~ '^room_'),
  name                    text NOT NULL
                            CONSTRAINT rooms_name_shape CHECK (
                              char_length(name) BETWEEN 2 AND 48 AND name = btrim(name)
                            ),
  -- RESTRICT, not CASCADE: a room holds other learners' hand history, so
  -- removing the owner must be an explicit, ordered operation that decides what
  -- happens to that history, never a side effect of one DELETE.
  owner_user_id           prl.prefixed_id NOT NULL
                            REFERENCES prl.users (id) ON DELETE RESTRICT,
  invite_code_hash        prl.sha256_hash NOT NULL,
  max_seats               int NOT NULL
                            CONSTRAINT rooms_max_seats_range CHECK (max_seats BETWEEN 2 AND 6),
  small_blind             int NOT NULL
                            CONSTRAINT rooms_small_blind_positive CHECK (small_blind > 0),
  big_blind               int NOT NULL
                            CONSTRAINT rooms_big_blind_positive CHECK (big_blind > 0),
  ante                    int NOT NULL DEFAULT 0
                            CONSTRAINT rooms_ante_range CHECK (ante >= 0),
  starting_stack          int NOT NULL
                            CONSTRAINT rooms_starting_stack_positive CHECK (starting_stack > 0),
  action_timeout_seconds  int NOT NULL
                            CONSTRAINT rooms_action_timeout_range CHECK (
                              action_timeout_seconds BETWEEN 5 AND 300
                            ),
  visibility              text NOT NULL DEFAULT 'invite_only'
                            CONSTRAINT rooms_visibility_invite_only CHECK (visibility = 'invite_only'),
  status                  text NOT NULL DEFAULT 'open'
                            CONSTRAINT rooms_status_allowed CHECK (status IN ('open', 'playing', 'closed')),
  closed_at               timestamptz NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT rooms_big_blind_above_small_blind CHECK (big_blind > small_blind),
  CONSTRAINT rooms_ante_within_big_blind CHECK (ante <= big_blind),
  -- A stack that cannot cover the big blind produces a table where the first
  -- forced bet is already all-in, which teaches nothing about betting.
  CONSTRAINT rooms_stack_covers_blinds CHECK (starting_stack >= big_blind * 2),
  CONSTRAINT rooms_closed_at_matches_status CHECK ((status = 'closed') = (closed_at IS NOT NULL))
);

COMMENT ON TABLE prl.rooms IS
  'A private, invite-only table. Blinds, antes and stacks are counts of valueless practice units; '
  'nothing in this schema converts them to or from money.';
COMMENT ON COLUMN prl.rooms.visibility IS
  'Deliberately constrained to ''invite_only''. Public matchmaking is blocked pending moderation and '
  'anti-abuse review, and unblocking it requires a migration.';
COMMENT ON COLUMN prl.rooms.invite_code_hash IS
  'sha256(invite code). The code itself is never stored. Unique (0002): a generator collision must '
  'retry rather than resolve ambiguously.';

-- -----------------------------------------------------------------------------
-- room_members
--
-- Seats are 0-based and bounded by the room's max_seats, which a CHECK cannot
-- see across tables; the repository layer validates seat < rooms.max_seats on
-- every seat assignment. The two partial unique indexes in 0002 are the part
-- that must be airtight: one live member per seat, one live membership per user.
--
-- Bots get real user rows so that seat identity, hand history and action logs
-- have exactly one shape whether a human or a bot occupies the seat. `is_bot`
-- and `bot_profile` describe how the seat decides, never whether it exists.
-- -----------------------------------------------------------------------------
CREATE TABLE prl.room_members (
  id           prl.prefixed_id PRIMARY KEY
                 CONSTRAINT room_members_id_prefix CHECK (id ~ '^mem_'),
  room_id      prl.prefixed_id NOT NULL
                 REFERENCES prl.rooms (id) ON DELETE CASCADE,
  user_id      prl.prefixed_id NOT NULL
                 REFERENCES prl.users (id) ON DELETE RESTRICT,
  seat         int NULL
                 CONSTRAINT room_members_seat_range CHECK (seat IS NULL OR seat BETWEEN 0 AND 5),
  stack        int NOT NULL
                 CONSTRAINT room_members_stack_non_negative CHECK (stack >= 0),
  is_bot       boolean NOT NULL DEFAULT false,
  -- OpponentProfile from packages/contracts/src/content-types.ts.
  bot_profile  text NULL
                 CONSTRAINT room_members_bot_profile_allowed CHECK (
                   bot_profile IS NULL
                   OR bot_profile IN (
                     'nit', 'tight-aggressive', 'loose-aggressive', 'calling-station', 'maniac', 'unknown'
                   )
                 ),
  joined_at    timestamptz NOT NULL DEFAULT now(),
  left_at      timestamptz NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT room_members_bot_profile_iff_bot CHECK ((bot_profile IS NOT NULL) = is_bot),
  CONSTRAINT room_members_left_after_joined CHECK (left_at IS NULL OR left_at >= joined_at)
);

COMMENT ON TABLE prl.room_members IS
  'A seat occupancy. left_at IS NULL means still at the table; the partial unique indexes in 0002 keep '
  'one live member per seat and per user.';

-- -----------------------------------------------------------------------------
-- hands
--
-- ###########################################################################
-- # THERE IS NO COLUMN FOR THE DECK AND NO COLUMN FOR THE COMMITMENT SALTS. #
-- ###########################################################################
--
-- The full deck and the per-position Merkle salts must never be persisted,
-- because a database read would then expose the undealt cards of a live hand and
-- the unshown hole cards of completed hands. Both live only in the server
-- process's HandState (packages/poker-engine/src/types.ts marks deck, deckCursor
-- and deckSalts as the hand's secrets) and both die with the hand.
--
-- What is stored instead is the Merkle root, which is a commitment: it proves
-- the deck order was fixed before the first action without revealing a single
-- card. After the hand, `reveal` carries proofs for exactly the cards that
-- legitimately became public - the board, plus the hole cards of seats that
-- actually showed. Everything else stays sealed forever, including from us.
-- See packages/poker-engine/src/commitment.ts.
--
-- The consequence is deliberate: an interrupted hand cannot be resumed from the
-- database after a server restart. Losing an in-flight hand is a far cheaper
-- failure than a schema that can leak the cards nobody was entitled to see.
-- -----------------------------------------------------------------------------
CREATE TABLE prl.hands (
  id                  prl.prefixed_id PRIMARY KEY
                        CONSTRAINT hands_id_prefix CHECK (id ~ '^hand_'),
  room_id             prl.prefixed_id NOT NULL
                        REFERENCES prl.rooms (id) ON DELETE CASCADE,
  hand_number         int NOT NULL
                        CONSTRAINT hands_hand_number_positive CHECK (hand_number >= 1),
  button_seat         int NOT NULL
                        CONSTRAINT hands_button_seat_range CHECK (button_seat BETWEEN 0 AND 5),

  -- TableConfig, snapshotted per hand. The room's settings may change later;
  -- what a hand was played under must never change retroactively, or a replay
  -- would be a replay of a different game.
  config              jsonb NOT NULL
                        CONSTRAINT hands_config_shape CHECK (
                          jsonb_typeof(config) = 'object'
                          AND config ?& array[
                            'smallBlind', 'bigBlind', 'ante', 'maxSeats', 'actionTimeoutSeconds'
                          ]
                        ),

  commitment_root     text NOT NULL
                        CONSTRAINT hands_commitment_root_shape CHECK (commitment_root ~ '^[0-9a-f]{64}$'),
  commitment_context  text NOT NULL
                        CONSTRAINT hands_commitment_context_shape CHECK (
                          char_length(commitment_context) BETWEEN 1 AND 200
                        ),
  -- Recorded permanently so a hand can never silently look like a fairly dealt
  -- one when it was not.
  random_source_kind  text NOT NULL
                        CONSTRAINT hands_random_source_kind_allowed CHECK (
                          random_source_kind IN ('csprng', 'deterministic-test-only', 'fixed-deck-scenario')
                        ),

  board               jsonb NOT NULL DEFAULT '[]'::jsonb
                        CONSTRAINT hands_board_is_cards CHECK (prl.is_card_notation_array(board, 0, 5)),
  street              text NOT NULL
                        CONSTRAINT hands_street_allowed CHECK (
                          street IN ('preflop', 'flop', 'turn', 'river', 'showdown', 'complete')
                        ),
  result              jsonb NULL
                        CONSTRAINT hands_result_shape CHECK (
                          result IS NULL
                          OR (
                            jsonb_typeof(result) = 'object'
                            AND result ?& array[
                              'showdowns', 'pots', 'awards', 'netBySeat', 'endedByFold', 'reveal'
                            ]
                          )
                        ),
  reveal              jsonb NULL
                        CONSTRAINT hands_reveal_shape CHECK (
                          reveal IS NULL
                          OR (
                            jsonb_typeof(reveal) = 'object'
                            AND reveal ?& array['commitment', 'cards', 'complete']
                          )
                        ),
  started_at          timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  -- A hand is over exactly when the engine says 'complete', and a completed hand
  -- always has its result. Either half alone would let a half-settled hand sit
  -- in the table looking finished to one query and live to another.
  CONSTRAINT hands_completed_iff_street_complete CHECK ((street = 'complete') = (completed_at IS NOT NULL)),
  CONSTRAINT hands_result_iff_completed CHECK ((result IS NOT NULL) = (completed_at IS NOT NULL)),
  CONSTRAINT hands_completed_after_start CHECK (completed_at IS NULL OR completed_at >= started_at),

  -- A "complete" reveal is every one of the 52 positions. commitment.ts allows
  -- that only for an explicit end-of-session audit, never for a hand, because a
  -- whole-deck reveal exposes the folded hole cards the whole scheme exists to
  -- protect. Enforced here so no code path, however well-intentioned, can
  -- persist one against a hand row. coalesce() makes a missing flag a violation
  -- rather than a pass.
  CONSTRAINT hands_reveal_is_never_complete CHECK (
    reveal IS NULL OR coalesce(reveal -> 'complete', 'null'::jsonb) = 'false'::jsonb
  ),
  CONSTRAINT hands_result_reveal_is_never_complete CHECK (
    result IS NULL OR coalesce(result #> '{reveal,complete}', 'null'::jsonb) = 'false'::jsonb
  ),

  -- The two constraints above trust one boolean. `complete` is set by the engine
  -- (revealPositions() in commitment.ts computes it as "did I reveal all 52
  -- positions?"), and a flag is only ever as honest as the code that writes it: a
  -- reveal carrying every leaf - every card AND every salt - while reporting
  -- complete=false would satisfy every other constraint in this table. That is
  -- exactly the whole-deck dump the schema exists to make impossible, so it gets a
  -- second check that counts rather than asks.
  --
  -- The ceiling is arithmetic, not a guess. A hand can only ever prove cards that
  -- legitimately became public: at most 5 board cards, plus 2 hole cards for each
  -- of at most 6 seats (rooms_max_seats_range, hand_seats_seat_range). 5 + 12 = 17.
  -- There are no burn cards - see machine.ts, which advances the board straight off
  -- the deck cursor - so nothing else can be in there.
  --
  -- coalesce() again, for the reason given above: a missing or non-array `cards`
  -- must be a violation rather than a NULL that a CHECK reads as satisfied.
  CONSTRAINT hands_reveal_proves_at_most_the_public_cards CHECK (
    reveal IS NULL
    OR (
      coalesce(jsonb_typeof(reveal -> 'cards'), 'missing') = 'array'
      AND jsonb_array_length(reveal -> 'cards') <= 17
    )
  ),
  CONSTRAINT hands_result_reveal_proves_at_most_the_public_cards CHECK (
    result IS NULL
    OR (
      coalesce(jsonb_typeof(result #> '{reveal,cards}'), 'missing') = 'array'
      AND jsonb_array_length(result #> '{reveal,cards}') <= 17
    )
  )
);

COMMENT ON TABLE prl.hands IS
  'One dealt hand. There is deliberately NO column for the deck and NO column for the commitment salts: '
  'persisting either would let a database read expose the undealt cards of a live hand and the unshown '
  'hole cards of completed hands. Only the Merkle root is stored, plus proofs for the cards that '
  'legitimately became public.';
COMMENT ON COLUMN prl.hands.commitment_root IS
  'Hex sha256 Merkle root over all 64 padded deck leaves, published before the first action. Proves the '
  'deck order was fixed in advance without revealing any card.';
COMMENT ON COLUMN prl.hands.reveal IS
  'DeckReveal covering only the board cards and the hole cards of seats that showed down. Each proof '
  'carries the per-position salt for a card that is already public, which is what makes it verifiable; '
  'the salts of unrevealed positions are never written anywhere. Never a complete reveal - see '
  'constraints hands_reveal_is_never_complete and hands_reveal_proves_at_most_the_public_cards.';

-- -----------------------------------------------------------------------------
-- hand_seats
--
-- One row per seat that was part of a hand. Two columns are nullable for reasons
-- worth stating: `hole_cards` because a seat sitting out was never dealt any, and
-- `net_result` because what a seat won or lost is not known until the hand
-- settles, and writing a placeholder 0 in the meantime would make an unfinished
-- hand indistinguishable from a break-even one.
--
-- The read rule on `hole_cards` is the most important thing in this table; it is
-- spelled out in the column comment below because it is the kind of rule that
-- gets broken by a well-meaning `SELECT *`.
-- -----------------------------------------------------------------------------
CREATE TABLE prl.hand_seats (
  id              prl.prefixed_id PRIMARY KEY
                    CONSTRAINT hand_seats_id_prefix CHECK (id ~ '^hseat_'),
  hand_id         prl.prefixed_id NOT NULL
                    REFERENCES prl.hands (id) ON DELETE CASCADE,
  seat            int NOT NULL
                    CONSTRAINT hand_seats_seat_range CHECK (seat BETWEEN 0 AND 5),
  -- SET NULL, not CASCADE: deleting an account must not delete the other seats'
  -- record of the hand. The seat survives with its identity detached.
  user_id         prl.prefixed_id NULL
                    REFERENCES prl.users (id) ON DELETE SET NULL,
  is_bot          boolean NOT NULL DEFAULT false,
  starting_stack  int NOT NULL
                    CONSTRAINT hand_seats_starting_stack_non_negative CHECK (starting_stack >= 0),
  hole_cards      jsonb NULL
                    CONSTRAINT hand_seats_hole_cards_are_two_cards CHECK (
                      hole_cards IS NULL OR prl.is_card_notation_array(hole_cards, 2, 2)
                    ),
  net_result      int NULL,
  -- SeatStatus from packages/poker-engine/src/types.ts, casing included.
  status          text NOT NULL
                    CONSTRAINT hand_seats_status_allowed CHECK (
                      status IN ('active', 'folded', 'allIn', 'sittingOut')
                    ),
  showed_down     boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE prl.hand_seats IS
  'One seat in one hand, with the cards it was dealt and what it won or lost.';
COMMENT ON COLUMN prl.hand_seats.hole_cards IS
  'Written at hand start. MUST only ever be SELECTed for the owning user, or for any user once '
  'showed_down is true. There is no way to express that as a constraint, so it is enforced in the '
  'repository layer: every read path filters on user_id = :viewer OR showed_down, and '
  'packages/poker-engine/test/hidden-information.test.ts guards the equivalent rule in the engine. A '
  'query that selects hole_cards without that predicate is a hidden-information leak, not a performance '
  'shortcut.';
COMMENT ON COLUMN prl.hand_seats.net_result IS
  'Chips won minus chips committed, for this seat in this hand. A count of practice units, not a balance.';

-- -----------------------------------------------------------------------------
-- hand_actions
--
-- Append-only. Rows are never updated and never deleted: this is the hand's
-- audit trail, and the runtime role holds only INSERT and SELECT on it.
--
-- `action_id` is the client-generated id from SubmittedAction. The partial
-- unique index in 0002 is the database-level idempotency guarantee - see the
-- comment there.
-- -----------------------------------------------------------------------------
CREATE TABLE prl.hand_actions (
  id               prl.prefixed_id PRIMARY KEY
                     CONSTRAINT hand_actions_id_prefix CHECK (id ~ '^act_'),
  hand_id          prl.prefixed_id NOT NULL
                     REFERENCES prl.hands (id) ON DELETE CASCADE,
  sequence         int NOT NULL
                     CONSTRAINT hand_actions_sequence_positive CHECK (sequence >= 1),
  -- BettingStreet: showdown and complete are not streets anyone acts on.
  street           text NOT NULL
                     CONSTRAINT hand_actions_street_allowed CHECK (
                       street IN ('preflop', 'flop', 'turn', 'river')
                     ),
  seat             int NOT NULL
                     CONSTRAINT hand_actions_seat_range CHECK (seat BETWEEN 0 AND 5),
  action_type      text NOT NULL
                     CONSTRAINT hand_actions_action_type_allowed CHECK (
                       action_type IN ('fold', 'check', 'call', 'bet', 'raise')
                     ),
  -- "raise to" semantics: the seat's TOTAL commitment for the street after the
  -- action, not the increment. Only bet and raise carry one.
  action_to        int NULL
                     CONSTRAINT hand_actions_action_to_non_negative CHECK (
                       action_to IS NULL OR action_to >= 0
                     ),
  amount_paid      int NOT NULL
                     CONSTRAINT hand_actions_amount_paid_non_negative CHECK (amount_paid >= 0),
  bet_level_after  int NOT NULL
                     CONSTRAINT hand_actions_bet_level_non_negative CHECK (bet_level_after >= 0),
  pot_after        int NOT NULL
                     CONSTRAINT hand_actions_pot_after_non_negative CHECK (pot_after >= 0),
  was_automatic    boolean NOT NULL DEFAULT false,
  action_id        text NULL
                     CONSTRAINT hand_actions_action_id_shape CHECK (
                       action_id IS NULL OR char_length(action_id) BETWEEN 8 AND 64
                     ),
  created_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT hand_actions_sizing_iff_bet_or_raise CHECK (
    (action_to IS NOT NULL) = (action_type IN ('bet', 'raise'))
  ),
  CONSTRAINT hand_actions_passive_actions_pay_nothing CHECK (
    action_type NOT IN ('fold', 'check') OR amount_paid = 0
  ),
  CONSTRAINT hand_actions_sizing_reaches_bet_level CHECK (
    action_to IS NULL OR action_to <= bet_level_after
  )
);

COMMENT ON TABLE prl.hand_actions IS
  'Append-only log of every action in a hand, in sequence order. Never updated, never deleted: the '
  'runtime role holds INSERT and SELECT only.';
COMMENT ON COLUMN prl.hand_actions.action_to IS
  '"Raise to" semantics: the seat''s total commitment for the street after the action, not the increment.';
COMMENT ON COLUMN prl.hand_actions.was_automatic IS
  'True when the server acted for a player whose action timer expired (check if legal, otherwise fold).';
COMMENT ON COLUMN prl.hand_actions.action_id IS
  'Client-generated id, stable across retries. Unique per hand where present (0002) - that index is the '
  'idempotency guarantee.';

-- -----------------------------------------------------------------------------
-- lesson_progress
--
-- lesson_id is validated but NOT a foreign key, and there is no `lessons` table.
-- Content ships in code (packages/content), version-controlled and tested
-- against the maths, precisely so a lesson's claims cannot drift from what
-- @prl/poker-math computes. Mirroring it into rows would create a second source
-- of truth that no test covers. The consequence is that progress rows can
-- outlive the content they point at, so read paths must tolerate an unknown
-- lesson_id rather than assume a join succeeds.
-- -----------------------------------------------------------------------------
CREATE TABLE prl.lesson_progress (
  id              prl.prefixed_id PRIMARY KEY
                    CONSTRAINT lesson_progress_id_prefix CHECK (id ~ '^lprog_'),
  user_id         prl.prefixed_id NOT NULL
                    REFERENCES prl.users (id) ON DELETE CASCADE,
  lesson_id       prl.content_id NOT NULL,
  completed_at    timestamptz NULL,
  last_viewed_at  timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE prl.lesson_progress IS
  'Which lessons a learner has opened and finished. Unique per (user_id, lesson_id) - see 0002. No '
  'ordering, no gating, no completion percentage: reading a lesson twice is not worth less than reading '
  'it once.';

-- -----------------------------------------------------------------------------
-- quiz_attempts
--
-- One row per answered question. There is deliberately NO aggregate score
-- column, no streak, no best-run, no pass flag and no percentage. Quizzes exist
-- to surface reasoning, and a stored score turns them into something to protect
-- - which is exactly the pressure this product refuses to create. Anything a
-- learner wants to know about their own history can be derived from these rows
-- at read time, by a query that can be changed without a migration.
--
-- `answer` is the learner's own submission, whatever shape the question takes.
-- `was_correct` is the app's comparison of that submission against a value
-- computed at runtime by @prl/poker-math. The expected value itself is never
-- stored: a stored answer key would be a number that can silently disagree with
-- the maths, and it would be the learner who paid for the disagreement.
-- -----------------------------------------------------------------------------
CREATE TABLE prl.quiz_attempts (
  id           prl.prefixed_id PRIMARY KEY
                 CONSTRAINT quiz_attempts_id_prefix CHECK (id ~ '^qatt_'),
  user_id      prl.prefixed_id NOT NULL
                 REFERENCES prl.users (id) ON DELETE CASCADE,
  quiz_id      prl.content_id NOT NULL,
  question_id  prl.content_id NOT NULL,
  answer       jsonb NOT NULL
                 CONSTRAINT quiz_attempts_answer_is_object CHECK (jsonb_typeof(answer) = 'object'),
  was_correct  boolean NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE prl.quiz_attempts IS
  'One answered quiz question. Append-only. No aggregate score, streak or pass column exists by design; '
  'see docs/PRODUCT-GUARDRAILS.md.';
COMMENT ON COLUMN prl.quiz_attempts.answer IS
  'The learner''s own submission. The expected value is computed at runtime by @prl/poker-math and '
  'never stored.';

-- -----------------------------------------------------------------------------
-- scenario_attempts
--
-- `matched_expected` is nullable on purpose. Plenty of Scenario Lab spots have
-- no single defensible answer - they turn on a range assumption the learner is
-- free to disagree with - and NULL records "this scenario makes no claim about
-- one correct action" rather than silently scoring a judgement call as wrong.
-- -----------------------------------------------------------------------------
CREATE TABLE prl.scenario_attempts (
  id                prl.prefixed_id PRIMARY KEY
                      CONSTRAINT scenario_attempts_id_prefix CHECK (id ~ '^satt_'),
  user_id           prl.prefixed_id NOT NULL
                      REFERENCES prl.users (id) ON DELETE CASCADE,
  scenario_id       prl.content_id NOT NULL,
  -- The engine's Action union: {type} plus {to} for bet and raise.
  chosen_action     jsonb NOT NULL
                      CONSTRAINT scenario_attempts_chosen_action_shape CHECK (
                        jsonb_typeof(chosen_action) = 'object'
                        AND chosen_action ->> 'type' IN ('fold', 'check', 'call', 'bet', 'raise')
                      ),
  matched_expected  boolean NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE prl.scenario_attempts IS
  'One decision made in the Scenario Lab. Append-only.';
COMMENT ON COLUMN prl.scenario_attempts.matched_expected IS
  'NULL when the scenario deliberately makes no claim about a single correct action. Never a score.';

-- -----------------------------------------------------------------------------
-- audit_log
--
-- Security-relevant events only, append-only, and pre-redacted by the caller.
-- The CHECK below refuses a top-level detail key that names something this
-- schema promises never to store. It cannot see inside nested objects, so it is
-- a backstop for the obvious mistake, not a substitute for redacting at the
-- boundary.
-- -----------------------------------------------------------------------------
CREATE TABLE prl.audit_log (
  id          prl.prefixed_id PRIMARY KEY
                CONSTRAINT audit_log_id_prefix CHECK (id ~ '^aud_'),
  user_id     prl.prefixed_id NULL
                REFERENCES prl.users (id) ON DELETE SET NULL,
  event       text NOT NULL
                CONSTRAINT audit_log_event_shape CHECK (
                  char_length(event) BETWEEN 3 AND 64
                  AND event ~ '^[a-z0-9]+([.][a-z0-9_]+)*$'
                ),
  detail      jsonb NULL
                CONSTRAINT audit_log_detail_is_object CHECK (
                  detail IS NULL OR jsonb_typeof(detail) = 'object'
                ),
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT audit_log_detail_has_no_forbidden_keys CHECK (
    detail IS NULL
    OR NOT (detail ?| array[
      'token', 'sessionToken', 'password', 'secret', 'authorization', 'cookie',
      'ip', 'ipAddress', 'userAgent', 'inviteCode', 'deck', 'salt', 'salts', 'holeCards'
    ])
  )
);

COMMENT ON TABLE prl.audit_log IS
  'Append-only record of security-relevant events. Detail must be pre-redacted: no tokens, no raw IPs '
  'or user agents, no invite codes, no deck, salts or hole cards.';

-- -----------------------------------------------------------------------------
-- updated_at triggers, on exactly the tables that have the column.
-- -----------------------------------------------------------------------------
CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON prl.users
  FOR EACH ROW EXECUTE FUNCTION prl.set_updated_at();
CREATE TRIGGER sessions_set_updated_at BEFORE UPDATE ON prl.sessions
  FOR EACH ROW EXECUTE FUNCTION prl.set_updated_at();
CREATE TRIGGER oidc_login_attempts_set_updated_at BEFORE UPDATE ON prl.oidc_login_attempts
  FOR EACH ROW EXECUTE FUNCTION prl.set_updated_at();
CREATE TRIGGER rooms_set_updated_at BEFORE UPDATE ON prl.rooms
  FOR EACH ROW EXECUTE FUNCTION prl.set_updated_at();
CREATE TRIGGER room_members_set_updated_at BEFORE UPDATE ON prl.room_members
  FOR EACH ROW EXECUTE FUNCTION prl.set_updated_at();
CREATE TRIGGER hands_set_updated_at BEFORE UPDATE ON prl.hands
  FOR EACH ROW EXECUTE FUNCTION prl.set_updated_at();
CREATE TRIGGER hand_seats_set_updated_at BEFORE UPDATE ON prl.hand_seats
  FOR EACH ROW EXECUTE FUNCTION prl.set_updated_at();
CREATE TRIGGER lesson_progress_set_updated_at BEFORE UPDATE ON prl.lesson_progress
  FOR EACH ROW EXECUTE FUNCTION prl.set_updated_at();

-- =============================================================================
-- Least privilege.
--
-- prl_app is the role the API connects as. It gets USAGE on the schema and the
-- narrowest verb set per table that the request path actually needs. It is
-- never granted, and must never be granted:
--
--   CREATE      - it cannot add or alter objects; migrations do that.
--   TRUNCATE    - one statement must not be able to empty a table.
--   REFERENCES  - it cannot attach foreign keys to app tables.
--   TRIGGER     - it cannot attach code that runs on other roles' writes.
--   ownership   - it cannot DROP, ALTER or re-grant anything.
--
-- The verb matrix, and why:
--
--   users                SELECT INSERT UPDATE DELETE  sign-up, rename, guest sweep,
--                                                     and a learner's right to delete
--   sessions             SELECT INSERT UPDATE DELETE  login, refresh, revoke, expiry sweep
--   oidc_login_attempts  SELECT INSERT UPDATE DELETE  start, single-use consume, sweep
--   rooms                SELECT INSERT UPDATE         create, play, close. No DELETE:
--                                                     closing a room is a status change,
--                                                     and its hands are history
--   room_members         SELECT INSERT UPDATE         join, re-seat, leave (left_at)
--   hands                SELECT INSERT UPDATE         deal, advance, settle. No DELETE
--   hand_seats           SELECT INSERT UPDATE         deal, show down, settle. No DELETE
--   hand_actions         SELECT INSERT                append-only audit trail
--   lesson_progress      SELECT INSERT UPDATE DELETE  a learner may clear their progress
--   quiz_attempts        SELECT INSERT                append-only
--   scenario_attempts    SELECT INSERT                append-only
--   audit_log            SELECT INSERT                append-only; a role that can edit
--                                                     the audit log has no audit log
--
-- Note that prl_app is granted nothing at all on prl.schema_migrations: the
-- runtime has no business reading, let alone editing, the migration ledger.
-- =============================================================================

REVOKE ALL ON SCHEMA prl FROM PUBLIC;
GRANT USAGE ON SCHEMA prl TO prl_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON prl.users               TO prl_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON prl.sessions            TO prl_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON prl.oidc_login_attempts TO prl_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON prl.lesson_progress     TO prl_app;

GRANT SELECT, INSERT, UPDATE ON prl.rooms        TO prl_app;
GRANT SELECT, INSERT, UPDATE ON prl.room_members TO prl_app;
GRANT SELECT, INSERT, UPDATE ON prl.hands        TO prl_app;
GRANT SELECT, INSERT, UPDATE ON prl.hand_seats   TO prl_app;

GRANT SELECT, INSERT ON prl.hand_actions      TO prl_app;
GRANT SELECT, INSERT ON prl.quiz_attempts     TO prl_app;
GRANT SELECT, INSERT ON prl.scenario_attempts TO prl_app;
GRANT SELECT, INSERT ON prl.audit_log         TO prl_app;

-- Both helper functions get an ACL spelled out here rather than an inherited one.
-- PostgreSQL grants EXECUTE on a new function to PUBLIC, which for functions that
-- exist only to be called from a CHECK constraint and a trigger is a privilege
-- nobody asked for.
REVOKE ALL ON FUNCTION prl.set_updated_at() FROM PUBLIC;
REVOKE ALL ON FUNCTION prl.is_card_notation_array(jsonb, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION prl.set_updated_at() TO prl_app;
GRANT EXECUTE ON FUNCTION prl.is_card_notation_array(jsonb, int, int) TO prl_app;

-- -----------------------------------------------------------------------------
-- Default privileges for objects a FUTURE migration creates.
--
-- Nothing is needed for tables and sequences: PostgreSQL's built-in default is
-- already owner-only, so a table added by a later migration grants prl_app
-- nothing at all until that migration says so in as many words.
--
-- New FUNCTIONS are the exception - EXECUTE goes to PUBLIC - so that default is
-- suppressed below.
--
-- Note the absence of `IN SCHEMA prl`, which is not an oversight. A built-in
-- default has no pg_default_acl row behind it, so a schema-scoped REVOKE has no
-- prior grant to remove and does nothing whatsoever: `\ddp` stays empty and every
-- new function still hands EXECUTE to PUBLIC. Only the database-wide form records
-- the entry that actually suppresses it. With the line below in place, a function
-- created by prl_migrator has the ACL {prl_migrator=X/prl_migrator} and nothing
-- more, which is exactly the point.
--
-- Types are left alone deliberately: revoking USAGE on future types from PUBLIC
-- would make a new domain silently unusable by prl_app, and a schema that fails
-- at runtime for a privilege nobody thought about is worse than one that grants
-- the ability to name a type.
-- -----------------------------------------------------------------------------
ALTER DEFAULT PRIVILEGES FOR ROLE prl_migrator REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

RESET ROLE;

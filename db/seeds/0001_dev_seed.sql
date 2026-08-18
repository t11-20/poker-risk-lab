-- =============================================================================
-- 0001_dev_seed.sql - development data.
--
-- Applied by `pnpm db:seed`, which refuses to run when NODE_ENV=production.
-- Seeds are not recorded in prl.schema_migrations, so this file has to be
-- re-runnable: every statement ends in ON CONFLICT (id) DO NOTHING and every id
-- is fixed and carries a `devseed` marker, which also makes the whole seed
-- removable with a dozen DELETEs if it ever needs to be.
--
-- ## What this file deliberately does not contain
--
-- No session rows. A seeded session would mean committing a working credential
-- to version control, and "it is only the dev database" is how that credential
-- ends up pasted at a staging URL. Log in as a guest instead; that path is one
-- request.
--
-- No plaintext secrets. The room invite code is written as
-- sha256(convert_to(<code>, 'utf8')) so the code appears in this file only as
-- the input to a digest, exactly as the application stores it. sha256() has been
-- built into PostgreSQL since 11, so this needs no extension.
--
-- No computed poker figures. There is no equity, no pot odds, no EV and no
-- rule-of-2-and-4 estimate anywhere below, because there is nowhere in the schema
-- to put one. Every number here defines the situation - blinds, stacks, bet
-- sizes, pot sizes, card identities - and the app derives the rest at runtime
-- with @prl/poker-math.
--
-- ## The seeded hand, and one honest caveat
--
-- The hand below is a preflop walk: UTG raises to 6, everyone folds, no board is
-- dealt and nobody shows. That was chosen because it is the one hand shape whose
-- DeckReveal is legitimately empty - no board card and no shown holding ever
-- became public, so there is nothing that ought to be proved, and `cards: []` is
-- the correct reveal rather than a convenient one.
--
-- The caveat: `commitment_root` below is a well-formed digest but not a real
-- Merkle root, because there is no deck behind it - the deck and the salts are
-- never persisted (see the comment on prl.hands), so a seed file cannot produce a
-- verifiable one. That is why random_source_kind is 'fixed-deck-scenario' and not
-- 'csprng': the row states outright that it was not dealt by the shuffler. A
-- client that verifies this hand will correctly report a mismatch. Deal a hand
-- through the server to exercise the fairness proof; this row exists to give the
-- history and replay views something to render.
--
-- Chips are practice units: free, resettable and worth nothing. The stacks below
-- sum to 4 x 200 after the hand, because chips move between seats and never
-- appear or vanish.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Learners. Two humans and two bots.
--
-- Bots get real user rows so a seat is a seat whoever occupies it: the same
-- membership, hand-seat and action shapes apply, and no query needs a special
-- case for "this seat has no user".
-- -----------------------------------------------------------------------------
INSERT INTO prl.users (id, kind, display_name, oidc_issuer, oidc_subject, last_seen_at)
VALUES
  ('usr_devseed_alice', 'guest', 'Alice (guest)', NULL, NULL, now() - interval '5 minutes'),
  -- A federated account. The issuer uses the reserved .invalid TLD so nothing
  -- here can accidentally resolve to a real identity provider.
  ('usr_devseed_borys', 'oidc', 'Borys', 'https://issuer.dev.invalid', 'devseed-subject-borys',
   now() - interval '2 hours'),
  ('usr_devseed_bot_nit', 'guest', 'Rock (bot)', NULL, NULL, now()),
  ('usr_devseed_bot_tag', 'guest', 'Hammer (bot)', NULL, NULL, now())
ON CONFLICT (id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- One private room.
--
-- The invite code in this development database is:  PRL-DEV-ROOM-1
-- Only its digest is stored, which is the whole point of the column.
-- -----------------------------------------------------------------------------
INSERT INTO prl.rooms (
  id, name, owner_user_id, invite_code_hash, max_seats,
  small_blind, big_blind, ante, starting_stack, action_timeout_seconds,
  visibility, status, closed_at
)
VALUES (
  'room_devseed_home',
  'Kitchen table',
  'usr_devseed_alice',
  sha256(convert_to('PRL-DEV-ROOM-1', 'utf8')),
  6,
  1, 2, 0, 200, 30,
  'invite_only', 'open', NULL
)
ON CONFLICT (id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- Seats. Stacks are as they stand after the seeded hand below:
-- seat 0 folded the button for nothing, seat 1 lost the small blind, seat 2 lost
-- the big blind, seat 3 raised to 6 and collected the 9 in the middle.
-- 200 + 199 + 198 + 203 = 800, which is 4 x 200. Chips are conserved.
-- -----------------------------------------------------------------------------
INSERT INTO prl.room_members (id, room_id, user_id, seat, stack, is_bot, bot_profile, joined_at, left_at)
VALUES
  ('mem_devseed_alice', 'room_devseed_home', 'usr_devseed_alice', 0, 200, false, NULL,
   now() - interval '1 hour', NULL),
  ('mem_devseed_borys', 'room_devseed_home', 'usr_devseed_borys', 1, 199, false, NULL,
   now() - interval '1 hour', NULL),
  ('mem_devseed_bot_nit', 'room_devseed_home', 'usr_devseed_bot_nit', 2, 198, true, 'nit',
   now() - interval '1 hour', NULL),
  ('mem_devseed_bot_tag', 'room_devseed_home', 'usr_devseed_bot_tag', 3, 203, true, 'tight-aggressive',
   now() - interval '1 hour', NULL)
ON CONFLICT (id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- Hand 1: a preflop walk.
--
-- Four seats, button on seat 0, so seat 1 posts the small blind, seat 2 the big
-- blind and seat 3 is first to act. Seat 3 raises to 6, the other three fold,
-- and the hand ends with no board and no showdown.
-- -----------------------------------------------------------------------------
INSERT INTO prl.hands (
  id, room_id, hand_number, button_seat, config,
  commitment_root, commitment_context, random_source_kind,
  board, street, result, reveal, started_at, completed_at
)
VALUES (
  'hand_devseed_0001',
  'room_devseed_home',
  1,
  0,
  jsonb_build_object(
    'smallBlind', 1,
    'bigBlind', 2,
    'ante', 0,
    'maxSeats', 6,
    'actionTimeoutSeconds', 30
  ),
  -- Not a real Merkle root. See the caveat in the header: there is no deck behind
  -- it, and a verifier will say so.
  encode(sha256(convert_to('prl-dev-seed/not-a-real-commitment/hand-1', 'utf8')), 'hex'),
  'prl-dev-seed/room_devseed_home/hand/1 NOT-A-REAL-COMMITMENT',
  'fixed-deck-scenario',
  '[]'::jsonb,
  'complete',
  jsonb_build_object(
    -- Nobody showed, so there is nothing to show.
    'showdowns', '[]'::jsonb,
    'pots', jsonb_build_array(
      jsonb_build_object('amount', 9, 'eligibleSeats', jsonb_build_array(3), 'capPerSeat', 6, 'index', 0)
    ),
    'awards', jsonb_build_array(
      jsonb_build_object(
        'potIndex', 0, 'amount', 9, 'seat', 3, 'playerId', 'usr_devseed_bot_tag',
        'wasSplit', false, 'oddChips', 0
      )
    ),
    -- Seat 3 committed 6 and collected 9; the blinds paid 1 and 2. Sums to zero.
    'netBySeat', jsonb_build_object('0', 0, '1', -1, '2', -2, '3', 3),
    'endedByFold', true,
    'reveal', jsonb_build_object(
      'commitment', jsonb_build_object(
        'algorithm', 'sha256',
        'version', 'prl-deck-v2',
        'root', encode(sha256(convert_to('prl-dev-seed/not-a-real-commitment/hand-1', 'utf8')), 'hex'),
        'context', 'prl-dev-seed/room_devseed_home/hand/1 NOT-A-REAL-COMMITMENT'
      ),
      'cards', '[]'::jsonb,
      'complete', false
    )
  ),
  jsonb_build_object(
    'commitment', jsonb_build_object(
      'algorithm', 'sha256',
      'version', 'prl-deck-v2',
      'root', encode(sha256(convert_to('prl-dev-seed/not-a-real-commitment/hand-1', 'utf8')), 'hex'),
      'context', 'prl-dev-seed/room_devseed_home/hand/1 NOT-A-REAL-COMMITMENT'
    ),
    'cards', '[]'::jsonb,
    'complete', false
  ),
  now() - interval '20 minutes',
  now() - interval '19 minutes'
)
ON CONFLICT (id) DO NOTHING;

-- Hole cards are recorded for every seat, as they are at hand start, and
-- showed_down is false everywhere because the hand ended before a showdown. That
-- combination is exactly what the read rule on prl.hand_seats.hole_cards exists
-- for: these eight cards may be shown to their own seat's user and to nobody
-- else, ever, because nobody paid to see them.
INSERT INTO prl.hand_seats (
  id, hand_id, seat, user_id, is_bot, starting_stack, hole_cards, net_result, status, showed_down
)
VALUES
  ('hseat_devseed_0001_s0', 'hand_devseed_0001', 0, 'usr_devseed_alice', false, 200,
   '["7d", "2c"]'::jsonb, 0, 'folded', false),
  ('hseat_devseed_0001_s1', 'hand_devseed_0001', 1, 'usr_devseed_borys', false, 200,
   '["Jh", "4s"]'::jsonb, -1, 'folded', false),
  ('hseat_devseed_0001_s2', 'hand_devseed_0001', 2, 'usr_devseed_bot_nit', true, 200,
   '["Kc", "9d"]'::jsonb, -2, 'folded', false),
  ('hseat_devseed_0001_s3', 'hand_devseed_0001', 3, 'usr_devseed_bot_tag', true, 200,
   '["Ah", "Ks"]'::jsonb, 3, 'active', false)
ON CONFLICT (id) DO NOTHING;

-- The action log. `pot_after` includes the blinds, which is why the first row is
-- already at 9: 1 + 2 posted, plus the 6 raised. `action_to` is a total for the
-- street, not an increment. The action_ids are the client-generated ones the
-- idempotency index keys on; the bots' actions have them too, because a bot goes
-- through the same submit path as a person.
INSERT INTO prl.hand_actions (
  id, hand_id, sequence, street, seat, action_type,
  action_to, amount_paid, bet_level_after, pot_after, was_automatic, action_id, created_at
)
VALUES
  ('act_devseed_0001_1', 'hand_devseed_0001', 1, 'preflop', 3, 'raise',
   6, 6, 6, 9, false, 'devseed-action-0001-1', now() - interval '20 minutes'),
  ('act_devseed_0001_2', 'hand_devseed_0001', 2, 'preflop', 0, 'fold',
   NULL, 0, 6, 9, false, 'devseed-action-0001-2', now() - interval '20 minutes'),
  -- One automatic action, so the timeout path has something to render: the server
  -- folded for seat 1 when the timer expired. No client submitted it, so there is
  -- no client action_id, which is why the idempotency index is partial.
  ('act_devseed_0001_3', 'hand_devseed_0001', 3, 'preflop', 1, 'fold',
   NULL, 0, 6, 9, true, NULL, now() - interval '19 minutes'),
  ('act_devseed_0001_4', 'hand_devseed_0001', 4, 'preflop', 2, 'fold',
   NULL, 0, 6, 9, false, 'devseed-action-0001-4', now() - interval '19 minutes')
ON CONFLICT (id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- Learning progress.
--
-- These content ids are development placeholders in the slug form of ContentId.
-- Content lives in packages/content, not in the database, so nothing here is a
-- foreign key and nothing here asserts that these lessons exist yet. Read paths
-- must already tolerate a progress row pointing at content that has been renamed
-- or retired, and this seed is one way to find out whether they do.
-- -----------------------------------------------------------------------------
INSERT INTO prl.lesson_progress (id, user_id, lesson_id, completed_at, last_viewed_at)
VALUES
  ('lprog_devseed_alice_pot_odds', 'usr_devseed_alice', 'pot-odds-and-break-even-equity',
   now() - interval '3 days', now() - interval '3 days'),
  ('lprog_devseed_alice_outs', 'usr_devseed_alice', 'counting-outs-and-the-rule-of-2-and-4',
   NULL, now() - interval '10 minutes'),
  ('lprog_devseed_borys_variance', 'usr_devseed_borys', 'variance-and-why-results-lie',
   NULL, now() - interval '2 hours')
ON CONFLICT (id) DO NOTHING;

-- Quiz attempts. `answer` is the learner's own submission and nothing else:
-- there is no stored expected value to compare it against, because the expected
-- value is computed at runtime. `was_correct` is the result of that runtime
-- comparison at the moment of the attempt.
--
-- Note what cannot be seeded here because it does not exist: a score, a streak,
-- a pass mark, a best run. Three attempts at one question is three rows, not a
-- 67%.
INSERT INTO prl.quiz_attempts (id, user_id, quiz_id, question_id, answer, was_correct, created_at)
VALUES
  ('qatt_devseed_alice_1', 'usr_devseed_alice', 'quiz-pot-odds', 'q-break-even-call',
   jsonb_build_object('kind', 'multipleChoice', 'selectedIndex', 2), true, now() - interval '3 days'),
  ('qatt_devseed_alice_2', 'usr_devseed_alice', 'quiz-pot-odds', 'q-facing-a-half-pot-bet',
   jsonb_build_object('kind', 'multipleChoice', 'selectedIndex', 0), false, now() - interval '3 days'),
  -- A numeric question. The value is what this learner typed in - a guess, kept
  -- so they can see their own reasoning later. It is not an answer key, and the
  -- app never reads it as one.
  ('qatt_devseed_alice_3', 'usr_devseed_alice', 'quiz-pot-odds', 'q-equity-needed-to-call',
   jsonb_build_object('kind', 'numeric', 'value', 20, 'unit', 'percent'), false,
   now() - interval '3 days'),
  ('qatt_devseed_borys_1', 'usr_devseed_borys', 'quiz-variance', 'q-what-a-downswing-proves',
   jsonb_build_object('kind', 'multipleChoice', 'selectedIndex', 1), true, now() - interval '2 hours')
ON CONFLICT (id) DO NOTHING;

-- Scenario Lab decisions. The third row has matched_expected NULL: that scenario
-- turns on a range assumption a learner may reasonably reject, so it makes no
-- claim about a single correct action and the seed records that honestly instead
-- of marking a judgement call wrong.
INSERT INTO prl.scenario_attempts (id, user_id, scenario_id, chosen_action, matched_expected, created_at)
VALUES
  ('satt_devseed_alice_1', 'usr_devseed_alice', 'flush-draw-facing-a-half-pot-bet',
   jsonb_build_object('type', 'call'), true, now() - interval '2 days'),
  ('satt_devseed_alice_2', 'usr_devseed_alice', 'gutshot-facing-a-pot-sized-bet',
   jsonb_build_object('type', 'call'), false, now() - interval '2 days'),
  ('satt_devseed_borys_1', 'usr_devseed_borys', 'turn-check-raise-with-a-blocker',
   jsonb_build_object('type', 'raise', 'to', 45), NULL, now() - interval '90 minutes')
ON CONFLICT (id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- One expired, already-consumed OIDC login attempt.
--
-- Consumed and expired on purpose. A pending attempt would be a usable - if
-- dev-only - CSRF state sitting in version control, and there is no reason to
-- write one: what this row is for is giving the expiry sweep and the "attempt
-- already used" branch something real to run against.
-- -----------------------------------------------------------------------------
INSERT INTO prl.oidc_login_attempts (
  id, state_hash, nonce_hash, pkce_verifier_hash, redirect_after, expires_at, consumed_at, created_at
)
VALUES (
  'oidc_devseed_consumed1',
  sha256(convert_to('devseed-state-already-used', 'utf8')),
  sha256(convert_to('devseed-nonce-already-used', 'utf8')),
  sha256(convert_to('devseed-pkce-verifier-already-used', 'utf8')),
  '/lessons/pot-odds-and-break-even-equity',
  now() - interval '1 hour',
  now() - interval '90 minutes',
  now() - interval '95 minutes'
)
ON CONFLICT (id) DO NOTHING;

-- -----------------------------------------------------------------------------
-- Audit events.
--
-- Every detail object is already redacted: no token, no raw IP, no user agent, no
-- invite code, no cards. The CHECK on prl.audit_log refuses those keys at the top
-- level anyway, which is a backstop and not the plan.
-- -----------------------------------------------------------------------------
INSERT INTO prl.audit_log (id, user_id, event, detail, created_at)
VALUES
  ('aud_devseed_0001', 'usr_devseed_alice', 'auth.guest.created',
   jsonb_build_object('kind', 'guest'), now() - interval '3 days'),
  ('aud_devseed_0002', 'usr_devseed_borys', 'auth.oidc.linked',
   jsonb_build_object('issuer', 'https://issuer.dev.invalid'), now() - interval '2 days'),
  ('aud_devseed_0003', 'usr_devseed_alice', 'room.created',
   jsonb_build_object('roomId', 'room_devseed_home', 'maxSeats', 6, 'visibility', 'invite_only'),
   now() - interval '1 hour'),
  -- No account attached: a wrong invite code is exactly the event that arrives
  -- without an identity, which is why audit_log.user_id is nullable.
  ('aud_devseed_0004', NULL, 'room.join.rejected',
   jsonb_build_object('reason', 'unknown_invite_code'), now() - interval '40 minutes'),
  ('aud_devseed_0005', 'usr_devseed_borys', 'hand.action.duplicate_rejected',
   jsonb_build_object('handId', 'hand_devseed_0001', 'reason', 'action_id_already_applied'),
   now() - interval '19 minutes')
ON CONFLICT (id) DO NOTHING;

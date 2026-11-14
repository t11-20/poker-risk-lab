-- Development data, applied by `pnpm db:seed` (which refuses NODE_ENV=production). Seeds are not
-- recorded in prl.schema_migrations, so every statement is re-runnable: fixed `devseed` ids and
-- ON CONFLICT (id) DO NOTHING.
--
-- No session rows: a seeded session is a working credential in version control. No plaintext secrets:
-- the invite code is stored as its sha256 digest, as the application stores it.
--
-- The seeded hand is a preflop walk, the one shape whose DeckReveal is legitimately empty. Its
-- commitment_root is not a real Merkle root (the deck and salts are never persisted), so the row says
-- 'fixed-deck-scenario', not 'csprng', and a verifier will correctly report a mismatch.

-- Bots get real user rows so a seat is a seat whoever occupies it, and no query special-cases a
-- seat with no user.
INSERT INTO prl.users (id, kind, display_name, oidc_issuer, oidc_subject, last_seen_at)
VALUES
  ('usr_devseed_alice', 'guest', 'Alice (guest)', NULL, NULL, now() - interval '5 minutes'),
  -- The reserved .invalid TLD cannot resolve to a real identity provider.
  ('usr_devseed_borys', 'oidc', 'Borys', 'https://issuer.dev.invalid', 'devseed-subject-borys',
   now() - interval '2 hours'),
  ('usr_devseed_bot_nit', 'guest', 'Rock (bot)', NULL, NULL, now()),
  ('usr_devseed_bot_tag', 'guest', 'Hammer (bot)', NULL, NULL, now())
ON CONFLICT (id) DO NOTHING;

-- The invite code in this development database is PRL-DEV-ROOM-1.
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

-- Stacks after the seeded hand: 200 + 199 + 198 + 203 = 4 x 200, because chips are conserved.
--
-- The bot seats carry all three durable facts (migration 0003) so they rehydrate rather than exercise
-- the refusal path. The seeds are what `seedFor('room_devseed_home', <seat>, undefined)` produces.
INSERT INTO prl.room_members
  (id, room_id, user_id, seat, stack, is_bot, bot_profile, bot_difficulty, bot_seed, joined_at, left_at)
VALUES
  ('mem_devseed_alice', 'room_devseed_home', 'usr_devseed_alice', 0, 200, false, NULL, NULL, NULL,
   now() - interval '1 hour', NULL),
  ('mem_devseed_borys', 'room_devseed_home', 'usr_devseed_borys', 1, 199, false, NULL, NULL, NULL,
   now() - interval '1 hour', NULL),
  ('mem_devseed_bot_nit', 'room_devseed_home', 'usr_devseed_bot_nit', 2, 198, true,
   'disciplined-specialist', 'realistic', 656271975,
   now() - interval '1 hour', NULL),
  ('mem_devseed_bot_tag', 'room_devseed_home', 'usr_devseed_bot_tag', 3, 203, true,
   'patient-technician', 'realistic', 639494356,
   now() - interval '1 hour', NULL)
ON CONFLICT (id) DO NOTHING;

-- Button on seat 0; seat 3 raises to 6 and the other three fold, with no board and no showdown.
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
  -- Not a real Merkle root: there is no deck behind it (see the header).
  encode(sha256(convert_to('prl-dev-seed/not-a-real-commitment/hand-1', 'utf8')), 'hex'),
  'prl-dev-seed/room_devseed_home/hand/1 NOT-A-REAL-COMMITMENT',
  'fixed-deck-scenario',
  '[]'::jsonb,
  'complete',
  jsonb_build_object(
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

-- Every seat's hole cards with showed_down false: the read rule on prl.hand_seats.hole_cards lets each
-- be shown to its own seat's user and nobody else.
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

-- `pot_after` includes the blinds (1 + 2 + 6 = 9) and `action_to` is a total for the street, not an
-- increment. Bots carry action_ids because they go through the same submit path as a person.
INSERT INTO prl.hand_actions (
  id, hand_id, sequence, street, seat, action_type,
  action_to, amount_paid, bet_level_after, pot_after, was_automatic, action_id, created_at
)
VALUES
  ('act_devseed_0001_1', 'hand_devseed_0001', 1, 'preflop', 3, 'raise',
   6, 6, 6, 9, false, 'devseed-action-0001-1', now() - interval '20 minutes'),
  ('act_devseed_0001_2', 'hand_devseed_0001', 2, 'preflop', 0, 'fold',
   NULL, 0, 6, 9, false, 'devseed-action-0001-2', now() - interval '20 minutes'),
  -- The server folded for seat 1 on timeout, so there is no client action_id; that is why the
  -- idempotency index is partial.
  ('act_devseed_0001_3', 'hand_devseed_0001', 3, 'preflop', 1, 'fold',
   NULL, 0, 6, 9, true, NULL, now() - interval '19 minutes'),
  ('act_devseed_0001_4', 'hand_devseed_0001', 4, 'preflop', 2, 'fold',
   NULL, 0, 6, 9, false, 'devseed-action-0001-4', now() - interval '19 minutes')
ON CONFLICT (id) DO NOTHING;

-- Content lives in packages/content, so these ids are not foreign keys: read paths must tolerate a
-- progress row pointing at renamed or retired content.
INSERT INTO prl.lesson_progress (id, user_id, lesson_id, completed_at, last_viewed_at)
VALUES
  ('lprog_devseed_alice_pot_odds', 'usr_devseed_alice', 'pot-odds-and-break-even-equity',
   now() - interval '3 days', now() - interval '3 days'),
  ('lprog_devseed_alice_outs', 'usr_devseed_alice', 'counting-outs-and-the-rule-of-2-and-4',
   NULL, now() - interval '10 minutes'),
  ('lprog_devseed_borys_variance', 'usr_devseed_borys', 'variance-and-why-results-lie',
   NULL, now() - interval '2 hours')
ON CONFLICT (id) DO NOTHING;

-- `answer` is the learner's own submission; there is no stored answer key, and `was_correct` is the
-- runtime comparison at the moment of the attempt.
INSERT INTO prl.quiz_attempts (id, user_id, quiz_id, question_id, answer, was_correct, created_at)
VALUES
  ('qatt_devseed_alice_1', 'usr_devseed_alice', 'quiz-pot-odds', 'q-break-even-call',
   jsonb_build_object('kind', 'multipleChoice', 'selectedIndex', 2), true, now() - interval '3 days'),
  ('qatt_devseed_alice_2', 'usr_devseed_alice', 'quiz-pot-odds', 'q-facing-a-half-pot-bet',
   jsonb_build_object('kind', 'multipleChoice', 'selectedIndex', 0), false, now() - interval '3 days'),
  ('qatt_devseed_alice_3', 'usr_devseed_alice', 'quiz-pot-odds', 'q-equity-needed-to-call',
   jsonb_build_object('kind', 'numeric', 'value', 20, 'unit', 'percent'), false,
   now() - interval '3 days'),
  ('qatt_devseed_borys_1', 'usr_devseed_borys', 'quiz-variance', 'q-what-a-downswing-proves',
   jsonb_build_object('kind', 'multipleChoice', 'selectedIndex', 1), true, now() - interval '2 hours')
ON CONFLICT (id) DO NOTHING;

-- matched_expected is NULL on the third row: that scenario turns on a range assumption a learner may
-- reasonably reject, so it claims no single correct action.
INSERT INTO prl.scenario_attempts (id, user_id, scenario_id, chosen_action, matched_expected, created_at)
VALUES
  ('satt_devseed_alice_1', 'usr_devseed_alice', 'flush-draw-facing-a-half-pot-bet',
   jsonb_build_object('type', 'call'), true, now() - interval '2 days'),
  ('satt_devseed_alice_2', 'usr_devseed_alice', 'gutshot-facing-a-pot-sized-bet',
   jsonb_build_object('type', 'call'), false, now() - interval '2 days'),
  ('satt_devseed_borys_1', 'usr_devseed_borys', 'turn-check-raise-with-a-blocker',
   jsonb_build_object('type', 'raise', 'to', 45), NULL, now() - interval '90 minutes')
ON CONFLICT (id) DO NOTHING;

-- Consumed and expired on purpose: a pending attempt would be a usable CSRF state in version control.
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

-- Every detail object is already redacted; the CHECK on prl.audit_log is a backstop, not the plan.
INSERT INTO prl.audit_log (id, user_id, event, detail, created_at)
VALUES
  ('aud_devseed_0001', 'usr_devseed_alice', 'auth.guest.created',
   jsonb_build_object('kind', 'guest'), now() - interval '3 days'),
  ('aud_devseed_0002', 'usr_devseed_borys', 'auth.oidc.linked',
   jsonb_build_object('issuer', 'https://issuer.dev.invalid'), now() - interval '2 days'),
  ('aud_devseed_0003', 'usr_devseed_alice', 'room.created',
   jsonb_build_object('roomId', 'room_devseed_home', 'maxSeats', 6, 'visibility', 'invite_only'),
   now() - interval '1 hour'),
  -- A wrong invite code arrives without an identity, which is why audit_log.user_id is nullable.
  ('aud_devseed_0004', NULL, 'room.join.rejected',
   jsonb_build_object('reason', 'unknown_invite_code'), now() - interval '40 minutes'),
  ('aud_devseed_0005', 'usr_devseed_borys', 'hand.action.duplicate_rejected',
   jsonb_build_object('handId', 'hand_devseed_0001', 'reason', 'action_id_already_applied'),
   now() - interval '19 minutes')
ON CONFLICT (id) DO NOTHING;

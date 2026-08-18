# Reviewer D — Security & Multiplayer (offensive testing)

**Scope:** Authorized pre-release security audit of Poker Risk Lab. All tests run against an
API instance **I started myself on port 3101**, bound to an **isolated database `prl_audit_d`**
(created + migrated by me; shared dev DB never touched). Attacks were written independently as
real HTTP/WebSocket clients (`node` + the `ws` package, and `curl`) — I did **not** rely on the
repo's own tests passing.

**Environment I built (evidence):**
```
$ docker exec ... psql -U poker -c "CREATE DATABASE prl_audit_d OWNER poker;"  -> CREATE DATABASE
$ DATABASE_URL=...prl_audit_d node apps/api/scripts/migrate.mjs up
  ✓ 0001_initial.sql   ✓ 0002_indexes_and_constraints.sql
$ node --env-file=audit.env apps/api/src/server.ts   # PORT=3101, NODE_ENV=development
  "listening" address=http://127.0.0.1:3101 allowedOrigins=["http://localhost:3000"]
$ curl .../api/v1/health -> {"status":"ok","version":"0.1.0","protocolVersion":1}
```
A second short-lived boot in **production mode** (still port 3101, still `prl_audit_d`) was used
to capture production cookie hardening.

**Bottom line:** This is an unusually careful, security-conscious implementation. Every P0
hidden-information channel I could reach was closed, and every attack in the brief was defended.
I found **no P0 or P1 security issues**. Two P3 cosmetic/design notes and two UNVERIFIED areas
(OIDC runtime, web-app RSC runtime — the latter blocked by my port restriction, mitigated by
static analysis showing the web app has no DB access).

---

## Summary table

| ID | Title | Status |
|----|-------|--------|
| SEC-001 | Hole cards never leak to other/unauth players | **PASS** |
| SEC-002 | Undealt/future deck cards never leak | **PASS** |
| SEC-003 | RNG salts/seed sealed; Merkle reveal = board + shown hands only | **PASS** |
| SEC-004 | Unauthorized room/table state not readable | **PASS** |
| SEC-005 | Session minting (guest) | **PASS** |
| SEC-006 | Cookie flags (`__Host-`/Secure/HttpOnly/SameSite) | **PASS** |
| SEC-007 | Session fixation | **PASS** |
| SEC-008 | Session forging / tamper / replay-after-logout | **PASS** |
| SEC-009 | Guest session boundaries | **PASS** |
| SEC-010 | Authorization (seat/turn/room-not-joined/uninvited/private-join) | **PASS** |
| SEC-011 | WebSocket Origin validation + cross-site WS hijack | **PASS** |
| SEC-012 | CSRF double-submit (omit/reuse/cross-origin) | **PASS** |
| SEC-013 | Input validation (JSON/types/extra/proto/numbers/oversized) | **PASS** |
| SEC-014 | SQL injection on every reachable parameter | **PASS** |
| SEC-015 | Rate limiting is real + not XFF-bypassable | **PASS** |
| SEC-016 | Idempotency (action replay does not double-apply) | **PASS** |
| SEC-017 | Sequence handling (stale/future rejected) | **PASS** |
| SEC-018 | Reconnect restores state, no leak, not hijackable | **PASS** |
| SEC-019 | Race conditions / chip conservation / no double-spend | **PASS** |
| SEC-020 | WS resource limits (socket cap / oversized / flood) | **PASS** |
| SEC-021 | Logs do not leak secrets | **PASS** |
| SEC-022 | Multiplayer functional proof (two sessions → showdown) | **PASS** |
| SEC-023 | Seat-reuse hole-card leak (documented regression) | **PASS** |
| SEC-024 | Hand-history / hand-review hidden-info + authz | **PASS** |
| SEC-025 | Web/RSC bundled hidden info | **PARTIAL** (static only; runtime blocked by port rule) |
| SEC-026 | OIDC auth flow (state/PKCE/nonce) | **UNVERIFIED** (no IdP configured) |
| SEC-027 | Timing side-channels on secret comparisons | **PARTIAL** (code-inspected, not timed) |
| SEC-028 | Non-owner can `startHand` | **PASS** (works; design note, not a vuln) |

---

### SEC-001 Hole cards never leak to another/unauthenticated player
- **Requirement (exact):** As an unauthorized/other player or unauthenticated attacker, it must be
  impossible to obtain another player's hole cards, via any channel.
- **Status:** PASS
- **Implementation location:** `packages/poker-engine/src/redact.ts:189-254` (`redactFor` builds a
  narrow `PlayerView`, hole cards only for `isSelf || showedDown`); `viewerFor` L163-173 resolves
  entitlement by **playerId, never seat index**. `apps/api/src/rooms/table.ts:387-390`
  (`viewFor` is the only exit). `apps/api/src/ws/router.ts:479-524` (per-recipient broadcast — one
  `viewFor(socket.userId)` per socket, never a shared object).
- **Runtime evidence:** Two independent sessions (separate cookie jars + WS) played a full
  heads-up hand to showdown while I captured **every** frame each received and scanned each seat's
  `holeCards`:
  ```
  ALICE self holeCards: [44,30]   BOB self holeCards: [31,3]
  LEAK during play [bob-frames]:   NONE
  LEAK during play [alice-frames]: NONE
  ```
  Repeated for fold-out and 3-handed mixed hands — opponents' cards never appeared while
  `street !== 'complete'` (and only shown-down seats' cards appeared at completion).
- **Test covering it:** `test/hidden-information-api.test.ts` exists (not relied upon).
- **Test result:** My independent scripts `t_showdown.mjs`, `t_fold.mjs`, `t_multiway.mjs` — all pass.
- **Reviewer notes:** The redaction constructs a new type rather than deleting fields (fails
  closed). Identity is by `playerId`. Verified directly against the server's own deal.
- **Missing work:** none.

### SEC-002 Undealt / future deck cards never leak
- **Requirement (exact):** The undealt deck stub must never be obtainable.
- **Status:** PASS
- **Implementation location:** `redact.ts` never projects `deck`/`deckCursor`; `cardsHiddenFrom`
  L266-291 treats every `index >= deckCursor` as permanently hidden.
- **Runtime evidence:** Raw-text scan of all frames for `"deck"`,`"deckSalts"`,`"deckCursor"`,
  `"boardPositions"`,`holeCardPositions`:
  ```
  secret-marker scan [alice]: NONE   secret-marker scan [bob]: NONE
  ```
  The `board` array in every view held only cards actually dealt for the current street.
- **Test covering it / result:** `t_showdown.mjs`/`t_fold.mjs`/`t_multiway.mjs` — pass.
- **Reviewer notes:** No wire message carries the deck or cursor; `PublicActionEvent` has no card
  field by construction.
- **Missing work:** none.

### SEC-003 RNG material sealed; Merkle reveal proves only board + shown hands
- **Requirement (exact):** The deck RNG material/seed/salts must not be obtainable, including via
  the Merkle deck-commitment reveal, which must expose ONLY the board and hands that actually
  showed — never folded players' hole cards or undealt cards.
- **Status:** PASS
- **Implementation location:** `packages/poker-engine/src/commitment.ts:255-285` (`revealPositions`
  exposes salt/proof only for the given positions); `machine.ts:550-566` builds `publicPositions`
  as `boardPositions ∪ holeCardPositions[showdownSeat]` — folded seats are excluded because
  `showdowns` excludes them.
- **Runtime evidence (showdown):**
  ```
  REVEAL cards count = 9  complete=false
  revealed card ids: [3,6,15,18,27,30,31,44,45]      (= 5 board + 2+2 shown holes)
  legit visible (board+shown): [3,6,15,18,27,30,31,44,45]
  EXTRA revealed beyond legit-visible: NONE
  reveal entry keys: ["index","card","saltHex","proof"]   (salt present ONLY for public positions)
  ```
  **Fold-out hand:** `reveal cards = [43,34,25]` (the 3 flop board cards only), both players'
  hole cards absent; `hole cards leaked via reveal: NONE`.
  **3-handed mixed (seat 1 folds, seats 0+2 show):**
  ```
  FOLDER seat 1 hole [51,37]
  showdown seats: [0,2]   reveal card ids: [1,2,12,18,31,32,41,42,46]
  FOLDER cards [51,37] leaked in reveal? NO
  ```
- **Test covering it / result:** `t_showdown.mjs`, `t_fold.mjs`, `t_multiway.mjs` — pass.
- **Reviewer notes:** The per-card Merkle tree with independent 32-byte salts is the right design;
  the salt for an unrevealed position is never emitted, so no leaf is brute-forceable. The
  server-side `DeckSecret` is dropped on hand completion (`table.ts:827`), never persisted (no
  column), never logged.
- **Missing work:** none. (The known *deck-choice-fairness* limitation is documented and accepted
  in `docs/THREAT-MODEL.md`; out of scope for a leak.)

### SEC-004 Unauthorized room/table state not readable
- **Requirement (exact):** A caller must not read a room/table it was not invited to.
- **Status:** PASS
- **Implementation location:** `apps/api/src/rooms/registry.ts:511-522` (`require`),
  `apps/api/src/routes/rooms.ts:562-580` (`openRoomFor` checks membership on durable rows before
  building a live table), `ws/router.ts:353-363` (`hello` membership check).
- **Runtime evidence:** Mallory (a valid guest who knows the roomId but never joined):
  ```
  GET /rooms/:id       -> 404 room_not_found_or_not_permitted
  POST /rooms/:id/sit  -> 404 room_not_found_or_not_permitted
  WS hello into room    -> error room_not_found_or_not_permitted, close 4403
  Mallory /rooms list contains Alice's room? false
  ```
- **Test covering it / result:** `t_authz_limits.mjs`, `t_wsorigin.mjs` — pass.
- **Reviewer notes:** One indistinguishable answer for "no such room" and "not yours".
- **Missing work:** none.

### SEC-005 Session minting (guest)
- **Requirement (exact):** Guest session creation must issue a valid, server-signed session.
- **Status:** PASS
- **Implementation location:** `apps/api/src/routes/auth.ts:382-393`,
  `apps/api/src/auth/session.ts:250-267` (`issueSession`).
- **Runtime evidence:** `POST /auth/guest` (with CSRF) -> 201, sets signed `prl_session`, and
  `GET /auth/session` then returns the user with `units: 1000`. Token stored server-side as a
  hash (`repositories/sessions.ts`), plaintext only in the cookie.
- **Test covering it / result:** `t_baseline.mjs` — pass.
- **Missing work:** none.

### SEC-006 Cookie flags
- **Requirement (exact):** Session/CSRF cookies must carry `__Host-` prefix, `Secure`, `HttpOnly`,
  and a correct `SameSite` in production.
- **Status:** PASS
- **Implementation location:** `apps/api/src/plugins/security.ts:139-193` (names + options).
- **Runtime evidence (development, my primary instance):**
  ```
  set-cookie: prl_csrf=...; Path=/; HttpOnly; SameSite=Lax
  set-cookie: prl_session=...; Max-Age=...; Path=/; HttpOnly; SameSite=Lax
  ```
  (No `__Host-`/`Secure` in dev — intentional and documented, since `Secure` over `http://localhost`
  is unreliable.)
  **Production mode boot (NODE_ENV=production, port 3101):**
  ```
  set-cookie: __Host-prl_csrf=...;    Path=/; HttpOnly; Secure; SameSite=Lax
  set-cookie: __Host-prl_session=...; Max-Age=1209599; Path=/; HttpOnly; Secure; SameSite=Lax
  Strict-Transport-Security: max-age=31536000; includeSubDomains
  ```
- **Test covering it / result:** `curl -i` in dev + prod — pass.
- **Reviewer notes:** `SameSite=Lax` (not Strict) is a deliberate, well-justified choice for the
  OIDC top-level-navigation return; residual risk is covered by the CSRF header + the "no GET
  changes state" rule. Production refuses to boot with `COOKIE_SECURE=false` (`config.ts:503-508`).
- **Missing work:** none.

### SEC-007 Session fixation
- **Requirement (exact):** A privilege change must mint a fresh token, not adopt a caller-supplied one.
- **Status:** PASS
- **Implementation location:** `apps/api/src/auth/session.ts:250-267` (revokes previous, always a
  brand-new token).
- **Runtime evidence:** Planted an attacker-chosen `prl_session=attackerchosenvalue.sig`, then
  `POST /auth/guest`:
  ```
  guest sets NEW session cookie; contains attacker value? false
  ```
- **Test covering it / result:** `t_race_session.mjs` — pass.
- **Missing work:** none.

### SEC-008 Session forging / tampering / replay-after-logout
- **Requirement (exact):** Forged, tampered, or revoked session cookies must be rejected.
- **Status:** PASS
- **Implementation location:** `auth/session.ts:311-334` (unsign before any DB lookup; revoked →
  `null`), signed via `@fastify/cookie` HMAC-SHA256 (`plugins/security.ts:579-586`).
- **Runtime evidence:**
  ```
  forged random cookie            -> user: null
  tampered signed cookie          -> user: null ; on /hands -> 401 not_authenticated
  replay valid cookie AFTER logout -> user: null ; on /hands -> 401 not_authenticated
  ```
- **Test covering it / result:** `t_race_session.mjs` — pass.
- **Reviewer notes:** Logout revokes server-side, so a captured cookie is dead immediately.
- **Missing work:** none.

### SEC-009 Guest session boundaries
- **Requirement (exact):** One guest must not read another guest's rooms/state.
- **Status:** PASS
- **Implementation location:** `routes/rooms.ts:291-307` (`listForUser`), `routes/hands.ts:399-425`
  (`s.user_id = <caller>` predicate).
- **Runtime evidence:** Mallory's `/rooms` is empty while Alice's shows her room; Bob cannot read
  Carol/Dave's hand (`404 hand_not_found`).
- **Test covering it / result:** `t_authz_limits.mjs`, `t_review.mjs` — pass.
- **Missing work:** none.

### SEC-010 Authorization: seat / turn / room-not-joined / uninvited / private-join
- **Requirement (exact):** A session must not act as another seat, act out of turn, act/read in a
  room it never joined, or join a private room without the invite.
- **Status:** PASS
- **Implementation location:** `rooms/table.ts:632-673` (`submitAction` derives the acting seat
  from the **user id in the hand's own roster**, checks `toAct`), `registry.ts:608-630`
  (join is by invite code only), `ws/router.ts:271-276` (intents before `hello` rejected).
- **Runtime evidence:**
  ```
  Non-acting player action           -> not_your_turn
  Action before hello                 -> invalid_request (not applied)
  Non-member WS hello                 -> room_not_found_or_not_permitted, close 4403
  Mallory sit/leave/read uninvited    -> 404 room_not_found_or_not_permitted
  Join only via invite code (sha256-stored); no join-by-id endpoint exists
  ```
  "Act as seat Y" is structurally impossible: the `action` frame carries no seat field — the
  server derives it from the session (`ws-protocol.ts:90-110`).
- **Test covering it / result:** `t_game.mjs`, `t_wsorigin.mjs`, `t_authz_limits.mjs` — pass.
- **Missing work:** none.

### SEC-011 WebSocket Origin validation + cross-site WS hijack
- **Requirement (exact):** Reject foreign, missing, null, empty, and lookalike Origins on the WS
  upgrade; prevent cross-site WebSocket hijacking.
- **Status:** PASS
- **Implementation location:** `apps/api/src/ws/hub.ts:156-171` (`evaluateUpgrade`),
  `plugins/security.ts:113-116` (`isAllowedOrigin`, exact lowercase match).
- **Runtime evidence:**
  ```
  http://localhost:3000        -> accepted (control)
  http://LOCALHOST:3000        -> accepted (case-insensitive, correct)
  https://evil.test            -> close 4406
  (Origin header omitted)      -> close 4406
  Origin: '' (empty)           -> close 4406
  Origin: null                 -> close 4406
  http://evil-localhost.com    -> close 4406
  http://localhost.evil.com    -> close 4406
  http://localhost:3000.evil.com -> close 4406
  http://localhost:3001 (wrong port) -> close 4406
  valid origin, NO cookie      -> close 4401
  ```
- **Test covering it / result:** `t_wsorigin.mjs`, `t_wsorigin2.mjs` — pass.
- **Reviewer notes:** Because a browser cannot forge `Origin` and page script cannot set headers on
  `new WebSocket()`, this is the correct and sufficient defence against cross-site WS hijacking.
- **Missing work:** none.

### SEC-012 CSRF double-submit
- **Requirement (exact):** State-changing requests require a matching double-submit token; omitting
  it, reusing another session's token, or a cross-origin state change must fail.
- **Status:** PASS
- **Implementation location:** `plugins/security.ts:589-635` (only `x-csrf-token`, applied to all
  mutating methods), CORS refuse for cross-origin mutations L341-368.
- **Runtime evidence:**
  ```
  own token + own cookie      -> 201  (control)
  Alice's token + Bob's cookie -> 403 csrf_failed
  garbage token               -> 403 csrf_failed
  no token                    -> 403 csrf_failed
  valid token + Origin https://evil.test          -> 403 forbidden (CORS refuses first)
  valid token + Origin http://localhost:3000.evil.com -> 403 forbidden
  ```
- **Test covering it / result:** `t_csrf_input.mjs` — pass.
- **Reviewer notes:** Two independent controls (strict Origin AND double-submit) both hold.
- **Missing work:** none.

### SEC-013 Input validation
- **Requirement (exact):** Malformed/oversized JSON, wrong types, extra fields, prototype pollution,
  and out-of-range numbers must be rejected.
- **Status:** PASS
- **Implementation location:** `app.ts:121-129` (Ajv closed schemas, `removeAdditional:false`),
  `plugins/security.ts:493-494` (`onProtoPoisoning/onConstructorPoisoning: 'error'`),
  contract schemas in `packages/contracts/src/schemas.ts`.
- **Runtime evidence:**
  ```
  malformed JSON              -> 400 invalid_request
  literal "__proto__" key     -> 400 invalid_request ; Object.prototype.admin === undefined (no pollution)
  "constructor":{"prototype"} -> 400 invalid_request
  extra field                 -> 400 invalid_request (additionalProperties:false)
  negative startingStack      -> 400 invalid_request
  fractional bigBlind 1.5     -> 400 invalid_request
  huge startingStack 1e308    -> 400 invalid_request
  NaN startingStack           -> 400 invalid_request
  oversized body (70 KiB)     -> 413 payload_too_large
  WS raise to:-100            -> schema-rejected (invalid_request, to has minimum 0)
  WS raise to:999999          -> illegal_action (engine rejects above-stack)
  ```
- **Test covering it / result:** `t_csrf_input.mjs`, `t_game.mjs` — pass.
- **Reviewer notes:** Ajv `coerceTypes:'array'` means `maxSeats:"2"` coerces to `2` and is accepted
  — but every field is bounded/enum, so coercion cannot produce an out-of-range value. This is
  documented (`app.ts:99-129`) and confirmed harmless. Unicode tricks in display names are stripped
  (`routes/auth.ts:184-189` removes control/bidi/zero-width chars).
- **Missing work:** none.

### SEC-014 SQL injection
- **Requirement (exact):** No SQL injection on any parameter reaching the database.
- **Status:** PASS
- **Implementation location:** Every query uses the `postgres` tagged-template driver
  (parameterised); user input is additionally schema-constrained. Hand ordering is a fixed lookup
  table, never string-interpolated (`routes/hands.ts:276-325`).
- **Runtime evidence:**
  ```
  roomId  "room_x' OR 1=1--"        -> 400 invalid_request (pattern)
  inviteCode "' OR '1'='1"          -> 400 invalid_request (pattern ^[A-Za-z0-9-]{8,32}$)
  sort  "recent';DROP TABLE..."     -> 400 invalid_request (enum)
  cursor "x'; DROP TABLE prl.hands;--" -> 400 invalid_request
  roomId query "' OR 1=1--"          -> 400 invalid_request
  ```
- **Test covering it / result:** `t_csrf_input.mjs` — pass.
- **Reviewer notes:** Defence in depth: schema rejects before SQL, and the driver parameterises
  even if it didn't. Migration DDL uses `.unsafe()` but that runner is offline and separate.
- **Missing work:** none.

### SEC-015 Rate limiting is real and correctly keyed
- **Requirement (exact):** Rate limiting must actually fire and must not be bypassable by changing a
  header such as `X-Forwarded-For`.
- **Status:** PASS
- **Implementation location:** `plugins/security.ts:402-457` (session-or-hashed-address key;
  session-minting routes force address key), `routes/auth.ts:93-94,380` (guest = 10/min address).
- **Runtime evidence:**
  ```
  16x POST /auth/guest, same address        -> 8x 201 then 8x 429  (limit fires)
  12x POST /auth/guest, distinct XFF each   -> 12x 429             (XFF ignored, no bypass)
  ```
  (`TRUST_PROXY=false`, so `X-Forwarded-For` never becomes `request.ip`.)
- **Test covering it / result:** `t_ratelimit.mjs` — pass.
- **Reviewer notes:** The session-minting-route key fix (address-keyed, ignoring the freshly issued
  cookie) is present and works — the counter accumulates instead of rotating.
- **Missing work:** none. (If `TRUST_PROXY=true` is ever set without a header-overwriting proxy in
  front, address keying becomes forgeable — this is loudly warned at boot, `config.ts:511-516`.)

### SEC-016 Idempotency (replayed action does not double-apply)
- **Requirement (exact):** Replaying the same action must not apply it twice.
- **Status:** PASS
- **Implementation location:** `rooms/table.ts:632-673` (memo of `actionId → outcome` checked before
  legality), L903-916.
- **Runtime evidence:**
  ```
  first apply   -> ack appliedSequence:1
  replay same actionId -> ack appliedSequence:1, deduplicated:true   (not re-applied)
  ```
  Chip totals were conserved across the hand (see SEC-019).
- **Test covering it / result:** `t_game.mjs` — pass.
- **Missing work:** none.

### SEC-017 Sequence handling
- **Requirement (exact):** Out-of-order, stale, and future sequence numbers must be rejected.
- **Status:** PASS
- **Implementation location:** `rooms/table.ts:655-661` (`expectedSequence !== actionSequence` →
  `stale_action_sequence`).
- **Runtime evidence:**
  ```
  expectedSequence = 0     (stale)  -> stale_action_sequence
  expectedSequence = 99999 (future) -> stale_action_sequence
  ```
- **Test covering it / result:** `t_game.mjs` — pass.
- **Missing work:** none.

### SEC-018 Reconnect: state restored, no leak, not hijackable
- **Requirement (exact):** Reconnecting must restore correct state without leaking, and an attacker
  must not hijack/resume someone else's session.
- **Status:** PASS
- **Implementation location:** `ws/router.ts:339-390` (`hello` re-sends current view; "reconnect is
  just send the current view"), auth from the HttpOnly cookie only.
- **Runtime evidence:** Dropped Alice's socket mid-hand, reconnected with the same cookie:
  ```
  hole before reconnect [38,13] ; after reconnect [38,13] ; matches: true
  reconnect welcome seat 0, street preflop ; opponent cards leaked: NONE
  ```
  Hijack is impossible without the cookie: no-cookie upgrade → 4401; a *different* session helloing
  into the room → 4403 (SEC-010/011). The cookie is `HttpOnly`, so script cannot read it.
- **Test covering it / result:** `t_race_session.mjs` — pass.
- **Missing work:** none.

### SEC-019 Race conditions / chip conservation / no double-spend
- **Requirement (exact):** Concurrent conflicting actions must not double-spend chips or corrupt state.
- **Status:** PASS
- **Implementation location:** `rooms/table.ts:326-367` (one async serialisation queue per table);
  seat allocation guarded by DB unique constraint `room_members_live_seat_key` (`registry.ts:641-672`).
- **Runtime evidence:**
  ```
  Join race (Bob & Carol both sit seat 1, concurrent) -> Bob 200, Carol 409 seat_taken (one occupant)
  startHand race (two members concurrent)             -> one ack, one illegal_action; 1 distinct handId
  Action race (same player, 2 actions same seq)       -> one ack(seq 1), one not_your_turn
  Chip conservation: heads-up 400 -> 400 ; 3-handed deal sum = 600 (no chips created/destroyed)
  ```
- **Test covering it / result:** `t_game.mjs`, `t_race_session.mjs` — pass.
- **Missing work:** none.

### SEC-020 WebSocket resource limits
- **Requirement (exact):** Per-session socket cap, oversized-frame, and flood limits must be enforced.
- **Status:** PASS
- **Implementation location:** `ws/hub.ts:167-169` (`maxSocketsPerSession`), `ws/router.ts:240-253`
  (size + token-bucket rate).
- **Runtime evidence:**
  ```
  5th socket on one session      -> close 4429 "too many sockets"
  frame > 8 KiB                  -> close 4429 "frame too large"
  60 pings (> burst 40)          -> close 4429 "too many messages"
  ```
- **Test covering it / result:** `t_authz_limits.mjs` — pass.
- **Missing work:** none.

### SEC-021 Logs do not leak secrets
- **Requirement (exact):** Logs must not contain hole cards, salts, deck, or session tokens.
- **Status:** PASS
- **Implementation location:** `apps/api/src/logging.ts` (redaction), request log records only
  method/path/`queryKeys`/hashed `clientKey`.
- **Runtime evidence:** After all the hands above, `grep` over `server.log` (588 lines) found **no**
  `"holeCards":[n,n]`, no `saltHex`/`deckSalt`/`deckCursor`, no `prl_session=` values. Requests log
  `"clientKey":"d41c61a7f7674d9a"` (a hash, not the IP) and `queryKeys` (names, not values). CSRF
  failures log a framework stack trace (server-side, level 40) but no secret value.
- **Test covering it / result:** log grep — pass.
- **Missing work:** none.

### SEC-022 Multiplayer functional proof (REQUIRED)
- **Requirement (exact):** Prove a private multiplayer hand actually completes with two independent
  sessions; also disconnect mid-hand → reconnect → state restored.
- **Status:** PASS
- **Implementation location:** end-to-end across rooms/table/ws.
- **Runtime evidence:** Two separate cookie jars + WS connections, joined one private room by invite
  code, both sat, Alice (owner) started the hand, both drove check/call to showdown:
  ```
  welcome A seat 0 ; welcome B seat 1
  ALICE hole [44,30] ; BOB hole [31,3] ; board [45,6,18,27,15]
  Alice showdown event: ["seat 0 shows pair of kings, nine kicker","seat 1 shows high card king..."]
  Alice handComplete: ["seat 0 wins 4 from pot 0"] ; Bob handComplete: same
  ```
  Disconnect→reconnect restored the exact same hole cards and street (SEC-018).
- **Test covering it / result:** `t_showdown.mjs` (+ fold and 3-handed variants) — pass.
- **Reviewer notes:** Private multiplayer genuinely works end to end. **Not** a P1 product failure.
- **Missing work:** none.

### SEC-023 Seat-reuse hole-card leak (documented regression)
- **Requirement (exact):** A new occupant of a chair a previous player vacated must not see the
  previous occupant's retained (folded) hole cards.
- **Status:** PASS
- **Implementation location:** `rooms/table.ts:387-390` + `redact.ts:163-173` — entitlement resolved
  by `playerId` against the hand's own dealt roster.
- **Runtime evidence:** Alice folded (cards `[25,44]`, never shown), left seat 0; Carol took seat 0
  and connected:
  ```
  Carol viewerSeat: null  (spectator to the retained hand — correct)
  Carol sees seat 0 holeCards: null ; seat 1 holeCards: null
  Any non-self holeCards in ANY Carol frame: NONE
  ```
- **Test covering it / result:** `t_seatreuse.mjs` — pass.
- **Reviewer notes:** The specific historical bug this codebase documents is closed at runtime.
- **Missing work:** none.

### SEC-024 Hand-history / hand-review hidden-info + authorization
- **Requirement (exact):** `GET /hands` and `GET /hands/:handId` must not leak folded/opponent hole
  cards and must be scoped to the caller.
- **Status:** PASS
- **Implementation location:** `routes/hands.ts:399-457` (SQL `user_id = :viewer OR showed_down`,
  authz via `exists(...seat)` in the same statement), `review/build-review.ts:304-321` (same rule
  re-applied when building the response — two independent layers).
- **Runtime evidence:** Bob reviews a hand where Alice folded:
  ```
  seats: [{seat:0, AliceOwner, hole:null, showed:false}, {seat:1, BobJoiner, hole:["5d","Tc"], showed:false}]
  reveal cards: 3 board positions ; verification ok
  Bob reading Carol/Dave hand (never a member) -> 404 hand_not_found
  Bob reading fake hand id                     -> 404 hand_not_found
  anonymous reading a real hand                -> 401 not_authenticated
  ```
- **Test covering it / result:** `t_review.mjs` — pass.
- **Missing work:** none.

### SEC-025 Web / RSC bundled hidden information
- **Requirement (exact):** RSC payloads and bundled client-side data must not embed hidden info.
- **Status:** PARTIAL (static analysis only)
- **Implementation location:** `apps/web/src/*`.
- **Runtime evidence:** I am restricted to API port 3101 and must **not** bind the web port (3000),
  so I could not exercise RSC at runtime. Static analysis instead:
  ```
  grep -rlE "postgres|DATABASE_URL|hand_seats|hole_cards" apps/web/src   -> (none)
  ```
  The web app has **no direct database access**; it is a pure client of the API
  (`apps/web/src/lib/api.ts`, `credentials:'include'`). Every place it touches `holeCards` (e.g.
  `TableStage.tsx`, `HandReplay.tsx`) renders values already redacted by the API. Therefore any RSC
  payload can only contain what the (verified-safe) API returned.
- **Reviewer notes:** Residual risk is low but unproven at runtime. Recommend a follow-up reviewer
  with web-port access confirm no RSC page fetches with elevated credentials.
- **Missing work:** Runtime RSC scan (blocked by my port assignment).

### SEC-026 OIDC authentication flow
- **Requirement (exact):** OIDC state/PKCE/nonce and its own double-submit must resist forged callbacks.
- **Status:** UNVERIFIED
- **Implementation location:** `apps/api/src/routes/auth.ts:308-518`, `apps/api/src/auth/oidc.ts`.
- **Runtime evidence:** My instance runs guest-only (no IdP). `GET /auth/session` reports
  `oidcEnabled:false`; the flow could not be exercised end to end without a provider.
- **Reviewer notes:** Code inspection shows a strong design: `state` double-submit compared with
  `timingSafeEquals`, single-use attempt rows, PKCE verifier hash checked before spending the code,
  plaintext secrets never stored, `redirectAfter` constrained to a path. No issue found by reading,
  but not proven at runtime.
- **Missing work:** Stand up a mock IdP and drive start→callback, including a forged-callback test.

### SEC-027 Timing side-channels on secret comparisons
- **Requirement (exact):** Secret comparisons must be constant-time.
- **Status:** PARTIAL (code-inspected)
- **Implementation location:** `repositories/hashing.ts` (`timingSafeEquals`), used for OIDC
  state/PKCE/nonce; session tokens looked up by SHA-256 digest (`repositories/sessions.ts`).
- **Runtime evidence:** Not timed (meaningful timing measurement over loopback is unreliable).
  Reading confirms `timingSafeEquals` on the OIDC comparisons and hash-based session lookup (so the
  raw token is never string-compared).
- **Missing work:** Optional microbenchmark; low priority.

### SEC-028 Non-owner can startHand (design note)
- **Requirement (exact):** Determine who may deal the next hand.
- **Status:** PASS (works as designed; flagged for awareness)
- **Implementation location:** `ws/router.ts:406-412` — `onStartHand` requires room membership, not
  ownership.
- **Runtime evidence:** Bob (a member who is not the owner) sent `startHand` → `ack`, hand went live.
- **Reviewer notes:** In an invite-only room where every member is a trusted invitee, allowing any
  member to start a hand is reasonable. It is **not** a privilege escalation (a non-member is still
  refused). Raising only so the product owner can confirm the intent.
- **Missing work:** none (confirm product intent if owner-only dealing was expected).

---

## Counts

- **PASS:** 25 (SEC-001..024, SEC-028)
- **FAIL:** 0
- **PARTIAL:** 2 (SEC-025 web/RSC runtime, SEC-027 timing)
- **UNVERIFIED:** 1 (SEC-026 OIDC)
- **N/A:** 0

## Severity-classified issues

- **P0 (security/correctness catastrophe):** none. Every hidden-information channel enumerated in
  the brief — REST responses, every WS frame type, error messages, hand-history/review, the Merkle
  commitment reveal, logs, reconnect, seat-reuse — was tested and holds. The reveal proves only the
  board and hands that actually showed.
- **P1 (required feature broken/missing):** none. Private multiplayer completes a full hand to
  showdown with two independent sessions, and reconnect restores state correctly.
- **P2 (significant quality gap):** none found within scope.
- **P3 (polish / follow-up):**
  1. **SEC-025 / SEC-026 residual coverage** — RSC runtime (blocked by my port restriction; static
     analysis shows the web app has no DB access) and the OIDC flow (no IdP configured) were not
     exercised at runtime. A follow-up reviewer with web-port and a mock IdP should close these.
  2. **Doc inconsistency:** `apps/web/src/lib/api.ts` comment states the session cookie is
     `SameSite=Strict`, but the server correctly sets `SameSite=Lax` (`plugins/security.ts:168-176`).
     Cosmetic; update the comment.
  3. **SEC-028:** confirm whether any room member (not just the owner) should be able to `startHand`.

## Notes on method / non-interference

- Bound **only** port 3101. Created and used **only** `prl_audit_d`; never ran `db:reset`, never
  touched the shared dev database, never edited repo source/tests/config.
- All scratch scripts live under my scratch dir
  (`.../scratchpad/agentD/`: `harness.mjs`, `t_*.mjs`), plus `server.log`/`prod.log`.
- A development-mode API instance remains running on 127.0.0.1:3101 against `prl_audit_d`.

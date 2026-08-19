> **Lead freeze, 2026-08-19.** Independent first-pass by the named reviewer at HEAD `f20bbad`. Subsequent P1 remediations are recorded in `docs/audit/final-traceability.md` and `docs/audit/final-release-report.md`. This file is the reviewer's own evidence, not a clearance.

# Reviewer D — Security & Multiplayer (independent re-audit)

- **Auditor:** Reviewer D (Security & Multiplayer). Did not build this. Did not fix code.
- **HEAD:** `f20bbad`
- **Date:** 2026-08-19
- **Target:** local repo + API started this session at `HOST=127.0.0.1 PORT=4201` (`PUBLIC_WEB_ORIGIN=http://localhost:3000`). Existing Postgres via `.env` `DATABASE_URL`. Nothing except localhost was attacked.
- **Prior `docs/audit/*`:** not used as evidence.
- **OIDC:** unconfigured in `.env` (all four variables commented). Live start/callback return `501 oidc_not_configured`.
- **Verdict summary:** no hidden-information leak observed. No P0. One control UNVERIFIED (OIDC, not configured). Stale-sequence first attempt was a harness ordering error; a follow-up while the actor was still to act returned `stale_action_sequence`.

## How this session attacked

API boot (this session):

```
HOST=127.0.0.1 PORT=4201 PUBLIC_WEB_ORIGIN=http://localhost:3000 LOG_LEVEL=info
node --env-file-if-exists=../../.env src/server.ts
→ listening http://127.0.0.1:4201  oidcEnabled=false  allowedOrigins=["http://localhost:3000"]
```

Two Node `ws` clients (independent cookie jars) created guest sessions, sat a private room, dealt, and drove actions. Every WS frame and the relevant REST bodies were scanned for the other seat’s `holeCards`, a `deck` / `deckSalts` / `salts` tree, commitment salts before reveal, and bot policy internals (`traits`, `observations`, `policyInput`).

Follow-up process (after the guest rate-limit window) re-tested stale sequence while still to act, and pulled showdown hand-review JSON for both participants.

---

## Requirement table

Nine fields: ID | Requirement | Verdict | Severity | Attack this session | Observed | Evidence | Locus | Notes

| ID | Requirement | Verdict | Severity | Attack this session | Observed | Evidence | Locus | Notes |
|---|---|---|---|---|---|---|---|---|
| SEC-001 | Hole cards never leak to other / unauthenticated players | **PASS** | — | Two guests sit seats 0/1, `startHand`, inspect every `state` frame | Each view has `isSelf` hole pair only; opponent `holeCards` is `null` preflop | A.holes=`[46,49]` B.holes=`[35,27]` A.opp=`[null]` B.opp=`[null]` | `packages/poker-engine/src/redact.ts` `redactFor`; `apps/api/src/rooms/table.ts` `viewFor(userId)`; `apps/api/src/ws/router.ts` `broadcast` per recipient | Entitlement is `playerId`, not seat index |
| SEC-002 | Undealt / future deck cards never leak | **PASS** | — | Deep-scan all WS frames + REST room/hand JSON for `deck`, `deckCursor`, remaining cards | No `deck` / `deckSalts` / `deckCursor` keys; only board + own holes on the wire | `A.secret=[]` `B.secret=[]` | `redact.ts` constructs `PlayerView`; `table.ts` never returns `HandState` | `cardsHiddenFrom` includes undealt suffix |
| SEC-003 | RNG salts / seed sealed; Merkle reveal = board + shown hands only | **PASS** | — | (1) Fold-out hand inspect `result.reveal`. (2) Check-down showdown inspect reveal + review | Fold-out: `endedByFold=true`, `showdowns=[]`, `reveal.cards=[]`, `complete=false`. Showdown: 9 proved positions (5 board + 4 holes), `complete=false`, verification `ok` | Fold reveal root `6d5bc4a9…` cards `[]`. Follow-up showdown `revealN=9` `verifiedPositions=9` both seats `showedDown=true` | `packages/poker-engine/src/machine.ts` `settle` `publicPositions`; `commitment.ts` `revealPositions`; `review/build-review.ts` refuses `complete: true` | Follow-up review: Alice `2d 9c`, Bob `Td Tc` only because both showed |
| SEC-004 | Unauthorized room/table state not readable | **PASS** | — | GET `/rooms/:id` as non-member; GET without cookie; GET `/rooms` unauthenticated | Non-member `404 room_not_found_or_not_permitted`; unauth `401 not_authenticated` | C GET room → 404 same code as missing room. Unauth list 401 | `routes/rooms.ts` `openRoomFor`; `registry.require` | Existence not confirmed to strangers |
| SEC-005 | Session minting (guest) | **PASS** | — | `GET /auth/session` then `POST /auth/guest` with CSRF | 201, distinct `usr_…` ids, `kind=guest`, session cookie set | A=`usr_b2xqwkhx4xjonbjv7uk74uamta` B=`usr_o74lkhflxibz23uxzj54zytaqy` | `routes/auth.ts` `POST /auth/guest`; `issueSession` always new token | Address-keyed rate limit 10/min (see SEC-015) |
| SEC-006 | Cookie flags (`__Host-` or equivalent / Secure / HttpOnly / SameSite) | **PASS** | — | Read `Set-Cookie` on live guest mint; read production naming in source | Live **development**: `prl_session=….<hmac>`; `HttpOnly`; `SameSite=Lax`; `Path=/`; **no** `Domain`; **no** `Secure`; name is **not** `__Host-prl_session`. CSRF cookie same flags | `prl_session=OIosex935M8s…; Max-Age=1209599; Path=/; HttpOnly; SameSite=Lax` | `plugins/security.ts` `sessionCookieName` / `sessionCookieOptions` | `__Host-` + `Secure` are production-only (`isProduction` / `cookieSecure`). Correct for `http://127.0.0.1`. Signed HMAC-SHA256 |
| SEC-007 | Session fixation | **PASS** | — | `POST /auth/guest` while already holding a session cookie | New token issued; previous identity replaced; cookie value changed | `rotated=true` oldUser=`usr_b2xqwkhx…` newUser=`usr_ogzwpu66…` | `auth/session.ts` `issueSession` revokes previous, `store.create` new token | Never reuses the presented token |
| SEC-008 | Session forging / tamper / replay-after-logout | **PASS** | — | Unsigned cookie; flipped byte of signed cookie; logout then replay old token | Unsigned → `user:null` + rooms `401 not_authenticated`. Tamper → `401 not_authenticated`. Replay → `401 session_expired` | logout `204`; replay rooms `401 session_expired` | `resolveSession` unsign first; `destroySession` + `sessions.revoke` | Unknown/expired/revoked are one `null` from the store |
| SEC-009 | Guest session boundaries | **PASS** | — | A records lesson read + plays hands; D lists hands and progress | D `handsPlayed=0`, `hands=[]`, `lessonsCompleted=[]`; A has 4 hands and `hand-flow` | `A.lessons=["hand-flow"]` `D.handsPlayed=0` | `GET /me/progress` `requireSession`; `GET /hands` `s.user_id = caller` | No user-id parameter to swap |
| SEC-010 | Authorization (seat/turn/room-not-joined/uninvited/private-join) | **PASS** | — | Wrong invite; uninvited REST sit; uninvited WS `hello`; out-of-turn action | Wrong invite `404 invite_code_invalid`. Uninvited sit `404 room_not_found_or_not_permitted`. Uninvited hello `error` + close **4403**. OOT `not_your_turn` | sit C → 404; hello C close `4403 not permitted` | `registry.joinByInviteCode`; `router.onHello` / `reopenFor`; `LiveTable.submitAction` | Same 404/4403 for missing and foreign rooms |
| SEC-011 | WebSocket Origin validation + cross-site WS hijack | **PASS** | — | Upgrade with `Origin: https://evil.example`; missing Origin; no cookie | Evil → close **4406** `origin not allowed`, 0 frames. Missing Origin → **4406**. No session → **4401** `no session` | First missing-Origin attempt used default allowlist (harness bug). Retry with omitted header → 4406 | `ws/hub.ts` `evaluateUpgrade` + `isAllowedOrigin` | Missing Origin fail-closed. Page script cannot forge Origin |
| SEC-012 | CSRF double-submit (omit / reuse / cross-origin) | **PASS** | — | POST guest with no token; POST rooms with A’s token on B’s cookie; POST rooms with valid token + `Origin: https://evil.example` | Omit `403 csrf_failed`. Reuse `403 csrf_failed`. Cross-origin mutating `403 forbidden` (CORS refuse, side-effect blocked) | bodies use contract messages only | `plugins/security.ts` `preValidation` CSRF; `applyCors` refuses disallowed mutating Origin | Header-only token (`x-csrf-token`). GET/WS exempt by design |
| SEC-013 | Input validation (JSON/types/extra/`__proto__`/numbers/oversized) | **PASS** | — | Extra field + `__proto__`; bad types; 80k name; isolated `__proto__` and `constructor` bodies | Extra → `400 invalid_request` field `extra`. Types `400`. Oversized `413 payload_too_large`. Isolated `__proto__` / `constructor` `400 invalid_request` | Fastify `onProtoPoisoning: 'error'`; schemas `additionalProperties: false` | `plugins/security.ts` `securityServerOptions`; `packages/contracts/src/schemas.ts` | Ajv `removeAdditional: false` so extras are rejected, not stripped |
| SEC-014 | SQL injection on every reachable parameter | **PASS** | — | Invite `1' OR '1'='1`; room/lesson/hand ids with quotes and `DROP TABLE` | All **400 invalid_request** at schema (patterns). No 500, no SQL in client body | invite/room/lesson/hand all 400 | `postgres` tagged templates in `routes/hands.ts`, `repositories/rooms.ts`; `PATTERNS.ID` | Values are bind parameters. Ajv rejects before SQL |
| SEC-015 | Rate limiting is real and not `X-Forwarded-For` bypassable | **PASS** | — | Exhaust guest mint (address-keyed); retry with `X-Forwarded-For` / `X-Real-Ip: 203.0.113.77` | Guest loop hit **429**. XFF spoof still **429** `rate_limited`. `TRUST_PROXY=false` so `request.ip` is the TCP peer | `guestStatuses=403,403,403,429` (early 403 = CSRF jar bug in loop) then `xff=429` | `clientKeyedRateLimit` on `/auth/guest`; `trustProxy: false` in `.env` | First three 403s were the harness omitting the CSRF cookie. Limiter still fired. XFF ignored |
| SEC-016 | Idempotency (action replay does not double-apply) | **PASS** | — | Replay same `actionId` + same `expectedSequence` after a call | Second ack `deduplicated: true`, same `appliedSequence: 1` | `applied={ack, appliedSequence:1}` `replay={ack, appliedSequence:1, deduplicated:true}` | `LiveTable.submitAction` memo **before** turn/sequence checks | Retry is success, not `not_your_turn` |
| SEC-017 | Sequence handling (stale/future rejected) | **PASS** | — | Future `expectedSequence+50` on first run; follow-up: after call (seq 0→1), other player still to act sends `expectedSequence: 0` | Future → `stale_action_sequence`. Follow-up stale-while-to-act → `stale_action_sequence`. First-run “stale” after the actor had already acted → `not_your_turn` (not applied) | Follow-up `staleAck.error.code=stale_action_sequence` `otherSeq=1` `toAct=0` | `LiveTable.submitAction` sequence check after turn check | First FAIL was harness: actor no longer to act. Control holds |
| SEC-018 | Reconnect restores state, no leak, not hijackable | **PASS** | — | Close B’s socket; new socket, same cookie, `hello` | `welcome.seat=1`; state restored; opponent holes still null | `selfHoles=[28,44]` (completed hand, self); `oppShown=[]` | `router.onHello` `sendState` = current `viewFor` | Reconnect is “send the current view”, no catch-up protocol |
| SEC-019 | Race / chip conservation / no double-spend of actions | **PASS** | — | Concurrent two different `actionId`s at same sequence from the player to act; stack sum after hand | One `ack:false`, other `not_your_turn`. Stacks `400==400`. Nets sum 0 | `results=["ack:false","not_your_turn"]` `sumStacks=400` | Per-table async queue in `LiveTable.enqueue`; DB unique seat index | Queue is the ordering; `expectedSequence` is the stale guard |
| SEC-020 | WS resource limits (socket cap / oversized / flood) | **PASS** | — | 80 pings; 12k nonce; 5th socket on one session | Flood close **4429** `too many messages` (39 pongs then drop). Oversized **4429** `frame too large`. 3rd extra socket **4429** `too many sockets` (cap 4) | `closes=[null,null,{4429 too many sockets}]` | `WS_LIMITS` in `ws-protocol.ts`; `takeToken` / `evaluateUpgrade` | Library `maxPayload` is 4× protocol cap |
| SEC-021 | Logs do not leak secrets or hole cards | **PASS** | — | Grep this session’s API stdout for `holeCards`, `deckSalts`, `salts`, `usr_`, session tokens | No hole-card/deck/user-id lines. Schema errors log the **pattern**, not the injected value | Two `inviteCode must match pattern` lines only | `logging.ts` `SENSITIVE_KEY_PATTERN`, `EXPLICIT_SENSITIVE_KEYS` (`holecards`,`deck`,`salt`), `REDACT_PATHS` | Serializers drop query **values** (OIDC `code`) |
| SEC-022 | Multiplayer functional proof (two independent sessions → complete a hand) | **PASS** | — | Two `ws` clients, independent cookies, sit, deal, check/call to showdown | Hand 2: `street=complete` both sides, `endedByFold=false`, pot 20, nets `{0:0,1:0}` (chop) | `start2=ack steps=8 done=true` | Full path: hub → router → `LiveTable` → engine | Also completed a fold-out hand first |
| SEC-023 | Seat-reuse hole-card leak | **PASS** | — | After B’s last holes `[18,47]`, B stands; C joins + sits seat 1; inspect C’s view of retained completed hand | C `sit` ack; `viewerSeat=null`; `self` undefined; `holes=[]`; old B pair absent | `street=complete` spectator view | `viewFor` → `redactFor({viewerPlayerId})`; hand roster is deal-time `playerId` | Chair inheritance does not inherit cards |
| SEC-024 | Hand-history / hand-review hidden-info + authz | **PASS** | — | `GET /hands` as A vs D; `GET /hands/:id` as A, as D, unauthenticated; inspect seats | A list n=4; D list n=0; D review `404`; unauth `401`. Fold-out review: own holes only, opponent `null`, `showed=false` | Follow-up showdown review: both seats’ holes visible **only** because `showedDown=true` for both | `routes/hands.ts` `findOwnHand` + SQL `CASE user_id=:viewer OR showed_down`; `build-review.ts` second filter | SQL and builder both apply the column rule |
| SEC-025 | Web/RSC bundled hidden info | **PASS** | — | Grep `apps/web/.next` `{js,rsc,json,html}` for `deckSalts`, `deckCursor`, `saltHex`, `"holeCards"` | No live-deck fields. Hits are: card helpers, CommitmentVerifier, and **canned teaching fixtures** (`apps/web/src/fixtures/review.ts` baked into SSR/static chunks) | Fixture salts (e.g. `d12c3d8aba295bdfff2b…`) are published demo proofs, not a live `DeckSecret` | Web fixtures + `CommitmentVerifier.tsx` | Teaching scenario hole cards in fixtures are public content, not hidden live state |
| SEC-026 | OIDC auth flow (state/PKCE/nonce) | **UNVERIFIED** | — | `GET /auth/oidc/start` and `GET /auth/oidc/callback?state&code` against this process | `501 oidc_not_configured` both. `.env` OIDC vars commented. Code implements discovery, PKCE S256, hashed state/nonce, `aud`/`iss`/`exp`/`nbf`, `timingSafeEquals` on nonce | Live: start 501, callback 501 | `apps/api/src/auth/oidc.ts`; `routes/auth.ts` `requireRelyingParty` | Not a fail. Cannot exercise state/PKCE/nonce against a real IdP this session |
| SEC-027 | Timing side-channels on secret comparisons | **PASS** | — | Read `timingSafeEquals`; time 20 short vs long forged cookies against `/auth/session` | Compare is `crypto.timingSafeEqual` with length-mismatch folded so it does not throw. Network medians 1.67 ms vs 1.58 ms — not an oracle | `hashing.ts` `timingSafeEquals` | Session unsign is HMAC (library); OIDC state/nonce/PKCE use this helper | Length of attacker-chosen input is not a secret |
| SEC-028 | `startHand` authorization (who may start) | **PASS** | — | Owner start; non-member start; seated non-owner start | Owner `ack`. Non-member hello/start → **4403** / `room_not_found_or_not_permitted`. Seated **non-owner member `ack`** | Policy actually enforced: **any room member**, not owner-only | `router.onStartHand` → `registry.require` (membership) then `table.startHand()` | Protocol comment says “owner’s table”; implementation is membership. Not an authz hole: strangers cannot start |
| SEC-029 | Private bot state never exposed | **PASS** | — | `POST /rooms` with `bots:[{profile:nit,count:1}]`; sit; deal; scan REST + WS | REST members show `isBot` + public `botProfile` (`disciplined-specialist`). No `traits` / `observations` / `policyInput`. Bot hole cards `null` in human view | `oppHoles=[]` `secrets=[]` street=preflop bot seat 1 holes=null | `bots.ts` `buildPolicyInput` from `viewFor(botUserId)` only; `toRoomSummary` exposes `botProfile` | Profile id is public table chrome, not hole cards or policy internals |
| SEC-030 | Deck material / commitment salts never on the wire except legitimate reveal | **PASS** | — | Mid-hand state scan; fold-out reveal; showdown reveal | Mid-hand: `result=null`, no `saltHex`. Fold-out: empty `cards`, `complete=false`. Showdown: per-card `saltHex` only for the 9 public positions | Mid-hand keys listed in transcript; no `deckSalts` | `LiveTable.settleIfComplete` drops `secret`; reveal built in `machine.settle` | `complete: true` refused at review parse |
| SEC-031 | Disconnect → reconnect preserves seat and does not leak | **PASS** | — | Drop B, reconnect same cookie | `welcome.seat=1` preserved; no opponent holes | `seat=1` `userB=usr_o74lkhflxibz23uxzj54zytaqy` | `registry.noteSocket`; seating is user-id keyed | Same as SEC-018 with explicit seat assertion |
| SEC-032 | `seatBot` ordering/race does not create authz/state corruption | **PASS** | — | Concurrent REST sit same seat; concurrent `POST /rooms` with bots (the only `seatBot` path) | Same-seat: `200` + `409 seat_taken`. Two bot rooms: both `201`, 2 bots each, no 500 | `statuses=409/200 codes=["seat_taken",null]` | `LiveTable.sit` queued; `room_members_live_seat_key`; `seatBot` is not a public route | No public `seatBot` after create. Human cannot take a bot seat without `seat_taken` |

---

## Attack transcripts

### T1 — Guest mint, cookies, CSRF, session attacks

```
GET /api/v1/auth/session
→ 200 {user:null, csrfToken:…, oidcEnabled:false}
Set-Cookie: prl_csrf=…; Path=/; HttpOnly; SameSite=Lax

POST /api/v1/auth/guest {displayName} + x-csrf-token
→ 201 {user:{id:usr_…, kind:guest}, csrfToken}
Set-Cookie: prl_session=<token>.<hmac>; Max-Age=1209599; Path=/; HttpOnly; SameSite=Lax

POST /auth/guest  (no CSRF header)
→ 403 csrf_failed

POST /rooms  (B cookies + A csrf token)
→ 403 csrf_failed

POST /rooms  (A cookies + A csrf + Origin: https://evil.example)
→ 403 forbidden     // CORS mutating refuse; no room created

GET /auth/session  Cookie: prl_session=forged-token-not-signed…
→ user:null
GET /rooms same cookie
→ 401 not_authenticated

GET /rooms  Cookie: <valid session with one HMAC byte flipped>
→ 401 not_authenticated

POST /auth/guest  (already signed in)
→ 201, new usr_ id, new prl_session value (fixation closed)

POST /auth/logout → 204
GET /rooms  Cookie: <revoked token>
→ 401 session_expired
```

### T2 — Private room, invite, uninvited, two-player deal

```
POST /rooms {name:AuditTable, maxSeats:6, 5/10, stack:200}
→ 201 {room.id, inviteCode}   // invite returned once

GET /rooms/:id   as guest C (not joined)
→ 404 room_not_found_or_not_permitted

GET /rooms/:id   no cookie
→ 401 not_authenticated

POST /rooms/join {inviteCode:"PRL-NOT-A-ROOM-XX"}
→ 404 invite_code_invalid

POST /rooms/join {inviteCode:<real>} as B
→ 200 members=2

POST /rooms/:id/sit {seat:0} as A → 200
POST /rooms/:id/sit {seat:1} as B → 200
POST /rooms/:id/sit {seat:2} as C → 404 room_not_found_or_not_permitted

WS A/B Origin http://localhost:3000 + session cookie
  hello → welcome seat=0 / seat=1
WS C hello same room
  error room_not_found_or_not_permitted, close 4403 not permitted

WS Origin: https://evil.example + A cookie
  close 4406 origin not allowed, 0 frames

WS no Origin + A cookie
  close 4406 origin not allowed

WS Origin allowlisted, no cookie
  close 4401 no session
```

### T3 — Hidden information on the wire (hand 1, preflop)

After `startHand` (owner):

```
A.state.view.street = preflop
A.seats[self].holeCards = [46,49]
A.seats[other].holeCards = null
B.seats[self].holeCards = [35,27]
B.seats[other].holeCards = null
result = null
no keys: deck, deckSalts, salts, traits, observations
commitmentRoot + commitmentContext present (public)
```

Out of turn (A while `toAct=1`): `error not_your_turn`.

Future sequence `+50`: `error stale_action_sequence`.

Call + replay same `actionId`: second `ack deduplicated=true appliedSequence=1`.

Drive folds → complete:

```
street=complete
endedByFold=true
showdowns=[]
reveal={commitment:{algorithm:sha256, version:prl-deck-v2, root:6d5bc4a9…, context:room_…:1:hand_…}, cards:[], complete:false}
folded hole pairs not present in reveal.cards
```

### T4 — Two-player hand to showdown (SEC-022)

```
startHand ack
8 legal check/call steps
both sockets: street=complete, endedByFold=false
pots=[{amount:20, eligibleSeats:[0,1], capPerSeat:10, index:0}]
nets={0:0, 1:0}   // chopped
sum(stacks)=400 = 2×200
reveal.cards.length=9, complete=false, saltHex only on those 9 leaves
```

Follow-up HU showdown review (`GET /hands/:id` as each player):

```
Alice seat0 showedDown=true holeCards=["2d","9c"] net=-10
Bobby seat1 showedDown=true holeCards=["Td","Tc"] net=+10
revealN=9 complete=false verification.ok=true verifiedPositions=9
```

Both seeing both holdings is correct **only because both showed**. Fold-out review in T3/T6 kept the folder sealed.

### T5 — Races, startHand authz, reconnect, seat reuse

```
Concurrent two actionIds at same sequence from the actor:
  ack:false  +  not_your_turn     // one apply

startHand as non-member (C never joined):
  hello/start → close 4403

startHand as seated non-owner (B):
  ack     // membership, not ownership

B disconnect / reconnect same cookie:
  welcome.seat=1, no opponent holes

B stand; C join invite; C sit seat 1 (B’s old chair); retained completed hand:
  sit ack
  viewerSeat=null, holes=[], old B pair [18,47] absent
```

### T6 — Hand history / guest isolation

```
GET /hands as A → 200 n=4
GET /hands as D (never played) → 200 n=0
GET /hands/:id as D → 404 hand_not_found
GET /hands/:id no cookie → 401
GET /hands/:id as A (fold-out) seats:
  seat0 showed=false holes=["Td","Ad"]   // viewer’s own
  seat1 showed=false holes=null          // folder sealed
GET /me/progress A vs D: A completed ["hand-flow"], D empty; D.handsPlayed=0
```

### T7 — Bots, seatBot, WS limits, rate limit

```
POST /rooms bots:[{profile:nit,count:1}]
  201 members: human + {isBot:true, botProfile:"disciplined-specialist", seat:1}
  JSON has no traits/observations/vpip
WS deal: human holes [41,42]; bot holes null

POST sit seat 3 as A and B concurrently:
  200 + 409 seat_taken

Two concurrent POST /rooms with 2 bots each:
  201/201, botsA=2 botsB=2

WS 80 pings: close 4429 too many messages (39 pongs)
WS ping nonce 12k chars: close 4429 frame too large
5th socket same session: close 4429 too many sockets

POST /auth/guest until limited, then same with X-Forwarded-For: 203.0.113.77
  429 then 429 (TRUST_PROXY=false)
```

### T8 — Validation / SQLi / proto / OIDC

```
POST /rooms extra field → 400 fields.extra
POST /rooms 80k name → 413 payload_too_large
POST /rooms {"__proto__":{"admin":true}} → 400 invalid_request
POST /rooms {"constructor":{"prototype":{…}}} → 400 invalid_request
POST /rooms/join invite "1' OR '1'='1" → 400 (pattern)
GET /rooms/x'%20OR%201=1-- → 400
GET /content/lessons/1';DROP… → 400
GET /hands/hand_1'%20OR%201=1-- → 400
GET /auth/oidc/start → 501 oidc_not_configured
GET /auth/oidc/callback?state=aaaaaaaa&code=bbbbbbbb → 501 oidc_not_configured
GET /rooms and /hands without cookie → 401
```

API stdout this session: no `holeCards` / `deckSalts` / user ids. Validation logs name the regex, not the payload.

---

## Findings (P0–P3)

No P0. Hidden-information checks were executed against live frames, not inferred from comments.

| Sev | ID | Title | Status |
|---|---|---|---|
| — | — | No confirmed defect that leaks hole cards, undealt deck, salts, or private bot state | — |

### Observations (not scored as defects)

1. **`startHand` is membership-gated, not owner-gated.** A seated invitee can deal. Strangers cannot. Matches `registry.require`. Worth documenting in the protocol comment (“owner’s table”).
2. **Development cookies omit `Secure` and `__Host-`.** Intentional (`NODE_ENV=development`, `cookieSecure` false). Production path in `sessionCookieName` / boot checks is the opposite.
3. **Web bundles include canned review fixture salts and teaching hole cards.** Public fixtures for the CommitmentVerifier demo, not a live `DeckSecret`.
4. **OIDC not live.** Implementation is substantial (PKCE S256, hashed state/nonce, alg allowlist, `aud`/`azp`, JWKS hammer floor). Unverified against a provider this session.

---

## Counts

| Class | Count |
|---|---|
| Requirements re-verified | 32 (SEC-001 … SEC-032) |
| **PASS** | 31 |
| **FAIL** | 0 |
| **UNVERIFIED** | 1 (SEC-026 OIDC unconfigured) |
| **P0** | 0 |
| **P1** | 0 |
| **P2** | 0 |
| **P3** | 0 |
| Two-player hands completed this session | 2 in the main harness (fold-out + showdown) + 1 follow-up showdown |
| Hidden-info leaks | **0** |

---

## Code map (read this session, not prior audits)

| Area | Path |
|---|---|
| Session mint / cookie / fixation | `apps/api/src/auth/session.ts`, `apps/api/src/routes/auth.ts` |
| Cookie flags, CSRF, CORS, rate limit, proto | `apps/api/src/plugins/security.ts` |
| XFF / client key | `apps/api/src/plugins/request-context.ts`, `apps/api/src/config.ts` `trustProxy` |
| Timing-safe compare | `apps/api/src/repositories/hashing.ts` `timingSafeEquals` |
| OIDC (unconfigured live) | `apps/api/src/auth/oidc.ts` |
| WS origin / socket cap | `apps/api/src/ws/hub.ts` |
| Per-recipient broadcast, hello, startHand, action | `apps/api/src/ws/router.ts` |
| Queue, `viewFor`, action memo, seat identity | `apps/api/src/rooms/table.ts` |
| `seatBot`, membership, invite join | `apps/api/src/rooms/registry.ts` |
| Bot policy input from redacted view only | `apps/api/src/rooms/bots.ts` |
| Redaction-by-construction | `packages/poker-engine/src/redact.ts` |
| Merkle reveal of public positions only | `packages/poker-engine/src/commitment.ts`, `machine.ts` `settle` |
| Hand review SQL + second filter | `apps/api/src/routes/hands.ts`, `apps/api/src/review/build-review.ts` |
| WS contract / limits | `packages/contracts/src/ws-protocol.ts`, `schemas.ts` |
| Log redaction | `apps/api/src/logging.ts` |

---

## Independence statement

Controls were re-broken from source and from a process this session started on port 4201. Previous audit markdown was not read. PASS rows are ones this session actually sent (or, for OIDC, honestly could not send).

# Final independent verification — Poker Risk Lab

**Auditor:** independent of the agents that built and remediated this commit. Prior PASS claims, `docs/audit/blocker-remediation.md`, test counts in commit messages, and `docs/audit/keyboard-audit.json` were not treated as evidence until re-derived.

**Candidate:** `56a51284533e54fd3deceac38cbe9de2a9ad9890`  
**Working tree:** clean, `git rev-parse HEAD` equals the candidate.  
**Date:** 2026-08-20  
**Environment:** Node 24.18.0, pnpm 11.10.0, Docker 29.6.1, Chrome 151.0.7922.169, macOS arm64.

## Verdict

**`RELEASE: FAIL`**

Not a ceremonial result. Two independent mandatory failures remain:

1. **F — screen reader is UNVERIFIED.** VoiceOver is installed. System Events automation timed out (TCC). VoiceOver AppleScript `launch` / `output` / `last phrase` timed out. ARIA inspection and the keyboard audit are not a screen-reader test. This requirement is mandatory. UNVERIFIED blocks approval.
2. **P1 — Expert Legends still serves live Coach** after advertising `coachAvailable: false` / “Coach in review only”. Reproduced on this commit against a live API: an Expert match returned `coachAvailable: false`, then `requestCoach` on our turn returned a Coach report (`suggestion: raise`, `confidence: low`). The web client auto-requests Coach on every turn with no check of that flag.

The six recently remediated blockers A–E and the probability *domain function* independently pass. Committed-state `pnpm run verify` is 11/11 PASS. That is not enough.

---

## How this was run

No application source was modified. Helpers lived under `/tmp/prl-final-verify/`.

| Step | What |
| --- | --- |
| Pin | `git rev-parse HEAD` = `56a51284533e54fd3deceac38cbe9de2a9ad9890`, `git status --porcelain` empty |
| H | `pnpm run verify` from this commit, log `/tmp/prl-final-verify/verify.log` |
| Runtime | API `node --env-file=.env apps/api/dist/server.js` on `:3001`; web `NODE_ENV=production pnpm start` on `:3000` |
| A | Create 12 Legend matches → SIGTERM API PID 80080 → start new PID 80266/80350 → `GET /rooms/:id` + SQL |
| B | `curl` headers + Chrome CDP negative control + production `poker-risk-lab-web` image on `:3100` |
| C | Two real Legend hands over WebSocket, then `GET /legends/hands/:id/comparison` |
| D | Fresh Chrome `--user-data-dir` profiles to `/learn` and `/lab` |
| E | `node scripts/keyboard-audit.mjs` against this production web (137/137) |
| F | VoiceOver / System Events / Safari AppleScript, all bounded |
| G | Independent probe of `normaliseProbability` / `formatProbability`, not the existing test file |
| H extras | `pnpm run test:keyboard`, `node scripts/smoke-test.mjs --strict` (isolated re-run 60/60), `docker compose build api web`, SBOM inside `security:audit` |
| Challenger | New `general-purpose` subagent, same model, no prior findings. Report at `/tmp/prl-final-verify/challenger-findings.md`. P1-1 re-derived here. |

---

## A — Bot / Legend restart

**PASS**

### What was done

1. `POST /api/v1/legends/matches` once per strategy profile, rotating difficulty `educational` / `realistic` / `expert` and distinct `deterministicSeed`s.
2. Read `prl.room_members` (`bot_profile`, `bot_difficulty`, `bot_seed`).
3. `kill -TERM` the API (PID 80080). Port 3001 freed in 1s. New process PID 80266.
4. `GET /api/v1/rooms/:id` (this is the `ensureOpen` path) for each of the 12 rooms, same session cookie.
5. Plant `bot_profile='unknown'`, `bot_difficulty=null`, `bot_seed=null` on a new room, SIGTERM again (PID 80266 → 80350), then `GET` that room.

### Evidence

All 12 ids persist under their own name. None wrote `unknown`.

| Profile | Difficulty | Stored seed (uint32) | After restart `members[].botProfile` |
| --- | --- | ---: | --- |
| vocal-aggressor | educational | 2686659725 | vocal-aggressor |
| adaptive-exploiter | realistic | 555363573 | adaptive-exploiter |
| patient-technician | expert | 803601363 | patient-technician |
| reading-pressure-specialist | educational | 1408160810 | reading-pressure-specialist |
| old-school-pressure | realistic | 1167262802 | old-school-pressure |
| mixed-game-generalist | expert | 445675925 | mixed-game-generalist |
| volume-grinder | educational | 1973370310 | volume-grinder |
| disciplined-specialist | realistic | 1023135230 | disciplined-specialist |
| foundational-reader | expert | 49056530 | foundational-reader |
| range-narrator | educational | 1632988483 | range-narrator |
| fundamentals-coach | realistic | 3382150475 | fundamentals-coach |
| calling-station | expert | 863678601 | calling-station |

- Invalid id `not-a-real-legend` → `400 invalid_request`.
- SQL `UPDATE … bot_profile='nit'` and `'retired-legend-xyz'` both violate `room_members_bot_profile_allowed`. The CHECK is exactly the twelve ids plus `unknown` (`pnpm run db:verify`: “bot_profile permits exactly the 13 runtime values”).
- After process death, `adaptive-exploiter` completed a hand (`hand_z5krw2lrszy4aubm7buapocet4`) — the seat was not inert.
- Planted `unknown` row after restart: `GET` returned `botProfile: "unknown"` (no substitution). API log:

```
"roomId":"room_i2d2upqilskbartgbt2fmgkppp","seat":1,"botProfile":"unknown",
"reason":"the row predates migration 0003 and its strategy profile was destroyed at write time",
"msg":"a bot seat could not be restored and will not act"
```

Locations: `apps/api/src/rooms/bot-profile.ts`, `apps/api/src/rooms/registry.ts` `ensureOpen` / `rehydrateBot`, `db/migrations/0003_bot_seat_recovery.sql`, `apps/api/scripts/verify-schema.mjs` check 8.

---

## B — CSP

**PASS**

### Host production `next start` (`http://localhost:3000/learn`)

`curl -sSI` and Chrome CDP (`/tmp/prl-final-verify/csp-browser.mjs`):

| Check | Result |
| --- | --- |
| Header present on HTML | PASS |
| Per-response nonce | PASS (`'nonce-…'`, 24 chars, present in HTML) |
| Theme hash | PASS (`'sha256-pFr/J6mAOwOBw+OUbWRw3SFuJuxHv7yTRXbAhz9wOxo='`) |
| `script-src` `'unsafe-inline'` | absent |
| `script-src` `'unsafe-eval'` | absent |
| Every `<script>` carries nonce | 15/15 |
| Page interactive after policy | `document.readyState=complete`, 69 controls, title `Learn — Poker Risk Lab` |
| Negative control | `button.setAttribute('onclick', "window.__prlInjected='EXECUTED'")` then real click: handler did **not** run; `securitypolicyviolation` `violatedDirective: script-src-attr`, `blockedURI: inline` |

Companion headers: `x-content-type-options: nosniff`, `x-frame-options: DENY`, `referrer-policy: same-origin`, `cross-origin-opener-policy: same-origin`.

`style-src-attr 'unsafe-inline'` is present and confined to that directive. Stated residual, not a script-src hole.

### Production container image

```
docker compose build api web   # poker-risk-lab-web:latest
docker run -d -p 127.0.0.1:3100:3000 -e NODE_ENV=production poker-risk-lab-web:latest
curl -sSI http://127.0.0.1:3100/learn
```

Same policy shape: nonce + hash + `'strict-dynamic'`, no `unsafe-inline`/`unsafe-eval` in `script-src`, `upgrade-insecure-requests`. HTML: 15 script tags, 0 without nonce, policy nonce present in HTML (`M43t42D1p/nTWymVdFgtCQ==`).

Configuration-file presence was not accepted as proof.

Locations: `apps/web/src/proxy.ts`, `apps/web/src/lib/csp.ts`.

---

## C — Legend hand review

**PASS**

Two real Legend hands, played over WebSocket against the live engine, then loaded through `GET /api/v1/legends/hands/:handId/comparison`.

| | Hand A | Hand B |
| --- | --- | --- |
| Opponent | adaptive-exploiter | vocal-aggressor |
| Hand id | `hand_nbrjo22vcrq7ylzlxjw7h6b46v` | `hand_zj4o3nisnski6mr6gcvu5tj2xo` |
| Live board (engine ints) | `[9,4,50,40,44]` | `[39,47,14,28,22]` |
| Review board | `4d 3c Ah Qc Kc` | `Js Ks 5h 9c 7h` |
| Encoding match | exact (`rank*4+suit`) | exact |
| Chip result | −16 | −14 |
| Decision count | 8 | 9 |
| `profileId` on comparison | adaptive-exploiter | vocal-aggressor |

Reviews are distinct (different board, result, decision count, profile). Comparison JSON keys: `handId`, `board`, `decisions`, `chipResult`, `decisionQuality`, `profileId`, `disclosure`. No sample/fixture body.

Authorization:

- Stranger and missing id both `404 hand_not_found`.
- Unauthorized body has no `decisions` / `board`.

HTML (production web):

- `/legends/hand-review` (no `?hand=`) → empty state “Choose a hand to review”, link to demo. **No** “bundled sample hand” banner.
- `/legends/hand-review?hand=hand_doesnotexist000` → not-found body, **no** sample banner, **no** fixture board.
- `/legends/hand-review/demo` → banner “This is a bundled sample hand, not one of yours”. Demo only on the explicit demo route.

`loadHandComparison` does not return `HAND_COMPARISON_FIXTURE`. That function is `demoHandComparison()`, used only by the demo page.

Locations: `apps/web/src/lib/legends-data.ts`, `apps/web/src/app/legends/hand-review/page.tsx`, `apps/web/src/app/legends/hand-review/demo/page.tsx`, `apps/api/src/routes/hands.ts`.

Residual (P2, not a silent sample fallback): the page copy still promises the model’s sampled weights. Stored hands set `decision: null`, so `modelReasoning` is always null on the live path. See Challenger P2-1.

---

## D — Guest bootstrap

**PASS**

### Fresh Chrome profile → Learn

`/tmp/prl-final-verify/guest-browser.mjs`, `--user-data-dir` unique, headless Chrome, real navigation:

- `/learn` minted `prl_session` guest `usr_66eu35lj4bu4g3khipfy3mdrdj`.
- Navigation to `/learn/pot-odds` and reload preserved that id.
- `POST /content/lessons/pot-odds/read` recorded `completedAt=2026-08-20T00:54:50.419Z`.
- Still one session cookie.

### Fresh Chrome profile → Scenario Lab

- `/lab` minted a **different** guest `usr_ta5tpbepomotnpx3usivunil6i` (separate profile, as required).
- Reload preserved identity.
- Scenario attempt `eq-flush-draw-turn-small-bet` → `200 recorded=true`.

### Other

- Prefetch (`sec-fetch-dest: empty`, `rsc: 1`, `next-router-prefetch: 1`) minted nothing.
- Existing session cookie reused on a second document GET of `/learn` (authenticated/guest replacement guard: any existing session cookie skips mint). OIDC is not configured on this stack, so a live OIDC user was not available; the cookie-name test is the mechanism that would protect one.
- Isolated `node scripts/smoke-test.mjs --strict` §11: guest on `/learn`, identity stable across navigation/refresh/concurrent GETs, `/legends` anonymous, prefetch silent, lesson recorded.

One earlier `--strict` smoke run failed §11 (`no session cookie`) **while** `test:keyboard` was driving the same origin. Isolated re-run: 60/60. Classified as contention, not a product defect.

Locations: `apps/web/src/proxy.ts`, `apps/web/src/lib/guest-bootstrap.ts`.

---

## E — Keyboard accessibility

**PASS**

Independent re-run, not the committed JSON:

```
PRL_WEB_ORIGIN=http://localhost:3000 PRL_API_ORIGIN=http://127.0.0.1:3001 \
  node scripts/keyboard-audit.mjs --json /tmp/prl-final-verify/keyboard-audit.json
Chrome/151.0.7922.169 — headless
137 check(s) passed, 2 warning(s)
```

Real `Input.dispatchKeyEvent` (Tab, Shift+Tab, Enter, Space, Escape, arrows). Journeys:

| Journey | Result |
| --- | --- |
| Learn `/learn` | 62 tab stops, skip link → `<main>`, no trap, visible focus |
| Guided practice `/learn/pot-odds` | 39 stops; focus survives the update it triggered |
| Scenario Lab `/lab` and `/lab/preflop-open-cutoff` | 55 / 20 stops; sliders included on the spot |
| AI Legends `/legends` and `/legends/adaptive-exploiter` | 43 / 31 stops |
| Hand review `/legends/hand-review` and `/demo` | 20 / 25 stops; 28 named cards on demo |
| Poker table + Coach `/play?state=decision` | 31 stops; warning: fixture actions disabled (covered by live table) |
| Poker table `/play` | warning: no action row until a table is open |
| Hand complete `/play?state=complete` | 166 named card elements |
| `/review`, `/record`, home | skip / order / focus / no trap |
| Narrow 390×844 menu sheet | Enter opens `aria-modal`, Tab and Shift+Tab trapped, Escape restores focus |
| Live private table | Open table → sit → deal → slider arrows 20→23 → End to max → Fold with Enter accepted by server; focus survived the update |

Warnings are fixture/idle states, not failures.

---

## F — Screen reader (release-blocking)

**UNVERIFIED**

This is the known mandatory requirement. It was not converted to PASS.

Attempted:

| Probe | Result |
| --- | --- |
| VoiceOver.app present | `/System/Library/CoreServices/VoiceOver.app` exists |
| `osascript` System Events | **timeout 4s** (TCC / automation permission) |
| `tell application "VoiceOver" to get name` | returns `VoiceOver` (the app object exists) |
| `tell application "VoiceOver" to launch` / `output` / `get content of last phrase` | **timeout 5s each** |
| `pgrep VoiceOver` before launch | not running |
| After `launch` hang | PID 81242 appeared; later gone. Not a usable caption/navigation session |
| NVDA | not applicable (macOS) |

No VoiceOver + Safari walk of Learn → Guided Practice → Poker Table/Coach → Scenario Lab → AI Legends → Hand Review was completed. No announcements of card names, whose turn, pot/stack, legal actions, Coach updates, errors, or hand completion were captured from a screen reader.

Code/ARIA inspection (`role="img"` + `aria-label` on cards, `aria-live="polite"` on the table, skip link, landmarks) was performed and is **not** counted as this check.

**Mandatory UNVERIFIED ⇒ cannot declare `RELEASE CANDIDATE: PASS`.**

---

## G — Probability domain

**PASS** for the domain function and the named numeric cases. **Residual P2** on two presentation paths that still bypass it.

Independent probe (`node --experimental-strip-types /tmp/prl-final-verify/probability-probe.mjs`), 17/17:

| Case | Domain | Notes |
| --- | --- | --- |
| `<0` (−0.5) | refused | `formatPercent` would print `-50.0%` |
| slightly `<0` beyond tolerance (−1e-8) | refused | |
| 0, −0 | accepted `0.0%` | |
| near 0 (1e-300, 1e-12) | accepted | |
| 1 | accepted `100.0%` | |
| `1+EPSILON`, `1.0000000000000002`, `1+TOLERANCE` | snapped to 1 / `100.0%` | |
| just past tolerance (`1+10·TOLERANCE`) | refused | |
| materially `>1` (1.6, 36) | refused | would have printed `160.0%` / `3,600.0%` |
| NaN, ±Infinity | refused | |
| valid 0.36 | `36.0%` | |

`packages/ui/test/probability.test.ts` independently re-run: 20/20.

`formatPercent` is unchanged (`formatPercent(1.6)==="160.0%"`). Sites that call `formatProbability` return `null` / `"not a probability"`.

Residual, confirmed in source, not a 160% live print:

- `Metric` `format="percent"` multiplies by 100 with no domain check (`packages/ui/src/components/Metric.tsx`). `PostHandComparison` and `HandReplay` pass `heroEquity` / `breakEvenEquity` through it. Challenger P2-2.
- `@prl/poker-ai` `commentary.ts` has a private `formatPercent` used in learner-facing model voice.

Producer still throws in `assertProbabilityFraction` (`packages/poker-math/src/coach.ts`). No live 160% was observed on Coach or smoke analysis (AA vs KK 81.26%, scenario 26.8%).

---

## H — Committed-state release gates

**PASS** (this commit, this machine). First smoke `--strict` failed §11 under concurrent keyboard load; isolated re-run passed. Not left as an unexplained intermittent.

### `pnpm run verify` — 11/11

Log: `/tmp/prl-final-verify/verify.log`. Exit 0.

| Gate | Result |
| --- | --- |
| security:audit | PASS (policy, hygiene, denylist, shapes, Shai-Hulud IOC, CI pinning, provenance, OSV, **SBOM**) |
| security:hygiene | PASS |
| lint | PASS |
| build | PASS |
| typecheck | PASS |
| design:contrast | PASS |
| test | PASS |
| test:a11y | PASS |
| test:exhaustive | PASS (all 133,784,560 seven-card hands) |
| test:simulation | PASS |
| db:verify | PASS |

Node:test summaries in that log: **1833 tests, 1833 pass, 0 fail** across engine 133, contracts 21, math 247, ui 250, content 29, poker-ai 148, web 178, api 699, scripts 103, exhaustive 2, simulation 23.

API 699 includes bot restart (`z3`), legend comparison (`z4`), WS reopen (`y2-ws-room-reopen`), table concurrency, hidden-information API tests.

### Additional gates required by this audit (not all inside `verify`)

| Gate | Result |
| --- | --- |
| `node scripts/keyboard-audit.mjs` | 137 pass |
| `node scripts/smoke-test.mjs --strict` (isolated) | 60 pass, including hidden-info WS scan (34 frames, no deck/cursor/salt, no mid-hand foreign hole cards), hand isolation, CSP §10, guest §11, rate limit |
| Production web/API builds | `verify` `build` + running `apps/api/dist/server.js` + `next start` |
| Container builds | `docker compose build api web` → `poker-risk-lab-api:latest`, `poker-risk-lab-web:latest` |
| Container CSP | PASS (section B) |
| SBOM | generated by `security:audit` (`docs/sbom/poker-risk-lab.cdx.json` rewritten during verify) |

---

## Final challenger

One new `general-purpose` subagent, same model, no prior findings. Instruction: assume the release is being approved too early; prove it should not ship. Full text: `/tmp/prl-final-verify/challenger-findings.md`.

The challenger reported **P0: 0, P1: 1, P2: 3, P3: 1**, plus two UNVERIFIED items that this audit *did* complete (keyboard, process restart).

### P1-1 — Expert Legends still serves live Coach — **reproduced here**

**Severity: P1**

Match create (this session):

```
POST /api/v1/legends/matches
{"profileIds":["adaptive-exploiter"],"difficulty":"expert",…}
→ 201
difficulty.coachAvailable = false
description includes: "The Coach is available afterwards in review, not during the hand."
```

On our turn, `requestCoach` returned a live report:

```
{"coach":{"suggestion":"raise","confidence":"low","hasAssumptions":true},"myTurn":true}
```

The server `onCoach` (`apps/api/src/ws/router.ts` 535–554) never reads difficulty. The client `use-live-table.ts` 806–810 auto-calls `askCoach()` whenever `isMyTurn`, discarding `CreateLegendMatchResponse.difficulty`. `DifficultyPicker` still shows “Coach in review only” for Expert (`apps/web/src/components/DifficultyPicker.tsx`). `DIFFICULTY_SETTINGS.expert.coachAvailable` is `false` (`packages/poker-ai/src/profiles.ts`).

Not P0: Coach is built from the caller’s redacted view. It is a false advertised control of a headline mode.

### P2-1 — Hand-review copy promises model weights the live path cannot have

**Confirmed in source.** Header of `apps/web/src/app/legends/hand-review/page.tsx` and `PostHandComparison.tsx` still say “the weights it sampled its action from”. Reconstruction sets `decision: null` (`apps/api/src/review/build-review.ts`). Demo fixture still has `modelReasoning`; live hands do not. Not a silent sample fallback.

### P2-2 — `Metric format="percent"` bypasses the probability domain

**Confirmed in source.** See G residual.

### P2-3 — Guest mint has no AbortSignal

**Confirmed in source** (`mintGuestSession` / `bootstrapGuest`). Happy path works. Failure-to-connect can stall the document until TCP dies. Not reproduced as a hang (API was up).

### P3-1 — `upgrade-insecure-requests` on `http://` `next start`

Observed on this host production server. Documented production deploy is HTTPS. Not scored as P1.

### Challenger UNVERIFIED items that this audit did complete

| Challenger left UNVERIFIED | This audit |
| --- | --- |
| Keyboard CDP | 137/137 PASS |
| API process restart | 12/12 profiles + unknown refusal PASS |

Hidden-information: challenger and this audit agree. Smoke §7–8 on this commit: no deck/cursor/salt on 34 frames; no mid-hand foreign hole cards; Bob does not see Alice’s hands.

---

## Findings table

| ID | Status | Severity | Summary |
| --- | --- | --- | --- |
| A bot/legend restart | PASS | — | 12/12 persist and rehydrate after SIGTERM; unknown refused with log |
| B CSP | PASS | — | Host + container HTML; nonce/hash valid; inline handler blocked |
| C hand review | PASS | — | Two real distinct hands; authz 404; demo only on `/demo` |
| D guest bootstrap | PASS | — | Fresh Chrome Learn and Lab; record works; no prefetch mint |
| E keyboard | PASS | — | 137 real-key checks including live fold |
| F screen reader | **UNVERIFIED** | P1 (mandatory) | VoiceOver not actually driven |
| G probability domain | PASS + residual | P2 residual | Domain cases pass; `Metric`/commentary still bypass |
| H committed gates | PASS | — | verify 11/11; smoke 60/60 isolated; images built; SBOM |
| Challenger P1-1 | **FAIL** | P1 | Expert live Coach despite `coachAvailable: false` |
| Challenger P2-1 | FAIL (non-blocking) | P2 | Copy promises model weights live path cannot store |
| Challenger P2-2 | FAIL (non-blocking) | P2 | `Metric` can still print an impossible percent |
| Challenger P2-3 | FAIL (non-blocking) | P2 | Guest mint fetch has no timeout |
| Hidden cards / future deck | PASS | — | No leak in smoke WS/history scan |

---

## Why not `RELEASE CANDIDATE: PASS`

The bar in the assignment is conjunctive. This commit fails it because:

- a mandatory requirement (actual screen-reader verification) remains **UNVERIFIED**;
- a **P1** remains: Expert Legends advertises Coach-in-review-only and still serves live Coach.

A–E, G’s domain function, and H independently pass. That is progress. It is not a shippable candidate.

## What would have to be true next time

1. An actual VoiceOver+Safari or NVDA+Chrome/Firefox pass of the listed journeys, with announcements captured, or an honest remaining UNVERIFIED (which still fails the candidate).
2. Expert (and any `coachAvailable: false` match) must not auto-request or return live Coach, **or** the chip/copy/API flag must describe the behaviour that actually runs. The socket handler must refuse, not only the UI.
3. Re-run this file’s A–H from the new commit. Do not carry these PASS cells forward by citation.

---

## Continuation (working tree, after the candidate FAIL)

The first-pass audit of `56a5128` is unchanged: that commit remains **`RELEASE: FAIL`**.

The P1 (Expert live Coach) was then closed in the **working tree**, not by rewriting history.

### P1-1 fix

- New error `coach_not_available` (409) in `packages/contracts/src/errors.ts`.
- `BotRunner.coachDuringHand()` is false when any registered bot plays a difficulty with `coachAvailable: false`.
- `WsRouter.onCoach` refuses **before** spending a Coach rate-limit token.
- Client: no auto-request and no “Refresh the analysis” on Expert; Coach sheet states review-only; a `coach_not_available` frame turns `coachDuringHand` off for reload-without-query-string.

Tests: `live Coach follows the match difficulty` (2/2), Legends match `coachAvailable: false` for expert, `live-regions` reducer test. Web typecheck passes.

Live retest against rebuilt `apps/api/dist/server.js`:

```
POST /legends/matches difficulty=expert → coachAvailable: false
requestCoach on our turn → error.code = coach_not_available
  message: "The Coach is available in review after the hand, not while it is being played at this difficulty."
coach: null
```

Previously the same sequence returned `suggestion: raise`.

### P2 fixes (working tree)

**P2-1 — hand-review copy.** `HandReviewHeader` and `PostHandComparison` no longer promise sampled model weights on stored hands. They say the log records the action taken, not the distribution, and that weights appear only when the record actually has them (the demo).

**P2-2 — `Metric format="percent"`.** `percent` now goes through `normaliseProbability`. `1.6` and `36` render as `not a probability`, not `160.0%` / `3,600%`. Non-finite values stay a dash (absent analysis). Tests in `packages/ui/test/metric-percent.test.ts` (4/4). Coach-panel render tests still 9/9.

**P2-3 — guest mint stall.** `mintGuestSession` defaults to `AbortSignal.timeout(GUEST_MINT_TIMEOUT_MS)` (4s), catches abort, returns null. The proxy passes the same deadline. Tests: aborted signal → null; timeout bounded 1–8s.

### Still blocking a candidate PASS

- **F remains UNVERIFIED.** VoiceOver still cannot be driven in this environment. That alone keeps the release FAIL.
- These source changes are **not** commit `56a5128`. A later candidate needs a new independent A–H pass.

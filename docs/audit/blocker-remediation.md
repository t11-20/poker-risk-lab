# Blocker remediation — Poker Risk Lab

**Date:** 2026-08-19
**Against:** `docs/audit/final-release-report.md`, verdict `RELEASE: FAIL`
**Starting HEAD:** `f20bbad` plus the uncommitted challenger patches in the working tree

This closes the six items that report named, plus two defects found while closing them. It is not
a re-audit: nothing here re-derives a verdict, and every claim below is a command that was run and
an output that was read.

---

## Summary

| Blocker | Was | Now |
|---|---|---|
| CHAL-P1-3 | Restart loses 7/12 Legend ids and re-registers no bots | Closed |
| CHAL-P1-4 | HTML origin serves no CSP | Closed |
| CHAL-P1-6 | `/legends/hand-review` always renders a bundled sample | Closed |
| PROD-048 | Learn/Lab mint no guest session | Closed |
| A11Y-001 | Keyboard journeys never Tab-tested in a browser | Verified, 2 defects found and fixed |
| P2 probability | `formatPercent` can print an impossible percentage | Closed |
| *(found here)* | `apps/web` did not typecheck | Fixed |
| *(found here)* | Migration gate test asserted a narrower rule than the gate | Fixed |

Full post-patch `pnpm run verify`: **11/11 gates PASS**. Details in §8.

---

## 1. CHAL-P1-3 — bots and Legend identity across a process restart

### Reproduction

Run before any change, from `apps/api`:

```js
import { PROFILES } from '@prl/poker-ai';
import { persistableProfile } from './src/rooms/bots.ts';
for (const p of PROFILES) console.log(p.naming.id, '->', persistableProfile(p.naming.id));
```

```
LOST  vocal-aggressor          -> unknown      OK  patient-technician          -> tight-aggressive
LOST  adaptive-exploiter       -> unknown      OK  reading-pressure-specialist -> loose-aggressive
LOST  old-school-pressure      -> unknown      OK  volume-grinder              -> maniac
LOST  mixed-game-generalist    -> unknown      OK  disciplined-specialist      -> nit
LOST  foundational-reader      -> unknown      OK  calling-station             -> calling-station
LOST  range-narrator           -> unknown
LOST  fundamentals-coach       -> unknown

7/12 Legend ids cannot be persisted (stored as "unknown").
```

The schema half reproduces through the new drift check in `apps/api/scripts/verify-schema.mjs`,
run against the pre-migration database:

```
✗ bot_profile constraint: does not permit vocal-aggressor, adaptive-exploiter, patient-technician,
  reading-pressure-specialist, old-school-pressure, mixed-game-generalist, volume-grinder,
  disciplined-specialist, foundational-reader, range-narrator, fundamentals-coach
✗ bot_profile constraint: permits nit, tight-aggressive, loose-aggressive, maniac, which
  @prl/poker-ai does not carry
```

### Root cause

Two independent faults that only became visible together.

**The column held the wrong vocabulary.** `room_members.bot_profile` was CHECK-constrained to the
five values of `OPPONENT_PROFILES` — the Scenario Lab's *range* labels — and the write path
squeezed a strategy profile through them with `persistableProfile`, which answered the literal
string `unknown` for anything those five could not express. The live registry held the real id, so
the mismatch was invisible for exactly as long as the process lived. Two further facts that decide
how a seat plays, `difficulty` and the decision `seed`, were request fields that nothing persisted
at all — so even the five profiles that *could* be named could not be put back as the same player.

**`ensureOpen` deliberately restored no bots.** Its comment reasoned that "a seat that cannot act is
more honest than one that silently plays a different style with a fresh model". The premise was
true and forced by the first fault. The conclusion did not follow: the fix for a column that cannot
name the opponent is to make it name the opponent, not to stop restoring opponents.

### Files changed

| File | What |
|---|---|
| `db/migrations/0003_bot_seat_recovery.sql` | **new.** Widens the CHECK to the twelve profile ids, converts the five legacy names in place, adds `bot_difficulty` and `bot_seed`. Declares itself irreversible with a reason |
| `apps/api/src/rooms/bot-profile.ts` | **new.** The durable vocabulary, derived from `PROFILES`; `durableProfile`, `durableSeed`, `rehydrateBotSeat`, `describeRefusal` |
| `apps/api/src/rooms/bots.ts` | `persistableProfile` and `PersistableBotProfile` deleted; `LEGACY_PROFILE_IDS` is now one-way. `BotRunner.specOf` added |
| `apps/api/src/rooms/registry.ts` | `ensureOpen` re-registers each bot seat via the new `rehydrateBot`; `RoomStore.addMember` takes a whole `DurableBotSeat` |
| `apps/api/src/repositories/rooms.ts` | Selects and maps the two new columns (`bigint` → number); `normaliseBotSeat` refuses a partial bot row at write time |
| `apps/api/src/routes/rooms.ts` | Both bot-seating paths persist profile, difficulty and the resolved seed |
| `apps/api/scripts/verify-schema.mjs` | Check 8: the CHECK's value set must equal the runtime profile list |
| `db/seeds/0001_dev_seed.sql` | The two seeded bot rows carry all three facts |

### Behaviour now

- All twelve profiles persist under their own id. Nothing writes `unknown`.
- A restarted process re-registers every bot seat with its exact profile, difficulty and seed.
- A row the build cannot reproduce — a pre-0003 `unknown`, a retired id, a missing difficulty or
  seed — leaves an **inert seat and a logged reason**. No strategy is ever substituted.
- `OpponentModel` is not restored, and that is stated rather than hidden: it is built from observed
  actions, and those observations died with the process.

### Tests added

`apps/api/test/z3-bot-restart-recovery.test.ts` — 6 tests against a real database:

- all twelve written and read back, with difficulty and the full uint32 seed range intact;
- the database itself rejects a profile id the runtime does not carry;
- `PERSISTABLE_BOT_PROFILES` is derived from `PROFILES`, not hand-written;
- **the restart**: a room built in one `RoomRegistry`, that registry closed, the same rows opened in
  a second one — `specOf` asserted field by field, for each of the twelve;
- two negative cases: a pre-0003 row and a row with no difficulty/seed each leave `seatCount === 0`,
  log exactly one problem, and keep the seat on the roster.

Two existing tests asserted the defect and were rewritten, not adjusted — see §7.

### Result

```
$ node --test apps/api/test/z3-bot-restart-recovery.test.ts
  ✔ writes and reads back all twelve, with difficulty and seed intact
  ✔ refuses a profile the runtime does not carry, at the column
  ✔ keeps the persisted vocabulary and the runtime one in step
  ✔ rehydrates profile, difficulty and seed for all twelve
  ✔ refuses a pre-0003 row whose profile was destroyed at write time without substituting a strategy
  ✔ refuses a row with a profile but no difficulty or seed without substituting a strategy
  tests 6 · pass 6 · fail 0

$ pnpm run db:reset && pnpm run db:migrate && pnpm run db:seed && pnpm run db:verify
  ✓ 0003_bot_seat_recovery.sql
  · bot_profile permits exactly the 13 runtime values
  ✓ every documented schema security property holds
```

### Residual risk

- Rows written before this migration stay unrecoverable. That is stated in the migration, in the
  column comment and in the refusal path; there is no data from which to recover them.
- A rehydrated bot starts with no opponent model. Real, unavoidable, and equivalent to a genuinely
  new opponent joining — it cannot mislead a learner about who they are playing.
- The one-process-per-room assumption in `registry.ts` is unchanged and still applies.

---

## 2. CHAL-P1-4 — no Content-Security-Policy on the HTML origin

### Reproduction

```
$ curl -sSI http://localhost:3000/ | head
HTTP/1.1 200 OK
Vary: rsc, next-router-state-tree, …
Cache-Control: no-cache, must-revalidate
X-Powered-By: Next.js
Content-Type: text/html; charset=utf-8
$ curl -sSI http://localhost:3000/learn | grep -i "content-security\|x-frame\|x-content"
  (no CSP / no security headers)
```

`THEME_BOOT_SCRIPT_CSP_HASH` existed, `test/theme-csp-hash.test.ts` kept it accurate, and nothing
placed it on a response. `next.config.ts` declared no `headers()`, there was no proxy file, and the
reverse proxy in `docker-compose.yml` sets none either.

### Root cause

The hash was treated as the deliverable. It is an input to a policy that was never written. A
carefully maintained constant that reaches no response is worse than nothing, because it makes the
gap invisible to anyone skimming the source for a CSP.

A hash-only policy is also not the fix, and the reason is worth recording: React Server Components
stream their payload through inline `<script>self.__next_f.push(…)</script>` tags whose contents
differ per render. A hash-only `script-src` blocks them, and a Next app whose flight payload is
blocked renders its server HTML and then never hydrates — every control on the page dead, with
nothing on screen to say why.

### Files changed

| File | What |
|---|---|
| `apps/web/src/lib/csp.ts` | **new.** The policy as a pure function, plus the four headers that sit beside it |
| `apps/web/src/proxy.ts` | **new.** Next 16's proxy convention: mints a per-response nonce, sets the policy on the forwarded request (so Next stamps its own scripts) and on the response |
| `apps/web/src/app/layout.tsx` | Reads `x-nonce` and puts it on the theme boot script; `<main>` gains `tabIndex={-1}` (see §5) |
| `scripts/smoke-test.mjs` | §10: asserts the header on a real rendered response |

The policy:

```
default-src 'self'; frame-ancestors 'none'; frame-src 'none'; object-src 'none';
base-uri 'none'; form-action 'self'; img-src 'self'; font-src 'self'; manifest-src 'self';
media-src 'none'; worker-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline';
script-src 'self' 'nonce-…' 'sha256-pFr/J6mAOwOBw+OUbWRw3SFuJuxHv7yTRXbAhz9wOxo=' 'strict-dynamic';
connect-src 'self'; upgrade-insecure-requests
```

- The theme script is allowed **twice**: by the nonce and by its exact bytes. Belt and braces, not
  redundancy — if the nonce plumbing breaks the page still resolves its theme before paint.
- No `unsafe-inline` and no `unsafe-eval` anywhere in `script-src`.
- `style-src-attr 'unsafe-inline'` is the one widening, confined to one directive, because the
  design system passes CSS custom properties through the `style` attribute and an attribute cannot
  carry a nonce. `style-src` itself stays `'self'`, so an injected `<style>` element does not run.
- Development adds exactly `'unsafe-eval'` (React Refresh) and the HMR websocket, and drops
  `upgrade-insecure-requests`. `test/csp-policy.test.ts` asserts production carries none of them.

### Tests added

- `apps/web/test/csp-policy.test.ts` — 10 tests on the value: the hash and nonce are present, no
  unsafe source of any kind, every closed directive is closed, the inline-style allowance is
  confined to `style-src-attr`, development and production differ only where intended.
- `scripts/smoke-test.mjs` §10 — against a running production server: the header arrives, it
  carries a nonce, `script-src` has no unsafe source, the theme hash is served, **every rendered
  `<script>` tag carries the nonce** (15/15), and the three companion headers are correct.

### Browser verification, including the negative control

Real Chrome, production build, `/learn`:

| Check | Result |
|---|---|
| Console errors / CSP violations on load | none |
| Hydration | works — page fully interactive, stylesheets applied |
| Policy enforced? | yes — `new Image().src = 'https://example.com/x.png'` → `img-src` violation |
| **Unapproved inline script** | **refused** — `button.setAttribute('onclick', "window.__x='EXECUTED'")` then a real click: handler did **not** run, `securitypolicyviolation` fired with `violatedDirective: 'script-src-attr'` |

The inline-handler form is the negative control that works: a `<script>` element injected from an
extension's isolated world is exempt from the page's policy and would have produced a false pass,
whereas an event-handler attribute is compiled by the page and is governed by the page's policy.

**This manual check is no longer the evidence.** `pnpm run test:csp`
(`scripts/csp-negative-control.mjs`) automates it and goes further, and it is in the `verify` gate
list. It intercepts the top-level document response over CDP and splices attack markup in before
`</body>`, so the browser parses and enforces the deployment's OWN policy and OWN per-response
nonce against markup the application never served — which is the only way to reach the
parser-inserted cases at all.

That distinction turned out to matter more than this section knew. Under `'strict-dynamic'`, a
`<script>` created with `document.createElement` and appended is exempt **even from page context**,
because that is precisely what `strict-dynamic` means: a trusted script may create further scripts.
So the DOM-insertion form produces a false pass for a second reason beyond the isolated world, and
`innerHTML` produces one for a third (HTML says such scripts never run, whatever the policy). The
event-handler form recorded above is genuinely governed, and remains one of the seven cases.

The automated control asserts five refusals with their violated directive, that the disallowed
origin was never contacted at all, and four positive controls — including that the page's own
nonce'd bundles hydrated, which under `'strict-dynamic'` is end-to-end proof of the nonce
mechanism. It was itself falsified: putting a proxy in front that added `'unsafe-eval'` and
`script-src-attr 'unsafe-inline'` flipped exactly those two cases and exited 1.

Also confirmed from the **production container image**:

```
$ docker run -d -p 3100:3000 -e NODE_ENV=production <web image>
$ curl -sSI http://127.0.0.1:3100/learn | grep -i content-security-policy
content-security-policy: default-src 'self'; … 'strict-dynamic'; connect-src 'self'; upgrade-insecure-requests
```

### Residual risk

- `style-src-attr 'unsafe-inline'` is a genuine widening. Bounded by there being no remote origin
  anywhere in the policy, which is what a CSS exfiltration would need.
- The proxy runs on every non-asset request; a Next release that changes the nonce contract would
  break hydration. The smoke test's "every script tag carries the nonce" assertion is what catches
  that, and it is why that assertion exists rather than only a header check.

---

## 3. CHAL-P1-6 — Legends hand review always rendered a bundled sample

### Reproduction

```
$ curl -s 'localhost:3000/legends/hand-review?hand=hand_aaaaaaaaaaaa' > a.html
$ curl -s 'localhost:3000/legends/hand-review?hand=hand_zzzzzzzzzzzz' > b.html
$ diff <(grep -o 'hand_[a-zA-Z0-9]*' a.html | sort -u) <(grep -o 'hand_[a-zA-Z0-9]*' b.html | sort -u)
< hand_aaaaaaaaaaaa
> hand_zzzzzzzzzzzz
```

The two pages differed only in the id echoed into a link. Same board, same decisions, same result —
because `loadHandComparison(_handId)` ignored its argument and returned `HAND_COMPARISON_FIXTURE`.

### Root cause

`buildHandComparison` existed in `@prl/poker-ai`, complete and tested, with **no route in front of
it**. The client had been written against `GET /api/legends/hands/:id/comparison`, which was never
registered, so the loader was changed to stop asking and render the sample with a banner. The banner
made it honest. It did not make it the feature.

### Files changed

| File | What |
|---|---|
| `apps/api/src/review/build-comparison.ts` | **new.** Assembles a `HandComparison` from stored rows, or refuses with a typed reason |
| `apps/api/src/review/build-review.ts` | `buildComparisonDecisions` — replays a stored hand into the `PlayerView` each seat acted on. Reuses the existing replay rather than a second one. `HandRow` now carries `random_source_kind` |
| `apps/api/src/routes/hands.ts` | `GET /legends/hands/:handId/comparison`, scoped by `findOwnHand`; `botProfilesOfRoom` joins the roster for the opponent's identity |
| `packages/contracts/src/api-paths.ts` | `legendHandComparison`, and its probe entry |
| `packages/contracts/src/errors.ts` | `hand_not_comparable` (409), distinct from `hand_not_found` (404) |
| `apps/web/src/lib/legends-data.ts` | `loadHandComparison` makes the request and returns a typed problem; `demoHandComparison` replaces the silent fallback |
| `apps/web/src/app/legends/hand-review/page.tsx` | Loads the reader's own hand, forwarding the session; four distinct failure screens, none of them the sample |
| `apps/web/src/app/legends/hand-review/demo/page.tsx` | **new.** The worked example, at a URL that says demo |

### Behaviour now

- The page loads the hand the URL names, scoped to a seat the caller actually held.
- No `?hand=` → an empty state that explains what the page needs and links to the hand history.
- Not found or not theirs → the app's 404 body, the same answer for both, so a hand id cannot be
  confirmed by probing.
- Still in progress / no modelled seat / rows that cannot be replayed → that specific reason.
- The sample is reachable only at `/legends/hand-review/demo`.
- Model decisions carry no reasoning, permanently: `prl.hand_actions` records what was done, never
  the distribution a policy sampled from.

### Tests added

`apps/api/test/z4-legend-hand-comparison.test.ts` — 11 tests, two **real** hands dealt through the
engine and written to a real database:

- the comparison names the hand asked for, and its board is that hand's board (`[]` for the
  preflop hand, `Qh 7h 2c 4d 9s` for the other);
- its decisions are the actions actually taken, by the seats that took them, in order;
- hand B's streets are `preflop → flop → turn → river`, which hand A never reached, and its pot grows;
- the two hands disagree on board, chip result and decision count — *the assertion the old page
  could not have passed*;
- the opponent is named `adaptive-exploiter`, one of the seven ids the old schema could not store;
- a stranger and a nonexistent id get the same `hand_not_found`;
- a live hand and a hand with no modelled seat get their own `hand_not_comparable` reason;
- **no refusal ever answers with a body containing `decisions` or `board`**.

```
$ node --test apps/api/test/z4-legend-hand-comparison.test.ts
  tests 11 · pass 11 · fail 0
```

### Residual risk

- A hand whose stored rows cannot be replayed shows a refusal rather than an approximate report.
  Deliberate: the guard in `buildHandComparison` is the reason the feature is worth having.
- Multi-seat tables report the first nameable profile as the headline `profileId`; per-seat
  profiles are still attached per decision. Fine for the heads-up Legends match, and the shape to
  revisit if a Legends table ever seats several different models.

---

## 4. PROD-048 — Learn and the Scenario Lab minted no guest session

### Reproduction

```
$ curl -c jar -b jar localhost:3000/learn        # no Set-Cookie
$ curl -c jar -b jar localhost:3000/learn/pot-odds # no Set-Cookie
$ curl -c jar -b jar localhost:3000/lab          # no Set-Cookie
$ curl -b jar :3001/api/v1/auth/session -H 'Origin: http://localhost:3000'
{"user":null,…}
$ curl -b jar -X POST :3001/api/v1/content/lessons/pot-odds/read …
{"lessonId":"pot-odds","completedAt":null,…}
```

Nothing recorded, for a reader who had worked through a lesson.

### Root cause

`POST /auth/guest` had exactly one caller in the whole client — `ensureSession` in
`table-rooms.ts`, reached only by opening a table. A reader who came to learn instead of to play
stayed anonymous forever. Every endpoint answered honestly (`completedAt: null`,
`recorded: false`, `401` on progress) and the combined effect was a product whose copy promises a
record and whose default path keeps none.

### Files changed

| File | What |
|---|---|
| `apps/web/src/lib/guest-bootstrap.ts` | **new.** Which paths bootstrap, whether a session cookie is already present, whether this is a document navigation, and the two-call CSRF exchange |
| `apps/web/src/lib/session-cookie-names.ts` | **new.** The cookie-name list, extracted from `server-session.ts` so the proxy can use it without dragging in `next/headers` |
| `apps/web/src/lib/server-session.ts` | Re-exports it; forwarding logic unchanged |
| `apps/web/src/proxy.ts` | Mints on a cookie-less document navigation to `/learn`, `/lab`, `/record`; adds the cookies to the forwarded request AND the response |
| `apps/api/test/session-cookie-names.test.ts` | Points at the extracted module |
| `scripts/smoke-test.mjs` | §11: the whole journey against a running stack |

Done in the proxy because a **server component cannot set a cookie**, and because a client effect
would leave the *server* render of `/learn` anonymous — so the reader's own "read" chips would only
appear on the second page view.

### Idempotence, precisely

- A request carrying a session cookie mints nothing. First check, pure string test. An
  authenticated reader is never replaced, and neither is an existing guest.
- Only a top-level document navigation mints: prefetches, RSC fetches and asset requests are
  skipped, so one page view cannot create several accounts.
- **Two simultaneous first navigations in two tabs from a browser that has never had a cookie will
  mint two guests.** Not fixable at this layer and stated rather than glossed: before a cookie
  exists nothing on the wire distinguishes one visitor from two, and inventing a fingerprint would
  be unreliable and a privacy regression. Cost: one unreferenced guest row with no progress on it.
- Every failure is swallowed — API down means the page is served anonymous, exactly as before.

### Tests added

- `apps/web/test/guest-bootstrap.test.ts` — 11 tests: which paths bootstrap and which do not, both
  cookie names recognised and no substring false positive (this is the check that stops an
  authenticated reader being replaced), every non-document request refused, the CSRF pair sent
  correctly, the page's own origin forwarded, cookies replayed verbatim, and five ways of
  half-succeeding all returning `null`.
- `scripts/smoke-test.mjs` §11, against a running production stack:

```
✓ a fresh visitor to /learn is issued a session          prl_session
✓ the session is a real guest account                    usr_jhn7pb7nlg6tacbcgjh7h4byxv
✓ navigation, refresh and concurrent requests mint nothing further
✓ the visitor keeps one identity across navigation
✓ /legends mints nothing for an anonymous visitor
✓ a prefetch of /learn mints nothing
✓ a lesson read by the bootstrapped guest is actually recorded   2026-08-19T10:55:00.117Z
```

The server render also picks it up: after one recorded read, `/learn` renders a `✓ read` chip and
its prose changes from "2 of those are not marked read" to "one of those is not marked read".

### Residual risk

- The concurrent-first-navigation case above.
- `/play` still mints through `ensureSession`, deliberately: it needs a session *before* it opens a
  socket, and folding it into the proxy would be a second mechanism to keep in step.

---

## 5. A11Y-001 — real keyboard verification

### What was missing

`scripts/a11y-audit.mjs` is a static audit and says so: it parses server-rendered HTML. Tab order
is decided by layout, a focus ring is a computed style under `:focus-visible`, a keyboard trap only
exists once something has stolen focus at runtime, and a control that hydrates into a handler is
inert in static HTML. None of that is decidable from markup.

### What was built

`scripts/keyboard-audit.mjs` (`pnpm run test:keyboard`) drives **real Chrome over the DevTools
Protocol** — `child_process` to start it, `fetch` for `/json`, and Node's built-in `WebSocket` for
the protocol. **No new dependency**, which matters here: this repository disables lifecycle scripts
and enforces a 7-day registry cooldown, so adding a browser driver is release-blocking.

Keys go through `Input.dispatchKeyEvent`. That is the same path a physical keypress takes; a
`KeyboardEvent` constructed in page script is `isTrusted: false` and moves no focus, which is
exactly why a DOM-level test cannot answer this question.

Per route: every focusable control reached by Tab, focus order follows the document, every stop
shows a focus indicator (measured by comparing the element **and its ancestors** focused against
blurred), the order cycles (no trap), Shift+Tab walks back, and Enter on the skip link moves focus
into `<main>`. Then the journeys: `<details>` on Enter, focus surviving an update, card text.

Two dedicated journeys:

- **Narrow viewport (390×844)** — the menu sheet, which only exists below 860px: opens on Enter,
  is `aria-modal`, moves focus inside, holds Tab *and* Shift+Tab, closes on Escape, and returns
  focus to the trigger.
- **A private table, keyboard only** — open the table, take the seat, deal, size the bet, fold.
  Every step reached by Tab and pressed with Enter, against a real socket and a real server.

### Defects found, and fixed

**A11Y-R1 — the skip link did not move focus.** `<main id="prl-main">` had no `tabindex`, so
activating the skip link set `location.hash` and moved the *sequential focus navigation starting
point*, but left `document.activeElement` on the link. Chrome and Firefox honour the starting point
so the next Tab does continue correctly — which is why it looked fine — but the focus ring stays at
the top of the page, a screen reader is not moved, and browsers that do not implement the starting
point get nothing. Fixed with `tabIndex={-1}` on `<main>`, plus an outline suppression for it
(`globals.css`) so the first use does not draw a viewport-sized ring. Verified: focus now lands on
`MAIN.prl-app__main` on every one of the 13 routes.

**A11Y-R2 — the Play CTA showed no focus indicator on `/play`.** Not a low-contrast ring: **no
change at all** between focused and unfocused. `.prl-pillbar__cta[aria-current="page"]` sets a
decorative `outline: 1px solid var(--prl-accent-fill)` — the same colour as its own fill — at
specificity (0,2,0), and the focus ring in `base.css` is written as
`:where(a, button, …):focus-visible`, which is (0,1,0) and loses. The same specificity trap this
stylesheet was caught by once before (see `.prl-stage__reveal` in `lab.css`). Fixed by restating
the rule at (0,2,0) with `--prl-text-on-accent`, the token whose contrast against that fill is
measured and enforced. Verified with real Tab presses: `outline: rgb(255,255,255) solid 2px`,
`matches(':focus-visible') === true`, and a screenshot showing the ring.

**A11Y-R3 — folding dropped focus to `<body>`.** Pressing Enter on Fold unmounts every button in
the action bar — correctly, it is no longer that seat's turn — and the browser's only option was to
drop focus to `<body>`. A keyboard user who had just acted was returned to the top of the document
with no announcement. Fixed in `packages/ui/src/components/ActionBar.tsx`: the idle line takes
`tabIndex={-1}` and `role="status"`, and focus moves to it **only when focus was inside the bar**
when the controls went away — so a table where the opponent acts while the reader is in the Coach
panel does not yank focus back.

### Three corrections to the instrument itself

Recorded because an audit that reports a defect it invented is worse than no audit, and each of
these produced a convincing false failure before it was fixed:

1. **Radio groups.** The first version counted every `<input type=radio>` as a required tab stop and
   reported every theme switcher and quiz answer set as "unreachable". A radio group is one tab stop
   by specification; putting them all in the tab order is the accessibility defect, not the fix.
2. **Focus visibility read only the focused element.** That produced 36 false failures on the
   Scenario Lab, where `lab.css` deliberately draws the ring on the *card* and sets
   `outline: none` on the link inside it — a good design the check called a WCAG failure. Now it
   compares the element **and its ancestors**, focused against blurred.
3. **Element identity was a DOM path, and the skip-link check ran on a dirty URL.** `BootSequence`
   unmounts shortly after first paint and renumbers siblings, so a path captured before the walk
   could name a different element after it — an intermittent "1 control unreachable" on the home
   page. Elements are now stamped with a stable attribute. Separately, a fragment link to the
   fragment the URL already carries is a no-op in Chrome, so the skip-link check now loads the route
   cleanly first, which is the state a reader arrives in.

A fourth, on the app side rather than the instrument: the post-action focus check waited for "no
enabled action" rather than for the bar's idle state, and caught the moment when the buttons are
merely `disabled` (which the browser blurs at once) before the component moves focus a frame later.

After all four, three consecutive runs: **137 passed, 0 failures**, identical each time.

### Result

```
$ pnpm run test:keyboard          # production build on :3000, API on :3001
  Chrome/151.0.7922.138 — headless

  13 routes + narrow viewport + a live table
  137 check(s) passed
  2 warning(s)
    - Poker table + Coach (decision): every action control is disabled in this state
    - Poker table (live): no action controls are on screen in this state
  Keyboard audit passed.
```

The two warnings are statements about fixture/idle states, not defects: `/play?state=decision`
renders the action row with every control disabled (that page says in its own copy that no link on
it opens a socket), and `/play` with no table open has no action row at all. Both are covered by the
live-table journey instead, which is the point of having one.

The live journey, in full:

```
✓ "Open the table" reached and activated by keyboard
✓ the socket went live
✓ "Take seat 1" reached and activated by keyboard
✓ "Deal the next hand" reached and activated by keyboard
✓ the hand reached this seat
✓ every offered action is enabled and tabbable          Raise to 20 / 15 units
✓ the size slider is named                              "Raise size slider"
✓ the slider declares its range                         20..1000
✓ the slider has non-slider alternatives                1 number input(s), 5 preset(s)
✓ the slider moves with the arrow keys                  20 → 23
✓ End reaches the maximum size
✓ Fold, pressed with Enter, was accepted by the server
✓ focus survived the table update the action caused
```

Machine-readable record: `docs/audit/keyboard-audit.json`.

### Coverage against the brief

| Asked for | Covered by |
|---|---|
| onboarding | `/` route walk |
| Learn | `/learn`, `/learn/pot-odds` |
| Guided Practice | `/learn/pot-odds` + focus-survives-update |
| Poker Table + Coach | `/play?state=decision`, `/play?state=complete`, and the live journey |
| Scenario Lab | `/lab`, `/lab/preflop-open-cutoff` + slider check |
| AI Legends | `/legends`, `/legends/adaptive-exploiter` |
| Hand Review | `/legends/hand-review`, `/legends/hand-review/demo`, `/review` |
| private multiplayer flow | the live private table journey (invite-code entry is a text field in the same walk) |
| every control reachable / order / visible focus / no traps | per-route checks 1–4 |
| modal focus management | narrow-viewport sheet journey |
| poker actions operable | live journey: Enter on Fold accepted by the server |
| sliders have keyboard alternatives | live journey: arrows, End, number input, 5 presets |
| card/table information understandable | `checkCardText` — 166 card elements on the complete-hand state, all carrying text |
| focus survives dynamic updates | per-route check + the post-action check on the live table |

### Residual risk

- **No screen-reader pass.** Not automated anywhere, and not claimed. This audit proves keyboard
  operability, not what a screen reader announces.
- Colour-contrast of focus indicators is checked by `design:contrast` for tokens, not per composite
  rendering.
- The audit needs a production build and a running API; against a dev build it would measure
  overlays that do not ship. The script says so and the runbook repeats it.

---

## 6. P2 — impossible probabilities at the render boundary

### Reproduction

```js
formatPercent(-0.5)  → '-50.0%'
formatPercent(1.6)   → '160.0%'
formatPercent(36)    → '3,600.0%'
```

Five call sites handed a probability-typed value straight to `formatPercent`:
`ActionDistribution` (a sampled weight), `LiveCalculation` (an EV term's "how often"),
`legends/[profileId]` (a measured frequency), `PostHandComparison` (break-even equity), and
`learn-calculations` (`percentInput`, fed equity / fold chance / equity-when-called).

### Root cause and the fix

The domain existed (`isProbabilityFraction`) and was applied only in `CoachPanel` and `EquityBar`.
It was also **exact**, which is the wrong domain for a computed number: a Monte Carlo division or a
normalisation over a set of weights lands on `1.0000000000000002` routinely, and a guard that
refuses correct figures is a guard somebody deletes.

`packages/ui/src/probability.ts` now defines the domain once, with a stated tolerance:

- `PROBABILITY_TOLERANCE = 1e-9` — enormous next to accumulated floating-point error (a few ULPs is
  ~`1e-16`) and minute next to every defect it exists to catch (a unit mix-up is off by 100×, the
  stale fixture value by 0.6).
- `normaliseProbability` **snaps** a value within tolerance onto the bound and returns `null`
  otherwise; the two sibling ranges (`-1..1` differences, `-100..100` points) get the same treatment.
- `formatProbability` formats the **snapped** value, so a rendering does not change meaning with the
  decimal count asked for.
- Every predicate delegates, so a second bound cannot be reintroduced in one of them.

`formatPercent` is deliberately **unchanged**: a formatter cannot know whether it was handed a
probability or a growth rate, and quietly rescuing `36` would hide the unit mismatch that once put
"3,600.0%" on a shipped page. What changed is that no probability-typed value is handed to it. The
distinction is preserved in both directions — `medianSizeToPotFraction` (a bet as a share of the
pot, legitimately > 1) and the decorative bar widths stay on `formatPercent`, with a comment at each
saying why.

### Tests added

`packages/ui/test/probability.test.ts`, 8 new tests covering exactly the cases named in the brief:

| Case | Result |
|---|---|
| `< 0` (`-0.5`, `-1e-8`) | refused |
| `0`, `-0` | accepted, normalised to `+0` |
| near 0 (`1e-300`, `1e-12`, `1e-9`) | accepted, formatted (`0.00000010%` at 8 dp) |
| `1` | accepted |
| slight `> 1` (`1 + EPSILON`, `1.0000000000000002`, `1 + TOLERANCE`) | snapped to 1 |
| just past tolerance (`1 + 10·TOLERANCE`, `1.0000001`) | refused |
| materially `> 1` (`1.6`, `36`) | refused |
| `NaN`, `±Infinity` | refused |
| the three ranges stay apart under tolerance | asserted |
| predicates agree with the normalisers at every boundary | asserted |

```
$ node --test packages/ui/test/probability.test.ts
  tests 20 · pass 20 · fail 0
```

### Residual risk

Enforcement is at the render boundary, not in a schema. A wrong probability still reaches the page
and is *named* (`not a probability`) rather than being caught upstream. That is defence in depth by
design — `@prl/poker-math` refuses at source, this refuses at display — and it is why the refusal
prints a phrase that reads as a rejection rather than as missing data.

---

## 7. Two defects found while remediating

### 7a. `apps/web` did not typecheck

`pnpm --filter @prl/web typecheck` failed on the working tree before any change here:

```
src/app/play/page.tsx(233,8): error TS2375: Type '{ legendMatch?: { profileId: string; difficulty: string } }'
  is not assignable to … difficulty: "educational" | "expert" | "realistic"
```

TypeScript narrows the *reference* inside the conditional but a fresh object literal built from it
widens the property back to `string`. Fixed with a type predicate (`isMatchDifficulty`), which
carries the narrowing across the literal. **This means the pre-existing tree would have failed the
`typecheck` gate**, so no `verify` run before this session could have been green on it.

### 7b. The migration gate test asserted a narrower rule than the gate

`apps/api/scripts/migrate.test.mjs` had a test named *"every migration already in db/migrations
passes the destructive-statement gate"* whose body called `findIrreversibleStatements` alone and
required an empty result — i.e. that no migration is destructive **at all**. That is not the gate:
`refuseUndeclaredIrreversible` in `migrate.mjs` refuses a destructive migration *that does not say
so*, and applies one carrying `-- prl:irreversible: <reason>`.

The old body tested half the gate under the full gate's name, and passed only for as long as every
migration happened to be additive. `0003` is the first that cannot be — changing a CHECK predicate
requires dropping it, and there is no `ALTER CONSTRAINT` for that.

Rewritten to the runner's real rule, **plus** a new test that a bare marker with no reason is not a
declaration — so the marker cannot become a rubber stamp. Documented under §7 rather than quietly,
per the remediation rules.

### Tests changed because they asserted the defect

Two, both rewritten with the reason recorded in the test file itself:

- `apps/api/test/rooms.test.ts` — `assert.equal(persistableProfile('adaptive-exploiter'), 'unknown')`
  asserted that a Legend's identity is destroyed at write time. Replaced by a round-trip over all
  twelve plus an explicit-refusal case, and a new test for `rehydrateBotSeat`'s four refusals.
- `apps/api/test/coverage-room-store.test.ts` — a block whose comment called the `unknown` fallback
  "the fallback working". Replaced by the real id going in verbatim, plus the two refusals.

Everything else that changed in a test file was a fixture shape (two new columns,
`random_source_kind`, `actionTimeoutSeconds`), not an assertion.

---

## 8. Full release suite, run from the final patched state

Every command below was run after the last source change, in this order.

### `pnpm run verify` — 11/11

```
=== PASS security:audit ===        (policy, denylist, shapes, osv, provenance, ioc, pinning, sbom)
=== PASS security:hygiene ===
=== PASS lint ===                  biome, 417 files
=== PASS build ===
=== PASS typecheck ===             8 projects
=== PASS design:contrast ===
=== PASS test ===                  see below
=== PASS test:a11y ===             7 routes, 0 violations
=== PASS test:exhaustive ===       133,784,560 seven-card hands, 6.6 s
=== PASS test:simulation ===       12 profiles × 8,000 hands, 260,426 actions
=== PASS db:verify ===             bot_profile permits exactly the 13 runtime values
=== verify: every gate passed ===
```

### Test counts

| Suite | Tests | Fail |
|---|---:|---:|
| `packages/poker-engine` | 133 | 0 |
| `packages/contracts` | 21 | 0 |
| `packages/poker-math` | 247 | 0 |
| `packages/ui` | 250 | 0 |
| `packages/content` | 29 | 0 |
| `packages/poker-ai` | 148 | 0 |
| `apps/web` | 178 | 0 |
| `apps/api` (integration, real Postgres) | 699 | 0 |
| `test:scripts` | 103 | 0 |
| **Total** | **1,808** | **0** |

### Security and supply chain, each gate run on its own

```
security:policy PASS   security:denylist PASS   security:shapes PASS   security:osv PASS
security:provenance PASS   security:ioc PASS   security:sbom PASS   security:pinning PASS
security:audit PASS   security:hygiene PASS
```

SBOM: 170 components, 171 dependency records, graph fingerprint `9e1ff9caf04966d2…` →
`docs/sbom/poker-risk-lab.cdx.json`.

### WebSocket, concurrency, reconnect, shutdown, restart

```
$ node --test test/ws-router test/ws-socket test/table-concurrency test/shutdown \
              test/y2-ws-room-reopen test/y3-turn-clock test/seat-reuse-identity \
              test/z3-bot-restart-recovery
  tests 66 · pass 66 · fail 0
```

### Production builds and containers

```
$ pnpm run build                                   PASS
$ docker build -f Dockerfile.api .                 sha256:304bc864b10e…
$ docker build -f Dockerfile.web .                 sha256:21506cd69164…
  both:  user=node (non-root), healthcheck present
  web container serves the full CSP on /learn      confirmed by curl against the running image
```

### Production-style smoke test

```
$ PRL_WEB_ORIGIN=http://localhost:3000 node scripts/smoke-test.mjs --strict
  60 check(s) passed
  Smoke test passed.
```

Includes the hidden-information property (one player never receives another's cards), hand-history
isolation, CSRF enforcement, rate limiting, the new §10 CSP checks and the new §11 guest-bootstrap
journey.

### Real keyboard accessibility

```
$ pnpm run test:keyboard
  137 check(s) passed · 2 warnings (both fixture-state statements) · Keyboard audit passed.
```

---

## 9. Residual risk, collected

| # | Risk | Where |
|---|---|---|
| 1 | Pre-0003 bot rows are unrecoverable; those seats stay inert with a logged reason | §1 |
| 2 | A rehydrated bot has no opponent model | §1 |
| 3 | One API process per room, unchanged | §1 |
| 4 | `style-src-attr 'unsafe-inline'`, bounded by no remote origin anywhere in the policy | §2 |
| 5 | A hand whose rows cannot be replayed shows a refusal, not an approximation | §3 |
| 6 | Two simultaneous first navigations from one browser mint two guests | §4 |
| 7 | **No screen-reader pass.** Keyboard operability is proven; announcement is not | §5 |
| 8 | Probability enforcement is at the render boundary, not in a wire schema | §6 |

None of these is a P0 or P1 by the audit's own definitions, and each is stated in the source at the
place it applies rather than only here.

---

## 10. What this document does not claim

It does not declare a release candidate. The verdict belongs to an independent re-verification, and
the reason this project has a `RELEASE: FAIL` behind it is precisely that a green suite was once
treated as a substitute for a product hole. What is claimed is narrower and checkable: the six
blockers named in `final-release-report.md` have reproductions above, fixes at the root cause,
regression tests, and a full suite run from the patched state.

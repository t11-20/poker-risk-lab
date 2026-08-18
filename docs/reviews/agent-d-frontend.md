# Agent D — Frontend, UX & Accessibility review

**Reviewer:** Agent D (independent) · **Date:** 2026-08-18
**Audited against:** `docs/frontend-design-system.md` v2.0 (dark-primary)
**Verdict:** **FAIL** — 2 × P0, 2 × P1, 2 × P2, 4 × P3

---

## 0. How this review was conducted, and what that means

**The shared Chrome extension tools were not usable for this audit.** The browser window
belonged to a concurrently-running session which held the foreground tab. My tab reported
`visibility: hidden`, `outerWidth/Height` of `0,0`, and a viewport frozen at **606×617**
regardless of `resize_window` calls to 1440×900 / 1500×950 / 400×800:

```
[resize_window] Successfully resized ... to 1500x950 pixels
{"inner":[606,617],"client":[606,617],"vis":"hidden"}
[resize_window] Successfully resized ... to 400x800 pixels
{"inner":[606,617],"client":[606,617]}
```

In a hidden tab `requestAnimationFrame` and `IntersectionObserver` do not fire, so the boot
overlay never dismissed and every `[data-revealed]` section sat at `opacity: 0`. Screenshots
taken in that state are not evidence about the product.

**So I drove my own headless Chrome over the DevTools Protocol instead** (driver:
`/private/tmp/claude-501/-Users-terence-Projects-exploration-sites/0b0dd179-432f-4e29-aabb-dcafd08eb8c7/scratchpad/cdp.mjs`,
no dependencies, Node 24 global `WebSocket`). That gave deterministic control of viewport,
`prefers-color-scheme`, `prefers-reduced-motion` and key input. **Everything below is from a
real browser at a real viewport**, and every layout claim is backed by both computed geometry
and `document.elementFromPoint` hit-testing, not by a screenshot alone.

I also could not use the already-running web server on port 3000: my `pnpm run build` at the
start of the review replaced `.next`, so the running `next start` served a stale chunk manifest
(`ChunkLoadError: Failed to load chunk /_next/static/chunks/1_jjh3ca-qmgp.js`). I was denied
permission to stop that process, so I started a clean server on **port 3010** against the build
I had just made, and audited that. The API on 3001 was left untouched.

---

## 1. Does it build and run?

`pnpm run build` — **clean, zero warnings**. All 6 packages plus both apps compiled; 14 routes
emitted (1 static, 13 dynamic). `pnpm run typecheck` — **clean**, 8 projects.

`pnpm run lint` — exit 0, **2 warnings**, both cognitive complexity in one non-frontend file
(`packages/content/src/validate.ts:670`, `:865`). See P3-2.

`packages/ui` tests: **169 pass, 0 fail, 0 skipped, 0 todo**. I checked the assertions rather
than the names: `packages/ui/test/motion.test.ts:241-255` genuinely `readFileSync`s
`tokens.css` and asserts `Number(found[1]) === COUNT_DURATION_MS` and
`deepEqual(numbers, [...EASE_STANDARD_CONTROL_POINTS])`. The design system's §5.5 claim is
real, not a regression lock.

---

## 2. Design-system consistency — the central rule holds

I counted every category §11 rule 1 forbids:

| Check | Result |
| --- | --- |
| Raw hex outside `tokens.css` (CSS) | **0** |
| Raw hex in any `.ts`/`.tsx` | **0** |
| `cubic-bezier` outside `tokens.css` | **0** (2 hits, both prose comments) |
| `box-shadow` anywhere in `packages/ui/src` + `apps/web/src` | **0** declarations (6 hits, all prose asserting there are none) |
| Positive `tabindex` | **0** |
| `h1` emitted by a `@prl/ui` component | **0** |
| `h1` per page | exactly **1** on all 13 routes (verified in-browser) |
| Horizontal overflow | none, at 390 / 834 / 1440 |
| `filter: blur()` / `backdrop-filter` | **0** |
| Animation of `width`/`height`/`top`/`left` | **0** |
| `addEventListener('scroll')` | **0** |
| `Lorem` / `Coming soon` / `TODO` / `FIXME` / `HACK` | **0** in UI copy |

`node scripts/check-contrast.mjs` — **PASS** on both layers (token layer and
`tokens.css + base.css` rendered layer), in both themes, "gap between them is zero" as claimed.

The raw-`px` grep returns hits, but they are not violations: `1px` hairlines (the idiom
`--prl-hairline` itself encodes), `0px` inside `clamp()` (units are mandatory there), and
media-query breakpoints — **CSS media queries cannot take `var()`**, so 600/860/900/1280 must
be literals. I found no genuine one-off length. Likewise the only raw durations are
`0ms`/`1ms` in the reduced-motion collapse block, which is required for `transitionend` to
still fire.

This is the cleanest design-token discipline I have audited. The findings below are behavioural,
not stylistic.

---

## P0-1 · Every web→API path 404s: the entire app runs on bundled fixtures

**Severity: P0** · `apps/web/src/lib/api.ts:306`, `apps/web/src/lib/legends-data.ts:47-52`,
`apps/web/src/lib/learn-data.ts:41,43`, `apps/web/src/app/lab/page.tsx:100`

### Problem

The web client omits the `/v1` version segment (and uses different sub-paths) on **every**
call. The API mounts everything under `/api/v1`. Not one web→API request can succeed, in any
environment, including the one running right now.

This is the same *symptom* as already-fixed defect #4 ("the web client could not reach the API
at all when following the documented dev flow"). That fix corrected the **port**. The **path**
axis was never corrected, so the defect it was meant to close is still open.
**Fix #4 is incomplete.**

### Reproduction

```
$ O="Origin: http://localhost:3000"   # the allow-listed origin, so CORS is not a factor
WEB PATH                                    -> STATUS   | LIKELY API PATH                        -> STATUS
/api/session                               -> 404     | /api/v1/auth/session                   -> 200
/api/content/lessons                       -> 404     | /api/v1/content/lessons                -> 200
/api/content/lessons/pot-odds              -> 404     | /api/v1/content/lessons/pot-odds       -> 200
/api/content/glossary                      -> 404     | /api/v1/content/glossary               -> 200
/api/scenarios                             -> 404     | /api/v1/content/scenarios              -> 200
/api/legends/profiles                      -> 404     | /api/v1/legends/profiles               -> 200
/api/legends/adaptive-exploiter/learn      -> 404     | /api/v1/legends/profiles/adaptive-exploiter -> 200
/api/legends/hands/hand-0042/comparison    -> 404     | /api/v1/legends/hands/hand-0042/comparison -> 404
```

Seven of eight have a working counterpart one path segment away. The eighth — the hand
comparison that `/legends/hand-review` is built on — **has no server implementation at all**.

`grep -n "api/v1" apps/web/src/lib/api.ts` returns nothing. `apps/web/next.config.ts` has no
`rewrites` and states "Deliberately absent: any webpack or turbopack customisation, any
redirect", so the paths are used verbatim against `API_ORIGIN`.

### Evidence

`apps/web/src/lib/api.ts:306` — the call the shell makes on every page:

```ts
return safeFetch<SessionResponse>(() => apiGet<SessionResponse>('/api/session', options));
```

Its own doc comment calls it "the one call the app shell makes on every page: it carries the
reader's units for the header badge **and the CSRF token every later mutation needs**".

### Consequences (all observed)

* **No session, ever** → the header's `1,000 UNITS` is always the fixture, and the CSRF token
  is always the fixture's deliberately-fake string. Every mutation (unit reset, room join,
  progress) is therefore impossible from the UI.
* **Every content screen is fixture-backed.** `/learn`, `/learn/*`, `/learn/glossary`, `/lab`,
  `/lab/*`, `/legends*`, `/review*` all render the bundled copy.
* **4 of 12 AI profiles are unreachable.** The API serves 12; the fixture has 8. The four
  absent ones render the **404 page**:
  ```
  /legends/old-school-pressure    h1="Page not found"  len=448
  ```
  (`mixed-game-generalist`, `foundational-reader`, `range-narrator` likewise.)
* Live equity/coach data is never exercised, so no journey below could be walked against real
  server state.

To the credit of the design, this degradation is *disclosed* rather than faked — the legends
screens render "These profiles are bundled sample data / The profile service is not reachable"
and the fixture CSRF token is visibly fake. The product is honest; it is just not connected.

### Fix

Introduce one `API_PREFIX = '/api/v1'` constant in `apps/web/src/lib/api.ts` and build every
path from it, then correct the four sub-paths that also differ in shape:
`/api/session` → `/api/v1/auth/session`; `/api/scenarios` → `/api/v1/content/scenarios`;
`LEGEND_API_PATHS.learnFrom` → `/api/v1/legends/profiles/{id}`. Implement or delete the
hand-comparison endpoint — a client path with no server route should not ship as a silent
fixture. Un-truncate `apps/web/src/fixtures/legends.ts` to all 12 profiles so the fallback
matches the wire.

### Missing test

An integration test that asserts, for every path the web client can emit, that a route exists
on a booted Fastify instance — i.e. enumerate the client's path constants and assert
`app.hasRoute()` / a non-404 for each. `pnpm run test:smoke` currently exercises the API's own
paths, so it cannot catch a client that asks for different ones. A contract test driven from
the *client's* constants is the one that fails on this bug.

---

## P0-2 · The sticky decision panel hides the entire poker table at every common desktop size

**Severity: P0** · `apps/web/src/styles/play.css:474-478`

### Problem

At `≥900px` the action/decision block becomes `position: sticky; inset-block-end: 0` with
`z-index: var(--prl-z-sticky)` (100) and an **opaque** `--prl-surface-page` background. It is
**566px tall**. Pinned to the bottom of a normal laptop viewport it covers the table field
(520px tall) completely. On landing at `/play` — scroll position 0, the state every user
starts in — **the pot, the board, all six seats and the dealer button are all occluded.**

The design system makes simultaneous visibility a *functional* requirement, not an aesthetic
one (§10): "a player must be able to see the pot, their cards, the price and the Coach's equity
figure *at the same time*. Any layout that forces a scroll to compare the price with the equity
has broken the product."

`play.css` §9 asserts this is structurally guaranteed:

> "The section 10 requirement at this width — pot, cards, price and equity all visible without
> scrolling — is already met by the two sticky elements above … **there is no viewport size at
> which the four figures fall off the screen.**"

That claim is false, and the figure it loses is the pot.

### Reproduction

Computed geometry plus hit-testing, four viewports, dark theme, `/play`:

```
1440x900:  decision{pos:sticky, bottom:0px, z:100, bg:rgb(11,13,17), top:334, h:566}
           field{top:375,h:520}  seatCentre[206,728] -> FIELDSET.prl-sizer   seatCovered:TRUE
1440x1400: decision{top:834,h:566}  seatCentre[206,728] -> DD.prl-seat__stat-value  seatCovered:false
1920x1080: decision{top:514,h:566}  seatCentre[430,728] -> BUTTON.prl-preset  seatCovered:TRUE
1280x800:  decision{top:263,h:566}  seatCentre[179,726] -> SPAN.prl-action-btn__cost  seatCovered:TRUE
```

Occlusion vs scroll position at 1440×900 (`elementFromPoint` on each element's visible centre):

```
scrollY=0     pot occluded:true   board occluded:true   seatsUnoccluded 0/6
scrollY=150   pot occluded:true   board occluded:true   seatsUnoccluded 1/6
scrollY=300   pot occluded:false  board occluded:true   seatsUnoccluded 3/6
scrollY=450   pot occluded:false  board occluded:false  seatsUnoccluded 4/6
scrollY=600   pot occluded:true   board occluded:false  seatsUnoccluded 3/6
```

**At no scroll position are all six seats unoccluded**, and the default view shows none of the
table.

Screenshots (identical build, identical theme, only viewport height differs):
* `shots/play-1440x1400-TABLE-VISIBLE.png` — the full oval: six seats, dealer button on BTN,
  `POT 100 UNITS`, board `Q♥ 7♥ 2♣`, active seat marked three ways.
* `shots/play-1440x900-TABLE-HIDDEN.png` — no table, no pot, no board, no phase spine.

### Evidence

```css
/* Guarantee 1 and 2: the price and the pot cannot scroll away. */
.prl-play__decision {
  position: sticky;
  z-index: var(--prl-z-sticky);
  inset-block-end: 0;
}
```

The comment names the pot as a thing being protected; the rule is what hides it. The table is
correctly built and correctly laid out — this is purely a stacking/height failure of the
overlay above it. **Tablet (834×1112) and mobile (390×844) are unaffected** and both look
excellent, because the sticky rule starts at 900px.

### Severity note for the release owner

Scrolling does partially recover the table, so this is not "the table is absent". I still rate
it P0 because it affects the product's central screen at the three most common desktop sizes
(1280×800, 1440×900, 1920×1080), the default unscrolled state shows none of it, no user action
or setting avoids it, and it falsifies a documented functional guarantee. If you prefer to ship
with a known-degraded Play screen, downgrade to P1 — but it should be a deliberate decision,
not an unnoticed one.

### Fix

The decision block must not overlap the table. Options, cheapest first: (a) drop
`position: sticky` and let it sit in its grid row, relying on the existing sticky HUD for the
price; (b) keep it sticky but cap its height (`max-block-size`) and make the table field's
`min-height` account for it, so the grid reserves the space the pinned panel occupies;
(c) collapse the sizer into a compact bar when pinned, expanding on focus. Whichever is chosen,
the block's pinned height must be subtracted from the space the table is allowed to claim.

### Missing test

A layout regression test that, at 1280×800 / 1440×900 / 1920×1080, asserts
`document.elementFromPoint()` at the pot's centre and at each of the six seats' centres returns
that element (or a descendant). The §10 guarantee is stated in prose and enforced nowhere; a
three-viewport hit-test would have failed the moment the sticky rule landed.

---

## P1-1 · The mobile nav focus trap leaks through the theme radio group

**Severity: P1** · `apps/web/src/components/MobileNav.tsx:174-188`

### Problem

The sheet is `role="dialog"` `aria-modal="true"`, moves focus to its close button on open, and
its Tab handler wraps from `focusable[focusable.length - 1]`. But the last focusables are the
three theme radios, and **a radio group is a single tab stop at the *checked* radio**. With the
default theme ("Auto" = the *first* radio), Tab from that radio moves past the whole group,
`active` is neither `last` nor outside the sheet, the handler does nothing, and focus lands
**outside the open sheet** on the bet-sizing controls the sheet is covering.

`document.querySelector('main').hasAttribute('inert')` is `false`, so the background is not
inert either. A keyboard user can focus and activate **Fold / Call / Raise** while looking at
the navigation sheet. On a poker table an unseen "Raise" is a consequential action.

### Reproduction

390×844, `/play`, dark:

```
radios: [{i:0,value:"system",checked:true},{i:1,value:"light"},{i:2,value:"dark"}]
before Tab: {tag:"INPUT", value:"system", checked:true, inside:true}
after  Tab: {tag:"BUTTON", cls:"prl-preset", txt:"✓⅓ pot — 80 units total",
             inside:false, sheetDisplay:"flex"}
```

Tabbing 8× from the close button reaches `.prl-preset` at step 7 with `insideSheet:false`.

### What does work (I tested it, and my first read was wrong)

Escape closes the sheet and returns focus correctly, and the wrap works from the *true* last
element:

```
after Escape: {sheetDisplay:"none", trigger:"false", active:{cls:"prl-nav-trigger"}}
focus last radio -> Tab: {cls:"prl-sheet__close", inside:true}
```

So the bug is narrow and configuration-dependent: it bites for "Auto" (the default) and
"Light", and not for "Dark".

### Evidence

```ts
const focusable = Array.from(sheet.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
const last = focusable[focusable.length - 1];
...
if (!event.shiftKey && (active === last || !sheet.contains(active))) {
  event.preventDefault();
  first.focus();
}
```

`FOCUSABLE_SELECTOR` collects all three radios, so `last` is the `dark` radio — an element
that is only ever the tab stop if the user has selected Dark.

### Fix

Compute the *tabbable* set the way the browser does: group `input[type=radio]` by `name` and
keep only the checked one (or the first if none is checked). Alternatively add a
`focusin` guard on `document` that pulls focus back when the sheet is open, or mark the page
content `inert` while open — `inert` alone would fix this class of bug permanently and is the
smallest correct change.

### Missing test

A keyboard test that opens the sheet and Tabs `n+1` times for `n` tab stops, asserting
`sheet.contains(document.activeElement)` after every press — with the theme radio left at its
**default**. A test written after selecting "Dark" would pass while the default stays broken.

---

## P1-2 · AI Legends ships 8 of 12 profiles behind a permanent "sample data" notice

**Severity: P1** · `apps/web/src/fixtures/legends.ts`, consequence of P0-1

### Problem

The requirement is 11 opponent profiles. `packages/poker-ai/src/profiles.ts` defines 12
archetypes and the live API returns all 12. The web fixture contains **8**, and because of
P0-1 the fixture is always what renders. So the shipped Legends experience is 8 profiles plus
a standing "the profile service is not reachable" banner, in a deployment where the service is
running and healthy.

### Reproduction

```
$ for d in educational realistic expert; do ... done
difficulty=educational -> 8 profile cards
difficulty=realistic   -> 8 profile cards
difficulty=expert      -> 8 profile cards
   (same 8 ids every time: adaptive-exploiter calling-station disciplined-specialist
    fundamentals-coach patient-technician reading-pressure-specialist vocal-aggressor
    volume-grinder)

$ curl -s http://127.0.0.1:3001/api/v1/legends/profiles | grep -oE '"archetypeName":"[^"]*"' | sort -u | wc -l
12
```

The four missing profiles' detail routes render `h1="Page not found"`. The app's own home-page
metric band and footer both say **twelve** ("The twelve opponent profiles, as trait vectors"),
so the UI contradicts itself.

### Evidence

`grep -oE "id: '[a-z-]+'" apps/web/src/fixtures/legends.ts` yields 8 profile ids (plus the 3
difficulty ids). Rendered page: `cardCount: 8`, and
`fallbackNotice: ["These profiles are bundled sample data", "The profile service is not
reachable, so this page is rendering the bundled sample profiles…"]`.

### Fix

Fix P0-1 so live data is used, **and** bring the fixture to all 12 profiles so the fallback is
not itself a requirement violation.

### Missing test

A test asserting `LEGEND_PROFILES_FIXTURE.profiles.length === PROFILES.length` (fixture vs
`@prl/poker-ai`), plus a render test asserting the `/legends` listing renders one card per
profile. The fixture is typed against `@prl/contracts`, which makes it the right *shape* — it
was never asserted to be the right *length*.

### What Legends gets right

Worth recording, because it is all required and all correct: the archetype name is the primary
heading (`<h3>` at 18px), the attributed name is secondary
(`.prl-legend-identity__attributed prl-label`, 11px uppercase), **every** disclaimer in the
array renders **inline in the card body** at 13px (`--prl-type-body-sm`) with
`inTooltip: false, visible: true` — not in a tooltip, not behind an icon, not in a `<details>`.
`imgCount: 0` across the page: no portraits, no likenesses, no AI faces. The 16-axis radar is
inline SVG with `role="img"` and a genuinely useful label — *"…sixteen trait axes. Trait radar
over 16 trait axes on a 0 to 1 scale, averaging 0.52. Highest: Tournament instincts at 0.78.
Lowest: Folds under pressure at 0.30."* — plus a full `<table>` text equivalent of all 16 axes.
The decorative sigil is `aria-hidden="true"`.

---

## P2-1 · No failsafe when hydration fails: boot overlay plus reveals leave a blank page

**Severity: P2** · `packages/ui/src/styles/components.css:1850-1870`,
`apps/web/src/app/globals.css:600-620`, `packages/ui/src/styles/components.css:1416-1441`

### Problem

Two independent mechanisms hide content until JavaScript runs, and both guard the
*scripting-disabled* case while neither guards the *scripting-enabled-but-JS-did-not-run* case:

1. `.prl-boot` is server-rendered `data-state="pending"`, `position: fixed; inset: 0`, opaque
   `background-color: var(--prl-surface-page)`, `z-index: 900`. Only `data-state="done"`
   makes it transparent and `pointer-events: none`, and **only JavaScript sets that.** The
   900ms cap §8 advertises is enforced solely in `BootSequence`'s effect.
2. The server emits `data-revealed="false"` on every `Reveal` (6 on the home page), and
   `.prl-reveal[data-revealed="false"] { opacity: 0 }`.

CSS covers `@media (scripting: none)`, `prefers-reduced-motion` and `data-boot="skip"`. None of
those match a browser where scripting is enabled but the bundle failed. The result is an opaque
full-viewport overlay over content that is itself invisible.

The code comment claims otherwise, which is why this is worth reporting rather than shrugging at
(`components.css:1403-1404`):

> "Every failure mode - no JavaScript, no observer, an observer that never fires, **a hydration
> that never happens** - lands on 'the content is there'."

### Reproduction

I hit this for real, twice, by two different routes.

**(a) A stale chunk manifest** — exactly what a mid-session deploy produces. After rebuilding
while a server was serving the old build:

```
[EXCEPTION] ChunkLoadError: Failed to load chunk /_next/static/chunks/1_jjh3ca-qmgp.js
            from module 28542
```
DOM at that moment: `bootState:"pending"` after 2s, and 5 minutes later still
`<div aria-hidden="true" class="prl-boot" data-state="pending">…<p class="prl-boot__count">0</p>`.

**(b) A backgrounded tab** (rAF/IO throttled to zero):

```
{"visibility":"hidden","hasFocus":false,"rafFiredWithin1500ms":false,"bootState":"pending"}
reveals: 6 × {rev:"false", op:"0"}   ← all content invisible
```

Case (b) self-heals when the tab is focused. Case (a) does not recover without a reload.

### Evidence that the guard set is incomplete

```
$ grep -rn "scripting" packages/ui/src apps/web/src
packages/ui/src/styles/components.css:1429  @media (scripting: none) {
apps/web/src/app/globals.css:600            @media (scripting: none) {
apps/web/src/styles/play.css:516            @media (scripting: none) {
```

`.prl-boot` has no time-based CSS dismissal; the only `@keyframes` in the block
(`prl-boot-wipe`) animates `.prl-boot__rule`, not the overlay's opacity.

### Fix

Make the 900ms cap real in CSS, which is the layer `globals.css` itself argues for ("all three
expressed in CSS rather than in JavaScript, because CSS applies before first paint and
JavaScript does not"). Add a forwards animation on `.prl-boot` with
`animation-delay: var(--prl-dur-count)` that ends at `opacity: 0; pointer-events: none`; keep
the component's `transitionend` unmount as the fast path. The pattern already exists two rules
away. For the reveals, the honest options are to render `data-revealed` **absent** on the
server (CSS then cannot hide it) or to add the same time-based failsafe.

### Missing test

A test that loads each route with the JS bundle blocked (request interception → 404 on
`/_next/static/chunks/*`) while `scripting` remains enabled, then asserts the boot overlay is
not hit-testable at the viewport centre and that the `h1` and each reveal have non-zero
opacity. The existing `scripting: none` guard is untested and would pass such a test only by
accident.

---

## P2-2 · CORS allows only `localhost:3000`, so `127.0.0.1:3000` degrades everything silently

**Severity: P2** · `.env:PUBLIC_WEB_ORIGIN`, `apps/web/src/lib/api.ts:42`

### Problem

`PUBLIC_WEB_ORIGIN=http://localhost:3000` and `API_ORIGIN` defaults to
`http://localhost:3001`. `localhost` and `127.0.0.1` are **different origins**. A reader who
opens the app at `http://127.0.0.1:3000` — the address this review task itself specifies, and
the one `next start` prints as a network alternative — gets no `Access-Control-Allow-Origin`
header, so every browser fetch is blocked and the whole app falls back to fixtures with nothing
in the UI to say so.

### Reproduction

```
http://127.0.0.1:3000      -> (no ACAO header)
http://localhost:3000      -> access-control-allow-origin: http://localhost:3000
http://127.0.0.1:3010      -> (no ACAO header)
```

Console, on every route, from a page served at `127.0.0.1`:

```
Access to fetch at 'http://localhost:3001/api/session' from origin 'http://127.0.0.1:3010'
```

`docs/RUNBOOK.md:38` and `.env.example:54` both say `http://localhost:3000`, so the
*documented* flow is consistent — this is a footgun rather than a broken doc, and it is
currently masked by P0-1 (nothing reaches the API anyway).

### Fix

Ship both loopback spellings in the dev default
(`PUBLIC_WEB_ORIGIN=http://localhost:3000,http://127.0.0.1:3000`) and derive
`NEXT_PUBLIC_API_ORIGIN`'s host from `window.location.hostname` in development so the two
always agree. Independently, the shell should surface *some* indication when the session call
fails, as the legends screens already do.

### Missing test

A smoke assertion that every origin in `PUBLIC_WEB_ORIGIN` receives a matching ACAO header, and
a dev-mode check that the API origin's host matches the web origin's host.

---

## P3 findings

### P3-1 · `pnpm run test:a11y` audits 6 of 13 routes by default

`scripts/a11y-audit.mjs:157-158` sets `maxRoutes: 12, crawlDepth: 1`. Crawling one level from
`/` reaches only the five nav destinations, so the seven detail routes are never audited even
though the route cap has headroom. Default run: "routes audited 6". Seeded explicitly with all
13, the audit still reports **0 violations**, so nothing is hiding there today — but a
regression on a lesson, profile, scenario or hand-review page would not be caught.
**Fix:** `crawlDepth: 2`, or seed the known route list. **Missing test:** assert the audited
route count equals the number of `page.tsx` files under `apps/web/src/app`.

### P3-2 · Two lint warnings

`packages/content/src/validate.ts:670` (complexity 36) and `:865` (complexity 33), max 24.
Not frontend, but `pnpm run lint` is a release gate and exits 0 while warning.
**Fix:** extract per-section validators. **Missing test:** run Biome with
`--error-on-warnings` in CI.

### P3-3 · The brand's accessible name changes with viewport

`apps/web/src/app/globals.css:181` hides `.prl-shell__brand-tail` (`" Lab"`) with
`display: none` below 860px, so the home link's accessible name becomes "00 Poker Risk" — the
product's name, minus a word — for every mobile and tablet user including screen-reader users.
The space saving is deliberate and documented; the accessible-name loss looks unintended.
**Fix:** swap `display: none` for the existing `.prl-visually-hidden` treatment on the tail, so
the name survives while the pixels do not. **Missing test:** assert the brand link's accessible
name is "Poker Risk Lab" at 390, 834 and 1440.

### P3-4 · Equity-bar legend rows are visually inconsistent when a label wraps

`.prl-equity-bar__row` measures 46px for the first series and 82px for the second, because the
long label ("Cutoff, the assumed continuation-betting range") wraps and pushes its swatch onto
its own line while the percentage falls to a third line. The first row reads
`▣ You, ace-king of hearts … 54.1%` on one line; the second does not, so the two series do not
scan as a pair. Cosmetic only — both values and both patterns are present and correct.
**Fix:** give the row a `grid-template-columns: auto 1fr auto` so swatch/label/value hold their
columns regardless of label length. **Missing test:** a snapshot of row heights with a
deliberately long series label.

---

## 3. What I verified as correct

These were all explicit audit items, and all pass. Recording them so nobody re-derives them.

**The table (§6.1)** — at any viewport where it is not occluded (all of mobile, all of tablet,
desktop ≥~1400px tall) it is complete and correct: six seats each with position label, name,
tabular stack, street commitment and status; dealer button on BTN; `POT 100 UNITS` as a metric
block; board `Q♥ 7♥ 2♣`; hatched face-down cards for the live opponent. **The active seat is
marked three ways at once** — accent border, a "to act" chip with real text, and the turn-timer
arc — never by colour alone. Below 900px it re-flows to a vertical stack with nothing removed,
and `.prl-table__opponents` is a wrapping grid rather than a horizontal scroller, which is the
right call for keyboard reachability.

**The Coach (§6.2)** — equity `54.1 % ± 0.35 points` with a `≈ monte carlo` chip and
"80,000 trials sampled", break-even equity 25.9%, price offered 2.9 to 1, clean vs dirty outs
distinguished by **fill pattern plus a text count** (9 clean / 6 dirty). Critically:
**the assumptions are not collapsed** — `assumptionsAnyCollapsed: false`. The only `<details>`
are the four §6.2 permits (per-action EV, outs card-by-card, derivations, teaching notes).
Nothing in the UI claims "correct" or "optimal": `CoachPanel.tsx:487` reads "A suggestion that
follows from the assumptions listed below — not a claim about the best play." The only
"optimal" string in the app is a deliberately-wrong quiz option.

**Screen-reader semantics** — cards carry `role="img"` with labels "queen of hearts",
"seven of hearts", "two of clubs", "face-down card". The board is a labelled group:
`<figure><figcaption class="prl-visually-hidden">community cards: queen of hearts, seven of
hearts and two of clubs</figcaption>`, with the visible "Board" label `aria-hidden` so it is not
announced twice. Action buttons announce cost: `"call 35 units"`,
`"fold, costs 0 units, gives up the hand and any claim on the pot"`,
`"raise to 70 units, 70 units out of your stack"`.

**Live regions and focus** — four `aria-live="polite"` regions carrying authoritative values
("Pot: 100 units", "Your share of the pot: 54.1 % ± 0.35 points", "Expected value of that line:
63.5 units") while the animated figures are `aria-hidden="true"`, so **no count-up is ever read
mid-count**. All twelve `.focus()` call sites are user-initiated (key handlers, quiz submit,
glossary jump, scenario commit, sheet open/close); **none fires on a data or remote event**.

**Reduced motion** — verified at the JS level, not just the media query: boot overlay absent
from the DOM, all 6 reveals resolved to `data-revealed="true"` / `opacity: 1` /
`transform: none`, and count-ups showing final values immediately (`133,784,560`, `36`, `12`,
`0`) while still `aria-hidden`.

**Keyboard** — every tab stop I visited showed a real focus ring
(`outline: 2px solid rgb(111,226,238)` = `--prl-accent-300`), including the skip link, brand,
units toggle, nav trigger, five bet presets and the slider. The bet slider **is** paired with a
number input (`RAISE TO [70]`), satisfying §7 / 2.1.1. Escape closes the mobile sheet and
returns focus to its trigger.

**Both themes** — light mode inverts the accent pairing correctly per §2.4a (the primary button
becomes dark teal with white text). Card faces stay light in both. Nothing illegible found in
either theme, and `check-contrast.mjs` passes on the rendered layer.

**Loading / error / empty / not-found** — root `loading.tsx`, `error.tsx` and `not-found.tsx`
exist and, per App Router semantics, serve as the boundary for every nested segment;
`/review/[handId]` adds its own. An unknown route renders a real "Page not found" page. No
route rendered blank.

**No casino or dark patterns** — no celebration on winning, no streaks, no leaderboard, no
currency symbol, no loss-chasing copy. The units badge carries the required explanation:
"Units are free practice chips. They have no monetary value, they cannot be bought, sold,
transferred or cashed out…". A hand that lost is styled as information, not failure.

---

## 4. What I could NOT verify

* **Any journey against live server state.** P0-1 means the UI never reached the API, so
  guided bot play, a real hand played to completion, the Coach on live equity, a real
  completed-hand state and post-hand Legend comparison were all audited as **fixtures only**.
  This is the largest gap in my coverage and it is caused by the defect, not by the environment.
* **Real assistive-technology output.** I verified accessible names, roles, live regions and
  focus order in the DOM. I did not run VoiceOver/NVDA, so I cannot claim what is actually
  announced.
* **A browser-based `axe.run()`.** `pnpm run test:a11y` is a static markup audit by design, and
  its own header is honest about excluding colour contrast, focus order, keyboard use and
  anything CSS or client JS decides. I covered those manually via CDP, but a real axe run in a
  live DOM is still outstanding.
* **Browsers other than Chrome.** Chrome 1440/834/390 only. No Safari, Firefox, or
  Windows high-contrast verification beyond reading the `forced-colors` blocks.
* **Exhaustive combinations.** I tested a representative subset of
  {13 routes} × {3 viewports} × {2 themes} × {2 motion settings}, not all 156.
* **The Scenario Lab's interactive controls** were loaded and structurally checked but not
  driven scenario-by-scenario.
* **The pre-existing server on port 3000**, which I was denied permission to restart; my audit
  ran against an identical build on port 3010.

---

## 5. Commands run

```
pnpm run build                       # clean, 0 warnings
pnpm run lint                        # exit 0, 2 warnings
pnpm run typecheck                   # clean, 8 projects
pnpm run test:a11y                   # PASS, 6 routes (default)
node scripts/a11y-audit.mjs --base-url http://127.0.0.1:3010 --no-start \
  --routes "<all 13>" --max-routes 14 --crawl-depth 0   # PASS, 13 routes, 0 violations
node scripts/check-contrast.mjs      # PASS both layers, both themes
(cd packages/ui && node --test 'test/*.test.ts')         # 169 pass / 0 fail
curl -s -H "Origin: http://localhost:3000" http://127.0.0.1:3001/api/...   # path matrix
node cdp.mjs-driven probes           # viewport/theme/motion/keyboard/hit-testing
```

Screenshots and probe scripts:
`/private/tmp/claude-501/-Users-terence-Projects-exploration-sites/0b0dd179-432f-4e29-aabb-dcafd08eb8c7/scratchpad/shots/`

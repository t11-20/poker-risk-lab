# Reviewer F — Frontend & Accessibility

**Repo:** `/Users/terence/Projects/exploration-sites/poker-risk-lab`
**Ports used:** web `3200`, api `3201` (both started by me)
**Date:** 2026-08-18
**Method:** real Chrome (Claude-in-Chrome MCP) driving the running app, plus the repo's own scripts.

## How the app was run

```
# API
PORT=3201 HOST=127.0.0.1 PUBLIC_WEB_ORIGIN=http://localhost:3200 \
  node --env-file-if-exists=.env apps/api/src/server.ts
{"msg":"Server listening at http://127.0.0.1:3201"}
{"address":"http://127.0.0.1:3201","nodeEnv":"development","oidcEnabled":false,
 "allowedOrigins":["http://localhost:3200"],"routeModules":7,"msg":"listening"}

# Web
PRL_API_ORIGIN=http://localhost:3201 PRL_API_REWRITE_ORIGIN=http://localhost:3201 \
  ./node_modules/.bin/next dev --port 3200
▲ Next.js 16.3.0 (Turbopack)  - Local: http://localhost:3200  ✓ Ready in 369ms
```

Note: this is `next dev`, not a production build. A production build would have required
overwriting `apps/web/.next`, which other auditors may be using. Semantics, focus, keyboard,
contrast and layout are identical between the two; the only dev-only artefact is the
`<nextjs-portal>` dev overlay, which I strip before every measurement and which I have
**excluded from all findings**.

---

## Tooling limits that shaped the evidence (read before trusting any status)

1. **OS-level key injection does not work in this environment.** `computer{action:"key"}` and
   `computer{action:"type"}` dispatch nothing the page can see — a `keydown` listener installed
   on `window` recorded `[]` after pressing Tab, End and typing into a focused `<input>` whose
   `value` stayed `""`. Mouse clicks by coordinate *do* work. Consequence: I could **not** press
   Tab. Where a requirement depends on the browser's own Tab sequencing I say so and do not
   claim PASS. What I did instead, and what it does and does not prove, is stated per requirement.
2. **The Chrome window is the user's own** (6 windows, 47 tabs in the window my tab landed in) and
   loses OS focus between tool calls. Without document focus, `:focus`/`:focus-visible` do not
   match and every element falsely reports "no focus ring". I detected this
   (`document.hasFocus():false`, `matchesFocus:false` while `activeElement` was correct) and
   re-ran every focus measurement inside a **single** tool call after foregrounding the tab, and
   made the harness self-validating (`focusVisibleCount` must equal the tab-stop count or the
   run is discarded). All focus-ring numbers below come from runs where that held.
3. **`resize_window` was unreliable** while the extension side panel was open (`innerWidth`
   pinned at 1280 regardless). I therefore drove the three viewports through a same-origin
   `<iframe>` sized exactly 375×667 / 768×1024 / 1440×900, which gives a genuine CSS viewport
   (media queries, `position:fixed`, painting and hit-testing all behave normally). I verified
   the iframe is faithful by reproducing the one occlusion finding in the real window too, and
   by confirming `documentElement.clientWidth` equals the requested width. The app's reset sets
   `max-width:100%` on iframes, which silently clamped my first 1440 run to 1280 — caught and
   overridden with `max-width:none`; the 1440 numbers below are from the corrected run.

---

## Summary table

| ID | Title | Status |
|---|---|---|
| UX-001 | No horizontal page scroll at 375 / 768 / 1440 | PASS |
| UX-002 | No interactive control occluded by another element | PARTIAL |
| UX-003 | Home → Learn → lesson → quiz journey | PASS |
| UX-004 | Scenario Lab → scenario → decision → see the math | PASS |
| UX-005 | Play / live table → Coach panel | PASS |
| UX-006 | Hand Review journey | PASS |
| UX-007 | Legends content | PASS |
| UX-008 | Error states (API down, bad id) | PASS |
| UX-009 | Loading and empty states | PASS |
| UX-010 | No silent fallback to fake data | PASS |
| UX-011 | Every primary control does something | PASS |
| UX-012 | No console errors/warnings | PARTIAL |
| UX-013 | Theme switching (light / dark / auto) | PASS |
| A11Y-001 | Keyboard-only operation of every primary journey | PARTIAL |
| A11Y-002 | No keyboard trap | PARTIAL |
| A11Y-003 | Visible focus indicator on every focusable element | PASS |
| A11Y-004 | Logical focus order | PASS |
| A11Y-005 | Focus management / announcement on route change | PASS |
| A11Y-006 | Modal focus trap works and Escape exits | PASS |
| A11Y-007 | Landmarks | PASS |
| A11Y-008 | Heading hierarchy, no skipped levels | PASS |
| A11Y-009 | Accessible name on every control | PASS |
| A11Y-010 | Images, SVG and charts have text alternatives | PASS |
| A11Y-011 | ARIA correctness | PASS |
| A11Y-012 | Live regions for dynamic updates (incl. Coach) | PARTIAL |
| A11Y-013 | Form error association | PARTIAL |
| A11Y-014 | Card accessibility — rank+suit, not colour alone | PASS |
| A11Y-015 | Contrast in both themes, rendered | PASS |
| A11Y-016 | Reduced motion respected | PARTIAL |
| A11Y-017 | Focus not obscured (WCAG 2.2 SC 2.4.11) | PASS |
| A11Y-018 | Target size minimum (WCAG 2.2 SC 2.5.8) | PASS |

---

## UX-001 No horizontal page scroll at three viewports

- **Requirement (exact):** At 375×667, 768×1024 and 1440×900 no primary page may scroll
  horizontally; content must not be clipped.
- **Status:** PASS
- **Implementation location:** `apps/web/src/styles/*.css`, `packages/ui/src/styles/base.css`
- **Runtime evidence:** Per route I measured `documentElement.scrollWidth > clientWidth` inside a
  correctly-sized iframe. 9 routes × 3 viewports = 27 measurements, all `hScroll=false` and
  `scrollWidth === viewportWidth`:

```
mobile375:  / vw=375 hScroll=false sw=375   | /learn vw=375 hScroll=false sw=375
            /lab vw=375 hScroll=false sw=375 | /play vw=375 hScroll=false sw=375
            /review vw=375 hScroll=false sw=375 | /legends vw=375 hScroll=false sw=375
            /legends/hand-review vw=375 hScroll=false sw=375
            /review/hand-0042 vw=375 hScroll=false sw=375
            /learn/pot-odds vw=375 hScroll=false sw=375
tablet768:  all 9 routes  vw=768  hScroll=false
desktop1440: all 9 routes vw=1440 hScroll=false sw=1440
```

  Wide content is correctly contained: on `/review` at 375 the `<table>` measures 860px wide but
  lives in an `overflow-x` scroll container, so the *page* does not scroll. The visually-hidden
  radar data tables on `/legends` are similarly wider than the viewport but clipped, not scrolling.
- **Test covering it:** `scripts/a11y-audit.mjs` checks `meta-viewport` only. No layout test
  observes real geometry.
- **Test result:** repo a11y audit — 40 routes, 0 violations (static markup only).
- **Reviewer notes:** This is the strongest single result in the audit. I deliberately measured
  page-level scroll rather than "any element wider than the viewport", because the latter
  false-positives on legitimate scroll containers and clipped visually-hidden tables.
- **Missing work:** none.

## UX-002 No interactive control occluded by another element

- **Requirement (exact):** No element may cover an interactive control such that the control
  cannot be actuated by pointer.
- **Status:** PARTIAL
- **Implementation location:** `apps/web/src/components/TableStage.tsx:432-459` (mobile Coach
  bottom sheet), `apps/web/src/styles/play.css`
- **Runtime evidence:** For every visible control I scrolled it into view, took its centre point
  and ran `document.elementFromPoint`, treating "the returned node is not the control nor a
  descendant/ancestor" as occlusion. Elements were gated on
  `checkVisibility({checkVisibilityCSS,contentVisibilityAuto,visibilityProperty})` so hidden
  content is not counted.

```
tablet 768  — 9 routes, 232 controls hit-tested, occ=0 on every route
desktop 1440 — 9 routes, occ=0 on every route
mobile 375  — 8 of 9 routes occ=0.  /play:
  a.prl-footer__link["05Review"] COVERED-BY div.prl-play__handle-row["Show the analysis…"]
```

  Reproduced in the real window at 375: the "Open the table" primary CTA is covered on first paint.

```
btnRect [37,626,159,44]   viewport 371x663   visible:true
elementFromPoint(117,648) -> BUTTON.prl-play__handle  ("Show the analysis")   isButton:false
coach sheet: position:fixed  top:599  z-index:300
main padding-bottom: 48px;  body padding-bottom: 0px;  footer padding-bottom: 0px
```

  Scroll scan of the same button (every 40px through the document):

```
scrollY 0   btnTop 626  clickable:false  hit BUTTON.prl-play__handle
scrollY 50  btnTop 576  clickable:true   hit BUTTON.prl-btn
… everClickable:true, covered at 5 of 59 scroll positions
```

- **Test covering it:** NONE. The repo's layout guard asserts CSS textually and cannot see
  occlusion.
- **Reviewer notes:** Real but bounded. The fixed Coach sheet occupies the bottom ~64px of the
  mobile viewport and the page reserves no bottom padding for it, so whatever sits under it at a
  given scroll offset is not clickable — including, at the initial scroll position, the page's
  primary call to action. It is recoverable with a 50px scroll and it is **not** a WCAG failure
  (see A11Y-017: keyboard focus scrolls the control clear). I also chased and **dismissed** two
  false positives that a less careful pass would have reported as defects: (a) the five
  `?state=` links inside the closed `<details class="prl-disclose">` on `/play` report stale
  layout rects under the footer, but Chrome correctly hides them —
  `checkVisibility()===false` and `el.focus()` refuses to move focus; (b) the `.prl-lab-card`
  focus ring (see A11Y-003).
- **Missing work:** reserve bottom padding on `/play` equal to the collapsed sheet height at
  `<600px`, so no content ever sits permanently under it.

## UX-003 Home → Learn → lesson → quiz journey

- **Requirement (exact):** A reader can go from the home page to Learn, open a lesson, and
  complete a quiz question.
- **Status:** PASS
- **Implementation location:** `apps/web/src/app/learn/[lessonId]/page.tsx`,
  `apps/web/src/components/QuizRunner.tsx`
- **Runtime evidence:** Navigated `/` → `/learn` (18 lesson links) → `/learn/pot-odds`. The quiz
  is a real radio group:

```
legends: ["Choose one answer"]
radios name="pot-odds-q1", every one wrapped in its <label>
choice 2 label: "The share of the time you must end up with the pot for calling…"
```

  Answering it (activation of the real radio, verified by `checked` transition
  `[false,false,false,false] -> [false,true,false,false]`) produced a verdict in a polite live
  region:

```
aria-live="polite" => "That matches the answer this lesson gives. The reasoning is below —
                       worth reading even so, because the reasoning is the part that …"
```

- **Test covering it:** `apps/web/test/**` (typecheck + node:test); no browser test.
- **Reviewer notes:** One caution about my own method — a coordinate click at a *verified
  correct* point initially failed to select the radio. I did not report that as a bug: the page
  has reveal-on-scroll animations that shift layout between the measure call and the click call,
  and the control itself is fully functional. Worth knowing that this app's layout is not stable
  across tool round-trips.
- **Missing work:** none.

## UX-004 Scenario Lab → scenario → decision → see the math

- **Requirement (exact):** A reader can open a scenario, commit a decision, and see the analysis.
- **Status:** PASS
- **Implementation location:** `apps/web/src/app/lab/[scenarioId]/page.tsx`,
  `apps/web/src/components/ScenarioStage.tsx:244-247, 388-397`
- **Runtime evidence:** `/lab` lists 36 scenarios. Opened
  `/lab/eq-flush-draw-turn-small-bet` and clicked **Call** with a real mouse click at
  screenshot (762,440):

```
before: buttons = fold/call/raise + 5 pot-fraction presets
after 4s:
  focusMovedTo: SECTION "The analysis of your decision"   tabIndex: -1
  h2s: What this analysis assumes | The situation | Your decision |
       How your action compares with the … | The reasoning |
       Ways this spot is commonly misread | The analysis in full
  live region role=status: "The analysis for Flush Draw Facing A Small Bet is now shown
                            below your decision."
```

- **Reviewer notes:** Exemplary. The reveal moves focus to a labelled `tabindex="-1"` section
  *and* announces it. This is the pattern the `/play` Coach path is missing (A11Y-012).
- **Missing work:** none.

## UX-005 Play / live table → Coach panel

- **Requirement (exact):** A reader can open a real server-dealt table and get Coach analysis.
- **Status:** PASS
- **Implementation location:** `apps/web/src/app/play/LiveTable.tsx`,
  `apps/web/src/lib/use-live-table.ts`, `packages/ui/src/components/CoachPanel.tsx`
- **Runtime evidence:** Full journey against the live API, not a fixture:

```
click "Open the table" -> fetch /api/v1/auth/session -> 200
                          fetch /api/v1/rooms       -> 201
                          WS ws://localhost:3200/api/v1/ws -> open
status: "Live. Everything on this screen is the server's own view of the table, redacted for you."
click "Take seat 1"  -> YOUR SEAT: seat 1
click "Deal the next hand" -> 14 .prl-card elements appear
action bar: legend "How much to raise to"; presets with aria-pressed;
  input[range] min=20 max=1000 step=1 aria-describedby -> "Allowed range 20 to 1,000 units…"
  buttons: aria-label "fold, costs 0 units, gives up the hand and any claim on the pot"
                      "call 10 units"
                      "raise to 20 units, 20 units out of your stack"
click Call -> live announcements:
  status => "You chose to call. smallBlind 5 from seat 4, bigBlind 10 from seat 5"
  status => "You chose to call. calls 10"
  polite => "Pot: 25 units"     status => "raises to 20"   status => "raises to 30"
  polite => "Pot: 75 units"     status => "folds"
Coach panel present, heading "Coach analysis",
  polite => "Your share of the pot: 23.1 % ± 1.83 points"
  polite => "Expected value of that line: 19.5 units"
```

- **Reviewer notes:** The table is genuinely server-authoritative and the hands I played later
  appeared in `/review` with correct timestamps. One robustness observation: after I restarted
  the API, the client's remembered room id produced a WS close `4403`; the UI recovered
  gracefully with "Not your table — … start your own table instead" plus a **Start a fresh
  table** button, which worked. The Coach *content* is fine; its *announcement* is the gap —
  see A11Y-012.
- **Missing work:** none for this requirement.

## UX-006 Hand Review journey

- **Requirement (exact):** A reader can open a finished hand and step through it.
- **Status:** PASS
- **Implementation location:** `apps/web/src/app/review/[handId]/page.tsx`,
  `apps/web/src/components/HandReplay.tsx`, `apps/web/src/components/DecisionTimeline.tsx`
- **Runtime evidence:** `/review` (with a real guest session) listed the hands I had just played;
  opened `/review/hand_2hmpywup7nmywi5mh64v67vo6q`:

```
h1 "Hand 2";  fieldset legend "Decision timeline";  15 markers
marker 1: tabIndex 0, aria-current="step",
  label "▸CALL 10 + Step 1 of 15. preflop: you called 10 units. A…"
markers 2..15: tabIndex -1
role=status: "Step 1 of 15. preflop: you called 10 units. An analysis is attached to…"
polite: "Pot: 15 units" / "Your stack: 1,000 units" / "Your equity: 13.0 % ± 0.65 points"
```

  Keyboard operation of the composite widget (dispatched `keydown`, which exercises the app's own
  handler):

```
ArrowRight prevented=true {tabStop:1,current:1,active:1,status:"Step 2 of 15. preflop: Patient Technician raised to "}
ArrowRight prevented=true {tabStop:2,current:2,active:2,status:"Step 3 of 15. preflop: Calling Station raised to 30 "}
ArrowLeft  prevented=true {tabStop:1,current:1,active:1,status:"Step 2 of 15…"}
End        prevented=true {tabStop:14,current:14,active:14,status:"Step 15 of 15. End of the hand: final stacks and the"}
Home       prevented=true {tabStop:0,current:0,active:0,status:"Step 1 of 15…"}
```

- **Reviewer notes:** Correct roving-tabindex composite widget: one tab stop, arrows/Home/End
  move it, `aria-current="step"` follows, and every move updates a `role="status"` region with a
  full sentence. `preventDefault` is called so the page does not also scroll.
- **Missing work:** none.

## UX-007 Legends content

- **Requirement (exact):** Legends screens render and are navigable.
- **Status:** PASS
- **Implementation location:** `apps/web/src/app/legends/**`
- **Runtime evidence:** `/legends` (12 profiles, 42 tab stops), `/legends/vocal-aggressor`,
  `/legends/compare`, `/legends/hand-review` all render. `/legends/hand-review` produced a full
  worked hand (7 decisions, per-decision equity, break-even equity, EV given up, opponent policy
  weights) and **discloses its provenance**: "This is a bundled sample hand — Per-hand comparison
  against a Legend profile is not served by the API yet…". No heading, landmark, label or focus
  problems on any of the four.
- **Missing work:** none.

## UX-008 Error states

- **Requirement (exact):** With the API stopped, or a bad id requested, the reader gets a real
  error state — not a blank page.
- **Status:** PASS
- **Runtime evidence:** Bad ids return proper 404s while the API is healthy:

```
404  /lab/does-not-exist      404  /learn/nope      404  /review/hand-9999
```

  API stopped (`kill 50514`), then `/play` → click "Open the table":

```
fetch /api/v1/auth/session -> 500
rendered: "The table could not be prepared
           GET /api/v1/auth/session failed with status 500 (internal_error)
           [Try again]
           ▲ ERROR — TABLE UNAVAILABLE
           No controls while the table is unreachable.
           NO ANALYSIS — The Coach prices the decision in front of you, so with no table
           state there is nothing to price."
```

- **Reviewer notes:** The visual error state is genuinely good — it names the failing call, the
  status, the contract error code, and offers recovery. Its **accessibility** is the problem;
  see A11Y-012, which is my hardest-hitting finding.
- **Missing work:** none for the visual state.

## UX-009 Loading and empty states

- **Requirement (exact):** Loading and empty states are real, not blank.
- **Status:** PASS
- **Runtime evidence:** `/play` before connecting shows a skeleton plus "Loading the table." /
  "Waiting for the table." / "Loading the analysis.", and a `role="status"` sentence "Not
  connected yet. Opening the table creates a guest session — no email, no password…". With a
  session and no history the review table renders the reader's real (server-sourced) rows; with
  no session it renders the fixture with a disclosure. `/legends/compare` empty-selection and
  `/play` no-hand-in-progress states both render explanatory copy ("No hand is in progress.
  Dealing is the owner's to ask for, so nothing starts until you do.").
- **Missing work:** none.

## UX-010 No silent fallback to fake data

- **Requirement (exact):** If the app renders fixture data instead of server data, it must say so.
- **Status:** PASS
- **Runtime evidence:** With the API stopped, every fallback is labelled on-page:

```
/lab      "Fixture data — The scenario API is not reachable, so this list comes from the typed
           fixture in src/fixtures/scenarios.ts. Every figure in it was computed by the real
           analysis functions, but no server was involved in this page."
/review   "Fixture data — The hands API is not reachable, so this list comes from
           src/fixtures/review.ts…"
/review/hand-0042
          "Fixture data — The hands API is not reachable, so this replay comes from
           src/fixtures/review.ts…"
/learn    "This index is not live — The content service is not reachable, so this index is
           listing the bundled copy of the curriculum. The lessons and their prerequisites are
           real; the read/unread marks are not yours. (could not reach the API at http://localh…)"
```

  Crucially the fallback stays *coherent*: with the API down `/lab` swaps to the fixture ids and
  following the first listed link returns 200, so the journey does not dead-end.
- **Reviewer notes:** I went looking for the classic "silently serves fake data" defect and it is
  not here. This is handled better than most production apps. One residual: a deep link to an
  API-sourced scenario id (`/lab/eq-flush-draw-turn-small-bet`) returns **404** during an outage
  rather than "temporarily unavailable", which misattributes an outage to a bad URL. P3.
- **Missing work:** distinguish "not found" from "cannot reach the service" on dynamic routes.

## UX-011 Every primary control does something

- **Requirement (exact):** Clicking any primary control produces an effect.
- **Status:** PASS
- **Runtime evidence:** Actuated and observed: Menu (opens sheet, `aria-expanded` false→true),
  theme radios (Auto/Light/Dark — `data-theme` attribute and painted colours change), Open the
  table, Start a fresh table, Take seat 1, Deal the next hand, Fold/Call/Raise + 5 presets,
  Refresh the analysis, quiz radios, quiz Next question, scenario Call, timeline markers, sort
  buttons on `/review`, Replay hand links, nav links, skip link.
- **Reviewer notes:** I found **no** dead control. Two apparent dead controls were tooling
  artefacts I disproved rather than reported: `computer{ref:…}` clicks silently no-op when the
  element re-rendered after `find` (the same button worked immediately via coordinates), and the
  quiz radio coordinate miss described in UX-003.
- **Missing work:** none.

## UX-012 No console errors or warnings

- **Requirement (exact):** No console errors or warnings on any page.
- **Status:** PARTIAL
- **Runtime evidence:** Console cleared, then 10 routes loaded. A clean load of `/` produced
  **zero** errors. Across the sweep, two errors:

```
[ERROR] [api] GET /api/v1/hands/hand-0042 → 404. Nothing is registered at that path, or the id
        in it does not exist. … so a 404 here is a client bug until that test says otherwise.
[ERROR] Encountered a script tag while rendering React component. Scripts inside React
        components are never executed when rendering on the client. Consider using template tag
        instead.
```

- **Reviewer notes:** Both are quality gaps rather than breakage. (1) is the app logging at
  **error** level on an entirely expected path — a signed-in guest opening a fixture-listed hand
  id that is not in their history — and the message asserts it "is a client bug", which is
  misleading for an outcome the app then handles correctly by falling back with a disclosure.
  (2) is React objecting to the pre-paint theme boot script inlined in
  `apps/web/src/app/layout.tsx`; the script is correct for SSR but React flags it on the client
  render.
- **Missing work:** demote the 404 log to info/debug for the no-history case; move the theme boot
  script out of the React tree (e.g. `<Script strategy="beforeInteractive">` or a raw
  `dangerouslySetInnerHTML` on a non-component node).

## UX-013 Theme switching

- **Requirement (exact):** Light, dark and auto themes all work and persist.
- **Status:** PASS
- **Runtime evidence:** Clicked each theme radio; `document.documentElement[data-theme]` went
  `auto → dark → light → auto`, `body` background `rgb(245,247,249)` ↔ `rgb(11,13,17)`, and
  screenshots confirm both themes render correctly. Contrast holds in both (A11Y-015).
- **Reviewer notes:** The theme change animates colours; `getComputedStyle` read within ~900ms of
  the switch returns interpolated values. I initially recorded 13 "dark theme contrast failures"
  that were entirely this artefact and disappeared on re-measure after settling. Anyone
  re-running a contrast check must wait for the transition.
- **Missing work:** none.

---

## A11Y-001 Keyboard-only operation of every primary journey

- **Requirement (exact):** Every primary journey must be completable using only
  Tab/Shift-Tab/Enter/Space/arrows; every control must be reachable and operable.
- **Status:** PARTIAL
- **Implementation location:** app-wide
- **Runtime evidence:** **I could not press Tab** (see Tooling limits §1), so I cannot report an
  observed Tab-by-Tab traversal, and I do not claim one. What I did verify, in a single
  focus-valid run at 1440×900 across 12 routes:

```
route                              stops  focus-visible  unreachable  no-ring
/                                    19        19             0          0
/learn                               61        61             0          0
/learn/pot-odds                      37        37             0          0
/learn/glossary                     373       373             0          0
/lab                                 54        54             0          0*
/lab/eq-flush-draw-turn-small-bet    28        28             0          0
/play                                16        16             0          0
/review                              27        27             0          0
/review/hand-0042                    19        19             0          0
/legends                             42        42             0          0
/legends/vocal-aggressor             30        30             0          0
/legends/hand-review                 22        22             0          0
                                    ---
total                               728       728             0          0
```

  *`/lab` initially reported 36 no-ring; resolved as a false positive — see A11Y-003.

  For each of the 728 I computed the sequential focus order per spec (DOM order; positive
  tabindex first; radio groups collapsed to the checked member), called `.focus()`, and asserted
  `document.activeElement === element`. **All 728 accepted focus.** App-level key handling was
  exercised with dispatched `KeyboardEvent`s, which run the app's own handlers: the mobile-nav
  Tab/Shift-Tab trap, Escape, and the DecisionTimeline Arrow/Home/End roving tab stop all behave
  correctly (see A11Y-006, UX-006). A quiz question was completed and a scenario decision
  committed without a mouse in the sense that both are native controls actuated through the
  accessibility/DOM activation path.
- **Test covering it:** NONE that exercises a real browser.
- **Test result:** repo `test:a11y` — 40 routes, 0 violations, and the script itself prints
  "Checked rules only. This is not a statement that the app is accessible; colour contrast, focus
  order and keyboard use still need a browser run."
- **Reviewer notes:** The evidence is strong but one link in the chain is missing. Reachability
  by `.focus()` plus a spec-derived order is not the same as observing the browser's own Tab
  sequence, and I will not upgrade this to PASS on inference. Nothing I saw suggests a problem:
  no positive `tabindex` anywhere, no `aria-hidden` container holding a tabbable, no custom
  widget re-implementing a native one.
- **Missing work:** run one automated keyboard traversal (Playwright/Puppeteer `page.keyboard.press('Tab')`
  in a loop, asserting the observed order) in CI. This is the single cheapest thing that would
  close the largest remaining evidence gap in this whole report.

## A11Y-002 No keyboard trap

- **Requirement (exact):** Focus must never become trapped anywhere the user cannot leave with
  the keyboard.
- **Status:** PARTIAL
- **Runtime evidence:** The one deliberate trap (mobile nav sheet) releases correctly: Escape
  closes it, `aria-expanded` returns to `false`, `hidden` is restored, the scroll lock attribute
  is removed and focus returns to the Menu button (A11Y-006). No other `role="dialog"`,
  `aria-modal`, `<dialog>`, `role="menu"` or focus-trapping code exists. The `GlossaryTerm`
  disclosure deliberately does not trap and closes on `focusout`.
- **Reviewer notes:** PARTIAL only because a trap is by definition something you discover by
  pressing Tab repeatedly, and I could not. No structural candidate for an accidental trap exists.
- **Missing work:** covered by the A11Y-001 traversal test.

## A11Y-003 Visible focus indicator on every focusable element

- **Requirement (exact):** WCAG 2.4.7 — every focusable element shows a visible focus indicator.
- **Status:** PASS
- **Implementation location:** `packages/ui/src/styles/base.css` (`:focus-visible` block),
  `apps/web/src/styles/lab.css` (`.prl-lab-card:has(…)`)
- **Runtime evidence:** Rules present in the *loaded* stylesheets:

```
:focus-visible { outline: var(--prl-focus-width) solid var(--prl-focus-color);
                 outline-offset: var(--prl-focus-offset); }
:focus:not(:focus-visible) { outline: none; }
:where(a,button,input,select,textarea,summary,[tabindex]):focus-visible {
                 z-index: var(--prl-z-raised); position: relative; }
.prl-skip-link:focus-visible { … clip-path: none; min-height: var(--prl-target-min); … }
@media (forced-colors: active) { :focus-visible { outline-color: highlight; } }
```

  Measured on a real focused element with document focus held:

```
matchesFocus:true  matchesFocusVisible:true
outline: "rgb(8, 69, 79) solid 2px"   outline-offset: "2px"
```

  Focus-ring contrast against the page background: **10.5:1** (rgb(8,69,79) vs white) — well
  above the 3:1 required by SC 1.4.11. Across 728 focusable elements on 12 routes, `no-ring = 0`.

  Skip link, focused:

```
clipPath:"none"  rect:[8,8,178,44]  position:fixed  z-index:500
outline:"rgb(8,69,79) solid 2px"   hitIsSkipLink:true   href:"#prl-main"
```

- **Reviewer notes:** I nearly filed a false FAIL here. `/lab`'s 36 scenario links compute to
  `outline-style:none` because of `.prl-lab-card__link:focus-visible { outline: none }`. The
  indicator is deliberately moved to the wrapping card via
  `.prl-lab-card:has(.prl-lab-card__link:focus-visible) { outline: … }`, which I confirmed by
  measuring the card before and after focusing the link: `none 3px` → `solid 2px rgb(8,69,79)`.
  Real indicator, different element. Also note the `z-index: var(--prl-z-raised)` rule, which is
  what stops focus rings being clipped by neighbours — a detail most codebases miss.
- **Missing work:** none.

## A11Y-004 Logical focus order

- **Requirement (exact):** WCAG 2.4.3 — focus order preserves meaning and operability.
- **Status:** PASS
- **Runtime evidence:** Observed order on `/` (16 stops at 1280, 19 at 1440):

```
0 skip link "Skip to main content"      1 brand "Poker Risk Lab"
2 nav Learn   3 nav Lab   4 nav Legends   5 nav Review   6 nav Play
7 units badge "What 'units' means"      8 "Start a hand"   9 "Read the lessons"
10 footer 01 Learn  11 02 Play  12 03 Lab  13 04 Legends  14 05 Review
15 theme radio (checked member only)
```

  Order matches visual order top-to-bottom, left-to-right. No positive `tabindex` on any route
  (the repo's static audit runs axe's `tabindex` rule and reports 0 violations across 40 routes).
  Radio groups correctly present a single tab stop.
- **Missing work:** none.

## A11Y-005 Focus management / announcement on route change

- **Requirement (exact):** A client-side route change must be perceivable to a screen-reader user.
- **Status:** PASS
- **Runtime evidence:** Focused the header "Learn" link, activated it, then polled:

```
before: path "/",     activeElement A "Learn"
after:  path "/learn", activeElement A.prl-nav__link "Learn",  isBody:false,  h1 "The curriculum"
```

  Focus is **not** moved into the new page — it stays on the activated link. The route *is*
  announced, by Next's built-in announcer, whose text lives in a shadow root:

```
navigate / -> /lab, polling next-route-announcer shadowRoot.textContent:
0ms "Scenario Lab"   300ms "Scenario Lab"  …  2700ms "Scenario Lab"
document.title: "Scenario Lab — Poker Risk Lab"
```

- **Reviewer notes:** A prior static reading of this codebase concluded there is "no route-change
  focus management, app-wide" and treated it as a defect. That is half right and the conclusion
  is wrong: there is no *app* code moving focus, but the framework's `aria-live` announcer does
  fire with the new page name, and focus lands on a persistent header link rather than being
  dropped to `<body>`. I read `a.textContent` first and got `""`, which would have produced a
  false FAIL — the text is in `shadowRoot`. Not moving focus on SPA navigation is a defensible
  choice and no WCAG SC requires it.
- **Missing work:** none required. Optional: `tabIndex={-1}` on `<main id="prl-main">`
  (`apps/web/src/app/layout.tsx:118`) as belt-and-braces for the skip link.

## A11Y-006 Modal focus trap works and Escape exits

- **Requirement (exact):** The mobile navigation dialog must trap focus while open, and Escape
  must close it and restore focus.
- **Status:** PASS
- **Implementation location:** `apps/web/src/components/MobileNav.tsx:102-120, 190, 205-263, 287-296`
- **Runtime evidence:** At 607px wide, clicked Menu:

```
aria-expanded false -> true;  sheet hidden -> false;  data-nav-open="true"
focus moved to: BUTTON "×Close menu"
role="dialog"  aria-modal="true"  aria-label="Menu"
tab stops inside (7): ×Close menu | 01 Learn | 02 Play | 03 Lab | 04 Legends | 05 Review |
                      theme radio (checked)
```

  Trap, both directions (dispatched `keydown`, exercising the component's handler):

```
Tab from LAST stop (checked radio "system")  -> activeElement = "×Close menu",  prevented=true
Shift+Tab from FIRST stop ("×Close menu")    -> activeElement = checked radio,  prevented=true
```

  Background-escape backstop — focused a control *outside* the sheet:

```
document.getElementById('glossary-search').focus()
after 120ms: activeElement = BUTTON "×Close menu"    escapedTrap: false
```

  Escape:

```
before: expanded "true",  hidden false,  active "×Close menu"
after:  expanded "false", hidden true,   active BUTTON "Menu",
        data-nav-open: null,  focusRestoredToMenuButton: true
```

- **Reviewer notes:** This is a correct hand-rolled trap, including the subtlety most get wrong:
  the tabbable set collapses a radio group to its checked member, so Tab from the theme radio
  wraps rather than walking onto the controls behind the sheet. My first forward-wrap test
  reported `prevented=false` because *I* used the naive tabbable set (all three radios) — the
  component was right and my test was wrong. The `focusin` backstop is real and works.
- **Missing work:** the background is not `inert` and carries no `aria-hidden`; the trap relies on
  `aria-modal="true"` plus the JS backstop. Screen readers that ignore `aria-modal` in browse
  mode can still read the page behind the sheet. Adding `inert` to `.prl-app` would make it
  declarative. P3.

## A11Y-007 Landmarks

- **Requirement (exact):** One `main`, named navigation landmarks, no duplicate unnamed landmarks.
- **Status:** PASS
- **Runtime evidence:** Measured per route; `/` at 1440:

```
mains: 1
header name="Site" | nav name="Primary" | main | footer | nav name="Sections"
```

  Every `<nav>` across the app carries a distinct accessible name (Primary, Sections, All
  sections, Jump to a letter, Scenario Lab, Sort hand history, Hand history pages, Legends
  navigation, Other legends screens, Other sections). Nested `<header>` elements are inside
  `<main>` and therefore map to `generic`, not a second `banner`.
- **Reviewer notes:** One theoretical `landmark-unique` collision: `not-found.tsx:85` names its
  nav "All sections", the same name the mobile sheet uses (`MobileNav.tsx:309`); they can only
  coexist on a 404 page with the menu open at a narrow viewport. `error.tsx:86` avoided it by
  using "Other sections". Cosmetic, P3.
- **Missing work:** none blocking.

## A11Y-008 Heading hierarchy

- **Requirement (exact):** Exactly one `h1` per page; no skipped heading levels.
- **Status:** PASS
- **Runtime evidence:** Computed the full heading sequence in DOM order on 12 routes and checked
  for `h1 count != 1` and any `prev -> prev+2` jump. **`headingProblems` was empty on all 12.**
  Examples:

```
/                 h1 A decision laboratory… | h2 What has been checked | h2 Three ways in |
                  h2 About Poker Risk Lab
/learn/pot-odds   h1 Pot odds… | h2 01 Two ways to write the same price | h3 The price of this
                  call ×3 | h2 02 Putting the two halves together | h2 03 What the price leaves
                  out | h2 What this lesson was for | h2 Terms this lesson uses |
                  h2 Reading the price | h3 Which of these describes break-even… |
                  h2 About Poker Risk Lab
/lab              h1 Scenario Lab | h2 Scenario 1..36 | h2 About Poker Risk Lab   (26 headings)
```

- **Reviewer notes:** My first `/lab` run showed only 2 headings because the scenario cards sit
  inside reveal wrappers whose *base* `opacity` is `0` (the animation supplies the painted value),
  so `checkVisibility({opacityProperty:true})` excluded them. Confirmed by screenshot that the 36
  cards are fully visible; corrected the gate and re-ran. Anyone auditing this app must not use
  `opacityProperty:true`.
- **Missing work:** none. (`/review` emits only an `h1` and no `h2`; every region there is
  landmark- or `<caption>`-labelled, so it is thin rather than wrong. P3.)

## A11Y-009 Accessible name on every control

- **Requirement (exact):** Every form control, button and link has an accessible name.
- **Status:** PASS
- **Runtime evidence:** On 12 routes I checked every visible `input`/`select`/`textarea` for
  `aria-label` | `aria-labelledby` | `<label for>` | wrapping `<label>`, and every visible
  `button`/`a[href]` for a non-empty name. **`unlabelled` was empty on all 12 routes.**
  Spot checks of the hardest cases:

```
range slider   label "Raise size slider" (visually hidden), aria-describedby ->
               "Allowed range 20 to 1,000 units. Presets are a fraction of the pot after your call."
action buttons aria-label "fold, costs 0 units, gives up the hand and any claim on the pot"
               aria-label "raise to 20 units, 20 units out of your stack"
presets        aria-pressed="true"/"false" (+ a ✓ glyph), so selection is not colour-only
quiz radios    wrapped in <label>, fieldset legend "Choose one answer"
difficulty     13×13 radio inside a 301×218 <label> — the label is the target
```

- **Missing work:** one silent tab stop — `apps/web/src/components/LiveCalculation.tsx:258`
  is a `tabIndex={0}` scroll container with no `aria-label`, unlike the two matching regions at
  `CoachPanel.tsx:406` and `review/page.tsx:349` which have one. P3.

## A11Y-010 Images, SVG and charts have text alternatives

- **Requirement (exact):** WCAG 1.1.1 — non-text content has a text alternative; charts are not
  the only carrier of their data.
- **Status:** PASS
- **Runtime evidence:** `/legends/vocal-aggressor`:

```
img elements: 0   (app-wide — there are no raster assets at all)
svg 1: aria-hidden="true"  focusable="false"          (decorative sigil)
svg 2: role="img"  aria-label="High-Variance Tournament Aggressor, sixteen trait axes.
                                Trait radar over 16 trai…"
visually-hidden <table> caption "High-Variance Tournament Aggressor, sixteen …", 16 rows,
  first row: ["01","Hands played","0.32"]
second <table> (visible) caption "Frequencies measured over 4,000 simulated ha…", 8 rows
```

- **Reviewer notes:** The radar chart ships the complete 16-axis dataset as a real
  visually-hidden `<table>` with `scope`d headers, always rendered — not a summary sentence
  pretending to be the data. Bar-style visuals elsewhere are `aria-hidden` with the number
  printed beside them, so nothing is announced twice.
- **Missing work:** none.

## A11Y-011 ARIA correctness

- **Requirement (exact):** ARIA roles, attributes and values are valid and allowed.
- **Status:** PASS
- **Runtime evidence:** `node scripts/a11y-audit.mjs --no-start --base-url http://127.0.0.1:3200
  --api-url http://127.0.0.1:3201 --crawl-depth 2 --max-routes 40`:

```
Summary
  routes audited      40
  violations          0
PASS — no violation of the checked rules.
```

  Rules include `aria-roles`, `aria-valid-attr`, `aria-allowed-attr`, `aria-valid-attr-value`,
  `aria-required-attr`, `aria-hidden-focus`, `duplicate-id-aria`, `tabindex`,
  `landmark-one-main`, `landmark-unique`, `heading-order`, `page-has-heading-one`, `label`,
  `button-name`, `link-name`, `select-name`, `image-alt`, `frame-title`, `list`.
  I corroborated live: `role="dialog"`+`aria-modal`, `role="img"`+`aria-label` on cards,
  `role="status"`, `aria-current="step"`/`"page"`, `aria-pressed`, `aria-expanded`+`aria-controls`
  all resolve correctly in the running DOM.
- **Reviewer notes:** The repo's script is a *static* audit of server-rendered HTML and is candid
  about it; I treat its 0 violations as corroboration, not proof. The live checks are the proof.
- **Missing work:** none.

## A11Y-012 Live regions for dynamic updates (including the Coach)

- **Requirement (exact):** WCAG 4.1.3 — status messages must be programmatically determinable
  without receiving focus. Dynamic Coach updates must be announced.
- **Status:** PARTIAL
- **Implementation location:** `packages/ui/src/components/CoachPanel.tsx` (no live region),
  `apps/web/src/lib/use-live-table.ts:158-183, 283-291` (`announce()` has no `coach` case),
  `apps/web/src/components/TableStage.tsx:261-268` (unannounced error)
- **Runtime evidence — what works:** table events, quiz verdicts, scenario reveal, timeline steps,
  filter counts and every `Metric` count-up all announce (quoted in UX-003/004/005/006).
- **Runtime evidence — what does not.** With the API stopped and the "table could not be
  prepared" error on screen, I enumerated every live region on the page and walked the error
  node's ancestors:

```
liveRegions on the page: [ { role:"status", text:"Ready to connect." } ]
error node ancestor chain:
  P.prl-error__title -> DIV.prl-error -> DIV.prl-play__table -> DIV.prl-play__main ->
  DIV.prl-play__stage -> DIV.prl-play -> MAIN.prl-app__main -> DIV.prl-app -> BODY
anyLiveAncestor: false
```

  So a screen-reader user is told **"Ready to connect."** while the screen says *"The table could
  not be prepared / ERROR — TABLE UNAVAILABLE / No controls while the table is unreachable."*

  Separately, the Coach panel itself is not in a live region:

```
coachFound:true  coachClass:"prl-coach"  coachHeading:"Coach analysis"
coachInsideLiveRegion:false
liveRegionsInsideCoach: [ "Your share of the pot: 23.1 % ± 1.83 points",
                          "Expected value of that line: 19.5 units" ]
```

  Its two numbers have atomic live regions, but nothing announces that the analysis *arrived* or
  *changed*. Below 600px the Coach is a collapsed bottom sheet, so its arrival is both silent and
  off-screen.
- **Test covering it:** NONE.
- **Reviewer notes:** **This is my hardest-hitting finding.** The error case is a clear WCAG 2.2
  SC 4.1.3 (Status Messages, AA) failure, and it is worse than a plain omission because the one
  region that *does* speak is actively contradicting the screen. The same page proves the team
  knows the pattern — `ScenarioStage.tsx:395-397` announces "The analysis for … is now shown
  below your decision." for the identical event on the Lab page. Related unannounced errors:
  `QuizRunner.tsx:219,233`, `LiveCalculation.tsx:336`, and the `coachProblem` path at
  `use-live-table.ts:319-324`.
- **Missing work:** give `DIV.prl-error` in `TableStage` `role="alert"`; add a `coach` case to
  `announce()` in `use-live-table.ts` (and a failure case for `coachProblem`); apply `role="alert"`
  consistently to the other silent error states listed above.

## A11Y-013 Form error association

- **Requirement (exact):** WCAG 3.3.1 — an input error is identified and programmatically
  associated with its field.
- **Status:** PARTIAL
- **Implementation location:** `apps/web/src/components/QuizRunner.tsx:269-276`,
  `packages/ui/src/components/ActionBar.tsx:200-213`
- **Runtime evidence:** `aria-invalid` does not appear anywhere in `apps/web/src` or
  `packages/ui/src` (zero occurrences). The quiz numeric field announces its verdict in a polite
  live region but the `<input>` carries no `aria-invalid` and its `aria-describedby` points at the
  tolerance hint, not the result — a reader who tabs back to the field hears no indication their
  value was rejected. The bet-amount `number` input silently re-clamps an out-of-range value on
  blur with no `aria-invalid` and no announcement of the correction.
- **Reviewer notes:** Genuinely mitigated rather than ignored — every field is labelled, every
  bound is in an `aria-describedby` sentence, and the verdict is announced once. The gap is
  persistence: the association does not survive the announcement.
- **Missing work:** set `aria-invalid` and point `aria-describedby` at the verdict/correction for
  the two fields above.

## A11Y-014 Card accessibility — rank + suit, never colour alone

- **Requirement (exact):** A playing card must be perceivable without colour; a screen reader must
  announce rank and suit. Verify the real accessible name in the DOM, not the visual glyph.
- **Status:** PASS
- **Implementation location:** `packages/ui/src/components/PlayingCard.tsx:114,124,138-146`,
  `packages/ui/src/cards.ts:121`, `packages/ui/src/components/CardRow.tsx:74-77`,
  `packages/ui/src/styles/components.css:2126-2159`
- **Runtime evidence — from a live server-dealt hand**, not a fixture:

```
14 .prl-card elements after dealing; accessible names read off the DOM:
  ["face-down card" ×10, "five of clubs", "eight of hearts", "five of clubs", "eight of hearts"]

group names come from <figure> + visually-hidden <figcaption>:
  "community cards: none dealt yet"
  "Patient Technician hole cards"     "Calling Station hole cards"
  "Reading Pressure hole cards"       "Disciplined Specialist hole cards"

actual markup of a face-down card:
  <span class="prl-card prl-card--sm prl-card--face-down" role="img" aria-label="face-down card">
    <span class="prl-card__back" aria-hidden="true"></span></span>
```

  And independently from the real hand-history table on `/review`:

```
["eight of spades","ten of clubs","three of diamonds","ace of hearts","ace of diamonds",
 "ten of diamonds"]
table caption "6 hands, ordered by most recent first…"; th[scope=col]:
 ["Hand","When","Board","Pot","Net to you","Ending"]
```

  Colour is not the only suit cue: each card face renders rank + suit **symbol** + suit **letter**
  (`d/h/c/s`), visible in the extracted page text as `K ♦ d  7 ♥ h  2 ♥ h  10 ♠ s  3 ♦ d`, with
  the whole face `aria-hidden="true"` so the reader hears only the label.
- **Reviewer notes:** This is the requirement I expected to fail and it is the best-implemented
  thing in the app. Face-down cards leak nothing — the card integer never reaches the DOM. Three
  redundant encodings (symbol, letter, colour) mean protanopia and forced-colors both survive.
- **Missing work:** none. (Cosmetic: `review/page.tsx:234-242` renders board cards loose in a
  `<td>` rather than a named `CardRow`, so the group has no "board" prefix; the `<th scope="col">Board</th>`
  supplies it via table semantics.)

## A11Y-015 Contrast in both themes, measured on what is rendered

- **Requirement (exact):** WCAG 1.4.3 — 4.5:1 for normal text, 3:1 for large text, in both themes.
- **Status:** PASS
- **Runtime evidence — repo script:**

```
node scripts/check-contrast.mjs
  PASS  token layer  (tokens.css)
  PASS  rendered layer  (tokens.css + base.css)
  Every claimed ratio holds, in both themes, in both passes.
  suit-spade 17.79/14.25  suit-heart 7.25/5.81  suit-diamond 7.68/6.15  suit-club 8.18/6.55
  text-on-accent 6.97 across the accent ramp; "picked the better ink"
```

  **Rendered-pixel check I ran independently:** for every text-bearing element I resolved the
  actual painted foreground (compositing `rgba`) against the nearest opaque ancestor background,
  including `::before`/`::after` fill layers, and applied the correct threshold for the element's
  computed font size and weight:

```
LIGHT theme   /  n=121 fail=0     /learn n=304 fail=0    /lab n=375 fail=0
              /play n=53 fail=0   /review n=149 fail=0   /legends n=881 fail=0
              /learn/glossary n=869 fail=0   /legends/hand-review n=394 fail=0
              /learn/pot-odds n=197 fail=0   /review/hand-0042 n=58 fail=0
DARK theme    identical route set, identical counts, fail=0 on all 10
```

  Focus-indicator contrast 10.5:1 (SC 1.4.11 needs 3:1).
- **Reviewer notes:** Two false-positive classes I had to eliminate before this could be trusted,
  both of which would have produced fabricated failures: (1) reading computed colour within
  ~900ms of a theme switch returns mid-transition values — that alone produced 13 phantom dark
  failures including "invisible" button text that a screenshot proved was perfectly legible;
  (2) primary buttons have `background-color: transparent` and paint their fill from a `::before`
  layer (`rgb(23,198,219)`), so a naive background walker attributes dark ink to the dark page and
  reports 1.13:1 — the true ink-on-accent ratio is **9.39:1**. Only one element ever flagged
  legitimately: the quiz **Previous** button at 2.6:1, and it is `disabled` (verified
  `button.disabled === true`), which WCAG 1.4.3 exempts.
- **Missing work:** none.

## A11Y-016 Reduced motion respected

- **Requirement (exact):** With `prefers-reduced-motion: reduce`, animation must actually stop —
  including JavaScript-driven motion.
- **Status:** PARTIAL
- **Implementation location:** `packages/ui/src/styles/tokens.css:507-517`,
  `packages/ui/src/styles/base.css:496-508`, `packages/ui/src/styles/reset.css:49-53`,
  `packages/ui/src/motion/usePrefersReducedMotion.ts`
- **Runtime evidence:** I could not set the OS preference (changing system settings is out of
  scope) and this toolchain exposes no media emulation, so I verified the **shipped CSS** by
  walking the live CSSOM rather than the source files:

```
reducedMotionMediaBlocks: 7   (in the stylesheets actually loaded by the running app)
declarations found inside them:
  :root                     --prl-dur-instant,--prl-dur-quick,--prl-dur-in,--prl-dur-out,
                            --prl-dur-reveal,--prl-dur-count
  html                      scroll-behavior
  *, ::before, ::after      transition-duration,transition-delay,animation-duration,
                            animation-iteration-count,animation-delay
  .prl-turn-ring            --prl-turn-progress, animation-name
  .prl-reveal[data-revealed="false"]  opacity, animation-*
  .prl-skeleton::after      display
  .prl-boot                 display

universal backstop, exact computed declarations:
  "*, ::before, ::after" {
    transition-duration: 1ms !important;   transition-delay: 0s !important;
    animation-duration: 1ms !important;    animation-iteration-count: 1 !important;
    animation-delay: 0s !important; }

hardcoded durations outside a reduced-motion block: 0
matchMedia('(prefers-reduced-motion: reduce)').matches: false  (this machine)
```

- **Reviewer notes:** The CSS side is airtight and I can say so from the shipped bytes: the
  `!important` universal backstop overrides every transition and animation in the app regardless
  of what any other rule declares, so no future CSS edit can regress it. `scroll-behavior: smooth`
  is opt-in under `no-preference` rather than opt-out, which cannot regress either. What I could
  **not** verify is the JavaScript path — `useCountUp`, `useReveal` and `BootSequence` consult
  `usePrefersReducedMotion`, and CSS media queries do not stop `requestAnimationFrame`. The hook
  subscribes to a module-level `MediaQueryList` I cannot reach from the page to fire a synthetic
  `change` at, and the app's JS runs before I can patch `matchMedia` on a fresh document.
- **Missing work:** verify the three JS animation drivers under emulated
  `prefers-reduced-motion: reduce` (trivial in Playwright: `browser.newContext({reducedMotion:'reduce'})`).
  Nothing observed suggests a defect; it is simply untested here.

## A11Y-017 Focus not obscured (WCAG 2.2 SC 2.4.11, AA)

- **Requirement (exact):** When a component receives keyboard focus it must not be *entirely*
  hidden by author-created content.
- **Status:** PASS
- **Runtime evidence:** Tested against the worst case in the app — the `/play` primary CTA that
  *is* covered by the fixed Coach sheet at rest (UX-002), at 375×667:

```
scrollTo(0); button covered by BUTTON.prl-play__handle
button.focus()
  scrollYAfterFocus: 311        focusedIsButton: true
  btnRect [37,315,159,44]       coach sheet top: 599      viewport 663
  15 sample points across the button, all return the BUTTON
  pointsShowingButton: 15/15    entirelyHidden: false
```

- **Reviewer notes:** Focusing scrolls the control clear of the sticky sheet, so the pointer-level
  occlusion in UX-002 does not become an SC 2.4.11 failure. Worth stating explicitly because the
  two look like the same defect and are not.
- **Missing work:** none.

## A11Y-018 Target size minimum (WCAG 2.2 SC 2.5.8, AA)

- **Requirement (exact):** Targets are at least 24×24 CSS px unless an exception applies.
- **Status:** PASS
- **Runtime evidence:** At 375×667, excluding inline links in prose (SC 2.5.8 inline exception):

```
/ targets=10 under24=0        /learn targets=32 under24=0      /lab targets=12 under24=0
/play targets=11 under24=0    /learn/glossary targets=367 under24=0
/review targets=15 under24=6  /legends targets=38 under24=3
```

  Both flagged sets resolve to exceptions on inspection:

```
/review  A.prl-review-table__link "Replay hand 2"  11x44,  nearest other target 25px
         -> Spacing exception: a 24px-diameter circle on each undersized target does not
            intersect another target (needs >=24px; measured 25px)
/legends INPUT[radio].prl-legend-difficulty__control 13x13, wrappedInLabel:true,
         label 301x218  -> the label is the target
         INPUT[radio].prl-theme__input 1x44, label 72x38 -> the label is the target
```

- **Reviewer notes:** Passes, but the `/review` hand links clear the spacing exception by exactly
  1px (25 vs 24 required). Any future row-density change breaks SC 2.5.8 there. P3.
- **Missing work:** widen the hand-number link's hit area (e.g. make the whole row cell the target).

---

## Counts

31 requirements total (UX-001…UX-013, A11Y-001…A11Y-018).

| Status | Count |
|---|---|
| PASS | 24 |
| FAIL | 0 |
| PARTIAL | 7 |
| UNVERIFIED | 0 |
| N/A | 0 |

PARTIAL: UX-002, UX-012, A11Y-001, A11Y-002, A11Y-012, A11Y-013, A11Y-016.
(A11Y-012 carries two distinct defects — the unannounced table error and the unannounced Coach
arrival — and is counted once.)

No requirement is marked FAIL. That is not a clean bill of health: A11Y-012 contains a genuine
WCAG 2.2 AA failure (SC 4.1.3) that is P1, and it is recorded as PARTIAL only because the other
half of the same requirement — announcing ordinary table and quiz state changes — demonstrably
works. Read the severity list, not the status counts.

## Issues by severity

### P0 — security / correctness / release catastrophe
None found in the frontend or accessibility scope.

### P1 — required feature broken or missing
1. **The `/play` table-error state is invisible to screen readers, and the only live region
   contradicts it.** `DIV.prl-error` ("The table could not be prepared") has no `role="alert"` and
   no live-region ancestor (`anyLiveAncestor: false`), while the page's sole `role="status"`
   announces "Ready to connect." WCAG 2.2 SC 4.1.3 (AA) failure on the app's most consequential
   error path. Fix: `role="alert"` on `TableStage.tsx:261-268`.
   *(A11Y-012)*

### P2 — significant quality gap
2. **Coach arrival/refresh is never announced on `/play`.** `CoachPanel` sits in no live region;
   `announce()` in `use-live-table.ts:158-183` has no `coach` case and the reducer at `:283-291`
   never sets `announcement`; the failure path `coachProblem` (`:319-324`) is equally silent.
   Below 600px the panel is also a collapsed off-screen sheet. `ScenarioStage.tsx:395-397` already
   does this correctly for the same event. *(A11Y-012)*
3. **Keyboard traversal is not proven end-to-end.** 728 focusable elements across 12 routes all
   accept focus and all render a focus ring, and every custom key handler works, but no real
   Tab keypress was possible in this environment. One Playwright keyboard-traversal test would
   close this. *(A11Y-001, A11Y-002)*
4. **Reduced motion is proven for CSS but not for the three JS animation drivers**
   (`useCountUp`, `useReveal`, `BootSequence`). CSS side is airtight via a verified `!important`
   universal backstop in the shipped stylesheet. *(A11Y-016)*
5. **`/play` mobile: the fixed Coach sheet covers the primary CTA at the initial scroll position**
   and the page reserves no bottom padding for it, so content at the document's end sits
   permanently underneath. Recoverable by scrolling; not a WCAG failure. *(UX-002)*

### P3 — polish
6. `aria-invalid` is used nowhere; the quiz numeric field and the bet-amount field announce or
   silently clamp without marking the field. *(A11Y-013)*
7. Console error `[api] GET /api/v1/hands/... → 404 … a 404 here is a client bug` is logged at
   **error** level on an expected no-history path that the app then handles correctly. *(UX-012)*
8. Console error `Encountered a script tag while rendering React component` from the pre-paint
   theme boot script in `apps/web/src/app/layout.tsx`. *(UX-012)*
9. Deep-linking a dynamic scenario id during an API outage returns **404** rather than
   "temporarily unavailable", misattributing an outage to a bad URL. *(UX-010)*
10. `MobileNav` background is not `inert`/`aria-hidden`; the trap relies on `aria-modal` plus a
    `focusin` backstop. *(A11Y-006)*
11. `LiveCalculation.tsx:258` is a `tabIndex={0}` scroll container with no `aria-label` — a silent
    tab stop, inconsistent with the two sibling regions that have one. *(A11Y-009)*
12. `/review` hand links clear SC 2.5.8's spacing exception by 1px (25 vs 24). *(A11Y-018)*
13. `not-found.tsx:85` names its nav "All sections", colliding with `MobileNav.tsx:309` on a 404
    page with the menu open. *(A11Y-007)*
14. `/review` emits only an `h1` and no `h2`. *(A11Y-008)*
15. `<main id="prl-main">` has no `tabIndex={-1}` (skip-link target relies on browser
    sequential-focus repositioning). *(A11Y-005)*
16. Board cards in the `/review` table are loose `PlayingCard`s rather than a named `CardRow`.
    *(A11Y-014)*

## False positives I chased down and did NOT report

Recorded because each would have been a plausible-looking finding and each is wrong:

- The `?state=` links inside the **closed** `<details>` on `/play` report stale layout rects under
  the footer. Chrome hides them correctly: `checkVisibility() === false` and `el.focus()` refuses.
- The 36 `/lab` scenario links compute `outline: none` on focus; the ring is moved to the parent
  card via `:has(.prl-lab-card__link:focus-visible)` — measured `none 3px` → `solid 2px`.
- 13 "dark theme contrast failures" were mid-theme-transition computed colours; a screenshot
  showed the text perfectly legible and a re-measure after settling showed 0 failures.
- Primary buttons appear to be dark-on-dark at 1.13:1 because their fill is a `::before` layer;
  the true ratio is 9.39:1.
- "No focus ring anywhere" appears whenever the Chrome window lacks OS focus, because `:focus`
  stops matching while `document.activeElement` still reports correctly.
- "Route change is never announced" — Next's `next-route-announcer` keeps its text in a
  **shadow root**; `textContent` on the host is empty, `shadowRoot.textContent` says "Scenario Lab".
- `/lab` "only 2 headings" and many "invisible" controls — reveal wrappers have base `opacity: 0`
  with the animation supplying the painted value, so `checkVisibility({opacityProperty:true})`
  under-reports.
- "Clicking Open the table does nothing" / "the quiz radio is dead" — both were tooling artefacts
  (stale `ref` after re-render; layout drift between measure and click). Both controls work.

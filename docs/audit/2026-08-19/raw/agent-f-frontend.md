# Reviewer F — Frontend & Accessibility (independent)

**Date:** 2026-08-19  
**HEAD:** `f20bbad`  
**Workspace:** `/Users/terence/Projects/exploration-sites/poker-risk-lab`  
**Role:** Frontend & Accessibility auditor. Did not build this. Did not modify source.

## How this was evidenced (and what was not)

This audit does **not** trust prior UX/a11y PASS claims. Evidence came from:

| Method | What it actually covers |
| --- | --- |
| `pnpm run design:contrast` (`node scripts/check-contrast.mjs`) | WCAG 2.x ratios **from `tokens.css` + `base.css`**, both themes, two passes. **Not** computed styles of a live DOM. |
| `node scripts/a11y-audit.mjs --no-start` against `http://127.0.0.1:4300` | Static markup subset of axe-core 4.13.0. Script header is honest: **no contrast, no focus order, no keyboard, no CSS visibility, no hydrated-only controls**. |
| Fetched HTML | Home, Learn, lesson `/learn/hand-flow`, glossary, Play live + `?state=loading\|error\|decision\|complete`, Lab index (36 live scenarios), scenario `/lab/eq-flush-draw-turn-small-bet`, Legends index/profile/compare/hand-review, Review index + `/review/hand-0042`, Record, unmatched 404, `notFound()` ids. |
| Stylesheet + component inspection | Overflow, sticky/fixed, focus, reduced-motion, cards, slider, Coach, nav, theme. |
| **Not done** | Real browser (no Playwright/Puppeteer in this repo). **No Tab, no `elementFromPoint`, no computed overflow, no console, no screen reader, no 375/768/1440 paint.** |

Servers started for this audit (and only these): API `PORT=4301` at `http://127.0.0.1:4301` (`GET /api/v1/health` → `200 {"status":"ok"}`); web `next start --port 4300` with `PRL_API_ORIGIN=http://127.0.0.1:4301`. An unrelated `next dev` already occupied `:4100`; it was not used and not killed.

**`test:a11y` overclaim:** a passing run means “no violation of the *checked subset* in *2xx HTML*”. It **skips 404s** (so the worst error pages are invisible to the gate). It does not mean the app is accessible.

---

## Requirement table

Verdicts: **PASS** = proven by rendered HTML/CSS/script; **PARTIAL** = real evidence, incomplete or mixed; **FAIL** = proven defect; **UNVERIFIED** = cannot be proven without a browser or other missing runtime.

| ID | Verdict | Evidence (short) |
| --- | --- | --- |
| UX-001 | **PARTIAL** | Containers are `min(100% - gutters, 88rem)`; cards wrap; play column `min-width: 0`; no `100vw`. **No live overflow measurement at 375 / 768 / 1440.** CSS risks: units disclosure `width: max-content; max-width: 60ch` (`nav.css`); desktop nav `flex-wrap: nowrap` + `white-space: nowrap` without `min-width: 0` on the nav column. |
| UX-002 | **PARTIAL** | `.prl-play__decision` is in flow (no `sticky`/`fixed`) — `packages/ui/test/layout-guarantees.test.ts` asserts the rule, not a hit-test. Mobile Coach is `position: fixed` with a 4rem peek; `scroll-padding-block-end` is set on `:root:has(.prl-play)`. Coach drops under the nav sheet via `:root[data-nav-open="true"]`. **Occlusion unproven without `elementFromPoint`.** |
| UX-003 | **PASS** | `/` → `/learn` (17 live lessons, 200) → `/learn/hand-flow` (lesson body + quiz `01 / 04`, radios, Check control) → glossary. |
| UX-004 | **PASS** | `/lab` rendered **36 live scenarios** (not the six-item fixture). Scenario page: assumptions **before** “Your decision”; `ActionBar` present; analysis not in the first HTML (revealed after commit — pedagogy). |
| UX-005 | **PARTIAL** | `/play` is `LiveTable` (“Open the table”, no silent fixture). Fixture states `?state=*` are labelled **“Fixture — no server is connected”**. `?state=decision` has table + ActionBar + Coach. Live WS/hand **not played**. |
| UX-006 | **PASS** | `/review` signed-out fixture, labelled. `/review/hand-0042` 200: “Hand 42”, timeline, Coach, “Check the deal yourself”, polite live regions. `/review/not-a-real-hand` 200 “This replay needs a session” (honest, not a fake 404). |
| UX-007 | **PARTIAL** | Index (12 profiles, live), profile detail, compare (live, no fixture banner), `/legends/hand-review`. Hand-review **always** bundled sample: *“Per-hand comparison against a Legend profile is not served by the API yet”*. |
| UX-008 | **FAIL** | Unmatched URL `/does-not-exist` → **404** with full shell, `h1` “Page not found”, five destinations. **`notFound()` from a page** (`/learn/not-a-real-lesson`, `/lab/not-a-real-scenario`, `/legends/not-a-real-profile`) → **404** with `<html id="__next_error__">`, **no `lang`**, **no `<main>`**, **no `h1`**, **no links**. Documented in `not-found.tsx` (Next 16 RSC empty body). API-down paths that *do* render are labelled fixtures (not silent). |
| UX-009 | **PASS** | `?state=loading` skeletons; Lab empty-filter copy + “Clear all filters”; Review empty state; Record signed-out callout (“no anonymous version… empty one would look like a record of having done nothing”); Coach “no outs count for this spot”. |
| UX-010 | **PASS** (with residual risk) | Live lab/learn/legends from API. Fixtures labelled. Record refuses zeros. Units unknown state exists in code. **No `160%` in fetched Coach HTML.** Residual: some percent formatters still unguarded (see Probability). |
| UX-011 | **PARTIAL** | Primary controls have `href`/`onClick`/native form. Fixture ActionBar records “decision was not applied”. Cannot click-prove every control. |
| UX-012 | **UNVERIFIED** | No browser console. |
| UX-013 | **PARTIAL** | Three radios Auto/Light/Dark in **footer** (every page) and **mobile sheet**. **Not in the header.** `SiteHeader` comment: removed for width. Works; discoverability on desktop requires scrolling to the footer. |
| UX-014 | **PARTIAL** | 13-step graphite, one cyan accent, **zero `box-shadow` declarations** (grep hits comments only), hairlines, technical labels, metric type, table is slate graph paper (not felt). **Chamfer removed from primary CTA** (`components.css` ~624–640); seats still chamfered. Design-system doc still says “chamfered CTA”. No casino gold/neon. |
| UX-015 | **PARTIAL** | Five destinations from `NAV_DESTINATIONS` in header pill, sheet, footer, 404. Play is an accent CTA, not a pill link. `aria-current="page"`. Brand wordmark **CSS-hidden** `<600px` and `860–1279px`. |
| UX-016 | **PARTIAL** | Table: container query 46rem oval vs stacked; opponents wrap not scroll; HUD hidden when stacked plate already shows hole cards. **Not device-tested.** |
| UX-017 | **PASS** (fixture HTML) / live **UNVERIFIED** | Fixture Coach: equity + method chip, price, assumptions list **not inside `<details>`**, five disclosures for EV/outs/notes. Suggestion not called “correct/GTO”. Live Coach not opened over WS. |
| UX-018 | **PARTIAL** | `tokens.css` collapses durations; `base.css` `!important` 1ms backstop; boot `display:none` under `prefers-reduced-motion` and `scripting: none`; `usePrefersReducedMotion`; count-up contract in `Metric`. **Not runtime-tested with the media query.** |
| UX-019 | **PARTIAL** | No UI `TODO` / `lorem` / “coming soon”. Input `placeholder=` only (glossary search, invite code). **User-facing unfinished:** Legends hand-review “not served by the API yet”. |
| A11Y-001 | **UNVERIFIED** | Did not press Tab in a real browser. Code/HTML show native controls, skip link, roving timeline, radio groups. |
| A11Y-002 | **PARTIAL** | `MobileNav` Tab cycles **tabbable** set (radio group = one stop) + `focusin` pull-back + Escape. **Not keyboard-verified.** No other `<dialog>` besides the sheet. GlossaryTerm is a disclosure, not a trap. |
| A11Y-003 | **PARTIAL** | `:focus-visible { outline: var(--prl-focus-width) solid var(--prl-focus-color) }` in `base.css`. Theme radios paint the ring on the sibling word. `:focus:not(:focus-visible) { outline: none }` is the only removal. **Not visually confirmed.** |
| A11Y-004 | **PARTIAL** | Skip → header → main → footer. ActionBar sizer **before** fold/call/raise. Scenario assumptions before decision. DOM vs visual `order` on the table is documented as safe because seats are not focusable. |
| A11Y-005 | **FAIL** | No route-change live region / focus move to `h1`. `error.tsx` explicitly does not move focus. Relies on Next title + browser. `notFound()` first paint has **no `h1` to announce**. |
| A11Y-006 | **PARTIAL** | Sheet `role="dialog"` `aria-modal="true"`; Escape; focus to Close; return to trigger; resize ≥860 closes + unlocks scroll. **Not keyboard-verified.** |
| A11Y-007 | **FAIL** on `notFound()`; **PASS** on 2xx | 2xx: `lang=en`, skip, one `<main id="prl-main">`, named `<header aria-label="Site">`, unique nav names (`Primary` / `All sections` / `Sections`), footer. `notFound()` HTML: no `lang`, no `main`, empty body. Static a11y gate **does not audit 404s**. |
| A11Y-008 | **FAIL** on `notFound()`; **PASS** on 2xx | All fetched 2xx pages: one `h1`, no skipped levels. `notFound()`: **zero headings**. |
| A11Y-009 | **FAIL** (brand, some widths); else **PASS** | Static audit 0 `button-name`/`link-name` on 20 2xx routes. Brand: `00` is `aria-hidden`; `.prl-pillbar__brand .prl-shell__brand-name { display: none }` by default and again at `min-width: 860px` until `1280px`. **`display: none` removes the name from the a11y tree → unnamed home link at 375 and laptop-but-not-wide.** Sheet close has visually-hidden “Close menu”. |
| A11Y-010 | **PASS** | Cards `role="img"` + spoken name (`ace of hearts`, `face-down card`). Radar `role="img"` + hidden table (component). Fetched `/play?state=decision`: 24 `role="img"` card names. |
| A11Y-011 | **PASS** (static subset) | 20 2xx routes, **0 violations**. Legends pages reported 1–12 unchecked `aria-*` on undetermined roles (script limitation, not a pass). |
| A11Y-012 | **PARTIAL** | `PokerTable` polite live region; play error `role="alert"` (error fixture confirmed); connection `role="status"`; `Metric` polite atomic; quiz verdict polite; filters `role="status"`. **Not SR-tested.** Review hand had **8** `aria-live="polite"` (noisy). |
| A11Y-013 | **PARTIAL** | Quiz numeric: `label` + `aria-invalid` + `aria-describedby` to error then hint. Sizer: `aria-invalid` + bounds `aria-describedby`. Join-code wiring in `LiveTable`. **Not interactively triggered.** |
| A11Y-014 | **PASS** | Rank + pip + **suit letter** (`c/d/h/s`) + four-colour tokens + `aria-label`. Colour is never the only cue. |
| A11Y-015 | **PASS** (token/rendered layers) | `design:contrast` **PASS** both themes, both passes. Worst AA body: dark faint 4.80:1 on active; light muted/faint 4.94:1 on active. Suits ≥4.90:1. Text-on-accent: dark ink-900 9.39:1; light white 6.97:1. Light scopes in sync (33 decls). **Not live `getComputedStyle`.** |
| A11Y-016 | **PARTIAL** | See UX-018. Reveals default-visible if JS never runs (`[data-revealed=false]` deadline). |
| A11Y-017 | **PARTIAL** | `scroll-padding-block-start` from pillbar height; play mobile `scroll-padding-block-end`. Sticky header is opaque. Units popover is `position: absolute` and can extend past the viewport. **Not 2.4.11 hit-tested.** |
| A11Y-018 | **PARTIAL** | `--prl-target-min: 44px` on buttons, inputs, units toggle, timeline markers, nav links, handle. WCAG floor is 24. **Not measured in a browser.** |
| A11Y-019 | **PASS** | `/play?state=decision` HTML: **one `type="range"` and one `type="number"`**, shared bounds, presets. Only slider in the UI package. |
| A11Y-020 | **PASS** (authoring) | Net: sign + “gained/lost/level”. Clean/dirty: solid vs 45° hatch + words + counts. Current nav: fill **and** weight **and** `aria-current`. Deltas: glyph + sign + words. **Not CVD-tested.** |

### Impossible probability rendering (must recheck)

| Surface | Guard? | Fetched evidence |
| --- | --- | --- |
| `CoachPanel` / `EquityBar` / `UncertaintyNote` | **Yes** — `formatProbability` / `isProbabilityFraction`; refuse with `not a probability` (value not printed) | `/play?state=decision` percents `54.1`, `45.9`, `33.3`, `95` — none >100; no `160`; no refusal (inputs were legal). |
| `PostHandComparison` | **No** — `Metric format="percent"` and `formatPercent(breakEvenEquity)` | `/legends/hand-review` percents all ≤95. Residual defect if a bad report arrives. |
| `LiveCalculation` EV terms | **No** — `formatPercent(term.probability)` | Lesson page had no >100% strings. |
| `ActionDistribution` | **No** — formats whatever it is given; **does** warn if weights do not sum to 1 | Compare page live. |
| Legends profile table | **No** — `formatPercent(row.value)` on 0..1 traits | Profile page: `32.0% ± 1.5` etc., none >100. |

**Verdict:** the original 160% Coach bug is **closed on the Coach render path** (code + tests + fetched fixture). It is **not closed for every percent on screen**.

---

## Viewport notes (375 / 768 / 1440)

**No real viewport paint.** The following is CSS/DOM architecture, marked proven vs UNVERIFIED.

| Width | Proven from CSS/HTML | UNVERIFIED |
| --- | --- | --- |
| **375** | Header: `00` mark + units + Menu (name `display:none`). Sheet nav. Play: Coach **fixed** bottom peek `--prl-space-12` (4rem) + `scroll-padding-block-end`. Table stacked. Cards wrap. | Actual `document.documentElement.scrollWidth`, Coach peek occluding Fold/Call, units `i` panel overflowing 60ch, 44px targets with finger. |
| **768** | `600–859`: brand **name shown** (including “Lab”). Still sheet nav. Play: Coach becomes in-flow panel (`position: static` ≥600). | Horizontal scroll of nowrap… N/A (nav is sheet). Table still stacked. |
| **860–1279** | Desktop pill nav **nowrap** + Play CTA + units; **brand name hidden again**. Grid `auto 1fr auto`. | **Highest overflow risk:** min-content of nowrap pill vs ~792px container at 860. |
| **1440** | Brand name shown ≥1280. Coach **sticky** 22rem rail. Decision band in flow; `@container prl-play-column (min-width: 46rem)` puts HUD beside controls. | Hit-test that the band does not cover pot/board/seats; “field + band on one screen”. |

Play.css comments cite Chrome `elementFromPoint` numbers. Those are **author measurements, not this audit**.

---

## Placeholder / unfinished inventory

| Location | What | User-facing? |
| --- | --- | --- |
| `GlossaryBrowser` `placeholder="equity, alpha, SPR…"` | Search hint | Yes — legitimate `placeholder`, not a page stub |
| `LiveTable` invite `placeholder={INVITE_CODE_EXAMPLE}` | Field hint | Yes — hint |
| `/legends/hand-review` | Always `HAND_COMPARISON_FIXTURE`; copy **“not served by the API yet”** | **Yes — unfinished feature, labelled** |
| Play `?state=*` | Typed fixtures for audit | Yes — labelled “Fixture — no server” |
| Review when signed out | Fixture rows + “Fixture data” | Yes — labelled |
| Record when signed out | No fake zeros; callout | Honest empty |
| Source comments (`TODO` in grep) | None in `apps/web`/`packages/ui` TSX except “placeholder” as *technical* wording | No |
| `lorem` / “coming soon” | **None** in web/ui source | — |

Home metrics fetched live: **133,784,560** hands, **36** scenarios, **12** profiles — matches `/lab` card count and `/legends` grid. Not decorative vanity stats.

---

## P0–P3 findings

### P0

1. **`notFound()` pages are not pages.**  
   Fetched `/learn/not-a-real-lesson`, `/lab/not-a-real-scenario`, `/legends/not-a-real-profile`: HTTP **404**, `<html id="__next_error__">` **without `lang`**, no `<main>`, no `h1`, no navigation, no skip target. `test:a11y` **refuses to audit 404s**, so the gate stays green. Unmatched `/does-not-exist` **does** render the real 404. Product already documents this in `apps/web/src/app/not-found.tsx`. Breaks UX-008, A11Y-007, A11Y-008, A11Y-005, and JS-off readability for bad ids.

### P1

2. **Home/brand control has no accessible name at 375 and at 860–1279.**  
   `00` is `aria-hidden`; product name is `display: none` in those ranges (`apps/web/src/styles/nav.css`). WCAG 4.1.2 / axe `link-name`. Static audit missed it because it does not apply CSS.

3. **Units “i” disclosure can overflow the 375 viewport.**  
   `nav.css`: `.prl-shell__units .prl-units__note { width: max-content; max-width: var(--prl-measure); }` with `--prl-measure: 60ch` (~page-width on a phone, *larger* than 375). Absolutely positioned; parent does not clip. UX-001 / A11Y-017 risk when the only on-bar explanation is opened.

4. **Percent UI guards are Coach-scoped, not app-scoped.**  
   `PostHandComparison`, `LiveCalculation` EV table, `ActionDistribution`, legends profile `formatPercent` still format raw fractions. A stale `1.6` would print **160.0%** on those surfaces. Coach path is defended.

### P2

5. **Theme switching is missing from the header** (footer + sheet only). UX-013 incomplete vs “every primary control in the chrome”.

6. **SSTR signature chamfer is gone from primary buttons**; design-system §6.4 still specifies it. Visual system is otherwise applied.

7. **No route-change announcement / focus-to-h1** (A11Y-005).

8. **Legends hand-review is a labelled stub** (“API yet”). UX-007 / UX-019.

9. **Coach `h3` concatenates chip into the heading** in HTML: `How certain is this?≈Monte Carlo sampling` (`/play?state=decision`, `/review/hand-0042`).

10. **Desktop nav nowrap** may overflow between 860px and ~1100px (UX-001 UNVERIFIED but CSS-plausible).

11. **`--prl-type-label-sm: 0.75rem` (12px)** while the token file calls 13px “the floor”.

### P3

12. Dead header theme CSS (`.prl-shell__theme`) after the control was moved.

13. Review/hand pages stack many polite live regions (8 on `/review/hand-0042`).

14. Footer comment still claims the theme control is in the pill bar ≥1280px; it is not.

---

## Counts

| | n |
| --- | --- |
| Catalog IDs | 39 (UX-001–019 + A11Y-001–020) |
| **PASS** | 12 |
| **PARTIAL** | 20 |
| **FAIL** | 5 (UX-008; A11Y-005; A11Y-007; A11Y-008; A11Y-009) |
| **UNVERIFIED** | 2 (A11Y-001, UX-012). Several PARTIAL rows are also unverified in a browser. |
| P0 | 1 |
| P1 | 3 |
| P2 | 7 |
| P3 | 3 |
| `design:contrast` | **PASS** (token + rendered layers, dark + light) |
| Static `a11y-audit` 2xx | **0 violations / 20 routes** (14 seeds + 6 fixtures). **404 seeds fail the script without checking markup.** |
| Impossible `160%` on fetched Coach HTML | **Not present** |
| `box-shadow` in ui/web CSS | **None** (comments only) |
| User-facing `lorem` / `coming soon` / `TODO` | **None** |

**Overall:** the visual system and the 2xx information architecture are unusually disciplined (tokens, honesty labels, cards, Coach assumptions, slider pairing). They are **not** enough for a WCAG 2.2 AA PASS. Keyboard, overflow, focus-not-obscured, and console are **UNVERIFIED**. The **`notFound()` empty document** is a proven AA and UX failure that the a11y gate is designed not to see.

---

## Scripts actually run

```
pnpm run design:contrast
  → PASS token layer; PASS rendered layer; both themes.

node scripts/a11y-audit.mjs --no-start --base-url http://127.0.0.1:4300 \
  --routes /,/learn,/learn/hand-flow,/learn/glossary,/play,/lab,\
  /lab/eq-flush-draw-turn-small-bet,/legends,/legends/patient-technician,\
  /legends/compare,/legends/hand-review,/review,/record
  → 14 routes, 0 violations, PASS (static subset).

  extra: /play?state=decision|error|loading|complete, /review/hand-0042, /learn/glossary
  → 6 routes, 0 violations.

  /learn/not-a-real-lesson → FAIL “no route was audited” (HTTP 404).
```

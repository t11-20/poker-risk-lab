# UX & Accessibility Audit

**Audit date:** 2026-08-18
**Reviewer:** F, working independently in real Chrome against the running application
(web `:3200`, API `:3201`, both started by the reviewer).

**Counts: 24 PASS · 0 FAIL · 7 PARTIAL · 0 UNVERIFIED · 0 N/A** (31 requirements: UX-001…013,
A11Y-001…018).

> *Count reconciliation.* Reviewer F's own summary block reads “PASS 23 / PARTIAL 8”, but its own
> list of PARTIAL items names **seven** requirement IDs (UX-002, UX-012, A11Y-001, A11Y-002,
> A11Y-012, A11Y-013, A11Y-016) and explains that A11Y-012 carries two distinct defects but is
> counted once. Counting requirement IDs — which is what this audit tabulates — gives 24 PASS and
> 7 PARTIAL of 31. The figures used throughout this audit are 24/0/7/0/0.

---

## 1. Why this reviewer's evidence is unusually trustworthy

The repo's own accessibility tooling **cannot** establish these results: `test:a11y` is a *static*
audit of server-rendered HTML, and the layout guard asserts CSS properties *textually*. Neither can
observe that one element covers another, or that focus moves. A real browser was therefore the only
way to reach a verdict.

Reviewer F went further than running a checker; it validated its own instrument:

- It discovered that **OS-level key injection does not work** in this environment — a `keydown`
  listener on `window` recorded `[]` after Tab/End, and typing left an input's `value` empty. It
  therefore **refused to claim PASS** on anything depending on the browser's own Tab sequencing.
- It discovered that when the Chrome window loses OS focus, `:focus`/`:focus-visible` stop matching
  while `document.activeElement` still reports correctly — which makes every element *falsely*
  report “no focus ring”. It re-ran every focus measurement inside a single tool call after
  foregrounding the tab, and made the harness **self-validating**: `focusVisibleCount` must equal
  the tab-stop count or the run is discarded.
- `resize_window` proved unreliable, so it drove the three viewports through a same-origin iframe
  sized exactly 375×667 / 768×1024 / 1440×900, then **verified the iframe was faithful** by
  reproducing its one occlusion finding in the real window and confirming
  `documentElement.clientWidth` matched.

It also documented **eight plausible-looking findings it chased down and rejected as false
positives** — including 13 apparent dark-theme contrast failures that were mid-transition computed
colours, primary buttons that appear to be 1.13:1 dark-on-dark but are truly 9.39:1 because the
fill is a `::before` layer, and an apparently-unannounced route change whose text lives in
`next-route-announcer`'s **shadow root**. An auditor that reports its own false starts is one whose
positive findings can be relied on.

---

## 2. Results

| ID | Requirement | Status |
|---|---|---|
| UX-001 | No horizontal page scroll at 375 / 768 / 1440 | **PASS** |
| UX-002 | No interactive control occluded by another element | PARTIAL |
| UX-003 | Home → Learn → lesson → quiz journey | **PASS** |
| UX-004 | Scenario Lab → scenario → decision → see the math | **PASS** |
| UX-005 | Play / live table → Coach panel | **PASS** |
| UX-006 | Hand Review journey | **PASS** |
| UX-007 | Legends content | **PASS** |
| UX-008 | Error states (API down, bad id) | **PASS** |
| UX-009 | Loading and empty states | **PASS** |
| UX-010 | No silent fallback to fake data | **PASS** |
| UX-011 | Every primary control does something | **PASS** |
| UX-012 | No console errors/warnings | PARTIAL |
| UX-013 | Theme switching (light / dark / auto) | **PASS** |
| A11Y-001 | Keyboard-only operation of every primary journey | PARTIAL |
| A11Y-002 | No keyboard trap | PARTIAL |
| A11Y-003 | Visible focus indicator on every focusable element | **PASS** |
| A11Y-004 | Logical focus order | **PASS** |
| A11Y-005 | Focus management / announcement on route change | **PASS** |
| A11Y-006 | Modal focus trap works and Escape exits | **PASS** |
| A11Y-007 | Landmarks | **PASS** |
| A11Y-008 | Heading hierarchy, no skipped levels | **PASS** |
| A11Y-009 | Accessible name on every control | **PASS** |
| A11Y-010 | Images, SVG and charts have text alternatives | **PASS** |
| A11Y-011 | ARIA correctness | **PASS** |
| A11Y-012 | Live regions for dynamic updates (incl. Coach) | PARTIAL |
| A11Y-013 | Form error association | PARTIAL |
| A11Y-014 | Card accessibility — rank + suit, not colour alone | **PASS** |
| A11Y-015 | Contrast in both themes, rendered | **PASS** |
| A11Y-016 | Reduced motion respected | PARTIAL |
| A11Y-017 | Focus not obscured (WCAG 2.2 SC 2.4.11) | **PASS** |
| A11Y-018 | Target size minimum (WCAG 2.2 SC 2.5.8) | **PASS** |

### Notable PASSes, with the evidence that earned them

**A11Y-014 — card accessibility.** Verified from a **live server-dealt hand**, not a fixture. The
real accessible names read off the DOM were `["face-down card" ×10, "five of clubs",
"eight of hearts", "five of clubs", "eight of hearts"]`, with group names supplied by `<figure>` +
visually-hidden `<figcaption>` (“community cards: none dealt yet”). Rank and suit are announced;
colour is not load-bearing. `packages/ui/src/components/PlayingCard.tsx:114,124,138-146`.

**UX-010 — no silent fallback to fake data.** The prior review's P0 (every screen silently serving
bundled fixtures) is genuinely fixed at the UX level: with the API up, real data is served; with it
killed, every screen shows a **labelled warning naming the failing path**. Independently confirmed
by Reviewer A.

**A11Y-003 / A11Y-004.** 728 focusable elements across 12 routes each accept focus and each render
a focus ring, measured under the self-validating harness described above.

---

## 3. Findings

### P1-1 — The `/play` table-error state is invisible to screen readers, and the only live region contradicts it
**A11Y-012. WCAG 2.2 SC 4.1.3 (AA) failure on the application's most consequential error path.**

`DIV.prl-error` (“The table could not be prepared”) has **no `role="alert"` and no live-region
ancestor** (`anyLiveAncestor: false`), while the page's sole `role="status"` simultaneously
announces **“Ready to connect.”** A screen-reader user is told the opposite of the truth at the
moment the table fails.

Fix: `role="alert"` on `TableStage.tsx:261-268`.

### P2-1 — Coach arrival/refresh is never announced on `/play`
**A11Y-012.** `CoachPanel` sits in no live region; `announce()` in `use-live-table.ts:158-183` has
no `coach` case, the reducer at `:283-291` never sets `announcement`, and the failure path
`coachProblem` (`:319-324`) is equally silent. Below 600 px the panel is additionally a collapsed
off-screen sheet. `ScenarioStage.tsx:395-397` already handles the identical event correctly, so the
pattern exists in the codebase and was simply not applied here.

The Coach is the product's headline feature; a screen-reader user is not told when its analysis
arrives.

### P2-2 — Keyboard traversal is not proven end-to-end
**A11Y-001, A11Y-002.** 728 focusable elements accept focus and render a ring, and every custom key
handler works — but **no real Tab keypress was possible in this environment**, so the browser's own
sequential-focus behaviour was never exercised.

The audit brief mandated *“real keyboard traversal”*. That specific verification **could not be
completed**, and it is recorded as unproven rather than assumed. One Playwright
keyboard-traversal test would close it permanently.

### P2-3 — Reduced motion proven for CSS but not for JS animation drivers
**A11Y-016.** The CSS side is airtight — a verified `!important` universal backstop in the shipped
stylesheet. The three JavaScript drivers (`useCountUp`, `useReveal`, `BootSequence`) were not
proven to respect `prefers-reduced-motion`.

### P2-4 — `/play` mobile: the fixed Coach sheet covers the primary CTA
**UX-002.** At the initial scroll position on a 375 px viewport the fixed Coach sheet covers the
primary call to action, and the page reserves no bottom padding for it, so content at the end of
the document sits permanently underneath. Recoverable by scrolling; **not** a WCAG failure, but a
real usability defect on the smallest viewport.

### P3 — polish (10 items)
`aria-invalid` used nowhere (quiz numeric field and bet-amount field clamp silently);
an expected no-history 404 logged at **error** level; a React “script tag while rendering” console
error from the pre-paint theme boot script; deep-linking a scenario id during an API outage returns
**404** rather than “temporarily unavailable”, misattributing an outage to a bad URL; `MobileNav`
background not `inert`/`aria-hidden`; `LiveCalculation.tsx:258` is a silent `tabIndex={0}` tab stop
with no `aria-label`; `/review` hand links clear SC 2.5.8's spacing exception by only 1 px (25 vs
24); `not-found.tsx:85` collides with `MobileNav.tsx:309` on nav naming; `/review` emits only an
`h1` and no `h2`; `<main id="prl-main">` has no `tabIndex={-1}`.

---

## 4. Conclusion

**No P0 and no frontend FAIL.** The interface is genuinely accessible in the ways that are hardest
to fake — real accessible names on playing cards from live dealt data, a focus ring on all 728
focusable elements, correct landmarks and heading order, verified rendered contrast in both themes,
and WCAG 2.2's newer criteria (2.4.11 focus-not-obscured, 2.5.8 target size) both met.

The gaps are concentrated in **dynamic announcement**: the most consequential error state on the
live table is silent and contradicted by a stale status region, and the Coach's arrival is never
announced. Both have a correct implementation elsewhere in the same codebase to copy.

One mandated verification — **real keyboard traversal** — could not be performed in this
environment and is reported as unproven, not as a pass.

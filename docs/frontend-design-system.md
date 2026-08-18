# Poker Risk Lab — Frontend Design System

**Version:** 2.0 (dark-primary) · **Last reviewed:** 2026-08-17

This is the authority for every visual decision in `apps/web` and `packages/ui`. If a value
is not in here, it does not belong in a component — see §11.

---

## 1. What this should feel like

**A high-performance decision laboratory that happens to have a poker table in it.**

Precise, dark, confident. Information-dense without being cluttered. Numbers are the
heroes: an equity figure should read like an instrument readout, not a score. The
brightest thing on screen is data.

Explicitly **not**: a casino, a SaaS dashboard, or a game. No felt green, no gold, no
metallic gradients, no glow, no chips-flying celebration, no jackpot colours. Those are the
visual language of gambling and this product is the opposite of gambling.

### Where the principles came from

The brief nominated <https://sstr.tech/en/> as the north star. I inspected the live site
and extracted its **computed** design decisions rather than guessing at them:

| Observed on the reference | What it tells you | How Poker Risk Lab adapts it |
| --- | --- | --- |
| 13-step neutral ramp `#eff0f1 → #0c0c0c`, with half-steps at 150/250/750/850 | Fine-grained surface control is what creates depth | Same 13-step structure, **our own cool-graphite hues**, dark-primary |
| A single accent ramp (orange 50–900), used on roughly one CTA per view | Restraint is what makes an accent read as important | Same discipline, **our own cyan-teal ramp** — not orange |
| **Zero shadow tokens** | Depth from surface value + hairlines, never from blur | Adopted exactly. No `box-shadow` for elevation anywhere |
| Radii `0 / 0.125 / 0.25 / 0.5em` | Near-square reads technical; rounded reads friendly/consumer | Adopted. Nothing is a pill except a status chip |
| One grotesk, four weights (300/400/500/700) | A single family with real weight range beats two families | Adopted, with a **system grotesk stack** — the reference's face is licensed |
| Small uppercase labels at `12px` / `+1.2px` tracking, mid-grey | Technical labels sit quietly above loud data | Adopted as `--prl-label-*` |
| Numbered indices `01 02 03…` in small tracked mid-grey | Numbering turns a list into a system | Adopted for hand phases and lesson steps |
| Metric pairs with units and a delta (`27 → 14 kN·m`, `−48%`) | A number with a unit and a comparison is an argument | Adopted for equity/EV/pot-odds readouts |
| em-based spacing ramp, 18 steps to `10.25em` | Spacing that scales with type size | Adopted, with rem for layout and em for intra-component |
| Signature easing `cubic-bezier(0.675, 0.15, 0.1, 1)`, in `0.425s` / out `0.375s` | Asymmetric timing feels deliberate rather than springy | **Our own curve** on the same asymmetric principle |
| Chamfered CTA corner, not a pill | A cut corner is a signature; a pill is a default | Adopted as a notch on the primary action only |
| Preloader `PLEASE WAIT // LOADING… 0%` | A loading state can carry brand confidence | Adopted **selectively** — first paint only, see §8 |

Nothing was copied: no code, no assets, no copy, no colour value, no layout. What is shared
is method — restraint, hairlines over shadows, one accent, technical labels, big numbers.

---

## 2. Colour

Dark-primary. A light theme is retained (`[data-theme='light']`) because the product is
educational and some people read better on light backgrounds, but dark is the designed
default.

**Every ratio below is measured** with the WCAG 2.x relative-luminance formula, not
estimated. Reproduce with `node scripts/check-contrast.mjs`.

### 2.1 Neutrals — "graphite"

Cool-shifted rather than neutral grey, so the dark surfaces read as instrument housing
rather than as an absence of colour.

| Token | Hex | Use |
| --- | --- | --- |
| `--prl-ink-000` | `#f4f6f8` | primary text on dark |
| `--prl-ink-050` | `#e4e8ec` | |
| `--prl-ink-100` | `#cbd2d9` | secondary text |
| `--prl-ink-200` | `#a9b2bd` | muted text, data series F |
| `--prl-ink-300` | `#8b95a1` | faint text, labels |
| `--prl-ink-400` | `#6e7885` | **meaningful** borders, focus ring backstop |
| `--prl-ink-500` | `#545d69` | disabled text |
| `--prl-ink-600` | `#3d444e` | decorative hairline |
| `--prl-ink-700` | `#2a2f37` | subtle hairline |
| `--prl-ink-750` | `#212630` | inset surface |
| `--prl-ink-800` | `#171b22` | panel surface |
| `--prl-ink-850` | `#12151b` | raised surface |
| `--prl-ink-900` | `#0b0d11` | page ground |

### 2.2 Accent — "readout cyan"

One ramp. Used for interaction, focus, and live data. Not for decoration.

`--prl-accent-200 #a5eef5` · `300 #6fe2ee` · `400 #3ed6e6` · `500 #17c6db` ·
`600 #0fa6bd` · `700 #0c8298` · `800 #0a6274` · `900 #08454f`

### 2.3 Semantic data colours

`--prl-favourable #3ddc9a` · `--prl-adverse #ff7a91` · `--prl-caution #f5b93d` ·
`--prl-info #7db8f0`

These are **desaturated on purpose**. `favourable` is a mint-teal and not a "win green";
`adverse` is a rose and not an "alarm red". A hand that lost is information, not a failure.

### 2.4 Measured contrast

Text on every surface, worst case (`--prl-surface-inset #212630`):

| Token | Ratio | Verdict |
| --- | --- | --- |
| `text` `#f4f6f8` | 14.00:1 | AA body |
| `text-secondary` `#cbd2d9` | 9.94:1 | AA body |
| `text-muted` `#a9b2bd` | 7.07:1 | AA body |
| `text-faint` `#8b95a1` | 4.99:1 | AA body |
| `accent-400` `#3ed6e6` | 8.64:1 | AA body |
| `favourable` `#3ddc9a` | 8.60:1 | AA body |
| `caution` `#f5b93d` | 8.59:1 | AA body |
| `adverse` `#ff7a91` | 6.10:1 | AA body |
| `info` `#7db8f0` | 7.21:1 | AA body |

On the page ground `#0b0d11` every one of those is higher again (primary text is 17.95:1).

**Two rules fall directly out of the measurements, and both are easy to get wrong:**

1. **Text on an accent fill must be `--prl-ink-900`, never white.**
   `ink-900` on `accent-500` is **9.39:1**. White on `accent-500` is **2.07:1** — a fail.
   The accent is a *bright* colour; treat it like a highlighter.
2. **`--prl-ink-700` and `--prl-ink-600` are decorative hairlines only** (1.44:1 and
   1.98:1 on the page). Any border that carries meaning — an input outline, a selected
   state, a chart axis — must use `--prl-ink-400` (**4.34:1**) or the accent.

### 2.4a The light theme inverts the button pairing — do not miss this

Both themes are first-class: dark is the designed default, light is fully supported, and a
component must be legible in both.

The accent has to darken in light mode, and that **flips which text colour is safe on it**:

| Theme | Accent fill | Safe text | Ratio | The other option |
| --- | --- | --- | --- | --- |
| dark | `accent-500` `#17c6db` | `--prl-ink-900` | **9.39:1** | white is 2.07:1 — fail |
| light | `accent-800` `#0a6274` | `#ffffff` | **6.97:1** | ink-900 is 2.79:1 — fail |

`--prl-text-on-accent` is redefined per theme for exactly this reason. **Always use the
token; never hard-code either colour.**

For the same reason, **every step of the accent ramp is remapped in light mode**, not just
the two currently in use. Left at their dark values the bright steps measure 1.21:1
(`accent-200`) to 2.71:1 (`accent-600`) on the light page — so the first component to use one
as text would silently fail contrast. Remapping the whole ramp makes that unrepresentable
rather than merely unlikely.

### 2.4b The three accent roles, and how the gate reads them

The accent is asked to do three jobs, and each is judged against a different threshold: a fill
against the text **on** it, a border against the surface **behind** it at 3:1, ink against the
surface behind it at 4.5:1. `packages/ui/src/styles/base.css` therefore names the three roles.
They introduce no new *values* — each points at an existing ramp step — and every component
uses them instead of reaching for `--prl-accent-400/500` directly:

| Token | Job | Resolves to | Worst measured |
| --- | --- | --- | --- |
| `--prl-accent-fill` | a background carrying `--prl-text-on-accent` | `accent-500` | 9.39:1 dark / 6.97:1 light |
| `--prl-accent-edge` | a border or graphic mark that carries meaning | `accent-500` | 7.04:1 dark / 5.39:1 light |
| `--prl-accent-text` | accent-coloured text | `accent-400` | 8.31:1 dark / 5.39:1 light |

None of the three needs a per-theme override, because §2.4a remaps the whole ramp. That is the
payoff of remapping all of it rather than only the steps in use.

**The gate reports two layers, and the difference matters.** `pnpm run design:contrast` measures
`tokens.css` alone (what this document claims) and then `tokens.css` + `base.css` (what a browser
paints). A failure in the first is a defect in the token set; a failure in the second is a defect
a reader would meet. **Both currently pass, and the gap between them is zero** — which is the state
to keep it in, because a repair layer in `base.css` is a second place to look for the value a
browser actually paints.

Getting there meant fixing three light-theme values at source. Each had been patched in
`base.css` section 0; all three are now correct in the light theme of `tokens.css`, in *both* of
its scopes, and `base.css` no longer overrides any token:

| Token | Was, in light | Measured | Now |
| --- | --- | --- | --- |
| `--prl-text-faint` | `#6b7684` | 3.57:1 on `surface-active` — fails 4.5:1 | `var(--prl-text-muted)` |
| `--prl-line-strong` | `#7e8894` | 2.78:1 on `surface-active` — fails 3:1 | `var(--prl-ink-400)` |
| `--prl-series-f` | not remapped (`ink-200`) | 2.15:1 on a white panel | `var(--prl-ink-500)` |

Two of those are worth understanding rather than just copying:

* **Light has no fourth text step.** `faint` collapses onto `muted` because every value that
  clears 4.5:1 against `--prl-surface-active` (`#dde3ea`) is within a rounding error of `muted` —
  the light surface ramp is too tight for a fourth step to be both legible *and* visibly
  different. One honest step of hierarchy beats a fifth token nobody can see.
* **`line-strong` is not lightened for light.** Lifting it to `#7e8894` made the
  *meaningful-border* token the weakest it was in either theme. The shared `ink-400` clears every
  light surface (3.47:1 worst) and needs no override at all — the override was the bug.

`--prl-series-f` is the failure mode to watch for: it is the one chart colour that is not part of
the semantic set, so it is the one a theme remap forgets. A data mark at 2.15:1 is not a dim
chart, it is a wrong one.

### 2.5 Card faces

Card faces stay light in both themes, because a dark playing card is unreadable at the
sizes a six-max table needs and because inverting a card is a novelty that costs
legibility.

| Suit | Hex | On `#f2f0ea` face | On dimmed `#d8d4c9` face |
| --- | --- | --- | --- |
| spade | `#15181d` | 15.61:1 | 12.01:1 |
| club | `#0f5a44` | 7.18:1 | 5.53:1 |
| heart | `#a81f2b` | 6.36:1 | 4.90:1 |
| diamond | `#1d4fa8` | 6.74:1 | 5.18:1 |

**Four-colour by default, and never colour alone.** Each suit carries its glyph *and* its
`aria-label` ("ace of hearts"). A red/black-only deck plus colour-coded meaning is exactly
the pattern that fails for colour-vision deficiency.

### 2.6 The table surface

`--prl-surface-table #101922` — a deep slate, one step cooler than the panels, with a
faint hairline grid at 32px drawn in `--prl-ink-800`. It reads as **graph paper**, which is
the whole thesis: this is a worksheet you happen to be playing on.

---

## 3. Typography

### 3.1 Families

```css
--prl-font-sans: 'Inter var', 'Inter', -apple-system, BlinkMacSystemFont,
                 'Segoe UI Variable Text', 'Segoe UI', Roboto, 'Helvetica Neue',
                 Arial, sans-serif;
--prl-font-mono: ui-monospace, SFMono-Regular, 'SF Mono', 'JetBrains Mono',
                 'Cascadia Mono', Menlo, Consolas, monospace;
```

**No web fonts.** No `@font-face`, no remote stylesheet, no CDN. The supply-chain policy
forbids remote assets (a font request is a third-party request that can be logged, changed
or blocked), and the CSP has no permitted font host. The stack above resolves to a real
grotesk on every target platform.

### 3.2 Scale

Two scales, because display type and data type have different jobs.

**Display / prose** — `clamp()` so it is fluid without breakpoints:

| Token | Size | Weight | Tracking | Use |
| --- | --- | --- | --- | --- |
| `--prl-type-display-1` | `clamp(2.75rem, 6.5vw, 5.25rem)` | 700 | `-0.03em` | page hero |
| `--prl-type-display-2` | `clamp(2rem, 4vw, 3.25rem)` | 700 | `-0.025em` | section opener |
| `--prl-type-display-3` | `clamp(1.5rem, 2.4vw, 2rem)` | 600 | `-0.02em` | panel title |
| `--prl-type-heading` | `1.125rem` | 600 | `-0.01em` | card title |
| `--prl-type-body` | `0.9375rem` / 1.6 | 400 | `0` | prose |
| `--prl-type-body-sm` | `0.8125rem` / 1.55 | 400 | `0` | secondary prose |

Display type is **tight-tracked and uppercase-optional**. Tight tracking at large sizes is
what makes a grotesk look engineered rather than merely big.

**Labels** — the technical voice:

| Token | Size | Weight | Tracking | Transform |
| --- | --- | --- | --- | --- |
| `--prl-type-label` | `0.6875rem` | 500 | `0.09em` | uppercase |
| `--prl-type-label-sm` | `0.625rem` | 500 | `0.11em` | uppercase |
| `--prl-type-index` | `0.6875rem` | 400 | `0.14em` | tabular, mid-grey |

**Metrics** — oversized numbers, the reason this system exists:

| Token | Size | Weight | Tracking |
| --- | --- | --- | --- |
| `--prl-type-metric-hero` | `clamp(3rem, 7vw, 5.5rem)` | 700 | `-0.04em` |
| `--prl-type-metric-lg` | `clamp(2rem, 3.6vw, 3rem)` | 700 | `-0.03em` |
| `--prl-type-metric-md` | `1.5rem` | 600 | `-0.02em` |
| `--prl-type-metric-sm` | `1.125rem` | 600 | `-0.01em` |

### 3.3 The numeric rule — non-negotiable

**Every figure that can change uses `font-variant-numeric: tabular-nums`.**

```css
.prl-metric__value { font-variant-numeric: tabular-nums; font-feature-settings: 'tnum' 1; }
```

Proportional digits change width as they change value, so a counting-up equity figure or a
live pot jitters horizontally. That is not a polish issue: at a poker table, a number that
moves while you are reading it is a number you misread. Tabular figures are also why a
column of stacks aligns without manual padding.

Metrics are always **value + unit + label**, in that visual order, with the unit at
`--prl-type-label` beside the value and the label above it. A bare number is never shown.

---

## 4. Spacing and layout

An em/rem hybrid ramp, mirroring the reference's structure:

`--prl-space-0` 0 · `1` 0.125rem · `2` 0.25rem · `3` 0.375rem · `4` 0.5rem · `5` 0.75rem ·
`6` 1rem · `7` 1.25rem · `8` 1.5rem · `9` 2rem · `10` 2.5rem · `11` 3rem · `12` 4rem ·
`13` 5rem · `14` 6.5rem · `15` 8rem · `16` 10rem

**Section rhythm** is deliberately large: `--prl-section-y: clamp(4rem, 9vw, 8rem)`. The
reference's confidence comes substantially from how much empty space it is willing to spend
between sections, and copying the colours without the rhythm would miss the point.

**Grid.** A 12-column grid inside `--prl-container: min(100% - 2 * var(--prl-gutter), 88rem)`
with `--prl-gutter: clamp(1rem, 4vw, 2.5rem)`. Content that is prose caps at `68ch`.

**Radii.** `--prl-radius-0: 0` · `-1: 2px` · `-2: 4px` · `-3: 8px` · `-pill: 999px`.
Near-square is the default. `-pill` is for status chips only.

**Borders.** `--prl-hairline: 1px solid var(--prl-line-subtle)`. Hairlines, not shadows,
are how surfaces separate.

### 4.1 No shadows for elevation

There is no `--prl-shadow-*` token, deliberately. Depth comes from moving one step on the
neutral ramp plus a hairline.

**As shipped, `packages/ui` and `apps/web` contain zero `box-shadow` declarations — not one, not
even for focus.** The focus ring is an `outline` (§7), which is the right primitive for it: an
outline does not participate in layout, is not clipped by `overflow: hidden`, and is replaced
wholesale under `forced-colors`, all of which a box-shadow ring gets wrong. So the rule is simply
*no `box-shadow`*, with no carve-out to argue about. A `grep -rn box-shadow packages/ui/src
apps/web/src` returning only prose is the check.

Beyond taste, this is a performance decision: large blurred shadows on a table with six
seats, community cards and a live panel are exactly the paint-heavy layers that cost frames
on a mid-range laptop.

---

## 5. Motion

```css
--prl-ease-standard: cubic-bezier(0.62, 0.14, 0.12, 1);   /* signature: fast out, long settle */
--prl-ease-enter:    cubic-bezier(0.16, 0.84, 0.30, 1);
--prl-ease-exit:     cubic-bezier(0.40, 0.00, 0.80, 0.30);
--prl-ease-hover:    cubic-bezier(0.62, 0.14, 0.12, 1);

--prl-dur-instant: 90ms;    /* hover, active */
--prl-dur-quick:   180ms;   /* chips, small state */
--prl-dur-in:      420ms;   /* entering — deliberately SLOWER than exit */
--prl-dur-out:     300ms;   /* leaving */
--prl-dur-reveal:  620ms;   /* section reveal */
--prl-dur-count:   900ms;   /* metric count-up */
```

The **in > out** asymmetry is taken from the reference (0.425s in / 0.375s out) and is what
makes transitions feel considered: things arrive with weight and leave without ceremony.

### 5.1 Motion must explain state, never decorate

Every animation in this app answers one of exactly four questions:

1. **What changed?** — a stack decreasing, a pot growing, a card arriving.
2. **Where did it come from?** — chips travelling seat → pot.
3. **Whose turn is it?** — the active seat's turn timer.
4. **Is this new information?** — a section or panel revealing on scroll.

If an animation answers none of those, it does not ship.

### 5.2 Count-up metrics

Equity, EV, pot odds and pot size count up on change over `--prl-dur-count`, easing with
`--prl-ease-standard`. Rules:

* The **final value is written to the DOM immediately**; the animation only interpolates a
  visually-presented copy. A screen reader must never read a mid-count number.
* The animated element is `aria-hidden`; the real value sits in a visually-hidden node in
  an `aria-live="polite"` region.
* Count-up is skipped entirely under `prefers-reduced-motion`, and for changes under 1%.

### 5.3 Reduced motion

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 1ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 1ms !important;
    scroll-behavior: auto !important;
  }
}
```

Plus, in JS: reveals resolve to their final state on mount, count-ups jump to the value,
and the loading transition (§8) is skipped. **The app must be fully usable and fully
legible with every animation disabled** — motion is never the only carrier of meaning.

"Disabled" has four causes, not one, and the fourth is the one that is easy to miss:
`prefers-reduced-motion`, `scripting: none`, an observer that never fires, and **a hydration that
never happens**. The first two are media queries and the third resolves itself; the fourth matches
no query at all, because scripting is enabled — the bundle simply never arrived. A reveal whose
hidden state survives that is a blank page, so the hidden state carries a deadline (§5.6) keyed on
the boot overlay still being `pending`. Verified by blocking `/_next/static/chunks/*.js` with
scripting left on: `h1` opacity 1, all six home-page reveals at opacity 1, and the boot overlay not
hit-testable at the viewport centre.

### 5.4 Performance rules

* Animate `transform` and `opacity` only. Never `width`, `height`, `top`, `left` or
  anything else that triggers layout.
* No `filter: blur()` on anything that animates, and no backdrop-filter on a large surface.
* `will-change` is applied on interaction start and removed on end, never left standing.
* Reveals use `IntersectionObserver`, unobserving after the first trigger. No scroll
  listeners, no `getBoundingClientRect` in a scroll handler.
* Prefer CSS `@keyframes` and `transition` over JS. The only JS-driven animation is the
  count-up, which uses `requestAnimationFrame` and cancels on unmount.

### 5.5 The one place motion values are duplicated in JS

`requestAnimationFrame` needs a duration as a **number** and an easing curve as a
**function**, and a CSS custom property is neither — it is a string that only resolves once
an element is in a document, which is not true during a server render. So the count-up (§5.2)
cannot read `--prl-dur-count`, and exactly two values are mirrored in JS:

| Mirror in `packages/ui/src/motion/tokens.ts` | Token it mirrors |
| --- | --- |
| `COUNT_DURATION_MS = 900` | `--prl-dur-count` |
| `EASE_STANDARD_CONTROL_POINTS = [0.62, 0.14, 0.12, 1]` | `--prl-ease-standard` |

`motion/easing.ts` evaluates that curve (a bézier solve, ~30 lines) so the JS count-up eases
identically to the CSS around it. **`packages/ui/test/motion.test.ts` asserts both values
against `tokens.css` itself**, so changing a token and forgetting the mirror fails the build
rather than producing a count-up that drifts out of step with everything else. Nothing else
in JS may hold a duration or a curve: if a new animation needs one, it needs CSS.

### 5.6 What JS publishes for CSS to style

Motion state crosses into the stylesheet as attributes and custom properties, never as
inline styles:

| Published by | Contract |
| --- | --- |
| `Reveal` / `useReveal` | `data-revealed="true" \| "false"`. The **hidden** state must be written as `[data-revealed='false']` — styling `.prl-reveal` bare would leave content invisible whenever the observer never runs |
| `BootSequence` | `.prl-boot[data-state='pending']` is, for CSS, the **proof that no JavaScript has run**: the overlay is server-rendered `pending` and only ever leaves that state by hydration. `:root:has(.prl-boot[data-state='pending']) .prl-reveal[data-revealed='false']` is therefore the one honest way to say "reveal it, nothing is coming", and it stops applying the instant the app is alive |
| `Reveal` | `--prl-reveal-index`, a unitless stagger position: `transition-delay: calc(var(--prl-reveal-index, 0) * var(--prl-dur-deal-stagger))` |
| `Metric` with `countUp` | `.prl-count` on the animated (and `aria-hidden`) figure |

---

## 6. Component rules

### 6.1 The poker table (highest priority)

* Surface `--prl-surface-table` with the 32px hairline grid. **No felt, no baize, no wood.**
* Seats are **hairlined rectangles with a chamfered inner corner**, not ovals. Each carries:
  position label (`--prl-type-label`), name, stack (tabular), current street commitment,
  and status.
* The **active seat** is marked three ways at once — accent border, a `--prl-type-label`
  "TO ACT" chip, and the turn-timer arc. Never by colour alone.
* The **turn timer** is a conic-gradient ring animated with a single custom property, so it
  is one composited element rather than an animated SVG.
* The **pot** is a metric block (`--prl-type-metric-lg`, tabular) with side pots listed
  beneath as indexed rows (`01`, `02`).
* **Community cards** deal in with a 120ms stagger, `translateY(-8px) → 0` plus opacity.
  Under reduced motion they are simply present.
* Responsive: below 900px the oval becomes a **vertical stack** — hero seat pinned to the
  bottom, opponents in a scrollable row, board fixed centre. Information is never removed to
  fit, only re-flowed.

### 6.2 The Coach panel

The most information-dense surface in the app, so it uses **progressive disclosure** with
hard limits on what may be hidden:

* **Always visible, never collapsible:** equity (with method + interval), pot odds and
  break-even, the suggestion with its confidence, **and the assumptions**. Hiding the
  assumptions behind a toggle would let a learner read a number without its caveats, which
  is the exact failure the product exists to prevent.
* **Collapsible:** the per-action EV table, the outs card-by-card breakdown, the derivation
  strings, and the teaching notes.
* Uses `<details>`/`<summary>` — free keyboard support, free screen-reader semantics, works
  with JS disabled. The arrow rotates on `--prl-dur-quick`.
* Monte Carlo figures render as `41.2% ±0.35` with the interval in `--prl-type-label`
  beside the value. Exact figures render as `41.2%` with an `EXACT` chip. **A bare
  percentage with no method is a bug, not a style choice.**
* Clean vs dirty outs are distinguished by **fill pattern and label**, not hue alone: clean
  outs are solid accent, dirty outs are a 45° hatch, each with a text count.

### 6.3 AI Legend cards

* Portrait-orientation panel, hairlined, with the **archetype name as the primary heading**
  and the attributed name (when enabled) beneath in `--prl-type-label`.
* A **16-axis radar** drawn as inline SVG — polygon, axis spokes, and three concentric
  reference rings. Accent stroke at 1.5px with a 12%-alpha accent fill.
* **No portraits, no likenesses, no photographs, no AI-generated faces.** Visual identity
  comes from a generated geometric sigil derived deterministically from the profile id —
  which is also the honest representation, since the profile *is* a set of numbers.
* The disclaimer renders **inline in the card body**, at `--prl-type-body-sm`, not in a
  tooltip and not behind an info icon. The wire type makes it non-optional; the design must
  not undo that.
* Three signature axes are called out as metric blocks above the radar so the card is
  readable at a glance.

### 6.4 Buttons

* **Primary** — accent fill, `--prl-ink-900` text (§2.4 rule 1), 2px chamfer on the
  top-right corner as the signature. One per view.
* **Secondary** — transparent, `--prl-ink-400` hairline, accent hairline and text on hover.
* **Ghost** — text only, accent on hover.
* **Action bar buttons** (fold/check/call/bet/raise) are a distinct family: full-width in a
  row, larger target, each with its **cost printed in tabular figures** on the button. A
  player should never have to work out what a button will cost them.
* The bar **wraps intrinsically rather than at a breakpoint**: the buttons and the sizer take a line
  each, and inside the sizer the presets, the slider row, the bounds and the readout declare the
  width they need unwrapped (`flex-basis: max-content` for the two interactive blocks) and share a
  line only when both fit on it. A half-width block that has wrapped internally is taller than the
  same two blocks stacked, which is why the basis is the unwrapped width and not a guess. The bar's
  height is a **table-visibility** constraint (§10.1), so it is spent deliberately: 462px stacked,
  325px reflowed at a desktop table, with nothing removed.
* Minimum target 44×44 CSS px (exceeding WCAG 2.2's 24×24 floor, because these are
  consequential and often used on a phone).

### 6.5 Metric blocks

The workhorse. `label` above, `value` + `unit` on the baseline, optional `delta` and
`note` beneath.

```
EQUITY                     ← --prl-type-label, --prl-ink-300
41.2 %                     ← --prl-type-metric-lg, tabular; unit at --prl-type-label
+7.9 pts over break-even   ← --prl-type-body-sm, semantic colour + explicit sign
```

Deltas always carry an explicit `+`/`−` **and** a word, never colour alone.

---

## 7. Accessibility (WCAG 2.2 AA)

| Requirement | How |
| --- | --- |
| 1.4.3 Contrast | Every pairing measured, §2.4. Worst body text 4.99:1 |
| 1.4.11 Non-text contrast | Meaningful borders use `--prl-ink-400` (4.34:1) or accent |
| 1.4.1 Use of colour | Every semantic colour paired with a sign, glyph, label or pattern |
| 2.1.1 Keyboard | Everything operable. Bet sizing is a slider **plus** a number input |
| 2.4.7 Focus visible | `outline: 2px solid var(--prl-accent-300); outline-offset: 2px` — 12.77:1 on page. `:focus-visible`, never `:focus`, and **never removed** |
| 2.4.11 Focus not obscured | Sticky nav has `scroll-padding-top` so a focused element is never behind it. No route pins a second surface to the bottom edge above 600px (§10.1) |
| 2.4.3 Focus order, modal surfaces | A focus trap must cycle the **tabbable** set, not the focusable one — a radio group is ONE tab stop, at the *checked* radio. Cycling `focusable[length - 1]` traps only readers who happen to have selected the last radio. And because arrow keys move focus inside a group natively, with nothing for a `keydown` handler to cancel, Tab handling alone is not a trap: the sheet also pulls focus back from a `focusin` listener while it is open |
| 2.5.8 Target size | 44×44 minimum |
| 4.1.2 / 4.1.3 Status | Table updates in `aria-live="polite"`. Focus is never moved by a remote event |
| 1.3.1 Structure | One `h1` per page; `@prl/ui` components never emit `h1` |
| 2.3.3 Animation | `prefers-reduced-motion` honoured throughout, §5.3 |

**Screen-reader specifics for cards and actions:** every card has an `aria-label` of the
form "ace of hearts"; decorative pips are `aria-hidden`. Every action button announces its
cost ("call 50 units"). The board announces as a group: "community cards: queen of hearts,
seven of hearts, two of clubs".

---

## 8. The loading transition

Used **once**, on first paint of the app shell — not between routes, and never as a
spinner on a data fetch.

`READY // CALIBRATING` with a monospace 0→100 counter and a 1px accent rule that wipes
left-to-right, then the shell cross-fades in over `--prl-dur-in`.

Hard limits:

* Capped at **900ms**, and dismissed early the moment the shell is ready. It must never
  delay interaction — a loading animation that makes a fast app slower is a net loss.
  **The cap is in CSS as well as in the component** (`animation: prl-boot-deadline … var(--prl-dur-count)
  forwards` on `.prl-boot`), because the one failure the overlay has to survive is the bundle not
  arriving — and in that failure every JavaScript exit is unavailable while an opaque, page-coloured,
  `z-index: 900` sheet is already painted. The deadline animates `visibility`, never `opacity`: a
  filling `opacity` animation would out-rank the `data-state="done"` declaration, the fade would
  never start, `transitionend` would never fire, and the component's own unmount would silently stop
  happening. Observed for real twice before it existed: a stale chunk manifest after a rebuild
  (`ChunkLoadError`) and a backgrounded tab whose `requestAnimationFrame` never fires.
* Skipped entirely under `prefers-reduced-motion`, and on repeat visits within the session
  (`sessionStorage`).
* Route changes get a 2px accent progress bar at the top instead. Data fetches get skeleton
  blocks at the real content's dimensions, so nothing reflows on arrival.

---

## 9. Navigation and information architecture

Five destinations, in learning order, with the numbered-system motif:

```
01 LEARN      lessons, quizzes, glossary
02 PLAY       tables — bots, AI Legends, private rooms
03 LAB        Scenario Lab
04 LEGENDS    AI opponent profiles
05 REVIEW     hand history and analysis
```

* Sticky header, `--prl-surface-page` at 92% with a hairline bottom, becoming opaque past
  40px of scroll (a class toggled by `IntersectionObserver` on a sentinel — no scroll
  listener).
* Active destination marked by an accent underline **and** `aria-current="page"`.
* Below 860px: a full-screen sheet, focus-trapped, `Escape` to close, opening with an accent
  wipe on `--prl-dur-in`.
* The **units badge** is permanent in the header, always reading `1,000 UNITS` with an
  accessible description that they are free and valueless. Never a currency symbol.

### 9.1 The process spine

The reference tells a process story; ours is the educational loop, and it appears as a
numbered spine on the home page and as a breadcrumb inside a hand:

```
01 LEARN → 02 CALCULATE → 03 DECIDE → 04 REVIEW
```

It is a **loop**, and the copy says so: step 04 leads back to 01. A linear four-step graphic
implies you are finished at the end, which is exactly the belief the review step exists to
correct.

The connector is a border on the **list**, not on each step, so it is one continuous hairline
rather than four segments with gaps. Each step meets it with a short accent tick; the current
step's tick is longer *and* its label goes accent, so the state is never carried by colour
alone. There are no arrow glyphs: `content: "→"` in a pseudo-element is announced by some
screen readers as "right arrow" between every step, and the ordered list plus the numerals
already carry the ordering.

### 9.2 The two app-shell tokens

§11 rule 1 forbids one-off values, so the two numbers §9 states in prose are declared as tokens.
Both live in `apps/web/src/app/globals.css` rather than in `tokens.css`, because they describe the
**shell** rather than the system — no component outside that file has any use for either, and
promoting them would invite one.

| Token | Value | What it implements |
| --- | --- | --- |
| `--prl-shell-header-fill` | `color-mix(in srgb, var(--prl-surface-page) 92%, transparent)` | The header's resting surface: the page ground at 92%. `color-mix` rather than an `rgba()` literal, so it tracks whichever theme's page ground is in force instead of becoming a third hard-coded colour |
| `--prl-shell-sentinel` | `var(--prl-space-10)` (2.5rem = 40px) | The scroll distance after which the header goes opaque, expressed as the **height of a sentinel element** rather than as a number in a JavaScript comparison |

The sentinel is the point of the second one. An `IntersectionObserver` watching a 40px-tall
absolutely-positioned element at the top of the document reports the same fact a
`scroll` handler would, off the main thread and only when the answer changes (§5.4) — and the
threshold stays in the token system instead of becoming a literal in a comparison.

There is deliberately **no `backdrop-filter`** on the header. A blur on a full-width strip that
repaints on every scroll frame is one of the most expensive things a compositor can be asked
for, and §5.4 rules it out on large surfaces.

**Also of note:** a 2px rule is written as `var(--prl-space-1)` (0.125rem), never as
`var(--prl-focus-width)`. Both resolve to 2px and only one of them means it; borrowing the focus
token as a generic length is how a later change to the ring's weight silently thickens an
unrelated marker. `components.css` already uses `--prl-space-1` this way on `.prl-error`.

---

## 10. Responsive

| Range | Layout |
| --- | --- |
| < 600px | single column; table stacks vertically; Coach becomes a bottom sheet with a drag handle |
| 600–899px | two-column content; table still stacked; Coach in a full-width panel below |
| 900–1279px | table in oval form once the column itself passes 46rem; Coach in a right rail at 22rem |
| ≥ 1280px | 12-column grid; table centred with Coach rail and the decision band in the same viewport, no scrolling during a decision |

**The ≥1280px rule is a functional requirement, not an aesthetic one:** a player must be
able to see the pot, their cards, the price and the Coach's equity figure *at the same
time*. Any layout that forces a scroll to compare the price with the equity has broken the
product.

### 10.1 The decision band is never pinned, and that is a rule rather than a preference

The band that carries your plate, the price, the sizer and the buttons is **in normal flow at
every width**. It was `position: sticky; inset-block-end: 0` from 900px up, and that single rule
hid the entire table: measured at 1440×900, dark, `/play`, scroll 0, the band was 566px tall and
pinned across `y 334..900` while the table field sat at `y 375..895`, so `elementFromPoint` at the
pot, the board, the dealer button and all six seat centres returned the bet slider and the presets.

The arithmetic generalises, which is why the ban is absolute rather than a height budget:

> A bottom-pinned element occupies `viewport-bottom − H … viewport-bottom` for as long as its own
> flow position is below the fold. The block immediately **above** it in flow therefore ends inside
> that strip by definition. Any sticky-bottom band in the table column occludes the table for the
> whole of its pinned range, at every viewport height, whatever `H` is.

The only pinned band that could not occlude the table is one in a column that does not scroll —
which means giving the table its own scroll box, and a scroll box with no focusable content in it
cannot be scrolled from a keyboard at all (WCAG 2.1.1; `.prl-table__opponents` already rejects that
pattern for the same reason).

**So simultaneity is bought with height, not with layers.** Two rules follow, and both are
enforceable by reading a stylesheet:

1. The decision band and the ActionBar inside it **reflow rather than stack** once there is room:
   your plate moves beside the controls (a `@container prl-play-column (min-width: 46rem)` query,
   the same threshold the table uses for its oval), and the sizer's presets, slider, bounds and
   readout pair up by intrinsic width. Measured band height at 1440×900: **342px, from 566px.**
   Nothing is removed, collapsed or hidden at any width to achieve it.
2. **Nothing on this route may overlap the table.** The check is a hit-test, not a review comment:
   at 1280×800, 1440×900, 1600×900, 1920×1080, 768×1024 and 390×844, `document.elementFromPoint`
   at nine sample points on the pot, the board, the dealer button and each of the six seats must
   never return a node inside `.prl-play__decision`. It currently returns 0/9 at every point, at
   every one of those sizes, in both themes.

At 1440×900 and above the whole field and the whole band are on screen together (486 of 520px of
field at 1440×900, all 520 at 1920×1080, six seats of six). At 1280×800 they are not, and cannot
be: 63px of sticky header plus a 520px field plus a 419px band is 1002px of content for 800px of
screen. The top of the field is then above the fold while the whole band is visible — a small
viewport, not an occlusion, and 90px of scroll recovers it. The distinction the design system cares
about is exactly that one: **content above the fold is reachable, content under an opaque overlay is
not.**

---

## 11. Rules for contributors

1. **No one-off values.** No hex, px, ms or cubic-bezier literal in a component. If you
   need a value that is not a token, add the token here first.
2. **Refactor before duplicating.** `packages/ui` already has `PlayingCard`, `CardRow`,
   `PokerTable`, `ActionBar`, `CoachPanel`, `EquityBar`, `StatTile`, `Callout`, `Formula`,
   `AssumptionList`, `UncertaintyNote`, `UnitsBadge`. Extend them.
3. **Native CSS only.** No Tailwind, no CSS-in-JS, no preprocessor, no animation library.
   The supply-chain policy makes every dependency a reviewed event; a utility-class
   framework is not worth one.
4. **No remote assets.** No fonts, scripts, images or stylesheets from another origin. The
   CSP forbids it and so does this document.
5. **Information beats aesthetics, always.** If a layout is prettier without the confidence
   interval, the layout is wrong.
6. **Test both themes and both motion settings.** Four combinations, all of which must be
   legible and usable.
7. Run `pnpm run lint && pnpm run typecheck && pnpm run test && pnpm run test:a11y` before
   claiming done.

---

## 12. What is deliberately absent

* **Shadow-based elevation.** §4.1.
* **A second font family.** One grotesk with four weights is enough, and a second family is
  a second thing to get wrong.
* **Any celebration animation on winning a pot.** Chips move to the winner and the stack
  counts up. There is no flourish, no sound, no particles. Rewarding the *outcome* is the
  core casino dark pattern, and this product rewards the *decision* — the post-hand review
  is where the positive feedback lives.
* **Icons for their own sake.** Labels are words. Icons appear only where the meaning is
  unambiguous and space is genuinely tight.
* **A dashboard.** There is no widget grid and no configurable homepage. Every screen has
  one job.

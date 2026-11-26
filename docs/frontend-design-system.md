# Poker Risk Lab — Frontend Design System

**Version:** 5.0 (warm and flat) · **Last reviewed:** 2026-11-22

> **What changed in 5.0, at the owner's request.** No blue anywhere: warm off-white and warm
> near-black grounds with charcoal and off-white ink, and one felt-green accent. Red, amber and
> green mean risk or result and nothing else. Every colour lives in `tokens.css` and a test fails a
> literal anywhere else. The 4.0 glass, page wash, elevation shadows, lit edges, gradient sheens
> and coloured edge bars are removed (§2.4 lists each). The theme switch is in the header (§9).
> The table, seats and cards are restyled separately (§2.5). Typography, spacing, motion and the
> 4.0 layout rules are unchanged.

This is the authority for every visual decision in `apps/web` and `packages/ui`. If a value
is not in here, it does not belong in a component — see §11.

---

## 1. What this should feel like

**The deck is the instrument.** (4.0; it was "a high-performance decision laboratory that
happens to have a poker table in it".)

Printed, precise, confident. The interface is set on card stock, and its headlines read like a
card's corner index or a printed odds board.
Numbers are still the heroes: the boldest type on a screen is a figure or a headline, and the
boldest object is a card. Spend boldness in one place per screen and keep the rest quiet.

Explicitly **not**: a casino, a SaaS dashboard, or a game. No gold, no metallic gradients, no glow,
no chips-flying celebration, no jackpot colours. The one felt green is a muted accent for controls,
never a field or a reward. Those are the
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

Since 5.0 there are two themes, warm and flat, chosen by the reader's system setting unless they
pick one in the header (§9). **Every colour is declared in `packages/ui/src/styles/tokens.css` and
nowhere else.** `packages/ui/test/colour-literals.test.ts` fails a hex, `rgb()`, `hsl()` or named
colour in any other stylesheet, and in any `.ts` or `.tsx` string; CSS system colours
(`Canvas`, `Highlight` …) are allowed for forced-colors rules and `global-error.tsx`.

There is **no blue**: not in the ink, the surfaces, the focus ring, the links, the chart series or
the table.

Reproduce every ratio below with `node scripts/check-contrast.mjs`. Its first two passes read the
stylesheets alone; the third composites real pages in Chrome (§7.3).

### 2.1 Palette

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--prl-surface-page` | `#f5f2ec` | `#161412` | page ground: warm off-white / warm near-black |
| `--prl-surface-raised` | `#fdfcf9` | `#1d1a17` | raised rows, header pills, chips |
| `--prl-surface-panel` | `#fdfcf9` | `#211e1a` | panels, where body text lives |
| `--prl-surface-inset` | `#eeeae2` | `#282420` | wells, code, callouts |
| `--prl-surface-hover` | `#e9e4db` | `#2d2924` | hover |
| `--prl-surface-active` | `#dfd9ce` | `#36312b` | pressed, selected |
| `--prl-text` | `#24211d` | `#f3efe7` | charcoal / off-white |
| `--prl-text-secondary` | `#45403a` | `#d5cfc4` | |
| `--prl-text-muted` | `#5b554d` | `#b2aa9c` | labels |
| `--prl-text-faint` | = muted | `#a39b8d` | light has no fourth step that clears 4.5:1 on `active` |
| `--prl-text-disabled` | `#a29b90` | `#6b645a` | exempt (WCAG 1.4.3) |
| `--prl-line-subtle` | `#e2ddd4` | `#2f2b26` | decorative hairline |
| `--prl-line` | `#cdc6ba` | `#433d36` | decorative hairline, panel edges |
| `--prl-line-strong` | `#7a7266` | `#8b8274` | a border that carries meaning (≥ 3:1) |
| `--prl-accent-fill` | `#1e5c40` | `#2f7a55` | felt green: primary buttons, the current place |
| `--prl-accent-fill-hover` | `#174a33` | `#276747` | |
| `--prl-accent-text` | `#1e5c40` | `#86cba5` | links, accent words |
| `--prl-accent-edge` | `#1e5c40` | `#5ea886` | accent borders and marks |
| `--prl-text-on-accent` | `#ffffff` | `#ffffff` | the label on a fill |
| `--prl-focus-color` | `#174a33` | `#a6dcbf` | focus ring; halo `#ffffff` / `#161412` (§7.1) |
| `--prl-favourable` | `#436410` | `#b4cc72` | a good result |
| `--prl-adverse` | `#a5332a` | `#ef9284` | a bad result |
| `--prl-caution` | `#7f5605` | `#e3b25a` | a risk |
| `--prl-series-a` | = accent-edge | = accent-edge | chart series (with a fill pattern each) |
| `--prl-series-b` | `#3b3630` | `#e6e0d4` | ink |
| `--prl-series-c` | `#8a4f2a` | `#d29a6c` | clay |
| `--prl-series-d` | `#7d3b66` | `#cf93bd` | plum |
| `--prl-series-e` | `#6b645a` | `#a8a092` | stone |
| `--prl-series-f` | `#7d6739` | `#c7ae7a` | tan |
| `--prl-mark-heart` | `#a5332a` | `#f08a8a` | a heart or diamond named in prose (`CardText`) |
| `--prl-scrim` | `rgb(36 33 29 / 44%)` | `rgb(10 9 8 / 72%)` | behind a modal |

The light value of each is declared twice (the `prefers-color-scheme` block and
`[data-theme="light"]`), and the contrast gate fails if the two disagree.

### 2.2 What colour may mean

* **The accent is one felt green** and means "you can act here" or "you are here": buttons, links,
  focus, the current page. It never means a good result.
* **Red, amber and green mean risk or result and nothing else** (`adverse`, `caution`,
  `favourable`), and each always travels with a word, a sign or a glyph (`▲ +28.2 points`,
  "Watch out", "Common misconception"). A chart series is a category, not a result, so the series
  are browns, plum and greys, with a fill pattern each.
* **Accent green and good green are told apart** by hue (the accent leans blue-green, `favourable`
  leans yellow-green) and never by hue alone: a favourable figure carries `▲`/`+`; the primary
  button is filled and semibold where the others are outlined; the current page is filled and
  semibold; the quiz's matched verdict carries its mark glyph.
* **The suit marks** beside the section names (Learn ♠, Lab ♦, Play ♥, Review ♣) take the text
  colour. A red heart or green club there would read as a risk or a result, and the shape plus the
  word already name the place. The header bar no longer carries them: the words name each place, and
  their width is what the theme switch needed to stay on one row at 860px. They remain in the phone
  menu, the footer, page heads and the home page.

### 2.3 Measured contrast

Worst case over every surface the gate checks (body text on all seven surfaces; accent and
semantic text on the five content surfaces; borders on all seven), 2026-11-22:

| Token | Dark | Light | Floor |
| --- | --- | --- | --- |
| `text` | 11.23 | 11.41 | 4.5 |
| `text-secondary` | 8.31 | 7.30 | 4.5 |
| `text-muted` | 5.59 | 5.24 | 4.5 |
| `text-faint` | 4.68 | 5.24 | 4.5 |
| `accent-text` | 8.14 | 6.58 | 4.5 |
| `favourable` | 8.67 | 5.70 | 4.5 |
| `adverse` | 6.69 | 5.63 | 4.5 |
| `caution` | 7.91 | 5.41 | 4.5 |
| `text-on-accent` on the fill / hover fill | 5.20 / 6.74 | 7.89 / 10.18 | 4.5 |
| `line-strong` | 3.40 | 3.38 | 3 |
| `accent-edge` | 4.55 | 5.62 | 3 |
| `focus-color` | 8.34 | 7.25 | 3 |
| series a–f | ≥ 4.55 | ≥ 3.86 | 3 |

Two rules fall out of the numbers:

1. **Text on an accent fill is `--prl-text-on-accent`**, never a literal. It is white in both
   themes, and the gate checks it is the better of white and the theme's darkest ink.
2. **`--prl-line-subtle` and `--prl-line` are decorative** (1.1–1.7:1). A border that carries
   meaning — an input outline, a selected state, a popover's edge — is `--prl-line-strong` or
   `--prl-accent-edge`.

### 2.4 Flat surfaces

Depth is a **fill and a hairline**. There is no shadow except the focus halo, no
`backdrop-filter`, no translucent pane and no gradient wash. Surfaces step down the ramp (`page`,
`raised`/`panel`, `inset`); a panel takes a 1px `--prl-line` edge; anything that sits over content
with nothing to lift it — a popover, the glossary panel, the phone Coach sheet, the menu — takes a
`--prl-line-strong` edge instead. Sticky bars (the header, the replay transport) are opaque, so text
scrolled under them never reads through. `packages/ui/test/layout-guarantees.test.ts` fails any
`box-shadow` that is not `var(--prl-focus-ring)` on a focus rule, and any `backdrop-filter`, glass,
wash, edge, veil or elevation token, in any rule, the table's included.

Panel surfaces are `.prl-panel` and `.prl-panel--inset`. The 4.0 edge and
veil tokens are gone, with the navy table and the old card tokens, now that the table is flat too.

**Removed, and why.** The 4.0 system built depth from translucent "glass" panes over a tinted page
wash, a five-level elevation ladder of double shadows, lit top hairlines, gradient sheens on
buttons, and coloured bars down the left edge of cards and callouts. Together they read as a
generated template rather than as this product, and each needed a guard of its own (a blur beside
every tint, a halo beside every shadow, the wash composited into every contrast figure). The list:

| Where | What it was | What replaced it |
| --- | --- | --- |
| `tokens.css`, `base.css` body | `--prl-page-wash` radial gradients on the page | flat `--prl-surface-page` |
| `globals.css` `.prl-app::before` | fixed four-gradient backdrop field | removed |
| header, pills, Coach sheet, replay transport, learn rail and quiz pill, action bar, secondary and danger buttons | glass tint plus `backdrop-filter` | opaque surface token |
| 81 `box-shadow` declarations in 78 rules across `components.css` and the route sheets | `--prl-elevation-1..4` shadows, and the `--_ring` mechanism that kept the halo beside them | none; base.css's halo is the only shadow |
| 38 rules | lit top / shaded bottom edge (`--prl-edge-lit/-shade`) | one `--prl-line` hairline |
| `.prl-btn--primary`, `.prl-range` thumb, `.prl-play .prl-action-btn--primary` | gradient sheen | one flat fill, darker on hover |
| `.prl-callout` and its four tones, `.prl-suggestion`, `.prl-uncertainty`, `.prl-error`, `.prl-stage__chosen`, `.prl-learn-scenario`, `.prl-term__panel`, `.prl-learn-quiz__explanation`, `.prl-learn-quiz__verdict`, the quiz's numeric error, `.prl-learn-entry[data-start]`, `.prl-lab-card__state`, `.prl-legal-flag`, `.prl-play__join`/`__invite`, `.prl-legend-disclaimers`, `.prl-source-note`, `.prl-gate__caveat` | coloured or grey 2–4px left-edge bar | a full hairline box; the tone is carried by the marker word (semibold, muted and medium on a note), its glyph, and red/amber only for warning and misconception. A note uses the decorative line, not the strong edge |
| `.prl-legend-decision[data-actor]` | accent bar for yours, grey for the model's | a full accent edge on yours, which the page's own copy describes |
| `.prl-timeline__street` | accent rail | 1px `--prl-line-strong` rail |
| `.prl-lab-card`, `.prl-legend-card`, `.prl-learn-entry`, `.prl-timeline__marker` hover | lift (`translateY`) plus a bigger shadow | a surface step and a stronger edge |
| `Callout` "Insight", `TraitBars` "Signature axis" | `◆` glyph | the word alone |
| header nav and Play button | coloured suit marks | none (see §2.2) |

Kept on purpose: the current-page bar in the phone menu and the lesson contents (a position, not
decoration), chart fill patterns and the outs swatch stripes (the non-colour cue), the skeleton
shimmer (a loading state), the turn-timer ring, and the table's own material.

### 2.5 Card faces and the table

Card faces stay light in both themes, because a dark playing card is unreadable at the
sizes a six-max table needs and because inverting a card is a novelty that costs
legibility.

The cards are SVG files, one per card plus the backs, in `apps/web/public/cards/`, written by
`scripts/cards/generate.mjs` (`pnpm run cards:generate`; `cards:check` and
`scripts/cards/generate.test.mjs` fail on a stale file). Ranks and suits are paths drawn in that
script, never text, so a face does not depend on the reader's fonts. A file loaded as an image
cannot follow the theme, so the face and inks are one value for both, `--prl-deck-*` in the TABLE
AND CARDS block of `tokens.css`, which the generator reads.

| Ink | Suits | Hex | On the face `#fcfbf8` |
| --- | --- | --- | --- |
| `--prl-deck-black` | spades, clubs | `#1f1d1a` | 16.25:1 |
| `--prl-deck-red` | hearts, diamonds | `#b3262d` | 6.28:1 |

The backs are a white margin round a lattice panel; the margin is what separates a dark back from
the felt. Three are generated (charcoal, deep green, dark wine) and `back.svg` is charcoal until the
owner picks one.

**Two inks, as on a real deck, and never colour alone.** Each card carries its rank, a large suit
symbol and its `aria-label` ("ace of hearts"). The deck was four-colour with a suit letter under
the rank until November 2026, when the owner asked for the familiar red and black without the
letter. Shape is now the only visual cue between a club and a spade, or a heart and a diamond, so
the centre symbol is large and the corner index carries the suit under the rank.

### 2.6 The table surface

A flat felt oval: `--prl-felt` with a `--prl-rail` border and one faint `--prl-felt-line` inside it,
a step deeper in dark. No gradient, glow or shadow. The pot, the bet and the side pots are plain text
on the felt in `--prl-felt-ink` and `--prl-felt-ink-muted`, and an empty board place is a dashed
`--prl-felt-slot` outline. `check-contrast.mjs` asserts each of those pairs.

The felt, rail and deck colours are read only by the table and three pictures of it: the home page's
example hand, the empty table on /play, and the card-shaped brand mark in the header.
`colour-literals.test.ts` names each reader, so a page rule cannot paint a pair the gate never
measured.


## 3. Typography

### 3.1 Families

**Since 4.0: one family, Archivo, at two widths.** `@fontsource-variable/archivo` (OFL-1.1, pinned
in the lockfile and through every supply-chain gate) is imported in `layout.tsx`; Next bundles the
woff2 files and serves them from this origin, which `font-src 'self'` already permitted. `h1`, `h2`
and display figures are set at `font-stretch: var(--prl-stretch-display)` (72%) and weight 800;
body text is the same family at its normal width. Second in the stack is "Archivo Fallback"
(`packages/ui/src/styles/font-fallback.css`): local Arial scaled to Archivo's widths and metrics, so
the swap to Archivo does not reflow the page. The system stack below follows it.

The 3.0 text follows, kept for its reasoning: the rule it states was about a third-party font
request, and a self-hosted file makes none.

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

**Display / prose** — `clamp()` so it is fluid without breakpoints. The sizes below are read off
`tokens.css`; the reading end of the scale has a measured justification in the comment there
(17px body, 15px secondary, 13px hard floor, sampled against products with strong reading
typography rather than chosen by taste):

| Token | Size | Weight | Tracking | Leading | Use |
| --- | --- | --- | --- | --- | --- |
| `--prl-type-display-1` | `clamp(2.5rem, 5vw, 4rem)` | 700 | `-0.03em` | 1.05 | page hero |
| `--prl-type-display-2` | `clamp(1.875rem, 3.2vw, 2.75rem)` | 700 | `-0.025em` | 1.05 | section opener, `h1` |
| `--prl-type-display-3` | `clamp(1.375rem, 2vw, 1.75rem)` | 600 | `-0.02em` | 1.3 | section title, `h2` |
| `--prl-type-heading` | `1.375rem` (22px) | 600 | `-0.014em` | 1.2 | panel title, `h3` |
| `--prl-type-body-lg` | `1.25rem` (20px) | 400 | `-0.014em` | 1.65 | lede, Coach conclusion |
| `--prl-type-body` | `1.0625rem` (17px) | 400 | `-0.003em` | 1.65 | prose — the default |
| `--prl-type-body-sm` | `0.9375rem` (15px) | 400 | `0` | 1.65 | secondary, captions, cells |

Below `20em` (§10: a phone at 200% text) the display ramp steps down to `2rem`, `1.5rem` and `1.375rem`
for display-1, -2 and -3. A display word such as "Fundamentalist" was wider than the column there, and
Chrome never hyphenates a capitalised word. The steps stay in rem, so they still follow the reader's size.

**Tracking is a function of size, not of role**, and the ramp now says so all the way down:

```css
--prl-tracking-display-1: -0.03em;    /* 40-64px */
--prl-tracking-display-2: -0.025em;   /* 30-44px */
--prl-tracking-display-3: -0.02em;    /* 22-28px */
--prl-tracking-heading:   -0.014em;   /* 20-22px */
--prl-tracking-body:      -0.003em;   /* 17px    */
--prl-tracking-flat:       0;         /* 15px and below */
```

It used to stop at `display-3`, so a 22px panel title borrowed the value for 28px and a 17px
paragraph got nothing — over-tightened above, loose below, and the discontinuity is visible the
moment a heading sits directly on top of its lede. Below the body size the direction reverses and
the **label** tokens go positive: wide tracking is a legibility aid at small sizes and a
legibility cost once the letterforms are big enough to read on their own.

**Labels** — the technical voice:

| Token | Size | Weight | Tracking | Transform |
| --- | --- | --- | --- | --- |
| `--prl-type-label` | `0.8125rem` (13px, the floor) | 500 | `0.07em` | uppercase |
| `--prl-type-label-sm` | `0.75rem` (12px, badge beside a label) | 500 | `0.09em` | uppercase |
| `--prl-tracking-index` | applied at `--prl-type-label` | 400 | `0.12em` | tabular, mid-grey |

There is deliberately **no `--prl-type-index` size token**: the index motif is the label size with
its own tracking, and a second token holding the same number is a second thing to keep in step.

**Metrics** — oversized numbers, the reason this system exists:

| Token | Size | Weight | Tracking |
| --- | --- | --- | --- |
| `--prl-type-metric-hero` | `clamp(3rem, 7vw, 5.5rem)` | 700 | `-0.03em` |
| `--prl-type-metric-lg` | `clamp(2rem, 3.6vw, 3rem)` | 700 | `-0.03em` |
| `--prl-type-metric-md` | `1.5rem` | 600 | `-0.03em` |
| `--prl-type-metric-sm` | `1.125rem` | 600 | `-0.03em` |

### 3.3 The numeric rule — non-negotiable

**Every figure that can change uses `--prl-numeric`, and so does the document.**

```css
--prl-numeric: tabular-nums lining-nums;

body       { font-variant-numeric: var(--prl-numeric); font-feature-settings: 'tnum' 1, 'lnum' 1; }
th, td     { font-variant-numeric: var(--prl-numeric); }
.prl-number{ font-variant-numeric: var(--prl-numeric); text-align: end; }
```

Proportional digits change width as they change value, so a counting-up equity figure or a
live pot jitters horizontally. That is not a polish issue: at a poker table, a number that
moves while you are reading it is a number you misread. Tabular figures are also why a
column of stacks aligns without manual padding.

**`lining-nums` is the half that is usually forgotten.** Several faces in `--prl-font-sans`
default to *old-style* figures next to lowercase, which puts a descending `4` and a short `1` in
the middle of a stack size. `tabular-nums` alone does not fix that. Both are now stated in one
token, so a component that restates the guarantee restates all of it — every one of the 24
per-component restatements in `components.css` now reads `var(--prl-numeric)` rather than
`tabular-nums`, which is how the second half reached them.

**`th, td` restate it** even though `body` already sets it and inheritance would carry it down.
That is not redundancy: any wrapper that sets `font-variant-numeric: normal` for a legitimate
reason silently un-aligns every table below it, and the failure looks like a slightly ragged
column rather than like a bug. A column is the one place the alignment is load-bearing — a stack
of percentages that do not share a decimal position cannot be compared by eye, which is the whole
reason a reader put them in a column.

There is deliberately **no proportional counterpart token**. Tabular figures inside a sentence
are slightly gappy, and that cost is paid knowingly: this app puts live figures inside prose, and
an opt-out would eventually be applied to a paragraph whose numbers move.

Metrics are always **value + unit + label**, in that visual order, with the unit at
`--prl-type-label` beside the value and the label above it. A bare number is never shown.

---

## 4. Spacing and layout

An em/rem hybrid ramp, mirroring the reference's structure:

`--prl-space-0` 0 · `1` 0.125rem · `2` 0.25rem · `3` 0.375rem · `4` 0.5rem · `5` 0.75rem ·
`6` 1rem · `7` 1.25rem · `8` 1.5rem · `9` 2rem · `10` 2.5rem · `11` 3rem · `12` 4rem ·
`13` 5rem · `14` 6.5rem · `15` 8rem · `16` 10rem

**Section rhythm** is deliberately large, but it is measured rather than generous:
`--prl-section-y: clamp(3rem, 5vw, 5.5rem)`. This said `clamp(4rem, 9vw, 8rem)` and was wrong for
a reason worth keeping — a section pads *both* block edges and sections stack, so every seam spent
the value twice: a measured 257px of nothing on an 801px-tall viewport, which does not read as
confidence, it reads as a page that failed to load. The intended amount is now the amount at the
**seam** rather than at each edge.

**Grid.** A 12-column grid inside `--prl-container: min(100% - 2 * var(--prl-gutter), 88rem)`
with `--prl-gutter: clamp(1rem, 4vw, 2.5rem)`. Prose caps at `--prl-measure: 60ch` — not 68ch.
`ch` is the advance of `0`, which in this stack is wider than the average lowercase letter, so
`68ch` measured out at 86 characters a line, well past the ~75 where the eye starts losing the
line beginning on the return sweep. `60ch` is about 76 characters, which is the number the rule
was always about.

**Radii.** `--prl-radius-0: 0` · `-1: 3px` · `-2: 6px` · `-3: 10px` · `-pill: 999px`. Panels,
popovers and sheets use `-3`; wells and callouts `-1` or `-2`.

**`-pill` is for controls and status chips, and it used to say "status chips only".** That sentence
was written before the shell had any floating chrome in it, and the shipped product contradicted it
in four places before this revision — `.prl-pill-group`, `.prl-nav__link`, `.prl-pillbar__cta` and
`.prl-nav-trigger` are all capsules, because a floating navigation is a row of objects rather than a
strip of tabs. Leaving the rule as written produced the defect it was supposed to prevent: on the
home page the header's accent `PLAY` capsule sat directly above a 2px-radius `Start a hand`
rectangle, and in one 1440px screenshot they read as two different products.

The argument behind the old rule is preserved and is the reason the change is a capsule rather than
a rounded rectangle: **a shape must be legible as deliberate at the size it is used at.** That is
the same measurement that deleted the primary button's chamfer (§6.4) — at 100% on a 1440px
viewport the chamfer read as a corner that had failed to render. A 999px radius on a 44px control is
unambiguous at 100%; 2px is a rectangle with the corners sanded.

Controls therefore share one set of metrics, declared as `--prl-control-*` at the head of section 5
of `components.css` and spent by section 6 as well:

| | |
|---|---|
| `--prl-control-h` | `--prl-target-min` (44px) — buttons, inputs, selects |
| `--prl-control-radius` | `--prl-radius-pill` — every single-line control |
| `--prl-control-radius-block` | `--prl-radius-3` — the textarea, which cannot be a capsule |
| `--prl-control-pad-x` | `--prl-space-8` — a button's label is centred and short |
| `--prl-control-pad-field` | `--prl-space-6` — a field's content is start-aligned and can be the longest `<option>` in a `<select>` |

One set of names is what makes a row of mixed controls line up, and what stops a later change to
the shape moving the buttons without the fields.

**Borders.** `--prl-hairline: 1px solid var(--prl-line-subtle)`. Hairlines, not shadows,
are how surfaces separate.

### 4.1 No shadows

Surfaces separate by fill and hairline (§2.4). The only `box-shadow` in the app is the focus halo
(§7.1), set by `base.css` on `:focus-visible`; any other `box-shadow` in a component rule would
out-rank it and delete it, which is why `layout-guarantees.test.ts` fails one, on the table as
everywhere else.

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

### 5.0 The second family: material motion

The curves above answer *what changed* and *where did it come from*, and their timing is right
for that. It is wrong for a **surface responding to a pointer**. A pill that takes 420ms to
acknowledge a hover feels broken; 90ms with the signature curve reads as a jump cut, because
`--prl-ease-standard` spends most of its duration settling.

```css
--prl-ease-material: cubic-bezier(0.4, 0, 0.2, 1);
--prl-dur-fast: 150ms;   /* hover, active, a chip flipping state */
--prl-dur-base: 200ms;   /* a surface changing level */
--prl-dur-slow: 250ms;   /* a popover or a sheet arriving */
```

One symmetric curve, three durations in the 150–250ms band. The curve is the standard
material/HIG interpolation — fast to leave, gentle to arrive, no overshoot — and it is the right
one **precisely because it is unremarkable**. A state change should be *felt* and not *seen*; a
signature easing on a hover is a signature you have to watch. Both families collapse to 1ms under
`prefers-reduced-motion` (§5.3), in `tokens.css`, alongside the six original durations.

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
* No `filter: blur()` and no `backdrop-filter` anywhere outside the table (§2.4).
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

* A flat felt oval (§2.6). Seats are placed by a grid (`seatSlot` in `Seat.tsx`), so no seat can
  cover another or the board: portrait below 42rem of table, with the board on its own row,
  landscape from 42rem. The viewer is always bottom centre, and the oval shows at every width.
* A seat is a **small plain box**: name, stack, one status line, with the position, the dealer
  button and the turn cues beside the stack. The "Stack" label is spoken, not drawn. An opponent
  still in the hand shows two small backs inside the box; a folded seat is dashed and muted, with
  no cards.
* The **seat to act** is marked three ways at once: a second line inside its outline, the words
  "to act", and the turn-timer ring. Never by colour alone.
* The **viewer's seat** has a 2px outline, and its cards, about 58 x 81px, are fanned at -4 and +4
  degrees beside it. Board cards are about 46 x 64px.
* The **turn timer** is a conic-gradient ring animated with a single custom property, so it
  is one composited element rather than an animated SVG.
* The **pot** is a counted metric on the felt, then the bet to match this street, then the
  board, with side pots listed beneath as indexed rows (`01`, `02`).
* **Community cards** deal in with a 120ms stagger, `translateY(-8px) → 0` plus opacity.
  Under reduced motion they are simply present.

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

All four families are `--prl-control-radius` capsules on `--prl-control-h`; see the **Radii** block
in §4 for why, and for the metric tokens they share with the form controls in §6.4a.

* **Primary** — one flat accent fill on a `::before` plate, `--prl-text-on-accent` (§2.3 rule 1),
  semibold. Hover darkens the fill to `--prl-accent-fill-hover`. One per view. Filled and semibold
  where the secondary is outlined, so the primary is not told by hue (§2.2).

  The plate exists because `clip-path` clips an element's `outline` too, so the fill lives on a
  pseudo-element at `z-index: -1` and the button's own box stays unclipped, which keeps the focus
  ring whole.
* **Secondary** — `--prl-surface-raised` with `--prl-line-strong` on all four edges, which is the
  component boundary WCAG 1.4.11 asks about. Accent border and accent text on hover.
* **Ghost** — no fill, a `--prl-line-strong` edge, secondary text. Accent on hover.
* **Danger** — the secondary with `--prl-adverse` for the border and the ink. Outline only, so red
  stays a word's colour and never a fill.
* **States.** Hover moves fill and border; press is a `translateY(1px)` and a darker fill. No state
  sets `box-shadow`, because it would delete the focus halo (§4.1).
* **Disabled** — `--prl-surface-inset` with `--prl-text-disabled`, never `opacity`, which takes a
  4.5:1 label towards 2:1. `[aria-disabled="true"]` is styled beside `:disabled`, because an anchor
  drawn as a button cannot carry the attribute the pseudo-class matches.
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
  consequential and often used on a phone). The size modifiers narrow the **ink**, never the
  target: `--sm` changes padding and type size only, and `--lg` is 3.5rem rather than the 4rem it
  was — at 64px a capsule's straight section is shorter than its two end caps and the shape stops
  reading as a capsule at all. `--md` is now declared as the default metrics, because four call
  sites already wrote it against a modifier this stylesheet had never defined.

### 6.4a Form controls

Inputs, selects and the numeric field spend the same `--prl-control-*` metrics as the buttons —
same height, same radius, same 1px `--prl-line-strong` boundary — so a row of mixed controls lines
up. What separates them is **material, not shape**: a field is the recessed member of the pair
(`--prl-surface-inset`) against the button's raised one. You put something into a
field and you press a button, and that reading is also what stops a row of eight controls looking
like eight buttons.

* The **textarea** is the one control that cannot be a capsule — its second line runs straight
  through the end cap — so it takes `--prl-control-radius-block`, the same radius the material
  ladder gives a floating pane.
* The **select** keeps the platform's own arrow and gets one step more end padding than start
  padding, because the engine draws that arrow flush to the padding edge and on a capsule it
  otherwise lands inside the end cap's curve.
* The **number input** keeps its native spinners, tabular figures and end alignment: the native
  spinner already responds to arrow keys, respects `step` and is announced correctly, and a bet
  sizer is the last place to reimplement stepping.
* The **range** is a capsule track with a circular thumb at the full 44px target, and the track
  grew one step so the knob is not a ball resting on a wire.
* **Disabled is stated rather than inherited.** A field with no `:disabled` rule keeps its
  `--prl-line-strong` boundary, which says "you may type here" at the one moment you may not.

### 6.5 Metric blocks

The workhorse. `label` above, `value` + `unit` on the baseline, optional `delta` and
`note` beneath.

```
Equity                     ← --prl-type-label, --prl-text-muted
41.2 %                     ← --prl-type-metric-lg, tabular; unit at --prl-type-label
+7.9 pts over break-even   ← --prl-type-body-sm, semantic colour + explicit sign
```

Deltas always carry an explicit `+`/`−` **and** a word, never colour alone.

---

## 7. Accessibility (WCAG 2.2 AA)

| Requirement | How |
| --- | --- |
| 1.4.3 Contrast | Every pairing measured, §2.3. Worst body text 4.68:1 dark, 5.24:1 light; worst semantic text 5.41:1 (light `caution`); worst suit 4.75:1 (§2.5) |
| 1.4.11 Non-text contrast | Meaningful borders use `--prl-line-strong` (3.40:1 dark, 3.38:1 light, worst surface) or the accent |
| 1.4.1 Use of colour | Every semantic colour paired with a sign, glyph, label or pattern |
| 2.1.1 Keyboard | Everything operable. Bet sizing is a slider **plus** a number input |
| 2.4.7 Focus visible | Two-tone: `outline: 2px solid var(--prl-focus-color)` at `outline-offset: 2px`, plus a 1px `--prl-focus-halo` of the opposite polarity. 11.91:1 on the dark page ground and 9.11:1 on the light one, and proved against *every* backdrop — §7.1. `:focus-visible`, never `:focus`, and **never removed** |
| 1.4.3 on composited stacks | Every element carrying text has its ancestors composited and measured in real Chrome, both themes, every route — §7.3 |
| User preference | Nothing is translucent, so `prefers-reduced-transparency` needs nothing; `prefers-contrast: more` promotes every hairline — §7.2 |
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

### 7.1 The focus ring has two tones

A single-colour ring is only as visible as its contrast with what is behind it, and the offset puts
most of its width on the backdrop: an accent fill, a card face, a chart. So the indicator is the
`--prl-focus-color` outline plus a 1px `--prl-focus-halo` of the opposite polarity, drawn as
`box-shadow: var(--prl-focus-ring)` by `base.css` on `:focus-visible`, filling the offset gap and
the pixel outside the outline.

The gate proves it in closed form. A colour of luminance `Lf` clears 3:1 against a backdrop `Lb`
unless `Lb` is inside one open interval, and the indicator fails only where both intervals meet:

| Theme | Ring fails only for | Halo fails only for | Overlap |
| --- | --- | --- | --- |
| dark (`#a6dcbf` / `#161412`) | `L ∈ (0.177, 1.992)` | `L ∈ (−0.031, 0.121)` | **empty** |
| light (`#174a33` / `#ffffff`) | `L ∈ (−0.016, 0.260)` | `L ∈ (0.300, 3.100)` | **empty** |

The halo is clipped by `overflow: hidden` and not painted under `forced-colors`; the outline stays
the primary tone in both cases. No other rule sets `box-shadow` (§4.1), so nothing can delete it.

### 7.2 Increased contrast and forced colors

Handled in `tokens.css`, so no component needs an override. **`prefers-contrast: more`** promotes
`--prl-line-subtle` and `--prl-line` to `--prl-line-strong` and widens the focus ring from 2px to
3px. **`forced-colors: active`** maps every line token to `CanvasText` and the focus colour to
`Highlight`; each component restates any state it showed only by fill. There is no translucency
left to remove, so `prefers-reduced-transparency` changes nothing.

### 7.3 Contrast is measured on the composited background, not on a token pair

A pair is two colours. A reader meets a **stack** — a tint over a tint over a gradient, with an
`opacity` somewhere in the middle — and §2.3 cannot express one. `pnpm run design:contrast` closes
that by walking the ancestor chain of every element carrying text, in real Chrome, on every route
in both themes, compositing every layer the way a browser does (source-over in sRGB, as nested
opacity groups, including each positioned `::before`/`::after` that covers the text — the plate
under every seat at the table is an `::after`) and measuring the glyph against the result.

Where the walk cannot finish it says so rather than guessing:

| Verdict | When | What is asserted |
| --- | --- | --- |
| **exact** | the walk reached an opaque fill, or the page ground, with every layer a colour | the composited ratio |
| **bounded** | the stack was still translucent when it crossed a floating or `backdrop-filter` element, or crossed a gradient | the **worse** of black and white behind it, and for a gradient the worst of its stop path |
| **unmeasured** | a layer that is not a colour at all — a `url()` image, `background-clip: text`, a `mix-blend-mode` | nothing, and the run **fails**: an unmeasurable background under real text is the blind spot this pass exists to remove |
| **exempt** | a disabled control (1.4.3 exempts inactive components) | nothing; measured and printed |

The arithmetic is not trusted. A sample of rows is **probed against a real screenshot**: a 5×5
patch is captured at a point inside the element that no glyph, no child box and no rounded corner
covers, the painted pixel is compared with the prediction, and the ratio is re-measured on the
pixel itself. On the current tree that is **10,884 text elements over 38 pages, and 145 probes of
which every one agreed** — 99 matching the predicted composite exactly and 46 landing inside a
bounded row's envelope. A probe that disagrees where no `box-shadow` can reach is a failure of the
gate itself: the model has stopped predicting Chrome.

**What this does not cover:** hover/focus/active states and per-element borders (asserted at the
token layer, §2.3 and §7.1), `box-shadow` (a drop shadow paints over the surface *behind* the
element casting it; every probe records whether one can reach it), and text overlapped by a
non-ancestor sibling.

**This pass once corrected a figure in `play.css`.** The comment above `.prl-seat--folded` declines an
`opacity` on folded seats. It once quoted `0.9 → 4.09:1` and `0.8 → 3.10:1`, which interpolated the
two *luminances*; a browser composites `opacity` in gamma-encoded sRGB, which is what this gate does
and what its probes confirm pixel-for-pixel. The comment now carries the composited figures
(5.95:1, 4.74:1, 3.79:1), measured under 3.0: the 0.9 step does not breach AA and the 0.8 step
does. Re-measure them before relying on either step in 4.0.

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

* Sticky header on the opaque page ground with a `--prl-line` hairline underneath, promoted to
  `--prl-line-strong` past 40px of scroll (an attribute toggled by `IntersectionObserver` on a
  sentinel — no scroll listener). §9.3.
* Current destination: accent fill, semibold **and** `aria-current="page"`.
* **The theme switch** — Light, Dark, System, three native radios in a fieldset named "Colour
  theme" — sits in the header bar from 860px and in the menu sheet below it, so exactly one copy is
  rendered. System is the default; a choice is saved under `prl-theme` in `localStorage` and applied
  before first paint. The checked word takes the accent fill and semibold weight, so the state is not
  colour alone; arrow keys move between options.
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

### 9.2 The app-shell tokens

§11 rule 1 forbids one-off values, so the numbers §9 states in prose are declared as tokens. They
live in `apps/web/src/app/globals.css` rather than in `tokens.css`, because they describe the
**shell** rather than the system — no component outside that file and `nav.css` has any use for
them, and promoting them would invite one.

| Token | Value | What it implements |
| --- | --- | --- |
| `--prl-shell-nav-fill` | `var(--prl-surface-inset)` | The fill for a control in the bar — the navigation pill, the units readout, the menu trigger, the theme switch — one step down from the page, so they read as controls on a strip |
| `--prl-shell-sentinel` | `var(--prl-space-10)` (2.5rem = 40px) | The scroll distance after which the header's edge is promoted, expressed as the **height of a sentinel element** rather than as a number in a JavaScript comparison |

The sentinel is the point of the second one. An `IntersectionObserver` watching a 40px-tall
absolutely-positioned element at the top of the document reports the same fact a
`scroll` handler would, off the main thread and only when the answer changes (§5.4) — and the
threshold stays in the token system instead of becoming a literal in a comparison.

### 9.3 The header strip is opaque

Headings scrolled under a translucent bar stay legible as a second layer of type in the wrong place
(the 3.0 "ghosting" bug). 4.0 answered it with a blur; 5.0 answers it with no translucency at all.
The bar is `--prl-surface-page`, its pills `--prl-shell-nav-fill` with a hairline, and nothing under
it can read through. The bar holds one row from 860px — 77px tall at every 20px from 860 to 1440 with
"How to use", the theme switch and a 999,999 balance in it — which `--prl-pillbar-h` and the root
`scroll-padding` assume, and `test:keyboard` fails a wrap at 860, 900, 960, 1024, 1280 and 1440. The
suit marks left the bar to make that row fit (§2.2). Below 1280 the navigation links, the gaps, Play
and the units pill each give up one step of padding, and below 960 "How to use" is its `?` mark with
the words as its name; without those steps it wrapped to 129px at 860 and 900px.

**Also of note:** a 2px rule is written as `var(--prl-space-1)` (0.125rem), never as
`var(--prl-focus-width)`. Both resolve to 2px and only one of them means it; borrowing the focus
token as a generic length is how a later change to the ring's weight silently thickens an
unrelated marker. `components.css` already uses `--prl-space-1` this way on `.prl-error`.

---

## 10. Responsive

Every viewport breakpoint is written in `em` (the px below divided by 16, so 600px is `37.5em`), in the
stylesheets and in the `matchMedia` strings that mirror them, and `apps/web/test/em-breakpoints.test.ts`
fails a px one. A media query's `em` is the reader's text size, so at the default size each range lands
on the pixel shown here, and at 200% text a 1440px window takes the 720px layout.

| Range | Layout |
| --- | --- |
| < 600px | single column; table stacks vertically; Coach becomes a bottom sheet with a drag handle. The Lab filters pair Difficulty and Street from 380px, and stack all three below it |
| 600–899px | two-column content; table still stacked; Coach in a full-width panel below |
| 900–1279px | table in oval form once the column itself passes 46rem; Coach in a right rail at 22rem |
| ≥ 1280px | 12-column grid; table centred with Coach rail and the decision band in the same viewport, no scrolling during a decision |

Two narrower ranges exist for large text. Below `20em` (a window under 320px at the default size, under
640px at 200%):

- **Paired items stack.** A lesson card's number goes above its text, an assumption's index above its
  sentence, a quiz radio above its answer and a Legends sigil above the names. The glossary's related
  terms, the Legends contrast list, the home spot figures and the review summary take one track. The
  equity readout's figures go under the name.
- **Nested padding gives way.** These keep `0.375rem` a side:
  - the lesson sheet;
  - `.prl-panel`, `.prl-callout`, `.prl-formula` and `.prl-assumptions` (the lesson calculators);
  - a glossary entry and its formula;
  - the Coach with its sections, suggestion, uncertainty note and stats. Its lists indent `0.75rem`.

  Legends cards, compare columns, decisions, difficulty frames and picker options pad `0.5rem`.
  Disclaimers pad `0.75rem`.
- **The bet sizer fits.** The action bar, the sizer, its controls, field and slider may shrink. The
  field wraps and the number field is never wider than it. The bar and the sizer keep `0.375rem` a side.
- **The display ramp steps down** (§3.2), and a Legends card's or compare column's name takes
  `body-lg`. A hand review's heading keeps its size, so it stays above its decisions.
- **Only an assumption's text may hyphenate.** Without it, "measurement" and "combinations" break
  mid-word. Nothing else needs it. `test:layout` measures its 360px cell at 200% with hyphenation off,
  because CI's Chrome may have no hyphenation dictionary.

Below `18em` a review row card and the deck-proof terms give each value its own row, and a review
board's cards wrap. One container query does the same for the Legends difficulty picker: below `15rem`
of its own width the radio takes a row above the name. A default-size window of 320px or wider reaches
none of these.

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
3. **Flat, always.** No shadow but the focus halo, no `backdrop-filter`, no translucent pane, no
   gradient wash, no coloured edge bar. Separate surfaces with a fill step and a hairline (§2.4);
   `packages/ui/test/layout-guarantees.test.ts` fails the first four.
4. **Native CSS only.** No Tailwind, no CSS-in-JS, no preprocessor, no animation library.
   The supply-chain policy makes every dependency a reviewed event; a utility-class
   framework is not worth one.
5. **No remote assets.** No fonts, scripts, images or stylesheets from another origin. The
   CSP forbids it and so does this document.
6. **Information beats aesthetics, always.** If a layout is prettier without the confidence
   interval, the layout is wrong.
7. **Test both themes and both motion settings.** Four combinations, all of which must be
   legible and usable, plus `prefers-contrast: more` (§7.2).
8. Run **`pnpm run verify`** before claiming done. It is the release gate and it is the whole
   list: sixteen gates including `lint`, `typecheck`, `build`, `test`, `design:contrast` and
   `test:a11y`, each reported `PASS`/`FAIL`, all of them run even after one fails. (This said
   *eleven*, which was the count when the line was written; the loop in `package.json` has since
   gained `test:ax`, `test:csp` and `test:age-gate`, and that loop is the authority.) The `&&`
   chain this line used to give stopped at the first failure and omitted `design:contrast` — the
   gate that checks the contrast ratios this document claims — so it could report success on a
   build that broke them.

---

## 12. What is deliberately absent

* **Shadows, blur, glass and washes.** The only shadow is the focus halo (§4.1, §2.4).
* **Blue.** Nowhere (§2.1).
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

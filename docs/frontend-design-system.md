# Poker Risk Lab — Frontend Design System

**Version:** 3.0 (dark-primary, material ladder) · **Last reviewed:** 2026-08-26

> **What changed in 3.0.** §2.7 is new: a five-level material ladder with translucent levels,
> elevation tokens and a lit hairline, replacing "one step on the surface ramp plus a hairline".
> §7.1 is new: the focus ring is two-tone, because a single-colour ring on a floating pane is only
> as visible as a backdrop this stylesheet does not own. §7.2 is new: `prefers-reduced-transparency`
> and `prefers-contrast: more`. §3.2, §4 and §4.1 had drifted from `tokens.css` and are corrected
> against it. Every ratio here is reproduced by `node scripts/check-contrast.mjs`.

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

The page ground now also carries **the wash** (§2.7) — two very low-alpha radial fields, which
is what gives a translucent pane something worth showing through. A gradient has no single
colour to assert, so what is asserted is its worst case: `--prl-wash-tint` is the brightest stop
either gradient reaches, and the gate composites it over the page ground and measures the result
as a content surface called `wash` alongside the flat ones. It costs almost nothing — primary
text 16.38:1, `text-faint` 5.84:1 — because the tint is 7%. If a stop is ever made brighter, the
token moves and every pairing in the table above is re-measured against it automatically.

Where the wash is actually painted is the app shell's business rather than the package's, and it
is **not** the `<body>` rule in `base.css`: that copy is switched off by `globals.css` and the
field is drawn once as a viewport-fixed layer instead, so a pane four screens down a document
still has something varying behind it. The stops are the same two tokens, deliberately, so the
`wash` surface measured here remains the true ceiling of the page ground. §9.3 has the geometry
and the worst-case arithmetic.

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

**The gate reports three layers, and the differences matter.** `pnpm run design:contrast` measures
`tokens.css` alone (what this document claims), then `tokens.css` + `base.css` (the pairings a
component may use), and then **the composited background of every piece of text the app actually
paints, in real Chrome** (§7.3). A failure in the first is a defect in the token set; a failure in
the second is a defect in the pairings; a failure in the third is a defect a reader would meet on a
screen, and the first two cannot see it, because a translucent stack has no token pair. **All three
currently pass, and the gap between the first two is zero** — which is the state to keep them in,
because a repair layer in `base.css` is a second place to look for the value a browser paints.

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

### 2.7 Materials — the depth ladder

**What this replaced.** §4.1 used to say there were no shadows and no blur, and that depth was
"one step on the surface ramp plus a hairline". The performance reasoning behind that is correct
and is preserved below unchanged. What was wrong was the conclusion: one step on a ramp plus a
hairline is not an elevation system, it is **one card style**, and one card style cannot tell a
panel holding prose apart from a toolbar travelling over content or a popover floating above
both. Everything in the app read as the same object at the same height.

There are now five levels. Each step changes **material**, **elevation** and **border luminance**
together — changing only the fill is what makes an interface look like cards stacked on cards.

| L | Name | Material | Edge | Elevation | What it is for |
| --- | --- | --- | --- | --- | --- |
| 0 | page | `--prl-surface-page` + `--prl-page-wash` | none | none | the ground. Nothing sits *on* it; things float *over* it |
| 1 | grouped | `--prl-surface-raised` | `--prl-edge` | **none, deliberately** | a well that collects related rows. What separates it from L2 is the *absence of elevation*, not the fill — an unshadowed pane reads as part of the page. In light it is white on a grey ground, so it is not a recess and is not meant to be |
| 2 | raised | `--prl-surface-panel` | lit hairline | `--prl-elevation-1` | **the card, and where body text lives.** Opaque on purpose |
| 3 | floating | `--prl-glass-floating` + blur | lit hairline | `--prl-elevation-2` | bounded chrome that travels over content: pills, toolbars, chips, the action bar |
| 4 | overlay | `--prl-glass-overlay` + strong blur | lit hairline | `--prl-elevation-3` | popovers, menus, sheets. May carry body text |
| 5 | modal | `--prl-scrim` + the L4 material | lit hairline | `--prl-elevation-4` | a modal dialog. The scrim is what makes it modal |

Classes: `.prl-material` plus `--grouped` / `--raised` / `--floating` / `--overlay` / `--modal`,
with `--interactive` adding the pointer states. `.prl-panel` **is** level 2 and needs no class.
`.prl-panel--floating` and `--overlay` promote it.

**Restraint is part of the definition.** Glass is for *floating, bounded* surfaces. Body text
sits on solid surfaces — long prose over a backdrop that varies is a legibility problem no amount
of tint solves. A wall of glass is worse than no glass.

#### 2.7.1 Blur **and saturate**, and why the second half is not optional

```css
--prl-glass-filter:        blur(20px) saturate(180%);
--prl-glass-filter-strong: blur(30px) saturate(180%);
```

Blur alone averages a backdrop towards grey, which reads as **fog**. Pushing saturation back past
100% restores the chroma the averaging removed, and that is what makes a pane read as a tinted
sheet of glass rather than as a dirty window. Most imitations of this look drop the saturation and
then wonder why the result looks cloudy.

**Wherever a glass fill goes, the filter goes with it — in the same block, every time, including
in a `:hover` block whose base rule already set it.** This is the ghosting bug from the header
comment in `apps/web/src/styles/nav.css`, stated as a rule: a 92%-opacity header with no
`backdrop-filter` let the headings underneath read straight through it as a second, perfectly
legible layer of text in the wrong place. Blur+saturate is the legitimate fix precisely because it
destroys the *legibility* of the backdrop while keeping its colour; opacity alone destroys
neither. `packages/ui/test/layout-guarantees.test.ts` fails any block in `packages/ui` or
`apps/web` that sets a glass fill without the filter, and the guard was watched failing against a
deliberately blur-less rule before it was believed.

Restating the filter costs nothing at runtime: it is the same value re-declared, not re-computed.

#### 2.7.2 The contrast floor for glass, and how it is established

**A translucent surface does not have a contrast ratio. It has a range of them, one per backdrop,
and the range is unbounded until something bounds it.** This is the point at which most design
systems that adopt translucency quietly stop measuring.

It is bounded here by construction rather than by convention. Nothing any display can paint is
outside `[#000000, #ffffff]`, so **every glass tint is composited over both extremes and the
worse of the two is the ratio this system claims** — declared in the stylesheet as
`--prl-glass-backdrop-min` / `-max` so the claim lives with the tokens. A ratio that holds at both
holds over a playing-card face, an accent fill, a chart, a photograph, and over whatever is added
next year, with no rule to remember about where glass may float.

Which extreme binds **flips with the theme**, which is why this is automated rather than
eyeballed: dark paints light text on a dark tint, so its enemy is a bright backdrop lifting the
composite; light paints dark text on a light tint, so its enemy is a dark backdrop pulling it
down. Measuring one extreme passes one theme and misses the other.

That is why the tints are as opaque as they are. At 90% the pass-through is 10% of a *blurred,
180%-saturated* backdrop: enough colour to read as material, little enough structure to be safe.

**Worst-of-both-extremes, dark theme** (`node scripts/check-contrast.mjs` prints all of it,
including the per-extreme figures):

| On | `text` | `secondary` | `muted` | `faint` | `adverse` | `line-strong` | `focus-color` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| L3 floating `rgb(18 21 27 / 90%)` | 12.88 | 9.14 | 6.51 | **4.59** | 5.61 | 3.12 | 9.16 |
| L3 hovered `rgb(26 30 38 / 94%)` | 12.94 | 9.18 | 6.53 | **4.61** | 5.64 | 3.13 | 9.20 |
| L3 pressed `rgb(33 38 48 / 97%)` | 12.76 | 9.06 | 6.45 | **4.55** | 5.56 | 3.09 | 9.08 |
| L4 overlay `rgb(11 13 17 / 92%)` | 15.02 | 10.66 | 7.59 | 5.36 | 6.54 | 3.63 | 10.69 |
| L4 hovered `rgb(20 24 30 / 95%)` | 14.40 | 10.22 | 7.27 | 5.14 | 6.27 | 3.48 | 10.25 |

**Worst-of-both-extremes, light theme** (`faint` collapses onto `muted` in light, §2.4b):

| On | `text` | `secondary` | `muted` | `favourable` | `line-strong` | `focus-color` |
| --- | --- | --- | --- | --- | --- | --- |
| L3 floating `rgb(255 255 255 / 94%)` | 16.21 | 8.52 | 5.60 | **4.68** | 3.93 | 9.33 |
| L3 hovered `rgb(248 250 252 / 96%)` | 16.17 | 8.50 | 5.59 | 4.67 | 3.92 | 9.31 |
| L3 pressed `rgb(240 244 248 / 97%)` | 15.70 | 8.26 | 5.43 | **4.53** | 3.81 | 9.04 |
| L4 overlay `rgb(255 255 255 / 96%)` | 16.94 | 8.91 | 5.86 | 4.89 | 4.11 | 9.76 |
| L4 hovered `rgb(248 250 252 / 97%)` | 16.59 | 8.73 | 5.74 | 4.79 | 4.02 | 9.56 |

Text floor 4.5:1, non-text floor 3:1. **The whole content text ramp is permitted on glass**,
`--prl-text-faint` included — but that is a measured result and it was not the first answer. At
the tints this started with, `faint` landed at 4.00:1 over the bright extreme and was excluded in
prose. The tints then had to get more opaque for an unrelated reason (`--prl-line-strong` on a
hovered pane fell to 2.71:1), and the gate's negative control reported that the exclusion had gone
stale. It is asserted now instead of written down. **`faint` at 4.55:1 has the least headroom of
anything in the system and is the row that fails first if a tint is ever made more transparent.**

The negative control that reported it now holds `--prl-line` and `--prl-line-subtle`, which are
decorative *by definition* (§2.4 rule 2) and measure 1.03–1.99:1 on glass. Those cannot become
vacuous by accident: if the palette ever lifted them past 3:1 they would still not be allowed to
carry meaning.

#### 2.7.3 The interactive states, and why they get *more* opaque

On an opaque surface a state is a colour change. On glass the obvious move — brighten the tint —
erodes the contrast floor from underneath every piece of text on the pane, and it did: the first
hover tint here took `--prl-line-strong` to 2.71:1.

So the states move **opacity** as well as lightness. Hovering firms the glass (90% → 94%),
pressing firms it further (→ 97%) and drops the pane one elevation level with a 1px
`translateY`. That is the physical reading of a press, and it is the direction that protects the
floor rather than spending it. Every state above is measured over both extremes.

**Disabled drops a level; it never fades.** `opacity` on a disabled pane is wrong twice over
here: it fades the text with the surface, taking a 4.5:1 label towards 2:1, *and* on a translucent
pane it lets more of the backdrop through, so the control gets less legible in exactly the
proportion the backdrop is busy. The material collapses to the opaque level below — flat,
unblurred, unelevated — which is a disabled control's honest description.

#### 2.7.4 Elevation, and the performance rule that survived

```css
--prl-elevation-1: 0 1px 2px rgb(0 0 0 / 24%), 0 2px 8px rgb(0 0 0 / 18%);
--prl-elevation-2: 0 2px 6px rgb(0 0 0 / 28%), 0 10px 24px rgb(0 0 0 / 26%);
--prl-elevation-3: 0 4px 12px rgb(0 0 0 / 32%), 0 20px 48px rgb(0 0 0 / 36%);
--prl-elevation-4: 0 8px 24px rgb(0 0 0 / 36%), 0 36px 80px rgb(0 0 0 / 48%);
```

Two shadows per level, because one cannot do both jobs: a short, tight, higher-alpha shadow is the
**contact edge** that says the pane is a physical object, and a long, wide, lower-alpha one is the
**ambient occlusion** that says how far above the page it is. A single blurred shadow reads as a
glow. Light-theme alphas are roughly a fifth of these — on a light ground, a dark-theme shadow
does not read as height, it reads as dirt.

The old rule's reasoning is kept and made enforceable:

* **Nothing on the table field takes a shadow or a blur.** Six seats, community cards and a live
  Coach panel are exactly the scene the original objection was about.
* **Blurred regions stay bounded, and there is exactly one exception.** `backdrop-filter` goes on
  pills, chips, popovers and sheets — elements that are small, already promoted to their own layer
  (`isolation: isolate`), and static. Never a page background, and never a second full-width strip.
  The one that exists is the app-shell header (§9.3): a 92px `position: sticky` bar, promoted by
  the filter itself, re-composited rather than re-laid-out as the page scrolls, and carrying the
  blur because the ghosting bug this system was built around is a **legibility** failure that only
  a blur fixes. That is a different scene from the objection this rule comes from, which is the
  table field — six seats, community cards and a live Coach panel all repainting under a blurred
  layer. If a second full-width blur is ever proposed, it needs its own version of that argument;
  the exception is one element, not a category.
* **`backdrop-filter` is never animated or transitioned.** It is re-evaluated against the entire
  backdrop on every frame it changes, which is the one way to turn a cheap bounded blur into an
  expensive one. It is absent from every `transition` list in the package.
* **A shadow is never a literal.** Every `box-shadow` value must be built from
  `--prl-elevation-*` and `--prl-focus-ring`. This is a *tighter* rule than the "no `box-shadow`
  at all" it replaced, not a looser one: the old rule never had to forbid an ad-hoc
  `0 2px 8px rgba(...)` because no shadow was allowed anywhere, and this one does.

#### 2.7.5 The lit hairline

A pane reads as a physical sheet when its top edge catches light and its bottom edge falls into
shadow — one border, three colours, applied per side:

```css
border: 1px solid var(--prl-edge);
border-block-start-color: var(--prl-edge-lit);
border-block-end-color: var(--prl-edge-shade);
```

A border rather than an inset shadow, so it survives `forced-colors`. These are **decorative** in
exactly the sense `--prl-line-subtle` is (§2.4 rule 2): they draw an object's edge, never its
meaning. A border that carries meaning is still `--prl-line-strong` or the accent.

#### 2.7.6 The wash

```css
--prl-wash-tint: rgb(23 198 219 / 7%);   /* light theme: rgb(10 98 116 / 6%) */
```

Two radial fields over the page ground. Without them the material system above is invisible: a
translucent pane over a flat colour is a slightly different flat colour. It is `background-repeat:
no-repeat` and `background-attachment: scroll` — **not** `fixed`, which re-resolves the background
against the viewport on every scroll frame and is precisely the per-frame repaint this system
avoids everywhere else. Scrolled, it is painted once into the page's own layer.

It resolves to `none` under `prefers-reduced-transparency`, `prefers-contrast: more` and
`forced-colors`, so no rule needs an override for it. Measured as a surface: §2.4.

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

**Radii.** `--prl-radius-0: 0` · `-1: 2px` · `-2: 4px` · `-3: 8px` · `-pill: 999px`.
Near-square is the default for SURFACES. **The material ladder uses `-3` for levels 3 and 4** — a
floating pane is a physical object with a rounded edge and a lit hairline, and at `-1` the hairline
reads as a mitre rather than as a bevel.

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

### 4.1 Shadows are tokens, and only tokens

**This section is superseded by §2.7, and the change is recorded rather than overwritten.** It
used to read:

> There is no `--prl-shadow-*` token, deliberately. Depth comes from moving one step on the
> neutral ramp plus a hairline. As shipped, `packages/ui` and `apps/web` contain zero
> `box-shadow` declarations — not one, not even for focus.

The performance argument under that is correct and is preserved verbatim in §2.7.4: large blurred
layers on a table with six seats, community cards and a live panel are exactly what costs frames
on a mid-range laptop. What did not follow from it was a *system* — "one step on the ramp plus a
hairline" gives one card style, and the app read as a single object repeated at a single height.

What replaced the blanket ban is a narrower rule with more teeth: **a shadow may only be spent
through `--prl-elevation-0..4` or `--prl-focus-ring`, never as a literal**, checked by
`packages/ui/test/layout-guarantees.test.ts` across `packages/ui` *and* every `apps/web`
stylesheet. The old rule never had to forbid an ad-hoc `0 2px 8px rgba(...)` in a component,
because no shadow was allowed anywhere; this one does.

The focus ring is still an `outline` and for the same reasons (§7): it does not participate in
layout, is not clipped by `overflow: hidden`, and is replaced wholesale under `forced-colors`.
What it gained is a second tone, as a `box-shadow`, which is a *supplement* — see §7.1.

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
* No `filter: blur()` on anything that animates, and no `backdrop-filter` on a large surface —
  see §2.7.4 for what "large" means now that the material ladder uses one, and for the single
  full-width exception the app-shell header is. **`backdrop-filter` is
  itself never animated or transitioned**, in either direction: it is re-evaluated against the
  entire backdrop on every frame it changes, and it appears in no `transition` list in the
  package. A pane that needs to arrive animates `opacity` and `transform`, with the filter already
  in place.
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

All four families are `--prl-control-radius` capsules on `--prl-control-h`; see the **Radii** block
in §4 for why, and for the metric tokens they share with the form controls in §6.4a.

* **Primary** — accent fill on a `::before` plate, `--prl-text-on-accent` (§2.4 rule 1,
  §2.4a — the pairing inverts with the theme), `--prl-elevation-1`, and a **sheen**: one stop of
  `--prl-veil-8` at the top of the plate, reaching `transparent` before the halfway line. One per
  view.

  The chamfer is gone. It was a 2px diagonal cut on the top-right corner, judged at 100% on a
  1440px viewport, and at that size it read as a corner that had failed to render rather than as a
  signature — it looked deliberate only at 400%, which is the trap. It was also applied to the
  primary and not the secondary, so a side-by-side pair showed one notched rectangle beside one
  plain one. The `::before` plate survives it: `clip-path` clips an element's `outline` too, so the
  fill lives on a pseudo-element at `z-index: -1` and the button's own box stays unclipped, which is
  what keeps the focus ring whole.

  **The sheen cannot move a measured ratio, and that is why it is spent through `--prl-veil-8`.**
  The veil flips with the theme — `rgb(244 246 248 / 8%)` on dark, `rgb(16 20 26 / 6%)` on light —
  so it lightens a bright fill carrying near-black ink and darkens a dark fill carrying white ink.
  Contrast rises in both themes, and the untinted rest of the plate is exactly `--prl-accent-fill`,
  the value `scripts/check-contrast.mjs` asserts at 9.39:1 dark / 6.97:1 light. The obvious
  `rgb(255 255 255 / 8%)` improves dark and erodes light; this is the trap the token avoids.
* **Secondary** — **L3 `floating` glass**: `--prl-glass-floating` with `--prl-glass-filter`,
  `--prl-elevation-1`, and `--prl-line-strong` on all four edges. It was `background: transparent`
  plus a hairline, which is a drawn rectangle rather than an object, and beside a filled primary it
  read as absent rather than as subordinate. This family has no fill of its own to identify it, so
  its border is the component boundary WCAG 1.4.11 is about and cannot take the primary's lit
  hairline — every edge stays `--prl-line-strong`, which the gate asserts on all three floating
  tints. Accent border and accent text on hover.
* **Ghost** — text only: no fill, no border, no elevation. Subordinate by having none of the three
  rather than by being a faint copy of the secondary. Accent on hover.
* **Danger** — the secondary's glass with `--prl-adverse` for the border and the ink, so a
  destructive control is recognisably the same object as the control beside it and differs only in
  its colour and its word. Outline-only in both themes: a filled `--prl-adverse` cannot carry
  legible text, because the light theme's rose is dark and neither ink-900 nor white clears 4.5:1
  on it.
* **States.** Hover moves fill and border; **press is a `translateY(1px)` and a darker fill, never
  an elevation change.** `box-shadow` is one property, so a hover or active rule at (0,3,0) that set
  an elevation would out-rank the `:focus-visible` rule at (0,2,0) that restates the focus halo, and
  hovering a keyboard-focused button would silently delete half of its focus indicator. Elevation is
  set once per family and restated beside the ring — `box-shadow: var(--prl-focus-ring),
  var(--prl-elevation-1)`, ring first, because shadows paint in list order.
* **Disabled** collapses to the opaque level below — flat, unblurred, unelevated, sheen removed,
  `--prl-surface-inset` — never `opacity`. Fading a translucent control fades its label with the
  surface AND lets more of the backdrop through, so it gets less legible in exactly the proportion
  the backdrop is busy. `[aria-disabled="true"]` is styled beside `:disabled`, because an anchor
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
(`--prl-surface-inset`, no elevation) against the button's raised one. You put something into a
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
| 2.4.7 Focus visible | Two-tone: `outline: 2px solid var(--prl-focus-color)` at `outline-offset: 2px`, plus a 1px `--prl-focus-halo` of the opposite polarity. 12.77:1 on the page ground, and proved against *every* backdrop — §7.1. `:focus-visible`, never `:focus`, and **never removed** |
| 1.4.3 / 1.4.11 on glass | Every material tint measured over both bounding backdrops, worse of the two asserted — §2.7.2 |
| 1.4.3 on composited stacks | Every element carrying text has its ancestors composited and measured in real Chrome, both themes, every route — §7.3 |
| 1.4.12 / user preference | `prefers-reduced-transparency` and `prefers-contrast: more` both drop translucency for solid fills — §7.2 |
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

### 7.1 The focus ring had to gain a second tone, and glass is why

A single-colour ring is only ever as visible as its contrast with **what is behind it**, and
`--prl-focus-offset` deliberately puts most of the ring's width on the backdrop rather than on the
control. On a page of opaque panels that is fine. On a floating pane it is not, because the
backdrop is not something this stylesheet owns: `accent-300` measures **1.52:1 against white**. On
a pill lying over a playing-card face, the ring is not dim — it is absent.

So the indicator is two-tone:

```css
--prl-focus-halo: var(--prl-ink-900);   /* light theme: #ffffff */
--prl-focus-ring: 0 0 0 calc(offset + width + 1px) var(--prl-focus-halo);
```

The accent outline, plus a hairline of the opposite polarity immediately **outside** it and
filling the offset gap immediately **inside** it — so both adjacencies carry the guarantee, which
is what 1.4.11 actually asks for.

**The claim is arithmetic, not aesthetic, and the gate proves it in closed form** rather than by
sampling. A foreground of relative luminance `Lf` clears 3:1 against a backdrop of luminance `Lb`
when `Lb ≤ (Lf + 0.05)/3 − 0.05` or `Lb ≥ 3(Lf + 0.05) − 0.05`, so each colour fails only strictly
inside one open interval. The indicator is defeated exactly where the two intervals intersect:

| Theme | Ring fails only for | Halo fails only for | Overlap |
| --- | --- | --- | --- |
| dark | `L ∈ (0.180, 2.018)` | `L ∈ (−0.032, 0.112)` | **empty** |
| light | `L ∈ (−0.017, 0.246)` | `L ∈ (0.300, 3.100)` | **empty** |

There is no backdrop in `[0, 1]` against which both tones disappear.

The halo is a `box-shadow`, which means it is clipped by an ancestor's `overflow: hidden` and not
painted under `forced-colors`. Both are accepted rather than hidden, because it is a
**supplement**: in either case the indicator degrades to exactly the outline it was before, which
is why the outline is still the primary tone. `box-shadow` is one property, so any rule giving an
element an elevation must restate the ring beside it while focused —
`box-shadow: var(--prl-focus-ring), var(--prl-elevation-2)`, ring first because shadows paint in
list order — or the pane drops a level for as long as the keyboard is on it.

### 7.2 Reduced transparency and increased contrast

Two stated preferences, handled in `tokens.css` so no component needs an override.

**`prefers-reduced-transparency: reduce`.** Translucency plus blur is a real cost for readers with
low vision, migraine or vestibular sensitivity, which is why the switch is under Accessibility on
macOS and iOS. Every glass tint collapses to the opaque surface one level below it, both filters
go to `none`, and the wash goes to `none`. This is not a degraded fallback: it is the state this
system was in before glass existed, and every ratio it produces is already asserted in §2.4.
`--prl-glass-filter: none` is what makes the collapse complete — an opaque fill with a live
`backdrop-filter` still *pays* for a blur nobody can see through.

**`prefers-contrast: more`.** A superset, written out in full rather than referencing the block
above, because a reader can ask for one preference without the other and a `var()` chain between
two media queries resolves in cascade order rather than in the order the preferences were stated.
Everything translucent goes solid, every decorative edge is promoted to the **meaningful** border
token (`--prl-line-strong`, 4.34:1, from the edge tokens' ~1.5:1), `--prl-line-subtle` is promoted
one step, and the focus ring goes from 2px to 3px.

**`forced-colors: active`** additionally drops both filters and the wash: the palette is replaced
wholesale so nothing can be seen through a pane, but the blur is still computed and still costs,
and `background-image` survives forced-colors — an accent-tinted field under system-coloured text
is precisely the author decoration that mode exists to remove.

Both preference states are now **rendered and measured**, not only argued: §7.3 sweeps `/play` and
`/learn` under each of them, in both themes.

### 7.3 Contrast is measured on the composited background, not on a token pair

A pair is two colours. A reader meets a **stack** — a tint over a tint over a gradient, with an
`opacity` somewhere in the middle — and §2.4 cannot express one. `pnpm run design:contrast` closes
that by walking the ancestor chain of every element carrying text, in real Chrome, on every route
in both themes, compositing every layer the way a browser does (source-over in sRGB, as nested
opacity groups, including each positioned `::before`/`::after` that covers the text — the plate
under every seat at the table is an `::after`) and measuring the glyph against the result.

Where the walk cannot finish it says so rather than guessing:

| Verdict | When | What is asserted |
| --- | --- | --- |
| **exact** | the walk reached an opaque fill, or the page ground, with every layer a colour | the composited ratio |
| **bounded** | the stack was still translucent when it crossed a floating or `backdrop-filter` element, or crossed a gradient | the **worse** of both bounding backdrops (§2.7.2's construction), and for a gradient the worst of its stop path |
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
token layer, §2.4 and §7.1), `box-shadow` (a drop shadow paints over the surface *behind* the
element casting it; every probe records whether one can reach it), and text overlapped by a
non-ancestor sibling.

**One number in `play.css` is wrong, and this pass is how we know.** The comment above
`.prl-seat--folded` declines an `opacity` on folded seats with the table `1.0 → 5.95:1`,
`0.9 → 4.09:1`, `0.8 → 3.10:1`. The composited measurement of that exact change is **4.74:1 and
3.79:1** — the 0.9 step does not breach AA, the 0.8 step does. The declined table interpolates the
two *luminances*; a browser composites `opacity` in gamma-encoded sRGB, which is what this gate
does and what its probes confirm pixel-for-pixel. The conclusion (don't fade the plate) survives;
the arithmetic under it does not.

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

* Sticky header, `--prl-glass-floating` with a real `--prl-glass-filter` and a lit hairline
  underneath, whose bottom edge is promoted from decorative to meaningful past 40px of scroll
  (an attribute toggled by `IntersectionObserver` on a sentinel — no scroll listener). This
  line used to read "`--prl-surface-page` at 92% … becoming opaque"; see §9.3 for what changed
  and why the ghosting bug that produced the old wording cannot return through the new one.
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

### 9.2 The app-shell tokens

§11 rule 1 forbids one-off values, so the numbers §9 states in prose are declared as tokens. They
live in `apps/web/src/app/globals.css` rather than in `tokens.css`, because they describe the
**shell** rather than the system — no component outside that file and `nav.css` has any use for
them, and promoting them would invite one.

| Token | Value | What it implements |
| --- | --- | --- |
| `--prl-shell-nav-fill` | `var(--prl-surface-inset)` | The fill for a control that floats in the bar — the navigation pill, the units readout, the menu trigger. Opaque, two steps up the ramp from the strip's tint, so four controls read as objects lying on a sheet rather than as holes cut in it |
| `--prl-shell-sentinel` | `var(--prl-space-10)` (2.5rem = 40px) | The scroll distance after which the header's edge is promoted, expressed as the **height of a sentinel element** rather than as a number in a JavaScript comparison |
| `--prl-shell-field-falloff` | dark `rgb(0 0 0 / 55%)`, light `rgb(16 20 26 / 5%)` | The backdrop field's edge falloff. Two values because its direction is decided by contrast: away from the ink in each theme (§9.3) |
| `--prl-shell-field` | four `radial-gradient()` layers | The backdrop field itself: three pools drawn with `--prl-wash-tint` / `--prl-wash-tint-2` and the falloff over them (§9.3) |

The sentinel is the point of the second one. An `IntersectionObserver` watching a 40px-tall
absolutely-positioned element at the top of the document reports the same fact a
`scroll` handler would, off the main thread and only when the answer changes (§5.4) — and the
threshold stays in the token system instead of becoming a literal in a comparison.

**`--prl-shell-header-fill` is gone.** It named the header's resting surface, first as the page
ground at 92% and then as the page ground solid, and it is deleted rather than repointed at the
glass because an alias hides a glass fill from the guard that exists to find one:
`packages/ui/test/layout-guarantees.test.ts` matches `var(--prl-glass-*)` in a declaration block
and fails it if no `backdrop-filter` sits beside it. A rule reading `background-color:
var(--prl-shell-header-fill)` is invisible to that scan. The header strip now writes
`var(--prl-glass-floating)` and both `backdrop-filter` declarations in the same block, in both
`globals.css` and `nav.css`.

### 9.3 The header strip is glass, and the page has a field under it

This section used to say, in bold, that there is deliberately **no `backdrop-filter`** on the
header strip, and that a blur "would not have fixed the ghosting bug anyway — it would only have
made the ghost blurry at 92% opacity". The first half was a defensible trade. The second half was
wrong, and correcting it is what this section is for.

Ghosting is a **legibility** failure: the reader's complaint was that headings passing under the
bar stayed readable, in the wrong place, as a second layer of type. Legibility is exactly what a
blur destroys and exactly what opacity does not:

| | destroys legibility | destroys colour |
| --- | --- | --- |
| 92% opacity | no | no |
| `blur(20px) saturate(180%)` | **yes** | no — and keeping the colour is the point |

So the strip is `--prl-glass-floating` with `--prl-glass-filter`, and the defect cannot return
through it. The blur radius is larger than the x-height of every face in `--prl-font-sans` at
every size in the ramp, so nothing that passes under the bar resolves into letterforms; it is
blurred from the first paint at every scroll position, so there is no 40px window at the top of a
page where it is translucent and unblurred, which is where the reader met the original bug; and
under `prefers-reduced-transparency`, `prefers-contrast: more` and `forced-colors` the token layer
resolves the fill to `--prl-surface-raised` and the filter to `none` **as a pair**, so the one
combination that produces the defect — translucent fill, no blur — is not reachable.

The performance argument in §2.7 is unchanged and is about a different thing: blur on surfaces
that repaint under moving content, which is the table field with six seats and a live Coach panel.
A `position: sticky` bar with `backdrop-filter` is promoted to its own compositor layer and
re-composited rather than re-laid-out as the page scrolls. Nothing in the app animates or
transitions a `backdrop-filter`.

**The backdrop field.** Glass over a flat colour is a slightly different flat colour, which is why
`--prl-page-wash` exists — and why it was not enough on its own. `base.css` paints it on `<body>`
with `background-attachment: scroll` and both of its stops anchored near the top edge, so on any
page longer than a viewport the varying part of the ground scrolls away: measured on `/terms` at
1440×1200 it is gone by 700px of scroll, which is section 2 of a fourteen-section document.

The shell therefore paints the field as `.prl-app::before` — one `position: fixed` layer at
`z-index: -1`, the size of the viewport, promoted once and never repainted, never scrolled, never
animated — and `globals.css` sets `body { background-image: none }` so the wash is not painted
twice. (Two copies of a 7% tint composite to 13.5%, which is brighter than `--prl-wash-tint` and
therefore brighter than the `--prl-surface-wash` §2.7 measures.)

Its pools are drawn with `--prl-wash-tint` and `--prl-wash-tint-2` and **not** with brighter
colours of the shell's invention, for the same reason: `scripts/check-contrast.mjs` derives
`--prl-surface-wash` from the brightest stop of the wash and asserts every text pairing against
it, so reusing those stops keeps that derived surface the true ceiling of the page ground. The
falloff moves away from the ink in each theme, which only ever raises a ratio in dark; in light it
spends headroom, so it was measured at the arithmetic worst case — every layer at full strength at
one point, which the geometry does not actually produce — and clears the floors there:

| | ground at worst case | text | secondary | muted / faint | line-strong |
| --- | --- | --- | --- | --- | --- |
| dark (pools at plateau, no falloff) | `#11222a` | 15.09:1 | 10.71:1 | 7.62:1 / 5.38:1 | 3.65:1 |
| light (pools at plateau + full falloff) | `#d4dee2` | 13.47:1 | 7.08:1 | 4.66:1 | 3.27:1 |

Floors are 4.5:1 for text and 3:1 for a meaningful border. `muted` in light is the row with the
least headroom and is the one to re-measure if a stop moves.

**The pills stay opaque.** Level 3 is for bounded panes, and a pill is one — but the strip is now
the glass, so a pill in the same material would stack one tint on another and land within a
rounding error of the sheet it sits on. They take `--prl-shell-nav-fill`, the lit hairline
(`--prl-edge` / `--prl-edge-lit` / `--prl-edge-shade`) and `--prl-elevation-2` instead, which is
the arrangement that reads as objects on a sheet. Every one of them that can take focus restates
`box-shadow: var(--prl-focus-ring), var(--prl-elevation-2)` — see §2.7's composition rule.

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
3. **Glass carries its blur, always.** A `--prl-glass-*` fill and a `backdrop-filter` go in the
   same block, every time, including in a `:hover` block whose base rule already set one. A
   translucent fill with no blur is the ghosting bug (§2.7.1), and
   `packages/ui/test/layout-guarantees.test.ts` fails it. Glass is for bounded, floating surfaces
   only; body text goes on level 2.
4. **Native CSS only.** No Tailwind, no CSS-in-JS, no preprocessor, no animation library.
   The supply-chain policy makes every dependency a reviewed event; a utility-class
   framework is not worth one.
5. **No remote assets.** No fonts, scripts, images or stylesheets from another origin. The
   CSP forbids it and so does this document.
6. **Information beats aesthetics, always.** If a layout is prettier without the confidence
   interval, the layout is wrong.
7. **Test both themes and both motion settings.** Four combinations, all of which must be
   legible and usable — and now check the two transparency preferences as well (§7.2), which
   `prefers-reduced-transparency` and `prefers-contrast` make trivially testable in DevTools.
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

* **Ad-hoc shadows and unbounded blur.** A shadow may only come from `--prl-elevation-*` or
  `--prl-focus-ring`; a `backdrop-filter` may only go on a small, bounded, static, already-promoted
  element; and nothing on the table field takes either. §2.7.4 and §4.1. (This entry used to read
  "shadow-based elevation" outright — see §4.1 for what changed and what did not.)
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

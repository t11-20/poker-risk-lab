# Product Guardrails

**Status:** Binding · **Last reviewed:** 2026-08-17

These are not preferences. They are constraints on what this product may be, and several
of them are enforced in code, in the database schema, or in the test suite rather than
left to reviewer discretion. Where a guardrail has a mechanical enforcement point, it is
named.

---

## 1. This is not a gambling product

**Prohibited outright.** No real money. No purchases, deposits, top-ups or subscriptions
tied to units. No cash-out, redemption or withdrawal. No transfer of units between
accounts. No prizes, sweepstakes or tournaments with an external reward. No
cryptocurrency, tokens or NFTs. No affiliate links, referral bounties or advertising for
gambling operators. No claim, implication or vibe suggesting that skill here converts
into money elsewhere.

**Units** are the only currency-like quantity. They are free, resettable at will by the
user, and have no value inside or outside the app.

**Enforcement**

* The word "units" is used in every user-facing surface. No currency symbols, no
  "balance", no "cashier", no "wallet". `<UnitsBadge>` carries an accessible description
  stating they are free, resettable and valueless.
* There is no transfer endpoint and no schema column that could represent one.
* Reset is always available and never penalised.

**Why it is a security guardrail too:** removing the financial motive is what lets the
threat model rate collusion and bot-farming as low severity. Introducing any value
transfer invalidates those ratings and requires a full threat-model redo
(`docs/THREAT-MODEL.md` §10).

## 2. No casino dark patterns

**Prohibited.** Loss-chasing prompts ("one more hand to win it back"). Streaks, daily
login rewards, or anything that punishes stopping. Near-miss celebration — a lost hand is
not dressed up as an almost-win. Variable-reward framing, mystery boxes, spinners. Urgency
or scarcity ("2 seats left!", countdowns that are not real). Sunk-cost framing ("you have
already invested 400 units"). Levels, XP, badges, leaderboards, or any ladder that makes
quantity of play the measure of progress. Autoplay, or a "rebuy" flow that is easier than
stopping.

**What replaces them.** The product rewards **reasoning**. A hand that was played well
and lost is shown as a hand that was played well. Hand review reports whether a decision
was consistent with the analysis, not whether it won.

**Enforcement**

* Quizzes have **no score threshold, no pass/fail and no aggregate score column** in the
  database. `prl.quiz_attempts` records individual answers only. There is deliberately
  nowhere to store a streak.
* Progress reporting counts lessons read, scenarios attempted and topics touched. It does
  not rank, compare or reward.
* Any celebratory feedback is attached to the quality of a decision, never to a win.

## 3. Never claim to be right

**Prohibited.** The words "correct play", "optimal", "GTO-approved", "solved", "always",
"never" (as strategy advice), or any framing implying a single right answer exists and
this product knows it.

**Required instead.** Every figure carries its **assumptions**. Every sampled figure
carries its **confidence interval**. Every suggestion carries a **confidence level that
may be low**, a **size range rather than a single number**, and an explicit list of
**what would change it**.

**Enforcement**

* `CoachReport.assumptions` and `CoachReport.uncertainty` are **non-optional fields**.
  A report cannot be constructed without them.
* `CoachSuggestion` has no field capable of expressing "correct" — the type is
  `{ action, sizeRange?, confidence: 'low' | 'moderate' | 'reasonable', reason,
  whatWouldChangeIt }`.
* The UI must not collapse assumptions or uncertainty behind a toggle. They render inline.
* Bots are labelled as heuristic opponents with recognisable styles, not as strong play.
* The ICM model states that it is Malmuth–Harville and lists what it ignores. Risk of ruin
  states that it is a diffusion approximation and lists its assumptions.

## 4. Never teach something false

**Required.** No pre-computed odds figure appears in content. Situations are stored;
numbers are computed. See ADR 0006.

**Enforcement**

* The hand evaluator is verified against **all 2,598,960** five-card hands and **all
  133,784,560** seven-card hands against independently published category frequencies.
* Scenario `expectedInsight` claims are machine-verified against computed maths. A
  scenario whose teaching point stops being true **fails the build**.
* `cleanOutsEquals` is rejected by the content validator unless the opponent is an exact
  hand, because against a range the out count is not well defined.
* Approximations may be taught — the rule of 2 and 4 is a lesson — but only labelled as
  approximations, alongside their actual error.

## 5. No public social surface until it can be moderated

**Prohibited for now.** Public matchmaking or a lobby of strangers. Free-text chat. User
avatars or uploads. Public profiles. Any user-to-user content channel.

**Enforcement**

* `rooms.visibility` has a `CHECK` constraint permitting exactly `'invite_only'`. Making
  the product public requires a migration and therefore a review — see ADR 0010 for why
  the constraint is in the schema rather than in config.
* Display names and room names are length-limited and pattern-restricted to exclude
  control characters, bidi overrides and zero-width characters (the mechanisms used for
  impersonation and log corruption).
* Display names are excluded from logs.

**To lift this:** moderation tooling, a reporting flow, rate and reputation systems, and a
threat-model review.

## 6. Accessibility is a requirement

WCAG 2.2 AA, treated as a functional requirement rather than a polish item.

* Keyboard operable throughout, with a visible focus indicator meeting contrast
  requirements.
* Text contrast ≥ 4.5:1 (≥ 3:1 large text) in **both** light and dark themes.
* **Never colour alone.** Card suits, clean vs dirty outs, win vs loss — all paired with
  text or shape. A red-green distinction that carries meaning is a defect.
* Live table updates announced through a polite `aria-live` region, not by moving focus.
* Target size ≥ 24×24 CSS px.
* `prefers-reduced-motion` honoured.
* A bet-size slider is always paired with a number input; a slider alone cannot be
  operated precisely by assistive technology.

**Enforcement:** `pnpm run test:a11y` in CI. Its coverage is static and its limitations
are stated explicitly in the script's own output — an accessibility check that overstates
what it verifies is worse than none (`docs/THREAT-MODEL.md` G5).

## 7. Original content only

All lessons, quizzes, scenarios, glossary entries, ranges and visual design are written
from first principles for this project.

**Prohibited.** Copying or paraphrasing any third-party poker course, book, training site,
range chart or article. Reproducing any third-party brand, logo, asset, colour scheme or
visual identity. In particular: no Hopkins course material, and no Zynga assets or
branding.

**Enforcement**

* The starting-hand strength ordering is **computed** from all-in equity against a random
  hand, not transcribed from a published chart — so it is both original and verifiable.
* The visual design deliberately avoids the language of gambling: no casino green baize,
  no gold, no neon. The palette is calm and analytical, and that choice is documented in
  the design tokens.

## 8. Respect the user's time and attention

* No infinite feed. No autoplay. No notification pressure.
* Estimated reading time is shown for every lesson so the user can decide, not be pulled.
* Stopping is always one click, never behind a confirmation designed to retain.
* No hidden state: the user can always see their units, the pot, the price, and the
  assumptions behind any number shown to them.

---

## Changing this document

Any change to §1, §2, §3 or §5 is a change to what the product *is*, not to how it works.
It requires an ADR, and §1 and §5 additionally require a threat-model review because the
severity ratings in `docs/THREAT-MODEL.md` depend on them.

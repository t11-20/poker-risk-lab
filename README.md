# Poker Risk Lab

An educational, **play-money** No-Limit Texas Hold'em app for learning probability, risk and
reward, expected value, and variance — the reasoning underneath poker decisions, not the
gambling.

> **This is not a gambling product.** Chips are "units": free, resettable, and worth
> nothing. There is no purchase path, no cash-out, no transfer between accounts, and no
> prize. No real money is involved anywhere, ever. See
> [`docs/PRODUCT-GUARDRAILS.md`](docs/PRODUCT-GUARDRAILS.md).

---

## What it does

**Learn.** Lessons and quizzes across the whole syllabus — the rules and flow of a hand,
position and blinds, counting outs, equity, pot odds, expected value, fold equity, bet
sizing, stack-to-pot ratio, ranges, variance, bankroll, and tournament ICM.

**Practise.** A Scenario Lab of hand situations where you make the decision and then see
the reasoning. Guided play against bots with recognisable styles. Private, invite-only
tables with people you already know.

**Understand.** At every decision, the **Coach** shows:

- **outs**, split into *clean* (they make you the likely winner) and *dirty* (they improve
  you but you can still lose) — a distinction most material skips, and the reason people
  miscount their real chances
- **equity**, saying whether it was computed **exactly** or **sampled**, and if sampled,
  its 95% confidence interval
- **pot odds** and the break-even equity a call needs, and whether you clear it
- **expected value per legal action**, with the arithmetic shown
- **a suggestion** — with a size *range*, a confidence level that is allowed to be "low",
  the reason, and an explicit list of what would change it
- **the assumptions**, always, never hidden behind a toggle

The Coach never says an action is "correct" or "optimal". The type it returns has no field
capable of saying so. It states what follows from stated assumptions, and says how sure
it is.

**Review.** Every hand can be replayed decision by decision. And every hand can be
**verified**: the server publishes a cryptographic commitment to the deck before anyone
acts, and afterwards proves the cards you saw came from that committed deck at those exact
positions.

---

## Quick start

```bash
corepack enable                      # Node 24.18.0 and pnpm 11.10.0 required

pnpm install --frozen-lockfile
pnpm run security:audit              # 11 supply-chain gates — run this first

cp .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
# paste into SESSION_COOKIE_SECRET in .env

pnpm run db:setup                    # postgres up, migrate, seed
pnpm run build:packages
pnpm run dev                         # web on :3000, api on :3001
```

No sign-in needed — the app is guest-first. Full command reference in
[`docs/RUNBOOK.md`](docs/RUNBOOK.md).

---

## How it is built

```
packages/poker-engine   pure rules: cards, evaluator, CSPRNG shuffle, Merkle deck
                        commitment, betting rules, side pots, state machine, redaction
packages/poker-math     pure maths: ranges, equity, outs, pot odds, EV, fold equity,
                        SPR, variance, risk of ruin, ICM, the Coach
packages/contracts      the wire contract: types, JSON Schemas, WebSocket protocol
packages/content        lessons, quizzes, scenarios, glossary — situations, never answers
packages/ui             React components and native CSS
apps/api                Fastify 5: REST + WebSockets, auth, rooms, bots, hand review
apps/web                Next.js 16 client
```

**Everything hard is in the pure core.** The engine and the maths have no dependencies, no
I/O, no clock, and no ambient state. That is what makes the verification below possible:
you can push all 133 million seven-card hands through a function, and you can replay
thousands of randomised hands through a reducer.

Design decisions and their trade-offs: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and
the twelve records in [`docs/adr/`](docs/adr/).

---

## Correctness, and how it is established

An app that teaches probability has one unforgivable failure: being confidently wrong. So
the foundations are verified against ground truth the code has no access to.

**The hand evaluator** is checked against every hand in the deck:

- all **2,598,960** five-card hands, cross-checked against a deliberately different
  reference implementation, *and* against the published category frequencies
- all **133,784,560** seven-card hands, whose nine category counts match the published
  combinatorial result exactly (23,294,460 high card · 58,627,800 pair · 31,433,400 two
  pair · 6,461,620 trips · 6,180,020 straight · 4,047,644 flush · 3,473,184 full house ·
  224,848 quads · 41,584 straight flush)

A single misclassified hand moves at least two of those counters.

**Equity** was checked against a published result: AA vs KK averaged over all 36 suit
configurations comes out at **81.946%**, matching the widely published ~81.9% figure, with
individual configurations spanning 81.26%–82.64%. Monte Carlo agrees with exact enumeration
inside its stated interval.

**The maths** is checked by identity and by independent derivation, not by asserting its
own output: EV-of-call is exactly zero at the break-even equity that pot odds computes;
minimum defence frequency and alpha sum to one; required fold equity round-trips back
through EV-of-bet to zero; the closed-form two-card hit probability is confirmed by
enumerating run-outs through the engine; ICM with 3:1 stacks and 70/30 payouts gives
exactly 60/40.

**The rules** are checked by three randomised soaks — **8,500 hands and 50,236 applied
actions** in total (4,000 general-invariant, 1,500 shove-heavy, 3,000 short-blind-heavy),
measured 2026-08-19 — asserting, after **every single action**, that chips are conserved,
that no card is dealt twice, that the bet level agrees with the seats, that pots always
balance, and that a rejected action leaves the state byte-identical. Each soak also asserts
its own coverage, so a generator that degenerated into folding every hand fails rather than
passing quickly.

**Hidden information** is checked at runtime, not by review: every view for every recipient
at every point in a hand is serialised and scanned for cards that recipient must not see.

**The teaching content** is checked too. No scenario stores a pre-computed number — it
stores the situation, and the test suite computes the answer and asserts the teaching claim.
A scenario whose point stops being true fails the build.

Full detail: [`docs/VERIFICATION.md`](docs/VERIFICATION.md).

---

## Two things worth reading about

### The commitment bug that a test caught

The first deck-commitment design was the obvious one: publish `SHA-256(salt ‖ deck)` before
the deal, reveal the salt and deck afterwards so anyone can recompute it. Correct for its
stated goal.

A hidden-information test failed, and it was right to. **Revealing the deck reveals all 52
cards** — including the hole cards of everyone who folded without showing. Heads-up, a fold
would publish the winner's exact hand. Whether an opponent folded a bluff or a monster is
precisely the information poker is played over, so the integrity control would have created
a leak far worse than the problem it solved.

The fix is a **per-card Merkle tree**: each deck position is a salted leaf, the published
commitment is the root, and afterwards the server proves *only* the cards that legitimately
became public — the board, and the hands that actually showed. Everything else stays sealed
forever. Details and the reasoning: [ADR 0004](docs/adr/0004-merkle-deck-commitment.md).

The general lesson: an integrity mechanism can create a confidentiality hole, and the two
have to be designed together.

### The supply-chain policy, and the footgun inside it

This repo was built during the **Mini Shai-Hulud** campaign — a self-propagating npm/PyPI
worm that compromised on the order of 1,300 package versions, steals CI and developer
credentials, and forges Sigstore provenance attestations. So the dependency policy is
release-blocking and enforced by **twelve gates**, which between them assert: the policy is
in effect, lifecycle scripts disabled, registry-only resolutions, a 7-day release-age
cooldown, exact versions, source-encoding hygiene, lockfile hashes cross-checked against the
registry, a family deny-list, an OSV scan, an on-disk IOC sweep, **no committed
credentials**, a CycloneDX SBOM, **a trivy CVE scan of the built container images**, and —
added after the release audit — **pinning of the pipeline's own dependencies**: every GitHub
Action by 40-hex commit SHA and every container base image by `@sha256:` digest, because
`actions/cache@v4` is a pointer its owner can repoint at code that then runs inside this
repository's CI. (This paragraph said "nine gates" and listed ten things; the count and the
list are both taken from the `GATES` array in `scripts/supply-chain/audit.mjs`, which has
gained a secret scan and a container-image scan since.)

The footgun: **pnpm 11 reads only auth and registry settings from `.npmrc`.** A policy
written there is *silently ignored* — the repo looks hardened while being wide open. That
is why one gate does not read a config file at all: it asks pnpm for its *effective*
configuration and asserts on that, and separately **fails** if a policy key appears in
`.npmrc`, because a setting sitting where it is ignored is worse than one that is absent.

Provenance attestations are recorded but **not trusted as a control**, because this campaign
forges them. Treating "has provenance" as "is safe" would be exactly the wrong lesson.

[`docs/SECURITY.md`](docs/SECURITY.md) ·
[`docs/security/shai-hulud-snapshot-2026-08-17.md`](docs/security/shai-hulud-snapshot-2026-08-17.md) ·
[ADR 0007](docs/adr/0007-supply-chain-policy.md)

---

## What this does *not* do

Stated plainly, because a limitations section that lists nothing is not a limitations
section.

- **The commitment does not prove the deck was chosen fairly.** It proves the deck was
  fixed before anyone acted. The server generates both the deck and the salts, so a
  dishonest operator could grind candidate decks and commit to a favourable one. Closing
  that needs player-contributed entropy, which is not implemented.
- **No public matchmaking and no chat.** Deliberate: neither ships until moderation and
  anti-abuse review pass. `rooms.visibility` is `CHECK`-constrained in the database so
  changing it requires a migration and a review, not a config flag.
- **The bots are heuristic, not strong.** They exist to be recognisable styles to practise
  against. A solver would make the teaching worse, not better.
- **ICM is Malmuth–Harville**, an approximation that ignores skill, position and blind
  pressure. Risk of ruin is a diffusion approximation assuming a constant edge, constant
  stakes and an infinite horizon. Both state their assumptions every time they produce a
  number.
- **The accessibility audit does not run a real browser**, because a headless browser needs
  install scripts that the supply-chain policy forbids. The script says exactly what it does
  and does not cover — an a11y check that overstates its coverage is worse than none.
- **Out-of-band collusion is undetectable.** No server control can see another channel.

Full list with severity and what would close each:
[`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md) §9.

---

## Stack

Node 24.18.0 · pnpm 11.10.0 · TypeScript 7.0.2 (strict, plus `exactOptionalPropertyTypes`,
`noUncheckedIndexedAccess`, `erasableSyntaxOnly`) · Next.js 16.3.0 · React 19.2.8 ·
Fastify 5.11.3 · PostgreSQL 16 · Biome 2.5.7 · native CSS · `node --test`

Every version is pinned exact and chosen to satisfy a 7-day release-age cooldown. Tests run
on Node's built-in runner against TypeScript directly, so there is no test framework and no
transpiler in the test path.

---

## Documentation

| Document | What is in it |
| --- | --- |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | The shape of the system and why, with trade-offs named |
| [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md) | Assets, adversaries, 16 threats, controls, **and the accepted gaps** |
| [`docs/SECURITY.md`](docs/SECURITY.md) | The supply-chain policy, secure coding rules, incident response |
| [`docs/PRODUCT-GUARDRAILS.md`](docs/PRODUCT-GUARDRAILS.md) | What this product may not become, and where each rule is enforced |
| [`docs/AI-LEGENDS.md`](docs/AI-LEGENDS.md) | The AI Poker Legends mode: strategy profiles of *styles*, not people — the trait model, the impersonation ban, the information boundary, **and its limitations** |
| [`docs/VERIFICATION.md`](docs/VERIFICATION.md) | Every correctness claim and the evidence for it |
| [`docs/RUNBOOK.md`](docs/RUNBOOK.md) | Commands, configuration, troubleshooting |
| [`docs/adr/`](docs/adr/) | Twelve decision records |
| [`docs/REPORT.md`](docs/REPORT.md) | Final delivery report: what was built, tested, and left undone |

## Licence

See [`LICENSE`](LICENSE). Original work; no third-party poker course material, chart, brand
or asset is reproduced.

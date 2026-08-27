# Branch handover — `production-hardening`

**State:** 83 commits ahead of `main` · 346 files · +94,025 / −2,898 · working tree clean · nothing pushed
**Gate:** `pnpm run verify` — **16 of 16, exit 0, 3,767 tests** (last run at `8768035`)
**Deployment:** staging is up on signed, CVE-clean digests that match `deploy/staging/release-manifest.json`

This document exists so a reviewer can pick the branch up without reading 83 commit messages. It
says what changed, what is measured, what is *not* done, and where to be sceptical.

---

## 1. Verify it yourself before believing any of this

Everything below is reproducible. Nothing here should be taken on the strength of this file — the
repository's own rule is that if a document and the code disagree, the code is right.

```bash
pnpm run verify          # 16 gates, ~50 min. Expect: "=== verify: every gate passed ==="
pnpm run db:verify       # every documented schema security property holds
node scripts/staging.mjs status   # four services healthy, api and web matching the manifest
pnpm run security:containers      # 0 blocking, 0 unfixable, 0 allowed
```

`verify` runs **every** gate even after one fails and exits listing them, so a single run tells you
the whole story rather than the first failure.

---

## 2. What this branch is, in one paragraph

An educational play-money No-Limit Hold'em lab was hardened for a paying cohort. The work was not
feature development: it was finding the places where a guard *looked* like coverage and was green
over nothing, and closing them. The recurring finding — stated here because it is the most useful
thing a reviewer can know — is that **almost every defect was in a guard, not in the product.**

---

## 3. The findings worth knowing about

Ordered by what would have hurt most, not chronologically.

| What | Where it was | How it was found |
| --- | --- | --- |
| **The Coach taught a threshold that does not exist** — "below roughly 20% fold equity the raise and the call are worth about the same". Solving for that frequency gives **−10.2%**; the raise is ahead by 5.7 chips even against an opponent who never folds | `apps/web/src/fixtures/table.ts` | Recomputing every numeric claim the product teaches against the engine |
| **Commitment salts written to logs verbatim** — the redaction denylist named fields the codebase does not have, so `deckSalts` (a `Uint8Array`) was walked as an object and two whole 32-byte salts emitted | `apps/api/src/logging.ts` | Adversarial sweep of hole-card privacy |
| **A HIGH OpenSSL CVE in both shipped images** (CVE-2026-14456, libcrypto3/libssl3 3.5.7-r0) | `Dockerfile.api`, `Dockerfile.web` | The container CVE gate, on a routine `verify` — no human read a feed |
| **The release pipeline ran 5 of 14 gates** — `security:hygiene`, `build`, `design:contrast`, `test:a11y`, `test:ax`, `test:csp`, `test:age-gate`, `test:exhaustive`, `test:simulation` ran in `ci.yml` and nowhere in `release.yml` | `.github/workflows/release.yml` | Reading the two files against each other |
| **A rehearsal could be signed and pushed to GHCR** — a `workflow_dispatch` dry run concludes *success*, and `dry_run: true` is the deliberate safe default | `.github/workflows/release-sign.yml` | Asking what the signing job actually checks about the run that triggered it |
| **A paid place could vanish with no record** — `ON DELETE CASCADE` removes an enrolment, and a referential action writes no audit row, so the trail showed an entitlement that was never closed | `apps/api/src/repositories/users.ts` | Measuring the claim in the migration's own header |
| **The confidentiality check examined zero seats** — it filtered `hand.seats` over a response type with no `seats` field | `scripts/smoke-test.mjs` | Adversarial sweep; this is the *second* time this check has failed this way |
| **Nothing stopped a fourth way to be seated** — `LiveTable.sit` has three call sites and that was prose. An ungated `reseatForRematch` added to the source left 77 tests in the three most relevant suites green | `apps/api/src/rooms/registry.ts` | Testing the claim rather than reading it |
| **The equity bound could not detect a broken evaluator** — `> 0.8 && < 0.84` on a figure whose spread across all 36 configurations is 1.4 points. Making club flushes stop existing moves the average to 82.098%, which that window accepts | `apps/api/test/calc.test.ts` | `docs/VERIFICATION.md` said so itself, in the honest section |
| **Text could collide and no gate could see it** — a collapsed grid track painted a sentence across its own label on the deployed build, with every gate green | `apps/web/src/styles/play.css` | Looking at a screenshot |

Two more that are guards claiming guarantees nobody had written: the audit log's forbidden-key CHECK
was byte-exact and missed `hole_cards`, `cards`, `board`, `reveal` and the four fields the engine
calls the hand's secrets — and the pairing test its comment said kept the two layers in step **did
not exist**. Both closed.

---

## 4. What is now gated that was not

`pnpm run verify` went from fourteen gates to sixteen, and `security:audit` from fourteen to fifteen.
The two counts are unrelated lists that have collided twice; read each off its own list.

- **`test:layout`** — `Range.getClientRects()` over each element's own text nodes, 15 routes × 2
  themes × 5 widths = 150 measurements, 34,098 painted text elements. It measures where the glyphs
  landed, because the defect it was written for does not overlap the element boxes. Six negative
  controls run on every invocation.
- **`test:keyboard`** — existed, was thorough, and ran **nowhere**: it had no `--start`, so it needed
  two servers brought up by hand. Now starts its own and blocks the release. 146 checks, twelve
  consecutive identical runs before it was wired in.
- **`pinned-action-advisories`** — the last unguarded supply-chain surface. Note the trap it avoids:
  OSV's *version-qualified* query returns `{}` for the GitHub Actions ecosystem even for a version
  inside an advisory's range, so a scanner written like `osv-scan.mjs` would have matched nothing for
  ever and printed a green tick.
- **`scripts/release-gate-coverage.mjs`** — reads the `for gate in …` clause of `verify` against both
  workflows' job graphs. Adding a gate is now a three-file change by construction.

---

## 5. Measurements, with the caveats that make them meaningful

| Measurement | Figure | Read this too |
| --- | --- | --- |
| Capacity, worst case | 30 seated players, 7,125 hands/min, p99 14.0 ms, **zero 5xx** | Zero think time — thirty bots racing. CPU 3.69 cores against a 0.9 threshold; the ceiling was **not** found |
| Capacity, human pace | 30 players, CPU **0.12 cores**, Coach p95 179 ms, Review p95 658 ms, zero errors | The worker pool still queues 3 against a threshold of 1. It is the only signal that does not relax |
| Cold start | First Coach analysis 83.6 ms **on the main thread** | That is also the event loop blocked for that long. Once per process; `staging up` warms it |
| Alerting | `alerts:verify` 35 of 35, both tiers, both transports, dead man's switch detected by stopping Alertmanager | Nothing rehearses that a real provider accepts these credentials, or that anybody is awake |
| Recovery | 172.9 MiB archive in 19.9 s; `verify --deep` four layers in 52.6 s, 181 TOC entries incl. **19 ACL entries**, 16 tables compared, scratch DB dropped | Proves the archive decrypts, parses and restores. **Not** that the app works against restored data. No WAL archiving, so RPO is the schedule interval |
| Accessibility | 71 of 72 assertions machine-checked; `test:ax` 117 checks | The one left needs a deliberately broken build |
| Staging smoke | 71 checks over TLS, X-Forwarded-For overwrite confirmed against 24 forged addresses | Says these journeys work on this deployment **once**. Not a load test |

---

## 6. What is NOT done

**Three handoffs, none of them engineering's to close.** `docs/production/go-live.md` §7 carries each.

1. **Counsel.** Eleven entries in `docs/production/legal-review-requirements.md`, each with the facts
   sourced from the code. All are launch blockers. The deletion question narrowed during this work:
   an erasure now writes `enrolment.ended_by_erasure` before the cascade, so the question is no
   longer "can a destroyed entitlement be evidenced" — it can, on both sides — but what the operator
   owes the holder of a live place who erases themselves.
2. **A paging provider.** The path is verified to the edge of a real account: SMTP transactions and
   RFC822 messages are real, delivered to sinks the script runs. `alerts:preflight` refuses
   placeholder, malformed and unrouted destinations. `alerts:ack` needs a person at a TTY.
3. **A git remote.** There is none, so every release is signed with a long-lived key — posture
   **KEY**, which proves possession of a key and *not* the identity of a builder. One tagged push
   makes `release-sign.yml` produce a Fulcio certificate instead.

**Open residuals** are in `docs/VERIFICATION.md` §12, which is the honest section and is worth
reading in full. The two sharpest:

- **A card stringified into a log message** passes every layer — `scrubValue` returns strings
  verbatim, so `log.info({ note: JSON.stringify(state) })` is not caught by a key denylist. Nothing
  does it today.
- **`hidden-information` is a smoke detector on the client, not a control.** `apps/web` refuses a
  frame carrying cards it should not have, but the bytes have already arrived — redaction has one
  boundary, on the server, deliberately.

---

## 7. Where to be sceptical of this work

Reviewing it the way it was written means distrusting green results. Specifically:

- **Every new guard has a negative control**, and each commit message states the measurement. If a
  control is not demonstrated by *running* it, treat the guard as decoration — that is this
  repository's own rule and it caught several of these.
- **Counts drift.** `verify` is sixteen and `security:audit` is fifteen; those were both fourteen and
  the equal numbers hid a stale claim for weeks. `readiness-report.test.mjs` now attributes each
  "N gates" claim by its nearest marker, but only for that document.
- **The frozen report.** `docs/production/final-readiness-report.md` is joined to the release
  manifest by a test, and it records superseded measurements *beside* current ones on purpose. Check
  which run a figure comes from before quoting it.
- **Two mistakes were made and corrected during this work** and are recorded rather than tidied
  away: a commit made before reading `biome`'s output, and a `git add -A` that swept a concurrent
  agent's in-flight files into a commit (undone with a soft reset). Both are the same error the
  branch spent its time finding in the codebase — acting on a result that had not actually been read.

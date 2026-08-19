# Final release report — Poker Risk Lab

**Date:** 2026-08-19  
**First-pass HEAD:** `f20bbad`  
**Auditor:** independent principal (did not build this application)

---

## Verdict

```
RELEASE: FAIL
```

No confirmed **P0**. Remaining **P1** items from the independent challenger were not all closed. The brief forbids a candidate while any P1 remains.

### Remaining P1 (do not ship)

| ID | Finding | Evidence |
|---|---|---|
| CHAL-P1-3 | After process restart, bots are not re-registered; seven of twelve Legend ids persist as `unknown` | `registry.ts` `ensureOpen`; `bot_profile` CHECK; `persistableProfile` |
| CHAL-P1-4 | The HTML origin has no CSP. The hashed theme-boot script is never placed on a response | `next.config.ts` has no `headers()`; `THEME_BOOT_SCRIPT_CSP_HASH` is unused at runtime |
| CHAL-P1-6 | `/legends/hand-review` always loads a bundled sample; no API path builds a learner’s comparison | `loadHandComparison` returns `HAND_COMPARISON_FIXTURE` |

### Also blocking under the brief’s UNVERIFIED rule

- **A11Y-001** keyboard-only primary journeys were not Tab-tested in a real browser.

---

## Totals

Catalog after this audit (split IDs; not forced to 208):

| | Count |
|---|---:|
| Total requirements | **281** |
| PASS | **250** |
| PARTIAL | **24** |
| FAIL | **4** (PROD-048 + CHAL-P1-3, P1-4, P1-6) |
| UNVERIFIED | **2** (A11Y-001; OIDC as guest-only N/A-equivalent) |
| N/A | **1** (PROD-009 custom scenarios) |

Every PARTIAL / FAIL / UNVERIFIED is listed in `docs/audit/final-traceability.md` §5.

---

## What the nine reviewers found (first pass, frozen)

Independent A–I at `f20bbad`. Raw: `docs/audit/2026-08-19/raw/`. Domain files are those reports with a lead freeze banner.

**No P0.** Lead demoted empty `notFound()` HTML from P0 to P1. Lead **disagreed** with ENG-026 (folded-chip refund vs short BB): that is uncalled-bet return; `short-blinds.test.ts` is right.

Known-issue recheck:

| Issue | Result |
|---|---|
| ScenarioAttemptResponse honesty | PASS after `recorded` |
| `/learn` own progress | PASS after session forward (Reviewer A rereview: live ✓ chip) |
| seatBot race | PASS (queued); leftover P2 no DB rollback |
| Coach legal-action grading | PASS |
| Impossible probability | PARTIAL (Coach guarded; `formatPercent` unclamped) |
| Graceful shutdown WS + raw TCP | PASS (WS 4503 ~10 ms; raw TCP 31 ms, exit 0) |
| Release/security gates | PASS (9/9 after audit-doc IOC quotes were redacted) |

---

## Remediations this session

Closed from first pass and from the challenger:

- ICM live calculation + quiz `icm-q6` (60% of 3:1 / 70–30) — A rereview **PASS**
- `/learn` forwards the session and shows that reader’s “read” chips — A rereview **PASS**
- `ScenarioAttemptResponse.recorded` + Lab copy — A rereview **PASS**
- Identifier 404s render `NotFoundBody` (no in-page `notFound()`, which Next 16 empties)
- Brand home control always has visually-hidden “Poker Risk Lab, home”
- **Play this style** now `POST /api/v1/legends/matches` via `API_PATHS.legendMatches`
- Re-sit uses `member.stack`, not a fresh `startingStack`
- `tournamentOrientation` documented as a fold knob, not Malmuth–Harville
- Units disclosure capped to the viewport
- IOC strings quoted in audit markdown redacted so the IOC gate judges dependencies, not our reports

---

## Clean release suite

`pnpm run verify` **passed all 11 gates** after the IOC redact (security:audit, hygiene, lint, build, typecheck, design:contrast, test 679/679, a11y 0 violations / 7 routes, exhaustive 133,784,560, simulation, db:verify).

That run was **before** the last challenger remediations (legend matches, sit stack, NotFoundBody on content ids). Those later edits: web tests **156/156**, biome clean on the touched files, contracts rebuild. A second full `verify` was not re-run after that last wave.

---

## Challenger

Independent, not shown prior reviewer conclusions. Report: `docs/audit/2026-08-19/raw/challenger.md`.

**P0: 0. P1: 6 originally.** Three of those (Play-this-style, re-sit stacks, ICM-as-docs-lie) were patched in source. Three remain (restart bots, page CSP, legends hand-review fixture).

Hidden cards, in-hand conservation, evaluator identities, ignoreScripts, impersonation default: challenger did **not** disprove.

---

## Why this is FAIL

A candidate requires zero unresolved P1. Restarting the only API process still turns bots into timeout-folders and forgets most Legend identities. The page origin still has no CSP. The Legends “compare your hand” route still cannot load a real hand.

Do not treat a green `verify` as a substitute for those product holes. This project has already been caught making that substitution.

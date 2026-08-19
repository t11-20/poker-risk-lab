# Final release report — the release decision

**Status: DO NOT SHIP.**
**Last updated:** 2026-08-18.

This is the document `REPORT.md` §8 points at. It exists to answer one question — *should this be
released?* — and to leave a record of who decided, on what evidence, and what would have to change.
It is deliberately short. The findings live in the registers it cites; repeating them here would
create a third place to get them wrong.

Until 2026-08-18 this file did not exist while `docs/REPORT.md:236` cited it as "the release
decision". That is worth recording rather than quietly fixing: a reader following the one reference
that would tell them whether to ship found nothing, and a missing decision reads far more like
"approved" than like "never made".

---

## The decision

**No release.** Two independent adversarial rounds have been run against this build. Both returned
FAIL, and the second — the more thorough of the two — is not close: it found four P0 clusters, and
the project's own declared release gate exits non-zero.

Nothing in either round suggests the product is unsound in conception. The engine, the mathematics
and the supply-chain posture were re-verified by reviewers who wrote their own instruments and both
rounds said so in as many words. The blockers are elsewhere: features that exist on the server and
are unreachable from the client, a Coach that priced actions the learner could not take, an
operational path that killed live connections on every deploy, and gates that could not fail.

---

## Round 1 — release review

**Register:** [`release-findings.md`](release-findings.md).

Seven reviewers (A–G) in parallel under a single barrier; none saw another's conclusions before
forming its own; none was given the implementer's summary as evidence.

| | |
|---|---|
| Verdict | **7 × FAIL** |
| Findings | 94 before deduplication, **15 blocking clusters** after |
| Most consequential | The Coach priced a raise as an opening bet — an error of exactly `(1−f)·C·(1−e)`, always positive, worst at low equity. It changed 6 of the 36 shipped scenario recommendations. |
| Second | The web app was not connected to the API at all; every screen silently served a bundled fixture and rendered correctly, which is why internal verification kept passing. |

Remediation followed, and round 2 confirmed several of those fixes as genuine — the Coach's raise
term, the silent fixture fallback, the deck-commitment verification in the browser. It also found
that some fixes had been *reported* as complete on weaker evidence than the report implied.

---

## Round 2 — independent release audit, 2026-08-18

**Register:** [`../audit/final-release-audit.md`](../audit/final-release-audit.md), with the
per-requirement matrix in [`../audit/requirements-traceability.md`](../audit/requirements-traceability.md)
and the reviewers' raw records in [`../audit/raw/`](../audit/raw/).

Eight reviewers under a single barrier, then a final challenger behind an information wall tasked
with disproving the product. The lead auditor re-verified every P0 independently rather than
relaying it.

| | |
|---|---|
| Verdict | **FAIL — do not ship** |
| Requirements | 208 traced · 143 PASS · 31 PARTIAL · 33 FAIL · 1 UNVERIFIED |
| Blockers | **4 P0 clusters, 17 P1 clusters** |

The four P0 clusters, in the audit's own numbering:

1. **The Coach prices, publishes, accepts and grades against actions the learner cannot legally
   take.** `legalActions` was optional and absent on the wire type the Scenario Lab uses, so the
   legality guard failed *open*. It inverts the codebase's own stated principle — build the narrow
   type field-by-field so that it fails closed — and it breaches the product guardrail "never teach
   something false".
2. Private multiplayer and several other stated features are complete on the server and unreachable
   from the client.
3. **Graceful shutdown was broken for every WebSocket connection.** One idle socket: 10.18 s and
   exit 1; under `docker compose stop`, exit 137. `RUNBOOK.md` stated the opposite and called it
   "a defect and is fixed".
4. **The declared release gate is red, and the release documents did not say so.** `verify` was a
   `&&` chain with `db:verify` last, so the gate the documents describe as asserting the live
   schema's security properties had never executed inside the command operators are told to run.

---

## What would have to be true for this to ship

A decision to release is a decision about evidence, so the bar is stated as evidence rather than as
a feeling of readiness.

1. **`pnpm run verify` green on the release commit — every gate `PASS`, not merely a zero exit.**
   The gate now runs all eleven gates, reports each, and exits non-zero if any failed
   (`RUNBOOK.md` §3). A partial pass is a fail.
2. **Zero P0 and zero P1 clusters open**, under the stated release rule that either one blocks. The
   count is taken from the traceability matrix, not from a summary.
3. **Every mandatory requirement PASS**, with `PARTIAL` and `UNVERIFIED` treated as not-passing.
   `UNVERIFIED` in particular must be resolved rather than aged out: a requirement nobody could
   check is not a requirement that passed.
4. **A third independent round returning PASS**, run against the remediated tree by reviewers who
   did not do the remediation and who are not shown the remediators' summaries. Two rounds have now
   found defects that the implementers' own verification did not, which is the argument for the
   third.
5. **The claims in `REPORT.md` and `VERIFICATION.md` re-derived, not re-read.** Round 2 found
   numbers in both that were stated more confidently than the evidence supported. Where a claim
   cannot be enforced by a gate, `VERIFICATION.md` §12 is where it belongs.

---

## Housekeeping

This file is updated when a decision changes, and only then. If it says DO NOT SHIP and the tree has
moved on, the correct reading is that no one has made a newer decision — not that the old one has
lapsed.

**2026-08-19 — status note, not a decision.** Remediation of the round-2 findings is under way and
some of it has landed; what has been re-run and by what evidence is recorded in
[`../REPORT.md`](../REPORT.md) §8. **The decision above is unchanged**, and none of that work
changes it: bar 4 asks for a third independent round against the remediated tree by reviewers who
did not do the remediation, and that round has not been run. Remediation is not clearance, which is
the whole reason this file has its own rule about when it changes.

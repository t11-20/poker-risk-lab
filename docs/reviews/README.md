# `docs/reviews/` — point-in-time review records, 2026-08-18/19

**None of this describes the current tree.** Every file here is 100+ commits behind, and the
verdicts in them were reversed or closed by the work that followed.

- Current state: [`../production/final-readiness-report.md`](../production/final-readiness-report.md)
- Reviewing the branch: [`../HANDOVER.md`](../HANDOVER.md)

| File | What it is |
| --- | --- |
| `agent-a-architecture.md` … `agent-g-production.md` | Round 1. Seven independent reviewers, one subsystem each, run in parallel and **not reconciled** — where two disagreed, both readings are kept |
| `release-findings.md` | Round 1's findings collected, with the disagreements preserved rather than averaged |
| `final-release-report.md` | The release decision of 2026-08-18: **DO NOT SHIP**. Reversed since; the file carries a banner saying so |

Kept rather than deleted because a reversed decision is evidence of how the decision was made, and
deleting the record of a failure leaves only the record of the fix. Note that
`final-release-report.md` also exists in [`../audit/`](../audit/) as a different document — the two
names collide and neither will be renamed, because both are cited by `REPORT.md` at those paths.

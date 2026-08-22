# Incorrect Coach or maths result

Somebody reports a probability, EV, equity, pot-odds or hand-ranking figure that is wrong.

This product teaches probability. **A wrong number is a product failure of the first order**, even though nothing is down and no data is lost: a learner who is taught the wrong equity carries it away. Treat it with the seriousness of a correctness incident, not a cosmetic one.

---

## Symptoms

- A reported equity, EV, pot-odds, outs count, SPR, fold-equity or variance figure that does not match an independent calculation.
- A hand ranked as beating a hand it should lose to.
- A Coach recommendation that contradicts its own stated numbers.
- A percentage outside 0–100, a probability outside 0–1, or a figure formatted in the wrong domain.
- Two surfaces disagreeing about the same hand — the live Coach and the post-hand review, say.

## Detection

There is no alert for this and there cannot be: nothing in production knows the right answer. Detection is a report, a review, or one of the offline suites.

The suites are the strongest evidence available and they are exhaustive rather than sampled:

```bash
pnpm run test:exhaustive     # all 133,784,560 seven-card hands through the evaluator
pnpm run test                # engine invariants and property tests
pnpm run test:simulation     # all 12 strategy profiles
```

## Immediate containment

1. **Get the exact case.** A report without the inputs is unactionable. Capture the hand id or the review URL, the board, the hole cards, the stacks, the street, and the number shown. The `requestId` from any error, or the hand id from the review page, is the anchor.

2. **Decide, quickly, whether it is a computation error or a presentation error.** They have entirely different blast radii:

   | | Computation | Presentation |
   | --- | --- | --- |
   | Where | `@prl/poker-engine`, `@prl/poker-math` | formatting in `@prl/ui` or a page |
   | Blast radius | every learner, every surface, silently | one surface |
   | Contained by | rolling back | rolling back the web tier only |

   The distinguishing question: does the same figure appear correctly anywhere else? A number that is right in the API response and wrong on screen is presentation. There is precedent — a metric once printed `160%` because a value in the probability domain was formatted as a percentage twice.

3. **If it is a computation error, contain by rolling back** to the last digest whose exhaustive suite passed → [rollback.md](rollback.md). Do not leave a wrong number teaching people while a fix is written.

4. **If it is confined to one surface**, that surface can be disabled instead. The Coach is already refusable — Expert-difficulty Legend matches advertise `coachAvailable: false` and the socket answers `coach_not_available`, so refusing analysis is a supported state rather than an improvised one.

Do **not** "adjust" a number to match expectation. If the expectation is right, the calculation is wrong and must be fixed where it is computed.

## Diagnosis

### Reproduce it as a test, not by hand

The pure core has no I/O, no clock, no global state and no randomness except through an explicitly passed source. That is what makes this tractable: the exact case is a function call.

Write the reported case as a test first, in the relevant package, and confirm it fails. A case that will not reproduce is either a presentation bug or a misreport, and either way you have learned the important thing.

### Check whether the exhaustive suites already disagree

```bash
pnpm run test:exhaustive
```

If this fails, the evaluator is wrong and the blast radius is everything. That is the most serious version of this incident.

If it passes, the evaluator is right for all 133,784,560 seven-card hands and the fault is above it: range construction, the equity path, the EV assembly, or presentation.

### Exact versus Monte Carlo

`docs/adr/0005-exact-then-monte-carlo.md` describes the split: exact enumeration where the space is small enough, Monte Carlo beyond it. Two failure modes follow, and they look different:

- **A wrong exact result** is deterministic and reproduces every time. That is a logic bug.
- **A wrong Monte Carlo result** varies between runs. If it varies, ask whether it varies *more than the sample count justifies*. A figure within sampling error is not wrong; a figure outside it means the sampler, the range, or the sample count is wrong. Sampling error is a property of the number of samples, so state the sample count when judging.

A Monte Carlo result that is *stable* and wrong is a logic bug wearing sampling clothes.

### Ranges and the inputs, which is where these usually live

The evaluator being exhaustively verified means the arithmetic is rarely the problem. In practice the fault is in what was handed to it: a range parsed wrongly, a board with a duplicate card, dead cards not removed, the wrong number of unseen cards, or a street boundary off by one. Check the *inputs* to the calculation before the calculation.

### Content, which must not contain answers

`docs/adr/0006-no-hardcoded-odds-in-content.md` forbids hardcoded odds in lesson and scenario content: every figure a learner sees is computed, so that content and code cannot drift. A wrong figure in a lesson is therefore either a real computation error or a violation of that ADR — and the second is worth checking, because it would mean the number was never computed at all.

### Worker faults

A crashed or timed-out worker must never produce a *partial* result. `assertReportStaysInsideItsLegalSet` exists for this: a Coach report is checked against the legal action set before it is returned. Check `prl_worker_tasks_total{outcome}` and the pool warnings — a `protocol-mismatch` means the worker script and the pool disagree, which is a half-deployed image and can produce nonsense.

## Recovery

1. **Fix it where it is computed.** Never at the presentation layer, and never with a clamp that hides an out-of-range value — a clamp turns a visible bug into an invisible one.
2. **Add the reported case as a permanent test**, alongside the property tests. Property tests find classes of bug; the reported case is the proof that this one is closed.
3. **Widen the property test if the class is wider than the case.** A single bad hand is usually a symptom of an invariant nobody asserted.
4. **Re-run every exhaustive suite** before shipping. This is the one class of change where "the unit test passes" is not enough.
5. **Consider what learners were taught.** If a figure was wrong for a meaningful period on a lesson or a review, that is worth saying out loud rather than silently correcting.

## Verification

```bash
# 1. The reported case fails before the fix and passes after. Prove BOTH.
git stash && node --test <the new test>      # expect FAIL
git stash pop && node --test <the new test>  # expect PASS

# 2. Exhaustive evaluator — the whole seven-card space.
pnpm run test:exhaustive

# 3. Invariants and property tests.
pnpm run test

# 4. All 12 strategy profiles still behave as documented.
pnpm run test:simulation

# 5. Content figures still match what the code computes — no hardcoded odds reintroduced.
pnpm run fixtures:check

# 6. The live surfaces agree with each other for the reported hand.
pnpm run test:smoke --strict
```

Step 1 is the one that matters, and it is written out rather than implied because a test that would have passed before the fix proves nothing.

## Escalation

Escalate when:

- `pnpm run test:exhaustive` fails. The evaluator is the foundation everything else stands on, and this is the highest-severity correctness finding this system can produce.
- The wrong figure appeared in lesson or scenario content. That is teaching material, and its blast radius is every learner who read it rather than every learner in a hand.
- The figure was wrong across more than one deploy. The window needs bounding by image digest and the affected surfaces need listing.
- The cause is in the Monte Carlo path and you cannot demonstrate that the new result is within sampling error of the exact one where an exact answer exists. "It looks right now" is not a verification.
- Fixing it would require changing an invariant. Invariants are the thing that makes the correctness claims meaningful; changing one is a design decision, not an incident action.

Related: `docs/VERIFICATION.md`, `docs/adr/0005-exact-then-monte-carlo.md`, `docs/adr/0006-no-hardcoded-odds-in-content.md`, `docs/adr/0012-probabilistic-policies-and-no-llm-in-the-loop.md`.

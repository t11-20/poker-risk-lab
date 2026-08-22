# Hidden-information incident

Any suspicion that hole cards, deck order, a deck cursor, or a commitment salt reached somewhere it must not.

**This is the most serious class of incident this system has, and it outranks availability.** The entire product is a claim that the server is authoritative and that a client is never trusted with what it must not know (`docs/adr/0003-redaction-by-construction.md`). Everything else can be restored. A disclosure cannot be taken back.

Treat any credible suspicion as an incident at page severity, including when the service is perfectly healthy. Do not wait for confirmation before containing.

---

## Symptoms

Any of the following, from any source:

- A learner reports seeing another seat's cards, or predicting the next card.
- A WebSocket frame, an API response, or a log line contains a field named `holeCards`, `deck`, `deckOrder`, `cursor` or `salt` where it should not be.
- A hand-review or comparison payload exposes a seat's private view for a hand still in progress.
- A commitment reveal appears before the hand is complete.
- `prl_authz_failures_total` spikes — an authenticated caller repeatedly refused other people's rooms and hands is somebody enumerating for exactly this.
- A code review, a scan, or a dependency change touched the redaction boundary.

## Detection

Automated:

| Signal | What it is |
| --- | --- |
| `AuthzFailureSpike` (page) | authenticated callers refused resources — enumeration |
| `pnpm run test:smoke --strict` §hidden-info | scans live WebSocket traffic for deck, cursor and salt |
| `apps/api/test/hidden-information-api.test.ts` | the in-process contract |
| The accessibility-tree audit | asserts a hidden card's accessible name never states a rank or suit — a leak into the accessibility tree is still a leak |

Manual, against a running deployment:

```bash
# Everything a client actually received. Must produce no output.
grep -Ei '"(holecards?|deck|deckorder|cursor|salt|commitmentsalt)"' <captured-frames.jsonl>

# Metrics must never carry any of it either.
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" \
  | grep -Ei 'holecard|deck|salt|cursor'

# Logs. Three redaction layers should make this impossible; verify rather than assume.
kubectl logs <pod> --since=24h | grep -Ei '"(holecards?|deck|deckorder|salt|commitmentsalt)":' \
  | grep -v '\[redacted\]'
```

The last one is the important inversion: finding the key name with `[redacted]` as its value is the system working. Finding it with a real value is the incident.

## Immediate containment

Containment comes before diagnosis here, and it is more aggressive than for any other incident.

1. **Preserve evidence before changing anything.** Capture the frames, the response, the log lines, the request ids and the room and hand ids. Once you restart or roll back, the state that explains it is gone, and this is the one incident where knowing the exact blast radius matters more than restoring service quickly.

2. **Stop the affected surface.** In order of preference:
   - If one endpoint or one message type is implicated, disable that path.
   - If the live table path is implicated, stop accepting new rooms and let existing hands finish — the exposure is already done for hands in progress and cutting them off does not undo it.
   - Roll back to the last digest that is known not to have the defect → [rollback.md](rollback.md). **Rolling back is cheap and a disclosure is not**; do not spend an hour confirming before you roll back.

3. **Do not restart to "clear" it.** A restart does not un-send a frame, and it destroys the evidence.

4. **Bound the exposure in time.** Establish the first deploy that could have leaked, using image digests, not tags. Everything between that digest and now is the window.

5. **Notify the incident owner immediately**, even out of hours, even if the service is healthy. This is not an availability judgement call.

## Diagnosis

### 1. Establish whether it is a genuine leak or a misread

Some of these are expected and correct:

- **Your own hole cards.** Every seat sees its own. That is the product.
- **A completed hand's showdown.** Cards shown at showdown are public.
- **A completed hand's review or comparison.** Post-hand analysis discloses what each seat could see, deliberately — `hand_not_comparable` exists precisely so that this is refused *while the hand is in progress*.
- **The commitment hash.** The Merkle commitment is published up front (`docs/adr/0004`); that is the point. The **salt** and the **order** are not.

A leak is: another seat's cards while the hand is live; deck order or the deck cursor at any time; a salt before its reveal; or any of them for a hand or room the caller is not part of.

### 2. Find where the boundary was crossed

The engine redacts **by construction**: a client view is built from a projection that never contains hidden state, rather than by deleting fields from a full state. So a leak is almost always one of four things, and they are worth checking in this order:

1. **A new field added to a view type** that was populated from the full state rather than the projection.
2. **A new WebSocket message** that serialises a state object directly instead of going through the redaction step.
3. **A route returning an internal record** — a repository row rather than a response type. Repository rows contain everything.
4. **An error path** that includes internal detail. Error bodies are built from a fixed contract shape for exactly this reason; a handler that returns a raw object bypasses it.

```bash
# Anything constructing a client-facing payload from an unredacted source.
git log -p --since='<window start>' -- apps/api/src/ws/ apps/api/src/rooms/ apps/api/src/review/ \
  packages/poker-engine/src/ | grep -nE 'holeCards|deck|salt|cursor|redactFor|snapshot\('
```

### 3. Establish the blast radius

For each implicated hand: which seats, which learners, which sessions, over which time window. Room and hand ids are in the **logs**, not in metrics — that separation is deliberate and this is the case it was designed for.

Fairness impact is the second question. Play money and no cash-out bound the harm severely (`docs/PRODUCT-GUARDRAILS.md`), and that is worth stating plainly in the incident record — but it does not reduce the severity of the defect, only its consequence.

### 4. Rule out the deliberate escape hatches

Two things legitimately reveal hidden state and must be confirmed to be behaving:

- **Commitment reveal after a hand**, which is how a learner verifies the shuffle was not manipulated. Correct after the hand, a leak before it.
- **Hand review and Legend comparison**, which are post-hand by design and refuse a live hand with `hand_not_comparable`.

If either fired early, the defect is in the *timing* check, and that check is the thing to fix.

## Recovery

1. **Fix the boundary, not the symptom.** Filtering a field out of one response leaves the same hidden state reachable through the next serialiser somebody adds. The fix belongs where the projection is built.
2. **Add a regression test that fails without the fix.** `apps/api/test/hidden-information-api.test.ts` is where the contract lives. The test must assert over the *serialised* payload a client would actually receive, not over an intermediate object — a leak that only appears after serialisation is exactly the leak an object-level assertion misses.
3. **Extend the automated scans** to cover the shape that leaked, in the smoke test's hidden-information scan and in the accessibility-tree audit.
4. **Rotate what can be rotated.** Salts and deck order are per hand and cannot be un-disclosed; there is nothing to rotate. If a *session* token or a *secret* was in the same payload, that is also [leaked-secret.md](leaked-secret.md) and the rotation there applies.
5. **Deploy the fix through the normal pipeline**, including staging. A hurried fix to a security boundary that skips verification is how the second incident happens.

## Verification

```bash
# 1. The regression test fails on the old code and passes on the new. Prove both.
git stash && node --test apps/api/test/hidden-information-api.test.ts   # expect FAIL
git stash pop && node --test apps/api/test/hidden-information-api.test.ts # expect PASS

# 2. The full hidden-information suite, the engine invariants, and the property tests.
pnpm run test
pnpm run test:exhaustive

# 3. Live traffic against the deployed fix: the smoke scan reads real frames.
pnpm run test:smoke --strict

# 4. The accessibility tree, which is a second, independent path a card could escape through.
pnpm run test:ax

# 5. Nothing hidden in metrics or logs.
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" | grep -Ei 'holecard|deck|salt|cursor'
kubectl logs <pod> --since=1h | grep -Ei '"(holecards?|deck|salt)":' | grep -v '\[redacted\]'
```

Steps 1 and 3 are the ones that count. A passing test that would also have passed before the fix proves nothing, which is why the stash step is written out rather than assumed.

## Escalation

Escalate immediately — do not wait for diagnosis — when:

- Hidden state reached a client that was not entitled to it, at all, for any duration.
- Deck order or a deck cursor left the server in any form.
- The exposure window spans more than one deploy, or cannot be bounded.
- Any evidence of deliberate exploitation: enumeration in `prl_authz_failures_total`, crafted frames, or a caller systematically walking room and hand ids.

The incident record must state: the window by image digest, the number of hands and learners affected, exactly what was exposed, whether it was exploited or only exposed, the fix, and the test that now prevents it. State plainly that this is play money with no cash-out and therefore no financial loss — and do not let that sentence do any work in deciding severity.

Related: [`../security.md`](../security.md), `docs/THREAT-MODEL.md` (assets and trust boundaries), `docs/adr/0003-redaction-by-construction.md`, `docs/adr/0004-merkle-deck-commitment.md`.

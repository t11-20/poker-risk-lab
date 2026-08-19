> **Lead freeze, 2026-08-19.** Independent first-pass by the named reviewer at HEAD `f20bbad`. Subsequent P1 remediations are recorded in `docs/audit/final-traceability.md` and `docs/audit/final-release-report.md`. This file is the reviewer's own evidence, not a clearance.

# Reviewer G — AI Poker Legends

**Auditor:** independent (did not build this)  
**HEAD:** f20bbad  
**Date:** 2026-08-19  
**Scope:** `docs/AI-LEGENDS.md`, `packages/poker-ai/src/*`, `packages/contracts/src/legends.ts`, `apps/api` rooms/bots + legends routes, `apps/web` legends pages.  
**Previous PASS claims:** untrusted. `docs/audit/*.md` not used as evidence.

## Verdict

**PASS — no P0, no P1.**

The twelve profiles are numeric trait vectors through one shared `decide()`. The policy input type cannot represent a `HandState`. Hidden/future cards are unrepresentable at the call site that matters, and I re-ran the instrumented read-set + invisible-card-swap tests. Commentary is third-person about “this model”; impersonation is asserted at profile load and at generation; I grepped generated strings myself. Naming defaults to archetype, throws on garbage, and never returns a display name without disclaimers. I re-ran the statistical suite: the profiles are distinguishable in play, the z-test can fail, and the same seed reproduces.

Must-recheck items (hidden cards, honest explanations, no impersonation): **hold**.

---

## How this audit was done

1. Read `docs/AI-LEGENDS.md` and the implementation files listed in §13, plus contracts, API `bots.ts` / `rooms.ts` / `legends.ts`, and `apps/web/src/app/legends/**`.
2. Type-level walk of `PolicyInput` / `decide()` / `PlayerView` vs `HandState`.
3. Grep of `packages/poker-ai` for `holeCards`, `deck`, `deckCursor`, `deckSalts`, `HandState`, `Math.random`, LLM clients, first-person templates.
4. Independent Node script from `packages/poker-ai`: naming modes (unset / empty / attributed / garbage), `profileDisclosure` disclaimer matrix, byte-identity of educational fields across modes, `findImpersonation` over 144 authored profile strings, 16 live `decide()` + `explainModelDecision` + `commentOnDecision` generations (224 strings), z-test can-fail check.
5. Ran `pnpm --filter @prl/poker-ai test` — **148/148 pass**.
6. Ran `pnpm --filter @prl/poker-ai test:simulation` — **23/23 pass** (96,000-hand sweep + difficulty + mixed-spot calibration).
7. Did **not** read `docs/audit/*.md`. Did **not** modify source.

---

## Requirement table

| ID | Requirement | Result | Evidence |
| --- | --- | --- | --- |
| LEG-001 | Twelve educational strategy simulations as trait vectors, not bespoke celebrity scripts | **PASS** | `PROFILES` in `packages/poker-ai/src/profiles.ts` has exactly 12 ids. Independent count: `vocal-aggressor`, `adaptive-exploiter`, `patient-technician`, `reading-pressure-specialist`, `old-school-pressure`, `mixed-game-generalist`, `volume-grinder`, `disciplined-specialist`, `foundational-reader`, `range-narrator`, `fundamentals-coach`, `calling-station`. Each is `makeTraits({…16 axes})` plus authored prose. One `decide()` in `policy.ts`. No per-celebrity script files. |
| LEG-002 | Numbers are design parameters, not measurements of real people; no hand histories consulted (structurally) | **PASS** | Every `modelBasis` is either `ATTRIBUTED_BASIS` / `ARCHETYPE_BASIS` or the course sentence — all start “Design parameters…”. Independent scan: every basis contains “design parameter”; none claims measurement from histories. No hand-history import, parser, or dataset in `packages/poker-ai`. Trait values are literals in `profiles.ts`. |
| LEG-003 | No endorsement/affiliation implied | **PASS** | `UNIVERSAL_DISCLAIMER` always: “not endorsed by anyone”. `ATTRIBUTION_DISCLAIMER` when an attributed name is shown: “not affiliated with or approved by them”. Guard rejects `endorsed` / `approved by` / `official` / `partnership` in commentary and profile prose. UI copy on `/legends` and `/legends/[profileId]` repeats the framing. |
| LEG-004 | Naming: archetype by default; attributed only via `PRL_LEGEND_NAMING=attributed` | **PASS** | `resolveNamingMode()`: unset / empty / whitespace → `archetype`. `attributed` (case-folded) → `attributed`. Independent run: `UNSET`, `""`, `"   "`, `"archetype"` → archetype; `"ATTRIBUTED"` / `"attributed"` → attributed. Web fixture forced to archetype (`apps/api/test/legends-naming-fallback.test.ts`). |
| LEG-005 | Unrecognised naming env throws, does not fall back | **PASS** | Independent: `true`, `yes`, `1`, `garbage`, `false` each throw `LabellingError` (“must be \"archetype\" or \"attributed\""). No fallback path in `labelling.ts`. **Note:** `apps/api/src/config.ts` does **not** call `resolveNamingMode` at boot; a typo survives process start and fails on the first Legends request. The function itself does not fall back. P3. |
| LEG-006 | `profileDisclosure` returns name + disclaimers together; no name-only API | **PASS** | Sole identity function is `profileDisclosure(naming, mode): ProfileDisclosure` with required `disclaimers`. No `displayNameFor` export (comment in `labelling.ts` is stale). Package public surface (`index.ts`) does not export a name-only helper. Wire type `ProfileDisclosureDto.disclaimers` is required non-empty. **Note:** `botDisplayName(profileId)` in `apps/api/src/rooms/bots.ts` builds a 24-char seat plate from the kebab id (`Vocal Aggressor`), never an attributed name; full disclosure travels beside it. P3. |
| LEG-007 | UNIVERSAL always; ATTRIBUTION when attributed; COURSE for course profile | **PASS** | Independent matrix over 12 × 2 modes: `disclaimers[0] === UNIVERSAL_DISCLAIMER` always; `ATTRIBUTION_DISCLAIMER` iff `mode === 'attributed' && attributedName`; `COURSE_PROFILE_DISCLAIMER` iff `isCourseDerived` (`fundamentals-coach`). Two profiles have no attributed name (`fundamentals-coach`, `calling-station`) and never get the attribution sentence. |
| LEG-008 | Educational content identical in both naming modes | **PASS** | Independent: `profileCard(..., 'archetype')` vs `'attributed'` — `learnFrom`, `styleNotes`, `counterStrategy`, `modelBasis`, `traits`, `signatureTraits`, `bestFor` are `JSON.stringify`-equal for all 12. Only `disclosure` changes. API `GET /legends/profiles` uses `profileCard`. |
| LEG-009 | Impersonation ban: no first person, no mental-state attribution, no “he would raise” | **PASS** | Shared patterns in `labelling.ts` reject pronoun+mental-state, `is/was thinking`, `would say/tell/think/feel`, inner-view phrases, first-person *opening*, endorsement, “digital twin”, “the real \<Firstname\>”, capitalised-name+mental-state, and **any gendered pronoun** (which catches “He would raise here”). `commentary.ts` `assertModelVoice` additionally bans person-name tokens derived from `attributedName`, first-person **anywhere**, verdict words, and caller labels / private cards. Independent: the three §3 BAD examples all fail the shared guard. |
| LEG-010 | `assertNoImpersonation` at profile load AND at commentary generation | **PASS** | `validateProfiles()` at module scope in `profiles.ts` runs the guard over `learnFrom`, `styleNotes`, `counterStrategy`, `modelBasis`, `archetypeTagline` — importing `PROFILES` is itself the load-time check (the package imported cleanly). `decide()` asserts every rationale, every `whatChangedIt`, and `modelPreference` before return. `publishCommentary` (only mint of `LearnerFacing`) runs `assertNoImpersonation` then `assertModelVoice`. Independent: 144 authored strings clean; 224 generated strings clean. |
| LEG-011 | Policy input unrepresentable for hidden/future cards (PlayerView + own cards, never HandState) | **PASS** | `PolicyInput` is seven keys: `view: PlayerView`, `holeCards`, `seat`, `traits`, `difficulty`, `observations`, `random`. No `state` / `handState` / `deck*`. `PlayerView` (`packages/poker-engine/src/redact.ts`) has no `deck`, `deckCursor`, `deckSalts`; `SeatView.holeCards` is null except self or completed showdown. `HandState` is not assignable to `PlayerView` (missing `legalActions`, `amountToCall`, `viewerSeat`, `commitmentRoot`, …). Production `buildPolicyInput` takes a redacted view only. Simulation harness is privileged and still hands `redactFor` + own cards into `decide`. |
| LEG-012 | Policy never receives other hole cards, deck, cursor, salts | **PASS** | Type: unrepresentable (LEG-011). Runtime: `test/no-hidden-information.test.ts` serialises the input (no `"deck"` / `deckCursor` / salt; no card in `cardsHiddenFrom`). Instrumented `Proxy` over the view: no path containing `deck`, `deckCursor`, `deckSalts`, `salt`, `holeCards`, `result`. Policy does not even read its own `view.seats[].holeCards` — own cards arrive as `input.holeCards`. Invisible-opponent-card swap: action, distribution, equity, and `modelPreference` byte-identical. Re-ran: all 7 hidden-info tests pass. Opponent model: `observeHandComplete(PlayerView)` reads `view.result.showdowns` only; fold-out records no cards (`opponent-model.test.ts`). |
| LEG-013 | Decisions sampled from a distribution over LEGAL actions only | **PASS** | `planCandidates` iterates `situation.legalActions` only; default branch throws on an unknown type. `sampleFrom` draws from that distribution. Independent: 16 decisions — sampled type ⊆ legal set; bet/raise sizes inside `minTo`/`maxTo`. Unit sweep: “every proposed action is legal… across thousands of decisions” (4k+ decisions, 800+ hands). Simulation: `sizeClampsApplied === 0` on all 12 × 8,000-hand runs. Engine re-validates via `applyAction` / `submitAction`. |
| LEG-014 | Controlled randomness via injected RNG; no `Math.random` in decision loop | **PASS** | `PolicyInput.random: RandomSource`. Sampling and size jitter use `random.nextInt`. Grep of `packages/poker-ai/src`: `Math.random` only in comments. `test/no-math-random.test.ts` scans `src/` (comments stripped), bans `Math.random` / `randomUUID` / `randomBytes`, and **proves the detector can fail**. Re-ran: pass. Bots use `createSeededRandom` (SplitMix32) for decisions; cards dealt from `createSecureRandom()`. |
| LEG-015 | Pre-sampling distribution exposed to the learner | **PASS** | `PolicyDecision.distribution` is part of the return. `ModelReasoning.actionProbabilities` is required on the wire. `explainModelDecision` copies the distribution (sorted). Compare API returns `actionDistribution` across trials plus `actionProbabilities` from the last trial. UI: `ActionDistribution` / compare page / `PostHandComparison`. Tests assert more than one live action wherever more than one is legal. |
| LEG-016 | Strategy quality is never outcome-based (`DecisionQuality` from EV before runout) | **PASS** | `scoreDecisionQuality({ analysis, chosenAction, bigBlind })` — no chip-result / board-runout parameter. `buildHandComparison` assembles `chipResult` and `decisionQuality` independently; `outcomeVersusQualityNote` is the only meeting point and fires only when they disagree (`consistent-with-analysis` + loss, or `materially-off` + win). Test: same decisions, opposite chip results → identical quality, alternatives, commentary. Unscored hand: no congratulatory note. |
| LEG-017 | Engine is authoritative; sizes clamped to minTo/maxTo | **PASS** | `chooseSizeTo` requires `legal.minTo`/`maxTo` and `Math.min(maxTo, Math.max(minTo, Math.round(chosen)))`. Bot actions go through `LiveTable.submitAction` (same path as a human). Simulation `resolveAction` counts clamps; primary sweep asserted **zero** clamps. Illegal proposal fails the run rather than being repaired. |
| LEG-018 | Profiles behave statistically differently (simulation evidence inspected **and** re-run) | **PASS** | Re-ran `test:simulation` (23/23). Primary sweep: 12 × 8,000 HU hands vs `reading-pressure-specialist`, seed `20260817`. Observed VPIP 0.158–0.507 tracks declared 0.15–0.52 (mean signed error +0.0132, tolerance 0.05). Extremes: VPIP z = 41.175; aggression z = 59.399; 3-bet z = 29.923; all significant at α = 0.001. 61/66 VPIP pairs separate; 5 adjacent pairs named as indistinguishable — the suite does **not** require every pair to split. Spearman ρ(declared, observed VPIP) = 1.000. Independent z-test: identical 400/1000 vs 400/1000 is **not** significant; 4000/8000 vs 1200/8000 is (z = 47.26). **Not tautological.** |
| LEG-019 | Reproducible tests exist and actually pin behaviour | **PASS** | Same seed → identical action, distribution, equity (`policy.test.ts`). Simulation: same seed → byte-identical `bySeat` (elapsedMs excluded). Different seed → >80% of VPIPs move, ordering ρ = 0.993. Mixed spot 3,000 trials matches published weights within 4σ. Hidden-info, impersonation, Math.random, and z-test suites all include “the guard can fail” cases. I re-ran the unit and simulation suites; both green. |
| LEG-020 | Risk/reward explanations are honest (assumptions, no false certainty) | **PASS** | Policy / commentary templates name price, break-even equity, assumed fold frequency, sample reliability, and “no read yet”. `CoachReport` candidates carry assumptions; quality notes say “on the range and fold-equity assumptions stated in that report”. Bands are qualitative, never “correct” / “optimal” (verdict words banned in `assertModelVoice`). Compare takeaway states the reconstruction assumptions (HU, hero on button, prior pot split). Profile cards: every axis description names a cost. §12 documents L1–L11. |
| LEG-021 | Does not falsely impersonate real players in UI copy | **PASS** | `/legends` h1 is “Opponent profiles”; naming chip + universal disclaimer + mode note. Profile page h1 is **archetype**; attributed name (if any) is a label under it with “(modelled style)”. Metadata titles use archetype only. Offline fixture is archetype-only and is tested so it cannot ship attributed names. Grep of `apps/web/src/app/legends` and `components` used by those pages: no Ivey/Hellmuth/etc. in rendered copy except via `disclosure.displayName` when the server opted in. |
| LEG-022 | Does not claim private thoughts | **PASS** | Wire field is `modelPreference`, not `thought`. Templates: “This model prefers…”. `assertModelVoice` rejects `thinks/feels/believes/senses/intends/wants/remembers`. Comparison never analyses a model seat (`analysis: null`) so a folder’s outs never appear. Independent generated headlines all start “This model prefers”. |
| LEG-023 | No LLM in the decision loop | **PASS** | `packages/poker-ai` dependencies: `@prl/contracts`, `@prl/poker-engine`, `@prl/poker-math` only. Grep: no `openai`, `anthropic`, `@ai-sdk`, `generateText`, chat completions. `decide()` is a pure function of `PolicyInput`. Commentary is templates through `publishCommentary`. ADR 0012 records the rejection of an LLM in or beside the loop. |
| LEG-024 | Limitations documented (`docs/AI-LEGENDS.md` §12 or equivalent) | **PASS** | §12 L1–L11 present (coarse styles, not solver-derived, no multi-street planning, frequency opponent model, texture-blind ranges, no beatability claim, pattern-list guard, sampling error, no tilt, ICM approximations, NIL is the deployer’s problem). **Note:** L7 is **stale** relative to the code — it still says the guard misses “Name + mental-state verb” and “he would \<poker verb\>"; both are now caught. §3 already describes the fix. P3 docs drift. |
| LEG-025 | Difficulty settings change behaviour without cheating | **PASS** | `educational`: traitExpression 0.6 toward **baseline** (not 0.5), noise 0.18, `exploitativeAdaptation` forced 0, 4k equity samples, coach on. `expert`: full traits, noise 0.05, adaptation on, 12k samples, coach off during play. Extra samples are of **own** equity vs an **assumed** range (`assessPostflop` → `monteCarloEquity` with `topPercentRange` / opponent-model range), not the live remainder of the deck. Unit: educational postflop entropy > expert + 0.05; preflop entry mass independent of noise. Simulation: educational VPIP spread 0.196 vs expert 0.357; adaptation structurally 0 at educational. Independent: `expressTraits(adaptive-exploiter, educational).vpip = 0.268` (between baseline 0.25 and declared 0.28), `exploitativeAdaptation = 0`. |
| LEG-026 | Post-hand comparison / `learnFrom` / `counterStrategy` exist and are not placeholders | **PASS** | Every profile has ≥2 `learnFrom` and ≥2 `counterStrategy` (enforced at load). Independent: authored lines pass through `learnFromSummary`; counters are the profile’s own sentences. `buildHandComparison` is a real builder with outcome-independence tests. `POST /legends/compare` runs `compareProfilesOnSpot`. `GET /legends/profiles/:id` returns `learnFrom` + `counterStrategy`. `observed` is **null** with an explicit producer-side reason (legacy `bot_profile` CHECK, bluff not visible, no `raiseWasAvailable` column) — honest absence, not a fake session. |
| LEG-027 | Complete-hand → explanation journey works (API **or** package-level) | **PASS** | Package: `buildHandComparison` + `explainModelDecision` + `commentOnDecision` + `outcomeVersusQualityNote` — tested, including “no hidden card in the comparison”. API: play via `POST /legends/matches` (real room + `BotRunner` + `decide`); spot compare via `POST /legends/compare`. **Gap (not a fail of the OR):** there is no `GET /legends/hands/:id/comparison`. `/legends/hand-review` renders `HAND_COMPARISON_FIXTURE` and **says so** (`loadHandComparison` documents the missing route). Package-level journey is complete. |

---

## Type-level: hidden fields cannot be passed

`decide(input: PolicyInput)` is the only decision entry.

```ts
export interface PolicyInput {
  readonly view: PlayerView;          // redactFor output
  readonly holeCards: readonly [Card, Card];
  readonly seat: SeatIndex;
  readonly traits: Traits;
  readonly difficulty: DifficultySettings;
  readonly observations: PolicyObservations; // statsFor / rangeFor / adjustmentsFor
  readonly random: RandomSource;
}
```

- There is no `HandState` field. `HandState` carries `deck`, `deckCursor`, `deckSalts`, `commitment.secret`, and every seat’s `holeCards`.
- `PlayerView` is built field-by-field in `redact.ts`. It has `board`, `legalActions`, `actions`, `seats: SeatView[]`, `result` (completed hands only). It does **not** have deck / cursor / salts.
- `SeatView.holeCards` is typed `readonly [Card, Card] | null` and documented as self-or-showdown only.
- `PolicyObservations` has no card field. `PublicActionEvent` (opponent-model input) has no card field.
- `readSituation` is the only function that touches `input.view`. It never reads any seat’s `holeCards`. Own cards come from `input.holeCards`.
- Excess-property / missing-field: a `HandState` cannot be supplied as `view` without a lie (`as PlayerView`), because `PlayerView` requires `legalActions`, `amountToCall`, `viewerSeat`, `commitmentRoot`, etc.

Fails-closed: adding a hidden channel requires editing `PolicyInput` and the permitted-key test.

Production construction (`apps/api/src/rooms/bots.ts` `buildPolicyInput`): redacted `view` + `own.holeCards` from that view. `BotRunner.act` calls `table.viewFor(botUserId)` then `decide`. Compare reconstructs a hypothetical `HandState` only so `redactFor` can produce a legal set; dummy opponent cards exist in that discarded state and are nulled in the view the policy sees.

---

## Grep / independent string work

| Probe | Result |
| --- | --- |
| `Math.random` in `packages/poker-ai/src` | Comments only. Source scan test pass. |
| LLM / OpenAI / Anthropic / `@ai-sdk` in poker-ai | None. |
| First-person templates in policy/commentary | None. Headlines are `This model prefers to …`. |
| Authored profile strings × `findImpersonation` | 144 scanned, 0 findings. Module load = `validateProfiles`. |
| Generated (16 decisions × 4 profiles, both naming modes) | 224 strings, 0 findings. Attributed tokens (`Ivey`, `Phil`, …) not interpolated. |
| Guard can fail (independent) | `Ivey senses weakness…`, `He would raise here.`, `I like a bet here.`, `She feels…`, `They think…` all rejected. |
| Shared-guard gap | Mid-sentence `I` (`This model prefers a bet, and I like it.`) is **missed** by `findImpersonation` (pattern is `^\s*(?:I\|My)\b`). `assertModelVoice` catches first-person anywhere. Policy path uses the shared guard only; its templates do not emit mid-sentence first person. P3. |
| UI celebrity names | Only via `ProfileDisclosure` when opted in. Fixture tree banned from attributed mode. |

---

## Tests I ran (not inherited claims)

```
pnpm --filter @prl/poker-ai test
  148 pass, 0 fail, ~4.3s

pnpm --filter @prl/poker-ai test:simulation
  23 pass, 0 fail, ~112.6s
  sweep: 12 × 8000 HU vs reading-pressure-specialist @ realistic, seed 20260817
  96000 hands, 260426 actions, 74.1s
```

Simulation numbers I actually saw:

| profile | declared VPIP | observed | Δ |
| --- | --- | --- | --- |
| disciplined-specialist | 0.150 | 0.1582 | +0.008 |
| fundamentals-coach | 0.230 | 0.2409 | +0.011 |
| calling-station | 0.520 | 0.5068 | −0.013 |
| reading-pressure-specialist | 0.420 | 0.4424 | +0.022 |

0 divergences vs `OBSERVABLE_AXES` tolerances. Mean signed VPIP +0.0132 (sampling half-width at 8,000 ≈ 0.011). Educational VPIP spread 0.196 vs expert 0.357. Mixed spot 3,000 seeds: raise 0.711 / call 0.162 / fold 0.127 vs declared 0.723 / 0.159 / 0.118.

Why the stats tests are not tautological:

- `twoProportionZTest` uses a pooled SE derived in the test from first principles; identical samples give z = 0 and `significantAt` false at any α (I re-checked independently).
- Adjacent profiles are **allowed** to be indistinguishable; the suite names them and only asserts that >60% of pairs separate.
- Three axes (pfrShare, bluff, sizing) show one-sided bias **inside** tolerance and are **not** directionally asserted — printed, not papered over.
- `aggressionFrequency` is measured on the **neutral** band; the file also proves the unconditional reading is arithmetically impossible for 4/12 profiles.

`profileDiversity()` exists (independent: min distance 0.0813, mean 0.1959, closest `mixed-game-generalist`/`volume-grinder`, 66 pairs). `docs/AI-LEGENDS.md` §11 claims a test asserts a floor on that minimum. **No such assertion exists** in `packages/poker-ai/test`. Play-level differentiation is what I verified. P3 docs/test drift.

There is **no** `packages/poker-ai` unit test that calls `resolveNamingMode`. I booted the three modes myself. API `legends-naming-fallback.test.ts` pins the web fixture to archetype.

---

## Integrity attack notes

These are the attacks I actually tried to make, on paper and in tests.

### 1. Feed the policy a HandState

Type refuses. Runtime key list is closed (`PERMITTED_INPUT_KEYS`). Serialised walk has no deck/cursor/salt. A caller would have to add a field — that is a reviewable change, not an autocomplete.

### 2. Read another seat’s holeCards off the view

`redactFor` nulls them. Instrumented policy never touches any `holeCards` path, including its own. Swap of an invisible opponent hand leaves the decision identical; commitment roots differ so the two hands were not the same hand.

### 3. Learn from a fold-out

`observeHandComplete` takes `PlayerView`, cards only from `result.showdowns`. Fold-out test: no shown hands from any viewer. Two seats’ views of the same public hand produce identical observations.

### 4. Compare path dummy cards

`buildHypotheticalState` deals two leftover cards to the opponent so the engine can form a legal set. `redactFor(state, { viewerSeat: HERO_SEAT })` then `buildPolicyInput`. Those dummy cards never appear in the policy input. Compare `modelPreference` quotes equity of the **caller-supplied** hero cards — the learner already named them.

### 5. Mid-hand leak of the bot’s equity

`PolicyDecision.modelPreference` includes “it assesses X% equity…”. `commentary.ts` deliberately **does not** forward that string (it would leak a folder’s holding). Live `BotRunner` submits only the `Action`. `buildHandComparison` regenerates reasoning via `explainModelDecision` (no equity / private cards). Compare API **does** forward `last.modelPreference` — acceptable because the holding is the request’s `heroCards`.

### 6. Impersonate via attributed mode

`explainModelDecision` / `commentOnDecision` take `disclosure` / `actorLabel` only to **ban** those strings. Independent attributed-mode generation: no `Ivey` / `Phil` / other name tokens in prose. Contrast section on the API re-derives `otherDisplayName` through `profileDisclosure` (identity, not commentary).

### 7. Cheat via difficulty

More Monte Carlo samples at `expert` improve the estimate of **this seat’s** equity against an assumed range built from public frequencies. The sampler never sees the live stub. Adaptation uses public action counts, reliability-weighted, forced off at `educational`.

### 8. Scripted identical actions

Same spot, 40 seeds → more than one action (`policy.test.ts`). Mixed-spot 3,000 trials match the published distribution. Educational noise floor is on plausible actions only (free fold stays at 0).

### 9. Grade by pot result

`scoreDecisionQuality` cannot see the runout. Opposite chip results, identical quality. `outcomeVersusQualityNote` says both facts are true and that the result is not evidence.

### 10. Privileged-caller hole-card swap

A malicious caller could put another seat’s cards in `input.holeCards`. The **type** cannot stop a liar. Production has one construction site (`buildPolicyInput`) that reads the redacted own seat. API `bots.test.ts` captures a real live `PolicyInput` and walks it for secret field names, 52-card permutations, and the other seat’s cards. I did not re-run the API suite (out of allowed commands); I read the test and the construction site.

### 11. Garbage naming at boot

`PRL_LEGEND_NAMING=true` does not fail `loadConfig`. First Legends GET throws `LabellingError`. Not a silent fallback. Documented intent (“a server that boots with a misspelled naming mode is a server whose naming mode nobody knows”) is stronger than the wiring.

---

## Findings

### P0

None.

Hidden/future cards are unrepresentable in `PolicyInput` and unobserved in the instrumented runs. The product does not speak as a real person or attribute thoughts to one.

### P1

None.

Actions are sampled from a legal distribution with engine clamp. Disclaimers travel with the name. No LLM in the loop.

### P2

None that meet the bar.

Closest items, judged P3 rather than P2:

- Live per-hand comparison is package-level + a labelled fixture, not a wired API. LEG-027 allows package-level.
- `LearnFromProfileResponse.observed` is always null. The page says why. Not a fabricated session.

### P3

1. **`PRL_LEGEND_NAMING` is not validated at API boot.** `resolveNamingMode` throws and does not fall back (LEG-005 holds). `config.ts` never calls it. A typo starts the process and fails on first Legends request.
2. **No package-level unit test for naming modes.** I executed unset / attributed / garbage myself. Only the web-fixture test pins the default.
3. **Documented `profileDiversity()` floor test is missing.** Function exists; §11 claims a test asserts `minDistance`. No caller in `packages/poker-ai/test`. Play-level separation is tested and held.
4. **`docs/AI-LEGENDS.md` §12 L7 is stale.** Code now catches “Ivey senses weakness” and “He would raise here.” §3 already says so. L7 still describes the old hole.
5. **Shared impersonation guard misses mid-sentence first person.** `^\s*(?:I|My)\b` only. `assertModelVoice` covers the commentary chokepoint. Policy templates do not emit this shape.
6. **`botDisplayName` is a name-without-disclaimer helper** for the 24-char DB plate, derived from the profile **id**, never an attributed name. Disclosure still rides on every seat plan.
7. **Stale comment** in `labelling.ts` refers to `displayNameFor`, which does not exist.
8. **One-sided measurement residuals** (pfrShare +0.042, bluff +0.057, sizing −0.041, all 12/12 or 0/12) sit inside tolerance and are printed, not asserted. Honest, but a future widening of those tolerances would be the failure the comments warn about.
9. **`STORED_RUNS` empty `divergences`** match the 8,000-hand sweep I ran (0 divergences). The API test re-derives **one** profile (`patient-technician`) exactly from the recorded seed. The other eleven rows are completeness-checked, not re-simulated on every unit run.

---

## Counts

| | |
| --- | --- |
| Requirements | 27 |
| PASS | 27 |
| FAIL | 0 |
| P0 | 0 |
| P1 | 0 |
| P2 | 0 |
| P3 | 9 |
| Unit tests re-run | 148 pass |
| Simulation tests re-run | 23 pass |
| Authored strings independently scanned | 144 |
| Generated strings independently scanned | 224 |
| Profiles | 12 (10 attributed names in data, 2 archetype-only) |
| Trait axes | 16 |

**Overall: PASS.**

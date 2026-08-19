# Challenger review — Poker Risk Lab

**Reviewer:** independent principal (did not build this; did not read `docs/audit/**` as evidence)  
**Date:** 2026-08-19  
**Verdict:** **Do not ship.** Headline AI-Legends play is not wired. Stack accounting on re-sit is wrong. A process restart turns every bot into a timeout-folder. No P0 hidden-card or in-hand conservation failure was reproduced.

| Severity | Count |
| --- | ---: |
| P0 | 0 |
| P1 | 6 |

---

## Method

Read product constraints (`README.md`, `docs/PRODUCT-GUARDRAILS.md`, `docs/AI-LEGENDS.md`, `docs/SECURITY.md`, ADR 0003) then source: engine (`redact.ts`, `machine.ts`, `betting.ts`, `pots.ts`, `evaluate.ts`, `positions.ts`, `commitment.ts`), maths (`coach.ts`, `ev.ts`, `odds.ts`, `outs.ts`, `icm.ts`), AI (`policy.ts`, `profiles.ts`, `stats.ts`, `labelling.ts`), API (rooms, WS, hands, review, legends), web (play, legends, fixtures, CSP), Docker/compose, `pnpm-workspace.yaml`.

Did not treat prior audit write-ups as evidence. Did not install, reset the database, or take compose down.

---

## P1-1 — “Play this style” never seats that style

**Severity:** P1 (required feature missing)  
**Worst finding.**

The advertised AI Poker Legends loop is: pick a profile and a difficulty, sit down against that style, watch it, compare. The API can do that. The product the learner clicks cannot.

- `LegendCard` and `/legends/[profileId]` primary CTA is `legendMatchHref(profile.id, difficulty)` → `/play?profile=<id>&difficulty=<setting>` (`apps/web/src/lib/legends-data.ts:128-129`).
- `/play` only special-cases `?state=` fixtures. `profile` and `difficulty` are discarded (`apps/web/src/app/play/page.tsx:199-221`).
- `useLiveTable.prepare` always creates `BOT_TABLE_REQUEST` (`apps/web/src/lib/use-live-table.ts:520`): five **legacy** names (`tight-aggressive`, `calling-station`, `loose-aggressive`, `nit`) at implicit `realistic`.
- `POST /api/v1/legends/matches` exists (`apps/api/src/routes/rooms.ts:441`) and seats real profile ids at the requested difficulty. It is **absent** from `API_PATHS` (`packages/contracts/src/api-paths.ts`). The web client has no legal way to build that path. `apps/api/test/web-api-paths.test.ts` therefore cannot fail when the client never calls it.
- `createRoomBodySchema.bots[].profile` is an enum of the five 2024 names (`packages/contracts/src/schemas.ts:228-230`). The twelve Legends ids are not legal on `POST /rooms`. There is no client fallback that could work.

A learner who taps “Play this style” on *Disciplined Specialist / expert* gets a six-handed mixed table of mapped archetypes at `realistic`, with the Coach auto-requested every street (`use-live-table.ts:771-775`) — the opposite of the chip that said “Coach in review only”.

`web-api-paths` and the rooms tests give false confidence: they prove the match route exists on Fastify, not that any learner can reach it.

**Fix:** Add `legendMatches` to `API_PATHS`. Have `/play` read `profile` + `difficulty` and call `POST /legends/matches`. Stop advertising a query the play page ignores.

---

## P1-2 — Stand then sit wipes the live stack

**Severity:** P1 (chip accounting; required units invariant)

`sitAtTable` checks the **durable** stack, then seats the live table at the **room starting stack**, and never writes that buy-in back:

```714:734:apps/api/src/rooms/registry.ts
  async sitAtTable(...) {
    const units = await this.store.readUnits(principal.userId);
    if (units < room.record.startingStack) { /* refuse */ }
    await this.store.seatMember(roomId, principal.userId, seat);
    await room.table.sit({
      ...
      stack: room.record.startingStack,  // not member.stack
    });
```

`seatMember` only sets `seat` (`apps/api/src/repositories/rooms.ts:505-506`). `unseatMember` only clears `seat`. After a winning session the DB still holds 1,500; the live table starts the next orbit at 1,000. The header badge (`readUnits` = `sum(room_members.stack)`) and the felt disagree until the next `stacksSettled` **overwrites** the 1,500 with the 1,000-based result.

A short stack cannot re-sit (`400 < 1000` → `insufficient_units`) and must hit Reset — so the only people this path punishes are the ones who were up. “Stand up” is a visible control on `/play`.

In-hand conservation in `pots.ts` / soak tests is real. This is a second ledger the product also presents as units.

**Fix:** Sit with `member.stack` (or an explicit rebuy that writes both sides). Never invent `startingStack` for a returning occupant.

---

## P1-3 — Restart: bots are furniture; seven of twelve styles become `unknown`

**Severity:** P1 (required play + Legends identity)

Two independent defects share a restart.

**Bots do not play after `ensureOpen`.** The comment is explicit (`apps/api/src/rooms/registry.ts:615-620`): seats are re-taken, `BotRunner.add` is not. The turn clock then check/folds for every bot. Compose is one replica; every deploy or crash converts a bot table into a timeout-folding table. ADR 0001 already forbids a second API process; it does not excuse a first process that cannot resume the only opponents the product ships.

**The CHECK cannot store the roster.** `room_members.bot_profile` allows `nit | tight-aggressive | loose-aggressive | calling-station | maniac | unknown` (`db/migrations/0001_initial.sql`). `persistableProfile` maps seven of twelve Legends ids to `unknown` (`apps/api/src/rooms/bots.ts:191-196`). After restart the live record is rebuilt from that column. Even if the runner were reattached, those seats would not know which policy to load.

`LearnFromProfileResponse.observed` is permanently `null` for the same reason (contract comment at `packages/contracts/src/legends.ts:295-300`). The Observe step in `docs/AI-LEGENDS.md` §9 is not implemented.

**Fix:** Migrate `bot_profile` to the twelve ids (plus difficulty). Re-register bots on `ensureOpen` from that column, or refuse to reopen a bot room and say so.

---

## P1-4 — The page the browser loads has no CSP

**Severity:** P1 (security; claimed control is not on)

`docs/SECURITY.md` and `apps/api/src/plugins/security.ts` put a strict CSP on the API (`script-src` with no `unsafe-inline` / `unsafe-eval`). Learners do not live on the API. They live on Next.

- `apps/web/next.config.ts` sets no `headers()`.
- There is no `middleware.ts`.
- The compose proxy (`docker-compose.yml`) does not inject CSP.
- The root layout emits an inline theme-boot `<script>` (`apps/web/src/app/layout.tsx:111`).
- `THEME_BOOT_SCRIPT_CSP_HASH` is exported and hash-tested (`apps/web/src/lib/theme.ts:229`, `apps/web/test/theme-csp-hash.test.ts`) and **never placed on a response**. The test proves the constant matches the script. It does not prove a browser enforces it.

XSS on the page origin can drive same-origin `fetch` with the session cookie (`credentials: 'include'`). HttpOnly stops exfiltration; it does not stop acting as the user. The product’s own security review checklist treats CSP as a control.

Lifecycle scripts are off (`pnpm-workspace.yaml` `ignoreScripts: true`, Docker `--ignore-scripts`). That is not the same as “scripts enabled” in the page.

**Fix:** Emit CSP on every HTML response (hash or nonce for the boot script). Fail CI if the header is absent.

---

## P1-5 — `tournamentOrientation` is documented as ICM and implemented as a fold knob

**Severity:** P1 (wrong taught mechanism; AI integrity)

`docs/AI-LEGENDS.md` axis 12: the trait “weights survival and ladder position heavily.” Limitation L10: “`tournamentOrientation` weights survival using Malmuth–Harville.”

`packages/poker-ai/src/policy.ts:1101`:

```ts
const survival = 1 + FOLD_SURVIVAL_SPAN * traits.tournamentOrientation * commitmentShare;
```

`commitmentShare = toCall / (toCall + myStack)`. No `icmEquity`, no payouts, no ladder. A high trait just folds more as the call gets large. The Coach’s real ICM (`packages/poker-math/src/icm.ts`) is unused by the policy.

A learner who plays “High-Variance Tournament Aggressor” because the card and the limitation table talk about ICM is being taught a false model of both the bot and tournament maths.

**Fix:** Either call Malmuth–Harville (with its assumptions on the decision) or rewrite axis 12 and L10 to describe the knob that actually runs. Do not leave a limitation that invents a model.

---

## P1-6 — Legends hand-review is a bundled sample, always

**Severity:** P1 (required journey missing)

`loadHandComparison` (`apps/web/src/lib/legends-data.ts:310-312`) returns `HAND_COMPARISON_FIXTURE` and never fetches. There is no `API_PATHS` entry for a comparison builder. The page copy can say it is a sample; the route is still titled as the Compare step of the shipped loop (`docs/AI-LEGENDS.md` §9). After a real Legends hand (if P1-1 were fixed) there is still no product path that places the learner’s decisions next to the model’s.

**Fix:** Persist the policy summaries that `buildHandComparison` needs, put a path in `API_PATHS`, load it, or remove the route until that exists.

---

## What was checked and did **not** fail as P0

These are the places a ship-blocker was expected and not found in current source:

- **Hidden cards on the wire.** `redactFor` constructs `PlayerView`. `viewFor` passes `viewerPlayerId`. WS `broadcast` calls `viewFor` per socket. Fold-out `showdowns` is empty; Merkle reveal is positions that became public. Dedicated engine tests check fold-out reveals. No live leak reproduced.
- **In-hand chip conservation.** `assertPotsBalance` / `awardPots` totals; uncalled excess returned; settlement writes `stack += won`. Soak tests exist. The break is sit/stand accounting (P1-2), not the reducer.
- **Evaluator / pot-odds / EV identities.** 7-card packing, wheel, third-pair-as-kicker, full-house-from-two-trips look correct on inspection. `odds.ts` `oddsRatio: null` on a free check (not `Infinity`). Coach `ruleOfThumb.estimate` is a fraction; `CoachPanel` formats it once.
- **Lifecycle scripts.** `ignoreScripts: true`, empty `onlyBuiltDependencies`, Docker `--ignore-scripts`. Not enabled.
- **Impersonation default.** Fixtures are `namingMode: 'archetype'`. `resolveNamingMode()` defaults safe. Attributed names live in `profiles.ts` on the server only.

The generic `assertNoHiddenCards` scan still does **not** inspect `result.reveal.cards[].card` (object number fields, not arrays). Dedicated tests cover two shapes. That is residual false confidence, not a demonstrated leak.

---

## Residual notes (not scored as P1)

- L7 in `docs/AI-LEGENDS.md` still claims the impersonation guard misses “Name + mental-state verb”; §3 of the same file says those patterns were added. Stale limitation.
- `STORED_RUNS` ships empty `divergences` behind 0.15–0.25-wide tolerances (`stats.ts`). Honesty feature is weak by construction.
- `assertNoHiddenCards` + “every view is scanned” in `README.md` overstates the Merkle-leaf coverage.
- Compose API `NODE_ENV=development` is documented; it is not a production profile.

---

## Ship gate

Do not ship until P1-1 is closed (a learner can sit against the profile and difficulty they picked) and P1-2 is closed (re-sit does not invent or destroy units). P1-3 must be closed or explicitly accepted in the threat model as “any restart ends bot play.” P1-4 and P1-5 are honesty/security of a product that teaches probability and claims CSP + ICM.

# Reviewer B — Poker Engine (independent adversarial audit)

- **Auditor:** Reviewer B (did not author this tree)
- **HEAD:** `f20bbad2f082e9fe135ce98070da16eff7cc3f14` (`f20bbad Fix the wrong-reason fallbacks, and the last gate instability`)
- **Date:** 2026-08-19
- **Scope:** `@prl/poker-engine` plus the table/seating path that the engine cannot see (`LiveTable`, `RoomRegistry.seatBot`, WS disconnect/timeout)
- **Independence:** `docs/audit/*.md` and prior remediation claims were not used as evidence. Existing tests were treated as untrusted until their assertions were read and the expected numbers were rebuilt. Runtime evidence is from this session: official package tests, the 133,784,560 exhaustive enumerator, and throwaway fixtures under `/tmp/prl-audit-b/`.
- **No source was modified.**

---

## Executive summary

The engine is a real, pure NLHE reducer: CSPRNG Fisher–Yates with rejection sampling, Merkle-committed decks, increment-not-doubling raises, incomplete all-ins that do not reopen, dead-button rotation, short-blind price that stays a full BB, 3/1/1 board, all-in run-out, redaction that does not leak hole cards, and chip **totals** that balance. The official suite is not vacuous: 133 tests passed in 2.8s including a 4,000-hand invariant fuzz (3,385 showdown / 615 fold / 2,945 side-pot hands), 1,500 and 3,000-hand soaks, and a 2,598,960 five-card cross-check. The 133,784,560 seven-card enumerator **actually ran** (6.5s, 20.5M hands/s) and matched the published Wikipedia/Alspach frequencies.

**One required pot rule is wrong, and the in-tree tests lock the wrong answer in.**

`buildPotLayers` caps every contribution at the highest *live* commitment and **returns the excess to its contributor, including folders**. The comment in `pots.ts` claims that state “should not arise from legal play.” It does: heads-up or multiway, the small blind (and their ante) legally folds into a shorter all-in big blind. Independent fixtures, hand-calculated from Robert’s Rules / TDA “folded chips stay; uncalled bets return only to the player who made them,” produced:

| Setup | Standard stacks after SB fold | Engine stacks | Delta |
|---|---|---|---|
| HU 5/10, SB 100, BB 3 | SB 95, BB 8 | SB 97, BB 6 | SB refunded 2 |
| 3-max 5/10, BB 3; BTN+SB fold | SB 195, BB 8 | SB 197, BB 6 | SB refunded 2 |
| 3-max 5/10/ante-2, BB stack 3; BTN+SB fold | SB 193, BB 12 | SB 197, BB 8 | SB refunded 4 (ante+blind excess) |

Totals still conserve. The remaining player still “wins.” They win the **wrong amount**. Existing `short-blinds.test.ts` asserts `stacks(folded) === [997, 6]` for HU SB-1000 vs BB-3, which is this defect encoded as a passing test.

No P0 (conservation break, wrong winner identity, duplicate card, accepted illegal action, hidden cards in a public view) was reproduced. SeatBot/startHand races are serialised by `LiveTable.enqueue`; two bots cannot occupy one seat; a sit queued after `startHand` is not dealt; a newcomer waits for the big blind. Residual seating issues are P2 (bot `seatMember` has no sit-rollback; restarted bots sit mute until the clock folds them).

**Verdict:** engine is production-grade on betting/order/eval/RNG, **FAIL on folded dead-money vs a shorter live all-in** (P1). Do not treat “133 tests green” as proof of pot awards against a short remaining stack.

---

## Requirement table

| ID | Requirement | Status | Implementation | Test (untrusted until this audit) | Runtime evidence (this session) | Reviewer B | Finding / severity |
|---|---|---|---|---|---|---|---|
| ENG-001 | Button assignment & movement, dead button, busts | **PASS** | `packages/poker-engine/src/positions.ts` 172–265 (`seedBlindRotation`, `advanceBlindRotation`); `machine.ts` 154–194; `apps/api/src/rooms/table.ts` 1117–1161 | `test/blind-rotation.test.ts`; `apps/api/test/table-blinds.test.ts` | Independent seed: BTN 1 / SB 3 / BB 0. Bust to HU: BB advances to 3, other seat gets BTN+SB. Dead button on vacated SB chair. LiveTable join-between-blinds: BB sequence `0 → 1` (not a repeat). | Confirmed | — |
| ENG-002 | SB/BB posting; short all-in for less than the blind | **PASS** | `machine.ts` 256–340; `betting.ts` 75–78 | `test/short-blinds.test.ts` | 4-max, BB stack 3, 5/10: BB `allIn` for 3, `betLevel=10`, UTG to-call 10, min-raise 20. HU BB posts 3 `wasShort: true`. | Confirmed | Short **price** is correct. Short **award when the SB folds** is ENG-026/P1. |
| ENG-003 | Heads-up: button is SB, first preflop, last postflop | **PASS** | `positions.ts` 112–117, 275–311; `machine.ts` 384–399 | `test/betting.test.ts` HU case | BTN=0 SB=0 BB=1; `toAct=0` preflop; after limp-check, flop `toAct=1`; BTN acts last. | Confirmed | — |
| ENG-004 | Turn order every street and after raises | **PASS** | `machine.ts` 384–416, 515–517 | `test/betting.test.ts` | 4-max UTG=3 first; after limps BB option; raise returns action to prior callers (existing test read; not re-driven as a new script beyond limp/option). | Confirmed | — |
| ENG-005 | Legal action set (check vs call, bet vs raise) | **PASS** | `betting.ts` 179–252 | `test/betting.test.ts` | UTG facing BB: `fold,call,raise` (no check). Out-of-turn: `[]`. BB option: `fold,check,raise`. | Confirmed | — |
| ENG-006 | Min-raise by increment, not doubling | **PASS** | `betting.ts` 104–107; `machine.ts` 496–500 | `test/betting.test.ts` | Raise to 50 over 10 → increment 40, next min **90** not 100. 89 rejected, 90 accepted. Postflop bet 100 → min raise 200. | Confirmed | — |
| ENG-007 | Incomplete all-in does not reopen | **PASS** | `betting.ts` 91–94; `machine.ts` 477–500 | `test/betting.test.ts` | UTG raise 100 (inc 90); BTN call; SB shove 150; `betLevel=150`, `lastFullRaiseBetLevel=100`. BB (unacted) may raise; UTG may only call/fold; raise throws. | Confirmed | “50-into-100” covered as +50 over a 90 increment. |
| ENG-008 | All-ins, including for less than the current bet | **PASS** | `betting.ts` 212–223, 75–78; `machine.ts` 446–473 | `test/betting.test.ts`, `all-in-runout.test.ts` | 25-stack facing 60: call cost 5, `allInAtMax`; after call status `allIn`, `committedTotal=25`. | Confirmed | — |
| ENG-009 | Multiple side pots: amounts **and** eligible sets | **PASS** (award path tainted by P1 when a folder out-committed live) | `pots.ts` 76–145 | `test/pots.test.ts` | Independent 50/120/200/400 + folded 30: pots `230{0,1,2,3}`, `210{1,2,3}`, `160{2,3}`, `200{3}`. Full stacked 4-way hand stacks `[0,410,160,200]` matching hand-calc AA/KK/QQ/22. | Confirmed for live all-ins | Folder-excess return is ENG-026. |
| ENG-010 | Ties / split pots, including side-pot-only tie | **PASS** | `pots.ts` 265–318 | `test/pots.test.ts` | Main 200 to seat 0; side 125 chopped by 1&2 → **63 / 62** (odd chip left of button 0). | Confirmed | — |
| ENG-011 | Odd chips: deterministic, no create/destroy | **PASS** | `pots.ts` 180–191, 289–316 | `test/pots.test.ts` | Same 125 split: 63+62+200=325. `seatOrderFromButton` walks clockwise from `button+1`. | Confirmed | An auditor fixture with unequal commitments (4+3+3) was a bad pot construction, not an engine bug. |
| ENG-012 | Showdown ordering and winner determination | **PASS** (all remaining hands tabled) | `pots.ts` 229–251; `evaluate.ts` 141–243; `machine.ts` 585–657 | `test/evaluate.test.ts`, `test/pots.test.ts` | Stacked AhAd vs KhKd on a brick: seat 0 nets +50. 9 textbook 5-card categories match. 400 random 7-card hands match an independent naive best-five. 2.6M 5-card + 133M 7-card enumerators ran. | Confirmed | No last-aggressor/muck order — every live hand is evaluated. Acceptable for a server engine; not a wrong winner. |
| ENG-013 | Chip conservation at every intermediate state | **PASS** | `pots.ts` 165–174; `machine.ts` 623–627 | `test/invariants.test.ts` (4k fuzz) | Scripted 3-max multi-street hand: chips constant at 900 through complete. 4-way all-in 770=770. Short-BB fold 103=103 (wrong *distribution*, conserved total). Official fuzz: 0 conservation failures / 27,233 actions. | Confirmed | Conservation ≠ correct awards. |
| ENG-014 | Disconnect behaviour mid-hand | **PASS** | Engine: none (pure). `table.ts` 700–726, 906–932; `ws/router.ts` 201–220 | `apps/api/test/y3-turn-clock.test.ts` | WS close only `noteSocket(-1)` — does **not** fold. Seat remains; `timeoutAction` then `applyAction(..., {automatic:true})`. `stand()` flags `leaving` and auto-folds in turn. Independent stand mid-hand completed without crash. | Confirmed | Disconnect ≠ instant fold. Clock resolves. |
| ENG-015 | Hand cancellation and chip return | **PARTIAL** | **No** `cancelHand` in `packages/poker-engine/src`. Process death: `hands.ts` 371–409 `abandonInterruptedHands` (net 0 because durable stacks never moved). `LiveTable.close()` drops the `HandState`; `this.seats[].stack` is still the buy-in. | archive tests only | Independent `close()` mid-hand: `handId=null`, seats still 200/200. No in-engine cancel that returns committed chips into a `HandResult`. | Missing first-class cancel | **P2** — process-death is accounted for; a live misdeal cannot be cancelled through the reducer. |
| ENG-016 | No card dealt twice | **PASS** | `cards.ts` 191–213; `machine.ts` 289–321, 556–565; `rng.ts` shuffle | `test/invariants.test.ts` | Fresh 6-max deal: 12 hole cards unique. After run-out: 17 unique (12+5). Fuzz asserts uniqueness after every action. | Confirmed | No burns (see ENG-028). |
| ENG-017 | Rejected/illegal action leaves state byte-identical | **PASS** | `machine.ts` 433–443 (validate before any write); `betting.ts` 274–390 | `test/invariants.test.ts` illegal-action fuzz | 12 hostile actions (OOT fold/call/check, `bet` preflop, to=1 / 99999 / 20.5 / NaN / missing `to` / `explode` / seat 99): all threw; `JSON` snapshot + deck/salt object identity unchanged. | Confirmed | Input is never mutated; throw discards the new object. |
| ENG-018 | CSPRNG shuffle, unbiased rejection sampling | **PASS** | `rng.ts` 42–69, 79–93, 102–111 | `test/rng.test.ts` | Independent: wrap draw `2^32-1` discarded, next draw `8` → `8%3=2`, two draws consumed. Official chi-squared + 3! shuffle distribution tests passed in this run. | Confirmed | — |
| ENG-019 | `Math.random` absent from engine (not used for cards) | **PASS** | `rng.ts` (comment-only mention); `createSecureRandom` → `randomFillSync` | `test/rng.test.ts` | Independent comment-stripped scan of all 11 `src/*.ts`: zero `Math.random`. | Confirmed | — |
| ENG-020 | Existing engine suite: real numbers, non-vacuous | **PASS** | `packages/poker-engine/test/*.test.ts` | (the suite itself) | `pnpm --filter @prl/poker-engine test`: **133/133 pass**, 2.77s. Fuzz 4,000 hands / 27,233 actions with floors `showdown>200`, `fold>200`, `sidePots>100` (observed 3385 / 615 / 2945). 5-card exhaustive 2,598,960 vs reference evaluator. Soaks 1,500 and 3,000. Assertions are literals (pot 150/140/180, min-raise 38, stacks `[6,997]`, etc.), not `assert.ok(true)`. | Confirmed | Quality is high **except** the short-BB-fold award test, which is precise and **wrong**. |
| ENG-021 | Exhaustive 133,784,560 + soak claims | **PASS** | `test/exhaustive/seven-card-distribution.test.ts` 56–101 (7 nested loops, `assert.equal` per category) | excluded from default glob (`test/*.test.ts`); `test:exhaustive` runs it | **Ran this session:** `enumerated 133,784,560 hands in 6.5s (20498k hands/s)` — all nine published frequencies matched (Wikipedia / Alspach). Soaks above actually executed (log lines printed). | Confirmed | Frequencies independently checked against published C(52,7) tables; they sum to 133,784,560. |
| ENG-022 | State machine resists hostile / OOT / malformed | **PASS** | `betting.ts` 274–390; `machine.ts` 439–441 | `test/betting.test.ts`, invariants | See ENG-017. Also `validateAction` distinguishes `bet` vs `raise`, non-integer `to`, closed-street fold. | Confirmed | — |
| ENG-023 | Newcomer must post or wait for the big blind | **PASS** | `table.ts` 667–675, 736–750, 1117–1150 (`blindDebts` by user id; `advanceBlindRotation.awaitingBigBlind`) | `apps/api/test/table-blinds.test.ts`, `w3-awaiting-blind-wire.test.ts` | Sit after first deal → `owesBlind`; mid-hand sitter `viewerSeat=null` and `awaitingBigBlind` contains their seat; stand/resit **keeps** the debt; next `startHand` still excludes them. | Confirmed | Table policy is “wait,” not “post a dead BB.” Engine deals whoever the table passes in. |
| ENG-024 | Timeouts fold or resolve without destroying chips | **PASS** | `machine.ts` 665–669 `timeoutAction`; `table.ts` 934–951, 1058–1072 | `apps/api/test/y3-turn-clock.test.ts` | Independent: facing a bet → `{type:'fold'}`; free option → `{type:'check'}`. Apply automatic fold: 400 chips conserved, `wasAutomatic=true`. LiveTable + manual clock: timeout logged, chips 400. Never a silent call. | Confirmed | — |
| ENG-025 | Ante handling (dead money, not live bets) | **PASS** (fold-award interaction is P1) | `machine.ts` 242–278, 364 | `test/betting.test.ts` ante case | Ante 2, 3-max: `committedThisStreet` is 0/5/10 (antes **not** live); `committedTotal` +2 each; `betLevel=10` not 12; `potFromPreviousStreets=6`; `totalPot=21`. BB wins 21 when others fold **if** BB covered the BB. | Confirmed posting | Combined with short BB + fold, ante excess is refunded (P1). |
| ENG-026 | Uncalled bet returned | **FAIL** | `pots.ts` 63–94, 89–94, 619–621; `machine.ts` 619–621 | `test/pots.test.ts` (live unmatched only); `test/short-blinds.test.ts` 425–429 (encodes the bug) | Live unmatched raise-then-fold: HU raise-to-100, BB folds → stacks 510/490 (correct). **Folder out-committed live:** see P1. | **P1** | Uncalled return is applied to **folded** excess. That is not an uncalled bet. |
| ENG-027 | Button posts SB heads-up; blinds posted before cards | **PASS** | `machine.ts` 242–321 | `test/betting.test.ts` | Forced bets exist, holes dealt, `board=[]` at first decision. HU button posted 5 before any action. | Confirmed | — |
| ENG-028 | Streets deal 3 / 1 / 1 board cards | **PASS** | `machine.ts` 57 `BOARD_CARDS`, 544–582 | many | Independent limp-check: flop 3, turn 4, river 5. No burn cards (not required by 3/1/1). | Confirmed | Fairness is the commitment, not casino burns. |
| ENG-029 | All-in run-out with no remaining decisions | **PASS** | `betting.ts` 143–154; `machine.ts` 374–380, 538–582 | `test/all-in-runout.test.ts` + 1,500 soak | HU call that covers the last stack: `street=complete`, board 5, `toAct=null`, one action. Both blinds short (3 vs 4): `startHand` itself runs out. | Confirmed | — |
| ENG-030 | seatBot / seating-order race | **PASS** with residual P2 | `registry.ts` 771–794 `seatBot`; `table.ts` 470–477 queue, 619–683 `sit`; `rooms.ts` 582–618 `seatRequestedBots` | `apps/api/test/table-concurrency.test.ts`, `bots.test.ts` | See seating section. Same-seat: one `fulfilled`, one `rejected`, one occupant. Sit queued after `startHand`: not dealt. Sit queued before: dealt with holes. `BotRunner.add` after `sit` and before queued `startHand` **does** act (1 decision). Newcomer after deal: `viewerSeat=null`. API was not on :3001; LiveTable/BotRunner were driven in-process. | Confirmed serialisation | **P2:** `seatBot` does not roll back `store.seatMember` if `table.sit` throws (human `sitAtTable` does). Restart re-sits bots without `BotRunner.add` — they exist and the clock folds them (`registry.ts` 615–620). |

No ENG-031+ mandatory engine rule was added beyond the catalog. The folder-excess defect is filed under ENG-026 (and taints ENG-009/025 on that path).

---

## Detailed non-PASS records

### ENG-026 / P1 — Folded chips above the remaining live cap are refunded

**Rule (standard NLHE).** A fold forfeits every chip already committed. Uncalled chips return only to the player who **made** an unmatched bet or raise and is still in (or has just won because everyone else folded to their bet). Side pots exist so a live short stack cannot *win* more than they put in from other **live** players. Dead money from folders stays in the pot the remaining player(s) win, even if it exceeds the winner’s own commitment.

**What the code does.** `buildPotLayers` (`pots.ts` 80–94):

```80:94:packages/poker-engine/src/pots.ts
  const live = seats.filter((seat) => seat.status === 'active' || seat.status === 'allIn');
  // ...
  const contestableCap = live.reduce((highest, seat) => Math.max(highest, seat.committedTotal), 0);

  const returns: UncontestedReturn[] = [];
  for (const seat of contributors) {
    const excess = seat.committedTotal - contestableCap;
    if (excess > 0) returns.push({ seat: seat.seat, amount: excess });
  }
```

The file comment (lines 68–72) says a folder who out-committed every live seat “should not arise from legal play — a player cannot fold chips nobody matched.” That sentence is false. Legal sequence:

1. Post blinds. Short BB is all-in for less than the SB (or less than SB+ante).
2. Everyone else folds to the SB.
3. SB folds (legal: they face a full BB they do not wish to complete).

The SB’s committed total is then strictly larger than the only live player’s. The function refunds the difference.

**Independent fixtures** (`/tmp/prl-audit-b/audit-engine.mjs`, `audit-ante-fold.mjs`), expected values computed before calling the engine:

**Fixture A — HU 5/10, stacks [100, 3], button = SB.**  
Posted: SB 5, BB 3. SB folds.  
- Standard: pot 8 to BB. Stacks **95 / 8**. Nets −5 / +5.  
- Engine: pot 6 to BB, return 2 to SB. Stacks **97 / 6**. Nets −3 / +3.  
- Conservation: 103 = 103.

**Fixture B — 3-max 5/10, stacks [200, 200, 3].** BTN folds, SB folds.  
- Standard: SB 195, BB 8.  
- Engine: SB **197**, BB **6**.

**Fixture C — direct `buildPotLayers`.** Seats: folded 0, folded 5, all-in 3.  
- Standard: no returns, pot 8 eligible `{2}`.  
- Engine: `returns=[{seat:1,amount:2}]`, pot 6.

**Fixture D — 3-max 5/10/ante 2, BB stack 3.** Forced: antes 2/2/2, SB 5, BB 1 short. BTN folds, SB folds.  
- Standard: pot 2+2+2+5+1 = **12** to BB; SB stack **193**.  
- Engine: pot **8** to BB; SB stack **197** (4 returned). Nets `{0:−2, 1:−3, 2:+5}`.

**Why existing tests miss the correct rule.** They do not miss the *path*. `test/short-blinds.test.ts` 425–429:

```text
// Folding is legal too, and costs seat 0 only the 3 that seat 1 could match.
assert.deepEqual(stacks(folded), [997, 6]);
```

That is the defect, asserted. The 4,000-hand fuzz only checks `inStacks + committed === chipsAtStart` and “awards sum to pots,” which both hold. A one-line change that stopped refunding **folded** excess would **fail** `short-blinds.test.ts` and still be the correct poker fix.

**Severity:** P1 (required pot rule wrong; winner identity unchanged; totals conserved). Not P0: no chip created/destroyed, no hidden card, no illegal action accepted.

**Mutation existing tests would still miss:** returning folded excess only when `status==='folded'` vs always — already the case. A more interesting miss: awarding the excess to the live short stack (standard) would fail the locked-in `[997, 6]` test, so CI currently **protects the bug**.

---

### ENG-015 — PARTIAL: no reducer-level cancel

There is no `cancelHand` / `voidHand` in `packages/poker-engine/src` (full-text scan). A live hand can only move by `applyAction` or by the server dropping it.

What *does* exist, verified by reading (not by trusting prior audits):

- `LiveTable.close()` (`table.ts` 837–845): nulls the secret and the hand. Independent run: mid-hand close left seat stacks at the **buy-in** (200/200) because `this.seats[].stack` is not debited until `settleIfComplete`. Accidental chip return, no `HandResult`.
- `abandonInterruptedHands` (`apps/api/src/repositories/hands.ts` 371+): after process death the deck is gone, durable stacks never moved, history is closed with `netBySeat {}` and `abandoned: true`. That is honest accounting for a crash, not a misdeal button.

**Severity:** P2. Mandatory if the product promises a dealer-cancel; the engine cannot do it.

---

### ENG-030 — residual P2 (not a deal-order race)

Independent in-process races (`/tmp/prl-audit-b/audit-seating.mjs`, `audit-bot-race.mjs`):

| Probe | Result |
|---|---|
| Two `sit`s on seat 2 at once | One fulfilled, one rejected; one occupant |
| `startHand` queued, then `sit` | Late player seated, **not** in `dealt` roster, `viewerSeat=null` |
| `sit` queued, then `startHand` | Late player **is** dealt two hole cards |
| `registry.seatBot` shape (`sit` → `BotRunner.add`) vs already-queued `startHand` | Bot is in the hand and **does** produce a `PolicyDecision` (1 action, not automatic) |
| `add` before `startHand` | Bot acts; hand can complete |
| Bot `sit` after deal | `viewerSeat=null`, `awaitingBigBlind` includes the seat |
| Newcomer stand/resit | `owesBlind` survives; still waiting |
| Join between button and blinds | Next BB is the next live seat (`0 → 1`), not a double charge |

`LiveTable.enqueue` is a promise chain; `sit` / `startHand` bodies are synchronous, so the queue plus the fact that `seatBot` `await`s `sit` before `bots.add` puts the runner registration **before** a `startHand` that was queued after that sit.

**Residuals (P2):**

1. `RoomRegistry.sitAtTable` writes the DB seat first and **unseats** if `table.sit` throws. `seatRequestedBots` / legends (`rooms.ts` 599–615) call `store.seatMember` then `seatBot` with **no** matching rollback. A `seat_taken` / `already_seated` from the live table leaves a durable seat with no live occupant.
2. `ensureOpen` after restart (`registry.ts` 615–620) re-sits bots and **does not** call `BotRunner.add`. They are mute; the turn clock check/folds them. Documented, still a seating/liveness hazard.
3. Comment on `seatBot` says “Both, or neither.” `table.sit` then `bots.add` then `addMember` is not transactional.

API was not listening on 3001; these conclusions are from the same `LiveTable` / `BotRunner` / `seatBot` the process would use.

---

## Independent fixture results (hand-calculated)

All scripts live in `/tmp/prl-audit-b/` and import `packages/poker-engine/dist` (and API `dist` for seating). They do not import `packages/poker-engine/test/helpers.ts`.

### Betting / order

- HU 5/10: button posts 5, BB 10, cards already dealt, board empty, SB acts first; postflop BB first, button last.
- 6-max from button 0: SB=1, BB=2.
- Dead button on seat 2, occupied `{0,1,3}`, blinds SB=3 BB=0: first actor **1** (next occupied after BB). Seat 1 did not post a blind.
- Short BB 3: level 10, call 10, min-raise 20, BB `allIn`.
- Raise 50 over 10: increment 40, min next 90; 89 rejected.
- Incomplete shove 150 after raise 100: BB may raise; prior actor may not.

### Pots (referee arithmetic in the script comments)

- 50+120+200+400+folded 30 = 800 → layers 230 / 210 / 160 / 200 as above.
- Side-pot-only tie 125, button 0: 63 and 62.
- Stacked 4-way all-in, deal order left of button, no burns, holes `22 / AA / KK / QQ`, board `7s 8c 9d 3h Jc`: stacks `0 / 410 / 160 / 200`.

### Conservation / identity / timeout / streets / run-out

- 12 hostile actions: 12 rejects, snapshot identical.
- Timeout: fold facing a bet, check when free; automatic fold conserves.
- Ante is dead: street commitments 0/5/10, pot 21, level 10.
- Streets 3 then +1 then +1.
- Both-blind short (3 vs 4): `startHand` completes with 5 board cards.

### Evaluator

- 9 textbook 5-card hands → correct `HAND_CATEGORY`.
- 400 deterministic 7-card samples: engine category = independent combination-of-5 naive evaluator.
- Published frequency vector sums to 133,784,560 (checked before the enumerator ran).

### Official runtime (this session)

```
pnpm --filter @prl/poker-engine test
  133 pass, 0 fail, 2773 ms
  FUZZ 4000 hands, 27233 actions | showdown 3385, folded 615, side pots 2945
  SOAK 1500 shove-heavy | showdowns 1459, fold-outs 41
  SOAK 3000 short-blind-heavy | short posts 2002 across 1699 hands
  EXHAUSTIVE 2,598,960 five-card hands match the reference evaluator (2052 ms)

pnpm --filter @prl/poker-engine test:exhaustive
  enumerated 133,784,560 hands in 6.5s (20498k hands/s)
  2 pass, 0 fail
```

---

## P0–P3 list

### P0

None reproduced.

Checked specifically: conservation on every independent hand; winner of stacked AA vs KK; unique cards; 12 illegal actions rejected without mutation; `redactFor` spectator and hero views contain no opponent holes and no `deck` / `deckCursor` / `deckSalts` keys.

### P1

1. **Folded dead money above the live cap is refunded** (`pots.ts` `contestableCap` / `returns`). Legal SB (and ante) fold vs a shorter all-in BB. Wrong award, right total. In-tree test asserts the wrong stacks. **ENG-026 FAIL.**

### P2

2. **No `cancelHand` in the engine.** Crash-abandon and `close()` exist around it; a live misdeal cannot be settled through the reducer. **ENG-015 PARTIAL.**
3. **`seatBot` / `seatRequestedBots` lack the DB rollback `sitAtTable` has.** Durable seat can exist without a live occupant if `table.sit` throws. **ENG-030 residual.**
4. **Restarted bots are seated but not re-attached to `BotRunner`.** They time out rather than play. Documented in `registry.ts`; still a liveness defect.
5. **Showdown is “table everything still live.”** No last-aggressor order, no muck. Acceptable for an authoritative server; not casino showdown ritual.

### P3

6. **No burn cards.** ENG-028 only requires 3/1/1; commitment binds the order. Mentioned so nobody confuses this with a casino shoe.
7. **`timeoutAction` is not unit-tested inside `@prl/poker-engine`** (only used by `LiveTable` and mentioned in API tests). Behaviour was confirmed independently; a future one-line change to “always fold” or “silent call” would not fail the engine package’s own suite.
8. **Fuzz/soak do not referee pot awards against a reconstructed winner** — only conservation, eligibility of award seats, and “best score among those who have scores.” A `computeShowdowns` that skipped a seat could theoretically go unnoticed if conservation still held.

---

## Mutation-mindset (tests would miss)

If the repo cannot be edited, these are one-line bugs the current suite would not reliably catch:

1. **Already true:** `returns` include folded seats. The suite treats that as correct.
2. `computeShowdowns`: `if (seat.seat === 0) continue;` — seat 0’s hand never scored; `awardPots` skips missing scores and can pay another eligible seat. Fuzz checks conservation and “award ⊆ eligible,” not “eligible best hand vs the cards.”
3. `timeoutAction`: `return { type: 'fold' };` always. Engine package has no test; only API clock tests would notice if they assert the action type.
4. `seatRequestedBots`: already no rollback — a thrown `table.sit` after a successful `seatMember` is untested as a pair.

A one-line `Math.random()` in `src/` **would** fail `rng.test.ts`. A one-line doubling min-raise **would** fail `betting.test.ts`. A one-line “deal 4 flop cards” **would** fail stacked-deck and invariant board-size checks.

---

## Counts

| | |
|---|---|
| Catalog requirements re-verified | 30 (ENG-001 … ENG-030) |
| Extra catalog IDs added | 0 |
| **PASS** | 28 (ENG-009 and ENG-030 carry residual notes, still PASS) |
| **PARTIAL** | 1 (ENG-015) |
| **FAIL** | 1 (ENG-026) |
| P0 findings | 0 |
| P1 findings | 1 |
| P2 findings | 4 |
| P3 findings | 3 |
| Official engine tests this session | 133 pass / 0 fail |
| Exhaustive 7-card | 133,784,560 enumerated, frequencies matched |
| Independent script assertions | 75 recorded in `audit-engine.mjs` (70 pass / 5 fail: 3 are the P1 pot rule, 1 is ENG-015 absence, 1 was a bad odd-chip construction) |
| Independent seating probes | 12/12 pass |

---

## How to reproduce the P1

```bash
node /tmp/prl-audit-b/audit-engine.mjs   # look for ENG-026/015-folder-excess-vs-short-live
node /tmp/prl-audit-b/audit-ante-fold.mjs
```

Or, against dist, HU 5/10 stacks `[100, 3]`, button 0, SB folds: expect standard `95/8`, observe `97/6`.

# REVIEWER B — Poker engine, adversarial rules correctness

**Scope:** `packages/poker-engine` plus the room/hand orchestration in `apps/api/src/rooms/`.
**Date:** 2026-08-18. **Node:** v24.18.0.

## Method (read this before the table)

I did **not** rely on the repo's own test suite for any PASS. For every requirement I wrote my
own probe scripts from first principles in
`/private/tmp/.../scratchpad/agentB/`, imported the engine source directly
(`packages/poker-engine/src/index.ts`), drove it, and asserted against values I derived by hand
and wrote into the probe as literals with the arithmetic shown in comments.

**The probes were themselves mutation-tested.** I made two copies of the engine with deliberate
classic bugs injected and confirmed my probes fail loudly on them:

- `mutant/pots.ts` — odd chip dropped (`oddChips = 0`) and the internal balance guard removed.
  My soak caught it on hand 213 of 300: `CHIP LEAK — expected 885, have 884`.
- `mutant2/machine.ts` — `reopens = raisedBetLevel` (every raise reopens the action), and
  `mutant2/positions.ts` — heads-up button posts the big blind. My probes produced
  `183` differential mismatches and `HU hand: non-button posted the BIG blind (2) (expected 2, got 1)`.

So a green result below means the probe would have gone red on the corresponding real bug.

**Probe totals across the run:** 396 passing hand-derived assertions across the engine probes
(p1 48, p2 74, p3 41, p5 44, p9 90, p10 64, p11 15, p13 20), plus the table-level probes p6/p7/p8
which are where the ENG-001 and ENG-023 failures came from; a 50,000-hand randomised soak
(275,112 applied actions, 290,644 rejected illegal actions, invariants asserted after **every**
action); and a 20,000-hand differential against an independently written model of the
reopening rule (145,631 decision points compared).

---

## Summary table

| ID | Requirement | Status |
|----|-------------|--------|
| ENG-001 | Button assignment and movement between hands (incl. dead button / busts) | **PARTIAL** |
| ENG-002 | Blinds: small/big posting, short (all-in for less than the blind) | PASS |
| ENG-003 | Heads-up: button is SB, acts first preflop, last postflop | PASS |
| ENG-004 | Turn ordering on every street, and after raises/re-raises | PASS |
| ENG-005 | Legal action set at each decision point (check/call, bet/raise) | PASS |
| ENG-006 | Minimum raise sizing (increment, not doubling) | PASS |
| ENG-007 | Incomplete all-in raises do not reopen the betting | PASS |
| ENG-008 | All-ins generally, incl. all-in for less than the current bet | PASS |
| ENG-009 | Multiple side pots: amounts AND eligible-player sets | PASS |
| ENG-010 | Ties / split pots, including a tie in a side pot only | PASS |
| ENG-011 | Odd chips: deterministic, documented, no chip created/destroyed | PASS |
| ENG-012 | Showdown ordering and winner determination | **PARTIAL** |
| ENG-013 | Chip conservation at every intermediate state | PASS |
| ENG-014 | Disconnect behaviour mid-hand | PASS |
| ENG-015 | Hand cancellation and chip return | **PARTIAL** |
| ENG-016 | No card is ever dealt twice | PASS |
| ENG-017 | A rejected/illegal action leaves state byte-identical | PASS |
| ENG-018 | CSPRNG shuffle with unbiased rejection sampling | PASS |
| ENG-019 | `Math.random` genuinely absent from all source trees | PASS |
| ENG-020 | Existing engine suite: real numbers, non-vacuous assertions | PASS |
| ENG-021 | Claimed 133,784,560 exhaustive evaluation + 20,000-hand soak | **PARTIAL** |
| ENG-022 | State machine resists hostile/out-of-turn/malformed actions | PASS |
| ENG-023 | Newcomer must post or wait for the big blind | **FAIL** |

---

### ENG-001 Dealer/button assignment and movement between hands

- **Requirement (exact):** The button must be assigned at the first deal and must advance
  correctly between hands, including when players bust or leave. Under the standard (dead-button)
  rule the **big blind advances by exactly one live player every hand**; nobody skips it and
  nobody pays it twice in a row.
- **Status:** **PARTIAL**
- **Implementation location:** `apps/api/src/rooms/table.ts:894-901` (`nextButton`),
  `apps/api/src/rooms/table.ts:525` (button seeded on first `sit`),
  `apps/api/src/rooms/table.ts:593-608` (button chosen per deal),
  `packages/poker-engine/src/positions.ts:75-99` (`assignBlinds`).
- **Runtime evidence:**

  Stable roster, 4 seats, 8 hands (`p6-table-button-timeout.ts`) — **correct**:
  ```
  buttons: 1,2,3,0,1,2,3,0
  SB seats: 2,3,0,1,2,3,0,1
  BB seats: 3,0,1,2,3,0,1,2
  ```
  Every seat held the button exactly twice and paid the big blind exactly twice; the button
  never stayed on the same seat. A bust is also handled correctly — the button never lands on a
  chipless seat, a chipless seat posts no blind, and when the table drops to two the button
  correctly becomes the small blind:
  ```
  stacks after the all-in hand: 0=0 1=30 2=1980
  busted seats: 0
  next hand button=2 forced={"sb":2,"bb":1}      <- heads-up: button IS the SB. correct.
  ```

  **Roster churn is where it breaks** (`p7-blind-rotation-churn.ts`, 40 hands with a scripted
  join/leave schedule):
  ```
  ! hand 3:  seat 0 paid the BB twice in a row (occupied 0/1/2/3/4, btn 3)
  ! hand 7:  BB jumped 3 -> 0, skipping seat 4 (occupied 0/1/3/4, btn 3)
  ! hand 10: seat 3 paid the BB twice in a row (occupied 0/1/2/3/4, btn 1)
  ! hand 17: seat 0 paid the BB twice in a row
  ! hand 24: seat 2 paid the BB twice in a row
  ! hand 31: seat 4 paid the BB twice in a row
  ! hand 38: seat 1 paid the BB twice in a row
  big-blind repeats: 6   big-blind skips: 1
  ```
  Minimal reproduction of the skip (`p6` case C):
  ```
  hand 1: BTN 1, SB 2, BB 3          (seats 0,1,2,3)
  seat 3 stands
  hand 2: BTN 2, SB 0, BB 1          (seats 0,1,2)
  ```
  The big blind jumped from seat 3 to seat 1, skipping seat 0. Under the dead-button rule the
  new big blind must be seat 0 (next live player after seat 3), with a dead small blind.
  Minimal reproduction of the double big blind (`p7` case 1):
  ```
  hand 1: {"btn":1,"sb":3,"bb":0}    (seats 0,1,3 at a six-max table)
  a player joins seat 2 (between the SB and the BB)
  hand 2: {"btn":2,"sb":3,"bb":0}    <- seat 0 pays the big blind AGAIN
  ```
- **Root cause:** `nextButton` advances the *button* by one occupied seat and the blinds are then
  derived as button+1 / button+2 among whoever is occupied *now*
  (`positions.ts:assignBlinds`). There is no dead button, no dead small blind, and no
  missed-blind bookkeeping. The correct rule anchors the rotation to the **big blind**, not to
  the button.
- **Test covering it:** NONE. `packages/poker-engine/test/positions.test.ts` tests blind
  assignment for a fixed occupancy; `apps/api/test/rooms.test.ts` never varies the roster
  between hands and asserts nothing about blind rotation.
- **Test result:** existing tests pass but do not cover this; my probe: 3 failures.
- **Reviewer notes:** No chips are created or destroyed and no hand is corrupted — this is a
  fairness bug, not a conservation bug. The concrete cost is real though: a player who pays the
  big blind twice in a row pays `2 × BB` over two hands where the rules charge `BB + SB`. With
  a busy private table this fires often (6 times in 40 hands under my churn schedule).
- **Missing work:** Track the big blind seat, not the button, across hands. Derive the next big
  blind as the next live player clockwise from the previous one, then place the small blind and
  the button behind it, allowing a dead small blind and a dead button. Persist the anchor so it
  survives a restart (see ENG-015 note).

---

### ENG-002 Blinds — small/big posting, and posting short

- **Requirement (exact):** The small blind and big blind must be posted by the correct seats
  for the amounts configured; a player who cannot cover a blind posts what they have, is
  **all-in and still holding cards** (not folded), and their short post must **not** reduce the
  bet level for anyone else.
- **Status:** PASS
- **Implementation location:** `packages/poker-engine/src/machine.ts:184-212` (`post`),
  `packages/poker-engine/src/machine.ts:266-267` (`betLevel = max(bigBlind, postedThisStreet)`).
- **Runtime evidence:** `node p5-blinds-allins.ts` → `44 assertions passed, 0 FAILED`.
  Hand-derived cases, all of which held:
  - Normal 6-handed 5/10, button 0: `forcedBets = [{smallBlind, seat 1, 5}, {bigBlind, seat 2, 10}]`,
    stacks `[100,95,90,100,100,100]`, `betLevel = 10`.
  - Antes 2 with 5/10: `betLevel` stays 10 (an ante is dead money, not a live bet),
    `potFromPreviousStreets = 6`, `committedTotal = [2,7,12]`, `committedThisStreet = [0,5,10]`,
    and the button still owes exactly 10 to call.
  - Short big blind (stack 4, blinds 5/10): `wasShort: true`, status `allIn`,
    **`betLevel` stays 10**, `amountToCall` for the button is 10 (not 4, not 5),
    `minimumRaiseTo` is 20, and a "raise" to 15 is rejected. Resulting layers:
    `[{amount:12, eligible:[0,1,2], cap:4}, {amount:12, eligible:[0,1], cap:10}]`.
  - Short small blind (stack 3), ante larger than a stack (stack 1, ante 3) — both post what they
    have, both `allIn`, both still hold cards.
  - Both blinds all-in for less than the big blind (stacks 3 and 4 heads-up): the hand settles
    immediately, the full 5-card board is dealt, both hands are shown, and the layers are
    `[{6, [0,1], cap 3}, {1, [1], cap 4}]` — the one uncontestable chip goes straight back.
- **Test covering it:** `packages/poker-engine/test/short-blinds.test.ts` (700 lines, 12 tests +
  a 3,000-hand soak).
- **Test result:** 119/119 engine tests pass; the short-blind file's soak reports
  `3000 hands, 16156 actions | short posts 2002 across 1699 hands`.
- **Reviewer notes:** The `Math.max(config.bigBlind, postedThisStreet)` line is the single most
  important line in this area and it is right. I attacked it from three directions (short BB,
  short SB, both short) and it held.
- **Missing work:** none.

---

### ENG-003 Heads-up rules

- **Requirement (exact):** Heads-up, the **button posts the small blind**, acts **first**
  preflop and **last** on the flop, turn and river.
- **Status:** PASS
- **Implementation location:** `packages/poker-engine/src/positions.ts:85-90` (button is SB),
  `:105-113` (`firstToActPreflop` returns the button heads-up), `:119-125`
  (`firstToActPostflop` returns the next occupied seat, i.e. the big blind).
- **Runtime evidence:** `node p1-headsup-positions.ts` → `48 assertions passed, 0 FAILED`,
  including a full hand driven street by street:
  - `assignBlinds(0, 6, [0,1])` → `smallBlindSeat 0, bigBlindSeat 1, isHeadsUp true`
  - `firstToActPreflop(0,6,[0,1]) === 0`, `firstToActPostflop(0,6,[0,1]) === 1`
  - Real hand, blinds 1/2, stacks 200: button seat 0 posts **1**, seat 1 posts **2**,
    `toAct = 0` preflop. After the button limps, `toAct = 1` (the big blind's option is not
    skipped). After the BB checks, `street = flop` and **`toAct = 1`** — the big blind acts
    first postflop and the button acts last. Same on turn and river.
  - Wrap-around checked: button on the higher seat index (button = 1) and gapped seating
    (seats 0 and 3 at a six-max table, button 3 → BB is seat 0).
  - `positionLabels` gives `BTN/SB` and `BB`.
  - Three-seat table where one seat has 0 chips (`p11-misc.ts`): two dealt players ⇒ heads-up
    blinds apply between them, and the button posts the small blind. Correct.
  - Folding down to two players **mid-hand** does **not** flip the ordering to heads-up
    (verified in `p11`): the postflop order still derives from the real button seat.
- **Test covering it:** `packages/poker-engine/test/betting.test.ts` ("heads-up: the button posts
  the small blind, acts first preflop and last postflop"), plus heads-up cases in
  `short-blinds.test.ts` and `all-in-runout.test.ts`.
- **Test result:** pass. My mutant (`smallBlindSeat: other`) makes my probe fail immediately, so
  the probe is load-bearing.
- **Reviewer notes:** This is the rule the brief flags as most commonly botched. It is correct
  here, and correct for gapped seating and for a table that is heads-up because the third seat
  has no chips.
- **Missing work:** none.

---

### ENG-004 Turn ordering on every street and after raises/re-raises

- **Requirement (exact):** Action must proceed clockwise from the correct opener on each street;
  a raise must reopen the action to everyone who has not matched the new level, in clockwise
  order, ending with the last player who owes chips.
- **Status:** PASS
- **Implementation location:** `packages/poker-engine/src/machine.ts:307-336`
  (`firstActor`/`nextActor`), `packages/poker-engine/src/betting.ts:81-85` (`owesAction`).
- **Runtime evidence:** `node p10-golden-hand.ts` → `64 assertions passed, 0 FAILED`. This is a
  single five-handed hand played to the river with **every** intermediate figure derived by hand
  before it was run:
  ```
  preflop: order 3,4,0,1,2 ; s3 raises 30 (inc 20) ; s4 calls ; s0 folds ; s1 completes 30
           s2 re-raises 90 (inc 60, min was 50) -> reopened to s3 ; s3 calls ; s4 folds ; s1 calls
           pot swept = 300 ; commitments [0,90,90,90,30] ; stacks [1000,910,910,910,970]
  flop:    opener = seat 1 ; s1 checks ; s2 bets 100 (inc 100, min raise 200)
           s3 raises 250 (inc 150) -> reopened to s1 (who had only checked) ; s1 folds ; s2 calls
           pot = 800
  turn:    opener = seat 2 (seat 1 has folded) ; check, bet 300, call -> pot 1400
  river:   opener = seat 2 ; s2 shoves 360 ; s3 may only call/fold ; calls
  settle:  one merged pot of 2120 eligible [2,3] ; chips 5000 conserved ; nets sum to 0
  ```
  Also verified in `p1`: 6-handed preflop order `[3,4,5,0,1,2]`, postflop order `[1,2,3,4,5,0]`
  (button last), and that a re-raise from the button reopens to `[1,2,3,4]` in that exact order.
- **Test covering it:** `packages/poker-engine/test/betting.test.ts:*` ("a raise reopens the
  action so a player who already called must act again").
- **Test result:** pass.
- **Reviewer notes:** The ordering is derived from `owesAction` rather than from a queue, which
  is why it stays correct when seats fold out mid-street. I could not find an ordering error.
- **Missing work:** none.

---

### ENG-005 Legal action set at each decision point

- **Requirement (exact):** At each decision point the engine must offer exactly the legal
  actions — `check` only when nothing is owed, `call` only when something is owed, `bet` only
  when nobody has bet this street, `raise` otherwise — with correct min/max bounds, and must
  reject anything outside that set.
- **Status:** PASS
- **Implementation location:** `packages/poker-engine/src/betting.ts:179-252` (`legalActions`),
  `:274-391` (`validateAction`).
- **Runtime evidence:** `node p2-minraise-shortallin.ts` → `74 assertions passed, 0 FAILED`.
  - Facing the big blind: `['call','fold','raise']` — no `check`, no `bet`.
  - A seat that is not to act: `[]`.
  - Big blind's option: `['check','fold','raise']` — correctly a **raise**, not a bet, because
    there is money on the table.
  - Flop with no bet: `['bet','check','fold']`. Facing a flop bet: `['call','fold','raise']`,
    and `check` throws `cannot check facing a bet of 20; 20 to call`.
  - When every opponent is all-in, aggression disappears: only `['call','fold']`.
  - A completed hand offers `[]`; a folded seat offers `[]`.
- **Test covering it:** `packages/poker-engine/test/betting.test.ts` (legal-action bounds,
  out-of-turn, check-facing-bet, over-stack, non-integer).
- **Test result:** pass.
- **Reviewer notes:** `legalActions` is the single definition of legality and `validateAction`
  re-derives from it rather than duplicating the rules — so the client and server cannot drift.
  The bounds are honest: `costAtMin`, `maxTo` and `allInAtMax` all matched my hand computation.
- **Missing work:** none.

---

### ENG-006 Minimum raise sizing

- **Requirement (exact):** A raise must increase the bet by at least the size of the largest
  previous complete bet/raise increment on the street, and never by less than one big blind.
  Preflop the big blind counts as a complete bet of one big blind.
- **Status:** PASS
- **Implementation location:** `packages/poker-engine/src/betting.ts:104-107` (`minimumRaiseTo`),
  `packages/poker-engine/src/machine.ts:419-420` (increment recorded on a complete raise).
- **Runtime evidence:** hand-derived, blinds 5/10 (`p2`):
  ```
  preflop min raise-to = 20         ; raises to 19, 11 and 10 all rejected
  after a raise to 30  (inc 20)     ; next min = 50   (NOT 60, NOT 40) ; 49 rejected
  after a raise to 50  (inc 20)     ; next min = 70
  after a raise 30->100 (inc 70)    ; next min = 170
  postflop minimum opening bet = 10 ; 9 rejected ; "raise" rejected in favour of "bet"
  after a flop bet of 35 (inc 35)   ; min raise = 70 ; 69 rejected ; 70 accepted
  ```
- **Test covering it:** `packages/poker-engine/test/betting.test.ts` ("a raise sets the minimum
  for the next raise by increment, not by doubling").
- **Test result:** pass.
- **Reviewer notes:** The classic wrong answer here is doubling (min raise to 60 after a raise to
  30 over a 10 blind). The engine gets 50, which is right.
- **Missing work:** none.

---

### ENG-007 Incomplete all-in raises must not reopen the betting

- **Requirement (exact):** An all-in that is more than a call but less than a full raise must
  **not** reopen the betting to a player who has already acted at the current complete level.
  Players who have not yet acted, and players whose last action was at a level below the last
  complete raise, may still raise. A later complete raise reopens the action to everyone.
- **Status:** PASS
- **Implementation location:** `packages/poker-engine/src/betting.ts:91-94` (`mayRaise`),
  `packages/poker-engine/src/machine.ts:391` (`lastActedAtBetLevel` records the level **after**
  the action), `:400,419-420` (`reopens = isCompleteRaise && raisedBetLevel`).
- **Runtime evidence:** hand-derived scenario (blinds 5/10, button stack 140, others 1000):
  ```
  UTG raises to 100        -> lastFullRaiseBetLevel 100, increment 90
  button all-in for 140    -> betLevel 140, lastFullRaiseBetLevel STILL 100, increment STILL 90
  SB (unacted)             -> mayRaise TRUE,  minimum re-raise 140 + 90 = 230, legal set has "raise"
  BB (unacted)             -> mayRaise TRUE,  legal set has "raise"
  UTG (acted at level 100) -> mayRaise FALSE, legal set is EXACTLY ["call","fold"]
     raise attempt rejected: "you may not raise: the last increase was a short all-in,
                             so you may only call or fold"
  then SB makes it a full 230 -> UTG mayRaise TRUE again, minimum 230 + 90 = 320
  ```
  Also verified: an all-in for **exactly** the minimum (190) *is* complete and does reopen; a
  player who acted at a *lower* level than the last full raise keeps the right to raise; the
  raiser itself may never raise its own raise; and a covered player cannot make a sub-minimum
  raise (140 rejected when the minimum is 190) while a short stack may shove the same amount.

  **Differential test** (`p12-reopen-differential.ts`): I re-implemented the rule from the rules
  text using a different representation (per-player "has acted since the last complete
  aggression" flags, cleared by a complete raise) and compared verdicts at every decision point:
  ```
  $ node p12-reopen-differential.ts 20000
        compared 145631 decision points across 20000 randomised hands
  === p12 reopening-rule differential: 2 assertions passed, 0 FAILED ===
  ```
  Against the mutant with `reopens = raisedBetLevel` the same probe reports 183 mismatches in
  200 hands, so this differential is load-bearing.
- **Test covering it:** `packages/poker-engine/test/betting.test.ts` ("a short all-in raise does
  NOT reopen the action for a player who already acted", "a later COMPLETE raise reopens the
  action to everyone again"), `test/short-blinds.test.ts:*`.
- **Test result:** pass.
- **Reviewer notes:** This is the single hardest rule in the brief and the implementation is
  correct, including the sizing question (after an incomplete all-in to 140 over a full raise to
  100, the next legal raise is to 230 — the incomplete amount plus the last complete increment,
  which is the TDA answer). The two-field design (`lastFullRaiseBetLevel` + per-seat
  `lastActedAtBetLevel`) is genuinely elegant and I could not break it in 145k decision points.
- **Missing work:** none.

---

### ENG-008 All-ins generally, including all-in for less than the current bet

- **Requirement (exact):** A player may call all-in for less than the bet; the excess must come
  back to the bettor; the betting must close when nobody can wager further; a fully-paid-up
  player with no opponent able to act must not be offered a fold.
- **Status:** PASS
- **Implementation location:** `packages/poker-engine/src/betting.ts:143-154`
  (`isBettingClosedForHand`), `packages/poker-engine/src/pots.ts:76-145` (contestable cap).
- **Runtime evidence:** hand-derived (`p5`): blinds 5/10, button 200 / SB 200 / BB 60.
  Button raises to 100, SB folds, BB owes 50 with 50 behind and calls all-in for 60 total.
  ```
  short-call pots: [{"amount":125,"eligible":[0,2],"cap":60},{"amount":40,"eligible":[0],"cap":100}]
  ```
  125 = BB's 60 + button's matched 60 + the SB's dead 5; the button's uncalled 40 is returned via
  a single-eligible layer. `chips = 460` conserved, nets sum to 0.
  Also: facing a shove the legal set is exactly `['call','fold']`; a fully paid-up lone seat is
  offered **nothing at all**, not even a fold (`legalActions` returns `[]` and `validateAction`
  throws `you cannot fold here: nobody can bet again and you owe nothing, so the board runs out`).
- **Test covering it:** `packages/poker-engine/test/all-in-runout.test.ts` (597 lines, 9 tests +
  a 1,500-hand shove-heavy soak).
- **Test result:** pass.
- **Reviewer notes:** The "case 4" reasoning in `isBettingClosedForHand` — a lone seat that is
  still *short* of the bet level does get a decision — is subtle and correct; I probed it
  directly and it held.
- **Missing work:** none. (See P3-3: the returned excess is reported as a one-player *pot* rather
  than as a return, which is cosmetically misleading in a teaching product.)

---

### ENG-009 Multiple side pots

- **Requirement (exact):** With three or more distinct all-in amounts, each pot layer's **amount**
  and **eligible-player set** must be exactly right, folded contributors must be excluded from
  every eligible set while their chips stay in the pot, and the layers must sum to every chip
  committed.
- **Status:** PASS
- **Implementation location:** `packages/poker-engine/src/pots.ts:76-145` (`buildPotLayers`),
  `:165-174` (`assertPotsBalance`).
- **Runtime evidence:** `node p3-sidepots-ties-oddchips.ts` → `41 assertions passed, 0 FAILED`.

  **Four players, four different stacks, all all-in preflop** (5/10, button 0, stacks
  400/100/200/300). Layers I computed by hand before running:
  ```
  cap 100 : 4x100                 = 400  eligible {0,1,2,3}
  cap 200 : 100+0+100+100         = 300  eligible {0,2,3}
  cap 300 : 100+0+0+100           = 200  eligible {0,3}
  cap 400 : 100                   = 100  eligible {0}
  ```
  Engine output matched exactly:
  ```
  [{"amount":400,"eligible":[0,1,2,3],"cap":100},{"amount":300,"eligible":[0,2,3],"cap":200},
   {"amount":200,"eligible":[0,3],"cap":300},{"amount":100,"eligible":[0],"cap":400}]
  pots sum = 1000 = every chip at the table ; awards sum = 1000 ; chips conserved
  ```
  **Three all-in stacks plus a folder** (5 seats, stacks 500/50/150/300/500, seat 4 folds
  pre-blind): `[{200,[0,1,2,3],cap 50},{300,[0,2,3],cap 150},{300,[0,3],cap 300}]` — matched.

  **Dead money from a folded blind** (stacks 200/100/100/100, SB folds after posting 5):
  commitments `[100,5,100,100]`; the two layers (cap 5 and cap 100) share the eligible set
  `[0,2,3]` and are correctly merged into a single displayed pot of **305**, with the folder
  contributing but ineligible.
- **Test covering it:** `packages/poker-engine/test/pots.test.ts` (342 lines; "three different
  all-in amounts build a main pot and two side pots", "awarding never creates or destroys chips,
  over many random all-in shapes").
- **Test result:** pass.
- **Reviewer notes:** The layer-merge step (adjacent layers with identical eligibility collapse)
  is a display nicety that does not change who can win what. `contestableCap` makes the function
  total rather than throwing on a state where the biggest contributor folded — a good call.
- **Missing work:** none.

---

### ENG-010 Ties and split pots, including a tie in a side pot only

- **Requirement (exact):** A tied pot must be split among exactly the tied eligible players; a
  tie confined to a side pot must not affect the main pot.
- **Status:** PASS
- **Implementation location:** `packages/poker-engine/src/pots.ts:265-318` (`awardPots`).
- **Runtime evidence:** hand-derived scenario with a stacked deck (`p3`):
  ```
  3 handed, 5/10, button 0.  seat 0 (100) AcAd ; seat 1 (300) KcKd ; seat 2 (300) KhKs
  board 2c 7d 9h Ts 3s  (no straight, no flush)
  => seat 0 aces ; seats 1 and 2 both kings with T,9,7 -> tie
  pots   [{300,[0,1,2],cap 100},{400,[1,2],cap 300}]
  awards [{pot 0, seat 0, 300},{pot 1, seat 1, 200},{pot 1, seat 2, 200}]
  net    {0:+200, 1:-100, 2:-100}   (sums to 0) ; chips 700 conserved
  showdown descriptions: 0:pair of aces, ten kicker | 1:pair of kings, ten kicker | 2:pair of kings, ten kicker
  ```
  The short stack took the whole main pot and only the side pot split. Also verified an even
  three-way split (18/3 = 6 each).
- **Test covering it:** `packages/poker-engine/test/pots.test.ts` ("a split pot divides evenly
  and odd chips go left of the button", "a chopped pot in a real hand splits the chips").
- **Test result:** pass.
- **Reviewer notes:** none.
- **Missing work:** none.

---

### ENG-011 Odd chips on a split

- **Requirement (exact):** An indivisible pot must be split with the remainder distributed
  deterministically (never randomly), documented, and with no chip created or destroyed.
- **Status:** PASS
- **Implementation location:** `packages/poker-engine/src/pots.ts:289-309`,
  documented at `packages/poker-engine/src/pots.ts:22-27` and `docs/VERIFICATION.md:125`.
- **Runtime evidence:** hand-derived (`p3`): blinds 3/6, three-handed, button 0. Button calls 6,
  SB folds leaving 3 dead, BB checks. Board `As Ks Qd Jc Th` plays for both survivors.
  Pot = 15, two winners → 7 each, remainder 1. `seatOrderFromButton(0, 3, [0,2]) = [2,0]`, so the
  odd chip goes to seat 2 — the first winner to the left of the button.
  ```
  pots   [{"amount":15,"eligible":[0,2],"cap":6}]
  awards [{pot 0, seat 0, 7, odd 0},{pot 0, seat 2, 8, odd 1}]
  net    {0:+1, 1:-3, 2:+2}   ; chips 300 conserved
  ```
  With antes producing a 10-chip pot and three winners: `3 / 4 / 3`, exactly one odd chip, to
  seat 1 (first winner left of the button). My 50,000-hand soak asserts `awarded === potTotal`
  on every settled hand.
- **Test covering it:** `packages/poker-engine/test/pots.test.ts` ("odd chip assignment is
  deterministic and starts left of the button").
- **Test result:** pass. Injecting `oddChips = 0` into a mutant copy made my soak fail on hand
  213 of 300 with `CHIP LEAK — expected 885, have 884`, so this is a real check.
- **Reviewer notes:** The rule is documented in the engine source and in `docs/VERIFICATION.md`
  but is not surfaced anywhere a *player* would see it. Minor (P3-6).
- **Missing work:** none material.

---

### ENG-012 Showdown ordering and winner determination

- **Requirement (exact):** The best eligible hand must win each pot; when everyone folds to one
  player the hand ends without a showdown and without revealing cards; the showdown order must
  be correct.
- **Status:** **PARTIAL** — winner determination is correct; showdown *order* and mucking are
  not modelled.
- **Implementation location:** `packages/poker-engine/src/pots.ts:229-251` (`computeShowdowns`),
  `packages/poker-engine/src/machine.ts:506-578` (`settle`).
- **Runtime evidence:**
  - Winner determination: verified in `p3`, `p10` and across 29,973 showdowns in the 50,000-hand
    soak, which asserts that no folded seat is ever eligible for any pot and that awards equal
    the pot total on every hand.
  - Everyone folds to one player (`p3`): `street complete`, `endedByFold true`,
    `showdowns.length 0`, **`reveal.cards.length 0`** (no card is proved at all),
    `awards [{pot 0, seat 2, 15}]`, `net {0:0, 1:-5, 2:+5}`, board length 0.
  - Folding out on the flop (`p10`): only the three board cards already dealt are proved; the
    turn and river are **not** dealt.
  - **Gap 1 — no mucking.** Every seat still holding cards at showdown is evaluated and its hole
    cards are proved and published, including hands that lost:
    ```
    showdown reveals: 0:AcAd | 1:2c3d | 2:4c5d | winner(s): 0
    ```
    In real poker a beaten player may muck without showing. Here seats 1 and 2 are exposed.
  - **Gap 2 — ordering.** `HandResult.showdowns` is emitted in **seat index order**
    (`[0,1,2]`), not in poker showdown order (last aggressor first, then clockwise). Nothing in
    the code or the docs states which order it is.
- **Test covering it:** `packages/poker-engine/test/hidden-information.test.ts` ("cards are only
  revealed at showdown, and only for seats that showed"), `test/pots.test.ts`.
- **Test result:** pass — but no test asserts anything about showdown *order*, and no test
  asserts that a loser may decline to show, because the engine has no such concept.
- **Reviewer notes:** Winner determination is solid; I have no doubt about it. The two gaps are
  real deviations from table rules but neither can move a chip. For a teaching lab, always
  showing may even be intentional — but it is nowhere stated as a deliberate choice, and it does
  publish information a real table would not.
- **Missing work:** Either implement muck-on-loss or state explicitly (in `docs/` and in the UI)
  that this lab always tables every live hand. Document the ordering of `HandResult.showdowns`,
  or emit it in showdown order.

---

### ENG-013 Chip conservation at every intermediate state

- **Requirement (exact):** The total number of chips in play must be invariant across an entire
  hand, at **every** intermediate state, not merely at the end.
- **Status:** PASS
- **Implementation location:** whole engine; the guards are
  `packages/poker-engine/src/pots.ts:165-174` and `:312-317`.
- **Runtime evidence:** my own soak, asserting after **every single action**:
  ```
  $ node p4-soak-invariants.ts 50000
  hands=50000  actions=275112  illegal-attempts=290644
  showdowns=29973  ended-by-fold=20027  state-mutations-on-rejection=0
  === p4 randomised soak / chip conservation / no partial mutation: 4 assertions passed, 0 FAILED ===
  ```
  Re-run at 20,000 hands with the same result (110,643 actions), so it is not seed-dependent.
  Per-action assertions: total chips unchanged; no negative or fractional stack or commitment;
  `committedThisStreet <= committedTotal`; `status` consistent with `stack`; `betLevel` at least
  the max street commitment; `toAct` always an active dealt seat; no duplicate card in play;
  every card in play drawn from the consumed deck prefix; deck still a 52-permutation; pot
  layers balance. On settlement additionally: final stacks equal the starting total,
  `netBySeat` sums to zero, awards equal pot total, pots never exceed commitments, no folded
  seat is eligible for any pot, and the reveal contains exactly `board + 2 × showdowns` cards.
  Stack sizes were randomised including many below the blinds; blinds, antes, seat counts (2–6)
  and button positions were all randomised.
- **Test covering it:** `packages/poker-engine/test/invariants.test.ts:174` ("FUZZ: 4000 random
  hands satisfy every invariant after every action").
- **Test result:** 119/119 engine tests pass.
- **Reviewer notes:** I deliberately made my soak stricter than the repo's (it also checks card
  provenance against the deck cursor and pot-layer balance at intermediate states). Nothing
  leaked in 275k actions. This is the strongest single result in this audit.
- **Missing work:** none.

---

### ENG-014 Disconnect behaviour mid-hand

- **Requirement (exact):** A player who disconnects mid-hand must not lose their hand
  instantly and must never have chips spent on their behalf. There must be a bounded mechanism
  that stops the table waiting forever.
- **Status:** PASS
- **Implementation location:** `apps/api/src/ws/router.ts:192-211` (`handleClose`),
  `apps/api/src/rooms/table.ts:773-791` (`applyTimeout`), `:834-848` (`armTimer`),
  `packages/poker-engine/src/machine.ts:585-589` (`timeoutAction`).
- **Runtime evidence:**
  - Code path: `handleClose` only decrements a socket count
    (`this.registry.noteSocket(roomId, connection.principal.userId, -1)`), drops the connection
    from the room set, and broadcasts. It does **not** stand the player up and does **not** fold
    their hand. Asserted mechanically in `p6`.
  - Timer behaviour, driven with the injected manual clock (`p6`):
    ```
    a turn deadline is armed as soon as a hand starts
    clock.advance(31_000)  ->  timeout fired exactly once, for the seat that was to act
    timeout produced: [{"kind":"action","seat":1,"description":"folds","wasAutomatic":true}]
    the timed-out seat's stack is UNCHANGED (a fold spends nothing)
    ```
  - Facing no bet, the automatic action is a **check**, not a fold:
    ```
    BB option timeout produced: [{"kind":"action","seat":0,"description":"checks","wasAutomatic":true}]
    ```
  - The server never calls on a player's behalf: asserted directly
    (`!actionEvents.some(e => e.description.startsWith('calls'))`).
  - `TurnExpiry` carries `handId` and `seat` and is re-checked before applying, so a late timer
    cannot fold someone who is now thinking on a different hand.
- **Test covering it:** `apps/api/test/rooms.test.ts`, `apps/api/test/ws-socket.test.ts`.
- **Test result:** `node --test test/rooms.test.ts test/table-concurrency.test.ts test/bots.test.ts
  test/seat-reuse-identity.test.ts` → `tests 41, pass 41, fail 0`.
- **Reviewer notes:** Correct and conservative. Note the practical consequence: a disconnected
  player keeps their seat and burns the full `actionTimeoutSeconds` on every turn until the hand
  ends. That is the right trade-off, but there is no "sit out on disconnect" so the table stalls
  for the full timeout each turn. Worth a product decision, not a defect.
- **Missing work:** none required.

---

### ENG-015 Hand cancellation and chip return

- **Requirement (exact):** State the conditions under which a hand is cancelled and verify chips
  are correctly returned.
- **Status:** **PARTIAL** — there is no cancellation mechanism at all; interruption is handled
  by never having debited anything, which works but is undocumented and loses the button.
- **Implementation location:** `apps/api/src/rooms/table.ts:675-684` (`close`),
  `:814-832` (`settleIfComplete`), `apps/api/src/rooms/registry.ts:375-396`
  (`stacksSettled` only fires when `notice.handCompleted`).
- **Runtime evidence:**
  - `p6`: `LiveTable` exposes no cancel/abort/refund entry point at all —
    ```
    LiveTable methods: enqueue, viewFor, snapshot, seatOf, isSeatFree, seatCount, handId,
    handInProgress, subscribe, archivedDeal, archivedResult, sit, stand, startHand,
    submitAction, close, apply, runAutomaticActions, applyTimeout, afterMutation,
    settleIfComplete, armTimer, publish, assertOpen, removeSeats, nextButton, lookupMemo,
    recordMemo, publicFactFor, wireEvents
    ```
    `close()` discards the in-flight hand outright (`table.handId === null` afterwards).
  - Chips: `this.seats[].stack` is only written back in `settleIfComplete`, and the database
    write (`archive.stacksSettled`) only runs when `notice.handCompleted` is true. So an
    interrupted hand never debits anybody: the room's persisted stacks still hold the pre-hand
    values and the whole hand is effectively void. I verified the in-memory half:
    mid-hand `snapshot()` reports `[1000,1000,1000]` (behind + committed), i.e. nothing has been
    taken away yet.
  - Every player standing up mid-hand (`p11`): the hand ends by folding, `netBySeat` sums to
    exactly 0, and the leavers are removed only after settlement.
- **Test covering it:** NONE for cancellation specifically.
- **Test result:** not executed (no such test exists).
- **Reviewer notes:** The "void the hand" behaviour is a defensible design, and it is safe
  because the deck secret is deliberately never persisted. But it is only *implicitly* correct —
  it works because nothing is written until the end, not because anything returns chips. Two
  concrete consequences worth stating in the docs:
  1. A hand interrupted by a restart is silently voided; players will see chips they had already
     committed reappear, and the hand will not be in their history.
  2. `LiveTable` restores `initialHandNumber` from the database on reopen but **not**
     `buttonSeat` (`apps/api/src/rooms/registry.ts:474-482`). `prl.hands.button_seat` is
     persisted per hand and could be read back, but is not — so after any API restart the button
     resets to "the first player who sits, plus one" and the blind rotation phase is lost.
- **Missing work:** Restore the button (and, once ENG-001 is fixed, the big-blind anchor) from
  the last archived hand on room reopen. Document the void-on-interruption behaviour.

---

### ENG-016 No card is ever dealt twice

- **Requirement (exact):** Within a hand, no card may appear in two places, and every card in
  play must have come off the committed deck.
- **Status:** PASS
- **Implementation location:** `packages/poker-engine/src/machine.ts:219-247` (hole card deal),
  `:476-493` (board deal), `packages/poker-engine/src/cards.ts:206-213`
  (`assertDistinctCards`).
- **Runtime evidence:**
  - 50,000-hand soak, checked after **every action**: board + all dealt hole cards distinct;
    every one of them present in `deck.slice(0, deckCursor)`; `deck` still a 52-permutation.
    Zero violations across 275,112 actions.
  - `p11`: 2,000 fully played six-handed hands →
    `across 2000 fully played six-handed hands, no card was ever dealt twice`.
  - `p9`: 20,000 real-CSPRNG shuffles, each asserted to be a 52-element permutation.
  - `startHand` rejects a `fixedDeck` that is too short, contains a duplicate, or contains an
    out-of-range card (all three verified in `p9`).
- **Test covering it:** `packages/poker-engine/test/invariants.test.ts`,
  `test/hidden-information.test.ts`.
- **Test result:** pass.
- **Reviewer notes:** none.
- **Missing work:** none.

---

### ENG-017 A rejected action leaves the state byte-identical

- **Requirement (exact):** An illegal or rejected action must not partially mutate the hand
  state.
- **Status:** PASS
- **Implementation location:** `packages/poker-engine/src/machine.ts:353-441` — validation runs
  before any new object is built, and the reducer is pure (spread-only, never mutating its
  input).
- **Runtime evidence:** in the 50,000-hand soak I took a `structuredClone` of the whole
  `HandState` (including the 1,664-byte salt array) before each hostile attempt and compared with
  `util.isDeepStrictEqual` afterwards:
  ```
  illegal-attempts=290644   state-mutations-on-rejection=0
  ```
  Attempts included: `to` values of `-5`, `-1`, `0`, `0.5`, `1.5`, `NaN`, `Infinity`,
  `MAX_SAFE_INTEGER`, `2**53`, `1e300`, `'100'` (string), `null`, missing `to`, unknown action
  types (`sneeze`, `__proto__`, `''`); acting out of turn; a folded seat acting; and betting
  exactly one chip more than the stack. Every one threw, and none changed a byte.
- **Test covering it:** `packages/poker-engine/test/invariants.test.ts:302` ("FUZZ: an illegal
  action is always rejected, never silently applied").
- **Test result:** pass.
- **Reviewer notes:** One nuance worth recording: a stray `to` on a `call` is **ignored**, not
  honoured — `applyAction(state, 0, {type:'call', to:999})` succeeds and commits exactly the
  10 owed. That is the safe behaviour.
- **Missing work:** none.

---

### ENG-018 CSPRNG shuffle with unbiased sampling

- **Requirement (exact):** Cards must be dealt from a CSPRNG, and index selection must be
  unbiased (correct rejection sampling, no off-by-one), with a correct Fisher–Yates shuffle.
- **Status:** PASS
- **Implementation location:** `packages/poker-engine/src/rng.ts:42-69` (`createSecureRandom`,
  `node:crypto.randomFillSync`), `:79-93` (`unbiasedInt`), `:102-111` (`shuffleInPlace`).
- **Maths, checked by hand:** `limit = floor(2^32 / n) * n`; a draw is accepted iff
  `draw < limit` (**strict**) and mapped by `draw % n`. The accepted set is `{0 … limit-1}`,
  exactly `floor(2^32/n)` complete residue cycles, so every residue is equally likely.
  A `<=` here would be the off-by-one — it would admit one extra draw and give residue 0 a
  `1/2^32` edge. For `n = 52`: `floor(4294967296/52) = 82595524`, `limit = 4294967248`,
  rejection region `48 = 2^32 mod 52`.
- **Runtime evidence:** `node p9-rng-and-hostile.ts` → `90 assertions passed, 0 FAILED`.
  For each of `n ∈ {2,3,5,7,51,52,1000,65537}` I fed a synthetic source and asserted the exact
  boundary: `limit-1` is **accepted** and maps to `(limit-1) mod n`; `limit` is **rejected** and
  the next draw is used (verified by draining the queue); `2^32-1` is rejected. Bound 0,
  negative and fractional bounds throw; bound 1 short-circuits to 0; a source stuck in the
  rejection region fails loudly rather than dealing biased cards. Statistics on the **real**
  CSPRNG:
  ```
  nextInt(52) over 520000 draws: chi-squared = 48.46  (51 df, 99.9th pct ~ 96.0)
  20000 shuffles: chi-squared(position of card 0) = 48.16, chi-squared(card in seat 0) = 49.58
  3-item shuffle chi-squared = 5.93 (5 df, 99.9th pct ~ 20.5)
    213=20215 123=19867 231=19941 321=19816 312=20127 132=20034
  ```
  All six orderings of three items appear at near-exactly `N/6` — this is the check that catches
  the classic `nextInt(n)` instead of `nextInt(i+1)` Fisher–Yates bug.
  The deterministic generator refuses to run in production
  (`createDeterministicRandomForTests must never be used in production`) and every hand records
  `randomSourceKind` (`csprng` / `deterministic-test-only` / `fixed-deck-scenario`), verified.
- **Test covering it:** `packages/poker-engine/test/rng.test.ts` (9 tests).
- **Test result:** pass.
- **Reviewer notes:** No off-by-one. The rejection bound and the Fisher–Yates direction are both
  right.
- **Missing work:** none.

---

### ENG-019 `Math.random` absent from all source trees

- **Requirement (exact):** `Math.random` must not appear in any first-party source tree.
- **Status:** PASS
- **Runtime evidence:** I wrote my own comment- and string-aware scanner rather than trusting
  the repo's:
  ```
  scanned 301 files (excluding node_modules/.next/dist)
  Math.random in CODE (comments stripped): [
    'packages/poker-ai/test/no-math-random.test.ts',
    'packages/poker-engine/test/rng.test.ts',
    'apps/api/test/server-randomness.test.ts',
    'scripts/supply-chain/repo-hygiene.mjs' ]
  ```
  All four are the detectors themselves (the literal `'Math.random'` appears as the needle). Every
  other hit in the repo is prose in a comment. `scripts/load-test.mjs` uses a seeded mulberry32,
  not `Math.random`, and says why.
- **Test covering it:** `packages/poker-engine/test/rng.test.ts:48`,
  `apps/api/test/server-randomness.test.ts`, `scripts/supply-chain/repo-hygiene.mjs:174-239`.
- **Test result:** pass; the repo's own detector also self-tests that it fires on real code and
  not on prose.
- **Reviewer notes:** none.
- **Missing work:** none.

---

### ENG-020 Existing engine suite: real numbers, non-vacuous assertions

- **Requirement (exact):** Run the existing suite, record real numbers, and judge whether its
  assertions are strong or vacuous.
- **Status:** PASS
- **Runtime evidence:**
  ```
  $ cd packages/poker-engine && node --test 'test/*.test.ts'
  ℹ tests 119   ℹ pass 119   ℹ fail 0   ℹ skipped 0   ℹ todo 0   ℹ duration_ms 3212.9

  $ cd apps/api && node --test test/rooms.test.ts test/table-concurrency.test.ts \
       test/bots.test.ts test/seat-reuse-identity.test.ts
  ℹ tests 41    ℹ pass 41    ℹ fail 0   ℹ skipped 0   ℹ todo 0   ℹ duration_ms 3669.5
  ```
  Embedded soak output from the run:
  ```
  3000 hands, 16156 actions | short posts 2002 across 1699 hands, decided by the blinds alone 201
  ```
- **Assertion-quality judgement:** strong, not vacuous. Evidence:
  - Zero `.skip` / `todo` in the engine, poker-ai and api test trees.
  - The tests assert against *external* ground truth in several places rather than against the
    implementation: published 7-card frequencies, a separate reference evaluator
    (`test/reference-evaluator.ts`) compared over all 2,598,960 five-card hands, and brute force
    over all C(7,5) subsets.
  - Named tests exist for every hard rule I attacked independently: "a short all-in raise does
    NOT reopen the action for a player who already acted"; "a later COMPLETE raise reopens the
    action to everyone again"; "a raise sets the minimum for the next raise by increment, not by
    doubling"; "heads-up: the button posts the small blind, acts first preflop and last
    postflop"; "the lone chipped seat may be all-in for LESS than an opponent, and still gets its
    decision"; "a fully committed seat with no opponent able to act is offered nothing at all —
    not even a fold".
  - Three randomised soaks (4,000 + 1,500 + 3,000 hands) that assert conservation after each
    action, not just at the end.
  - `apps/api/test/workspace-test-reachability.test.ts` asserts every test file is reachable
    from a documented root command, which closes the "test exists but never runs" hole.
- **Reviewer notes:** This is the strongest test suite I have audited on this project. My
  independent probes found nothing the suite had missed *inside the engine* — every engine
  finding below is in the orchestration layer, which the suite covers much more thinly.
- **Missing work:** none for the engine. `apps/api/src/rooms/table.ts` needs blind-rotation tests
  (see ENG-001, ENG-023).

---

### ENG-021 Claimed exhaustive evaluation and 20,000-hand soak

- **Requirement (exact):** The repo claims an exhaustive 133,784,560 seven-card evaluation and a
  20,000-hand randomised engine soak. Verify both.
- **Status:** **PARTIAL** — the exhaustive claim is true and verified; the 20,000-hand engine
  soak claim is overstated.
- **Runtime evidence — exhaustive (I ran the real thing, not a scaled-down version):**
  ```
  $ cd packages/poker-engine && node --test --test-timeout=1800000 'test/exhaustive/**/*.test.ts'
        enumerated 133,784,560 hands in 7.6s (17619k hands/s)
  ✔ the expected frequencies sum to C(52,7) (0.39ms)
  ✔ EXHAUSTIVE: all 133,784,560 seven-card hands classify to the published frequencies (7604.26ms)
  ℹ tests 2  ℹ pass 2  ℹ fail 0
  EXIT=0
  ```
  I independently checked the nine expected constants in
  `test/exhaustive/seven-card-distribution.test.ts:37-47` against the published 7-card
  frequencies — high card 23,294,460; pair 58,627,800; two pair 31,433,400; trips 6,461,620;
  straight 6,180,020; flush 4,047,644; full house 3,473,184; quads 224,848; straight flush
  41,584 — summing to 133,784,560. They are correct, and they are genuinely external ground
  truth. I also spot-checked the evaluator's *ordering* by hand (`p13-evaluator-spot.ts`,
  20 assertions, 0 failures): the full nine-category ladder is strictly increasing, the wheel is
  the weakest straight, `K A 2 3 4` is **not** a straight, an ace does not play both ways,
  kickers decide, suits are irrelevant, the royal is found inside seven cards, and the steel
  wheel is a straight flush.
- **Runtime evidence — the soak claim:** `docs/REPORT.md:117` states "**The engine** is checked
  by a randomised soak of 20,000 hands / 167,987 decision points". The engine's own randomised
  soaks total **8,500** hands: `test/invariants.test.ts:175` (`HANDS = 4000`),
  `test/all-in-runout.test.ts:481` (`1500`), `test/short-blinds.test.ts:594` (`3000`). The only
  literal `20_000` in the workspace is `packages/poker-ai/test/stats.test.ts:817`, which is a
  **seed-collision** check, not a hand soak. The poker-ai simulation suite does play thousands of
  hands per profile with chip-conservation checks, so the number is plausible as a cross-package
  sum — but it is attributed to "the engine" and is not traceable to any named engine test.
- **Test covering it:** as above.
- **Test result:** exhaustive 2/2 pass.
- **Reviewer notes:** The substance is fine — my own soak ran 50,000 hands / 275,112 decisions
  with stricter per-action invariants than the repo's. The problem is only that a headline claim
  in `docs/REPORT.md` does not match any artefact in the tree, which is exactly the kind of
  number a reader would check first.
- **Missing work:** Correct `docs/REPORT.md:117` to the real figure, or add a named engine soak
  that actually runs 20,000 hands.

---

### ENG-022 State machine resists hostile input

- **Requirement (exact):** Deliberate attempts to break the state machine — acting out of turn,
  acting after folding, betting more than the stack, negative/NaN/fractional amounts, huge
  integers, acting on a finished hand, hand-forged state — must all be rejected cleanly.
- **Status:** PASS
- **Implementation location:** `packages/poker-engine/src/betting.ts:274-391`,
  `packages/poker-engine/src/machine.ts:84-122` (config/seat validation),
  `apps/api/src/rooms/table.ts:632-673` (server-side turn + sequence checks).
- **Runtime evidence:** `node p9-rng-and-hostile.ts` → `90 assertions passed, 0 FAILED`.
  - 21 malformed `startHand` inputs all rejected: duplicate seat numbers, seat outside
    `0..maxSeats-1`, negative seat, negative / fractional / `NaN` / `Infinity` stack, empty
    `playerId`, fewer than two players with chips, `smallBlind = 0`, negative `bigBlind`,
    fractional or `NaN` blind, `bigBlind < smallBlind`, negative ante, `maxSeats` 1 or 7, button
    on an empty seat, and three malformed `fixedDeck` shapes. A 0-chip seat is legal and is dealt
    out (`status sittingOut`, `holeCards null`).
  - Hostile actions: out of turn, from a non-existent seat, `MAX_SAFE_INTEGER`, `1e308`,
    negative, fractional and `NaN` raise amounts all throw. Acting on a completed hand throws and
    `legalActions` returns `[]`. A folded seat cannot act and is offered `[]`. A hand-forged
    state with `toAct` pointing at a folded seat is still refused by `validateAction`.
  - At the server layer (`apps/api/test/table-concurrency.test.ts`, 41/41 pass): two simultaneous
    submissions — exactly one applies, the other is rejected as stale; a replayed `actionId` is
    deduplicated rather than reapplied; a burst is serialised by the per-table queue.
  - 290,644 hostile attempts inside the soak, none accepted, none mutating.
- **Test covering it:** `packages/poker-engine/test/betting.test.ts`,
  `packages/poker-engine/test/invariants.test.ts:302`,
  `apps/api/test/table-concurrency.test.ts`.
- **Test result:** pass.
- **Reviewer notes:** I could not construct a state that broke the machine.
- **Missing work:** none.

---

### ENG-023 A newcomer must post or wait for the big blind

- **Requirement (exact):** A player who sits down between hands must either wait for the big
  blind or post a dead blind before being dealt in. Otherwise they can take free hands in late
  position and stand up before the blind reaches them.
- **Status:** **FAIL**
- **Implementation location:** `apps/api/src/rooms/table.ts:490-533` (`sit` — no blind
  bookkeeping at all), `:586-606` (`startHand` deals in every seat with chips that is not
  leaving). There is no `missedBlinds`, `postedBigBlind` or `waitingForBigBlind` field anywhere
  in the repo.
- **Runtime evidence:** brute force over 15 (seating, newcomer-seat) combinations at a six-max
  table (`p8-blind-dodging.ts`):
  ```
  tried 15 (seating, newcomer) combinations
  ! base 0/2/4   + newcomer at 3: dealt in, posted 0 (button 3)
  ! base 1/3/5   + newcomer at 4: dealt in, posted 0 (button 4)
  ! base 0/2/3/5 + newcomer at 1: dealt in, posted 0 (button 3)
  ! base 0/1/3/4 + newcomer at 2: dealt in, posted 0 (button 2)
  free hands granted to a newcomer: 4/15
  ```
  In two of those four the newcomer was dealt in **on the button** — the best seat at the table —
  having posted nothing at all.
- **Test covering it:** NONE.
- **Test result:** not executed (no such test exists).
- **Reviewer notes:** On its own this is a fairness gap. Combined with ENG-001 it becomes an
  exploit: a player can stand up as the blinds approach and sit back down after they pass,
  because nothing tracks that they owe a blind. Play money makes the damage small, but this is a
  *private multiplayer* product where the point is that the game is fair.
- **Missing work:** Track per-seat blind obligations. On `sit`, mark the seat as owing the big
  blind; deal it in only once the big blind reaches it, or accept a posted dead blind. Preserve
  the obligation across a stand/sit within the same room.

---

## Counts

| Status | Count |
|--------|-------|
| PASS | 18 |
| FAIL | 1 |
| PARTIAL | 4 |
| UNVERIFIED | 0 |
| N/A | 0 |

---

## Issues by severity

### P0 — security / correctness / release catastrophe
**None found.** I attacked the core rules engine hard and it held: chip conservation, side pots,
the incomplete-all-in reopening rule, heads-up ordering, minimum raise sizing, the shuffle and
the evaluator are all correct under independently derived fixtures.

### P1 — required feature broken or missing
1. **No dead-button rule: the big blind does not advance by exactly one live player when the
   roster changes.** (ENG-001) `apps/api/src/rooms/table.ts:894-901`. Measured: **6 players paid
   the big blind twice in a row and 1 player skipped it entirely, over 40 hands with churn**. A
   player paying two consecutive big blinds is over-charged by half a big blind relative to the
   rules. Reproduction: seats 0/1/3 six-max, hand 1 `BTN 1 / SB 3 / BB 0`; a player joins seat 2;
   hand 2 `BTN 2 / SB 3 / BB 0` — seat 0 pays again. Fix: anchor the rotation to the big blind,
   allow a dead small blind and a dead button.
2. **A newcomer is dealt in without posting anything.** (ENG-023) `apps/api/src/rooms/table.ts:490-533`.
   4 of 15 seating combinations gave a newcomer a completely free hand, twice **on the button**.
   No blind obligation is tracked anywhere, so standing up and sitting back down dodges the
   blinds entirely. Fix: implement wait-for-the-big-blind or a dead-blind post, and persist the
   obligation across a stand/sit.

### P2 — significant quality gap
1. **The button position is not restored when a room reopens after a restart.** (ENG-015)
   `apps/api/src/rooms/registry.ts:474-482` restores `initialHandNumber` from the database but
   not the button, even though `prl.hands.button_seat` is persisted. After any API restart the
   button resets to "first player to sit, plus one" and the blind rotation phase is lost.
2. **`docs/REPORT.md:117` overstates the engine soak** as "20,000 hands / 167,987 decision
   points". The engine's randomised soaks total 8,500 hands (4,000 + 1,500 + 3,000). The only
   `20_000` in the tree is a seed-collision check in `packages/poker-ai/test/stats.test.ts:817`.
   The underlying quality is fine; the number is not traceable. (ENG-021)
3. **No test covers blind rotation across roster changes.** (ENG-001, ENG-023) Both P1 findings
   are in `apps/api/src/rooms/table.ts`, which has 41 passing tests, none of which varies the
   roster between hands. This is the one real coverage hole I found.

### P3 — polish
1. **No mucking: every live hand is revealed at showdown**, including losers'
   (`packages/poker-engine/src/pots.ts:229-251`). Defensible for a teaching lab but nowhere
   stated as a deliberate choice. (ENG-012)
2. **`HandResult.showdowns` is emitted in seat order**, not poker showdown order, and the
   ordering is undocumented. (ENG-012)
3. **An uncalled bet is reported as a one-player "pot" and an "award"** rather than as a return
   (`packages/poker-engine/src/pots.ts:76-145`; observed:
   `[{125,[0,2],cap 60},{40,[0],cap 100}]`). Chips are conserved, but in a product whose whole
   purpose is teaching pot mechanics, "seat 0 wins 40 from pot 1" is the wrong description of
   getting your own uncalled bet back.
4. **A disconnected player burns the full `actionTimeoutSeconds` on every turn**; there is no
   sit-out-on-disconnect. Correct, but the table stalls. (ENG-014)
5. **`SeatState.isAllInThisHand` is written but never read** in any production code path, and its
   doc comment (`packages/poker-engine/src/types.ts:71`: "True once the seat has voluntarily put
   chips in on this street") describes something else entirely — it is set when the stack reaches
   zero.
6. **The odd-chip rule is documented only in engine source and `docs/VERIFICATION.md:125`**, not
   anywhere a player can see it. (ENG-011)
7. **Void-on-interruption is undocumented.** A hand interrupted by a restart silently disappears
   and its chips reappear; this works by construction but is not written down. (ENG-015)

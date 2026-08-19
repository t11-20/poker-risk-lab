# Journey verification — runtime, in a real browser

**Agent:** Journey Verifier
**Date:** 2026-08-19
**Method:** Chrome automation against a live stack I started myself. API on `:3911`, web on `:3910`,
own database `prl_journey` (created, migrated, seeded, `db:verify` green). Two independent browser
sessions with separate cookie jars (`localhost:3910` and `127.0.0.1:3910` — different origins, so
different cookie jars; confirmed two distinct `usr_*` rows in the database, not two tabs on one
session). Nothing in the repository was edited; the only configuration used is a scratch env file
outside the tree.

Everything below is what appeared on screen, quoted. Where a claim is about the server it is
corroborated against `prl_journey` or the API log.

---

## Verdicts

| # | Journey | Verdict |
| --- | --- | --- |
| 1 | Guest → Learn → lesson → quiz → progress | **PARTIALLY COMPLETES** |
| 2 | Guest → Guided Practice → hand to showdown vs bots | **COMPLETES** |
| 3 | Poker table → Coach analysis at a real decision | **COMPLETES** |
| 4 | Scenario Lab → scenario → decision → maths | **COMPLETES** |
| 5 | Private room → two independent sessions → hand to completion | **COMPLETES** |
| 6 | Disconnect → reconnect mid-hand | **COMPLETES** |
| 7 | Completed hand → Hand Review + deck-commitment verification | **PARTIALLY COMPLETES** |
| 8 | Tournament / ICM learning flow | **COMPLETES** |
| 9 | Progress reset | **PARTIALLY COMPLETES** |
| — | API-down path | **PARTIALLY COMPLETES** |
| — | No impossible probability | **PASS** |
| — | No dark patterns | **PASS** |
| — | Console errors | **PASS with one warning-level defect** |

---

## 1. Guest → Learn → a lesson → a quiz → progress — PARTIALLY COMPLETES

Signed-in path works end to end. The *guest-first* path — the one the product's own copy promises —
silently records nothing while telling the learner it recorded.

**What worked.** `/learn` lists 17 lessons. `/learn/pot-odds` renders in full with live figures.
The quiz is embedded at the foot of the lesson; the answer control is honest about stakes:
"Skipping is fine, and costs nothing. Come back to it or do not." Marking a lesson read is an
explicit act: "your record only counts the lessons you say you have finished. It is counted, never
scored: there is no percentage complete and nowhere for one to be stored."

With a session (created by opening a table), the loop closes: answering
`counting-outs-q1` and pressing "I have finished" produced

> Recorded. This lesson is now one of the lessons finished on your record. … The server stamped it
> 19/08/2026, 09:55:37.

and `/record` then showed `LESSONS FINISHED 1`, `QUIZ QUESTIONS ANSWERED 1`. Confirmed in the
database (`prl.lesson_progress`, `prl.quiz_attempts` each gained exactly one row for
`usr_cpok6aaljce6wykutbzydcbb4c`).

**What failed.** As a genuine first-time guest (no session), I answered the break-even-equity
question on `/learn/pot-odds`. The panel said:

> That matches the answer this lesson gives. … This is the server's own comparison, made against a
> figure it computed when you answered — **and the one it recorded as a question you have
> answered.**

Nothing was recorded. `GET /api/v1/me/progress` answered `401 not_authenticated`, and
`prl.quiz_attempts` contained only the four dev-seed rows afterwards. See **P1-A**.

The same page's lesson-read control gets this right in the same session — "Nothing was recorded,
because there is no session to attach it to" — which is what makes the quiz wording a defect rather
than a design choice.

---

## 2. Guest → Guided Practice → complete a hand vs bots — COMPLETES

`/play` → "Open the table" created a guest session in one request (`POST /api/v1/auth/guest` → 201)
and a six-handed room with five bots. Took seat 1, dealt, and played a hand to showdown acting at
every street.

Final board `10s 10c 7c 4h 3c`; I held `7d 6d` in the big blind and finished with 2,058 units.
"How the hand ended: seat 0 wins 2058 from pot 0 / seat 4 wins 7 from pot 1" — side pots settled
correctly, and the accompanying line is exactly right for an educational product:

> The result of one hand says almost nothing about the decision that produced it. The analysis
> beside this table is where the useful feedback is.

Chips conserved: 1,114 + 1,037 + 985 + 7 + 2,058 + 799 = 6,000 across six 1,000-unit stacks.
`prl.hand_seats.net_result` for that hand sums to 0.

Action buttons carry their own price — "Fold 0 UNITS", "Call 10 UNITS", "Raise to 20 / 20 UNITS" —
which is the product's stated design and it holds.

**But see P2-A:** two earlier hands ended without me because the 60-second turn clock expired while
I was reading the Coach panel. `prl.hand_actions` records `seat 0 | fold | was_automatic = t`.

---

## 3. Poker table → Coach — COMPLETES

Requested and read the Coach panel at several real decisions (preflop, flop, river) on a live table.
Every required element is present.

| Required | Seen on screen |
| --- | --- |
| clean vs dirty outs | `OUTS — 15 CARDS IN TOTAL` · `Clean 14 cards` · `Dirty 1 card`, plus a card-by-card disclosure |
| equity labelled exact or sampled | `≈ monte carlo` with "2,000 trials sampled."; `= exact` with "455,400 boards enumerated." |
| 95% interval when sampled | `14.6 % ± 1.54 POINTS`; "The equity figure is sampled, ±1.54 points at 95% confidence." |
| pot odds | `PRICE OFFERED 1.5 to 1`, `POT AND PRICE 15 units in the middle, 10 units to call` |
| break-even equity | `BREAK-EVEN EQUITY 40.0 %` with "The share of the pot a call has to win, on average, just to break even." |
| EV per action with arithmetic | `WHAT EACH ACTION IS WORTH (5 LINES)` — e.g. "EV(call) = equity x (pot + toCall) - toCall = 0.76 x (104 + 45) - 45 = 68.24" |
| suggestion + size range | `ONE READING OF THIS SPOT` · `Raise — 55 units to 55 units` |
| confidence | `LOW CONFIDENCE` / `MODERATE CONFIDENCE` / `REASONABLE CONFIDENCE` |
| reason | "fold has the highest expected value against the stated range, by 4.4 chips over the next-best action." |
| what would change it | Four bullets under "What would change this:" including the sampling interval and the size of the gap |
| assumptions | `WHAT THESE NUMBERS ASSUME` — always expanded, listing the exact range strings and combination counts |

**The two hard constraints hold.**

*Nothing claims an action is correct, optimal or best.* Scanning the full panel text for
`correct|optimal|best|guaranteed`, the only matches are the comparative "the next-best action"
(describing the runner-up row of the EV table) and the panel's own disclaimer:

> A suggestion that follows from the assumptions listed below — not a claim about the best play.
> Poker has no single correct action in a spot like this, and different assumptions about the
> opponent give different answers.

*No percentage outside 0–100%.* Across every Coach panel read, percentages ranged 0.0–95.0.

Preflop, the outs section refuses rather than inventing: "No outs breakdown for this spot. Outs are
counted when there are cards still to come…".

Two content problems in the panel are recorded as **P2-B** (the outs count degenerates when hero is
already far ahead) and **P3-A** (the panel says "chips" where the whole product says "units").

---

## 4. Scenario Lab → a scenario → make a decision → see the maths — COMPLETES

`/lab` lists 36 scenarios. Opened `eq-rule-of-four-big-draw-flop` ("Where The Rule Of Four Drifts" —
the scenario the previous audit found rendering "160.0%").

Before the decision the page states its assumptions, and says why:

> They are here before the decision rather than after it because deciding without knowing the range
> assumption is not a fair question — and because a figure whose assumptions you have not read is a
> figure you cannot disagree with.

Pressed **Call** (170 units into a 230 pot). The maths appeared:

- `= consistent with the analysis` — "This is the server's own verdict on your action"
- `YOUR ACTION IS WORTH +55.1 units`
- `BEST ROW ON THE TABLE +55.1 units — Call to 170`
- `CALLED CONSISTENT WITHIN 10 units`
- "This is a comparison, not a mark … There is no score."

Recorded server-side: `prl.scenario_attempts` gained one row
(`eq-rule-of-four-big-draw-flop`, `{"type":"call"}`).

**The 160.0% is gone.** All 16 percentages on the rendered page after the decision were within
0–95%. I additionally swept all six offline-fixture scenario pages (the surface where the bad figure
lived) and found no value above 100%.

---

## 5. Private room → two independent sessions → complete a hand — COMPLETES

This is the one the audit called out, so the independence is spelled out.

- **Session 1**: tab on `http://localhost:3910`, guest `usr_cpok6aaljce6wykutbzydcbb4c`
  ("Guest 0CC9CB"), 2,058 units.
- **Session 2**: separate tab on `http://127.0.0.1:3910`. Different origin, therefore a different
  cookie jar (`.env.example` and the RUNBOOK both note the session cookie is host-scoped). On first
  load `GET /api/v1/auth/session` returned `user: null` and the header read `1,000 UNITS` — a fresh
  visitor, not a shared session. It became guest `usr_hsami7kvo46zfymj7dqrqgjuam` ("Guest 5EA04F").

Session 1 pressed "Start a private table to invite somebody to" and was shown, once:

> INVITE CODE — SHOWN ONCE · `RU36-E4JU-NDJ6-QRKA`
> Anybody with this code can join this table. Only a hash of it is kept, so it cannot be shown again…

Session 2 typed that code into "Join a private table with an invite code" and got
"Joined Private table. Take a seat to be dealt in." Room header: "Private table — invite-only,
4 at the table."

Database confirms two distinct **human** members plus two bots in
`room_4uwh4i6yguy4j63jo27gftucp3`:

```
seat 0  usr_cpok6aaljce6wykutbzydcbb4c  is_bot=f   Guest 0CC9CB
seat 1  usr_jr4x2tscy2rlpql6dvknwjssih  is_bot=t   Patient Technician
seat 2  usr_vuenjf2rribekagsude7wpeom7  is_bot=t   Calling Station
seat 3  usr_hsami7kvo46zfymj7dqrqgjuam  is_bot=f   Guest 5EA04F
```

Session 1 dealt; both sessions acted alternately through preflop, flop, turn and river and the hand
reached showdown. `prl.hands` shows `hand_6baf3sthlygsf5ipjsbilsi6nh … street = complete`, and
`prl.hand_seats` nets to zero (255, −85, −85, −85).

**Redaction held throughout.** Session 2's screen showed "Guest 0CC9CB" with face-down cards for the
whole hand.

---

## 6. Disconnect → reconnect mid-hand — COMPLETES

Wrapped `window.WebSocket` to capture the live socket, dealt Hand 2 at the private table, recorded
the state, then closed the socket mid-hand (`close(4999, 'audit-simulated-drop')`).

The client reconnected on its own — a second socket reached `readyState 1` within three seconds —
and the page stayed on "Live. Everything on this screen is the server's own view of the table,
redacted for you." with "A hand is in progress." The web dev log carries the client's own note:
`[table-socket] socket closed 4999 audit-simulated-drop`.

State restored exactly: same hand ("Hand 2"), same stack (1,250), same room and seat.

**Nothing leaked.** Inspecting the resync `state` frame on the new socket:

```
seat 0  isSelf=true   holeCards: 2 cards
seat 1  isSelf=false  holeCards: null
seat 2  isSelf=false  holeCards: null
seat 3  isSelf=false  holeCards: null
```

and in the DOM only my own cards (`Qh Jh`) were rendered; every other seat's "HOLE CARDS" region was
empty. The frame types received were `pong`, `welcome`, `state`, `event` — no card data outside my
own seat.

---

## 7. A completed hand → Hand Review — PARTIALLY COMPLETES

`/review` lists the hands correctly: 5 rows, board, pot, "NET TO YOU" with `GAINED`/`LOST`/`LEVEL`.

**Where it renders, it is excellent — including the browser-side deck proof.** On
`/review/hand_lav3cfwl4fe6k4cryl67zvaa7a`:

> DEAL VERIFICATION — **Check the deal yourself** — ✓ proof holds
> MERKLE ROOT `d873b1e44df279a04e4ffaa8a7ae8b7e6ca6eb441087fdd1c100780f6ddd582d`
> BOUND TO `room_6om4j2g7uvsjknbnwjwczje5ox:2:hand_lav3cfwl4fe6k4cryl67zvaa7a`
> **PROVED IN YOUR BROWSER** 3 of 52 deck positions
> **THE SERVER SAID** verified, 3 positions
>
> Your browser recomputed each leaf hash from the card, its salt and its deck position, walked the
> six sibling hashes up the tree, and arrived at the root above — 3 times. … The other 49 positions
> stay sealed, which is the point: they are the cards nobody was entitled to see.

The two claims are shown side by side rather than merged, which is the whole value of the scheme,
and `apps/web/src/components/CommitmentVerifier.tsx` is a `'use client'` component running the
engine's own `verifyDeckReveal`. This part of the product does what it says.

**But the richest hands are unreachable.** Clicking the +255 showdown hand in my own history landed
on

> **404 — Page not found.** There is nothing at this address. It may have moved, or the link may
> have been mistyped — here is everything the app can actually show you.

The hand exists. See **P1-B** for the mechanism and measurements.

---

## 8. Tournament / ICM learning flow — COMPLETES

`/learn/tournament-chips-and-icm` renders in full (~12 KB of text, 4 sections, 5 quiz questions),
with the non-gambling framing stated inside the lesson rather than only in the chrome:

> WATCH OUT — Nothing of value is awarded here. The tournaments in this lab award no money, no
> prizes and nothing transferable. A payout schedule appears only as arithmetic to reason about…

Two tournament scenarios back it: `rk-nine-big-blinds-call-or-fold` and
`rk-when-survival-outweighs-chip-ev`. I completed the second. It produced
`YOUR ACTION IS WORTH +4,092.8 units` and, crucially, disclosed its own limit:

> …this app computes chip expected value rather than the value of a finishing position. So read the
> number as one input and not as the answer.

That is the honest thing to say, and it is said in the right place.

---

## 9. Progress reset — PARTIALLY COMPLETES

`/record` carries the promised control, always available and unconditional:

> Units are free practice counters with no value of any kind… Resetting them puts your balance back
> to the starting amount and puts every seat you currently hold back to its table's starting stack.
> It costs nothing, it is not recorded as anything, and you may do it as often as you like.
>
> It does not erase anything. The hands you have played stay in your history…

Pressing "Reset my units to the starting amount" issued `POST /api/v1/me/units/reset` → 200 and the
button became `Recorded`… with:

> Done. Your units are back to 2000. Nothing else changed: the hands you have played, and every
> figure on this page derived from them, are exactly as they were.

The reset itself is real: `UNITS, NET, ALL TIME` stayed at 1,308, and after a reload the header read
`2,000 UNITS` (I held two live seats; units are the sum of live seat stacks, each reset to its room's
1,000 starting stack).

**Two problems on that screen.** The header badge still read `3,308 UNITS` while the note said
"back to 2000" — see **P2-C**. And the copy promises "the starting amount", which the whole app
elsewhere states is 1,000; a learner reading "back to 2000" has no way to reconcile the two, because
nothing on the page explains that units are per-seat sums — see **P3-B**.

---

## The API-down path — PARTIALLY COMPLETES

I stopped the API mid-session and walked the app.

**Screens that say so plainly, and label bundled data as bundled — good:**

| Screen | What it said |
| --- | --- |
| `/learn` | "▲ WATCH OUT — **This index is not live.** The content service is not reachable, so this index is listing the bundled copy of the curriculum. The lessons and their prerequisites are real; the read/unread marks are not yours." |
| `/learn/<lesson>` | "▲ WATCH OUT — **This lesson is the bundled copy.** … Every figure in it is still computed here, from the maths package, exactly as it would be with the API up." |
| `/lab` | "FIXTURE DATA — The scenario API is not reachable, so this list comes from the typed fixture… no server was involved in this page." (6 fixture scenarios, all of which open) |
| `/lab/<fixture scenario>` | "FIXTURE DATA — …rendered from src/fixtures/scenarios.ts." |
| `/legends` | "▲ WATCH OUT — **These profiles are bundled sample data** … treat nothing here as a live figure." |
| `/review` | "FIXTURE DATA — The hands API is not reachable, so this list comes from src/fixtures/review.ts." |
| `/record` | "▲ WATCH OUT — **Your record could not be fetched.** … **Nothing is shown rather than zeroes: a zero here would be a claim about your record, and this page does not have one to make.**" |
| `/play` | "▲ WATCH OUT — **The table could not be prepared.** GET /api/v1/auth/session failed with status 500 (internal_error)" plus a "Try again" button |

`/record`'s behaviour is the standard the rest should be held to.

**Screens that do not:**

- The **units badge in the header** keeps showing `1,000 UNITS` on every page, with no qualification,
  while the API is down. See **P1-C**. It sits on `/record` directly above the notice saying the
  record could not be fetched.
- The **home page** shows no notice at all and carries the same unqualified units badge.
- A **Scenario Lab detail page for one of the 30 non-fixture scenarios** renders a bare 404 —
  "There is nothing at this address" — rather than an outage message. See **P2-D**.
- `/review` fills the learner's own hand history with fixture hands. It is labelled, but it is a
  different standard from `/record`, which refuses to show zeroes for exactly this reason.

No screen presented a stale *computed figure* as live. The failure is confined to the account-level
units badge and to two pages that 404 instead of explaining.

---

## No impossible probability — PASS

Swept 75 rendered routes (home, learn index, glossary, all 17 lessons, lab index, all 36 scenarios,
legends index + compare + hand-review + all 12 profiles, play, record, review) plus every Coach panel
and Scenario Lab analysis I opened interactively, extracting every `N%` and flagging anything outside
0–100.

Two figures above 100% exist and both are legitimate and correctly labelled:

- `/legends/old-school-pressure`: "Average bet size **107.5%** ± 1.5 points — As a fraction of the
  pot, across every bet it made."
- `/legends/compare`: "Median size **171% of the pot**".

Both are bet-size-to-pot ratios, not probabilities. **The "160.0%" the previous audit found is gone**,
and `pnpm run fixtures:check`'s subject — the Scenario Lab rule-of-2-and-4 surface — now renders
within range. Recorded as **P3-C** only because those ratios are rendered with the same
"`NN.N% ± N.N points`" treatment as the probabilities beside them.

---

## No dark patterns — PASS

Nothing on any screen I visited is a score, streak, level, rank, loss-chasing prompt, urgency device
or variable reward. `/record` states the absence structurally rather than as a promise:

> Six counts and two lists, and nothing else. There is no score on this page, no percentage complete,
> no streak and no rank — not because they were left out, but because the database has no column one
> could be stored in and the response type has no field one could be sent in.

The keyword sweep across all 75 routes returned 41 hits for `streak|reward|deposit|badge|…`, and
every single one is either the product denying the pattern ("there is no mark, no total and no streak
anywhere in this app"; "no deposits, no withdrawals, no cashing out") or ordinary poker prose ("the
reward for winning the pot", "hand rankings"). No leaderboard, no bonus, no timer pressure to act
beyond the honest turn clock, no "win it back" framing. The quiz says "Skipping is fine, and costs
nothing." The scenario page says "Nothing is scored." The hand summary says the result "says almost
nothing about the decision that produced it."

---

## Console errors — PASS with one defect

Navigating `/` → `/learn` → `/lab` → `/legends` → `/record` after clearing the console produced **no
errors**. On some full document loads React logs an error for the theme-boot script — see **P3-D**.
The only other errors captured were `GET /api/v1/content/lessons/tournament-icm → 404`, which was my
own mistyped URL, not the product.

---

# Findings

### P1-A — The quiz panel claims the server recorded an answer it did not record

**Where:** `apps/web/src/lib/quiz-attempts.ts:162` (`VERDICT_SOURCE_NOTE.server`);
`packages/contracts/src/api-types.ts:121` (`QuizAttemptResponse`).

A signed-out learner — the product's default state, since nothing creates a session until you open a
table — answers a quiz and is told:

> …and the one it recorded as a question you have answered.

`POST /api/v1/content/quizzes/:id/attempt` answers 200 to an anonymous caller and stores nothing.
Verified: after answering, `/api/v1/me/progress` returned `401 not_authenticated` and
`prl.quiz_attempts` still held only the four dev-seed rows.

The client *cannot* know: `QuizAttemptResponse` carries `correct`, `explanation`, `expected`,
`optionNotes` and no recorded/attributed signal at all. The sibling module `lesson-reads.ts` solves
exactly this with `completedAt: null` → state `'anonymous'` → "Nothing was recorded, because there is
no session to attach it to", and its header comment says the states exist "precisely so no sentence
on the screen can claim a record the learner does not have". The quiz path has no such state, and the
comment above `VERDICT_SOURCE_NOTE` — "Never claims a recording that failed" — is not true of the
anonymous case.

This is the product's own honesty rule being broken by the product, in its teaching surface.

### P1-B — Hand Review 404s for the hands most worth reviewing

**Where:** `apps/web/src/lib/api.ts:80` (`REQUEST_TIMEOUT_MS = 4_000`);
`apps/web/src/app/review/[handId]/page.tsx:39-56` (`loadReview`).

Opening my own four-handed showdown hand from `/review` rendered
**"404 — Page not found. There is nothing at this address."** The hand exists: fetched from the
browser with the same session, `GET /api/v1/hands/hand_6baf3sthlygsf5ipjsbilsi6nh` returns **200**
with a 45 KB payload containing `commitmentRoot`, `commitmentContext`, `reveal`, `verification`,
`seats`, `decisions`.

Measured from the API log:

| Hand | API response time | Page |
| --- | --- | --- |
| `hand_6baf3sthlygsf5ipjsbilsi6nh` (4 seats, showdown, 15 actions) | **6,272 / 6,444 / 6,959 ms** | 404 |
| `hand_u76sm7ysm37nln4oselizqhuj3` | 1,426 ms | renders |
| `hand_lav3cfwl4fe6k4cryl67zvaa7a` | 1,834 ms | renders |

The web client's per-call deadline is 4,000 ms, so the server render aborts. `loadReview` classifies
the abort as `isApiUnavailable`, falls back to `handReviewFixture(handId)`, gets `null` for any real
hand id, and calls `notFound()`. The web dev log shows `GET /review/hand_6baf… 404 in 4.5s
(application-code: 4.0s)` — the 4.0 s is the deadline, not work.

Two things are wrong and either alone would be a defect: an outage-and-timeout path is being reported
to the learner as "there is nothing at this address"; and the timeout is shorter than the endpoint's
normal response time for a hand with a few decisions in it. The effect is that the deck-commitment
proof — the product's headline verifiable claim — is unreachable for precisely the hands a learner
would want to check.

### P1-C — With the API down, the header invents the learner's unit balance

**Where:** `apps/web/src/components/SiteHeader.tsx:150,168-177`.

With the API stopped, the units badge showed **`1,000 UNITS`** on every page, with no qualification.
The learner's actual figure was 2,000. On `/record` this sat directly above the page's own notice
that "Your record could not be fetched".

The header's session effect is `if (!result.ok) return;` — the fallback silently stands. The scenario
count in the same component does the opposite and is right: "Not answering is a fine answer: the
badge stays absent rather than inventing a number." The units badge should follow it. As it stands,
the one figure the app displays on *every* screen about the learner's own account is a bundled
constant presented as live — which is the precise failure the mandate asks about.

### P1-D — An API restart strands every open table, and the UI blames the learner

**Where:** `apps/api/src/ws/router.ts:355` (`this.registry.require(...)`) versus
`apps/api/src/routes/rooms.ts:577-579` (`await registry.ensureOpen(roomId); return registry.require(...)`).

After restarting the API, "Open the table" produced:

> ▲ WATCH OUT — **Not your table.** The server refused this room: either it does not exist or this
> session is not a member of it. Rooms here are invite-only, so there is no list to browse — start
> your own table instead.
>
> ▲ WATCH OUT — **The server refused something.** No table was found for that link.
> (`room_not_found_or_not_permitted`)

Both statements are false. `GET /api/v1/rooms` answered 200 with both of my rooms
(`room_4uwh4i6yguy4j63jo27gftucp3`, `room_6om4j2g7uvsjknbnwjwczje5ox`), and the database has both as
`status = open` with my membership live at seat 0 and a 1,000 stack in each.

The cause is the split above: the REST path hydrates a persisted room with `ensureOpen`, the
WebSocket `join` path calls `require()`, which only consults the in-memory map. Any room the process
has not loaded since boot is refused.

Consequences: a routine restart or redeploy makes every learner's table unreachable; the only offered
recovery is "start your own table instead", which abandons a private room *and* its invite code —
the code is shown once and only a hash is kept, so the second player can never be re-invited to that
room. And the message accuses the learner of not being a member of a room they demonstrably belong to.

### P2-A — The 60-second turn clock is shorter than the Coach panel takes to read

Twice, a hand ended without me while I was reading the Coach analysis;
`prl.hand_actions` records `seat 0 | fold | was_automatic = t`. The room's
`action_timeout_seconds` is 60.

There *is* a visible countdown on the acting seat ("to act 57s"), and folding rather than calling on
timeout is the right rule (`timeoutAction` in `packages/poker-engine/src/machine.ts:665`), so this is
not a hidden trap. But the panel a learner is meant to read at that moment is ~5,700 characters plus
a five-row EV table and a 47-row card-by-card outs table. The product's two headline features are in
direct tension: you cannot read the analysis and still act. For an educational table with bots and no
stakes, a much longer clock (or none until the learner has acted once) would cost nothing.

### P2-B — "47 outs in total" — the outs count degenerates when hero is already ahead

On a live flop where I held two pair, the Coach panel headed the section
**`OUTS — 47 CARDS IN TOTAL`**, with `Clean 4 cards`, `Dirty 43 cards`, and the summary

> Of the 47 cards that can come next, 4 are clean and 43 are dirty, which is **47 outs in total**.

47 is every unseen card. The "Dirty" label reads "These improve your hand but can still lose", which
is false for most of those 43 — a blank does not improve two pair. The definition being used is a
post-card equity threshold (clean ≥ 90%, dirty 50–90%), and the panel does explain itself in the
paragraph below:

> Hero is already in front before any card arrives — equity now is above the same threshold a card has
> to clear to count as an out — so read the counts as cards that keep hero ahead rather than as the
> size of a draw.

That caveat is honest, but it is a sentence at the end of a paragraph while the headline number is
set in the section title. On a genuine draw the same panel produces a textbook `15 outs`
(9 flush + 6 straight) — so a learner sees a correct 15 in one spot and an absurd 47 in another, from
a section whose own lesson ("Outs: Clean, Dirty and Imaginary") teaches the standard meaning. Either
suppress the count when hero's current equity already clears the threshold, or stop calling it "outs".

### P2-C — After a units reset the same screen shows two different unit totals

Immediately after pressing "Reset my units to the starting amount", the page said "Done. Your units
are back to 2000" while the header badge, unchanged, still read `3,308 UNITS`. Only a reload
reconciled them. The reset response carries the new figure; the header is not told.

### P2-D — With the API down, a Scenario Lab detail page 404s instead of explaining

`/lab/eq-rule-of-four-big-draw-flop` with the API stopped renders "404 — Page not found. There is
nothing at this address." The scenario exists; only 6 of the 36 have offline fixtures, and
`scenarioFixture(id)` returning `null` is turned into `notFound()` in
`apps/web/src/app/lab/[scenarioId]/page.tsx:88`. Same root shape as P1-B: "no fixture for this id" is
being reported as "no such thing". A learner who bookmarked a scenario, or who was on one when the
API went down and reloaded, is told the page never existed. (The `/lab` index itself degrades
correctly to its 6 fixture scenarios and labels them, so this only bites direct navigation.)

### P2-E — `/learn` tells the learner 9 of 17 lessons are unavailable while the API is serving them

**Where:** `apps/web/src/lib/learn-data.ts:121` (`READABLE_LESSON_IDS` derived from the offline
fixture) used at `apps/web/src/app/learn/page.tsx:122`.

With the API up and healthy, nine lesson cards on `/learn` carry:

> This lesson's text comes from the content service, which is not reachable. The page will tell you
> the same thing rather than showing you an empty lesson.

The content service is reachable. `GET /api/v1/content/lessons/betting-actions` returns 200 with
14,545 bytes, and clicking straight through to `/learn/betting-actions` renders the complete lesson.
The index is reporting *fixture coverage* (the bundled copy carries 8 of 17 bodies) in the words of
*service availability*. Affected: `betting-actions`, `all-ins-and-side-pots`, `position-basics`,
`blinds-and-the-option`, `reading-the-board`, and four more. A learner is being warned off more than
half the curriculum on a healthy deployment.

### P2-F — `/legends/compare` explains a different decision from the one it shows

On `/legends/compare`, under one heading:

> **ACTION MIX OVER 40 TRIALS** — raise — most likely **60.0%** · Median size 171% of the pot ·
> call 35.0% · fold **5.0%**
>
> **WHY THIS MODEL PREFERS THAT** — This model **prefers to fold** here, with **13.5%** of its weight
> on that action…

The mix says raise at 60% and fold at 5%; the explanation under "why this model prefers *that*" says
it prefers to fold, at a weight (13.5%) that appears nowhere in the table. The second card on the page
does the same: "raise — most likely 47.5% … fold 10.0%" over "prefers to fold here, with 17.2% of its
weight". The rationale comes from `modelPreferenceFor` in `packages/poker-ai/src/policy.ts:1530`,
which describes the single sampled decision, while the table aggregates 40 trials; the heading binds
them together. On a page whose purpose is comparing how styles decide, the "why" contradicts the
"what".

### P2-G — Seat numbering is inconsistent within one screen

On the same table view:

- Room header: `YOUR SEAT: seat 1` (I am seat index 0).
- Coach panel `EQUITY BY PLAYER`: `you 12.7%` then `seat 1 17.2%`, `seat 2 18.4%`… — 0-based, so its
  "seat 1" is a different player from the header's "seat 1".
- Coach assumptions: "02 you holds exactly 5d2s. 03 **seat 1** holds any of 519 combinations…".
- Hand summary: "**seat 0** wins 2058 from pot 0" — a label that appears nowhere else in the UI, and
  in that hand *seat 0 was me*, unattributed.
- Timeout announcement (`use-live-table.ts:203`): "Seat ${seat + 1} ran out of time" — 1-based.

Four surfaces, two conventions, and the collision lands on the two labels a learner reads most.

### P3-A — The Coach says "chips" where the product says "units"

The EV arithmetic and the suggestion reason both use "chips": "EV(fold) = 0 chips", "by 4.4 chips over
the next-best action", "68.24 chips". Everywhere else the product is emphatic that "Chips are units",
and the surrounding rows are labelled "units". Small, but this is the vocabulary the non-gambling
framing rests on.

### P3-B — "back to 2000" is not the starting amount the app names anywhere

The reset copy promises "the starting amount"; a fresh guest gets 1,000; the reset produced 2,000
because units are the sum of live seat stacks and I held two seats. Nothing on the page explains that.
Also unformatted — "2000" where the rest of the app writes "2,000". Same for
"CALLED CONSISTENT WITHIN 2000 units" in the Scenario Lab and "seat 0 wins 2058" in the hand summary.

### P3-C — Bet-size ratios are rendered exactly like probabilities

"Average bet size 107.5% ± 1.5 points" sits in a column with "Bluffing 53.5% ± 1.5 points" and
"Reached showdown 41.1% ± 1.5 points". The 107.5% is correct (an overbet averages more than the pot),
but the presentation invites the reading that produced the previous audit's "160.0%" complaint. A
different unit treatment ("1.08× pot") would remove the ambiguity.

### P3-D — React logs an error for the theme-boot script on some page loads

`Encountered a script tag while rendering React component. Scripts inside React components are never
executed when rendering on the client.` — from `<script>{THEME_BOOT_SCRIPT}</script>` at
`apps/web/src/app/layout.tsx:111`. The script works on the initial document (no theme flash was
observed), so this is noise rather than breakage, but it is logged at error level.

### P3-E — Outage notices print the internal API origin and fixture paths to the learner

"(could not reach the API at `http://127.0.0.1:3911`: fetch failed)", "this list comes from the typed
fixture in `src/fixtures/scenarios.ts`". Excellent for a developer, and the honesty is the point; but
a deployed build shows an end user an internal address and a source path. Worth deciding
deliberately rather than by default.

### P3-F — Minor copy and formatting

- "Of the 45 cards that can come next, 14 are clean and **1 are dirty**" — grammar.
- "Raise — **55 units to 55 units**" where `min === max`; the contract says a single defensible size
  should be "stated as such rather than padded out", and this reads as padding.
- Scenario detail pages set `<title>` to the generic "Scenario — Poker Risk Lab" until after a
  decision, so browser tabs and history are indistinguishable. Lessons get this right.
- `/play` with the API stopped reports "failed with status 500 (internal_error)" when the real cause
  is that nothing is listening; the Next rewrite turns `ECONNREFUSED` into a 500 and the learner sees
  a server-error code rather than "unreachable".

---

## Can a real learner actually use this product end to end today?

**Mostly yes, and the parts that work are unusually good — but not without hitting at least one wall
that will look like the product being broken.**

Everything a learner does *at the table* works and is trustworthy. Hands deal, settle and conserve
chips; bots act with recognisable styles; two genuinely separate people can meet in a private room by
invite code and play a hand to showdown; a dropped socket reconnects and restores state without
leaking a single opponent card; the Coach panel is complete, arithmetically explicit, honestly
labelled exact-or-sampled, and — checked directly — never claims an action is correct, optimal or
best, and never shows a probability outside 0–100%. The "160.0%" is gone. There are no dark patterns
anywhere: no score, no streak, no rank, no urgency, no loss-chasing. `/record` refusing to show
zeroes when it cannot read the record is the best single piece of engineering judgement I saw.

What a learner will hit:

1. They arrive as a guest, answer a quiz, and are told the server recorded it. It did not (**P1-A**).
   Nothing on screen tells them they need to open a table first for any of it to count.
2. They play a good hand, go to review it, and get **"There is nothing at this address"** — because
   the richer the hand, the more certain the 4-second client deadline is to fire (**P1-B**). The deck
   proof, which does work and is the product's strongest claim, is unreachable for exactly those hands.
3. If the API is ever restarted while they have a table open, their table is gone and the app tells
   them it was never theirs (**P1-D**).
4. If the API is briefly unavailable, every screen tells them so honestly — except the units badge,
   which quietly shows 1,000 as though it were theirs (**P1-C**).
5. On the way in, `/learn` warns them off nine of seventeen lessons that are working perfectly
   (**P2-E**).

None of these are engine or maths defects — the poker and the probability are sound. They are all the
same class of defect: a *fallback path that reports the wrong reason*. "Timed out" is rendered as
"does not exist", "no offline fixture" as "no such hand", "no session" as "recorded", "not loaded into
memory" as "not your table", "cannot reach the API" as "1,000 units". For a product whose central
promise is that it never says more than it knows, that is the pattern worth fixing before release —
and it is a small, well-localised set of changes rather than a redesign.

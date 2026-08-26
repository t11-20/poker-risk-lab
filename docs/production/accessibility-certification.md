# Screen-reader certification procedure

**Candidate SHA:** `b292b2ac234cb586f253ad42ec0ef4d949fa332b` — **for section 10's captured
`osascript` errors only.** Corrected 2026-08-26: `scripts/ax-assertions.mjs` did not exist at that
commit (`git cat-file -e b292b2a:scripts/ax-assertions.mjs` → no such object; it first appears at
`d191473`), so the machine-verified count below cannot be evidence taken at the stamped SHA. The
assertion inventory *is* held to the code by `scripts/screen-reader-certify.test.mjs` and
`scripts/readiness-report.test.mjs`, which is where its currency comes from — not from this header.

**Status on this candidate (2026-08-23, this host): BLOCKED — UNVERIFIED.**
Section 10 records exactly why, with the errors captured on this SHA. Nothing in this repository
has ever heard this application read aloud, and no gate in it can. This document is the procedure
that would settle that, written so that a person who has never seen this app can execute it on
another machine and produce a defensible verdict.

**70 of the 72 assertions below are now machine-verified on every run** of `pnpm run test:ax`, one
check per assertion ID, against the rendered accessibility tree in real Chrome
(`scripts/ax-assertions.mjs`). A regression in any of them fails `pnpm run verify`. The remaining
**2** are marked `person` and still require somebody with a screen reader and headphones —
section 5 explains where the line is drawn and why it is drawn conservatively. That session is now
about **five minutes** per platform rather than the better part of an afternoon.

Six of the ten that were left in that session have gone since, and **not one of them went because
the standard was relaxed**. Two were application defects filed as certification limits, one asked
for a control that has never existed, and three — added 2026-08-26, in the second list below — were
left for a reason that turned out to be answerable when somebody checked it.

- **3.3** — "A new hand was dealt." was measurably never announced. That was read as a question for a
  person ("is hearing the blinds instead a PASS?") and it was a bug: the table's narration region did
  not exist at the moment the hand was dealt, and the deal sentence was overwritten by the forced
  bets of the same table notice before any reader could hear either. Both are fixed
  (`apps/web/src/components/TableStage.tsx`, `apps/web/src/lib/use-live-table.ts`) and the row is
  now `auto`. What a reader hears is recorded in section 5.
- **8.2** — reaching the bundled-copy path needs the **web server's** own fetch to fail, which is why
  blocking `/api/*` in the browser could not do it. The gate now runs a second web app off the same
  build with no API behind it, so the row is a fixture the gate owns rather than a state it cannot
  reach.
- **1.5** — retired. It asked a reviewer to check a disclosure `/learn` has never had. See section 5.

The three that moved on 2026-08-26. None of them was refused for a reason about speech; each was
refused for a reason that does not survive being measured:

- **2.4** — "the prompt is **not** read twice" was read as a fact about the utterance. It is a fact
  about the tree with exactly one cause in it: a reader announces a group's name on entering it, so
  the prompt is heard again if and only if it appears in a second accessible name. `QuizRunner`
  already says so where its legend is written — "a legend that repeats it makes a screen reader read
  the whole question twice" — and the check is that comment, asserted.
- **2.9** — "**no** score is announced **anywhere**" is unbounded over *wordings* and bounded over
  *causes*. A score is a function of what the learner got right, so the gate now walks the quiz to
  its review panel twice from a fresh load, diverging in exactly one answer, and requires the two to
  read identically. That is a decision procedure rather than a pattern list; see section 5.
- **3.19** — provoking a server refusal was said to need "a second actor racing the same seat". It
  needs one task: `disabled` arrives from React state, so two `click()`s inside one task both reach
  `act` and two decisions go out over one socket. Measured against the running server, the second
  was answered `It is not your turn to act. (not_your_turn). Nothing was applied.` — a real refusal
  of a real second decision, with nobody racing anybody.

Nineteen of those 70 were `person` until the gate grew three fixtures rather than because they were
about speech: **a live table over a real socket**, **a hand this run played, replayed at
`/review/<handId>`**, and **a second web app with no API behind it**. All three are driven through
the product's own screens — a guest session, a private room with five bots, a dealt hand, a
decision, a page served with nothing behind it — so the connection status changing, the blinds
arriving before the bots, a turn announced once across ten seconds of state frames, a decision echo
that is not stapled to the events after it, a whole hand read back decision by decision, and the
bundled-copy notice being a sentence rather than a badge are now facts a gate can lose. See
section 5 for what each of them does *not* establish.

Do not record a PASS here because `test:ax` or `test:keyboard` was green. **70 of 70 automated
assertion checks passing is not a certification of anything**, including of those 70: it says the
tree is right, not that a reader heard it.

---

## 1. What this decides, and what it does not

This procedure decides one thing: **can each of the six primary journeys be completed, correctly and
without guessing, by somebody who is operating this application entirely through a screen reader?**

It is the only check in this repository that can decide that, because it is the only one that
involves a screen reader. The three automated gates are all *necessary conditions* and none of them
is sufficient:

| Gate | What it establishes | What it cannot |
|---|---|---|
| `pnpm run test:a11y` | Static rules over server-rendered HTML | Anything CSS, JS or a browser decides |
| `pnpm run test:keyboard` | Real Tab/Enter/Escape/arrows in real Chrome, focus order, focus visibility, traps, a whole hand folded from the keyboard | What any of it is announced as |
| `pnpm run test:ax` | The **computed accessibility tree** — role, computed name, live-region politeness, heading outline, landmark uniqueness, that no hidden card names a rank or suit, and that a real interaction changes an announcement region and leaves focus on a named node. Plus a **live table over a real socket**, a **hand it played, replayed**, and a **second web app with no API behind it** — every write into every live region, in order, with its politeness. **Plus 70 of the 72 assertions below, one check each** (see section 5) | Whether any assistive technology **speaks** any of it, in what order, at what verbosity, or comprehensibly. And 2 of the 72, which it does not attempt |

A correct accessibility tree is what a screen reader consumes. It is not what a screen reader
*says*. The gap between the two is verbosity settings, browse-vs-focus mode, live-region queueing,
interruption behaviour, punctuation handling, and thirty years of divergent implementation. That gap
is what this document exists to close, and it can only be closed by a person with headphones on.

**Do not record a PASS here on the strength of a green `test:ax` run.** They are different claims.

---

## 2. Required environment

Both platforms are required for a full certification. A single-platform run is recorded as PARTIAL
(see section 9).

### 2.1 macOS — VoiceOver with Safari

| Item | Requirement | How to check |
|---|---|---|
| macOS | 14 (Sonoma) or later | `sw_vers` |
| VoiceOver | The build shipped with that macOS. Not separately versioned. | Present at `/System/Library/CoreServices/VoiceOver.app` |
| Safari | The build shipped with that macOS, 17 or later | `defaults read /Applications/Safari.app/Contents/Info.plist CFBundleShortVersionString` |
| Audio | Headphones or speakers that work. A silent run is not a PASS. | — |

Safari, not Chrome, is the macOS pairing that matters: VoiceOver + Safari is the combination the
overwhelming majority of macOS screen-reader users actually run, and it is the pairing with the most
history of dropping live regions that other browsers announce.

### 2.2 Windows — NVDA with Chrome, and NVDA with Firefox

| Item | Requirement | How to check |
|---|---|---|
| Windows | 10 22H2 or later, or Windows 11 | `winver` |
| NVDA | 2024.1 or later | NVDA menu → Help → About |
| Chrome | 120 or later | `chrome://version` |
| Firefox | 128 ESR or later | `about:support` |

NVDA is the free reader, so it is the one a reviewer can actually obtain; and NVDA + Chrome and
NVDA + Firefox differ in live-region behaviour often enough that both are worth ten minutes.

JAWS is **not** required. If it is available, run journey 3 (the table) on it as well and record the
result as a note — that journey is the one with the most live-region traffic.

### 2.3 The build under test

Certify a **production** build. A development build ships dev-only overlays that are not what ships,
and one of them is itself a live region.

```sh
pnpm install
pnpm run build
pnpm run db:setup            # journeys 3 and 6 need a database
pnpm --filter @prl/api start &
pnpm --filter @prl/web start &
```

Then confirm the automated gates are green **before** starting, so that a failure heard here is not
one a machine could have caught. Run these with the two servers above **stopped**: all three start
their own — `test:ax` on :3456 and `test:keyboard` on :3464, both with an API on :3001 — and a
manual API already holding :3001 makes them fail at boot rather than measure anything:

```sh
pnpm run test:a11y
pnpm run test:keyboard
pnpm run test:ax
```

Record the three results in the header of section 8. A manual pass over a build whose automated
gates are red is not a certification of anything.

---

## 3. Permissions (macOS TCC)

VoiceOver itself needs no permission — it is a system service and it is enabled with **Command +
F5**, or in **System Settings → Accessibility → VoiceOver**.

Permissions are needed only if the reviewer intends to **script or record** the session. That is
optional; a certification carried out by a person listening and ticking boxes needs none of it. If
you do want to script or record it, grant these before you start, because each one interrupts the
run with a modal the first time it is hit:

| What you want to do | Permission | Where to grant it |
|---|---|---|
| Screenshot or screen-record the session as evidence | **Screen Recording** | System Settings → Privacy & Security → Screen Recording → add and enable your terminal (or the recording app) |
| Drive VoiceOver or the UI with AppleScript / `osascript` | **Automation** — one entry per target app | System Settings → Privacy & Security → Automation → your terminal → enable **System Events** and **VoiceOver** |
| Send synthetic keystrokes | **Accessibility** | System Settings → Privacy & Security → Accessibility → add and enable your terminal |
| Let VoiceOver be controlled by AppleScript at all | **"Allow VoiceOver to be controlled with AppleScript"** | VoiceOver Utility (**VO + F8**) → General → tick that box. This is a **separate** switch from the Automation permission above, and both are required. |

Two things about this that cost people an afternoon:

- Each permission is granted **per terminal application**. Granting it to Terminal.app does nothing
  for iTerm2, for VS Code's integrated terminal, or for an agent harness running under a different
  parent process. The entry that must be enabled is the one for the process that will actually make
  the call.
- macOS caches a refusal. After granting a permission, **fully quit and reopen** the terminal;
  `tccutil reset AppleEvents <bundle-id>` clears a stale grant if the pane appears correct and the
  call is still refused.

The permissions database (`/Library/Application Support/com.apple.TCC/TCC.db` and the per-user copy
under `~/Library/Application Support/com.apple.TCC/`) is protected by System Integrity Protection.
It cannot be edited, and it must not be: an environment where these grants were forged is not an
environment whose accessibility result anybody should believe. Grant them through the panes above or
record the journey as BLOCKED.

---

## 4. Screen-reader key reference

Only the keys this procedure uses. `VO` means **Control + Option** held together.

### VoiceOver (macOS)

| Action | Keys |
|---|---|
| Start / stop VoiceOver | Command + F5 |
| Read next item | VO + Right Arrow |
| Read previous item | VO + Left Arrow |
| Activate the item | VO + Space |
| Open the rotor | VO + U (Left/Right Arrow switches list: Headings, Links, Landmarks, Form Controls) |
| Jump to next heading | VO + Command + H |
| Jump to next landmark | VO + Command + Shift + L (or the rotor) |
| Read the whole page from here | VO + A |
| Stop speaking | Control |
| Repeat the last thing spoken | VO + Z |
| Open the last announcement history | VO + Shift + Z |
| Interact with / stop interacting with a group | VO + Shift + Down / VO + Shift + Up |

### NVDA (Windows)

| Action | Keys |
|---|---|
| Start NVDA | Control + Alt + N |
| Read next line | Down Arrow (browse mode) |
| Next heading / next landmark / next form field | H / D / F |
| Toggle browse and focus mode | NVDA + Space |
| Read the whole page from here | NVDA + Down Arrow |
| Stop speaking | Control |
| Report the current focus | NVDA + Tab |
| Open the speech-history viewer | NVDA menu → Tools → Speech Viewer (**turn this on before starting**; it is the only practical way to quote an announcement exactly) |

**Turn on a speech viewer / announcement log before the run.** Every assertion below is about words
that are spoken once and gone, and a certification that rests on "I think it said something like
that" is not one.

---

## 5. How to record a result

Each step below is a **pass/fail assertion**, phrased so that it is decidable. For each one, write
one of:

- **PASS** — the assertion held, in the words quoted or in a paraphrase that carries the same
  information.
- **FAIL** — something was announced and it was wrong, or the wrong thing interrupted, or the
  reader was left unable to tell what happened. Quote what WAS said.
- **SILENT** — nothing was announced at all. Recorded separately from FAIL because the two have
  different causes and different fixes.
- **N/A** — the state could not be reached in this run. Say why.

Exact wording is **not** required to pass. What is required is that the information is there, that
it arrives at the right moment, and that nothing louder talks over it. Where a phrase below is in
quotation marks it is the string the app actually ships, so it is what you should expect to hear.

### The "Checked by" column: 70 of these are now decided by a machine

Every assertion below carries a **Checked by** marker, and it decides whether
`pnpm run certify:screen-reader` will put the row in front of you at all.

| Marker | Means | Who decides it |
|---|---|---|
| `auto` | **70** rows. The fact this assertion rests on is asserted on every run of `pnpm run test:ax`, against the rendered accessibility tree in real Chrome — at a live table, on a replayed hand, and on a web app with no API behind it where the row needs one. A regression fails `pnpm run verify`. | `scripts/ax-assertions.mjs`, one check per assertion ID |
| `person` | **2** rows. The state cannot be reached without a server that lies about a deal, or without a deliberately broken build. | You, with headphones |

The line between them is the one section 5 already draws. **"The information is there"** is a fact
about the accessibility tree, and a machine can decide it: an accessible name, a role, an ARIA
state, a live region's politeness, a heading level, where focus landed, whether a control is in the
tree at all. **"It arrives at the right moment, and nothing louder talks over it"** is a fact about
a screen reader, and nothing in this repository can decide it.

Three things this split does **not** mean:

1. **It is not a partial certification.** A green `test:ax` still certifies nothing, for exactly the
   reason section 1 gives. What the 70 buy is that a *regression* in one of them now fails a gate on
   the same day rather than waiting for a manual session that may be months away — and that the
   manual session is five minutes rather than an afternoon.
2. **The residual 2 still require a person.** They are not deferred, waived or downgraded. Until
   somebody sits down with VoiceOver or NVDA and works through them, this certification is
   UNVERIFIED, and section 10 stays as it is.
3. **The split is deliberately conservative.** Where a row mixes a checkable fact with a claim about
   speech — 3.16's focus landing *and* the sentence being heard — the whole row stays `person`
   unless the speech half follows from a structural property the check actually asserts. A row
   half-covered by a machine and dropped from the human session is a row nobody checks, which is
   worse than a smaller automated set. **2.4 is the only row that has ever been moved under that
   carve-out**, and it was moved because "the prompt is not read twice" has exactly one cause inside
   the tree and the check asserts the absence of it. 6.7 is the counter-example that stays: its two
   halves are both structural, one of them is unreachable, and half a row is not a covered row.

**Two of the four that were left have since been closed by changing the PRODUCT, not this document.**
4.2 and 7.4 were not certification limits; they were defects with a checklist item wrapped round
them, and the entry each of them used to have in the list below said so. The Lab's filtered count is
now in the document title, and the background behind the navigation sheet is now `inert`. Both are
recorded under "What 4.2 and 7.4 announce now" below, and both moved to `auto` only once
`scripts/ax-assertions.mjs` held a check that had been shown to fail against the old build.

Some `auto` rows are worth reading before you trust them, because what the machine does is not
literally the recipe the row gives:

- **2.4** checks the *cause* of a double reading rather than the reading. The group's computed name
  is "Choose one answer", every option's name is its own text, and the prompt appears in exactly one
  accessible name in the question — the heading's. A reader announces a group's name on entering it,
  so those three facts are the whole of what the page can do to make the prompt be said twice. What
  is left over is a reader re-reading on request, which is not a property of this page.
- **2.9** is decided by DIFFERENCE, not by scanning for words like "score". The gate walks the quiz
  to its review panel twice from a fresh load and answers the first question with the lesson's own
  answer in one run and with another option in the other, skipping the rest identically; the two
  panels — and every live region on the page — must read the same, over `main` rather than the whole
  document because the shell's units pill is fetched and can settle differently. A tally, a mark, a
  percentage or a bare "well done" would all differ, in any wording, digits or none. The one thing a
  differential cannot see is a figure that does not depend on correctness, so the panel is
  separately required to carry no `N of M` or `N%` shape. The document used to say the panel's own
  prose "defeats every textual scan"; it does not — it spells the number as a word — but a scan was
  the wrong instrument anyway.
- **3.19** presses Fold **twice inside one task**. A real Enter key cannot do it: two key events are
  two tasks, and by the second one the control is genuinely disabled. `disabled` arrives from React
  state, so within one task both presses reach `act`, each minting its own `actionId`, and both
  frames leave over one socket in order. The check refuses the run if the control was already
  disabled between the two presses — a silence measured after one decision would be a silence the
  fixture manufactured. Which refusal the server picks is deliberately not pinned; `not_your_turn`
  and `stale_action_sequence` differ only in where the hand got to.

- **2.6** types `1e` rather than letters. Chrome's `<input type="number">` filters bare letters out
  at the editing layer — measured in Chrome 151, three real `a`/`b`/`c` key events left the field
  empty, `validity.badInput` false and `aria-invalid` absent, so nothing had happened. `1e` is a
  partial exponent, which Chrome does accept and does report as bad input. The claim being checked —
  a refused answer says so, and says *why* before it says what the tolerance is — is the same.
- **3.9** is checked as reading order, not as a group name. Chrome does not compute a `<figure>`'s
  accessible name from its `<figcaption>` at all (measured: the name is empty with or without the
  caption being visually hidden). The check asserts the caption is in the accessibility tree, names
  every card on the board, and comes before them.
- **3.6** is checked as DOM mutations, not only as text. A polite region rewritten with the *same*
  sentence changes nothing on screen and is a repeat announcement in several readers, so counting
  distinct texts would pass an app that re-announced the turn on every state frame. The check
  requires the turn region to take **no mutation at all** for the ten seconds the row asks for.
- **3.20** blocks the browser's `/api/*` requests instead of stopping the API. Stopping the API this
  gate started would also take out `/lab`, the hand journey 6 reads back, and every other assertion
  in the run. From the page's side the two are the same fact — the fetch fails and the socket never
  opens — and the check asserts the same thing either way: the error interrupts, and the polite
  status line does not go on claiming the table is ready.
- **6.1–6.6** run against a hand *this run played*, not against a fixture. The gate opens a table,
  sits down, deals, folds, waits for the hand to finish, and then replays it at `/review/<handId>`
  as the reader's own history. A run that cannot produce a hand with both a face-down and a face-up
  card in it fails these rows rather than passing them: a replay where nothing is hidden proves
  nothing about hiding.
- **8.2** runs against a **second web app**, on its own port, off the same build, with
  `PRL_API_ORIGIN` pointing at `127.0.0.1:1` — a port nothing can be listening on, because binding
  it needs root. That is the whole fixture: the web server's own `fetch` gets a transport error,
  `isApiUnavailable` says so, and `/learn` renders the bundled curriculum with its notice. Blocking
  `/api/*` in Chrome the way 3.20 does cannot produce this state, because the fetch that fails is
  the server's and not the browser's.

The three fixtures are what moved seventeen rows (this said "nineteen" until 2026-08-26; the three
figures immediately below add to 10 + 6 + 1 = 17, and one of those, 3.3, moved because of a bug fix
rather than a fixture). Journey 3 was **10 of 21** `auto` because
`/play?state=decision` renders the table's component tree without a socket; it is now **21 of 21**,
driven against `/play` itself, the last of them by the double-press fixture 3.19 needed. Journey 6
was **0 of 7** because the scrubbable replay needs a hand in a database and
`/legends/hand-review/demo` renders `PostHandComparison`, a different component with no face-down
card and no timeline; it is now **6 of 7**. Journey 8 was **1 of 3** and is now **2 of 3**. Journey 2
was **7 of 9** and is now **9 of 9**.

### What 3.3 announces now, and why it does not double-announce

3.3 was `person` on the strength of a measurement — "A new hand was dealt." never reached the DOM —
and that measurement was right about the symptom and wrong about the cause. Two things were broken,
and both are application defects rather than certification limits:

1. **The narration region did not exist when the hand was dealt.** It was owned by `PokerTable`,
   which is not rendered until a `view` arrives, and the frames that start a hand bring the first
   sentence and the first view in one commit. So the region was *inserted already holding* the
   blinds sentence, and a live region that arrives with its text announces nothing — the platform is
   notified of a change to a region it already knows about. Measured by the gate at the moment "Deal
   the next hand" was pressed: the document's only live regions were the route announcer, the
   connection line, the invite and join notes, the decision band's turn region and the footer
   statement. The region is now mounted unconditionally by `TableStage`, empty, from first paint —
   the same rule `RouteAnnouncer` and the quiz already follow.
2. **The deal sentence was destroyed by the forced bets.** `handStarted` and `forcedBets` are two
   events of ONE table notice: the API writes them back to back and the engine emits
   `forcedBetsPosted` unconditionally in the same `startHand` call. Two writes into one atomic
   polite region for one notice are one announcement, and it is the second one. With the region
   mounted the gate could see it happen — "A new hand was dealt.", then "smallBlind 5 from seat 3,
   bigBlind 10 from seat 4" — which is the same silence, now visible.

**What a reader hears now is one polite sentence: "A new hand was dealt. smallBlind 5 from seat 3,
bigBlind 10 from seat 4."** The reducer does not write the deal and then extend it; `handStarted`
writes nothing at all and leaves a sentence to be *carried* onto the front of the first thing the
hand says. That is exactly one write into the region however the frames arrive, so there is no
timing under which the deal is heard twice — which is the defect on the other side, and the one
3.17 exists to catch.

The check behind the row asserts each of those facts — the region was already there, the sentence
was one the region was observed holding, it was polite, it was said once, and it did not stand
alone — and refuses one more thing: an entry recovered from a `characterData` old value, which is a
string that existed inside one React commit and never painted. A first version of it passed against
a build with the defect deliberately restored, and the clause that now refuses a deal sentence
standing alone is what that run bought.

### What 4.2 and 7.4 announce now, and why neither was a certification limit

Both rows were `person`, and the entry each of them had in the list below recorded a measurement
rather than a limit. Re-measured on 2026-08-26 against a production build in Chrome 151 before
anything was changed, both measurements held.

**4.2 — the filtered count was announced to nobody.** `ScenarioFilters` is a plain `GET` form and
ships no JavaScript on purpose, so a submit replaces the document. Measured: a `window` marker set
before the submit was gone afterwards (the JavaScript context was destroyed), `document.title` was
byte-identical before and after — `Scenario Lab — Poker Risk Lab`, carrying nothing about the filter
— and the summary region on the new document took **zero mutations**, because it arrived already
holding "Showing 14 of 36 scenarios." A live region that arrives with its text announces nothing;
that is the same fact 3.3 was fixed for. The difference from 3.3 is that there the region could be
mounted empty from first paint and written into a moment later, and here there is no "later": the
context that would do the writing has been thrown away by the navigation.

So the fix is the one channel a new document *does* announce with no JavaScript at all — its title,
which is assertion G1. **A filtered view's title now carries the count**: "Scenario Lab — 14 of 36
scenarios — Poker Risk Lab", and "Scenario Lab — 0 of 36 scenarios — Poker Risk Lab" for a
combination that matches nothing. An unfiltered `/lab` is untouched, which is what keeps 4.1's quoted
title true. The summary line's `role="status" aria-live="polite"` is **gone** rather than left as a
promise nothing keeps — an announcement channel measured never to fire is how this row stayed open —
and the count phrase is one function shared by the title and the line, so the two cannot disagree.
`RouteAnnouncer` cannot stand in for any of this: it is deliberately silent on a full load, and a
query-only change does not move `usePathname` at all. The check (`J4.2`) asserts the submit still
destroys the context — because a client-side query change would announce nothing however good the
title is — reads the count off the page's own summary rather than recomputing it, and refuses a run
that never reached an empty result.

**7.4 — the background was reachable behind the sheet.** Measured with the sheet open at 390x844 on
`/`, before the fix: of 34 content-bearing elements outside `.prl-sheet`, **29 were still non-ignored
nodes in the computed accessibility tree** — "Skip to main content", the wordmark link, `main`, its
`h1`, every hero link. `MobileNav` held the background in scope with `aria-modal="true"` and a
`focusin` trap and nothing else, so whether a virtual cursor reached those 29 nodes was a fact about
whether the reader honours `aria-modal` — which is exactly why the row needed a person.

**Every subtree that is not the sheet is now `inert` while it is open.** An inert subtree is out of
the accessibility tree, out of the tab order and out of pointer events at once, so there is nothing
left to walk to whatever the reader thinks of `aria-modal`. Measured after the fix on the same page:
of 188 content-bearing elements behind the sheet, **0** are non-ignored. Two things the fix
deliberately does not do, and the check asserts both rather than glossing them:

- **The sheet's own ancestors are not inert**, because `inert` is inherited and a descendant cannot
  opt out — inerting `<header>`, where the trigger and the sheet both live, would inert the sheet
  inside it. What is required of them instead is that they are containers: an ancestor still in the
  tree must carry no text of its own. One survives, `<header aria-label="Site">`, a banner with no
  text and no non-ignored descendant outside the sheet.
- **The route announcer is spared**, because it is the one region outside the sheet that still has
  something to say: a back-button navigation announces the new route while the sheet is still open,
  and `RouteAnnouncer` is mounted above the shell so its effect runs first on that commit. Sparing it
  is only free while it is empty, so the check asserts that it is empty *and* that it is the only
  thing spared.

The `focusin` trap stays. It is not made redundant: it is what still holds if `inert` is unsupported,
and it is the only thing watching the node the sweep spares. The two do not fight — an inert element
cannot take focus, so the trap never fires for one. 7.2 and 7.3 are unchanged and still pass.

Neither row moved until the check behind it had been shown to fail against the old build.

### Why 1.5 was retired rather than left for a reviewer

The row asked a reviewer to "Tab to a lesson's disclosure and press Enter" on `/learn`. There is no
such control, there never has been, and there should not be:

- no `<details>` and no `aria-expanded` has ever existed in `apps/web/src/app/learn/page.tsx` —
  checked over the file's whole history, not just this build. The row was written speculatively in
  the same commit as the rest of this document, against a page nobody had opened;
- the only `aria-expanded` controls reachable from `/learn` belong to the site shell (`UnitsBadge`
  in the header, `MobileNav`'s "Menu"), and the shell's is already asserted at 7.1 and 7.5;
- the page hides nothing on purpose. Summaries, difficulty, reading time, prerequisites and their
  links are all printed on every card, and the page's own module comment gives that as a product
  decision. A disclosure here would be a feature nobody asked for, invented to satisfy a checklist.

A reviewer sent to check it would either waste the time or — much worse — tick it against the
shell's navigation control and record a pass for something that was never tested. The claim the row
was making is asserted at **3.21**, against a control that exists. The row is therefore gone, and
`1.5` is left unused rather than renumbering `1.6`: an assertion number is a reference, and silently
moving one changes what an old report was talking about.

The two that are left are left for a reason, one line each. (They are written as a list rather
than a table on purpose: a table whose first cell is `6.7` is an assertion row to the harness's
parser, and it would refuse this file for having a row whose `Checked by` cell says something else.)

- **6.7** — the failing half needs a server that lies about a deal, and there is no honest fixture
  for it. `/review/<handId>` is a server component: the reveal reaches `CommitmentVerifier` as a
  prop from the web server's own fetch, so the browser cannot be made to receive a corrupted one
  the way 3.20 makes a fetch fail, and an honest API never serves a reveal that contradicts its own
  commitment. The two remaining routes are both refused. A switch inside the product that produced
  a bad proof would be a production code path that can lie about a deal, which is the single thing
  this component exists to detect — its own header says a server that dealt dishonestly is exactly
  the server whose self-assessment cannot be trusted. A harness serving a hand-built
  `HandReviewResponse` would be checking the shape of its own fixture, and would go stale against
  the contract the moment either side moved. `apps/web/test/deck-proof-binding.test.ts` drives the
  branch at source level against real commitments, which is a different and weaker claim, and this
  row stays where it is. **One route is not refused by the argument above and has not been taken:**
  a third web app, off the same build, whose `PRL_API_ORIGIN` points at a pass-through proxy that
  forwards the real API's real review response and flips one byte inside the reveal. That is neither
  a production code path that can lie nor a hand-built payload — it stays bound to the contract
  because it never authors one — and it would reach `mismatch` honestly, the way 8.2's second web
  app reaches the bundled copy. It is a third `next start` and a proxy inside a release gate for one
  row, and the row's other half is reachable and would then be checked alongside it. Not taken; not
  refused either. Recorded here so the next person costs it rather than re-deriving it.
- **8.3** — needs a build with a deliberate `throw` in the root layout, and no fixture reaches it.
  The boundary fires only when the ROOT layout fails to render, and that layout has exactly one
  runtime input — `(await headers()).get('x-nonce') ?? undefined` — so no request, cookie, header or
  stored state can make it throw. There is nothing to drive. Every remaining route needs a
  *different build*: either a source patch plus a full `next build`, which would put an application
  build inside `pnpm run verify` and keep a recipe for a poisoned build in the tree, or a
  build-time switch whose job is to break the application, which is a production code path that can
  lie. The note under journey 8 tells a reviewer how to make that build by hand and revert it, and
  that is the right place for it.

---

## 6. Global assertions (check once per platform, on any page)

| # | Checked by | Assertion | Result |
|---|---|---|---|
| G1 | auto | On loading `/`, the reader announces the document title **"Poker Risk Lab — a decision laboratory for poker"**. | |
| G2 | auto | The **first** Tab stop announces **"Skip to main content, link"**. Pressing Enter on it moves the reading cursor into the main content — the next VO + Right / Down Arrow reads content, not the header. | |
| G3 | auto | The landmark rotor lists exactly: one **banner** ("Site"), one **main**, one **contentinfo** ("About Poker Risk Lab"), and navigation landmarks that are **differently named** ("Primary", "Sections", and at narrow widths "All sections"). No two landmarks of the same role share a name. | |
| G4 | auto | The heading rotor shows exactly **one level-1 heading** on the page, and no level is skipped going down the list. | |
| G5 | auto | Every control the reader lands on announces a name and a role. Nothing is announced as a bare "button", "link" or "image". | |
| G6 | auto | The theme control announces as a radio group with three options (Auto, Light, Dark), the current one announced as selected. | |

### Route announcement (the assertion most likely to fail, and the one most likely to be misread)

| # | Checked by | Assertion | Result |
|---|---|---|---|
| G7 | auto | From `/`, activate the "Learn" link in the primary navigation. Within about a second the reader announces **"Learn — Poker Risk Lab"** — politely, i.e. it waits for whatever was being read to finish rather than cutting it off. | |
| G8 | auto | The title is announced **exactly once**. Hearing it twice is a FAIL: it means the framework's own announcer is still present alongside the app's. | |
| G9 | auto | On the **initial** page load (a full document load, not a link), the title is announced by the browser/reader as usual and **not** a second time by the app. | |
| G10 | auto | Focus does **not** move on navigation. After activating a link the reading cursor is where the reader left it, not forced to the top or to the new heading. This is deliberate; a reader who is moved is a FAIL. | |

> **Why G8 exists.** Next 16 ships its own route announcer, inside a shadow root, `role="alert"`,
> `aria-live="assertive"`. This app removes it and announces politely in the light DOM instead. If
> both are present the reader hears the page title twice, once interrupting. This was measured in
> Chrome 151 against a production build: the framework's announcer went from empty to
> `"Learn — Poker Risk Lab"` within 300ms of a client navigation. It works — that is exactly why a
> duplicate is audible.

---

## 7. The six journeys

Each journey starts from a freshly loaded page at the URL given. Run each one **without looking at
the screen** wherever you can; the point is not whether the information exists but whether it
arrives.

### Journey 1 — Learn (the curriculum index) · `/learn`

| # | Checked by | Step (keys) | Assertion | Result |
|---|---|---|---|---|
| 1.1 | auto | Load `/learn` | The title **"Learn — Poker Risk Lab"** is announced. | |
| 1.2 | auto | VO + Command + H (or `H`) to the first heading | A single level-1 heading naming the curriculum is announced, with its level. | |
| 1.3 | auto | Continue by heading | Each topic group announces as a heading at level 2 or 3, in an order that never skips a level. | |
| 1.4 | auto | Rotor → Links (or `K`) | Every lesson link announces the lesson's title. No link announces as a bare number, a glyph, or "link". | |
| 1.6 | auto | Read the figures at the top (VO + Right / Down) | Each figure announces a **label and a value together** ("Lessons, 17"), never a bare number. | |

> **1.5 is missing on purpose.** It asked for a disclosure `/learn` has never had, and it was
> retired rather than renumbered — see section 5. The number stays unused so that an older report
> citing "1.5" still means what it meant.

### Journey 2 — Guided practice (a lesson and its quiz) · `/learn/pot-odds`

| # | Checked by | Step (keys) | Assertion | Result |
|---|---|---|---|---|
| 2.1 | auto | Load `/learn/pot-odds` | Title **"Pot odds — Poker Risk Lab"** (or the lesson's own title) is announced. | |
| 2.2 | auto | Read to the quiz | The quiz panel announces as a heading, and the question prompt as a level-3 heading. | |
| 2.3 | auto | Read the question's position | The heading announces **"Question 1 of 5"** before the prompt. | |
| 2.4 | auto | Tab into the answer group | The group announces its purpose ("Choose one answer") and each option announces its own text. The prompt is **not** read twice. | |
| 2.5 | auto | Select an option (Arrow keys, then Space if needed) | Within a moment, politely and without interrupting: **"That matches the answer this lesson gives…"** or **"That is not the answer this lesson gives…"**, followed by the sentence about what was recorded. | |
| 2.6 | auto | 2.5 again, on a **numeric** question: type letters into the answer field | The field announces itself as **invalid**, and the correction — "That is not a number this question can be checked against…" — is announced **with the field**, before the tolerance hint. | |
| 2.7 | auto | Clear the field and type a number, then activate "Check against the computed figure" | The comparison is announced politely as one message ("… is within the tolerance of …"), including the sentence about whether anything was recorded. Hearing the recording sentence *without* the verdict in front of it is a FAIL. | |
| 2.8 | auto | Activate "Next question" | The reading cursor moves to the new question's heading and announces **"Question 2 of 5"** followed by the new prompt. Being moved to a heading that announces only the prompt is a FAIL — the reader cannot tell whether they advanced. | |
| 2.9 | auto | Reach the end of the quiz | The review panel announces, and **no score, tally or mark out of five is announced anywhere**. Hearing one is a FAIL against the product's own guarantee. | |

### Journey 3 — Poker table and Coach · `/play`

This is the largest surface and the one with the most live-region traffic. Run it twice: once with
the reader's verbosity at its default, and once with live regions at their most verbose.

Set up: load `/play`, activate **"Open the table"**, wait for the connection, activate **"Take seat
1"**, then **"Deal the next hand"**.

| # | Checked by | Step (keys) | Assertion | Result |
|---|---|---|---|---|
| 3.1 | auto | Activate "Open the table" | The connection status is announced politely as it changes — "Preparing: reading your session…", then "Live. Everything on this screen is the server's own view of the table, redacted for you." | |
| 3.2 | auto | After each of "Open the table" / "Take seat 1" | The control that was activated has disappeared. The reading cursor is **not** dumped at the top of the document: the reader is placed on the status line and hears it. Silence plus a cursor at `<body>` is a FAIL. | |
| 3.3 | auto | Activate "Deal the next hand" | **"A new hand was dealt."** is announced politely, once, at the front of the forced bets that arrive with it — "A new hand was dealt. smallBlind 5 from seat 3, bigBlind 10 from seat 4." Hearing the deal on its own and then again in front of the blinds is a FAIL; so is hearing only the blinds. | |
| 3.4 | auto | Wait for the blinds and the bots | Each table event is announced politely and **in order**: the forced bets, then each seat's action in the server's own words ("The balanced bot bet 35 units on the flop"). Nothing interrupts. | |
| 3.5 | auto | **When the decision reaches your seat** | A single polite announcement of the form **"Your turn on the flop. 35 units to call. Pot 100 units, your stack 970 units. You can fold, call or raise."** It must contain: that it is your turn, the street, the price, the pot, your stack, and the legal actions. | |
| 3.6 | auto | Stay on your turn without acting for ten seconds | The turn sentence is announced **once**, not repeatedly. This app pushes whole-state frames several times a second; hearing the turn sentence more than once per turn is a FAIL. | |
| 3.7 | auto | Read your own seat plate (VO + Right / Down) | Your two cards announce by rank and suit in words — **"ace of spades"**, **"king of hearts"** — never as a letter and a symbol. | |
| 3.8 | auto | Read an opponent's seat plate | Their cards announce as **"face-down card"**. **If any rank or suit is announced for a card the server has not revealed, STOP the certification and file it as a hidden-information leak, not an accessibility defect.** | |
| 3.9 | auto | Read the board | The community cards announce as a group ("community cards: queen of hearts, seven of hearts and two of clubs") before the individual cards. | |
| 3.10 | auto | Read the pot | It announces with its label ("Pot, 100 units"), as a settled figure. Hearing a run of intermediate numbers counting up is a FAIL. | |
| 3.11 | auto | Wait for the Coach analysis to arrive | **"The analysis of this decision is ready in the Coach panel, below the table on a narrow screen."** is announced politely, and **carries no figure**. | |
| 3.12 | auto | Navigate into the Coach panel | Equity, the price, the outs and the stack context each announce as headings with their figures, and the assumptions block is reachable and is **not** collapsed away. | |
| 3.13 | auto | Tab to the bet sizer | The slider announces a name, its minimum, its maximum and its current value. The number field beside it announces its own label. | |
| 3.14 | auto | Tab to the action buttons | Each announces the action **and its cost** as a sentence — "fold, costs 0 units, gives up the hand and any claim on the pot"; "call 35 units"; "raise to 70 units, 70 units out of your stack". A button that announces a run-together string of the word and a number is a FAIL. | |
| 3.15 | auto | Activate **Fold** | **"You chose to fold."** is announced politely, once. | |
| 3.16 | auto | Immediately after 3.15 | The reading cursor is **not** dumped to the document. It lands on the acknowledgement ("Decision sent — Sent. The server is the only authority on a hand, so the controls stay disabled until it answers.") and that sentence is announced. | |
| 3.17 | auto | After the server answers | The next table event is announced **without** "You chose to fold." repeated in front of it. Hearing the echo stapled to every subsequent announcement is a FAIL. | |
| 3.18 | auto | Let the hand finish | **"The hand is complete."** followed by the result sentences, announced politely. | |
| 3.19 | auto | **Provoke a refusal**: act twice quickly, or act after the clock has run out | The refusal **interrupts** — "The server refused it", followed by the server's own wording — and it is the only thing on this screen that interrupts. A refusal that is announced politely, or not at all, is a FAIL. | |
| 3.20 | auto | **Provoke a failure**: stop the API, then reload `/play` and open the table | The error block **interrupts**: "Error — table unavailable", then the reason. At the same moment the polite status line must **not** be claiming the table is ready. | |
| 3.21 | auto | Narrow the window below 600px, Tab to "Show the analysis" | It announces as a button with its expanded state. Activating it announces the change of state. | |

### Journey 4 — Scenario Lab · `/lab` then `/lab/fl-same-cards-under-the-gun`

| # | Checked by | Step (keys) | Assertion | Result |
|---|---|---|---|---|
| 4.1 | auto | Load `/lab` | Title **"Scenario Lab — Poker Risk Lab"** announced. | |
| 4.2 | auto | Tab to the filters, change one, submit | The new count is announced. Submitting is a full document load, so it arrives in that document's TITLE — **"Scenario Lab — 12 of 36 scenarios — Poker Risk Lab"** — and not from the summary line, which arrives already holding its text and announces nothing. A filter that narrows the list to nothing must announce that, not leave it to be discovered by scrolling. | |
| 4.3 | auto | Open a scenario | The situation announces: the position, the stacks, the board and the price, each with a label. | |
| 4.4 | auto | Make a decision | The analysis reveal is announced politely: **"The analysis for &lt;scenario&gt; is now shown below your decision."** | |
| 4.5 | auto | Read the analysis | Every figure announces with its label and its unit. Every figure that has an interval announces the interval with it. No bare number. | |
| 4.6 | auto | Find the assumptions | They are reachable, they are not inside a collapsed region, and they announce as a list. | |

### Journey 5 — AI Legends · `/legends` then a profile

| # | Checked by | Step (keys) | Assertion | Result |
|---|---|---|---|---|
| 5.1 | auto | Load `/legends` | Title announced; one level-1 heading. | |
| 5.2 | auto | Rotor → Links | Every profile announces by name. | |
| 5.3 | auto | Open a profile | The trait bars announce as **values with labels** ("Aggression, 7 out of 10"), not as decorative graphics. A trait that announces as an unnamed image is a FAIL. | |
| 5.4 | auto | Find the radar chart | It has a text alternative that carries the same figures — a table or an equivalent readout — reachable by reading. A chart that announces as nothing but an image is a FAIL. | |
| 5.5 | auto | Read the disclaimers | The sentences about what the profile is and is not are reachable and are not hidden behind a control. | |

### Journey 6 — Hand review · `/review`, then a hand, or `/legends/hand-review/demo`

| # | Checked by | Step (keys) | Assertion | Result |
|---|---|---|---|---|
| 6.1 | auto | Load the replay | Title announced. The instruction sentence about the arrow keys is announced or reachable **before** the timeline. | |
| 6.2 | auto | Tab to the timeline, press Right Arrow | The new step is announced politely as one message: **"Step 3 of 9. flop: you raised to 70 units. An analysis is attached to this decision. Pot 100 units."** | |
| 6.3 | auto | Press Right Arrow repeatedly | Each step announces once. The reading cursor is not moved anywhere the reader did not ask to go. | |
| 6.4 | auto | Press End, then Home | The first and last steps are announced. | |
| 6.5 | auto | Tab to "Next decision" and press Enter until the last step | When the button disables itself at the end, the reading cursor moves to **"Previous decision"** and announces it. Being dumped to the document at the end of a hand is a FAIL. | |
| 6.6 | auto | Read a step's cards | Cards that were shown down announce by rank and suit. Cards that were never shown announce as **"face-down card"** — see 3.8, and the same rule about stopping applies. | |
| 6.7 | person | Read the commitment verifier | Its result announces as a sentence, and a verification failure announces as an alert. | |

### Journey 7 (cross-cutting) — the navigation sheet, at a narrow width

Resize to 390 x 844, or use a phone-sized window.

| # | Checked by | Step (keys) | Assertion | Result |
|---|---|---|---|---|
| 7.1 | auto | Tab to "Menu" and press Enter | The sheet announces as a **dialog** named "Menu", and the reading cursor is inside it, on **"Close menu"**. | |
| 7.2 | auto | Tab repeatedly | The cursor never leaves the sheet. Reaching content behind the sheet is a FAIL. | |
| 7.3 | auto | Shift + Tab repeatedly | The same, backwards. | |
| 7.4 | auto | Read past the end of the dialog with VO + Right / Down Arrow | Content behind the sheet is **not** reachable — every subtree that is not the sheet is `inert` while it is open, so there is nothing in the tree to walk to whether or not the reader honours `aria-modal`. | |
| 7.5 | auto | Press Escape | The sheet closes, and the reading cursor returns to the "Menu" button, which announces as collapsed. | |
| 7.6 | auto | Open the sheet, activate a destination | The sheet closes, the route change is announced (see G7), and the reader is not stranded on a removed node. | |

### Journey 8 (cross-cutting) — the failure paths

| # | Checked by | Step (keys) | Assertion | Result |
|---|---|---|---|---|
| 8.1 | auto | Visit a URL for a hand that does not exist | The refusal announces as a heading and a sentence, and offers a way out. | |
| 8.2 | auto | Stop the API and reload a data-backed page (`/learn`) | The page renders from its bundled copy and the notice saying so is **reachable and announced**, not a visual-only badge: strip every decorative glyph and a sentence saying the content is the bundled copy is still there, inside `main`, behind no disclosure, and in the accessibility tree. | |
| 8.3 | person | Force a root-layout failure (see the note below) | The fallback document announces as an **alert**: "The application could not be displayed", followed by the explanation. The page has a language, a heading, and two controls that announce their names. | |

> Provoking 8.3 is deliberately awkward, because the boundary exists for something that should never
> happen. The reliable way is to build with a temporary `throw new Error('certification')` at the top
> of `apps/web/src/app/layout.tsx`'s component body, run the certification step, and then revert it.
> Do not ship that build.

---

## 8. Running it

`pnpm run certify:screen-reader` walks a reviewer through the **2 `person` assertions** in this
document, in order, and writes the result to `accessibility-certification-result.json`. It states up
front how many of the 72 are machine-covered and where those checks live, so the number it asks you
for is never mistaken for the whole document.

It reads the assertions **out of this file** rather than carrying a copy, so editing a journey here
changes what the session asks — including the `Checked by` column, so re-marking a row moves it
between the two sets with no code change. `scripts/screen-reader-certify.test.mjs` asserts three
things about that:

- the parse finds all **72** rows, agreeing with the per-section counts in §9 below — a harness that
  quietly matched fewer would otherwise produce a complete-looking session covering part of the
  document, which is exactly what the first version of it did (10 of 73);
- the `auto`/`person` split per section agrees with §9's declared breakdown;
- the set of rows marked `auto` is **exactly** the set of assertion IDs `scripts/ax-assertions.mjs`
  carries a check for. Neither side can move alone. Delete a check and the document still claims the
  row is machine-covered, so it would fall out of the automated set *and* out of the human session at
  the same time, checked by nobody — that test is the control against precisely that.

```
pnpm run certify:screen-reader                 # start, or resume where you stopped
pnpm run certify:screen-reader -- --preflight  # check the environment, answer nothing
pnpm run certify:screen-reader -- --section J4 # one journey only (J4 has one `person` row)
pnpm run certify:screen-reader -- --all        # every row, machine-covered ones included
pnpm run certify:screen-reader -- --check      # is the recorded result current?
```

`--all` exists for one situation: a reviewer who does not trust the automated half and wants to hear
it for themselves. It is not the normal session, and a result recorded with it is a superset of one
that is not.

Three things it enforces that a paper form cannot:

- **It refuses to call an incomplete session a pass.** Every assertion answered, no `FAIL`, no
  `SILENT`, or the verdict is NOT CERTIFIED.
- **A `FAIL` or a `SILENT` must quote what was announced.** "It said the wrong thing" is not a
  defect report; the words are the entire subject matter here.
- **The result is stamped with the commit it was run against**, and `--check` calls it stale once
  `HEAD` moves. A screen reader speaks the build it was given and no other.

### On error -1743

Every release report this project has produced records this certification as UNVERIFIED, citing
`osascript` error **-1743**. That is accurate about what it says and misleading about what it
means: **-1743 refuses an AGENT permission to drive VoiceOver. It does not stop a person.** Pressing
Command + F5 and listening needs no Automation grant. The grant in §3 is needed only if you intend
to script the reader; a human certification does not.

What has actually been missing is somebody sitting down for half an hour. That is what this is for.

---

## 9. Results

**Build under test:** `_______________________` (git SHA)
**Date:** `____________`  **Reviewer:** `____________________`

**Automated gates before this run:** `test:a11y` ☐ PASS ☐ FAIL · `test:keyboard` ☐ PASS ☐ FAIL ·
`test:ax` ☐ PASS ☐ FAIL

| Platform | Reader | Browser | Version |
|---|---|---|---|
| macOS | VoiceOver | Safari | |
| Windows | NVDA | Chrome | |
| Windows | NVDA | Firefox | |

`auto` and `person` are the `Checked by` markers in sections 6 and 7. The PASS/FAIL/SILENT/N/A
columns are what **this** session recorded, and this session is asked only the `person` rows — so
they sum to the `person` column, not to `Assertions`.

| Section | Assertions | auto | person | PASS | FAIL | SILENT | N/A | Notes |
|---|---|---|---|---|---|---|---|---|
| Global (G1–G10) | 10 | 10 | 0 | | | | | |
| J1 Learn | 5 | 5 | 0 | | | | | |
| J2 Guided practice | 9 | 9 | 0 | | | | | |
| J3 Table and Coach | 21 | 21 | 0 | | | | | |
| J4 Scenario Lab | 6 | 6 | 0 | | | | | |
| J5 AI Legends | 5 | 5 | 0 | | | | | |
| J6 Hand review | 7 | 6 | 1 | | | | | |
| J7 Navigation sheet | 6 | 6 | 0 | | | | | |
| J8 Failure paths | 3 | 2 | 1 | | | | | |
| **Total** | **72** | **70** | **2** | | | | | |

**Automated coverage on this build:** `pnpm run test:ax` ☐ 70 of 70 assertion checks passed
☐ some failed — *list them, and do not start the session until they are green; a manual pass over a
build whose machine-checkable facts are broken is a certification of nothing.*

For every FAIL and every SILENT, record on a separate line: the assertion number, the platform, what
was actually announced (quoted from the speech viewer), and what should have been.

---

## 9. What decides PASS or FAIL

A certification is **PASS** only when all of the following hold:

1. **Zero FAIL and zero SILENT on the following assertions**, on every platform tested. These are
   the ones where the reader is actively misled or cannot proceed:
   - **G2** (skip link), **G7** (route change announced), **G8** (announced once)
   - **3.5** (the turn is announced), **3.8** (no hidden card is ever named), **3.15**, **3.16**
     (focus after acting), **3.19** (a refusal interrupts), **3.20** (a failure interrupts and the
     status line does not contradict it) — all of these are `auto`, so a red `test:ax` on any of
     them stops the session before it starts rather than being heard in it
   - **6.5** (focus at the end of a replay), **6.6** (no hidden card is ever named)
   - **7.1**, **7.2**, **7.3**, **7.5** (the modal is a modal, and it can be left)
   - **8.3** (the last-resort boundary announces itself)
2. **No more than three FAIL or SILENT results in total**, none of them on a journey's primary task,
   and each one recorded with a defect reference.
3. **Both platforms were tested.** A single-platform run is **PARTIAL**, never PASS.
4. **The three automated gates were green on the same build.**

Any of the following is an immediate **FAIL**, regardless of the rest:

- Any rank or suit announced for a card the server did not reveal (**3.8**, **6.6**). This is a
  hidden-information leak. Stop and file it as such.
- Any journey that cannot be **completed** by ear.
- A live region that interrupts on every table update, or a turn announcement repeated more than
  once per turn (**3.6**). Over-announcement makes a reader turn the region off, which loses the
  announcements that matter — it is a defect, not a nicety.
- The route title announced twice (**G8**).

Anything else is recorded, referenced and scheduled. Record the verdict as **PASS**, **PARTIAL** or
**FAIL** and sign it.

---

## 10. Status on the machine this document was written on: BLOCKED / UNVERIFIED

This procedure **has not been executed** against the final candidate SHA recorded in the final
readiness report. It could not be, and the reasons are specific rather
than a matter of time. Recorded here in full so that nobody mistakes the existence of this document
for its result.

**Candidate SHA:** `b292b2ac234cb586f253ad42ec0ef4d949fa332b`. The application evidence and its
provenance are listed in the final readiness report; this manual certification remains unexecuted.
**Capture:** `/var/folders/7s/l9fr0tyd4wn9vp8qhg9yv7g80000gn/T/grok-goal-843cf6607006/implementer/screen-reader-blocked.log` recaptured on this SHA (`osascript` System Events **-1743**).
**Re-confirmed** at UTC 2026-08-24 on the same host, during the work that closed the alerting and
secret-scanning gaps: `osascript -e 'tell application "System Events" to return name of first
process'` still answers `execution error: Not authorised to send Apple events to System Events.
(-1743)`. Nothing about this blocker has changed, and nothing in this repository can change it.
**Host:** macOS 26.5.2 (build 25F84), Darwin, Apple silicon. Safari and VoiceOver.app are both
present (`/System/Library/CoreServices/VoiceOver.app`). Google Chrome 151 is installed and is what
`pnpm run test:ax` and `pnpm run test:keyboard` drive.

| Blocker | Evidence | Consequence |
|---|---|---|
| **Screen Recording is denied** to the executing process | Capture attempts fail with `could not create image from display` | No visual or audio-visual evidence of a session can be produced, so a claimed run could not be evidenced even if it happened |
| **Apple Events are refused to System Events** | `osascript -e 'tell application "System Events" to get UI elements enabled'` returns **error -1743** (`Not authorised to send Apple events to System Events`) | The UI cannot be driven or inspected programmatically |
| **VoiceOver cannot be enabled or driven** | VoiceOver.app is present; `tell application "VoiceOver" to get version` returned `10` without driving the reader; System Events remains `-1743` | VoiceOver cannot be started, configured, or read from by this agent — including its announcement history, which is the only machine-readable record of what was said |
| **The permissions database cannot be edited** | `csrutil status` reports **System Integrity Protection: enabled**; `TCC.db` is SIP-protected | The refusals above cannot be cleared from inside this environment, and must not be: forged grants would make any result worthless |
| **No Windows reader is present** | `command -v nvda` → not found; `command -v orca` → not found | The NVDA half of section 2.2 cannot be attempted at all. Orca is absent too, so there is no Linux substitute |

There is also a plainer reason, and it outranks all of the above: **this environment has nobody
listening.** Even with every permission granted, the assertions in section 7 are about what a person
hears. An automated harness that read VoiceOver's announcement history would establish that a string
was emitted — which is very close to what `pnpm run test:ax` already establishes about the tree it
was emitted from, and still not the same claim as "a person could use this".

### What IS established on this machine, and should be quoted instead

Do not let the blockage above be read as "accessibility unknown". These were run here and their
results are real:

- `pnpm run test:ax` on this SHA — 46 passed, 0 failed (`verify.log`, `VERIFY_EXIT=0`). The gate now
  starts an API (`--with-api`) so `/lab/fl-same-cards-under-the-gun` is not audited as an error page.
- **The `auto` assertions of this document, on this application, in Chrome 151 — all passed, 0
  failed.** They are the second half of that same gate run: 45 of them at the candidate SHA above,
  **65** since the gate grew a live table, a replayed hand and a web app with no API behind it,
  **68** since 2.4, 2.9 and 3.19 moved on 2026-08-26, and **70** since 4.2 and 7.4 were fixed in the
  product on the same day (section 5). Writing them has now found six real defects that had been
  sitting in sections 6 and 7 as untested claims:
    - G3 asserts a `contentinfo` landmark named "About Poker Risk Lab", and the footer's
      visually-hidden `h2` did not name it — a heading INSIDE a landmark does not name the landmark,
      and the computed name was the empty string. Fixed with `aria-labelledby` in
      `apps/web/src/components/SiteFooter.tsx`.
    - 3.2 asserts that a reader who presses "Open the table" or "Take seat 1" is placed on the status
      line **and hears it**. Focus did land there, and the computed name of that `role="status"` was
      the empty string: a `status` takes no name from its own contents, so the caret arrived at a
      node the tree describes as an unnamed status. Fixed with an `aria-label` in
      `apps/web/src/app/play/LiveTable.tsx`, the same treatment `ActionBar`'s in-flight line and
      `TableStage`'s acknowledgement already carry for the same reason.
    - The table's polite narration region was **not in the document when a hand was dealt**. It was
      owned by `PokerTable`, which is not rendered until a view arrives, so on the first hand of
      every session the region was created already holding its first sentence — and a live region
      that arrives with its text announces nothing. It is now mounted unconditionally by
      `TableStage`. This is the first half of 3.3.
    - **"A new hand was dealt." was never announced.** `handStarted` and `forcedBets` are two events
      of one table notice, and two writes into one atomic polite region for one notice are one
      announcement — the second one. The deal is now carried onto the front of the blinds sentence
      and written once (`onEventFrame` in `apps/web/src/lib/use-live-table.ts`). This is the second
      half of 3.3, and it had been filed in this document as a question for a reviewer rather than
      as the defect it was.

  All four are exactly the kind of thing a manual procedure nobody has run cannot catch. The last
  two are worse than that: they had been *written down here* as a limit of the certification.
- `pnpm run test:keyboard` against `http://127.0.0.1:3458` with API on `:3001` (the baked rewrite) —
  142 passed, `KEYBOARD_EXIT=0`. One N/A: `/play` before sitting has no decision row (the seated
  journey is the private-table path). Capture: `implementer/keyboard.log` in the goal scratch dir.
- `pnpm run test:a11y` — static rules over delivered HTML, PASS in `verify.log`.
- `pnpm run test:csp` — 11/0 PASS; the browser refused every injection.
- `apps/web/test/a11y-contracts.test.ts`, `apps/web/test/live-regions.test.ts` and
  `apps/web/test/route-announcer.test.ts` — the source-level contracts, each with a negative control.

The honest summary is: **the accessibility tree is checked, the keyboard is checked, a real hand is
now played, replayed and refused on every run, 70 of this document's own 72 assertions are checked,
and no screen reader has ever been pointed at this application.** The 2 `person` rows are what
changes that, and both need a person with headphones. Nothing about the 70 reduces that requirement
— it reduces how long it takes and stops the other 70 rotting in the meantime. Two of the four rows
that used to sit here were never certification limits at all: 4.2 and 7.4 were product defects with
a checklist item wrapped round them, they were re-measured and confirmed, they were fixed in the
application, and they moved only once a check had been shown to fail against the old build
(section 5).

---

## 11. Maintaining this document

Every quoted announcement in section 7 is a string the app actually ships. When one of them changes,
this document is stale and a reviewer will record a FAIL against wording that is now correct. The
strings live in:

| Announcement | Where |
|---|---|
| Route title | `apps/web/src/components/RouteAnnouncer.tsx` (it announces `document.title`) |
| Turn, decision echo, Coach arrival, Coach failure | `apps/web/src/lib/use-live-table.ts` |
| Table events (dealt, street, showdown, hand complete) | `announce()` in the same file |
| Connection status | `statusSentence()` in `apps/web/src/app/play/LiveTable.tsx` |
| Refusal and error headings | `apps/web/src/components/TableStage.tsx` |
| Quiz verdicts and the recording sentence | `apps/web/src/components/QuizRunner.tsx`, `apps/web/src/lib/quiz-attempts.ts` |
| Replay step | `apps/web/src/components/HandReplay.tsx` |
| Scenario reveal and filter count | `apps/web/src/components/ScenarioStage.tsx`, `ScenarioFilters.tsx` |
| Card names | `packages/ui/src/cards.ts` and `PlayingCard.tsx` |

`pnpm run test:ax` fails if the structure changes underneath these; it does not fail if the wording
does, with the exceptions below — the strings the `auto` checks quote literally or match a shape of,
which are now pinned by a gate. Change one and `pnpm run verify` fails with the assertion ID on it.

| Pinned string | Held by |
|---|---|
| `Poker Risk Lab — a decision laboratory for poker` and `Learn — Poker Risk Lab` | G1, 1.1 |
| `Scenario Lab — Poker Risk Lab` | 4.1 |
| `The analysis for <scenario> is now shown below your decision.` | 4.4 |
| `Preparing: reading your session…` and `Live. Everything on this screen is…` | 3.1 |
| `Your turn <street>. <price>. Pot N units, your stack N units. You can …` — its shape, not its words | 3.5 |
| `The analysis of this decision is ready in the Coach panel…` | 3.11 |
| `A new hand was dealt.` — and that the forced bets are in the same write | 3.3 |
| `You chose to fold.` | 3.17 |
| `The hand is complete.` plus at least one result sentence | 3.18 |
| `Error — table unavailable` | 3.20 |
| `The server refused it` plus the server's own `… (code). Nothing was applied.` | 3.19 |
| `Choose one answer` — the answer group's name, and that it is not the prompt | 2.4 |
| `Step N of M. …  Pot N units.` — the replay step's shape | 6.2, 6.3, 6.4 |
| `bundled copy` / `content service is not reachable` — the fallback notice, once its glyphs are stripped | 8.2 |

The live-table and replay rows also depend on three things that are not strings: the class names
`SPEECH_PROBE` keys its regions by (`prl-play__connection-lines`, `prl-play__table >
prl-live-region`, `prl-play__decision > prl-live-region`), the API allowing the audit's own origin
(`PUBLIC_WEB_ORIGIN`, which `scripts/ax-tree-audit.mjs` sets on the API it starts), and — for 8.2 —
a second web app the audit starts for itself on `PRL_WEB_OFFLINE_ORIGIN` with its API origin pointed
at `127.0.0.1:1`. A renamed class fails the check that reads it rather than passing quietly, because
every one of them refuses an empty set of writes.

The table's narration region moved from `PokerTable` to `TableStage` when 3.3 was fixed, which is
why its key is `prl-play__table` and not `prl-table`. Moving it back would put a live region inside
a component that is not always rendered, and the sentence would stop being announced on the first
hand of a session — see section 5.

Re-read this section against the source before each certification run.

### Adding, removing or re-marking an assertion

The `Checked by` column is the only thing that decides which set a row is in, and two tests hold it
honest:

1. Add a row and update §9's counts, or `scripts/screen-reader-certify.test.mjs` fails on the
   per-section totals.
2. Mark a row `auto` and add a check with that `id` to `ASSERTION_ROUTES` in
   `scripts/ax-assertions.mjs`, or the same test fails on the bidirectional mapping. Mark it
   `person` and *remove* the check, or it fails the other way.

The failure that mapping exists to prevent is silent: a check deleted while the document still says
`auto` takes the row out of the automated set and out of the human session at once, and the result
is a row that reads as covered twice and is covered by nobody.

If you are unsure which marker a new row deserves, mark it `person`. That costs a reviewer a minute;
the other mistake costs a defect nobody is looking for.

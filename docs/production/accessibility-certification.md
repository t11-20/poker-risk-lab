# Screen-reader certification procedure

**Status on the machine this was written on: BLOCKED — UNVERIFIED.** Section 10 records exactly
why, with the errors. Nothing in this repository has ever heard this application read aloud, and no
gate in it can. This document is the procedure that would settle that, written so that a person who
has never seen this app can execute it on another machine and produce a defensible verdict.

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
| `pnpm run test:ax` | The **computed accessibility tree** — role, computed name, live-region politeness, heading outline, landmark uniqueness, that no hidden card names a rank or suit, and that a real interaction changes an announcement region and leaves focus on a named node | Whether any assistive technology **speaks** it, in what order, at what verbosity, or comprehensibly |

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
one a machine could have caught:

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

---

## 6. Global assertions (check once per platform, on any page)

| # | Assertion | Result |
|---|---|---|
| G1 | On loading `/`, the reader announces the document title **"Poker Risk Lab — a decision laboratory for poker"**. | |
| G2 | The **first** Tab stop announces **"Skip to main content, link"**. Pressing Enter on it moves the reading cursor into the main content — the next VO + Right / Down Arrow reads content, not the header. | |
| G3 | The landmark rotor lists exactly: one **banner** ("Site"), one **main**, one **contentinfo** ("About Poker Risk Lab"), and navigation landmarks that are **differently named** ("Primary", "Sections", and at narrow widths "All sections"). No two landmarks of the same role share a name. | |
| G4 | The heading rotor shows exactly **one level-1 heading** on the page, and no level is skipped going down the list. | |
| G5 | Every control the reader lands on announces a name and a role. Nothing is announced as a bare "button", "link" or "image". | |
| G6 | The theme control announces as a radio group with three options (Auto, Light, Dark), the current one announced as selected. | |

### Route announcement (the assertion most likely to fail, and the one most likely to be misread)

| # | Assertion | Result |
|---|---|---|
| G7 | From `/`, activate the "Learn" link in the primary navigation. Within about a second the reader announces **"Learn — Poker Risk Lab"** — politely, i.e. it waits for whatever was being read to finish rather than cutting it off. | |
| G8 | The title is announced **exactly once**. Hearing it twice is a FAIL: it means the framework's own announcer is still present alongside the app's. | |
| G9 | On the **initial** page load (a full document load, not a link), the title is announced by the browser/reader as usual and **not** a second time by the app. | |
| G10 | Focus does **not** move on navigation. After activating a link the reading cursor is where the reader left it, not forced to the top or to the new heading. This is deliberate; a reader who is moved is a FAIL. | |

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

| # | Step (keys) | Assertion | Result |
|---|---|---|---|
| 1.1 | Load `/learn` | The title **"Learn — Poker Risk Lab"** is announced. | |
| 1.2 | VO + Command + H (or `H`) to the first heading | A single level-1 heading naming the curriculum is announced, with its level. | |
| 1.3 | Continue by heading | Each topic group announces as a heading at level 2 or 3, in an order that never skips a level. | |
| 1.4 | Rotor → Links (or `K`) | Every lesson link announces the lesson's title. No link announces as a bare number, a glyph, or "link". | |
| 1.5 | Tab to a lesson's disclosure and press Enter | The expanded state is announced ("expanded" / "collapsed"), and the revealed content is reachable by continuing to read. | |
| 1.6 | Read the figures at the top (VO + Right / Down) | Each figure announces a **label and a value together** ("Lessons, 17"), never a bare number. | |

### Journey 2 — Guided practice (a lesson and its quiz) · `/learn/pot-odds`

| # | Step (keys) | Assertion | Result |
|---|---|---|---|
| 2.1 | Load `/learn/pot-odds` | Title **"Pot odds — Poker Risk Lab"** (or the lesson's own title) is announced. | |
| 2.2 | Read to the quiz | The quiz panel announces as a heading, and the question prompt as a level-3 heading. | |
| 2.3 | Read the question's position | The heading announces **"Question 1 of 5"** before the prompt. | |
| 2.4 | Tab into the answer group | The group announces its purpose ("Choose one answer") and each option announces its own text. The prompt is **not** read twice. | |
| 2.5 | Select an option (Arrow keys, then Space if needed) | Within a moment, politely and without interrupting: **"That matches the answer this lesson gives…"** or **"That is not the answer this lesson gives…"**, followed by the sentence about what was recorded. | |
| 2.6 | 2.5 again, on a **numeric** question: type letters into the answer field | The field announces itself as **invalid**, and the correction — "That is not a number this question can be checked against…" — is announced **with the field**, before the tolerance hint. | |
| 2.7 | Clear the field and type a number, then activate "Check against the computed figure" | The comparison is announced politely as one message ("… is within the tolerance of …"), including the sentence about whether anything was recorded. Hearing the recording sentence *without* the verdict in front of it is a FAIL. | |
| 2.8 | Activate "Next question" | The reading cursor moves to the new question's heading and announces **"Question 2 of 5"** followed by the new prompt. Being moved to a heading that announces only the prompt is a FAIL — the reader cannot tell whether they advanced. | |
| 2.9 | Reach the end of the quiz | The review panel announces, and **no score, tally or mark out of five is announced anywhere**. Hearing one is a FAIL against the product's own guarantee. | |

### Journey 3 — Poker table and Coach · `/play`

This is the largest surface and the one with the most live-region traffic. Run it twice: once with
the reader's verbosity at its default, and once with live regions at their most verbose.

Set up: load `/play`, activate **"Open the table"**, wait for the connection, activate **"Take seat
1"**, then **"Deal the next hand"**.

| # | Step (keys) | Assertion | Result |
|---|---|---|---|
| 3.1 | Activate "Open the table" | The connection status is announced politely as it changes — "Preparing: reading your session…", then "Live. Everything on this screen is the server's own view of the table, redacted for you." | |
| 3.2 | After each of "Open the table" / "Take seat 1" | The control that was activated has disappeared. The reading cursor is **not** dumped at the top of the document: the reader is placed on the status line and hears it. Silence plus a cursor at `<body>` is a FAIL. | |
| 3.3 | Activate "Deal the next hand" | **"A new hand was dealt."** is announced politely. | |
| 3.4 | Wait for the blinds and the bots | Each table event is announced politely and **in order**: the forced bets, then each seat's action in the server's own words ("The balanced bot bet 35 units on the flop"). Nothing interrupts. | |
| 3.5 | **When the decision reaches your seat** | A single polite announcement of the form **"Your turn on the flop. 35 units to call. Pot 100 units, your stack 970 units. You can fold, call or raise."** It must contain: that it is your turn, the street, the price, the pot, your stack, and the legal actions. | |
| 3.6 | Stay on your turn without acting for ten seconds | The turn sentence is announced **once**, not repeatedly. This app pushes whole-state frames several times a second; hearing the turn sentence more than once per turn is a FAIL. | |
| 3.7 | Read your own seat plate (VO + Right / Down) | Your two cards announce by rank and suit in words — **"ace of spades"**, **"king of hearts"** — never as a letter and a symbol. | |
| 3.8 | Read an opponent's seat plate | Their cards announce as **"face-down card"**. **If any rank or suit is announced for a card the server has not revealed, STOP the certification and file it as a hidden-information leak, not an accessibility defect.** | |
| 3.9 | Read the board | The community cards announce as a group ("community cards: queen of hearts, seven of hearts and two of clubs") before the individual cards. | |
| 3.10 | Read the pot | It announces with its label ("Pot, 100 units"), as a settled figure. Hearing a run of intermediate numbers counting up is a FAIL. | |
| 3.11 | Wait for the Coach analysis to arrive | **"The analysis of this decision is ready in the Coach panel, below the table on a narrow screen."** is announced politely, and **carries no figure**. | |
| 3.12 | Navigate into the Coach panel | Equity, the price, the outs and the stack context each announce as headings with their figures, and the assumptions block is reachable and is **not** collapsed away. | |
| 3.13 | Tab to the bet sizer | The slider announces a name, its minimum, its maximum and its current value. The number field beside it announces its own label. | |
| 3.14 | Tab to the action buttons | Each announces the action **and its cost** as a sentence — "fold, costs 0 units, gives up the hand and any claim on the pot"; "call 35 units"; "raise to 70 units, 70 units out of your stack". A button that announces a run-together string of the word and a number is a FAIL. | |
| 3.15 | Activate **Fold** | **"You chose to fold."** is announced politely, once. | |
| 3.16 | Immediately after 3.15 | The reading cursor is **not** dumped to the document. It lands on the acknowledgement ("Decision sent — Sent. The server is the only authority on a hand, so the controls stay disabled until it answers.") and that sentence is announced. | |
| 3.17 | After the server answers | The next table event is announced **without** "You chose to fold." repeated in front of it. Hearing the echo stapled to every subsequent announcement is a FAIL. | |
| 3.18 | Let the hand finish | **"The hand is complete."** followed by the result sentences, announced politely. | |
| 3.19 | **Provoke a refusal**: act twice quickly, or act after the clock has run out | The refusal **interrupts** — "The server refused it", followed by the server's own wording — and it is the only thing on this screen that interrupts. A refusal that is announced politely, or not at all, is a FAIL. | |
| 3.20 | **Provoke a failure**: stop the API, then reload `/play` and open the table | The error block **interrupts**: "Error — table unavailable", then the reason. At the same moment the polite status line must **not** be claiming the table is ready. | |
| 3.21 | Narrow the window below 600px, Tab to "Show the analysis" | It announces as a button with its expanded state. Activating it announces the change of state. | |

### Journey 4 — Scenario Lab · `/lab` then `/lab/preflop-open-cutoff`

| # | Step (keys) | Assertion | Result |
|---|---|---|---|
| 4.1 | Load `/lab` | Title **"Scenario Lab — Poker Risk Lab"** announced. | |
| 4.2 | Tab to the filters, change one, submit | The count is announced politely: **"Showing 12 of 36 scenarios."** A filter that narrows the list to nothing must announce that, not leave it to be discovered by scrolling. | |
| 4.3 | Open a scenario | The situation announces: the position, the stacks, the board and the price, each with a label. | |
| 4.4 | Make a decision | The analysis reveal is announced politely: **"The analysis for &lt;scenario&gt; is now shown below your decision."** | |
| 4.5 | Read the analysis | Every figure announces with its label and its unit. Every figure that has an interval announces the interval with it. No bare number. | |
| 4.6 | Find the assumptions | They are reachable, they are not inside a collapsed region, and they announce as a list. | |

### Journey 5 — AI Legends · `/legends` then a profile

| # | Step (keys) | Assertion | Result |
|---|---|---|---|
| 5.1 | Load `/legends` | Title announced; one level-1 heading. | |
| 5.2 | Rotor → Links | Every profile announces by name. | |
| 5.3 | Open a profile | The trait bars announce as **values with labels** ("Aggression, 7 out of 10"), not as decorative graphics. A trait that announces as an unnamed image is a FAIL. | |
| 5.4 | Find the radar chart | It has a text alternative that carries the same figures — a table or an equivalent readout — reachable by reading. A chart that announces as nothing but an image is a FAIL. | |
| 5.5 | Read the disclaimers | The sentences about what the profile is and is not are reachable and are not hidden behind a control. | |

### Journey 6 — Hand review · `/review`, then a hand, or `/legends/hand-review/demo`

| # | Step (keys) | Assertion | Result |
|---|---|---|---|
| 6.1 | Load the replay | Title announced. The instruction sentence about the arrow keys is announced or reachable **before** the timeline. | |
| 6.2 | Tab to the timeline, press Right Arrow | The new step is announced politely as one message: **"Step 3 of 9. flop: you raised to 70 units. An analysis is attached to this decision. Pot 100 units."** | |
| 6.3 | Press Right Arrow repeatedly | Each step announces once. The reading cursor is not moved anywhere the reader did not ask to go. | |
| 6.4 | Press End, then Home | The first and last steps are announced. | |
| 6.5 | Tab to "Next decision" and press Enter until the last step | When the button disables itself at the end, the reading cursor moves to **"Previous decision"** and announces it. Being dumped to the document at the end of a hand is a FAIL. | |
| 6.6 | Read a step's cards | Cards that were shown down announce by rank and suit. Cards that were never shown announce as **"face-down card"** — see 3.8, and the same rule about stopping applies. | |
| 6.7 | Read the commitment verifier | Its result announces as a sentence, and a verification failure announces as an alert. | |

### Journey 7 (cross-cutting) — the navigation sheet, at a narrow width

Resize to 390 x 844, or use a phone-sized window.

| # | Step (keys) | Assertion | Result |
|---|---|---|---|
| 7.1 | Tab to "Menu" and press Enter | The sheet announces as a **dialog** named "Menu", and the reading cursor is inside it, on **"Close menu"**. | |
| 7.2 | Tab repeatedly | The cursor never leaves the sheet. Reaching content behind the sheet is a FAIL. | |
| 7.3 | Shift + Tab repeatedly | The same, backwards. | |
| 7.4 | Read past the end of the dialog with VO + Right / Down Arrow | Content behind the sheet is **not** reachable. | |
| 7.5 | Press Escape | The sheet closes, and the reading cursor returns to the "Menu" button, which announces as collapsed. | |
| 7.6 | Open the sheet, activate a destination | The sheet closes, the route change is announced (see G7), and the reader is not stranded on a removed node. | |

### Journey 8 (cross-cutting) — the failure paths

| # | Step (keys) | Assertion | Result |
|---|---|---|---|
| 8.1 | Visit a URL for a hand that does not exist | The refusal announces as a heading and a sentence, and offers a way out. | |
| 8.2 | Stop the API and reload a data-backed page | The page renders from its bundled copy and the notice saying so is **reachable and announced**, not a visual-only badge. | |
| 8.3 | Force a root-layout failure (see the note below) | The fallback document announces as an **alert**: "The application could not be displayed", followed by the explanation. The page has a language, a heading, and two controls that announce their names. | |

> Provoking 8.3 is deliberately awkward, because the boundary exists for something that should never
> happen. The reliable way is to build with a temporary `throw new Error('certification')` at the top
> of `apps/web/src/app/layout.tsx`'s component body, run the certification step, and then revert it.
> Do not ship that build.

---

## 8. Results

**Build under test:** `_______________________` (git SHA)
**Date:** `____________`  **Reviewer:** `____________________`

**Automated gates before this run:** `test:a11y` ☐ PASS ☐ FAIL · `test:keyboard` ☐ PASS ☐ FAIL ·
`test:ax` ☐ PASS ☐ FAIL

| Platform | Reader | Browser | Version |
|---|---|---|---|
| macOS | VoiceOver | Safari | |
| Windows | NVDA | Chrome | |
| Windows | NVDA | Firefox | |

| Section | Assertions | PASS | FAIL | SILENT | N/A | Notes |
|---|---|---|---|---|---|---|
| Global (G1–G10) | 10 | | | | | |
| J1 Learn | 6 | | | | | |
| J2 Guided practice | 9 | | | | | |
| J3 Table and Coach | 21 | | | | | |
| J4 Scenario Lab | 6 | | | | | |
| J5 AI Legends | 5 | | | | | |
| J6 Hand review | 7 | | | | | |
| J7 Navigation sheet | 6 | | | | | |
| J8 Failure paths | 3 | | | | | |
| **Total** | **73** | | | | | |

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
     status line does not contradict it)
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

This procedure **has not been executed**. It could not be, and the reasons are specific rather than
a matter of time. Recorded here in full so that nobody mistakes the existence of this document for
its result.

**Host:** macOS 26.5.2 (build 25F84), Apple silicon. Safari 26.5.2 and VoiceOver.app are both
present at the expected paths. Google Chrome 151.0.7922.170 is installed and is what
`pnpm run test:ax` and `pnpm run test:keyboard` drive.

| Blocker | Evidence | Consequence |
|---|---|---|
| **Screen Recording is denied** to the executing process | Capture attempts fail with `could not create image from display` | No visual or audio-visual evidence of a session can be produced, so a claimed run could not be evidenced even if it happened |
| **Apple Events are refused to System Events** | `osascript` returns **error -1743** (`Not authorized to send Apple events`) | The UI cannot be driven or inspected programmatically |
| **Apple Events are refused to VoiceOver** | `osascript` returns **error -1743** for the VoiceOver target as well | VoiceOver cannot be started, configured, or read from by script — including its announcement history, which is the only machine-readable record of what was said |
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

- `pnpm run test:ax` — the computed accessibility tree, walked in Chrome 151, per journey: computed
  names on interactive nodes, one h1 and no skipped levels, uniquely named landmarks, live-region
  politeness, no rank or suit in any face-down card's computed name or markup, and a real
  interaction that changes an announcement region and leaves focus on a named node.
- `pnpm run test:keyboard` — every journey driven by real key events in real Chrome.
- `pnpm run test:a11y` — the static rules over delivered HTML.
- `apps/web/test/a11y-contracts.test.ts`, `apps/web/test/live-regions.test.ts` and
  `apps/web/test/route-announcer.test.ts` — the source-level contracts, each with a negative control.

The honest summary is: **the accessibility tree is checked, the keyboard is checked, and no screen
reader has ever been pointed at this application.** Section 7 is what changes that, and it needs a
machine with the permissions in section 3 and a person with headphones.

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
does. Re-read this section against the source before each certification run.

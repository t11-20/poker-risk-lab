#!/usr/bin/env node
/**
 * The half of `docs/production/accessibility-certification.md` that a machine can actually decide,
 * one check per assertion ID, run against the rendered accessibility tree in real Chrome.
 *
 * This module is the check registry. `scripts/ax-tree-audit.mjs` owns the browser, the servers and
 * the reporting, and drives this; `pnpm run test:ax` is the gate both live behind. This is a private
 * module of that one gate, not a library two gates share — the warning in `ax-tree-audit.mjs` about
 * a gate that can be broken from a distance is about sharing across gates, and there is no second
 * consumer here.
 *
 * ## The failure this exists to end
 *
 * The certification document holds 72 manual assertions and every release report this project has
 * produced records the same verdict for all of them: UNVERIFIED, because nobody has sat down with a
 * screen reader. That is true and it is also the wrong shape of true. A large share of those 72 are
 * not really about speech at all — they are about an accessible name, a role, an ARIA state, a
 * live region's politeness, where focus lands, whether a heading outline skips a level. Those are
 * facts about the rendered accessibility tree. Leaving them in a manual session that has never been
 * run means a regression in ANY of them — a removed `aria-label`, a live region flipped to
 * assertive, a control that drops focus on the floor when it disables itself — ships silently and
 * waits for a human session that never comes.
 *
 * So the 72 are split. The 70 whose whole subject is a DOM/ARIA fact are checked here, on every
 * run, and a regression fails `pnpm run verify`. The 2 that are left stay with the person, and
 * `pnpm run certify:screen-reader` now presents only those: two states no honest fixture reaches
 * (6.7 and 8.3).
 *
 * ## Three of them were answerable, and the reason each had been left was wrong
 *
 * Added 2026-08-26, each with the measurement that moved it:
 *
 *   - **2.4** was `person` for "the prompt is **not** read twice", which reads as a fact about the
 *     utterance and is a fact about the tree. A reader announces a group's name on entering it, so
 *     the prompt is heard a second time if and only if it appears in a second accessible name —
 *     the group's, or an option's. `QuizRunner` already says this where its legend is written; the
 *     check asserts it. Measured: group name "Choose one answer", four options each named by its
 *     own text, the prompt in exactly one accessible name.
 *   - **2.9** was `person` because "no score is announced anywhere" is unbounded over WORDINGS. It
 *     is bounded over CAUSES: a score is a function of what the learner got right. `gatherQuizReview`
 *     walks the quiz to its review panel twice from a fresh load, answering the first question with
 *     the lesson's own answer once and with another option once, and requires the two ends to read
 *     identically. Nothing that depends on correctness can survive that, in any wording.
 *   - **3.19** was `person` because provoking a server refusal was said to need "a second actor
 *     racing the same seat". It needs one task. `disabled` comes from React state and is applied on
 *     the next render, so two `click()`s inside one task both reach `act`, each minting its own
 *     `actionId`, and both frames leave over one socket in order. Measured against the running
 *     server: the second click saw `disabled === false` and the server answered "It is not your
 *     turn to act. (not_your_turn). Nothing was applied." — assertively, and the only interruption
 *     in the whole hand.
 *
 * ## Four more were not certification limits at all, but DEFECTS filed as one
 *
 * 3.3 said "A new hand was dealt." never reaches the DOM and asked a reviewer to decide whether
 * hearing the blinds instead was a PASS. That is a bug with a checklist item wrapped round it, and
 * a check that had existed would have found it: the table's narration region was not in the
 * document when a hand was dealt, and the deal sentence was destroyed by the forced bets of the
 * same table notice. Both are fixed in the application, and J3.3 below is what keeps them fixed.
 * 8.2 said the bundled-copy path needs the API down for a process this gate shares with everything
 * else — true, and the conclusion does not follow: the gate now runs a second web app that has no
 * API behind it. Neither row was ever about speech.
 *
 * **4.2 and 7.4 joined them on 2026-08-26, and the certification had already written down why.** It
 * said of 4.2 that a machine could answer it, that the answer was that nothing announced the filter
 * count, and that closing it was a product change rather than a certification one. It said of 7.4
 * that making the background `inert` "would then make the row `auto` by construction". Both product
 * changes were made, both measurements were re-taken first and both held:
 *
 *   - **4.2.** A GET submit on `/lab` replaces the document, so there is no surviving context to
 *     write into a live region — measured, the `window` marker was gone, `document.title` was
 *     byte-identical, and the summary region took zero mutations because it arrived already holding
 *     its sentence. A filtered view now carries the count in its title, which is the one thing a new
 *     document announces without JavaScript. J4.2 below checks that the submit is still a document
 *     load (a client-side query change would announce nothing at all), and reads the count off the
 *     page's own summary rather than recomputing it.
 *   - **7.4.** Measured: 29 of 34 content-bearing elements behind the open sheet were still
 *     non-ignored nodes. `MobileNav` now marks every subtree that is not the sheet `inert` while it
 *     is open. J7.4 below is a negative over the whole background, with a floor under the sweep, and
 *     it holds the sheet's un-inertable ancestors and its one deliberate exemption to their own
 *     stricter terms.
 *
 * ## "Needs a live table" was a statement about this gate, not about speech
 *
 * Nineteen of those 70 were with the person until this module grew three fixtures, and every one of
 * them was refused for a fixture reason rather than an un-automatable one:
 *
 *   - **A live table over a real socket** (`gatherLiveTable`). `/play?state=decision` renders the
 *     table's component tree without a server, so the connection never changes state, no blind is
 *     ever posted, the turn is never yours and no hand ever completes. The fixture opens a guest
 *     session, creates a private room with five bots, deals, folds when the decision arrives, and
 *     lets the hand finish — through the screens, with real key presses.
 *   - **A hand this run played, replayed** (`gatherReplay`). The scrubbable replay is at
 *     `/review/<handId>` and needs a hand in a database; the demo route renders a different
 *     component with no face-down card and no timeline in it. The fixture reads back the hand the
 *     live table just played, as the reader's own history.
 *
 *   - **A web app with no API behind it** (`gatherBundledCopy`). The bundled-copy path is taken by
 *     the WEB SERVER's own fetch, so blocking `/api/*` in the browser — which is how 3.20 is
 *     driven — leaves the server render untouched and the page still arrives with live data in it.
 *     `ax-tree-audit.mjs` starts a second `next start` off the same build with `PRL_API_ORIGIN`
 *     pointed at a port nothing can be listening on, and one route visits it.
 *
 * What is still refused is refused on its merits, and section 5 of the certification document lists
 * both with one line each: 6.7 needs a server that lies about a deal, and 8.3 needs a build with a
 * deliberate `throw` in the root layout.
 *
 * ## What this does NOT claim
 *
 * A check here does not certify its assertion. It establishes that the fact the assertion rests on
 * is still true. That is exactly the difference between `test:ax` and a certification, stated at
 * length in `ax-tree-audit.mjs`'s header and in section 1 of the certification document, and it is
 * not softened by there being more checks. What the split buys is that a REGRESSION now fails a
 * gate instead of waiting for a manual session, and that the manual session is a half-hour rather
 * than an afternoon.
 *
 * The split is conservative on purpose. Where an assertion mixes a checkable fact with a claim
 * about speech, the whole row stays with the person unless the speech half follows from a
 * structural property the check actually asserts — 2.4 is the only row that has ever been moved
 * under that carve-out, and 6.7 is the counter-example that stays: both of its halves are
 * structural, one of them is unreachable, and half a row is not a covered row. Overclaiming here is
 * worse than a smaller automated set: a row that has been dropped from the human session and is
 * only half covered by a machine is a row nobody checks. Nothing here moved on the strength of a
 * check that had not been run against a build with the defect deliberately restored.
 *
 * ## Shape
 *
 * Each entry in `ASSERTION_ROUTES` is one page visit. `gather` DRIVES: it navigates, presses real
 * keys through Chrome's input pipeline, waits, and returns one plain-JSON evidence object. Each
 * `check` then DECIDES, as a pure function of that evidence.
 *
 * That split is not tidiness. It means one scripted interaction serves several assertions (opening
 * the navigation sheet answers five of journey 7), the decisions are readable next to the sentence
 * they came from, and — the part that matters — every `decide` can be handed synthetic evidence by
 * `scripts/ax-assertions.test.mjs` and shown to REFUSE it. A checker that has only ever been shown
 * a correct page is a checker nobody has tested.
 *
 * `id` is the assertion ID from the document, and `scripts/screen-reader-certify.test.mjs` asserts
 * that the set of IDs here is EXACTLY the set of rows the document marks `auto`. Neither side can
 * move alone: delete a check and the doc still marks the row machine-covered, so the row would fall
 * out of the automated set AND out of the human session at once. That test is the control against
 * exactly that.
 */

// ---------------------------------------------------------------------------
// Shared vocabulary
// ---------------------------------------------------------------------------

/**
 * Words that must never appear in the accessible name of a card the server chose to hide.
 *
 * Ranks and suits, as `packages/ui/src/cards.ts` spells them. Matched on word boundaries so
 * "face-down card" does not trip on anything, and so a name like "Ada hole cards" is not read as a
 * leak — "cards" is not a rank.
 *
 * It lives here rather than in `ax-tree-audit.mjs` so that the per-journey card audit and assertion
 * 3.8 cannot drift apart into two different ideas of what a leak looks like.
 */
export const CARD_VALUE_WORDS =
  /\b(ace|king|queen|jack|ten|nine|eight|seven|six|five|four|three|two|deuce|hearts?|diamonds?|clubs?|spades?)\b/iu;

/** A card named the way `packages/ui/src/cards.ts` names a revealed one: rank, "of", suit. */
export const CARD_NAMED_IN_WORDS =
  /^(ace|king|queen|jack|ten|nine|eight|seven|six|five|four|three|two) of (hearts|diamonds|clubs|spades)\b/iu;

const pass = (detail) => ({ ok: true, detail });
const fail = (detail) => ({ ok: false, detail });

/**
 * True when a computed name tells a reader nothing beyond the role they were going to hear anyway.
 *
 * The three cases the document names in G5 and 1.4: nothing at all, a bare number or glyph (an
 * index span that escaped its `aria-hidden`), and the role word itself. "3" and "›" are names; they
 * are not names anybody can act on.
 */
export function isBareName(name) {
  const trimmed = (name ?? '').trim();
  if (trimmed.length === 0) return true;
  if (/^[\d\p{P}\p{S}\s]+$/u.test(trimmed)) return true;
  return /^(link|button|image|graphic|icon)$/iu.test(trimmed);
}

/**
 * True when an action button's name is a sentence rather than a word welded to a number.
 *
 * 3.14 is explicit that "a button that announces a run-together string of the word and a number is
 * a FAIL". That is not hypothetical: the visible label and the cost are two spans, so this
 * control's `textContent` really is "Fold0 units", and it is only the `aria-label` on it that makes
 * it a sentence. A letter immediately followed by a digit is the signature of the `aria-label`
 * having been dropped and the text content taking over.
 */
export function announcesActionAndCost(name) {
  const trimmed = (name ?? '').trim();
  if (!/^(fold|check|call|bet to|raise to)\b/iu.test(trimmed)) return false;
  if (/[a-z]\d/iu.test(trimmed)) return false;
  return /\d[\d,]*\s+units?\b/iu.test(trimmed);
}

/** Every heading level in document order, checked for a skipped level. Returns null when clean. */
export function skippedHeadingLevel(levels) {
  let previous = null;
  for (const level of levels) {
    if (previous !== null && level > previous + 1) return `${previous} to ${level}`;
    previous = level;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Page-side probes
// ---------------------------------------------------------------------------

/**
 * Installed at document start, before any framework code runs.
 *
 * G9 asserts the app's announcer says NOTHING on a full document load — the browser and the reader
 * already say the title, and an app that says it again is the duplicate G8 exists to forbid. An
 * observer attached after the page has settled cannot tell "never wrote" from "wrote and was
 * cleared", so it has to be attached before hydration. `Page.addScriptToEvaluateOnNewDocument` is
 * the only place early enough.
 *
 * It records every DISTINCT non-empty text the announcer has held, with the milliseconds since the
 * document started, which is what G7 (arrives within about a second) and G8 (exactly once) read.
 */
export const ANNOUNCER_PROBE = `
(() => {
  const log = [];
  const started = Date.now();
  window.__prlAnnouncerLog = log;
  window.__prlAnnouncerReset = () => { log.length = 0; };
  let last = '';
  const read = () => {
    const region = document.querySelector('[data-prl-route-announcer]');
    return region === null ? null : (region.textContent ?? '').replace(/\\s+/gu, ' ').trim();
  };
  const sample = () => {
    const now = read();
    if (now === null || now === last) return;
    last = now;
    if (now !== '') log.push({ text: now, at: Date.now() - started });
  };
  const observer = new MutationObserver(sample);
  const attach = () => {
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    sample();
  };
  if (document.documentElement === null) {
    document.addEventListener('readystatechange', attach, { once: true });
  } else {
    attach();
  }
})();
`;

/**
 * Every write into every live region, in order, installed before any framework code runs.
 *
 * ## Why the announcement surface has to be RECORDED rather than read
 *
 * The live table says most of what it says once and replaces it a second later. Measured on a real
 * hand: "You chose to fold." was written at 13,248ms and the next table event overwrote it 6ms
 * later. A check that reads the regions after the hand sees the last sentence and nothing else, so
 * every assertion about what the table said during the hand — the connection going live, the blinds
 * before the bots, the turn sentence, the Coach arriving, the hand completing — would be checking a
 * page that has already stopped saying it.
 *
 * So this observes the whole document from `Page.addScriptToEvaluateOnNewDocument` and appends one
 * entry per DISTINCT text a region has held, with the milliseconds since the document started.
 * `ANNOUNCER_PROBE` does the same thing for the route announcer alone and is kept separate: G7/G8/G9
 * are about one region whose politeness and duplication are the subject, and merging them would
 * make those three read a haystack.
 *
 * ## Three details that are each load-bearing
 *
 * **`characterDataOldValue`, and the `recovered` flag on what it produces.** React coalesces two
 * state changes that arrive in one task into a single render, so a sentence can be replaced before
 * it ever reaches the DOM. Where the DOM itself was written twice in one batch the observer only
 * sees the final text, and the old value is the only record that the first one existed. Recovering
 * it is what lets a check distinguish "was said and replaced" from "was never said" — the
 * distinction assertion 3.3 rests on.
 *
 * Every recovered entry is marked `recovered: true`, and that marking is the point. A recovered
 * value is a string that was in a React element's props and never in a painted DOM: Chrome posts a
 * live-region notification from the commit and reads the region's text when it services it, so an
 * intermediate value inside one commit is never announced by anything. A check that accepted a
 * recovered entry as an announcement would pass while a screen-reader user heard nothing, which is
 * the exact failure 3.3 was filed as.
 *
 * **A mutation count per region.** A polite region re-written with the SAME text produces no change
 * of text and is still a re-announcement in several readers. Assertion 3.6 — the turn sentence is
 * announced once per turn, on an app that pushes whole-state frames several times a second — is
 * therefore a question about mutations, not about text. Counting both is the only way to answer it.
 *
 * **A key that survives two regions of the same class.** The table's narration and the decision
 * band's turn sentence are both `div.prl-live-region[role=status]`; keyed on their own class alone
 * they would be one region, and 3.6 would count the table's narration as re-announcements of the
 * turn. The key is the nearest three ancestor class names, which tells them apart.
 */
export const SPEECH_PROBE = `
(() => {
  const log = [];
  const mutations = [];
  const started = Date.now();
  window.__prlSpeech = { log, mutations };
  window.__prlSpeechReset = () => { log.length = 0; mutations.length = 0; };
  // Which announcement surfaces EXIST right now, by the same key the log uses. A live region that
  // is inserted already holding its sentence is not announced by Chrome — the notification is
  // posted for a change to a region the platform already knew about — so "was the region there
  // before the event" is a fact some assertions have to be able to read. See 3.3.
  window.__prlSpeechRegions = () => [...document.querySelectorAll(SELECTOR)].map((el) => keyOf(el));
  const SELECTOR = '[aria-live], [role="status"], [role="alert"]';
  const seen = new WeakMap();
  const tidy = (value) => (value ?? '').replace(/\\s+/gu, ' ').trim();
  const politeness = (el) => {
    const live = el.getAttribute('aria-live');
    if (live !== null) return live;
    const role = el.getAttribute('role');
    return role === 'alert' ? 'assertive' : role === 'status' ? 'polite' : 'off';
  };
  const keyOf = (el) => {
    const parts = [];
    for (let node = el; node !== null && parts.length < 3; node = node.parentElement) {
      const className = typeof node.className === 'string' ? node.className.split(/\\s+/u)[0] : '';
      if (className !== '') parts.unshift(className);
    }
    const label = el.getAttribute('aria-label');
    return parts.join('>') + (label === null ? '' : '#' + label);
  };
  const push = (el, text, recovered) => {
    if (text === '' || seen.get(el) === text) return;
    seen.set(el, text);
    log.push({
      text,
      live: politeness(el),
      role: el.getAttribute('role'),
      key: keyOf(el),
      at: Date.now() - started,
      // False only for a text this region was actually observed HOLDING. See the header: a
      // recovered old value is a sentence that existed inside one commit and never painted, and
      // a check that counts one as an announcement is claiming a reader heard something no
      // assistive technology was ever notified of.
      recovered: recovered === true,
    });
  };
  const scan = () => {
    for (const el of document.querySelectorAll(SELECTOR)) push(el, tidy(el.textContent), false);
  };
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      const node = record.target.nodeType === 1 ? record.target : record.target.parentElement;
      const region = node === null ? null : node.closest(SELECTOR);
      if (region === null) continue;
      mutations.push({ key: keyOf(region), at: Date.now() - started });
      // The text this region held before this write, recovered only when the region is the one
      // text node that changed — otherwise the "old value" is a fragment of a longer region and
      // logging it would invent a sentence nobody wrote.
      if (record.type === 'characterData' && typeof record.oldValue === 'string') {
        if (tidy(region.textContent) === tidy(record.target.data)) {
          push(region, tidy(record.oldValue), true);
        }
      }
    }
    scan();
  });
  const attach = () => {
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      characterDataOldValue: true,
      attributes: true,
    });
    scan();
  };
  if (document.documentElement === null) {
    document.addEventListener('readystatechange', attach, { once: true });
  } else {
    attach();
  }
})();
`;

/** Every live-region write and mutation this document has recorded so far. */
const speechSoFar = (page) =>
  page.evaluate('window.__prlSpeech ?? { log: [], mutations: [] }').then((speech) => ({
    log: speech.log ?? [],
    mutations: speech.mutations ?? [],
  }));

/** Every non-ignored AX node, flattened to the fields these checks read. */
async function axNodes(page) {
  const nodes = await page.axTree();
  return nodes.filter((node) => node.ignored !== true).map((node) => axShape(node));
}

function axShape(node) {
  const property = (name) => (node.properties ?? []).find((entry) => entry.name === name)?.value?.value;
  return {
    role: String(node.role?.value ?? ''),
    name: String(node.name?.value ?? '')
      .replace(/\s+/gu, ' ')
      .trim(),
    level: Number(property('level') ?? 0),
    live: String(property('live') ?? ''),
    checked: String(property('checked') ?? ''),
    expanded: property('expanded'),
    invalid: String(property('invalid') ?? ''),
    valuemin: property('valuemin'),
    valuemax: property('valuemax'),
    focused: property('focused') === true,
    hidden: property('hidden') === true || property('hiddenRoot') === true,
    value: String(node.value?.value ?? ''),
  };
}

/** The computed AX nodes for one selector, plus each element's own markup. */
async function axFor(page, selector) {
  const found = await page.axFor(selector);
  return found.map((entry) => ({
    ...(entry.node === null ? axShape({}) : axShape(entry.node)),
    ignored: entry.node?.ignored === true,
    html: entry.html ?? '',
  }));
}

/**
 * The computed AX node for whatever currently holds the DOM caret.
 *
 * Read through a stamped attribute rather than from the full tree, for the reason
 * `ax-tree-audit.mjs` documents at length: Chrome 151 keeps `focused` on `RootWebArea` after a
 * `tabindex="-1"` landing place is focused, so the full tree answers "the document is focused" for
 * a caret that is demonstrably on a named status node. `getPartialAXTree` on the real
 * `activeElement` answers the question that was actually asked.
 */
async function focusedAx(page) {
  const where = await page.evaluate(
    `(() => {
      const el = document.activeElement;
      if (el === null || el === document.body || el === document.documentElement) return null;
      el.setAttribute('data-prl-ax-focus', '1');
      return { tag: el.tagName, inMain: el.closest('main') !== null, connected: el.isConnected };
    })()`,
  );
  if (where === null) return { onDocument: true, role: '', name: '', inMain: false, connected: false };
  const found = await axFor(page, '[data-prl-ax-focus="1"]');
  await page.evaluate(
    `document.querySelectorAll('[data-prl-ax-focus]').forEach((el) => el.removeAttribute('data-prl-ax-focus'))`,
  );
  const node = found[0] ?? { role: '', name: '' };
  return {
    onDocument: false,
    role: node.role,
    name: node.name,
    inMain: where.inMain,
    connected: where.connected,
  };
}

/**
 * Every `Metric` under one root, as the four things a reader is entitled to hear about a figure.
 *
 * `Metric` in `@prl/ui` has two shapes and only one of them puts the value in the tree as text: a
 * counting figure hides the animated number from assistive technology and carries the real one in a
 * visually-hidden node that reads "label: value unit interval". A check written against the visible
 * value alone would report every counted figure on the site as unnamed, so both shapes are read
 * here and the decisions below accept either.
 */
const METRICS_JS = `((root) => {
  const tidy = (el) => (el === null ? null : (el.textContent ?? '').replace(/\\s+/gu, ' ').trim());
  const hidden = (el) => el === null || el.closest('[aria-hidden="true"]') !== null;
  return [...root.querySelectorAll('.prl-metric')].map((metric) => {
    const label = metric.querySelector('.prl-metric__label');
    const value = metric.querySelector('.prl-metric__value');
    const unit = metric.querySelector('.prl-metric__unit');
    const interval = metric.querySelector('.prl-metric__interval');
    const spoken = metric.querySelector('.prl-metric__figure .prl-visually-hidden');
    return {
      label: tidy(label),
      labelHidden: hidden(label),
      value: tidy(value),
      valueHidden: hidden(value),
      unit: tidy(unit),
      interval: tidy(interval),
      intervalHidden: interval === null ? false : hidden(interval),
      spoken: tidy(spoken),
      labelFirst:
        label !== null &&
        value !== null &&
        (label.compareDocumentPosition(value) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
    };
  });
})`;

/**
 * What a reader hears about one figure, whichever shape it is in: the label, then the number.
 *
 * Returns a sentence describing the defect, or null when the figure is announced whole.
 */
export function figureDefect(figure) {
  const label = (figure.label ?? '').trim();
  if (label === '' || figure.labelHidden) return 'a figure reaches the tree with no label beside it';
  const spoken = (figure.spoken ?? '').trim();
  if (figure.valueHidden || figure.value === null) {
    // The counting shape. The visible number is decoration; the hidden readout is the figure.
    if (spoken === '') return `"${label}" hides its value from the tree and offers no readout instead`;
    if (!spoken.startsWith(`${label}:`)) return `"${label}" is announced as "${spoken}", without its label`;
    if (!/\d/u.test(spoken)) return `"${label}" announces "${spoken}", which carries no figure`;
    if ((figure.interval ?? '') !== '' && !spoken.includes(figure.interval)) {
      return `"${label}" shows an interval (${figure.interval}) that its spoken readout leaves out`;
    }
    return null;
  }
  if ((figure.value ?? '').trim() === '') return `"${label}" has no value`;
  if (!figure.labelFirst) return `"${label}" is announced after its own number`;
  if ((figure.interval ?? '') !== '' && figure.intervalHidden) {
    return `"${label}" carries an interval that is hidden from the tree, so the figure is read as exact`;
  }
  return null;
}

const LIVE_REGIONS_JS = `
  [...document.querySelectorAll('[aria-live], [role="status"], [role="alert"]')].map((el) => ({
    role: el.getAttribute('role'),
    live: el.getAttribute('aria-live'),
    atomic: el.getAttribute('aria-atomic'),
    text: (el.textContent ?? '').replace(/\\s+/gu, ' ').trim(),
    className: el.className,
  }))`;

/** Every live region on the page, as the reader's own announcement surface. */
const liveRegions = (page) => page.evaluate(`(() => (${LIVE_REGIONS_JS}))()`);

// ---------------------------------------------------------------------------
// Journey: global (the site shell), at a desktop width
// ---------------------------------------------------------------------------

const SHELL_TITLE = 'Poker Risk Lab — a decision laboratory for poker';
const LEARN_TITLE = 'Learn — Poker Risk Lab';

async function gatherGlobal(page) {
  const evidence = {};
  evidence.title = await page.evaluate('document.title');
  evidence.announcerOnLoad = await page.evaluate('window.__prlAnnouncerLog ?? null');
  evidence.announcer = await axFor(page, '[data-prl-route-announcer]');
  evidence.frameworkAnnouncers = await page.evaluate(
    "document.getElementsByTagName('next-route-announcer').length",
  );

  const nodes = await axNodes(page);
  evidence.landmarks = nodes
    .filter((node) => ['banner', 'navigation', 'main', 'contentinfo'].includes(node.role))
    .map((node) => ({ role: node.role, name: node.name }));
  evidence.headings = nodes
    .filter((node) => node.role === 'heading' && !node.hidden)
    .map((node) => ({ level: node.level, name: node.name }));
  evidence.controls = nodes
    .filter((node) => !node.hidden && NAMED_ROLES.has(node.role))
    .map((node) => ({ role: node.role, name: node.name }));
  evidence.unnamedImages = nodes.filter(
    (node) => node.role === 'image' && !node.hidden && node.name === '',
  ).length;
  evidence.themeGroups = nodes.filter((node) => node.role === 'group' && /colour theme/iu.test(node.name));
  evidence.themeOptions = nodes
    .filter((node) => node.role === 'radio' && !node.hidden)
    .map((node) => ({ name: node.name, checked: node.checked }));

  // --- G2: the first Tab stop, and where Enter on it puts the caret ---------
  await page.evaluate('document.body.focus(); document.activeElement && document.activeElement.blur()');
  await page.press('Tab');
  evidence.firstTabStop = await focusedAx(page);
  await page.press('Enter');
  evidence.afterSkipLink = await focusedAx(page);

  // --- G7, G8, G10: a REAL client-side navigation ---------------------------
  const target = await page.evaluate(
    `(() => {
      const link = [...document.querySelectorAll('nav[aria-label="Primary"] a')]
        .find((a) => (a.textContent ?? '').trim() === 'Learn');
      if (link === undefined) return null;
      link.setAttribute('data-prl-nav-source', '1');
      link.focus();
      return (a => a.getAttribute('href'))(link);
    })()`,
  );
  evidence.navLinkFound = target !== null;
  if (target !== null) {
    await page.press('Enter');
    await page.settle(2500);
    evidence.announcerAfterNav = await page.evaluate('window.__prlAnnouncerLog ?? []');
    evidence.frameworkAnnouncersAfterNav = await page.evaluate(
      "document.getElementsByTagName('next-route-announcer').length",
    );
    evidence.titleAfterNav = await page.evaluate('document.title');
    evidence.focusAfterNav = await page.evaluate(
      `(() => {
        const el = document.activeElement;
        if (el === null) return { onSource: false, where: 'null' };
        return {
          onSource: el.getAttribute('data-prl-nav-source') === '1',
          where: el === document.body ? 'body' : el.tagName,
        };
      })()`,
    );
  }
  return evidence;
}

const GLOBAL_CHECKS = [
  {
    id: 'G1',
    what: 'the document title on / is the one the certification quotes',
    decide: (e) =>
      e.title === SHELL_TITLE
        ? pass(`"${e.title}"`)
        : fail(`document.title is "${e.title}", the certification quotes "${SHELL_TITLE}"`),
  },
  {
    id: 'G2',
    what: 'the first Tab stop is the skip link, and Enter on it moves the caret into main',
    decide: (e) => {
      if (e.firstTabStop.role !== 'link' || !/^skip to main content$/iu.test(e.firstTabStop.name)) {
        return fail(
          `the first Tab stop computes as ${e.firstTabStop.role || 'nothing'} "${e.firstTabStop.name}"; ` +
            'a reader who cannot see the screen has no other way past the header',
        );
      }
      if (!e.afterSkipLink.inMain) {
        return fail(
          'activating the skip link left the caret outside <main>, so the link announces a promise ' +
            'it does not keep',
        );
      }
      return pass(`link "${e.firstTabStop.name}" -> ${e.afterSkipLink.role} inside main`);
    },
  },
  {
    id: 'G3',
    what: 'one banner, one main, one contentinfo, and no two landmarks of a role sharing a name',
    decide: (e) => decideLandmarks(e.landmarks),
  },
  {
    id: 'G4',
    what: 'exactly one level-1 heading, and no level skipped',
    decide: (e) => decideHeadingOutline(e.headings),
  },
  {
    id: 'G5',
    what: 'every control carries a computed name, and nothing is a bare role',
    decide: (e) => {
      const bare = e.controls.filter((control) => isBareName(control.name));
      if (bare.length > 0) {
        return fail(
          `${bare.length} control(s) announce as a bare role: ` +
            bare
              .slice(0, 4)
              .map((control) => `${control.role} "${control.name}"`)
              .join(', '),
        );
      }
      if (e.unnamedImages > 0) {
        return fail(`${e.unnamedImages} image(s) reach the tree with no computed name`);
      }
      if (e.controls.length < 10) {
        return fail(`only ${e.controls.length} control(s) were examined; the shell did not render`);
      }
      return pass(`${e.controls.length} controls, all named`);
    },
  },
  {
    id: 'G6',
    what: 'the theme control is a three-option radio group with exactly one option selected',
    decide: (e) => {
      if (e.themeGroups.length === 0) return fail('no group named "Colour theme" in the computed tree');
      const words = ['auto', 'light', 'dark'];
      const named = words.map((word) =>
        e.themeOptions.find((option) => new RegExp(`^${word}\\b`, 'iu').test(option.name)),
      );
      const missing = words.filter((_, index) => named[index] === undefined);
      if (missing.length > 0) {
        return fail(
          `no radio announces as ${missing.join('/')}; the tree has ` +
            `${e.themeOptions.map((option) => `"${option.name}"`).join(', ') || 'no radios at all'}`,
        );
      }
      const selected = named.filter((option) => option.checked === 'true');
      if (selected.length !== 1) {
        return fail(
          `${selected.length} of the three theme options report checked; a reader is told either ` +
            'nothing about the current theme or that two are current at once',
        );
      }
      return pass(`Auto/Light/Dark, "${selected[0].name}" selected`);
    },
  },
  {
    id: 'G7',
    what: 'a client navigation announces the new title through one polite region',
    decide: (e) => {
      if (!e.navLinkFound) return fail('no "Learn" link in the primary navigation to activate');
      const region = e.announcer[0];
      if (region === undefined) return fail('no light-DOM route announcer on the page');
      if (region.live !== 'polite') {
        return fail(
          `the route announcer's computed politeness is "${region.live || 'none'}"; an assertive one ` +
            'cuts off whatever the reader was in the middle of',
        );
      }
      const spoken = e.announcerAfterNav ?? [];
      const heard = spoken.find((entry) => entry.text === LEARN_TITLE);
      if (heard === undefined) {
        return fail(
          `after activating "Learn" the announcer held ${JSON.stringify(spoken.map((s) => s.text))}, ` +
            `expected "${LEARN_TITLE}"`,
        );
      }
      return pass(`polite status, "${LEARN_TITLE}"`);
    },
  },
  {
    id: 'G8',
    what: 'the title is written once, and the framework announcer is stood down',
    decide: (e) => {
      if (!e.navLinkFound) return fail('no "Learn" link in the primary navigation to activate');
      const spoken = e.announcerAfterNav ?? [];
      if (spoken.length !== 1) {
        return fail(
          `the announcer held ${spoken.length} distinct texts across one navigation ` +
            `(${JSON.stringify(spoken.map((entry) => entry.text))}); the title is announced once`,
        );
      }
      if (e.announcer.length !== 1) {
        return fail(`${e.announcer.length} light-DOM route announcers on the page, expected 1`);
      }
      if (e.frameworkAnnouncersAfterNav !== 0) {
        return fail(
          `${e.frameworkAnnouncersAfterNav} <next-route-announcer> element(s) survive the ` +
            'stand-down, so the page title is announced twice — once assertively, from a shadow root',
        );
      }
      return pass('one write, one announcer, no framework announcer');
    },
  },
  {
    id: 'G9',
    what: 'a full document load announces nothing from the app',
    decide: (e) => {
      if (e.announcerOnLoad === null) {
        return fail('the announcer probe never installed, so this run proved nothing about the load');
      }
      // Silence is only evidence when there was something that could have spoken. Without this,
      // G9 is the one check in the registry that passes a page which rendered nothing at all —
      // which is exactly what the blanket control in `ax-assertions.test.mjs` caught it doing.
      const region = e.announcer[0];
      if (e.announcer.length !== 1 || region.live !== 'polite') {
        return fail(
          `${e.announcer.length} light-DOM route announcer(s) on the page` +
            `${region === undefined ? '' : `, politeness "${region.live || 'none'}"`}. There is no ` +
            'announcer here to have stayed quiet, so this run proved nothing about the load',
        );
      }
      if (e.announcerOnLoad.length !== 0) {
        return fail(
          `on a full document load the app's announcer said ` +
            `${JSON.stringify(e.announcerOnLoad.map((entry) => entry.text))}. The browser already ` +
            'announces the title of a document it has just loaded; this is the second time',
        );
      }
      return pass('silent on load, as it must be');
    },
  },
  {
    id: 'G10',
    what: 'activating a navigation link does not move the caret',
    decide: (e) => {
      if (!e.navLinkFound) return fail('no "Learn" link in the primary navigation to activate');
      if (!e.focusAfterNav.onSource) {
        return fail(
          `after a route change the caret is on ${e.focusAfterNav.where}, not on the link that was ` +
            'activated. A reader who is moved has lost their place, and this app deliberately does ' +
            'not move them',
        );
      }
      return pass('caret left where the reader put it');
    },
  },
];

/** Shared by G3 and the journey routes: landmark inventory and uniqueness. */
function decideLandmarks(landmarks) {
  const counted = (role) => landmarks.filter((landmark) => landmark.role === role);
  for (const [role, expected] of [
    ['banner', 1],
    ['main', 1],
    ['contentinfo', 1],
  ]) {
    const found = counted(role);
    if (found.length !== expected) {
      return fail(`${found.length} ${role} landmark(s) in the computed tree, expected ${expected}`);
    }
  }
  const banner = counted('banner')[0];
  if (banner.name === '') return fail('the banner landmark has no computed name');
  const contentinfo = counted('contentinfo')[0];
  if (contentinfo.name === '') {
    return fail(
      'the contentinfo landmark has no computed name, so the landmark rotor offers it as an ' +
        'unlabelled "content information" and G3 quotes a name it does not have',
    );
  }
  for (const role of ['banner', 'navigation', 'main', 'contentinfo']) {
    const names = counted(role).map((landmark) => landmark.name.toLowerCase());
    const duplicate = names.find((name, index) => names.indexOf(name) !== index);
    if (duplicate !== undefined) {
      return fail(`two ${role} landmarks share the computed name "${duplicate || '(no name)'}"`);
    }
  }
  return pass(
    landmarks
      .map((landmark) => `${landmark.role}${landmark.name === '' ? '' : `:${landmark.name}`}`)
      .join(', '),
  );
}

/** Shared by G4 and 1.2/1.3: one h1, and no level skipped in document order. */
function decideHeadingOutline(headings) {
  const levelOnes = headings.filter((heading) => heading.level === 1);
  if (levelOnes.length !== 1) {
    return fail(`${levelOnes.length} level-1 heading(s); a route owns exactly one and the shell owns none`);
  }
  if (levelOnes[0].name === '') return fail('the level-1 heading has no computed name');
  const skip = skippedHeadingLevel(headings.map((heading) => heading.level));
  if (skip !== null) {
    return fail(
      `the heading outline jumps ${skip}, so a reader navigating by heading is told a section is ` +
        'nested under one that does not exist',
    );
  }
  return pass(`h1 "${levelOnes[0].name}", ${headings.length} heading(s), no level skipped`);
}

/** Roles whose nodes must carry a computed accessible name. Mirrors `ax-tree-audit.mjs`. */
const NAMED_ROLES = new Set([
  'button',
  'checkbox',
  'combobox',
  'link',
  'listbox',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'radio',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
  'treeitem',
]);

// ---------------------------------------------------------------------------
// Journey 1 — Learn, the curriculum index
// ---------------------------------------------------------------------------

async function gatherLearn(page) {
  const nodes = await axNodes(page);
  return {
    title: await page.evaluate('document.title'),
    headings: nodes
      .filter((node) => node.role === 'heading' && !node.hidden)
      .map((node) => ({ level: node.level, name: node.name })),
    mainLinks: await axFor(page, 'main a[href]').then((found) =>
      found
        .filter((entry) => !entry.ignored)
        .map((entry) => ({ name: entry.name, html: entry.html.slice(0, 80) })),
    ),
    figures: await page.evaluate(
      `(() => {
        const row = document.querySelector('.prl-learn-page__figures');
        return row === null ? null : (${METRICS_JS})(row);
      })()`,
    ),
  };
}

const LEARN_CHECKS = [
  {
    id: 'J1.1',
    what: 'the /learn document title is the one the certification quotes',
    decide: (e) =>
      e.title === LEARN_TITLE
        ? pass(`"${e.title}"`)
        : fail(`document.title is "${e.title}", the certification quotes "${LEARN_TITLE}"`),
  },
  {
    id: 'J1.2',
    what: 'one level-1 heading, named, exposed with its level',
    decide: (e) => {
      const levelOnes = e.headings.filter((heading) => heading.level === 1);
      if (levelOnes.length !== 1)
        return fail(`${levelOnes.length} level-1 heading(s) on the curriculum index`);
      if (levelOnes[0].name === '') return fail('the level-1 heading has no computed name');
      return pass(`h1 "${levelOnes[0].name}"`);
    },
  },
  {
    id: 'J1.3',
    what: 'every topic group is a level-2 or level-3 heading and no level is skipped',
    decide: (e) => {
      const belowTheTitle = e.headings.filter((heading) => heading.level > 1);
      if (belowTheTitle.length < 5) {
        return fail(`only ${belowTheTitle.length} heading(s) below the h1; the curriculum did not render`);
      }
      const wrong = belowTheTitle.filter((heading) => heading.level < 2 || heading.level > 3);
      if (wrong.length > 0) {
        return fail(
          `${wrong.length} heading(s) sit outside levels 2 and 3: ` +
            wrong
              .slice(0, 3)
              .map((heading) => `h${heading.level} "${heading.name}"`)
              .join(', '),
        );
      }
      const skip = skippedHeadingLevel(e.headings.map((heading) => heading.level));
      if (skip !== null) return fail(`the heading outline jumps ${skip}`);
      return pass(`${belowTheTitle.length} group and lesson headings, levels 2-3, no skip`);
    },
  },
  {
    id: 'J1.4',
    what: 'every link in main announces a name that is not a bare number, glyph or role word',
    decide: (e) => {
      if (e.mainLinks.length < 10) {
        return fail(`only ${e.mainLinks.length} link(s) in main; the curriculum did not render`);
      }
      const bare = e.mainLinks.filter((link) => isBareName(link.name));
      if (bare.length > 0) {
        return fail(
          `${bare.length} link(s) announce as a bare number, glyph or the word "link": ` +
            bare
              .slice(0, 4)
              .map((link) => `"${link.name}" (${link.html})`)
              .join(' · '),
        );
      }
      return pass(`${e.mainLinks.length} links, all named`);
    },
  },
  {
    id: 'J1.6',
    what: 'each figure at the top announces a label and a value together, never a bare number',
    decide: (e) => {
      if (e.figures === null) return fail('the figures block did not render on the curriculum index');
      if (e.figures.length < 3) {
        return fail(`only ${e.figures.length} figure(s) at the top of /learn; the header did not render`);
      }
      const defects = e.figures.map((figure) => figureDefect(figure)).filter((defect) => defect !== null);
      if (defects.length > 0) {
        return fail(
          `${defects.length} of ${e.figures.length} figure(s) announce a number a reader cannot ` +
            `place: ${defects.slice(0, 3).join('; ')}`,
        );
      }
      return pass(e.figures.map((figure) => `${figure.label} ${figure.value ?? figure.spoken}`).join(', '));
    },
  },
];

// ---------------------------------------------------------------------------
// Journey 2 — a lesson and its quiz
// ---------------------------------------------------------------------------

const QUIZ_VERDICT_OPENING =
  /^(That matches the answer this lesson gives|That is not the answer this lesson gives)\./u;
const NUMERIC_VERDICT_OPENING = /^\S.* is (within|outside) the tolerance of .*?\./u;

async function gatherQuiz(page) {
  const evidence = { title: await page.evaluate('document.title') };
  evidence.panelHeading = (await axFor(page, '.prl-learn-quiz .prl-panel__title'))[0] ?? null;
  evidence.promptHeading = (await axFor(page, '.prl-learn-quiz__heading'))[0] ?? null;

  // 2.4 — read BEFORE anything is answered. Answering inserts the chips and the note under each
  // option, and a check that read the group afterwards would be reading a different group from the
  // one the assertion's step ("Tab into the answer group") arrives at.
  evidence.answerGroup = (await axFor(page, '.prl-learn-quiz__options'))[0] ?? null;
  evidence.answerOptions = await axFor(page, '.prl-learn-quiz__options input[type="radio"]');

  // 2.5 — answer the multiple-choice question and read the region it writes into.
  const answered = await page.evaluate(
    `(() => {
      const radio = document.querySelector('.prl-learn-quiz__options input[type="radio"]');
      if (radio === null) return false;
      radio.click();
      return true;
    })()`,
  );
  evidence.choiceAnswered = answered;
  await page.settle(900);
  evidence.choiceVerdict =
    (await liveRegions(page)).find((region) => QUIZ_VERDICT_OPENING.test(region.text)) ?? null;
  evidence.choiceVerdictCount = (await liveRegions(page)).filter((region) =>
    QUIZ_VERDICT_OPENING.test(region.text),
  ).length;

  // 2.8 — advance, and see where the caret lands.
  const advanced = await page.evaluate(
    `(() => {
      const next = [...document.querySelectorAll('.prl-learn-quiz__nav button')]
        .find((b) => /Next question/u.test(b.textContent ?? ''));
      if (next === undefined) return false;
      next.focus();
      next.click();
      return true;
    })()`,
  );
  evidence.advanced = advanced;
  await page.settle(700);
  evidence.afterNext = await focusedAx(page);

  await gatherNumericQuestion(page, evidence);
  return evidence;
}

/**
 * 2.6 and 2.7, on the first numeric question the quiz offers.
 *
 * Two things about the input, both measured rather than assumed.
 *
 * First, it has to arrive through Chrome's own key pipeline. Setting `.value = 'abc'` on an
 * `<input type="number">` is silently discarded by the DOM — the element reports an empty value and
 * `validity.badInput` never becomes true — so a check written that way would type nothing, see no
 * error, and report a pass for a field it never made invalid.
 *
 * Second, what gets typed is `1e` and not the `abc` the assertion's recipe names. Chrome's number
 * field FILTERS bare letters out at the editing layer: measured in Chrome 151, three real `a`/`b`/`c`
 * key events left the field at `value: ""`, `badInput: false`, `aria-invalid` absent — nothing had
 * happened, and a check that typed them would have reported the app broken when it is the browser
 * refusing the keystroke. `1e` is a partial exponent, which Chrome does accept into the buffer and
 * does report as `badInput`, so it is the malformed answer this browser can actually be given. The
 * claim the assertion makes — a refused answer says so, and says WHY before it says what the
 * tolerance is — is the same claim either way; the recipe is not.
 */
async function gatherNumericQuestion(page, evidence) {
  const field = await page.evaluate(
    `(() => {
      const input = document.querySelector('.prl-learn-quiz__numeric input[type="number"]');
      if (input === null) return null;
      input.focus();
      return { id: input.id, describedBy: input.getAttribute('aria-describedby') };
    })()`,
  );
  evidence.numericFound = field !== null;
  if (field === null) return;
  evidence.numericBefore = field;

  await page.insertText('1e');
  await page.settle(500);
  evidence.numericInvalid = await page.evaluate(
    `(() => {
      const input = document.querySelector('.prl-learn-quiz__numeric input[type="number"]');
      const describedBy = (input.getAttribute('aria-describedby') ?? '').split(/\\s+/u).filter(Boolean);
      return {
        ariaInvalid: input.getAttribute('aria-invalid'),
        describedBy,
        described: describedBy.map((id) => {
          const el = document.getElementById(id);
          return { id, text: el === null ? null : (el.textContent ?? '').replace(/\\s+/gu, ' ').trim() };
        }),
      };
    })()`,
  );
  evidence.numericInvalidAx = (await axFor(page, '.prl-learn-quiz__numeric input[type="number"]'))[0] ?? null;

  // 2.7 — a real number, then the comparison.
  await page.selectAllAndType('.prl-learn-quiz__numeric input[type="number"]', '33');
  await page.settle(400);
  const checked = await page.evaluate(
    `(() => {
      const button = [...document.querySelectorAll('.prl-learn-quiz button')]
        .find((b) => /^Check/u.test((b.textContent ?? '').trim()) && !b.disabled);
      if (button === undefined) return false;
      button.click();
      return true;
    })()`,
  );
  evidence.numericChecked = checked;
  await page.settle(2200);
  evidence.numericVerdict =
    (await liveRegions(page)).find((region) => NUMERIC_VERDICT_OPENING.test(region.text)) ?? null;
}

const QUIZ_CHECKS = [
  {
    id: 'J2.1',
    what: 'the lesson title is the lesson name plus the site name',
    decide: (e) =>
      /^.+ — Poker Risk Lab$/u.test(e.title)
        ? pass(`"${e.title}"`)
        : fail(`document.title is "${e.title}", expected "<lesson> — Poker Risk Lab"`),
  },
  {
    id: 'J2.2',
    what: 'the quiz panel is a heading and the question prompt is a level-3 heading',
    decide: (e) => {
      if (e.panelHeading === null || e.panelHeading.role !== 'heading') {
        return fail('the quiz panel title is not a heading in the computed tree');
      }
      if (e.panelHeading.level !== 2) {
        return fail(`the quiz panel heading reports level ${e.panelHeading.level}, expected 2`);
      }
      if (e.promptHeading === null || e.promptHeading.role !== 'heading') {
        return fail('the question prompt is not a heading in the computed tree');
      }
      if (e.promptHeading.level !== 3) {
        return fail(
          `the question prompt heading reports level ${e.promptHeading.level}, expected 3; a reader ` +
            'navigating by heading cannot tell the question from the panel that holds it',
        );
      }
      return pass(`h2 "${e.panelHeading.name}" / h3 "${e.promptHeading.name.slice(0, 40)}…"`);
    },
  },
  {
    id: 'J2.3',
    what: 'the question heading announces its position before the prompt',
    decide: (e) => {
      if (e.promptHeading === null) return fail('no question heading in the computed tree');
      if (!/^Question \d+ of \d+\./u.test(e.promptHeading.name)) {
        return fail(
          `the question heading computes as "${e.promptHeading.name.slice(0, 60)}…"; it must open ` +
            'with "Question N of M." or a reader cannot tell where they are in the quiz',
        );
      }
      return pass(`"${e.promptHeading.name.slice(0, 46)}…"`);
    },
  },
  {
    id: 'J2.4',
    what: 'the answer group names its purpose, each option names itself, and the prompt is in the tree once',
    decide: (e) => {
      if (e.answerGroup === null || e.answerGroup.ignored) {
        return fail(
          'the answer options are not a group in the computed tree, so entering them announces nothing',
        );
      }
      // The role, not only the name. A `generic` container carrying an `aria-label` computes a name
      // that no reader announces on entry, so it would satisfy every other clause here and tell the
      // reader nothing — which is the same silence as having no group at all.
      if (!['group', 'radiogroup'].includes(e.answerGroup.role)) {
        return fail(
          `the answer options sit inside a "${e.answerGroup.role}", which is not a role a reader ` +
            'announces on entry. Its name is never said, whatever the name is',
        );
      }
      if (isBareName(e.answerGroup.name)) {
        return fail(
          `the answer group computes the name "${e.answerGroup.name}". A reader who tabs into it is ` +
            'told a group started and not what it is for',
        );
      }
      const options = (e.answerOptions ?? []).filter((option) => !option.ignored);
      if (options.length < 2) {
        return fail(
          `${options.length} answer option(s) reached the tree; there is nothing to choose between`,
        );
      }
      const bare = options.filter((option) => isBareName(option.name));
      if (bare.length > 0) {
        return fail(`${bare.length} of ${options.length} options announce no text of their own`);
      }
      // The half of this row that is about the UTTERANCE, decided structurally.
      //
      // "The prompt is not read twice" has exactly one cause inside the tree: the prompt appearing
      // in a second accessible name. A group labelled by the prompt is re-announced on entry by
      // every reader; an option whose name carries the prompt repeats it once per option.
      // `QuizRunner` says so where the legend is written — "a legend that repeats it makes a screen
      // reader read the whole question twice" — and this is that comment as a check. What is left
      // over is a reader re-reading anything at all on request, which is not a property of this page.
      const prompt = (e.promptHeading?.name ?? '').replace(/^Question \d+ of \d+\.\s*/u, '').trim();
      if (prompt.length < 12) {
        return fail(
          `the question prompt could not be read off the heading ("${e.promptHeading?.name ?? ''}"), so ` +
            'this run could not check whether anything else repeats it',
        );
      }
      const repeats = [
        ...(e.answerGroup.name.includes(prompt) ? [`the group ("${e.answerGroup.name}")`] : []),
        ...options
          .filter((option) => option.name.includes(prompt))
          .map((option) => `an option ("${option.name.slice(0, 40)}…")`),
      ];
      if (repeats.length > 0) {
        return fail(
          `the prompt is in the accessibility tree ${repeats.length + 1} times — as the heading, and ` +
            `as ${repeats.join(' and ')}. A reader hears the whole question again on entering the group`,
        );
      }
      return pass(`group "${e.answerGroup.name}", ${options.length} named options, prompt named once`);
    },
  },
  {
    id: 'J2.5',
    what: 'answering writes the verdict and its source sentence into one polite region',
    decide: (e) => {
      if (!e.choiceAnswered) return fail('no radio option on the quiz to answer');
      if (e.choiceVerdict === null) {
        return fail('answering wrote no verdict into any live region, so a reader is told nothing');
      }
      if (e.choiceVerdict.live !== 'polite' && e.choiceVerdict.role !== 'status') {
        return fail(
          `the verdict region computes as ${e.choiceVerdict.role ?? 'no role'}/` +
            `${e.choiceVerdict.live ?? 'no aria-live'}; a verdict that interrupts is a defect`,
        );
      }
      const rest = e.choiceVerdict.text.replace(QUIZ_VERDICT_OPENING, '').trim();
      if (rest.length < 20) {
        return fail(
          'the verdict arrived without the sentence about what was recorded; the two must be one ' +
            'message or the reader hears a mark with no account of what it did',
        );
      }
      if (e.choiceVerdictCount !== 1) {
        return fail(`${e.choiceVerdictCount} regions carry the verdict; it must be announced from one`);
      }
      return pass(`"${e.choiceVerdict.text.slice(0, 54)}…"`);
    },
  },
  {
    id: 'J2.6',
    what: 'an unusable answer makes the field invalid, with the correction described before the hint',
    decide: (e) => {
      if (!e.numericFound) return fail('this lesson quiz offers no numeric question to make invalid');
      if (e.numericInvalid.ariaInvalid !== 'true') {
        return fail(
          'after typing an unusable answer the field reports ' +
            `aria-invalid="${e.numericInvalid.ariaInvalid}". A reader is left with a field they ` +
            'cannot see and no announcement that it is refused',
        );
      }
      if (e.numericInvalidAx !== null && e.numericInvalidAx.invalid === 'false') {
        return fail('the computed tree still reports the field as valid');
      }
      const described = e.numericInvalid.described;
      if (described.length < 2) {
        return fail(
          `aria-describedby names ${described.length} element(s); the correction and the tolerance ` +
            'hint must both be there',
        );
      }
      if (!/not a number this question can be checked against/u.test(described[0].text ?? '')) {
        return fail(
          'the first described-by element is not the correction, so the tolerance rule is announced ' +
            `before the reason the answer was refused (first is "${(described[0].text ?? '').slice(0, 50)}…")`,
        );
      }
      return pass('aria-invalid=true, correction described first');
    },
  },
  {
    id: 'J2.7',
    what: 'the comparison and the recording sentence arrive as one polite message, verdict first',
    decide: (e) => {
      if (!e.numericFound) return fail('this lesson quiz offers no numeric question to check');
      if (!e.numericChecked) return fail('the "Check against the computed figure" control was not enabled');
      if (e.numericVerdict === null) {
        return fail('checking a numeric answer wrote no comparison into any live region');
      }
      if (e.numericVerdict.role !== 'status' && e.numericVerdict.live !== 'polite') {
        return fail(`the comparison region computes as ${e.numericVerdict.role}/${e.numericVerdict.live}`);
      }
      const rest = e.numericVerdict.text.replace(NUMERIC_VERDICT_OPENING, '').trim();
      if (rest.length < 20) {
        return fail(
          'the comparison arrived with no sentence about whether anything was recorded. Hearing the ' +
            'recording sentence without the verdict in front of it is the failure this forbids',
        );
      }
      return pass(`"${e.numericVerdict.text.slice(0, 54)}…"`);
    },
  },
  {
    id: 'J2.8',
    what: 'advancing moves the caret to the new question heading, which names its position',
    decide: (e) => {
      if (!e.advanced) return fail('no "Next question" control on the quiz');
      if (e.afterNext.onDocument) {
        return fail('after advancing the caret was dropped to the document; the reader restarts at the top');
      }
      if (e.afterNext.role !== 'heading') {
        return fail(`after advancing the caret is on a ${e.afterNext.role}, expected the question heading`);
      }
      if (!/^Question \d+ of \d+\./u.test(e.afterNext.name)) {
        return fail(
          `the caret landed on a heading named "${e.afterNext.name.slice(0, 50)}…", which does not say ` +
            'which question it is, so a reader cannot tell whether they advanced',
        );
      }
      return pass(`caret on heading "${e.afterNext.name.slice(0, 40)}…"`);
    },
  },
];

// ---------------------------------------------------------------------------
// Journey 2.9 — the end of a quiz, run twice
// ---------------------------------------------------------------------------

/**
 * 2.9 — "no score, tally or mark out of five is announced anywhere" — decided by DIFFERENCE.
 *
 * ## Why the obvious check is the wrong one, and why this row sat with the person
 *
 * The certification recorded this as an unbounded negative over speech, and added that "the
 * end-of-quiz panel's own prose about there being no mark out of five defeats every textual scan".
 * The second half of that is measurably false — the panel spells the number as a word ("nowhere in
 * this product for a mark out of five to live"), so no digit-shaped scan trips on it — but the
 * first half is the real problem and a scan does not solve it. A scan is a list of the wordings
 * somebody thought of. "You matched three of the five" defeats a digit pattern; "well done" is a
 * verdict with no number in it at all. A negative decided by a wording list is a negative that
 * passes anything the list did not anticipate, which is exactly the proxy-for-a-judgement shape
 * this repository has been bitten by before.
 *
 * ## What is decided instead
 *
 * A score is a function of what the learner got right. So the quiz is run to its review panel
 * TWICE, from a fresh load each time, diverging in exactly one place: the first question is
 * answered with the lesson's own answer in one run and with a different option in the other. Every
 * other question is skipped, identically, in both. If any figure anywhere on the page were derived
 * from correctness — a tally, a percentage, a mark, a grade, a sentence of praise, in digits or in
 * words or in a live region — the two runs would differ, because the number of matched answers
 * differs by exactly one. They must be identical.
 *
 * That is a decision procedure rather than a pattern list: it cannot be defeated by a wording
 * nobody thought of, because it never looks at the wording. What it does not cover is a figure that
 * does NOT depend on correctness — "5 questions answered" is a tally the row also forbids and it
 * would be identical in both runs — so the panel is separately required to carry no `N of M` or
 * `N%` shape. The differential is the load-bearing half; the shape scan is a second, weaker guard
 * over the one thing the differential cannot see.
 *
 * The run is compared over `main` rather than the whole document, deliberately: the shell's units
 * pill is fetched asynchronously and can settle as `assumed` in one run and `known` in the next,
 * which is a difference about the API's latency and not about the quiz. Nothing outside `main`
 * knows what was answered.
 */
const SPOKEN_TEXT_JS = `((root) => {
  if (root === null) return null;
  const copy = root.cloneNode(true);
  for (const decoration of copy.querySelectorAll('[aria-hidden="true"]')) decoration.remove();
  return (copy.textContent ?? '').replace(/\\s+/gu, ' ').trim();
})`;

/** The shapes a tally takes when it is written in digits. See the header: the weaker of the two halves. */
const TALLY_SHAPE = /\b\d[\d,]*\s*(?:\/|of|out of)\s*\d[\d,]*\b|\b\d[\d,]*\s*%/u;

/** How many "Next question"/"Finish" presses it can take to walk out of a quiz. */
const QUIZ_STEP_LIMIT = 12;

async function gatherQuizReview(page, baseUrl) {
  const evidence = { runs: [] };
  for (const takeTheLessonAnswer of [true, false]) {
    const run = { takeTheLessonAnswer };
    await page.goto(`${baseUrl}/learn/pot-odds`);
    await page.settle(700);
    // Answer once with whatever is first, only so that the chips appear and the lesson's own answer
    // can be read off the page. Which option carries it is a fact about the question, and this
    // gate has no business knowing the answer key.
    run.opened = await page.evaluate(
      `(() => {
        const radios = [...document.querySelectorAll('.prl-learn-quiz__options input[type="radio"]')];
        if (radios.length === 0) return 0;
        radios[0].click();
        return radios.length;
      })()`,
    );
    if (run.opened === 0) {
      evidence.runs.push(run);
      continue;
    }
    await page.settle(900);
    run.chose = await page.evaluate(
      `(() => {
        const options = [...document.querySelectorAll('.prl-learn-quiz__option')];
        const lesson = options.findIndex((option) => /the answer this lesson gives/u.test(option.textContent ?? ''));
        if (lesson < 0) return null;
        const wanted = ${JSON.stringify(takeTheLessonAnswer)} ? lesson : (lesson === 0 ? 1 : 0);
        const radio = options[wanted].querySelector('input[type="radio"]');
        if (radio === null) return null;
        radio.click();
        return { lesson, wanted };
      })()`,
    );
    await page.settle(900);
    run.verdict = await page.evaluate(
      `(${SPOKEN_TEXT_JS})(document.querySelector('.prl-learn-quiz__verdict'))`,
    );

    // Out through the quiz's own control, skipping the rest — identically in both runs.
    for (let step = 0; step < QUIZ_STEP_LIMIT; step += 1) {
      const advanced = await page.evaluate(
        `(() => {
          const button = [...document.querySelectorAll('.prl-learn-quiz__nav button')]
            .find((b) => /Next question|Finish/u.test(b.textContent ?? '') && !b.disabled);
          if (button === undefined) return false;
          button.click();
          return true;
        })()`,
      );
      if (!advanced) break;
      await page.settle(450);
      run.reachedReview = await page.evaluate(
        `document.querySelector('.prl-learn-quiz__options') === null &&
         document.querySelector('.prl-learn-quiz__advice') !== null`,
      );
      if (run.reachedReview === true) break;
    }
    run.panel = await page.evaluate(`(${SPOKEN_TEXT_JS})(document.querySelector('.prl-learn-quiz'))`);
    run.main = await page.evaluate(`(${SPOKEN_TEXT_JS})(document.querySelector('main'))`);
    run.regions = (await liveRegions(page)).map((region) => `${region.live ?? region.role}:${region.text}`);
    evidence.runs.push(run);
  }
  return evidence;
}

const QUIZ_REVIEW_CHECKS = [
  {
    id: 'J2.9',
    what: 'the end of the quiz says nothing that depends on what was answered, and carries no tally',
    decide: (e) => {
      const [matched, missed] = e.runs ?? [];
      if (matched === undefined || missed === undefined) {
        return fail('the quiz was not run to its review panel twice, so there was nothing to compare');
      }
      for (const run of [matched, missed]) {
        const label = run.takeTheLessonAnswer ? 'the matching run' : 'the non-matching run';
        if (run.chose === null || run.chose === undefined) {
          return fail(
            `${label} could not find the lesson's own answer on the page, so it diverged from nothing`,
          );
        }
        if (run.reachedReview !== true) {
          return fail(
            `${label} never reached the review panel, so this assertion checked no end of any quiz`,
          );
        }
        if ((run.panel ?? '').length < 100) {
          return fail(
            `${label} read ${(run.panel ?? '').length} characters of review panel; a sweep of nothing is not a pass`,
          );
        }
      }
      // The divergence, proved rather than assumed. Two runs that answered the same way would agree
      // about everything including a score, and this check would pass a scoreboard.
      if (matched.chose.wanted === missed.chose.wanted) {
        return fail('both runs picked the same option, so nothing about correctness differed between them');
      }
      if (!/^That matches the answer this lesson gives/u.test(matched.verdict ?? '')) {
        return fail(
          `the run that picked the lesson's own answer was told "${(matched.verdict ?? '').slice(0, 60)}", ` +
            'so it did not match after all and the two runs may have scored the same',
        );
      }
      if (!/^That is not the answer this lesson gives/u.test(missed.verdict ?? '')) {
        return fail(
          `the run that picked another option was told "${(missed.verdict ?? '').slice(0, 60)}", so it ` +
            'matched too and the two runs scored the same',
        );
      }
      if (matched.main !== missed.main) {
        return fail(
          'the end of the quiz reads differently depending on whether the answer matched, so something ' +
            `on the page is derived from correctness. Matching run: "${firstDifference(
              matched.main,
              missed.main,
            )}"`,
        );
      }
      if (JSON.stringify(matched.regions) !== JSON.stringify(missed.regions)) {
        return fail(
          'a live region at the end of the quiz holds different text depending on whether the answer ' +
            `matched: ${JSON.stringify(matched.regions)} against ${JSON.stringify(missed.regions)}`,
        );
      }
      const tally = TALLY_SHAPE.exec(matched.panel ?? '');
      if (tally !== null) {
        return fail(
          `the review panel announces "${tally[0]}", which is a tally. The panel is where the quiz ends ` +
            'and there is nothing there for a figure to be about except the answers',
        );
      }
      return pass(
        `identical over ${matched.main.length} characters of main across a matched and an unmatched run, ` +
          'no tally shape in the panel',
      );
    },
  },
];

/** Where two strings first differ, with a little either side. For a failure message that can be read. */
export function firstDifference(left, right) {
  const a = left ?? '';
  const b = right ?? '';
  let at = 0;
  while (at < a.length && at < b.length && a[at] === b[at]) at += 1;
  const from = Math.max(0, at - 30);
  return `…${a.slice(from, at + 50)}…` + ` / …${b.slice(from, at + 50)}…`;
}

// ---------------------------------------------------------------------------
// Journey 3 — the poker table and the Coach, at a desktop width
// ---------------------------------------------------------------------------

const POT_READOUT = /^Pot: [\d,]+ units?$/u;

async function gatherTable(page) {
  const evidence = {};
  evidence.heroCards = await axFor(page, '.prl-seat--self .prl-card');
  evidence.faceDown = (await axFor(page, '.prl-card--face-down')).map((entry) => ({
    name: entry.name,
    html: entry.html,
    rendered: !entry.ignored,
  }));
  evidence.boardCaption = await boardCaption(page);
  evidence.boardCaptionInTree =
    (await axFor(page, '.prl-table__board .prl-card-row__label'))[0]?.ignored === false;

  evidence.potFirst = await potReadout(page);
  await page.settle(1300);
  evidence.potSecond = await potReadout(page);

  evidence.coachHeadings = (await axFor(page, '.prl-coach h2, .prl-coach h3')).map((entry) => ({
    level: entry.level,
    name: entry.name,
  }));
  evidence.coachSections = await page.evaluate(
    `(() => [...document.querySelectorAll('.prl-coach__section')].map((section) => ({
        heading: (section.querySelector('h3')?.textContent ?? '').replace(/\\s+/gu, ' ').trim(),
        hasFigure: /\\d/u.test(section.textContent ?? ''),
      })))()`,
  );
  evidence.assumptions = await page.evaluate(
    `(() => {
      const section = document.querySelector('.prl-coach .prl-assumptions');
      if (section === null) return null;
      const details = section.closest('details');
      return {
        collapsed: details !== null && details.open !== true,
        inDetails: details !== null,
        hidden: section.hidden === true || getComputedStyle(section).display === 'none',
        items: section.querySelectorAll('.prl-assumptions__item').length,
      };
    })()`,
  );

  evidence.slider = (await axFor(page, 'input[type="range"].prl-sizer__slider'))[0] ?? null;
  evidence.sizerNumber = (await axFor(page, 'input[type="number"].prl-sizer__number'))[0] ?? null;
  evidence.actionButtons = await actionButtons(page);

  await actAtTheTable(page, evidence);
  return evidence;
}

/**
 * The board's caption, and whether it really arrives before the cards it describes.
 *
 * Read as reading order rather than as the `<figure>`'s accessible name, and that is a correction
 * rather than a shortcut. Chrome does not compute a figure's name from its `figcaption` at all:
 * measured in Chrome 151 against `<figure><figcaption>plain caption</figcaption>…</figure>`, the
 * figure's computed name is the empty string, with or without the caption being visually hidden,
 * and only an explicit `aria-label` names it. So a check written against the group's NAME would
 * report a defect against markup that is correct, and send somebody to add an `aria-label` that
 * duplicates the caption. What 3.9 actually asks — that the board is announced as a whole before
 * the cards are met one at a time — is a question about reading order, and this is that question.
 */
function boardCaption(page) {
  return page.evaluate(
    `(() => {
      const figure = document.querySelector('.prl-table__board .prl-card-row');
      if (figure === null) return null;
      const caption = figure.querySelector('.prl-card-row__label');
      if (caption === null) return null;
      const cards = [...figure.querySelectorAll('.prl-card')];
      return {
        text: (caption.textContent ?? '').replace(/\\s+/gu, ' ').trim(),
        ariaHidden: caption.closest('[aria-hidden="true"]') !== null,
        rendered: getComputedStyle(caption).display !== 'none',
        beforeCards:
          cards.length > 0 &&
          cards.every((card) => (caption.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0),
        cardNames: cards.map((card) => card.getAttribute('aria-label') ?? ''),
      };
    })()`,
  );
}

/**
 * Each action control's computed name, alongside the `aria-label` it is supposed to come from.
 *
 * Both halves, and the second one is not redundant — it is what makes this check able to fail. The
 * visible label and the cost are two separate spans, so removing the `aria-label` leaves the button
 * named from its own content. Measured in Chrome 151: with the label removed the computed name is
 * `"Fold 0 units"`, because accname joins the two spans with a space. That reads well enough to
 * satisfy any pattern written against the NAME alone, and the actual regression — a reader losing
 * "gives up the hand and any claim on the pot", and the whole sentence form 3.14 asks for — sails
 * through. Found by breaking the component: the first version of this check passed a build with
 * every action `aria-label` deleted.
 *
 * So the check asserts the name is the label the app authored, and that the label is a sentence.
 */
function actionButtons(page) {
  return page.evaluate(
    `(() => [...document.querySelectorAll('button.prl-action-btn')].map((button) => ({
        ariaLabel: (button.getAttribute('aria-label') ?? '').replace(/\\s+/gu, ' ').trim(),
        text: (button.textContent ?? '').replace(/\\s+/gu, ' ').trim(),
      })))()`,
  );
}

async function potReadout(page) {
  const regions = await liveRegions(page);
  return regions.find((region) => POT_READOUT.test(region.text))?.text ?? null;
}

/** Fold with a real Enter, then read the announcement surface and the caret. */
async function actAtTheTable(page, evidence) {
  const target = await page.evaluate(
    `(() => {
      const named = (b) => (b.getAttribute('aria-label') ?? b.textContent ?? '').replace(/\\s+/gu, ' ').trim();
      const button = [...document.querySelectorAll('button')]
        .filter((b) => /^fold\\b/iu.test(named(b)))
        .find((b) => !b.disabled);
      if (button === undefined) return null;
      button.focus();
      return named(button);
    })()`,
  );
  evidence.foldTarget = target;
  if (target === null) return;
  await page.press('Enter');
  await page.settle(900);
  const regions = await liveRegions(page);
  evidence.afterFold = regions.map((region) => ({ role: region.role, live: region.live, text: region.text }));
  evidence.foldEchoRegions = regions.filter((region) => /^You chose to fold\./u.test(region.text));
  evidence.afterFoldFocus = await focusedAx(page);
}

const TABLE_CHECKS = [
  {
    id: 'J3.7',
    what: 'your own cards are named by rank and suit, in words',
    decide: (e) => {
      const rendered = e.heroCards.filter((card) => !card.ignored);
      if (rendered.length === 0) return fail('no cards on your own seat plate; the table did not render');
      const wrong = rendered.filter((card) => !CARD_NAMED_IN_WORDS.test(card.name));
      if (wrong.length > 0) {
        return fail(
          `${wrong.length} of your own card(s) are named ` +
            `${wrong.map((card) => `"${card.name}"`).join(', ')}; a reader needs "ace of spades", ` +
            'not a letter and a symbol',
        );
      }
      return pass(rendered.map((card) => `"${card.name}"`).join(', '));
    },
  },
  {
    id: 'J3.8',
    what: 'no face-down card names a rank or a suit, in its name or in its markup',
    decide: (e) => {
      if (e.faceDown.length === 0) {
        return fail('no face-down card on a route that renders an opponent, so nothing was proved');
      }
      for (const card of e.faceDown) {
        const leak = CARD_VALUE_WORDS.exec(card.name) ?? CARD_VALUE_WORDS.exec(card.html);
        if (leak !== null) {
          return fail(
            `a face-down card discloses "${leak[0]}". The server withheld this card; this is a ` +
              'hidden-information leak before it is an accessibility defect — STOP and file it as one',
          );
        }
        if (card.rendered && !/face[- ]?down|hidden|not shown/iu.test(card.name)) {
          return fail(`a face-down card is named "${card.name}", which does not say that it is hidden`);
        }
      }
      return pass(`${e.faceDown.length} face-down card(s), all named as hidden and none disclosing`);
    },
  },
  {
    id: 'J3.9',
    what: 'the board is announced as a whole, before the individual cards',
    decide: (e) => {
      const caption = e.boardCaption;
      if (caption === null) return fail('the board has no caption element at all');
      if (!/^community cards:/iu.test(caption.text)) {
        return fail(
          `the board caption reads "${caption.text}"; a reader meets the cards one at a time with ` +
            'nothing saying they are the board',
        );
      }
      if (caption.ariaHidden || !caption.rendered || !e.boardCaptionInTree) {
        return fail(
          'the board caption is in the DOM and out of the accessibility tree, so it is announced by ' +
            'nothing and the board is a row of unexplained cards',
        );
      }
      if (!caption.beforeCards) {
        return fail('the board caption does not precede the cards, so it arrives after them or not at all');
      }
      const missing = caption.cardNames.filter((card) => card !== '' && !caption.text.includes(card));
      if (missing.length > 0) {
        return fail(
          `the caption says "${caption.text}" but the board holds ` +
            `${missing.map((card) => `"${card}"`).join(', ')} as well`,
        );
      }
      return pass(`"${caption.text}", ahead of ${caption.cardNames.length} card(s)`);
    },
  },
  {
    id: 'J3.10',
    what: 'the pot announces with its label, as one settled figure',
    decide: (e) => {
      if (e.potFirst === null) {
        return fail(
          'no live region announces the pot with its label; a reader hears a bare number or nothing',
        );
      }
      if (e.potSecond !== e.potFirst) {
        return fail(
          `the pot readout changed from "${e.potFirst}" to "${e.potSecond}" with nothing happening. ` +
            'A reader hears a run of intermediate numbers counting up instead of the figure',
        );
      }
      return pass(`"${e.potFirst}", stable`);
    },
  },
  {
    id: 'J3.12',
    what: 'the Coach sections are headings with figures, and the assumptions are never collapsed',
    decide: (e) => {
      const wanted = [/^Equity$/iu, /^The price$/iu, /^Outs\b/iu, /^Stack context$/iu];
      const missing = wanted.filter(
        (pattern) => !e.coachHeadings.some((heading) => pattern.test(heading.name)),
      );
      if (missing.length > 0) {
        return fail(
          `${missing.length} Coach section(s) are not headings in the computed tree; the panel is ` +
            `${e.coachHeadings.map((heading) => `"${heading.name}"`).join(', ') || 'empty'}`,
        );
      }
      const figureless = e.coachSections.filter((section) => !section.hasFigure);
      if (figureless.length > 0) {
        return fail(
          `${figureless.length} Coach section(s) carry no figure at all: ` +
            figureless.map((section) => `"${section.heading}"`).join(', '),
        );
      }
      if (e.assumptions === null) return fail('the Coach panel has no assumptions block');
      if (e.assumptions.collapsed || e.assumptions.hidden) {
        return fail(
          'the assumptions are collapsed or hidden. Every figure in the panel rests on them, and ' +
            'this product does not let them be an optional extra',
        );
      }
      if (e.assumptions.items === 0) return fail('the assumptions block rendered with no items in it');
      return pass(`4 sections with figures, ${e.assumptions.items} assumptions, none collapsed`);
    },
  },
  {
    id: 'J3.13',
    what: 'the bet sizer announces a name, a range and a value, and the field beside it its own label',
    decide: (e) => {
      if (e.slider === null) return fail('no slider on a route that renders a decision');
      if (e.slider.role !== 'slider')
        return fail(`the sizer computes as role "${e.slider.role}", expected slider`);
      if (isBareName(e.slider.name)) return fail(`the slider computes as "${e.slider.name}", a bare role`);
      if (e.slider.valuemin === undefined || e.slider.valuemax === undefined) {
        return fail(
          'the slider reaches the tree without a minimum or a maximum, so a reader is asked for a ' +
            'size with no idea what sizes are legal',
        );
      }
      if (e.slider.value === '' && e.slider.valuemin === undefined) return fail('the slider has no value');
      if (e.sizerNumber === null || isBareName(e.sizerNumber.name)) {
        return fail(`the number field beside the slider computes as "${e.sizerNumber?.name ?? 'nothing'}"`);
      }
      return pass(
        `slider "${e.slider.name}" ${e.slider.valuemin}–${e.slider.valuemax} at ${e.slider.value || '?'}, ` +
          `field "${e.sizerNumber.name}"`,
      );
    },
  },
  {
    id: 'J3.14',
    what: 'each action button announces the action and its cost as a sentence',
    decide: (e) => {
      if (e.actionButtons.length === 0) return fail('no action buttons on a route that renders a decision');
      const unlabelled = e.actionButtons.filter((button) => button.ariaLabel === '');
      if (unlabelled.length > 0) {
        return fail(
          `${unlabelled.length} action button(s) carry no aria-label, so they are named from their ` +
            `own content — ${unlabelled.map((button) => `"${button.text}"`).join(' · ')}. The word ` +
            'and the cost are separate spans, so what is left is a run-together string with the ' +
            'sentence about what the action does thrown away',
        );
      }
      const wrong = e.actionButtons.filter((button) => !announcesActionAndCost(button.ariaLabel));
      if (wrong.length > 0) {
        return fail(
          `${wrong.length} action button(s) do not announce an action and a cost as a sentence: ` +
            wrong.map((button) => `"${button.ariaLabel}"`).join(' · '),
        );
      }
      return pass(e.actionButtons.map((button) => `"${button.ariaLabel.slice(0, 34)}"`).join(', '));
    },
  },
  {
    id: 'J3.15',
    what: 'acting announces the decision once, politely',
    decide: (e) => {
      if (e.foldTarget === null) return fail('no enabled Fold control on a route that renders a decision');
      if (e.foldEchoRegions.length === 0) {
        return fail(
          'after folding, no live region opens with "You chose to fold." — a reader who cannot see ' +
            'the screen was told nothing about their own action. Regions held ' +
            `${JSON.stringify(
              e.afterFold
                .map((region) => region.text)
                .filter(Boolean)
                .slice(0, 3),
            )}`,
        );
      }
      if (e.foldEchoRegions.length > 1) {
        return fail(`${e.foldEchoRegions.length} regions echo the decision; it is announced once`);
      }
      const region = e.foldEchoRegions[0];
      if (region.role === 'alert' || region.live === 'assertive') {
        return fail(
          'the decision echo is assertive, so it cuts off whatever the table was in the middle of ' +
            'saying. Only a refusal interrupts on this screen',
        );
      }
      return pass(`"${region.text.slice(0, 46)}…" politely, once`);
    },
  },
  {
    id: 'J3.16',
    what: 'acting leaves the caret on a named node, not on the document',
    decide: (e) => {
      if (e.foldTarget === null) return fail('no enabled Fold control on a route that renders a decision');
      if (e.afterFoldFocus.onDocument) {
        return fail(
          'after acting, focus is on the document itself. The control the reader pressed disabled ' +
            'itself and the browser blurred it, so a keyboard reader is returned to the top of the ' +
            'page and is told nothing about what their decision did',
        );
      }
      if (isBareName(e.afterFoldFocus.name)) {
        return fail(
          `the caret landed on a ${e.afterFoldFocus.role} with no computed name, which is announced ` +
            'as a bare role and tells the reader nothing about where they now are',
        );
      }
      return pass(`${e.afterFoldFocus.role}: "${e.afterFoldFocus.name}"`);
    },
  },
];

// ---------------------------------------------------------------------------
// Journey 3, continued — the narrow-width analysis disclosure
// ---------------------------------------------------------------------------

async function gatherTableNarrow(page) {
  const evidence = {};
  evidence.handle = (await axFor(page, 'button.prl-play__handle'))[0] ?? null;
  if (evidence.handle === null || evidence.handle.ignored) return evidence;
  await page.evaluate(`document.querySelector('button.prl-play__handle').focus()`);
  await page.press('Enter');
  await page.settle(600);
  evidence.handleAfter = (await axFor(page, 'button.prl-play__handle'))[0] ?? null;
  return evidence;
}

const TABLE_NARROW_CHECKS = [
  {
    id: 'J3.21',
    what: 'the narrow-width analysis disclosure is a button that reports its expanded state',
    decide: (e) => {
      if (e.handle === null || e.handle.ignored) {
        return fail('no analysis disclosure in the computed tree below 600px, so the panel cannot be opened');
      }
      if (e.handle.role !== 'button') return fail(`the disclosure computes as role "${e.handle.role}"`);
      if (isBareName(e.handle.name))
        return fail(`the disclosure computes as "${e.handle.name}", a bare role`);
      if (e.handle.expanded !== false) {
        return fail(
          `the disclosure reports expanded=${String(e.handle.expanded)} before it is pressed; a ` +
            'reader is told the panel is open when it is not',
        );
      }
      if (e.handleAfter === null || e.handleAfter.expanded !== true) {
        return fail(
          `after activating it the disclosure reports expanded=${String(e.handleAfter?.expanded)}. ` +
            'The state change is the only thing that tells a reader anything happened',
        );
      }
      return pass(`"${e.handle.name}" false -> "${e.handleAfter.name}" true`);
    },
  },
];

// ---------------------------------------------------------------------------
// Journey 3, continued — a LIVE table, over a real socket
//
// The fixture routes `/play?state=...` render this screen's component tree without a server, which
// is what the eleven assertions below used to be blocked on: a connection that never changes state,
// blinds that never arrive, a turn that is never yours, a decision no server answers and a hand
// that never completes. Everything here is driven against `/play` itself — a guest session, a
// private room with five bots, a real WebSocket, a real hand — and read out of the live-region log
// `SPEECH_PROBE` keeps.
//
// Two facts about this fixture that are easy to get wrong and expensive to debug:
//
//   - The API must allow this audit's own origin. `PUBLIC_WEB_ORIGIN` is one allowlist for CORS and
//     for the socket's `Origin` check, so an API started with a developer's `.env` answers every
//     browser-side call from `127.0.0.1:3456` with `forbidden` and the table never opens.
//     `ax-tree-audit.mjs` sets it on the API it starts; with `--no-start` it is the operator's.
//   - The reader must be new. Chrome keeps its profile between runs, so a second run reuses the
//     room the first left the reader seated in and "Take seat 1" is never offered.
// ---------------------------------------------------------------------------

/** Where each of the three regions this journey listens to lives, as a `SPEECH_PROBE` key. */
const CONNECTION_REGION = /prl-play__connection-lines/u;
// `prl-play__table`, not `prl-table`: the narration region is mounted by `TableStage` rather than
// by `PokerTable`, because `PokerTable` is not rendered until a view exists and a live region that
// is inserted already holding its first sentence is announced by nothing. See 3.3.
const TABLE_REGION = /prl-play__table>prl-live-region/u;
const TURN_REGION = /prl-play__decision>prl-live-region/u;

/** How long 3.6 sits on its own turn without acting. The assertion says ten seconds; this is it. */
const TURN_DWELL_MS = 10_000;

/**
 * How far short of `TURN_DWELL_MS` a measured dwell may fall and still count as ten seconds.
 *
 * ## Why there is a tolerance at all
 *
 * The dwell is `setTimeout(10_000)` bracketed by two `Date.now()` reads, and neither end is exact.
 * `setTimeout` is a *minimum* by specification, timer resolution is coarsened by browsers and by
 * the platform, and `Date.now()` is a wall clock that can be stepped by NTP mid-measurement. One
 * run of this gate failed with
 *
 *     the run waited 9999ms on its own turn, not the 10000ms this assertion asks for
 *
 * — a one millisecond shortfall, in a release gate, on a check about whether a live region was
 * rewritten. That is a false failure: nothing the assertion is about could differ between 9,999ms
 * and 10,000ms of state frames, and a gate that fails on a 1ms wall-clock shortfall costs more
 * than it catches — the cost being that a red `verify` stops meaning "something is wrong".
 *
 * ## Why it is 250ms and not larger
 *
 * The guard this bound protects is real and is stated in the failure message: a SHORT wait can miss
 * a re-announcement and then report a silence it never observed. 250ms is two orders of magnitude
 * below the ten seconds being asked for (2.5%) and far below the interval at which this app pushes
 * whole-state frames, so a dwell inside the tolerance has still seen many frames. Anything that
 * genuinely cut the dwell short — a `settle` that returned early, a `dwellMs` that was never
 * passed, a hand that ended — is off by seconds, not by milliseconds, and is still caught.
 */
const TURN_DWELL_TOLERANCE_MS = 250;

/** The reader's own decision, echoed by the reducer. `spokenDecision` in `use-live-table.ts`. */
const FOLD_ECHO = /^You chose to fold\./u;

/** The sentence 3.3 is about, at the front of whatever else the deal brought with it. */
const DEALT_ANNOUNCEMENT = /^A new hand was dealt\./u;

const entriesFrom = (log, region) => (log ?? []).filter((entry) => region.test(entry.key ?? ''));

/**
 * Focus an enabled control whose name matches, then press Enter on it.
 *
 * A real key through Chrome's input pipeline rather than `element.click()`, for the reason the
 * journey audit gives at length: a synthesised click does not exercise the keyboard path, and the
 * focus rescues this screen depends on are written against a browser that blurs a control it has
 * just removed. Returns the name it pressed, or null when nothing matched.
 */
async function pressControl(page, pattern) {
  const name = await page.evaluate(
    `(() => {
      const named = (b) => (b.getAttribute('aria-label') ?? b.textContent ?? '').replace(/\\s+/gu, ' ').trim();
      const wanted = new RegExp(${JSON.stringify(pattern.source)}, ${JSON.stringify(pattern.flags)});
      const button = [...document.querySelectorAll('button')]
        .filter((b) => wanted.test(named(b)))
        .find((b) => !b.disabled);
      if (button === undefined) return null;
      button.focus();
      return named(button);
    })()`,
  );
  if (name === null) return null;
  await page.press('Enter');
  return name;
}

/** True when no enabled control on the page answers to `pattern` any more. */
function controlGone(page, pattern) {
  return page.evaluate(
    `(() => {
      const named = (b) => (b.getAttribute('aria-label') ?? b.textContent ?? '').replace(/\\s+/gu, ' ').trim();
      const wanted = new RegExp(${JSON.stringify(pattern.source)}, ${JSON.stringify(pattern.flags)});
      return ![...document.querySelectorAll('button')].some((b) => wanted.test(named(b)));
    })()`,
  );
}

/** Poll the page until `expression` is true, or give up. Returns whether it became true. */
async function waitInPage(page, expression, seconds) {
  for (let attempt = 0; attempt < seconds * 4; attempt += 1) {
    await page.settle(250);
    if ((await page.evaluate(expression).catch(() => false)) === true) return true;
  }
  return false;
}

const ENABLED_ACTION = `[...document.querySelectorAll('button.prl-action-btn')].some((b) => !b.disabled)`;

/**
 * Open a table, sit down, deal, fold when the decision arrives, and let the hand finish.
 *
 * The product's own path, pressed one control at a time — the same journey `scripts/smoke-test.mjs`
 * drives over a bare socket, driven here through the screen instead, because what is being asserted
 * is what the screen said while it happened.
 *
 * `fresh` clears the cookie jar first, which the live-table route needs and the replay route must
 * not do: it is reading back a hand that belongs to the session it already has.
 *
 * `decide` is how the decision is made when the turn arrives. It defaults to one Fold pressed with
 * a real Enter key; 3.19 substitutes a double press, which is the only fixture that reaches a
 * server refusal. See `foldTwiceInOneTask`.
 */
async function driveLiveHand(page, baseUrl, { fresh = false, dwellMs = 0, decide = foldOnce } = {}) {
  const evidence = { steps: [], reachedTurn: false, dwellMs: 0, complete: false, turnOpenedAt: null };
  if (fresh) await page.clearCookies();
  await page.goto(`${baseUrl}/play`);
  await page.evaluate('window.__prlSpeechReset && window.__prlSpeechReset()');

  evidence.opened = await pressControl(page, /^Open the table$/iu);
  if (evidence.opened === null) return { ...evidence, ...(await speechSoFar(page)) };
  await page.settle(700);
  evidence.steps.push({
    control: evidence.opened,
    gone: await controlGone(page, /^Open the table$/iu),
    focus: await focusedAx(page),
  });

  evidence.socketLive = await waitInPage(
    page,
    '/Take seat|Deal the next hand|Stand up/u.test(document.body.innerText)',
    45,
  );
  if (!evidence.socketLive) return { ...evidence, ...(await speechSoFar(page)) };

  // Only when a seat is on offer. A session that is already seated at its own room — which is what
  // the replay route finds when it has to play a hand of its own — is a legitimate state, not a
  // failure, and the seat step is simply not part of that run.
  evidence.sat = await pressControl(page, /^Take seat \d+$/iu);
  if (evidence.sat !== null) {
    await page.settle(900);
    evidence.steps.push({
      control: evidence.sat,
      gone: await controlGone(page, /^Take seat \d+$/iu),
      focus: await focusedAx(page),
    });
  }

  await waitInPage(page, '/Deal the next hand/u.test(document.body.innerText)', 25);
  // Read BEFORE the deal, because that is when it decides anything: see 3.3. The narration region
  // has to already be in the document when the hand starts, or the sentence arrives with the region
  // that holds it and no assistive technology is notified of a change.
  evidence.regionsBeforeDeal = await page.evaluate(
    'window.__prlSpeechRegions ? window.__prlSpeechRegions() : []',
  );
  evidence.dealt = await pressControl(page, /^Deal the next hand$/iu);
  if (evidence.dealt === null) return { ...evidence, ...(await speechSoFar(page)) };

  evidence.reachedTurn = await waitInPage(page, ENABLED_ACTION, 60);
  if (!evidence.reachedTurn) return { ...evidence, ...(await speechSoFar(page)) };
  const opened = await speechSoFar(page);
  evidence.turnOpenedAt = entriesFrom(opened.log, TURN_REGION).at(-1)?.at ?? null;

  // 3.6: ten seconds on your own turn, doing nothing, while the server pushes whole-state frames.
  if (dwellMs > 0) {
    const started = Date.now();
    await page.settle(dwellMs);
    evidence.dwellMs = Date.now() - started;
  }

  evidence.folded = await decide(page, evidence);
  await page.settle(1400);
  evidence.foldFocus = await focusedAx(page);
  evidence.complete = await waitInPage(page, '/The hand is complete/u.test(document.body.innerText)', 90);
  await page.settle(700);
  return { ...evidence, ...(await speechSoFar(page)) };
}

/** One Fold, through Chrome's own key pipeline. What a reader does, and what 3.15 and 3.16 read. */
const foldOnce = (page) => pressControl(page, /^fold\b/iu);

/**
 * Two decisions out of one seat before the controls can disable themselves — the fixture for 3.19.
 *
 * ## Why this is not the race the document said it was
 *
 * 3.19 was `person` because "provoking a server refusal needs a decision the server rejects, and
 * this client disables the controls the instant one is sent" — with the conclusion that the only
 * remaining route was a second actor racing the same seat. The premise is right about a human and
 * wrong about a task: `disabled` arrives from React state, so it is applied on the NEXT render, and
 * two `click()`s inside one task both reach `act`, which mints a fresh `actionId` for each. Both
 * frames go out over one socket, in order. Measured against the running server: the second click
 * saw `button.disabled === false`, and the server answered
 * `"It is not your turn to act. (not_your_turn). Nothing was applied."` — a real refusal of a real
 * second decision, with no second actor anywhere.
 *
 * A real Enter key cannot do this and that is not a shortcoming of the fixture: two key events are
 * two tasks by construction, and by the second one the control is genuinely disabled. The keyboard
 * path to a decision is what 3.15 and 3.16 press; what 3.19 is about is the fate of the second one.
 *
 * The refusal code is deliberately not pinned. Which one the server picks depends on where the hand
 * got to between the two frames — `not_your_turn` once the fold has moved the action on,
 * `stale_action_sequence` if it has not — and 3.19 is about the refusal being heard, not about
 * which refusal it was.
 */
async function foldTwiceInOneTask(page, evidence) {
  const result = await page.evaluate(
    `(() => {
      const named = (b) => (b.getAttribute('aria-label') ?? b.textContent ?? '').replace(/\\s+/gu, ' ').trim();
      const button = [...document.querySelectorAll('button.prl-action-btn')]
        .filter((b) => /^fold\\b/iu.test(named(b)))
        .find((b) => !b.disabled);
      if (button === undefined) return null;
      button.click();
      // Read between the two presses. If this is ever false the fixture has stopped working: the
      // second click would be refused by the browser and no second decision would be sent, and the
      // check below would then be reporting a silence it manufactured.
      const stillEnabled = !button.disabled;
      button.click();
      return { name: named(button), stillEnabled };
    })()`,
  );
  evidence.doubleAct = result;
  return result === null ? null : result.name;
}

const gatherLiveTable = (page, baseUrl) =>
  driveLiveHand(page, baseUrl, { fresh: true, dwellMs: TURN_DWELL_MS });

/** 3.19's own hand, played to the same turn and then acted on twice. */
const gatherRefusedDecision = (page, baseUrl) =>
  driveLiveHand(page, baseUrl, { fresh: true, decide: foldTwiceInOneTask });

/** The sentence `statusSentence` prints while the session and the room are being found. */
const PREPARING = /^Preparing: reading your session/u;
const LIVE_STATUS = /^Live\. Everything on this screen is the server/u;

const LIVE_TABLE_CHECKS = [
  {
    id: 'J3.1',
    what: 'the connection status is announced politely as it changes, preparing then live',
    decide: (e) => {
      if (e.opened === null)
        return fail('no "Open the table" control on /play; the live table did not render');
      const status = entriesFrom(e.log, CONNECTION_REGION);
      if (status.length === 0) {
        return fail('the connection panel wrote nothing into any live region, so the transport is silent');
      }
      const preparing = status.findIndex((entry) => PREPARING.test(entry.text));
      const live = status.findIndex((entry) => LIVE_STATUS.test(entry.text));
      if (preparing < 0) {
        return fail(
          `the status region never said it was preparing; it held ${JSON.stringify(
            status.map((entry) => entry.text.slice(0, 40)),
          )}. A reader presses "Open the table" and is told nothing until it works`,
        );
      }
      if (live < 0) {
        /*
          The one non-accessibility reason this fails, named because it costs an hour otherwise:
          `PUBLIC_WEB_ORIGIN` is one allowlist for CORS and for the socket's `Origin` check, so an
          API started with a developer's `.env` answers every browser-side call from this audit's
          origin with `forbidden` and no table ever opens. `ax-tree-audit.mjs` sets it on the API it
          starts; with `--no-start` it is whatever the running API was given.
        */
        const refused = (e.log ?? []).some((entry) => /forbidden|not authenticated/iu.test(entry.text));
        return fail(
          'the status region never announced that the table went live, so a reader who cannot see ' +
            `the screen never learns the connection is up. It held ${JSON.stringify(
              status.map((entry) => entry.text.slice(0, 40)),
            )}` +
            (refused
              ? '. The API refused this origin — check that it was started with PUBLIC_WEB_ORIGIN ' +
                'set to the origin this audit is driving, which is what --start does for you'
              : ''),
        );
      }
      if (live < preparing)
        return fail('the table announced itself live before it announced it was preparing');
      const shouty = status.filter((entry) => entry.live === 'assertive' || entry.role === 'alert');
      if (shouty.length > 0) {
        return fail(
          `${shouty.length} connection status message(s) are assertive, so a socket state change cuts ` +
            'off whatever the reader was in the middle of',
        );
      }
      return pass(`${status.length} polite status changes, preparing -> live`);
    },
  },
  {
    id: 'J3.2',
    what: 'after opening the table and taking a seat, the caret lands on the status line',
    decide: (e) => {
      if (e.steps.length < 2) {
        return fail(
          `only ${e.steps.length} of the two setup controls were reached ` +
            `(opened ${JSON.stringify(e.opened)}, seated ${JSON.stringify(e.sat ?? null)}); ` +
            'the seat step is where the caret is most often dropped, so a run without it proves nothing',
        );
      }
      for (const step of e.steps) {
        if (!step.gone) {
          return fail(`"${step.control}" is still on the page after being activated`);
        }
        if (step.focus.onDocument) {
          return fail(
            `after "${step.control}" the caret is on the document itself. The control the reader ` +
              'pressed was removed and the browser dropped focus, so a keyboard reader is returned ' +
              'to the top of the page and hears nothing about what changed',
          );
        }
        if (isBareName(step.focus.name)) {
          return fail(
            `after "${step.control}" the caret landed on a ${step.focus.role} with no computed name`,
          );
        }
        if (step.focus.role !== 'status') {
          return fail(
            `after "${step.control}" the caret landed on a ${step.focus.role} named ` +
              `"${step.focus.name.slice(0, 40)}", not on the status line that says what just changed`,
          );
        }
      }
      return pass(e.steps.map((step) => `${step.control} -> "${step.focus.name.slice(0, 32)}…"`).join(', '));
    },
  },
  {
    /*
      3.3 was `person` because the sentence was measurably never announced, which is a defect rather
      than a certification limit — see `onEventFrame` in `apps/web/src/lib/use-live-table.ts`. This
      check is what stops it coming back, and every clause of it was written against a run that
      passed a weaker version of the same check:

        - **the narration region must already EXIST when the hand is dealt.** A live region inserted
          already holding its sentence is not announced: the platform is notified of a CHANGE to a
          region it knows about, and a moment earlier there was no region. Measured on this gate
          before the fix — at the moment "Deal the next hand" was pressed the document's only live
          regions were the route announcer, the connection line, the invite and join notes, the
          decision band's turn region and the footer statement;
        - **the entry must be one the region was observed HOLDING** (`recovered !== true`). A value
          recovered from `characterData` old values existed inside one React commit and never
          painted, so nothing was ever notified of it;
        - **it must not stand alone.** This is the clause the first version of this check lacked,
          and a deliberately broken build passed without it. `handStarted` and `forcedBets` are two
          events of ONE table notice, so with the region mounted the run recorded two writes for one
          notice: "A new hand was dealt." and then the blinds, milliseconds apart. `role="status"`
          is atomic and a polite region is read when the notification is serviced, not when it is
          posted, so the reader hears the last text and the deal is lost exactly as before — the
          only difference being that the loss is now visible to a probe. One notice must be one
          write, so the text that opens with the deal has to carry what the deal brought with it;
        - **it must be said once.** A sentence left in front of the table's later narration is read
          again on every event for the rest of the hand — the defect 3.17 catches, in reverse.
    */
    id: 'J3.3',
    what: 'the deal is announced politely, once, in a region the page already had',
    decide: (e) => {
      if (e.dealt === null) return fail('the hand was never dealt, so nothing announced a deal');
      const narration = entriesFrom(e.log, TABLE_REGION);
      const hadRegion = (e.regionsBeforeDeal ?? []).some((key) => TABLE_REGION.test(key ?? ''));
      if (!hadRegion) {
        return fail(
          'the table had no narration region at the moment the hand was dealt, so whatever it says ' +
            `about the deal arrives WITH the region that holds it. Regions present: ${JSON.stringify(
              e.regionsBeforeDeal ?? [],
            )}. Chrome notifies a reader of a CHANGE to a live region it already knows about; a ` +
            'region inserted carrying its first sentence is silent, which is what a reader gets on ' +
            'the first hand of every session',
        );
      }
      const dealt = narration.filter((entry) => DEALT_ANNOUNCEMENT.test(entry.text));
      const painted = dealt.filter((entry) => entry.recovered !== true);
      if (painted.length === 0) {
        return fail(
          dealt.length === 0
            ? 'nothing the table said began with "A new hand was dealt." A reader who pressed the ' +
                `control is told the blinds and never told a hand started. The region held ${JSON.stringify(
                  narration.slice(0, 4).map((entry) => entry.text.slice(0, 44)),
                )}`
            : '"A new hand was dealt." exists only as a value recovered from a characterData old ' +
                'value: it was written and replaced inside one React commit and never painted, so no ' +
                'assistive technology was ever notified of it. That is silence, not an announcement',
        );
      }
      const first = painted[0];
      if (first.live !== 'polite' || first.role === 'alert') {
        return fail(`the deal is announced ${first.live}; a hand starting interrupts nothing`);
      }
      if (painted.length > 1) {
        return fail(
          `the deal sentence was written into the region ${painted.length} times: ${JSON.stringify(
            painted.map((entry) => entry.text.slice(0, 44)),
          )}. One hand, one deal, one announcement`,
        );
      }
      const rest = first.text.replace(DEALT_ANNOUNCEMENT, '').trim();
      if (rest === '') {
        const next = narration[narration.indexOf(first) + 1];
        return fail(
          'the region was written with "A new hand was dealt." and nothing else, so the forced bets ' +
            `that arrive in the same table notice took it back${
              next === undefined ? '' : ` — the next text it held was "${next.text.slice(0, 44)}"`
            }. A polite region is read when the notification is serviced rather than when it is ` +
            'posted, so two writes for one notice are one announcement and it is the second one. ' +
            'The deal has to be carried onto the front of the sentence that replaces it',
        );
      }
      const after = narration.slice(narration.indexOf(first) + 1);
      const carried = after.filter((entry) => DEALT_ANNOUNCEMENT.test(entry.text));
      if (carried.length > 0) {
        return fail(
          `"A new hand was dealt." is still in front of ${carried.length} later announcement(s) — ` +
            `"${carried[0].text.slice(0, 60)}". The region is atomic, so the reader hears the deal ` +
            'again on every event for the rest of the hand',
        );
      }
      return pass(`"${first.text.slice(0, 70)}…", polite, once`);
    },
  },
  {
    id: 'J3.4',
    what: 'the table narrates the forced bets first, then each seat action, politely and in order',
    decide: (e) => {
      if (e.dealt === null) return fail('the hand was never dealt, so no table event was announced');
      const narration = entriesFrom(e.log, TABLE_REGION);
      if (narration.length === 0) {
        return fail('the table narrated nothing at all; its polite region was never written to');
      }
      const blinds = narration.findIndex((entry) => /blind/iu.test(entry.text));
      if (blinds < 0) {
        return fail(
          `the forced bets were never announced. The table held ${JSON.stringify(
            narration.slice(0, 4).map((entry) => entry.text.slice(0, 40)),
          )}, so a reader is told the price of a decision they never heard being set`,
        );
      }
      const actions = narration.filter(
        (entry, index) => index > blinds && /\b(folds|checks|calls|bets|raises)\b/iu.test(entry.text),
      );
      if (actions.length === 0) {
        return fail('no seat action was announced after the blinds, so the hand was narrated as a blank');
      }
      const early = narration.findIndex((entry) => /\b(folds|checks|calls|bets|raises)\b/iu.test(entry.text));
      if (early < blinds) {
        return fail(
          `a seat action ("${narration[early].text.slice(0, 30)}") was announced before the forced bets, ` +
            'so the reader hears the hand out of the order it was played in',
        );
      }
      const shouty = narration.filter((entry) => entry.live === 'assertive' || entry.role === 'alert');
      if (shouty.length > 0) {
        return fail(`${shouty.length} table event(s) were announced assertively; the table never interrupts`);
      }
      return pass(`blinds first, then ${actions.length} seat action(s), all polite`);
    },
  },
  {
    id: 'J3.5',
    what: 'your turn is announced as one sentence carrying the street, the price, the pot, your stack and the actions',
    decide: (e) => {
      if (!e.reachedTurn) return fail('the hand never reached this seat, so no turn was announced');
      const turns = entriesFrom(e.log, TURN_REGION).filter((entry) => /^Your turn\b/u.test(entry.text));
      if (turns.length === 0) {
        return fail(
          'the decision became the reader’s and no region said so. Everything they need — that it is ' +
            'their turn, the street, the price, the pot, their stack and the legal actions — is on ' +
            'screen and unannounced',
        );
      }
      const sentence = turns[0].text;
      if (turns[0].live !== 'polite') return fail(`the turn sentence is ${turns[0].live}, and it must wait`);
      const missing = [
        ['the street', /^Your turn (preflop|on the (flop|turn|river)|at the end of the hand)\./u],
        ['the price', /(\d[\d,]* units? to call|Nothing to call)\./u],
        ['the pot', /Pot [\d,]+ units?/u],
        ['your stack', /your stack [\d,]+ units?/u],
        ['the legal actions', /You can [a-z, ]+\./u],
      ].filter(([, pattern]) => !pattern.test(sentence));
      if (missing.length > 0) {
        return fail(
          `the turn sentence is missing ${missing.map(([name]) => name).join(', ')}: "${sentence}"`,
        );
      }
      return pass(`"${sentence.slice(0, 70)}…"`);
    },
  },
  {
    id: 'J3.6',
    what: 'the turn sentence is announced once, and ten seconds of state frames do not repeat it',
    decide: (e) => {
      if (!e.reachedTurn) return fail('the hand never reached this seat, so nothing was dwelt on');
      // Not `< TURN_DWELL_MS`: `setTimeout` is a minimum, `Date.now()` is a wall clock, and this
      // gate has failed on a ONE millisecond shortfall. See `TURN_DWELL_TOLERANCE_MS` for the
      // measurement and for why the bound is still worth having.
      if (e.dwellMs < TURN_DWELL_MS - TURN_DWELL_TOLERANCE_MS) {
        return fail(
          `the run waited ${e.dwellMs}ms on its own turn, more than ${TURN_DWELL_TOLERANCE_MS}ms short ` +
            `of the ${TURN_DWELL_MS}ms this assertion asks for. A shorter wait can miss a ` +
            're-announcement and report silence it never observed',
        );
      }
      if (e.turnOpenedAt === null)
        return fail('no turn sentence was recorded, so there is nothing to repeat');
      const repeats = entriesFrom(e.log, TURN_REGION).filter(
        (entry) => entry.at > e.turnOpenedAt && entry.at <= e.turnOpenedAt + e.dwellMs,
      );
      if (repeats.length > 0) {
        return fail(
          `the turn region was rewritten ${repeats.length} time(s) while the reader sat on their own ` +
            `turn: ${JSON.stringify(repeats.map((entry) => entry.text.slice(0, 30)))}. This app pushes ` +
            'whole-state frames several times a second, and a region that follows them announces the ' +
            'same turn over and over until the reader turns live regions off',
        );
      }
      // The stronger half. A region rewritten with the SAME text changes nothing here and is still
      // a re-announcement in several readers, so the mutation count is what settles it.
      const churn = (e.mutations ?? []).filter(
        (entry) =>
          TURN_REGION.test(entry.key ?? '') &&
          entry.at > e.turnOpenedAt &&
          entry.at <= e.turnOpenedAt + e.dwellMs,
      );
      if (churn.length > 0) {
        return fail(
          `the turn region took ${churn.length} DOM mutation(s) during ${e.dwellMs}ms on one turn. The ` +
            'text did not change, so this is invisible on screen and is a repeat announcement to a reader',
        );
      }
      return pass(`one write, no mutation for ${e.dwellMs}ms of state frames`);
    },
  },
  {
    id: 'J3.11',
    what: 'the Coach analysis announces its arrival politely, carrying no figure',
    decide: (e) => {
      if (!e.reachedTurn) return fail('the hand never reached this seat, so no analysis was asked for');
      const arrival = (e.log ?? []).find((entry) =>
        /^The analysis of this decision is ready in the Coach panel/u.test(entry.text),
      );
      if (arrival === undefined) {
        const failed = (e.log ?? []).find((entry) => /^The analysis could not be shown/u.test(entry.text));
        return fail(
          failed === undefined
            ? 'the analysis arrived beside the buttons and nothing said so. On a narrow screen it is ' +
                'not even on the same screen, so a reader is never told it is there'
            : `the analysis was refused: "${failed.text.slice(0, 80)}"`,
        );
      }
      if (arrival.live !== 'polite' || arrival.role === 'alert') {
        return fail(`the Coach arrival is ${arrival.live}; an analysis is never urgent enough to interrupt`);
      }
      if (/\d/u.test(arrival.text)) {
        return fail(
          `the Coach arrival announcement carries a figure — "${arrival.text}". A number read out of ` +
            'the panel has left the assumptions it rests on behind, which is the one thing this ' +
            'product will not do with a figure',
        );
      }
      return pass(`"${arrival.text.slice(0, 60)}…"`);
    },
  },
  {
    id: 'J3.17',
    what: 'the decision echo is said once and is not stapled to the table events after it',
    decide: (e) => {
      if (e.folded === null) return fail('no enabled Fold control when the decision was the reader’s');
      const narration = entriesFrom(e.log, TABLE_REGION);
      const echoAt = narration.findIndex((entry) => FOLD_ECHO.test(entry.text));
      if (echoAt < 0) {
        return fail(
          'after folding, the table’s region never said "You chose to fold." — a reader who cannot ' +
            'see the screen was told nothing about their own decision',
        );
      }
      const after = narration.slice(echoAt + 1);
      if (after.length === 0) {
        return fail(
          'nothing was announced after the decision, so this run cannot tell whether the echo is ' +
            'carried onto the events that follow it — which is the whole of this assertion',
        );
      }
      const carried = after.filter((entry) => FOLD_ECHO.test(entry.text));
      if (carried.length > 0) {
        return fail(
          `"You chose to fold." is still in front of ${carried.length} later announcement(s) — ` +
            `"${carried[0].text.slice(0, 60)}". The region is atomic, so it is read whole every time ` +
            'and the reader hears their own fold again on every event for the rest of the hand',
        );
      }
      return pass(`echoed once, then ${after.length} clean event(s)`);
    },
  },
  {
    id: 'J3.18',
    what: 'the end of the hand is announced politely, with the result sentences',
    decide: (e) => {
      if (!e.complete) return fail('the hand did not finish within the time this fixture allows');
      const done = entriesFrom(e.log, TABLE_REGION).find((entry) =>
        /^The hand is complete\./u.test(entry.text),
      );
      if (done === undefined) {
        return fail('the hand finished and no region said so; the table simply stops talking');
      }
      if (done.live !== 'polite' || done.role === 'alert') {
        return fail(`the end of the hand is announced ${done.live}; it interrupts nothing`);
      }
      const summaries = done.text.replace(/^The hand is complete\./u, '').trim();
      if (summaries.length === 0) {
        return fail(
          'the hand is announced complete with no result after it, so a reader is told it ended and ' +
            'never told how',
        );
      }
      return pass(`"${done.text.slice(0, 64)}…"`);
    },
  },
];

/** The heading `SUBMISSION_TITLE.rejected` prints when the refusal came from the server. */
const SERVER_REFUSED = /The server refused it/u;

/**
 * The wording the server itself supplied, as `onErrorFrame` renders it: a sentence, then `(code)`.
 *
 * Matched as a shape rather than as a string. Which refusal arrives depends on where the hand got
 * to between the two frames, and pinning `not_your_turn` would fail the gate on a timing difference
 * that changes nothing about what a reader is told.
 */
const SERVER_REFUSAL_REASON = /\(([a-z_]+)\)\.\s*Nothing was applied\./u;

const REFUSED_DECISION_CHECKS = [
  {
    id: 'J3.19',
    what: 'a refused decision interrupts, in the server’s own words, and nothing else on the screen does',
    decide: (e) => {
      if (!e.reachedTurn) {
        return fail('the decision never reached this seat, so no decision could be refused');
      }
      if (e.doubleAct === null || e.doubleAct === undefined) {
        return fail('no enabled Fold control was on the screen when the turn arrived');
      }
      if (e.doubleAct.stillEnabled !== true) {
        return fail(
          'the control was already disabled between the two presses, so only ONE decision was sent ' +
            'and this run never asked the server to refuse anything. The fixture has stopped ' +
            'working; a silence measured here would be a silence it manufactured',
        );
      }
      const writes = e.log ?? [];
      if (writes.length === 0) {
        return fail('no live region was written to during the whole hand; nothing was measured');
      }
      const refusals = writes.filter((entry) => SERVER_REFUSED.test(entry.text) && !entry.recovered);
      if (refusals.length === 0) {
        return fail(
          'two decisions went out and no region ever said the server refused one. Either the second ' +
            'was accepted — in which case this seat acted twice — or the refusal reached the screen ' +
            `as pixels only. The regions held ${JSON.stringify(
              writes.map((entry) => entry.text.slice(0, 40)).slice(-4),
            )}`,
        );
      }
      const interrupting = refusals.find((entry) => entry.live === 'assertive' || entry.role === 'alert');
      if (interrupting === undefined) {
        return fail(
          `the refusal was announced ${refusals[0].live}, not assertively. A reader who is mid-` +
            'sentence hears their decision refused whenever the queue gets to it, by which time they ' +
            'have acted again — "a refusal that is announced politely is a FAIL"',
        );
      }
      const reason = SERVER_REFUSAL_REASON.exec(interrupting.text);
      if (reason === null) {
        return fail(
          `the alert says "${interrupting.text.slice(0, 80)}", which carries the heading and none of ` +
            "the server's own wording. A reader is told something was refused and not what",
        );
      }
      // "…and it is the only thing on this screen that interrupts." An assertive region that fires
      // for anything else is what teaches a reader to turn the whole surface off, which costs them
      // this announcement — the one that matters.
      const otherInterruptions = writes.filter(
        (entry) =>
          (entry.live === 'assertive' || entry.role === 'alert') &&
          !entry.recovered &&
          !SERVER_REFUSED.test(entry.text),
      );
      if (otherInterruptions.length > 0) {
        return fail(
          `${otherInterruptions.length} other announcement(s) on this screen interrupted as well — ` +
            `${JSON.stringify(otherInterruptions.map((entry) => entry.text.slice(0, 50)).slice(0, 3))}. ` +
            'The refusal is the only thing here that is allowed to',
        );
      }
      return pass(`assertive, "${interrupting.text.slice(0, 56)}…", code ${reason[1]}, sole interruption`);
    },
  },
];

/**
 * Journey 3.20 — the table with no API behind it.
 *
 * The recipe is "stop the API, then reload `/play`". Stopping the API this gate started would also
 * take out `/lab`, the hand the replay route reads back, and every other assertion in the run, so
 * what is stopped instead is the browser's ability to reach it: `Network.setBlockedURLs` refuses
 * every `/api/*` request and the socket upgrade with it. From the page's side that is the same
 * fact — the fetch fails, the socket never opens — and it is the failure the screen has to survive.
 */
async function gatherTableOffline(page, baseUrl) {
  const evidence = {};
  try {
    await page.blockUrls(['*/api/*']);
    await page.goto(`${baseUrl}/play`);
    await page.evaluate('window.__prlSpeechReset && window.__prlSpeechReset()');
    evidence.opened = await pressControl(page, /^Open the table$/iu);
    await page.settle(4000);
    Object.assign(evidence, await speechSoFar(page));
  } finally {
    // Always, even when the page could not be driven: a run that left the API blocked would score
    // every route after it as an outage and report those failures against pages that are correct.
    await page.blockUrls([]).catch((error) => {
      console.log(`  could not clear the URL block: ${error.message}`);
    });
  }
  return evidence;
}

const TABLE_OFFLINE_CHECKS = [
  {
    id: 'J3.20',
    what: 'with the API unreachable the error interrupts, and the status line does not claim the table is ready',
    decide: (e) => {
      if (e.opened === null) return fail('no "Open the table" control on /play; the page did not render');
      const alerts = (e.log ?? []).filter((entry) => entry.live === 'assertive' || entry.role === 'alert');
      const failure = alerts.find((entry) => /Error — table unavailable/u.test(entry.text));
      if (failure === undefined) {
        return fail(
          'the table could not be reached and nothing interrupted. The error block replaced the ' +
            `table on screen; the regions held ${JSON.stringify(
              (e.log ?? []).map((entry) => entry.text.slice(0, 40)).slice(-3),
            )}, so a reader is left waiting for a table that is never coming`,
        );
      }
      const status = entriesFrom(e.log, CONNECTION_REGION);
      if (status.length === 0) {
        return fail('the connection panel said nothing at all, so this run proved nothing about the failure');
      }
      const contradicting = status.filter(
        (entry) =>
          entry.at >= failure.at &&
          (LIVE_STATUS.test(entry.text) || /^Ready to connect\.$/u.test(entry.text)),
      );
      if (contradicting.length > 0) {
        return fail(
          `the polite status line says "${contradicting[0].text.slice(0, 50)}" at the same moment the ` +
            'alert says the table is unavailable. An assertive alert and a polite status that ' +
            'disagree is worse than either alone — the reader is told the opposite of the screen',
        );
      }
      const last = status.at(-1);
      return pass(`alert "${failure.text.slice(0, 40)}…", status "${last.text.slice(0, 40)}…"`);
    },
  },
];

// ---------------------------------------------------------------------------
// Journey 6 — the hand replay, on a hand this run actually played
//
// `/review/<handId>` needs a hand in a database and a session that holds a seat in it, which is why
// all seven of these rows were `person`: `/legends/hand-review/demo` renders `PostHandComparison`,
// a different component, with no face-down card and no timeline in it. The fixture is a hand played
// through `/play` by the same browser — the reader's own history, read back the way the product
// reads it.
// ---------------------------------------------------------------------------

/** Every hand this browser's session can see, newest first, asked for as the app asks. */
const listHands = (page) =>
  page
    .evaluate(
      `fetch('/api/v1/hands?limit=5', { headers: { accept: 'application/json' } })
         .then((r) => (r.ok ? r.json() : { hands: [] }))
         .then((body) => (body.hands ?? []).map((hand) => hand.id))
         .catch(() => [])`,
    )
    .then((ids) => ids ?? []);

/**
 * A replayable hand, played if this session has none that will do.
 *
 * "That will do" is one property, and it is the one journey 6 turns on: at least one seat whose
 * cards were never shown, so the replay renders a real face-down card for 6.6 to check. A hand
 * where every seat showed proves nothing about hiding — and saying so is better than passing.
 * Bounded at three attempts because a fixture that plays hands until it likes one is a gate that
 * can run forever.
 */
async function handForReplay(page, baseUrl) {
  const tried = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const hands = await listHands(page);
    const candidate = hands[0] ?? null;
    if (candidate !== null && !tried.includes(candidate)) {
      tried.push(candidate);
      await page.goto(`${baseUrl}/review/${candidate}`);
      const shape = await page.evaluate(
        `(() => ({
          faceDown: document.querySelectorAll('.prl-card--face-down').length,
          faceUp: document.querySelectorAll('.prl-card:not(.prl-card--face-down)').length,
          markers: document.querySelectorAll('.prl-timeline__marker').length,
        }))()`,
      );
      if (shape.faceDown > 0 && shape.faceUp > 0 && shape.markers > 1) return { id: candidate, shape, tried };
    }
    await driveLiveHand(page, baseUrl, {});
  }
  return { id: null, shape: null, tried };
}

async function gatherReplay(page, baseUrl) {
  const evidence = { hand: null };
  const found = await handForReplay(page, baseUrl);
  evidence.hand = found.id;
  evidence.attempts = found.tried;
  if (found.id === null) return evidence;

  await page.goto(`${baseUrl}/review/${found.id}`);
  evidence.title = await page.evaluate('document.title');
  evidence.h1 = (await axFor(page, 'h1'))[0]?.name ?? '';
  evidence.instructions = await page.evaluate(
    `(() => {
      const timeline = document.querySelector('.prl-timeline');
      if (timeline === null) return null;
      const described = timeline.getAttribute('aria-describedby');
      const note = described === null ? null : document.getElementById(described);
      if (note === null) return { described: false, before: false, text: '', hidden: false };
      return {
        described: true,
        text: (note.textContent ?? '').replace(/\\s+/gu, ' ').trim(),
        before: (note.compareDocumentPosition(timeline) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
        hidden: note.closest('[aria-hidden="true"]') !== null || getComputedStyle(note).display === 'none',
      };
    })()`,
  );

  evidence.faceDown = (await axFor(page, '.prl-card--face-down')).map((entry) => ({
    name: entry.name,
    html: entry.html,
    rendered: !entry.ignored,
  }));
  evidence.faceUp = (await axFor(page, '.prl-card:not(.prl-card--face-down)'))
    .filter((entry) => !entry.ignored)
    .map((entry) => entry.name);
  evidence.total = await page.evaluate(`document.querySelectorAll('.prl-timeline__marker').length`);

  // The timeline is one tab stop with a roving tabindex, so the caret goes to the marker that is
  // current and the arrow keys do the rest — the reader's own key press, dispatched for real.
  await page.evaluate(
    `(() => {
      const marker = document.querySelector('.prl-timeline__marker[tabindex="0"]');
      if (marker !== null) marker.focus();
    })()`,
  );
  evidence.scrub = [];
  for (let step = 0; step < 3; step += 1) {
    await page.evaluate('window.__prlSpeechReset && window.__prlSpeechReset()');
    await page.press('ArrowRight');
    await page.settle(500);
    const speech = await speechSoFar(page);
    evidence.scrub.push({
      log: speech.log,
      focus: await focusedAx(page),
      inTimeline: await page.evaluate(
        `document.activeElement !== null && document.activeElement.closest('.prl-timeline') !== null`,
      ),
    });
  }

  await page.evaluate('window.__prlSpeechReset && window.__prlSpeechReset()');
  await page.press('End');
  await page.settle(500);
  evidence.atEnd = (await speechSoFar(page)).log;
  await page.evaluate('window.__prlSpeechReset && window.__prlSpeechReset()');
  await page.press('Home');
  await page.settle(500);
  evidence.atHome = (await speechSoFar(page)).log;

  // 6.5: walk the transport to the last step with Enter, which is where "Next decision" disables
  // itself under the caret and the browser drops focus to <body> unless something rescues it.
  const reached = await page.evaluate(
    `(() => {
      const next = [...document.querySelectorAll('.prl-replay__transport button')]
        .find((b) => /Next decision/u.test(b.textContent ?? ''));
      if (next === undefined) return false;
      next.focus();
      return true;
    })()`,
  );
  evidence.transportFound = reached;
  if (reached) {
    for (let step = 0; step < (evidence.total ?? 0) + 1; step += 1) {
      const onEnabledNext = await page.evaluate(
        `document.activeElement !== null &&
         document.activeElement.disabled === false &&
         /Next decision/u.test(document.activeElement.textContent ?? '')`,
      );
      if (!onEnabledNext) break;
      await page.press('Enter');
      await page.settle(220);
    }
    evidence.afterTransport = {
      focus: await focusedAx(page),
      buttons: await page.evaluate(
        `(() => [...document.querySelectorAll('.prl-replay__transport button')].map((b) => ({
            text: (b.textContent ?? '').trim(),
            disabled: b.disabled,
          })))()`,
      ),
    };
  }
  return evidence;
}

const REPLAY_STEP = /^Step (\d+) of (\d+)\. /u;

/** The step sentences one press wrote, from the replay's own polite region. */
const stepWrites = (log) => (log ?? []).filter((entry) => REPLAY_STEP.test(entry.text));

const REPLAY_CHECKS = [
  {
    id: 'J6.1',
    what: 'the replay announces a title, and the arrow-key instruction is reachable before the timeline',
    decide: (e) => {
      if (e.hand === null) {
        return fail(
          `no replayable hand: this run played ${e.attempts.length} hand(s) and none produced a ` +
            'timeline with both a face-down and a face-up card. Journey 6 cannot be reached without one',
        );
      }
      if (!/ — Poker Risk Lab$/u.test(e.title ?? '')) {
        return fail(`document.title is "${e.title}", which does not name the site the reader is on`);
      }
      if (isBareName(e.h1)) return fail(`the replay's level-1 heading computes as "${e.h1}"`);
      const note = e.instructions;
      if (note === null) return fail('there is no timeline on this replay at all');
      if (!note.described) {
        return fail(
          'the timeline is described by nothing, so the sentence about the arrow keys is a paragraph ' +
            'a reader meets only if they happen to read past it before they Tab',
        );
      }
      if (!/arrow keys/iu.test(note.text)) {
        return fail(
          `the timeline's description does not mention the arrow keys: "${note.text.slice(0, 60)}"`,
        );
      }
      if (note.hidden) return fail('the instruction sentence is hidden from the accessibility tree');
      if (!note.before) {
        return fail(
          'the instruction sentence comes after the timeline in reading order, so a reader meets the ' +
            'control before the sentence that says how to work it',
        );
      }
      return pass(`"${e.title}", instructions before the timeline and wired to it`);
    },
  },
  {
    id: 'J6.2',
    what: 'stepping right announces the new step as one polite message with its position and pot',
    decide: (e) => {
      if (e.hand === null) return fail('no replayable hand, so nothing was stepped through');
      const first = e.scrub?.[0];
      if (first === undefined) return fail('the arrow key was never pressed');
      const writes = stepWrites(first.log);
      if (writes.length === 0) {
        return fail(
          'pressing the right arrow scrubbed the replay and announced nothing, so a reader who ' +
            'cannot see the table has no idea which decision they are now on',
        );
      }
      const spoken = writes[0];
      if (spoken.live !== 'polite' || spoken.role === 'alert') {
        return fail(`the step is announced ${spoken.live}; scrubbing is not urgent and must not interrupt`);
      }
      const rest = spoken.text.replace(REPLAY_STEP, '').trim();
      if (rest.length < 10) {
        return fail(`the step announcement is a position and nothing else: "${spoken.text}"`);
      }
      if (!/Pot [\d,]+ units?/u.test(spoken.text)) {
        return fail(
          `the step announcement carries no pot — "${spoken.text}". The pot is the figure that ` +
            'changes under the reader as they scrub, and it is on screen beside a sentence that omits it',
        );
      }
      if (writes.length > 1) {
        return fail(`${writes.length} regions announced the same step; it is announced from one`);
      }
      return pass(`"${spoken.text.slice(0, 64)}…"`);
    },
  },
  {
    id: 'J6.3',
    what: 'each step announces once and the caret stays on the timeline the reader is working',
    decide: (e) => {
      if (e.hand === null) return fail('no replayable hand, so nothing was stepped through');
      const presses = e.scrub ?? [];
      if (presses.length < 3) return fail(`only ${presses.length} arrow press(es) were made`);
      const positions = [];
      for (const press of presses) {
        const writes = stepWrites(press.log);
        if (writes.length !== 1) {
          return fail(
            `one arrow press produced ${writes.length} step announcement(s) ` +
              `(${JSON.stringify(writes.map((entry) => entry.text.slice(0, 24)))}); each step is said once`,
          );
        }
        if (!press.inTimeline) {
          return fail(
            `after an arrow press the caret is on a ${press.focus.role} outside the timeline — ` +
              'the reader asked to move a step, not to be moved off the control they were using',
          );
        }
        positions.push(Number(REPLAY_STEP.exec(writes[0].text)[1]));
      }
      const advancing = positions.every(
        (position, index) => index === 0 || position === positions[index - 1] + 1,
      );
      if (!advancing) {
        return fail(`the steps announced were ${positions.join(', ')}, which is not one step at a time`);
      }
      return pass(`steps ${positions.join(' -> ')}, caret on the timeline throughout`);
    },
  },
  {
    id: 'J6.4',
    what: 'End and Home announce the last and the first step',
    decide: (e) => {
      if (e.hand === null) return fail('no replayable hand, so End and Home were never pressed');
      const last = stepWrites(e.atEnd)[0];
      const first = stepWrites(e.atHome)[0];
      if (last === undefined) return fail('End announced nothing, so a reader cannot jump to the end by ear');
      if (first === undefined)
        return fail('Home announced nothing, so a reader cannot get back to the start');
      const [, lastIndex, lastTotal] = REPLAY_STEP.exec(last.text);
      if (lastIndex !== lastTotal) {
        return fail(`End announced step ${lastIndex} of ${lastTotal}, which is not the last one`);
      }
      const [, firstIndex] = REPLAY_STEP.exec(first.text);
      if (firstIndex !== '1') return fail(`Home announced step ${firstIndex}, which is not the first`);
      return pass(`End -> ${lastIndex} of ${lastTotal}, Home -> 1`);
    },
  },
  {
    id: 'J6.5',
    what: 'reaching the last decision moves the caret to "Previous decision" rather than dropping it',
    decide: (e) => {
      if (e.hand === null) return fail('no replayable hand, so the transport was never walked');
      if (!e.transportFound) return fail('the replay has no transport controls');
      const after = e.afterTransport;
      if (after === undefined) return fail('the transport was never walked to the end');
      const next = after.buttons.find((button) => /Next decision/u.test(button.text));
      if (next === undefined || !next.disabled) {
        return fail('the walk did not reach the end of the hand, so the rescue was never needed or tested');
      }
      if (after.focus.onDocument) {
        return fail(
          'at the end of the hand the caret was dropped to the document. "Next decision" disabled ' +
            'itself under the reader, the browser blurred it, and a reader who has just read a whole ' +
            'hand is silently returned to the top of the page',
        );
      }
      if (!/Previous decision/u.test(after.focus.name)) {
        return fail(
          `at the end of the hand the caret is on "${after.focus.name.slice(0, 40)}", not on the ` +
            'transport control that survived',
        );
      }
      return pass(`caret on "${after.focus.name}", "Next decision" disabled`);
    },
  },
  {
    id: 'J6.6',
    what: 'cards that were shown are named in words and cards that were never shown name nothing',
    decide: (e) => {
      if (e.hand === null) return fail('no replayable hand, so no card was read');
      if (e.faceDown.length === 0) {
        return fail('no face-down card in this replay, so nothing was proved about hiding');
      }
      if (e.faceUp.length === 0) {
        return fail('no face-up card in this replay, so nothing was proved about naming');
      }
      for (const card of e.faceDown) {
        const leak = CARD_VALUE_WORDS.exec(card.name) ?? CARD_VALUE_WORDS.exec(card.html);
        if (leak !== null) {
          return fail(
            `a card the server never disclosed announces "${leak[0]}" in the replay. The hand is over ` +
              'and these cards are sealed for good — STOP and file this as a hidden-information leak, ' +
              'not as an accessibility defect',
          );
        }
        if (card.rendered && !/face[- ]?down|hidden|not shown/iu.test(card.name)) {
          return fail(`a never-shown card is named "${card.name}", which does not say that it is hidden`);
        }
      }
      const wrong = e.faceUp.filter((name) => !CARD_NAMED_IN_WORDS.test(name));
      if (wrong.length > 0) {
        return fail(
          `${wrong.length} shown card(s) are named ${wrong.map((name) => `"${name}"`).join(', ')}; a ` +
            'reader needs "king of hearts", not a letter and a symbol',
        );
      }
      return pass(`${e.faceUp.length} named in words, ${e.faceDown.length} face-down and silent`);
    },
  },
];

// ---------------------------------------------------------------------------
// Journey 6.7 — the deck proof that does NOT check out
//
// 6.7 has two halves and only one of them was reachable. "Its result announces as a sentence" is on
// screen for every hand; "a verification failure announces as an alert" needs a reveal whose proofs
// do not reach its own hand's published root, and the certification document refused three routes to
// one on their merits: the browser cannot be made to receive a corrupted reveal (the review page is
// a server component, so the fetch that matters is the WEB SERVER's), the product must not contain a
// switch that lies about a deal (that is the single thing `CommitmentVerifier` exists to detect), and
// a hand-built `HandReviewResponse` would be a check of the gate's own fixture that goes stale
// against `packages/contracts` the moment either side moves.
//
// The fourth route was written down in §5 and not taken: a third web app off the same build whose
// `PRL_API_ORIGIN` points at a pass-through proxy. `scripts/review-proxy.mjs` forwards the REAL
// API's REAL review response with one hex digit of one salt flipped — a splice into the response
// TEXT, so every other byte is the API's — and that reaches `mismatch` honestly. It never authors a
// payload, so there is nothing here to go stale.
//
// The failure this route is built against is the fixture's, not the application's: a proxy that
// silently forwarded the bytes unchanged would render a perfectly good proof, and a screen with no
// alert on it cannot tell that apart from a defect. So the proxy records every response it corrupted
// and every one it refused, with reasons, and the check below will not read anything off the screen
// until that log names the hand that is on it. A hand everybody folded out of proves no deck
// position, which is the CORRECT outcome for such a hand and exactly the payload with no byte to
// flip — it is the common case, not a corner one.
// ---------------------------------------------------------------------------

/** `verifyDeckReveal`'s own words when a leaf hash no longer walks to the published root. */
const PROOF_FAILED_REASON = /position \d+ does not prove against the published root/u;

/** The sentence the verifier renders while the check has not run yet. Only ever server-side. */
const VERIFIER_PENDING = 'Recomputing the deck proof in your browser.';

/**
 * The verifier as a reader gets it: the chip, the outcome block, and the published facts.
 *
 * `spoken` strips every `aria-hidden` decoration before reading the text, which is the standard 8.2
 * already holds its notice to: a result carried by a glyph and a tone colour is a visual-only badge
 * however loud it looks, and 6.7 asks for a sentence.
 */
const VERIFIER_PROBE = `(() => {
  const tidy = (value) => (value ?? '').replace(/\\s+/gu, ' ').trim();
  const spoken = (el) => {
    const copy = el.cloneNode(true);
    for (const decoration of copy.querySelectorAll('[aria-hidden="true"]')) decoration.remove();
    return tidy(copy.textContent);
  };
  const section = document.querySelector('.prl-verifier');
  if (section === null) return null;
  const chip = section.querySelector('.prl-chip');
  const alert = section.querySelector('[role="alert"]');
  // The outcome callout. The disclosure below it uses class \`prl-note\`, not \`role="note"\`, so this
  // cannot pick up "what this proves and what it does not" by mistake.
  const note = section.querySelector('[role="note"]');
  if (alert !== null) alert.setAttribute('data-prl-ax-verdict', 'alert');
  if (note !== null) note.setAttribute('data-prl-ax-verdict', 'note');
  const terms = [...section.querySelectorAll('.prl-verifier__facts dt')];
  const values = [...section.querySelectorAll('.prl-verifier__facts dd')];
  return {
    chip: chip === null ? null : spoken(chip),
    alert: alert === null ? null : { spoken: spoken(alert), markup: alert.getAttribute('aria-live') },
    note:
      note === null
        ? null
        : { spoken: spoken(note), title: tidy(note.querySelector('.prl-callout__title')?.textContent) },
    facts: terms.map((term, at) => ({ label: tidy(term.textContent), value: tidy(values[at]?.textContent) })),
    inMain: section.closest('main') !== null,
  };
})()`;

/** One reading of the verifier, from the DOM and from the computed tree at the same moment. */
async function readVerifier(page) {
  const shape = await page.evaluate(VERIFIER_PROBE);
  if (shape === null) return { present: false };
  const alertAx = (await axFor(page, '[data-prl-ax-verdict="alert"]'))[0] ?? null;
  const noteAx = (await axFor(page, '[data-prl-ax-verdict="note"]'))[0] ?? null;
  const nodes = await axNodes(page);
  await page.evaluate(
    `document.querySelectorAll('[data-prl-ax-verdict]').forEach((el) => el.removeAttribute('data-prl-ax-verdict'))`,
  );
  return {
    present: true,
    ...shape,
    alertAx,
    noteAx,
    // Decided against the TREE rather than against `textContent`, for the reason 8.2 gives: a
    // sentence that is on screen and not in the tree is unreadable to the thing that reads screens.
    treeText: nodes.map((node) => node.name).filter((name) => name.length > 0),
  };
}

/**
 * Render a page SERVER-SIDE and answer three questions about the HTML, without navigating to it.
 *
 * Two jobs in one request. It is the candidate probe — the web server's own fetch goes through the
 * proxy, so this is what makes the proxy see a review at all — and it is the evidence that the
 * verdict is computed in the BROWSER. `CommitmentVerifier` runs `checkDeckProof` in an effect and
 * says why where it does it: an initialiser would also run during the server render, and then
 * "checked in your browser" would be a claim the component could not support. An alert that arrived
 * inside the document would also be an alert nothing announces — the 3.3 defect, in the one branch
 * on this screen that is allowed to interrupt.
 */
const renderedHtml = (page, path) =>
  page.evaluate(
    `fetch(${JSON.stringify(path)}, { headers: { accept: 'text/html' } })
       .then((response) => response.text())
       .then((html) => {
         // From the verifier onwards, not the whole document: the row is about THIS section's
         // alert, and a site-wide banner somewhere in the shell would otherwise fail it for
         // something that has nothing to do with a deck proof.
         const at = html.indexOf('prl-verifier');
         const section = at === -1 ? '' : html.slice(at);
         return {
           reached: true,
           length: html.length,
           carriesVerifier: at !== -1,
           pending: section.includes(${JSON.stringify(VERIFIER_PENDING)}),
           carriesReason: /position \\d+ does not prove against the published root/u.test(section),
           carriesAlert: /role="alert"/u.test(section),
         };
       })
       .catch((error) => ({ reached: false, why: String(error) }))`,
  );

/** Every hand this session can see, newest first, with how many board cards it dealt. */
const listHandSummaries = (page) =>
  page
    .evaluate(
      `fetch('/api/v1/hands?limit=10', { headers: { accept: 'application/json' } })
         .then((r) => (r.ok ? r.json() : { hands: [] }))
         .then((body) => (body.hands ?? []).map((hand) => ({ id: hand.id, board: (hand.board ?? []).length })))
         .catch(() => [])`,
    )
    .then((hands) => hands ?? []);

/**
 * Act until the hand is over, and never fold. The fixture that puts a byte in the reveal.
 *
 * ## The flake this exists to end, with the measurement
 *
 * A reveal proves the board cards that were dealt plus the hole cards of anybody who showed
 * (`publicPositions` in `packages/poker-engine/src/machine.ts`). So a hand that ends before the
 * flop proves NOTHING — correctly, and that is the whole point of a per-card Merkle tree — and has
 * no byte to flip. The first version of this route reused whatever hands the session had, all of
 * them played by `foldOnce`: the hero folds immediately and whether a board is ever dealt is then a
 * fact about five bots. Measured over seven consecutive `test:ax` runs, one of them failed — three
 * hands in a row ended preflop and the row refused, correctly and uselessly. A gate that goes red
 * once in seven for a reason that is not a defect teaches people to re-run it, which costs more
 * than the row is worth.
 *
 * A hero who never folds ends the hand preflop only by winning it uncontested from the big blind:
 * a call cannot be folded out, and the big blind behind a call can always check, which deals a
 * flop. So this is the same fixture family as `foldOnce` and `foldTwiceInOneTask` — the product's
 * own controls, real Enter keys — chosen so that the state 6.7 needs is reached by the rules rather
 * than by luck.
 *
 * Check before call, because a check is free and a call is not: the hero has 1,000 units and a bot
 * may shove, and calling a shove is fine (it goes to showdown, which reveals more, not less) but
 * checking is what a hand mostly offers.
 */
async function stayInTheHand(page, evidence) {
  let first = null;
  const over = '/The hand is complete/u.test(document.body.innerText)';
  for (let decision = 0; decision < 12; decision += 1) {
    const acted = (await pressControl(page, /^check\b/iu)) ?? (await pressControl(page, /^call\b/iu));
    if (acted === null) break;
    first ??= acted;
    // Wait for the controls to go down before waiting for them to come back. Without this the next
    // poll can still see the PREVIOUS turn's enabled buttons — `disabled` arrives from React state,
    // which is exactly the window 3.19 uses on purpose to get a decision refused.
    await waitInPage(page, `!(${ENABLED_ACTION})`, 10);
    if (!(await waitInPage(page, `${ENABLED_ACTION} || ${over}`, 60))) break;
    if ((await page.evaluate(over)) === true) break;
  }
  evidence.stayedIn = first;
  return first;
}

/**
 * A hand whose reveal has a byte to flip, played if this session has none.
 *
 * Bounded at three attempts for the reason `handForReplay` gives: a fixture that plays hands until
 * it likes one is a gate that can run forever. Every candidate is recorded with what the proxy made
 * of it, so a run that finds nothing says which hands it looked at and why each was refused.
 */
async function findCorruptibleHand(page, proxiedBase, honestBase, proxy) {
  const tried = [];
  let seen = 0;
  let noBoard = 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.goto(`${proxiedBase}/review`);
    const hands = await listHandSummaries(page);
    seen = Math.max(seen, hands.length);
    for (const hand of hands) {
      if (tried.some((entry) => entry.id === hand.id)) continue;
      // Read off the list, so a hand that cannot possibly work costs nothing. A hand that dealt no
      // board card and had no showdown proves no deck position — see `stayInTheHand` for the whole
      // arithmetic — and rendering it would only produce a refusal this already knows about.
      if (hand.board === 0) {
        noBoard += 1;
        continue;
      }
      const html = await renderedHtml(page, `/review/${hand.id}`);
      const record = proxy.log.mutated.find((entry) => entry.handId === hand.id) ?? null;
      // Matched on the PATH, not by taking the last entry: a refusal recorded for some other hand
      // would otherwise be reported as this hand's reason, which is a lie in a failure message and
      // the failure message is the whole value of a refusal.
      const refused = proxy.log.refused.findLast((e) => e.path.endsWith(`/${hand.id}`))?.why ?? null;
      tried.push({ id: hand.id, mutated: record !== null, why: record === null ? refused : null });
      if (record !== null) return { id: hand.id, html, record, tried, seen, noBoard };
    }
    // Nothing in this session's history reached a flop. Play one that will: the hero stays in the
    // hand rather than folding, which is what makes the board — and therefore the reveal — exist.
    if (attempt < 2) await driveLiveHand(page, honestBase, { decide: stayInTheHand });
  }
  return { id: null, html: null, record: null, tried, seen, noBoard };
}

/**
 * Load a replay and wait for the verifier to stop saying "checking".
 *
 * A fixed `settle` would be a race against hydration on a machine under load, and the thing being
 * waited for is exactly the thing this row is about: the verdict is computed in an effect, so it
 * does not exist until the browser has run one. Returns whether it settled; a run that timed out
 * says so rather than reporting whatever the pending screen looked like.
 */
async function verifierSettled(page, url) {
  await page.goto(url);
  return waitInPage(
    page,
    `(() => {
      const chip = document.querySelector('.prl-verifier .prl-chip');
      return chip !== null && !/checking/iu.test(chip.textContent ?? '');
    })()`,
    20,
  );
}

async function gatherDeckProofAlert(page, proxiedBase, context) {
  const honestBase = context?.origins?.default ?? null;
  const proxy = context?.proxy ?? null;
  const evidence = { hand: null, tried: [], proxy: null, honest: null, corrupted: null, html: null };
  if (honestBase === null || proxy === null) {
    evidence.wiring = 'the corrupting proxy was not wired into this run';
    return evidence;
  }

  const found = await findCorruptibleHand(page, proxiedBase, honestBase, proxy);
  evidence.tried = found.tried;
  evidence.seen = found.seen;
  evidence.noBoard = found.noBoard;
  evidence.proxy = { reviews: proxy.log.reviews, refused: proxy.log.refused.slice(-3) };
  if (found.id === null) return evidence;
  evidence.hand = found.id;
  evidence.record = found.record;
  evidence.html = found.html;

  // The corrupted screen first, then the honest one. Both halves of 6.7 are about the SAME hand, so
  // a run where they disagreed about which hand they were reading would be two measurements rather
  // than one row.
  evidence.corruptedSettled = await verifierSettled(page, `${proxiedBase}/review/${found.id}`);
  evidence.corrupted = await readVerifier(page);

  evidence.honestSettled = await verifierSettled(page, `${honestBase}/review/${found.id}`);
  evidence.honest = await readVerifier(page);
  return evidence;
}

const DECK_PROOF_CHECKS = [
  {
    id: 'J6.7',
    what: 'the verifier states its result as a sentence, and a proof that fails says so as an alert',
    decide: (e) => {
      if (e.wiring !== undefined) return fail(e.wiring);
      if (e.hand === null || e.hand === undefined) {
        // The fixture failing, said as the fixture failing. A screen with no alert on it cannot
        // tell "the application stopped announcing" from "the proxy served nothing corrupted", and
        // guessing between those two is how a green check over nothing happens.
        return fail(
          `the proxy corrupted no reveal, so nothing was checked. Of ${e.seen ?? 0} hand(s) in this ` +
            `session ${e.noBoard ?? 0} dealt no board card and could not carry one; the proxy saw ` +
            `${e.proxy?.reviews ?? 0} review response(s) across the rest — ${JSON.stringify(
              (e.tried ?? []).map((entry) => `${entry.id}: ${entry.why ?? 'no record'}`),
            )}. A hand that ended before the flop proves no deck position and has no byte to flip`,
        );
      }
      if (e.record.serverOk !== true || !(e.record.serverPositions > 0)) {
        return fail(
          `the API's own verdict on the UNCORRUPTED payload was ${JSON.stringify(e.record.serverOk)} ` +
            `over ${e.record.serverPositions} position(s). This run would be measuring a broken API ` +
            'rather than a corrupted reveal',
        );
      }

      // ----- the half that is on screen for every hand: the result is a sentence
      if (e.honestSettled !== true || e.corruptedSettled !== true) {
        return fail(
          `the verifier was still reading "checking" after 20s (honest ${String(e.honestSettled)}, ` +
            `corrupted ${String(e.corruptedSettled)}). Whatever this run then read is a pending screen`,
        );
      }
      if (e.honest?.present !== true) return fail('no commitment verifier on the honest replay page');
      if (e.honest.chip !== 'proof holds') {
        return fail(
          `the honest replay of this hand reads "${e.honest.chip}", not "proof holds". The corrupted ` +
            'half below would then be comparing two different states rather than one hand seen twice',
        );
      }
      if (e.honest.alert !== null) {
        return fail(
          `a proof that HOLDS raised an alert saying "${e.honest.alert.spoken.slice(0, 60)}". The one ` +
            'result on this screen that interrupts must be the one that should not happen',
        );
      }
      if (e.honest.note === null || e.honest.noteAx?.ignored === true) {
        return fail(
          'the honest result is not stated in any block a reader reaches; the chip is all there is',
        );
      }
      if (e.honest.note.spoken.length < 80 || e.honest.note.title.length === 0) {
        return fail(
          `with every decorative glyph removed the honest result reads "${e.honest.note.spoken}", which ` +
            'is a badge rather than a sentence',
        );
      }
      if (!e.honest.treeText.some((text) => text.includes(e.honest.note.title))) {
        return fail(
          `"${e.honest.note.title}" is on screen and is not in the accessibility tree, so it is ` +
            'unreadable to the thing that reads screens',
        );
      }
      const server = e.honest.facts.find((fact) => /^The server said/iu.test(fact.label));
      if (server === undefined || !/^verified/u.test(server.value)) {
        return fail(
          'the honest page does not state the SERVER’s verdict beside the browser’s. The two ' +
            'answers standing side by side is the whole point of this section',
        );
      }

      // ----- the half the proxy exists for: the failure announces as an alert
      if (e.corrupted?.present !== true) return fail('no commitment verifier on the corrupted replay page');
      if (e.corrupted.chip !== 'proof failed') {
        return fail(
          `one byte of the reveal was flipped and the verifier reads "${e.corrupted.chip}". ` +
            '"different hand" would mean the fixture moved the binding and "no reveal" that it broke ' +
            'the parse; either is a fixture defect, and neither is the mismatch this row is about',
        );
      }
      if (e.corrupted.alert === null) {
        return fail(
          'the proof failed and nothing on the page carries role="alert". A reader is told the deal ' +
            'cannot be shown to be on the record by a colour and a glyph',
        );
      }
      const node = e.corrupted.alertAx;
      if (node === null || node.ignored) {
        return fail('the failure block is not in the accessibility tree, so only a sighted reader gets it');
      }
      if (node.role !== 'alert' || node.live !== 'assertive') {
        return fail(
          `the failure block computes as role "${node.role || 'none'}" with live politeness ` +
            `"${node.live || 'none'}". A polite failure waits behind whatever the page is already saying`,
        );
      }
      if (!PROOF_FAILED_REASON.test(e.corrupted.alert.spoken)) {
        return fail(
          `the alert reads "${e.corrupted.alert.spoken.slice(0, 90)}" and does not carry the reason ` +
            'the engine gave. A reader is told something is wrong and nothing about what',
        );
      }
      if (e.corrupted.alert.spoken.length < 80) {
        return fail(
          `with every decorative glyph removed the alert reads "${e.corrupted.alert.spoken}", which is ` +
            'a badge rather than a sentence',
        );
      }
      if (!e.corrupted.treeText.some((text) => PROOF_FAILED_REASON.test(text))) {
        return fail('the reason is in the DOM and not in the accessibility tree');
      }

      // ----- the alert is INSERTED, which is what makes it an alert
      if (e.html?.reached !== true || !e.html.carriesVerifier) {
        return fail(`the server-rendered HTML could not be read: ${e.html?.why ?? 'no verifier in it'}`);
      }
      if (!e.html.pending || e.html.carriesReason || e.html.carriesAlert) {
        return fail(
          'the verdict is in the document the server sent (pending sentence ' +
            `${String(e.html.pending)}, reason ${String(e.html.carriesReason)}, alert ` +
            `${String(e.html.carriesAlert)}). An alert that arrives WITH its document announces ` +
            'nothing — the platform is notified of a change to a region it already knows about — and ' +
            'a verdict computed on the server is the server marking its own work',
        );
      }

      // ----- the two answers on the page disagree, which is what the section is for
      const corruptedServer = e.corrupted.facts.find((fact) => /^The server said/iu.test(fact.label));
      if (corruptedServer === undefined || !/^verified/u.test(corruptedServer.value)) {
        return fail(
          `the corrupted page reports the server as "${corruptedServer?.value}". The proxy did not ` +
            'touch that field, so this run is no longer reading the response the API sent',
        );
      }
      const root = e.corrupted.facts.find((fact) => /^Merkle root/iu.test(fact.label));
      if (root?.value !== e.record.root) {
        return fail(
          `the root on screen is "${root?.value}" and the proxy forwarded "${e.record.root}". The page ` +
            'is not showing the bytes this fixture corrupted',
        );
      }
      return pass(
        `${e.hand}: honest, "${e.honest.note.title}"; then salt byte ${e.record.byteOffset} ` +
          `"${e.record.before}"->"${e.record.after}" at deck position ${e.record.position} — assertive ` +
          `"${e.corrupted.alert.spoken.slice(0, 56)}…" while the server still says ${corruptedServer.value}`,
      );
    },
  },
];

// ---------------------------------------------------------------------------
// Journey 4 — the Scenario Lab
// ---------------------------------------------------------------------------

/** The summary line under the filters, as a reader would hear it. */
const LAB_SUMMARY_JS = `(() => {
  const line = document.querySelector('.prl-lab-filters__summary');
  return line === null ? null : (line.textContent ?? '').replace(/\\s+/gu, ' ').trim();
})()`;

/**
 * Every filter option, with the count the option itself declares.
 *
 * The label is built as \`\${label} (\${count})\` by \`ScenarioFilters\`, and the count is computed
 * against the OTHER two facets — so an option reading "(0)" on an already-filtered page is a
 * combination that matches nothing, which is how the empty case below is reached without this gate
 * knowing anything about the scenario catalogue.
 */
const LAB_OPTIONS_JS = `(() => [...document.querySelectorAll('form.prl-lab-filters select')].map((select) => ({
  id: select.id,
  chosen: select.value,
  options: [...select.options].map((option) => {
    const text = (option.textContent ?? '').trim();
    const counted = /\\((\\d+)\\)\\s*$/u.exec(text);
    return { value: option.value, text, count: counted === null ? null : Number(counted[1]) };
  }),
})))()`;

/** The marker whose disappearance proves the submit replaced the document rather than the query. */
const LAB_CONTEXT_MARKER = 'window.__prlLabContext';

/**
 * Choose a filter option, submit the form, and record what the new document says.
 *
 * `wanting` is `'fewer'` for any option that narrows the list, and `'none'` for one whose declared
 * count is zero. Both are found by reading the counts the page prints on its own options, so this
 * function knows nothing about which topics or streets exist.
 */
async function submitLabFilter(page, wanting) {
  await page.evaluate(`${LAB_CONTEXT_MARKER} = 'alive'; true`);
  const chosen = await page.evaluate(
    `(() => {
      const wantEmpty = ${JSON.stringify(wanting === 'none')};
      const declared = (option) => {
        const counted = /\\((\\d+)\\)\\s*$/u.exec((option.textContent ?? '').trim());
        return counted === null ? null : Number(counted[1]);
      };
      for (const select of document.querySelectorAll('form.prl-lab-filters select')) {
        // The "any" option's own count is the size of the unfiltered list, which is what makes
        // "this option NARROWS the list" decidable here rather than assumed. An option that matches
        // everything would still change the title and would prove nothing about a narrowing.
        const anyOption = [...select.options].find((option) => option.value === 'any');
        const total = anyOption === undefined ? null : declared(anyOption);
        for (const option of select.options) {
          if (option.value === 'any') continue;
          const count = declared(option);
          if (count === null) continue;
          if (wantEmpty ? count !== 0 : count === 0 || count === total) continue;
          if (select.value === option.value) continue;
          select.value = option.value;
          return { select: select.id, value: option.value, declared: count, total };
        }
      }
      return null;
    })()`,
  );
  if (chosen === null) return { chosen: null };
  const submitted = await page.evaluate(
    `(() => {
      const button = document.querySelector('form.prl-lab-filters button[type="submit"]');
      if (button === null) return false;
      button.click();
      return true;
    })()`,
  );
  if (!submitted) return { chosen, submitted: false };
  await page.settle(2500);
  const speech = await speechSoFar(page);
  return {
    chosen,
    submitted: true,
    url: await page.evaluate('location.href'),
    title: await page.evaluate('document.title'),
    summary: await page.evaluate(LAB_SUMMARY_JS),
    // Absent means the JavaScript context was destroyed, which is what a full document load does
    // and what the whole approach below rests on.
    contextSurvived: (await page.evaluate(`${LAB_CONTEXT_MARKER} ?? null`)) !== null,
    summaryIsLive: await page.evaluate(
      `(() => {
        const line = document.querySelector('.prl-lab-filters__summary');
        if (line === null) return null;
        return line.closest('[aria-live], [role="status"], [role="alert"]') !== null;
      })()`,
    ),
    // How many times ANY live region on the new document was written to. Recorded rather than
    // gated: it is the measurement the row was filed on, and it belongs in the run's output where
    // the next person can read it instead of re-deriving it.
    regionMutations: speech.mutations.length,
  };
}

/**
 * Journey 4's index, and the two submits assertion 4.2 is about.
 *
 * Three page loads rather than one, because the assertion is about what a SUBMIT produces and the
 * empty case has to be reached from an already-filtered page: an option can only read "(0)" once
 * another facet is set.
 */
async function gatherLabIndex(page, baseUrl) {
  const evidence = {};
  evidence.title = await page.evaluate('document.title');
  evidence.summary = await page.evaluate(LAB_SUMMARY_JS);
  evidence.fields = await page.evaluate(LAB_OPTIONS_JS);

  await page.goto(`${baseUrl}/lab`);
  evidence.narrowed = await submitLabFilter(page, 'fewer');

  // Straight on from the narrowed view: the zero-count option only exists because a facet is
  // already set, and starting again from `/lab` would throw that away.
  evidence.emptied = await submitLabFilter(page, 'none');
  return evidence;
}

/** What the three selects offered, for a failure message that says why nothing could be chosen. */
function labOptionInventory(fields) {
  if (!Array.isArray(fields) || fields.length === 0) return 'nothing — the form rendered no selects';
  return fields
    .map(
      (field) =>
        `${field.id}: ${field.options.map((option) => `${option.value}(${option.count})`).join(' ')}`,
    )
    .join('; ');
}

/** The count as `ScenarioFilters.scenarioCountPhrase` writes it: "14 of 36", or "all 36". */
const LAB_COUNT_PHRASE = /(?:all\s+\d+|\d+\s+of\s+\d+)/u;

/**
 * The count the page is SHOWING, read out of its own summary line.
 *
 * Read rather than computed: the point of the assertion is that the reader is told the number the
 * page is displaying, and a gate that recomputed it from the catalogue would be checking its own
 * arithmetic against the page's.
 */
function labCountShown(summary) {
  const found = summary === null ? null : LAB_COUNT_PHRASE.exec(summary);
  return found === null ? null : found[0].replace(/\s+/gu, ' ');
}

const LAB_INDEX_CHECKS = [
  {
    id: 'J4.1',
    what: 'the /lab document title is the one the certification quotes',
    decide: (e) =>
      e.title === 'Scenario Lab — Poker Risk Lab'
        ? pass(`"${e.title}"`)
        : fail(`document.title is "${e.title}", the certification quotes "Scenario Lab — Poker Risk Lab"`),
  },
  {
    id: 'J4.2',
    /*
      This row was `person`, and the certification said why: a machine could answer it, the answer
      was that NOTHING announced the count, and closing it was a product change rather than a
      certification one. The product change has been made, so the row is here.

      The defect. `ScenarioFilters` is a plain GET form and ships no JavaScript on purpose, so a
      submit replaces the document. Measured in Chrome 151 against a production build of this app:
      a `window` marker set before the submit was gone afterwards, `document.title` was
      byte-identical before and after ("Scenario Lab — Poker Risk Lab", carrying nothing about the
      filter), and the summary region on the new document took ZERO mutations because it arrived
      already holding "Showing 14 of 36 scenarios." A live region that arrives with its text
      announces nothing — the same fact 3.3 was fixed for. There the region could be mounted empty
      and written into a moment later; here the context that would do the writing has been thrown
      away by the navigation, so there is no "later" to write in.

      The fix, and therefore what this checks. A new document IS announced, by its title, with no
      JavaScript involved — that is assertion G1 — so a filtered view now puts the count there.
      `RouteAnnouncer` cannot stand in for it: it is deliberately silent on a full load, and a
      query-only change does not move `usePathname` at all.

      The clauses, in the order they would catch a regression:

        - the submit still destroys the JavaScript context. If a future edit made this a client-side
          navigation, the title would still change and NOTHING would announce it, because the
          announcer only speaks on a pathname change. That would be a silent regression to exactly
          the state this row was filed in, so it fails here rather than passing on the title alone.
        - the unfiltered title carries no count, so `/lab` still reads as 4.1 quotes it.
        - a narrowing submit puts the page's own count in the title, and an emptying one does too.
          The count is read off the summary line rather than recomputed, so the two cannot agree by
          both being wrong in the same way.
        - the empty case is reached and is not simply "0 scenarios" arriving as silence: the row
          says a filter that narrows the list to nothing must announce that.

      A sweep of nothing is refused twice over: a run where the filters offered no narrowing option,
      or no zero-count option, fails rather than passing with two clauses unexercised.
    */
    what: 'a filtered view announces its count, in the one channel a full document load has',
    decide: (e) => {
      const narrowed = e.narrowed ?? {};
      const emptied = e.emptied ?? {};
      if (narrowed.chosen === null || narrowed.chosen === undefined) {
        return fail(
          'the filters offered no option that narrows the list, so no submit was made and nothing ' +
            `about the count was checked. What they offered: ${labOptionInventory(e.fields)}`,
        );
      }
      if (narrowed.submitted !== true) return fail('the filter form has no submit control');
      if (narrowed.contextSurvived) {
        return fail(
          'the submit did NOT replace the document — the JavaScript context survived it. A ' +
            'client-side query change moves neither the pathname nor a document load, so nothing ' +
            'announces the new count however good the title is. See RouteAnnouncer',
        );
      }
      if (LAB_COUNT_PHRASE.test(e.title)) {
        return fail(
          `the UNFILTERED title already carries a count ("${e.title}"), which 4.1 quotes without one`,
        );
      }
      const shown = labCountShown(narrowed.summary);
      if (shown === null) {
        return fail(`the filtered page shows no count at all; its summary line reads "${narrowed.summary}"`);
      }
      if (!narrowed.title.includes(shown)) {
        return fail(
          `the page shows "${narrowed.summary}" and the document title is "${narrowed.title}". A new ` +
            'document is announced by its title and by nothing else this page can reach, so a count ' +
            'that is not in the title is a count no reader is told',
        );
      }
      if (narrowed.title === e.title) {
        return fail(`the filtered title is byte-identical to the unfiltered one ("${e.title}")`);
      }
      if (narrowed.summaryIsLive === true) {
        return fail(
          'the summary line is dressed as a live region on a page whose every filter change is a ' +
            'full document load. It cannot fire — it arrives already holding its text — and an ' +
            'announcement channel that has been measured never to work is how this row stayed open ' +
            'for as long as it did. The title is the channel; see the comment above',
        );
      }
      if (emptied.chosen === null || emptied.chosen === undefined) {
        return fail(
          'no filter combination on this catalogue narrows the list to nothing, so the half of this ' +
            'row about an empty result was never exercised. That is not a pass. What the unfiltered ' +
            `page offered: ${labOptionInventory(e.fields)}`,
        );
      }
      const emptyShown = labCountShown(emptied.summary);
      if (emptyShown === null || !/^0\s+of\s+\d+$/u.test(emptyShown)) {
        return fail(
          `an option declaring "(0)" was applied and the page then shows "${emptied.summary}", which ` +
            'is not an empty result. The fixture chose the wrong option, so nothing was proved',
        );
      }
      if (!emptied.title.includes(emptyShown)) {
        return fail(
          `a filter that matches nothing leaves the title as "${emptied.title}" while the page says ` +
            `"${emptied.summary}". An empty result is the one a reader cannot discover by scrolling`,
        );
      }
      return pass(
        `"${narrowed.title}" and "${emptied.title}", both on a fresh document, with ` +
          `${narrowed.regionMutations} live-region mutation(s) behind them`,
      );
    },
  },
];

async function gatherScenario(page) {
  const evidence = {};
  evidence.h1 = (await axFor(page, 'h1'))[0]?.name ?? '';

  // 4.3 — read BEFORE the decision. The situation is what the reader is being asked about, and
  // after the reveal the same screen carries the analysis too; gathering it here keeps the two
  // assertions looking at the two different things they are each about.
  evidence.situation = await page.evaluate(
    `(() => {
      const tidy = (el) => (el === null ? null : (el.textContent ?? '').replace(/\\s+/gu, ' ').trim());
      const hidden = (el) => el === null || el.closest('[aria-hidden="true"]') !== null;
      const table = document.querySelector('.prl-table');
      if (table === null) return null;
      const seats = [...table.querySelectorAll('.prl-seat')].map((seat) => {
        const labels = [...seat.querySelectorAll('.prl-seat__stat-label')];
        const values = [...seat.querySelectorAll('.prl-seat__stat-value')];
        const position = seat.querySelector('.prl-seat__position');
        return {
          name: tidy(seat.querySelector('.prl-seat__name')),
          position: tidy(position),
          positionHidden: hidden(position),
          stats: labels.map((label, index) => ({
            label: tidy(label),
            value: index < values.length ? tidy(values[index]) : null,
          })),
        };
      });
      const boards = [...table.querySelectorAll('.prl-card-row')].map((row) => {
        const caption = row.querySelector('.prl-card-row__label');
        return { caption: tidy(caption), captionHidden: hidden(caption), cards: row.querySelectorAll('.prl-card').length };
      });
      const meta = [...table.querySelectorAll('.prl-table__meta li')].map((item) => tidy(item));
      return { seats, boards, meta, metrics: (${METRICS_JS})(table) };
    })()`,
  );

  const acted = await page.evaluate(
    `(() => {
      const button = [...document.querySelectorAll('button.prl-action-btn')].find((b) => !b.disabled);
      if (button === undefined) return false;
      button.focus();
      return true;
    })()`,
  );
  evidence.acted = acted;
  if (acted) {
    await page.press('Enter');
    await page.settle(1200);
    evidence.reveal =
      (await liveRegions(page)).find((region) =>
        /^The analysis for .+ is now shown below your decision\.$/u.test(region.text),
      ) ?? null;
    evidence.revealRegions = (await liveRegions(page))
      .map((region) => region.text)
      .filter((text) => text.length > 0);
    evidence.analysisFigures = await page.evaluate(
      `(() => {
        const reveal = document.querySelector('.prl-stage__reveal');
        return reveal === null ? null : (${METRICS_JS})(reveal);
      })()`,
    );
  }
  evidence.assumptions = await page.evaluate(
    `(() => {
      const section = document.querySelector('.prl-assumptions');
      if (section === null) return null;
      const details = section.closest('details');
      const list = section.querySelector('ul, ol');
      return {
        inDetails: details !== null,
        collapsed: details !== null && details.open !== true,
        hidden: section.hidden === true || getComputedStyle(section).display === 'none',
        listTag: list === null ? null : list.tagName,
        items: section.querySelectorAll('li').length,
      };
    })()`,
  );
  return evidence;
}

const SCENARIO_CHECKS = [
  {
    id: 'J4.3',
    what: 'the situation carries a position, a stack, the board and the price, each with a label',
    decide: (e) => {
      const situation = e.situation;
      if (situation === null) return fail('the scenario rendered no table, so there is no situation to read');
      if (situation.seats.length < 2) {
        return fail(`${situation.seats.length} seat(s) on the scenario table; it did not render`);
      }
      const positionless = situation.seats.filter(
        (seat) => (seat.position ?? '') === '' || seat.positionHidden,
      );
      if (positionless.length > 0) {
        return fail(
          `${positionless.length} seat(s) announce no position, so a reader is asked about a spot ` +
            'without being told where anybody is sitting',
        );
      }
      const stackless = situation.seats.filter(
        (seat) => !seat.stats.some((stat) => (stat.label ?? '') !== '' && (stat.value ?? '') !== ''),
      );
      if (stackless.length > 0) {
        return fail(
          `${stackless.length} seat(s) carry a stack figure with no label, or a label with no figure`,
        );
      }
      const board = situation.boards.find((row) => (row.caption ?? '') !== '');
      if (board === undefined || board.captionHidden) {
        return fail(
          'the cards on this table are a row with no caption in the accessibility tree, so a reader ' +
            'meets them one at a time with nothing saying what they are',
        );
      }
      const price = (situation.meta ?? []).find((item) => /\d[\d,]*\s+units?\s+to\s+call/iu.test(item ?? ''));
      if (price === undefined) {
        return fail(
          `nothing in the situation states the price of the decision. It holds ${JSON.stringify(
            situation.meta,
          )}, and the price is the one figure the question cannot be answered without`,
        );
      }
      const pot = (situation.metrics ?? []).find((figure) => /pot/iu.test(figure.label ?? ''));
      if (pot === undefined) return fail('the pot is not a labelled figure on this table');
      const potDefect = figureDefect(pot);
      if (potDefect !== null) return fail(potDefect);
      return pass(
        `${situation.seats.length} seats with positions and stacks, "${board.caption.slice(0, 34)}…", ` +
          `"${price}"`,
      );
    },
  },
  {
    id: 'J4.5',
    what: 'every figure in the analysis announces its label and its unit, and its interval with it',
    decide: (e) => {
      if (!e.acted) return fail('no decision was committed, so no analysis was revealed');
      const figures = e.analysisFigures;
      if (figures === null) return fail('the analysis did not appear after a decision was committed');
      if (figures.length < 2) {
        return fail(`only ${figures.length} figure(s) in the revealed analysis; it did not render`);
      }
      const defects = figures.map((figure) => figureDefect(figure)).filter((defect) => defect !== null);
      if (defects.length > 0) {
        return fail(
          `${defects.length} figure(s) are announced incompletely: ${defects.slice(0, 3).join('; ')}`,
        );
      }
      /*
        A bare number is the failure this row names, and "bare" is narrower than "has no unit".
        Measured against the real analysis: "Price offered: 1.5 to 1" carries no unit and is not a
        bare number — a ratio is stated in the form that says what it is. So a figure is bare only
        when nothing places it AND the number is nothing but digits: no unit element, no percent, no
        unit word, and no word in the value itself.
      */
      const bare = figures.filter((figure) => {
        const spoken = `${figure.spoken ?? ''} ${figure.value ?? ''} ${figure.unit ?? ''}`;
        if (/%|\b(units?|points?|outs?|times?|hands?|boards?|trials?|to \d)\b/iu.test(spoken)) return false;
        return /^[\d,.\s+-]*$/u.test(figure.value ?? figure.spoken?.split(':').slice(1).join(':') ?? '');
      });
      if (bare.length > 0) {
        return fail(
          `${bare.length} figure(s) announce a number with nothing saying what it is in: ` +
            bare.map((figure) => `"${figure.label}: ${figure.value ?? figure.spoken}"`).join(', '),
        );
      }
      const intervals = figures.filter((figure) => (figure.interval ?? '') !== '');
      return pass(`${figures.length} figures, all placed, ${intervals.length} carrying an interval`);
    },
  },
  {
    id: 'J4.4',
    what: 'making a decision announces the reveal politely, naming the scenario',
    decide: (e) => {
      if (!e.acted) return fail('no enabled decision control on the scenario');
      if (e.reveal === null) {
        return fail(
          'committing a decision announced no reveal. The analysis appeared below a reader who has ' +
            `no way of knowing it did. Regions held ${JSON.stringify(e.revealRegions.slice(0, 3))}`,
        );
      }
      if (e.reveal.role === 'alert' || e.reveal.live === 'assertive') {
        return fail('the reveal interrupts; it is not urgent and must not cut the reader off');
      }
      if (!e.reveal.text.includes(e.h1)) {
        return fail(`the reveal says "${e.reveal.text}" but the scenario is "${e.h1}"`);
      }
      return pass(`"${e.reveal.text}"`);
    },
  },
  {
    id: 'J4.6',
    what: 'the assumptions are a list, reachable, and behind no control',
    decide: (e) => {
      if (e.assumptions === null) return fail('the scenario rendered no assumptions block at all');
      if (e.assumptions.inDetails) {
        return fail(
          'the assumptions are inside a <details>. Every figure on the page rests on them and this ' +
            'product does not let them be opt-in',
        );
      }
      if (e.assumptions.hidden) return fail('the assumptions block is not rendered');
      if (e.assumptions.listTag === null || e.assumptions.items === 0) {
        return fail('the assumptions are not a list, so a reader is not told how many there are');
      }
      return pass(`<${e.assumptions.listTag.toLowerCase()}> of ${e.assumptions.items}, not collapsed`);
    },
  },
];

// ---------------------------------------------------------------------------
// Journey 5 — AI Legends
// ---------------------------------------------------------------------------

async function gatherLegendsIndex(page) {
  const nodes = await axNodes(page);
  return {
    title: await page.evaluate('document.title'),
    headings: nodes
      .filter((node) => node.role === 'heading')
      .map((node) => ({ level: node.level, name: node.name })),
    profileLinks: (await axFor(page, 'a[href^="/legends/"]'))
      .filter((entry) => !entry.ignored)
      .map((entry) => entry.name),
  };
}

const LEGENDS_INDEX_CHECKS = [
  {
    id: 'J5.1',
    what: 'the /legends title is announced and the page owns exactly one level-1 heading',
    decide: (e) => {
      if (!/^AI Legends — Poker Risk Lab$/u.test(e.title)) {
        return fail(`document.title is "${e.title}", expected "AI Legends — Poker Risk Lab"`);
      }
      const levelOnes = e.headings.filter((heading) => heading.level === 1);
      if (levelOnes.length !== 1) return fail(`${levelOnes.length} level-1 heading(s) on /legends`);
      return pass(`"${e.title}", h1 "${levelOnes[0].name}"`);
    },
  },
  {
    id: 'J5.2',
    what: 'every profile link announces a name',
    decide: (e) => {
      if (e.profileLinks.length < 5)
        return fail(`only ${e.profileLinks.length} profile link(s); /legends did not render`);
      const bare = e.profileLinks.filter((name) => isBareName(name));
      if (bare.length > 0) {
        return fail(`${bare.length} profile link(s) announce as a bare role or number`);
      }
      const duplicates = e.profileLinks.filter((name, index) => e.profileLinks.indexOf(name) !== index);
      if (duplicates.length > 0) {
        return fail(
          `${new Set(duplicates).size} profile link name(s) are shared by more than one link, so the ` +
            `links rotor cannot tell them apart: "${[...new Set(duplicates)][0]}"`,
        );
      }
      return pass(`${e.profileLinks.length} distinct profile links`);
    },
  },
];

async function gatherProfile(page) {
  const evidence = {};
  evidence.traits = await page.evaluate(
    `(() => [...document.querySelectorAll('.prl-legend-traits__row')].map((row) => ({
        label: (row.querySelector('.prl-legend-traits__label')?.textContent ?? '').trim(),
        value: (row.querySelector('.prl-legend-traits__value')?.textContent ?? '').trim(),
        text: (row.textContent ?? '').replace(/\\s+/gu, ' ').trim(),
        trackHidden: row.querySelector('.prl-legend-traits__track')?.getAttribute('aria-hidden') === 'true',
      })))()`,
  );
  evidence.traitImages = (await axFor(page, '.prl-legend-traits [role="img"], .prl-legend-traits img'))
    .filter((entry) => !entry.ignored)
    .map((entry) => entry.name);
  evidence.radar = (await axFor(page, '.prl-radar__svg'))[0] ?? null;
  evidence.radarTable = await page.evaluate(
    `(() => {
      const table = document.querySelector('.prl-radar table');
      if (table === null) return null;
      return {
        inDetails: table.closest('details') !== null,
        rows: [...table.querySelectorAll('tbody tr')].map((row) =>
          [...row.cells].map((cell) => (cell.textContent ?? '').trim()),
        ),
      };
    })()`,
  );
  evidence.disclaimers = await page.evaluate(
    `(() => {
      const block = document.querySelector('.prl-legend-disclaimers');
      if (block === null) return null;
      return {
        inDetails: block.closest('details') !== null,
        behindExpander: block.closest('[aria-expanded="false"]') !== null,
        hidden: block.hidden === true || getComputedStyle(block).display === 'none',
        items: block.querySelectorAll('li').length,
      };
    })()`,
  );
  return evidence;
}

const PROFILE_CHECKS = [
  {
    id: 'J5.3',
    what: 'each trait announces a label and a value, and no trait is an unnamed graphic',
    decide: (e) => {
      if (e.traits.length < 3)
        return fail(`only ${e.traits.length} trait row(s); the profile did not render`);
      const unlabelled = e.traits.filter((trait) => trait.label === '' || trait.value === '');
      if (unlabelled.length > 0) {
        return fail(`${unlabelled.length} trait row(s) carry a label or a value but not both`);
      }
      const scaleless = e.traits.filter((trait) => !/of\s+\d/u.test(trait.text));
      if (scaleless.length > 0) {
        return fail(
          `${scaleless.length} trait row(s) announce a number with no scale, so "0.72" is all a ` +
            'reader is given and it could be out of anything',
        );
      }
      const decorative = e.traits.filter((trait) => !trait.trackHidden);
      if (decorative.length > 0) {
        return fail(
          `${decorative.length} trait bar(s) are in the accessibility tree as graphics. The figure ` +
            'is already text beside them; the bar is decoration and must be hidden from the reader',
        );
      }
      const unnamed = e.traitImages.filter((name) => isBareName(name));
      if (unnamed.length > 0) return fail(`${unnamed.length} unnamed image(s) inside the trait list`);
      return pass(`${e.traits.length} traits, each a label and a value on a stated scale`);
    },
  },
  {
    id: 'J5.4',
    what: 'the radar chart is named and carries a text alternative with the same figures',
    decide: (e) => {
      if (e.radar === null) return fail('no radar chart on the profile');
      if (isBareName(e.radar.name)) {
        return fail(
          `the radar chart computes as "${e.radar.name}"; a chart that announces as nothing but an ` +
            'image is the failure this forbids',
        );
      }
      if (e.radarTable === null) {
        return fail('the radar chart has no table alternative, so its figures exist only as a picture');
      }
      if (e.radarTable.inDetails) {
        return fail(
          'the radar chart’s table alternative is behind a <details>, so it is not reachable by reading',
        );
      }
      if (e.radarTable.rows.length < 3) {
        return fail(`the table alternative has ${e.radarTable.rows.length} row(s); the chart has more axes`);
      }
      const figureless = e.radarTable.rows.filter((row) => !row.some((cell) => /\d/u.test(cell)));
      if (figureless.length > 0) {
        return fail(`${figureless.length} row(s) of the table alternative carry no figure`);
      }
      return pass(`"${e.radar.name.slice(0, 40)}…" plus a ${e.radarTable.rows.length}-row table`);
    },
  },
  {
    id: 'J5.5',
    what: 'the disclaimers are reachable and behind no control',
    decide: (e) => {
      if (e.disclaimers === null) return fail('the profile rendered no disclaimers at all');
      if (e.disclaimers.inDetails || e.disclaimers.behindExpander) {
        return fail(
          'the disclaimers are behind a control. What a profile is and is not is the one thing on ' +
            'this page that may not be optional reading',
        );
      }
      if (e.disclaimers.hidden) return fail('the disclaimers are in the DOM and not rendered');
      if (e.disclaimers.items === 0) return fail('the disclaimers block rendered with nothing in it');
      return pass(`${e.disclaimers.items} disclaimer(s), in the open`);
    },
  },
];

// ---------------------------------------------------------------------------
// Journey 7 — the navigation sheet, at a phone width
// ---------------------------------------------------------------------------

const SHEET_TAB_STOPS = 14;

/**
 * The fewest content-bearing elements a page must have behind the sheet for 7.4 to mean anything.
 *
 * Not a target: a floor. The check is a negative over the whole background, and a negative over an
 * empty set is the shape of green check this repository has been bitten by. Measured on `/` at
 * 390x844: 188 elements match `BACKGROUND_CONTENT_JS` — the header, the hero, every card, the
 * footer — so twenty leaves room for the page to be redesigned and none for the sweep to stop
 * matching. Demonstrated by raising this to 500 against the real page, which failed the check with
 * "only 188 content-bearing element(s) found outside the sheet".
 */
const BACKGROUND_CONTENT_FLOOR = 20;

async function gatherSheet(page) {
  const evidence = {};
  const opened = await page.evaluate(
    `(() => {
      const trigger = document.querySelector('button.prl-nav-trigger');
      if (trigger === null) return false;
      trigger.focus();
      return true;
    })()`,
  );
  evidence.triggerFound = opened;
  if (!opened) return evidence;

  await page.press('Enter');
  await page.settle(500);
  evidence.dialog = (await axFor(page, '[role="dialog"].prl-sheet'))[0] ?? null;
  evidence.focusOnOpen = await focusedAx(page);

  evidence.forwardStops = await tabAround(page, 'Tab');
  evidence.backwardStops = await tabAround(page, 'Tab', { shift: true });

  evidence.background = await gatherSheetBackground(page);

  // Put the caret back where the sheet put it. `gatherSheetBackground` stamps and unstamps
  // attributes only, so it does not move focus — but Escape is read on the sheet's own key handler
  // and a caret left anywhere else would make 7.5 a test of this fixture rather than of the sheet.
  await page.evaluate(`document.querySelector('.prl-sheet__close')?.focus(); true`);
  await page.press('Escape');
  await page.settle(500);
  evidence.afterEscape = {
    focus: await focusedAx(page),
    trigger: (await axFor(page, 'button.prl-nav-trigger'))[0] ?? null,
    sheetHidden: await page.evaluate(
      `document.querySelector('.prl-sheet') === null || document.querySelector('.prl-sheet').hidden === true`,
    ),
  };

  await gatherSheetDestination(page, evidence);
  return evidence;
}

/**
 * What "content behind the sheet" IS, for a page that has no idea what its own content is.
 *
 * An element counts if it could be stopped on and read: it has a text node of its OWN (so a wrapper
 * `<div>` around a paragraph is not counted twice), or it is a control, an image, a landmark, or
 * something carrying an explicit `role`. Deliberately structural rather than a list of the things
 * this app happens to render at `/` — the assertion is about anything a future edit puts behind the
 * sheet, not about the hero links that were there when it was written.
 */
const BACKGROUND_CONTENT_JS = `(() => {
  const sheet = document.querySelector('.prl-sheet');
  if (sheet === null) return null;
  const CONTROLS = 'a[href],button,input,select,textarea,img,svg,[role],main,nav,header,footer,aside,form,h1,h2,h3';
  const ownText = (el) =>
    [...el.childNodes].some((node) => node.nodeType === 3 && (node.textContent ?? '').trim() !== '');
  const elements = [...document.querySelectorAll('body *')].filter((el) => {
    if (el === sheet || sheet.contains(el)) return false;
    if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.tagName === 'LINK') return false;
    return ownText(el) || el.matches(CONTROLS);
  });
  elements.forEach((el, index) => el.setAttribute('data-prl-bg', String(index)));
  return elements.map((el) => ({
    tag: el.tagName.toLowerCase(),
    // An ancestor of the sheet cannot be made inert: \`inert\` is inherited and a descendant cannot
    // opt out, so inerting the sheet's own \`<header>\` would inert the sheet inside it. These are
    // the nodes the check holds to a different, and stricter, standard.
    ancestor: el.contains(sheet),
    announcer: el.hasAttribute('data-prl-route-announcer'),
    text: (el.textContent ?? '').replace(/\\s+/gu, ' ').trim().slice(0, 60),
    own: ownText(el),
  }));
})()`;

/**
 * Every content-bearing element outside the open sheet, and whether the accessibility tree ignores
 * it.
 *
 * `axFlagsFor` rather than `axFor`: this asks the question of the whole page, and `axFor` would
 * fetch the outer HTML of `<main>` and of every ancestor of everything inside it to decide a
 * boolean per node.
 */
async function gatherSheetBackground(page) {
  const elements = await page.evaluate(BACKGROUND_CONTENT_JS);
  if (elements === null) return null;
  const flags = await page.axFlagsFor('[data-prl-bg]');
  await page.evaluate(
    `document.querySelectorAll('[data-prl-bg]').forEach((el) => el.removeAttribute('data-prl-bg')); true`,
  );
  // Both sides are the same selector engine over the same document, so both are in document order
  // and the two lists line up. Checked rather than assumed: if they ever did not, every verdict
  // below would be about the wrong element and would still read as a clean pass.
  if (flags.length !== elements.length) return { misaligned: { dom: elements.length, ax: flags.length } };
  return elements.map((element, index) => ({ ...element, ...flags[index] }));
}

/** Tab (or Shift+Tab) around the sheet, recording whether the caret ever leaves it. */
async function tabAround(page, key, options = {}) {
  const stops = [];
  for (let step = 0; step < SHEET_TAB_STOPS; step += 1) {
    await page.press(key, options);
    stops.push(
      await page.evaluate(
        `(() => {
          const el = document.activeElement;
          if (el === null || el === document.body) return { inside: false, where: 'document' };
          const sheet = document.querySelector('.prl-sheet');
          return {
            inside: sheet !== null && sheet.contains(el),
            where: (el.getAttribute('aria-label') ?? el.textContent ?? el.tagName).replace(/\\s+/gu, ' ').trim().slice(0, 40),
          };
        })()`,
      ),
    );
  }
  return stops;
}

async function gatherSheetDestination(page, evidence) {
  const reopened = await page.evaluate(
    `(() => {
      const trigger = document.querySelector('button.prl-nav-trigger');
      if (trigger === null) return false;
      trigger.focus();
      trigger.click();
      return true;
    })()`,
  );
  if (!reopened) return;
  await page.settle(500);
  await page.evaluate('window.__prlAnnouncerReset && window.__prlAnnouncerReset()');
  const chosen = await page.evaluate(
    `(() => {
      const link = document.querySelector('.prl-sheet a.prl-sheet__link');
      if (link === null) return null;
      link.focus();
      return link.getAttribute('href');
    })()`,
  );
  if (chosen === null) return;
  await page.press('Enter');
  await page.settle(2500);
  evidence.afterDestination = {
    href: chosen,
    sheetHidden: await page.evaluate(
      `document.querySelector('.prl-sheet') === null || document.querySelector('.prl-sheet').hidden === true`,
    ),
    announced: await page.evaluate('window.__prlAnnouncerLog ?? []'),
    title: await page.evaluate('document.title'),
    caretConnected: await page.evaluate(
      'document.activeElement === null ? false : document.activeElement.isConnected',
    ),
  };
}

const SHEET_CHECKS = [
  {
    id: 'J7.1',
    what: 'the sheet is a named dialog and the caret opens inside it, on a named control',
    decide: (e) => {
      if (!e.triggerFound) return fail('no "Menu" trigger at a phone width');
      if (e.dialog === null || e.dialog.ignored)
        return fail('the sheet is not a dialog in the computed tree');
      if (isBareName(e.dialog.name)) return fail(`the dialog computes as "${e.dialog.name}", with no name`);
      if (e.focusOnOpen.onDocument) return fail('opening the sheet left the caret on the document');
      if (isBareName(e.focusOnOpen.name)) {
        return fail(`the caret opened on a ${e.focusOnOpen.role} with no computed name`);
      }
      return pass(`dialog "${e.dialog.name}", caret on "${e.focusOnOpen.name}"`);
    },
  },
  {
    id: 'J7.2',
    what: 'Tab never leaves the sheet',
    decide: (e) => decideTrap(e.forwardStops, 'Tab'),
  },
  {
    id: 'J7.3',
    what: 'Shift + Tab never leaves the sheet',
    decide: (e) => decideTrap(e.backwardStops, 'Shift + Tab'),
  },
  {
    id: 'J7.4',
    /*
      This row was `person`, and the certification's reason for it was right about the
      implementation and wrong about the ceiling: "whether the virtual cursor reaches those 29 nodes
      is a fact about whether the reader honours `aria-modal`". It was, because the background was
      only DECLARED out of scope. Measured before the fix, sheet open at 390x844 on `/`: of 34
      content-bearing elements outside `.prl-sheet`, 29 were still non-ignored nodes in the computed
      accessibility tree — "Skip to main content", the wordmark link, `main`, its `h1`, every hero
      link. `MobileNav` now marks every subtree that is not the sheet `inert` while it is open, and
      an inert subtree is not in the tree at all, so there is nothing left for a cursor to walk to
      whatever the reader thinks of `aria-modal`. That is what makes this row decidable here.

      Two things this deliberately does NOT require, because both would be false claims:

        - it does not require the sheet's own ANCESTORS to be ignored. `inert` is inherited and a
          descendant cannot opt out of it, so inerting `<header>` — where both the trigger and the
          sheet live — would inert the sheet inside it. What is required of them instead is that
          they are containers: an ancestor that is still in the tree must carry no text of its own,
          so reading it reaches a landmark boundary and nothing else. Measured: the one survivor is
          `<header aria-label="Site">`, a banner with no text of its own.
        - it does not require the route announcer to be ignored, and it requires it to be EMPTY.
          `MobileNav` spares it on purpose (see `INERT_EXEMPT` there): it is the one region outside
          the sheet that still has something to say, because a back-button navigation announces the
          new route while the sheet is still open. Sparing it is only free while it is empty, which
          is what this asserts — and it asserts that it is the ONLY thing spared, so a second
          exemption cannot be added quietly.

      A sweep of nothing is refused: a run that found fewer than twenty content-bearing elements
      behind the sheet has not looked at the page, and a page with no background is not a page this
      assertion has been proved against.
    */
    what: 'nothing behind the open sheet is left in the accessibility tree for a cursor to walk to',
    decide: (e) => {
      const background = e.background;
      if (background === null || background === undefined) {
        return fail('the sheet was never found, so nothing was measured behind it');
      }
      if (background.misaligned !== undefined) {
        return fail(
          `the DOM sweep found ${background.misaligned.dom} elements and the accessibility query ` +
            `answered for ${background.misaligned.ax}. The two lists do not line up, so every ` +
            'verdict below would be about the wrong element',
        );
      }
      if (background.length < BACKGROUND_CONTENT_FLOOR) {
        return fail(
          `only ${background.length} content-bearing element(s) found outside the sheet. This ` +
            'assertion is a negative over the whole background, and a negative over an empty set ' +
            'is not a pass',
        );
      }
      const spared = background.filter((element) => element.announcer);
      const reachable = background.filter(
        (element) => !element.ignored && !element.ancestor && !element.announcer,
      );
      if (reachable.length > 0) {
        return fail(
          `${reachable.length} of ${background.length} elements behind the sheet are still ` +
            `non-ignored nodes in the computed tree, among them ${reachable
              .slice(0, 4)
              .map((element) => `<${element.tag}> "${element.name === '' ? element.text : element.name}"`)
              .join(', ')}. A reader whose virtual cursor does not stop at \`aria-modal\` walks out ` +
            'of the menu into a page that is not on the screen',
        );
      }
      const speaking = background.filter((element) => element.ancestor && !element.ignored && element.own);
      if (speaking.length > 0) {
        return fail(
          `${speaking.length} of the sheet's own ancestors are in the tree AND carry text of their ` +
            `own (${speaking.map((element) => `<${element.tag}> "${element.text}"`).join(', ')}). An ` +
            'ancestor cannot be made inert without inerting the sheet inside it, so it has to be a ' +
            'container and nothing more',
        );
      }
      if (spared.length !== 1) {
        return fail(
          `${spared.length} element(s) behind the sheet are exempt from the sweep. Exactly one is ` +
            'expected — the route announcer, which must keep speaking because a back-button ' +
            'navigation announces the new route while the sheet is still open. A second exemption ' +
            'is a hole in this assertion',
        );
      }
      if (spared[0].text !== '') {
        return fail(
          `the route announcer is spared from the sweep and is holding "${spared[0].text}" while ` +
            'the sheet is open, so there IS content behind the sheet that a cursor can reach',
        );
      }
      const ancestors = background.filter((element) => element.ancestor && !element.ignored);
      return pass(
        `${background.length} behind the sheet, ${reachable.length} reachable; ` +
          `${ancestors.length} container(s) left in the tree (${ancestors
            .map((element) => `${element.role || element.tag}`)
            .join(', ')})`,
      );
    },
  },
  {
    id: 'J7.5',
    what: 'Escape closes the sheet and returns the caret to the trigger, which reports collapsed',
    decide: (e) => {
      if (!e.triggerFound) return fail('no "Menu" trigger at a phone width');
      if (!e.afterEscape.sheetHidden) return fail('Escape did not close the sheet');
      if (e.afterEscape.focus.onDocument) {
        return fail(
          'closing the sheet dropped the caret to the document. A reader who opened a menu and ' +
            'closed it is returned to the top of the page',
        );
      }
      if (!/menu/iu.test(e.afterEscape.focus.name)) {
        return fail(`after Escape the caret is on "${e.afterEscape.focus.name}", not the trigger`);
      }
      if (e.afterEscape.trigger === null || e.afterEscape.trigger.expanded !== false) {
        return fail(
          `the trigger reports expanded=${String(e.afterEscape.trigger?.expanded)} with the sheet ` +
            'closed, so a reader is told the menu is open',
        );
      }
      return pass(`caret back on "${e.afterEscape.focus.name}", collapsed`);
    },
  },
  {
    id: 'J7.6',
    what: 'choosing a destination closes the sheet, announces the route, and strands nobody',
    decide: (e) => {
      const after = e.afterDestination;
      if (after === undefined) return fail('the sheet offered no destination to activate');
      if (!after.sheetHidden) return fail('the sheet is still open after a destination was activated');
      const heard = after.announced.map((entry) => entry.text);
      if (!heard.includes(after.title)) {
        return fail(
          `the route change to ${after.href} announced ${JSON.stringify(heard)}, and the new title ` +
            `is "${after.title}"`,
        );
      }
      if (!after.caretConnected) {
        return fail(
          'the caret is on a node that is no longer in the document — the reader is standing on the ' +
            'sheet that was just removed',
        );
      }
      return pass(`${after.href}, "${after.title}", caret still attached`);
    },
  },
];

function decideTrap(stops, label) {
  if (stops === undefined || stops.length === 0) return fail(`${label} was never pressed`);
  const escaped = stops.filter((stop) => !stop.inside);
  if (escaped.length > 0) {
    return fail(
      `${escaped.length} of ${stops.length} ${label} presses left the sheet, reaching ` +
        `${escaped
          .slice(0, 3)
          .map((stop) => `"${stop.where}"`)
          .join(
            ', ',
          )}. Content behind a modal is content a reader can walk into and not find their way back from`,
    );
  }
  return pass(`${stops.length} ${label} presses, all inside`);
}

// ---------------------------------------------------------------------------
// Journey 8 — the failure paths
// ---------------------------------------------------------------------------

async function gatherMissingHand(page) {
  const nodes = await axNodes(page);
  return {
    headings: nodes
      .filter((node) => node.role === 'heading')
      .map((node) => ({ level: node.level, name: node.name })),
    prose: await page.evaluate(
      `(() => [...document.querySelectorAll('main p')]
         .map((p) => (p.textContent ?? '').replace(/\\s+/gu, ' ').trim())
         .filter((text) => text.length > 30))()`,
    ),
    wayOut: (await axFor(page, 'main a[href], main button'))
      .filter((entry) => !entry.ignored && !isBareName(entry.name))
      .map((entry) => entry.name),
  };
}

const MISSING_HAND_CHECKS = [
  {
    id: 'J8.1',
    what: 'a hand that does not exist refuses with a heading, a sentence, and a way out',
    decide: (e) => {
      const levelOnes = e.headings.filter((heading) => heading.level === 1);
      if (levelOnes.length !== 1 || isBareName(levelOnes[0].name)) {
        return fail(`the refusal offers ${levelOnes.length} named level-1 heading(s)`);
      }
      if (e.prose.length === 0) {
        return fail(
          'the refusal is a heading with no sentence under it, so a reader is told something went ' +
            'wrong and nothing about what',
        );
      }
      if (e.wayOut.length === 0) {
        return fail('the refusal offers no named link or button, so a reader is left on a dead end');
      }
      return pass(`"${levelOnes[0].name}", ${e.prose.length} sentence(s), ${e.wayOut.length} way(s) out`);
    },
  },
];

// ---------------------------------------------------------------------------
// Journey 8, continued — the page a reader gets when the API is not there
//
// 8.2 was `person` for a reason that reads like an impossibility and is a fixture: "the
// bundled-copy path is taken by the WEB SERVER's own fetch, not the browser's, so reaching it needs
// the API to be down for a process this gate shares with every other assertion". Both halves are
// true and the conclusion does not follow — the gate can run a SECOND web server. It is the same
// build, on its own port, with `PRL_API_ORIGIN` pointing at a port nothing can be listening on, and
// nothing else in the run goes near it. See `OFFLINE_WEB_ORIGIN` in `ax-tree-audit.mjs`.
//
// What that buys is the real path rather than a simulation of it: `loadLessonList` gets a transport
// error from its own `fetch`, `isApiUnavailable` says so, and `/learn` renders `LEARN_LESSON_LIST_
// FIXTURE` with `fallbackReason` set — exactly what a reader would get from a deployment whose API
// is down.
// ---------------------------------------------------------------------------

/** The phrase every fixture fallback in `apps/web/src/lib/learn-data.ts` is built on. */
const BUNDLED_COPY_NOTICE = /bundled copy|content service is not reachable/iu;

async function gatherBundledCopy(page) {
  const nodes = await axNodes(page);
  const notice = await page.evaluate(
    `(() => {
      const wanted = /bundled copy|content service is not reachable/iu;
      const note = [...document.querySelectorAll('[role="note"]')].find((el) =>
        wanted.test((el.textContent ?? '').replace(/\\s+/gu, ' ')),
      );
      if (note === undefined) return null;
      note.setAttribute('data-prl-ax-notice', '1');
      // What a reader is actually given: the same node with every decorative glyph removed. A
      // notice whose meaning survives only in an aria-hidden marker is the "visual-only badge"
      // this assertion refuses.
      const spoken = note.cloneNode(true);
      for (const decoration of spoken.querySelectorAll('[aria-hidden="true"]')) decoration.remove();
      return {
        text: (note.textContent ?? '').replace(/\\s+/gu, ' ').trim(),
        spoken: (spoken.textContent ?? '').replace(/\\s+/gu, ' ').trim(),
        inMain: note.closest('main') !== null,
        insideDetails: note.closest('details') !== null,
        ariaHidden: note.closest('[aria-hidden="true"]') !== null,
        rendered: note.getClientRects().length > 0,
      };
    })()`,
  );
  const ax = notice === null ? [] : await axFor(page, '[data-prl-ax-notice="1"]');
  await page.evaluate(
    `document.querySelectorAll('[data-prl-ax-notice]').forEach((el) => el.removeAttribute('data-prl-ax-notice'))`,
  );
  return {
    notice,
    noticeAx: ax[0] ?? null,
    // The sentence as the TREE carries it, which is the half a source scan cannot make: a `role=
    // "note"` takes no accessible name from its contents, so the evidence that a reader gets the
    // words is that the words are in the tree as text.
    spokenInTree: nodes.filter((node) => BUNDLED_COPY_NOTICE.test(node.name)).map((node) => node.name),
    headings: nodes
      .filter((node) => node.role === 'heading')
      .map((node) => ({ level: node.level, name: node.name })),
    lessonLinks: (await axFor(page, 'main a[href^="/learn/"]')).filter(
      (entry) => !entry.ignored && !isBareName(entry.name),
    ).length,
  };
}

const BUNDLED_COPY_CHECKS = [
  {
    id: 'J8.2',
    what: 'with no API behind the web server the page renders its bundled copy and says so in words',
    decide: (e) => {
      const levelOnes = e.headings.filter((heading) => heading.level === 1);
      if (levelOnes.length !== 1) {
        return fail(
          `this page rendered ${levelOnes.length} level-1 heading(s), so it is an error boundary ` +
            'rather than the curriculum. The bundled copy is what the page falls back TO; a page ' +
            'that fell over instead is a different defect and this assertion cannot see past it',
        );
      }
      if (e.lessonLinks === 0) {
        return fail(
          'the page carries no named lesson link, so nothing was rendered from the bundled copy — ' +
            'the notice would be describing a page that is not there',
        );
      }
      if (e.notice === null) {
        return fail(
          'nothing on the page says the content is the bundled copy. Either the web server reached ' +
            'an API after all — in which case this assertion checked the live page and proves ' +
            `nothing — or the fallback is silent. The page's headings were ${JSON.stringify(
              e.headings.slice(0, 4).map((heading) => heading.name),
            )}`,
        );
      }
      if (e.notice.ariaHidden || e.noticeAx?.ignored === true) {
        return fail('the notice is hidden from the accessibility tree, so only a sighted reader gets it');
      }
      if (!e.notice.rendered) return fail('the notice is in the DOM and is not rendered');
      if (!e.notice.inMain) {
        return fail(
          'the notice is outside `main`, so a reader who used the skip link to get to the content ' +
            'has skipped past the sentence saying the content is not live',
        );
      }
      if (e.notice.insideDetails) {
        return fail(
          'the notice is inside a disclosure. Whether what you are reading is live is not optional ' +
            'reading',
        );
      }
      // The badge test, and it is the one the row actually turns on. Strip every `aria-hidden`
      // glyph and what is left must still be a sentence; a tone marker plus a coloured border is a
      // visual-only badge however loud it looks.
      if (!BUNDLED_COPY_NOTICE.test(e.notice.spoken) || e.notice.spoken.length < 40) {
        return fail(
          `with every decorative glyph removed the notice reads "${e.notice.spoken}", which is not a ` +
            'sentence saying the content is a bundled copy. A reader who cannot see the tone colour ' +
            'is told nothing',
        );
      }
      if (e.spokenInTree.length === 0) {
        return fail(
          'the sentence is in the DOM and not in the accessibility tree, so it is on screen and ' +
            'unreadable to the thing that reads screens',
        );
      }
      return pass(`"${e.notice.spoken.slice(0, 80)}…", in main, in the tree`);
    },
  },
];

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/**
 * One entry per page visit, in the order the certification document walks them.
 *
 * `viewport` is a real device-metrics override rather than a window resize, because the two
 * narrow-width journeys are decided by `matchMedia` and a container query, and a headless window
 * that was merely made small does not always move either.
 */
export const ASSERTION_ROUTES = [
  { key: 'global', title: 'Global (G1–G10)', path: '/', gather: gatherGlobal, checks: GLOBAL_CHECKS },
  { key: 'learn', title: 'J1 Learn', path: '/learn', gather: gatherLearn, checks: LEARN_CHECKS },
  {
    key: 'practice',
    title: 'J2 Guided practice',
    path: '/learn/pot-odds',
    gather: gatherQuiz,
    checks: QUIZ_CHECKS,
  },
  {
    /*
      2.9 gets its own page visit because it needs two of them: the quiz is walked to its review
      panel twice from a fresh load, and the runs differ in exactly one answer. See
      `gatherQuizReview` for why the row is decided by difference rather than by a scan.
    */
    key: 'quiz-review',
    title: 'J2 Guided practice, at the end of the quiz',
    path: '/learn/pot-odds',
    gather: gatherQuizReview,
    checks: QUIZ_REVIEW_CHECKS,
  },
  {
    key: 'table',
    title: 'J3 Table and Coach',
    path: '/play?state=decision',
    gather: gatherTable,
    checks: TABLE_CHECKS,
  },
  {
    key: 'table-narrow',
    title: 'J3 Table and Coach, at 390px',
    path: '/play?state=decision',
    viewport: { width: 390, height: 844 },
    gather: gatherTableNarrow,
    checks: TABLE_NARROW_CHECKS,
  },
  /*
    The live table, and it is placed before the replay deliberately.

    Both routes can stand alone — the replay plays a hand of its own when the session has none — but
    run in this order the replay reads back the hand this one just played, which is one hand rather
    than two and about twenty seconds of gate. The order is an optimisation, not a dependency; a run
    of `--assertions replay` alone is still a complete check of journey 6.
  */
  {
    key: 'live-table',
    title: 'J3 Table and Coach, over a live socket',
    path: '/play',
    gather: gatherLiveTable,
    checks: LIVE_TABLE_CHECKS,
  },
  {
    key: 'table-offline',
    title: 'J3 Table with the API unreachable',
    path: '/play',
    gather: gatherTableOffline,
    checks: TABLE_OFFLINE_CHECKS,
  },
  {
    key: 'replay',
    title: 'J6 Hand review, on a hand this run played',
    path: '/review',
    gather: gatherReplay,
    checks: REPLAY_CHECKS,
  },
  {
    /*
      6.7's corrupted reveal, and it sits here for the same session reason the replay does.

      `origin: 'proxied'` is the second route that does not run against the app under test: a third
      `next start` off the same build whose `PRL_API_ORIGIN` points at `scripts/review-proxy.mjs`,
      which forwards the real API's real review response with one hex digit of one salt flipped. It
      reads the hands THIS session already has, so it must come before `live-refusal` clears the
      cookie jar — and it plays a hand of its own only when none of them proved a deck position.
    */
    key: 'deck-proof-alert',
    title: 'J6 Hand review, with one byte of the reveal flipped',
    origin: 'proxied',
    path: '/review',
    gather: gatherDeckProofAlert,
    checks: DECK_PROOF_CHECKS,
  },
  /*
    3.19's hand, and it must come AFTER the replay.

    It clears the cookie jar and plays a hand of its own, so a session sitting between it and the
    replay would be a different reader's — the replay would find no hand of its own to read back
    and would have to play one, which is twenty seconds of gate for nothing. Ordering only; the
    route stands alone.
  */
  {
    key: 'live-refusal',
    title: 'J3 Table and Coach, a decision the server refuses',
    path: '/play',
    gather: gatherRefusedDecision,
    checks: REFUSED_DECISION_CHECKS,
  },
  { key: 'lab', title: 'J4 Scenario Lab', path: '/lab', gather: gatherLabIndex, checks: LAB_INDEX_CHECKS },
  {
    key: 'scenario',
    title: 'J4 Scenario Lab, one scenario',
    path: '/lab/fl-same-cards-under-the-gun',
    gather: gatherScenario,
    checks: SCENARIO_CHECKS,
  },
  {
    key: 'legends',
    title: 'J5 AI Legends',
    path: '/legends',
    gather: gatherLegendsIndex,
    checks: LEGENDS_INDEX_CHECKS,
  },
  {
    key: 'profile',
    title: 'J5 AI Legends, one profile',
    path: '/legends/adaptive-exploiter',
    gather: gatherProfile,
    checks: PROFILE_CHECKS,
  },
  {
    key: 'sheet',
    title: 'J7 Navigation sheet, at 390px',
    path: '/',
    viewport: { width: 390, height: 844 },
    gather: gatherSheet,
    checks: SHEET_CHECKS,
  },
  {
    key: 'missing-hand',
    title: 'J8 Failure paths',
    path: '/review/prl-no-such-hand',
    gather: gatherMissingHand,
    checks: MISSING_HAND_CHECKS,
  },
  {
    /*
      `origin: 'offline'` is the only route that does not run against the app under test. It runs
      against a second `next start` off the same build whose `PRL_API_ORIGIN` points at nothing, so
      the web server's own fetch fails and the page renders its bundled copy — which is the state
      8.2 is about and the one thing blocking `/api/*` in the browser cannot produce.
    */
    key: 'bundled-copy',
    title: 'J8 Failure paths, with no API behind the web server',
    origin: 'offline',
    path: '/learn',
    gather: gatherBundledCopy,
    checks: BUNDLED_COPY_CHECKS,
  },
];

/**
 * Every assertion ID this module claims to cover, sorted.
 *
 * `scripts/screen-reader-certify.test.mjs` asserts this is EXACTLY the set of rows the
 * certification document marks `auto`. That is the control against the split rotting: a check
 * deleted here, or a row re-marked there, fails a test rather than quietly leaving an assertion
 * covered by nobody.
 */
export const ASSERTION_IDS = ASSERTION_ROUTES.flatMap((route) =>
  route.checks.map((check) => check.id),
).sort();

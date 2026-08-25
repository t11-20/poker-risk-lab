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
 * The certification document holds 73 manual assertions and every release report this project has
 * produced records the same verdict for all 73: UNVERIFIED, because nobody has sat down with a
 * screen reader. That is true and it is also the wrong shape of true. A large share of those 73 are
 * not really about speech at all — they are about an accessible name, a role, an ARIA state, a
 * live region's politeness, where focus lands, whether a heading outline skips a level. Those are
 * facts about the rendered accessibility tree. Leaving them in a manual session that has never been
 * run means a regression in ANY of them — a removed `aria-label`, a live region flipped to
 * assertive, a control that drops focus on the floor when it disables itself — ships silently and
 * waits for a human session that never comes.
 *
 * So the 73 are split. The 45 whose whole subject is a DOM/ARIA fact are checked here, on every
 * run, and a regression fails `pnpm run verify`. The 28 whose subject is the SPEECH — what order an
 * utterance arrives in, whether a polite region really waited, whether a refusal interrupted,
 * whether a sentence is comprehensible, anything needing a live socket at a real table — stay with
 * the person, and `pnpm run certify:screen-reader` now presents only those.
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
 * about speech — "the group announces its purpose ... and the prompt is not read twice" — the whole
 * row stays with the person. Overclaiming here is worse than a smaller automated set: a row that
 * has been dropped from the human session and is only half covered by a machine is a row nobody
 * checks.
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
// Journey 4 — the Scenario Lab
// ---------------------------------------------------------------------------

async function gatherLabIndex(page) {
  return { title: await page.evaluate('document.title') };
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
];

async function gatherScenario(page) {
  const evidence = {};
  evidence.h1 = (await axFor(page, 'h1'))[0]?.name ?? '';
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

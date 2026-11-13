#!/usr/bin/env node
/**
 * The rows of `docs/production/accessibility-certification.md` a machine can decide, one check per
 * assertion ID, run against the computed accessibility tree in real Chrome by
 * `scripts/ax-tree-audit.mjs` (`pnpm run test:ax`).
 *
 * Each entry in `ASSERTION_ROUTES` is one page visit. `gather` drives the page with real keys and
 * returns plain-JSON evidence, and each `check` decides from that evidence alone, so
 * `ax-assertions.test.mjs` can feed it synthetic evidence and watch it refuse.
 *
 * A check here does not certify its row. It proves the DOM/ARIA fact the row rests on still holds.
 * `scripts/screen-reader-certify.test.mjs` asserts the IDs here are exactly the rows the document
 * marks `auto`.
 */

// Ranks and suits as `packages/ui/src/cards.ts` spells them, on word boundaries. Shared with the
// per-journey card audit so the two leak checks cannot drift.
export const CARD_VALUE_WORDS =
  /\b(ace|king|queen|jack|ten|nine|eight|seven|six|five|four|three|two|deuce|hearts?|diamonds?|clubs?|spades?)\b/iu;

export const CARD_NAMED_IN_WORDS =
  /^(ace|king|queen|jack|ten|nine|eight|seven|six|five|four|three|two) of (hearts|diamonds|clubs|spades)\b/iu;

const pass = (detail) => ({ ok: true, detail });
const fail = (detail) => ({ ok: false, detail });

// Empty, a bare number or glyph, or the role word itself (G5, 1.4).
export function isBareName(name) {
  const trimmed = (name ?? '').trim();
  if (trimmed.length === 0) return true;
  if (/^[\d\p{P}\p{S}\s]+$/u.test(trimmed)) return true;
  return /^(link|button|image|graphic|icon)$/iu.test(trimmed);
}

// A letter directly followed by a digit means the `aria-label` was dropped and `textContent`
// ("Fold0 units") took over (3.14).
export function announcesActionAndCost(name) {
  const trimmed = (name ?? '').trim();
  if (!/^(fold|check|call|bet to|raise to)\b/iu.test(trimmed)) return false;
  if (/[a-z]\d/iu.test(trimmed)) return false;
  return /\d[\d,]*\s+units?\b/iu.test(trimmed);
}

export function skippedHeadingLevel(levels) {
  let previous = null;
  for (const level of levels) {
    if (previous !== null && level > previous + 1) return `${previous} to ${level}`;
    previous = level;
  }
  return null;
}

/**
 * Installed at document start. G9 asserts the announcer says nothing on a full load, and an observer
 * attached later cannot tell "never wrote" from "wrote and was cleared". It records each distinct text
 * with its time, for G7 and G8.
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
 * Every write into every live region, recorded from document start, because the live table replaces
 * most sentences within milliseconds ("You chose to fold." was overwritten 6ms later).
 *
 * - `characterDataOldValue` recovers a text replaced inside one React commit. Such entries carry
 *   `recovered: true`, because nothing announced them and no check may count them (3.3).
 * - A mutation count per region, because a same-text rewrite is still a re-announcement (3.6).
 * - The key is the nearest three ancestor class names, because the table narration and the turn
 *   sentence share a class.
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

const speechSoFar = (page) =>
  page.evaluate('window.__prlSpeech ?? { log: [], mutations: [] }').then((speech) => ({
    log: speech.log ?? [],
    mutations: speech.mutations ?? [],
  }));

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

async function axFor(page, selector) {
  const found = await page.axFor(selector);
  return found.map((entry) => ({
    ...(entry.node === null ? axShape({}) : axShape(entry.node)),
    ignored: entry.node?.ignored === true,
    html: entry.html ?? '',
  }));
}

// Through `getPartialAXTree` on `activeElement`, because Chrome 151's full tree keeps `focused` on
// RootWebArea after a `tabindex="-1"` landing is focused.
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

// `Metric` has two shapes. A counting figure hides the animated number and carries the real one in a
// visually hidden readout, so both shapes are read.
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

// Returns a sentence describing the defect, or null when the figure is announced whole.
export function figureDefect(figure) {
  const label = (figure.label ?? '').trim();
  if (label === '' || figure.labelHidden) return 'a figure reaches the tree with no label beside it';
  const spoken = (figure.spoken ?? '').trim();
  if (figure.valueHidden || figure.value === null) {
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

const liveRegions = (page) => page.evaluate(`(() => (${LIVE_REGIONS_JS}))()`);

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

  // G2
  await page.evaluate('document.body.focus(); document.activeElement && document.activeElement.blur()');
  await page.press('Tab');
  evidence.firstTabStop = await focusedAx(page);
  await page.press('Enter');
  evidence.afterSkipLink = await focusedAx(page);

  // G7, G8, G10: a real client-side navigation.
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
      // Silence is only evidence when the announcer exists. Without this G9 passed a blank page.
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
    what: 'every group of lessons is a level-2 or level-3 heading and no level is skipped',
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

export const QUIZ_VERDICT_OPENING =
  /^(That matches the answer this lesson gives|That is not the answer this lesson gives)\./u;
// "35.0 % is more than ±1.5 % from the computed 33.3 %." See `apps/web/src/lib/quiz-verdict.ts`.
export const NUMERIC_VERDICT_OPENING = /^\S.* is (?:within ±.*? of|more than ±.*? from) the computed .*?\./u;

// False when the button is missing or disabled, which J2.5 reports.
const PRESS_CHECK_ANSWER_JS = `(() => {
  const button = document.querySelector('.prl-learn-quiz__check');
  if (button === null || button.disabled) return false;
  button.click();
  return true;
})()`;

async function gatherQuiz(page) {
  const evidence = { title: await page.evaluate('document.title') };
  evidence.panelHeading = (await axFor(page, '.prl-learn-quiz .prl-panel__title'))[0] ?? null;
  evidence.promptHeading = (await axFor(page, '.prl-learn-quiz__heading'))[0] ?? null;

  // 2.4: read before answering, because answering adds chips and notes to the group.
  evidence.answerGroup = (await axFor(page, '.prl-learn-quiz__options'))[0] ?? null;
  evidence.answerOptions = await axFor(page, '.prl-learn-quiz__options input[type="radio"]');

  // 2.5: selecting must not answer, then "Check answer" writes the region. Two evaluates, because React
  // applies the selection on the next render and the button is still disabled in the same task.
  const selected = await page.evaluate(
    `(() => {
      const radio = document.querySelector('.prl-learn-quiz__options input[type="radio"]');
      if (radio === null) return false;
      radio.click();
      return true;
    })()`,
  );
  await page.settle(600);
  evidence.verdictOnSelect = selected
    ? await page.evaluate(`document.querySelector('.prl-learn-quiz__verdict')?.textContent ?? null`)
    : null;
  evidence.choiceAnswered = selected ? await page.evaluate(PRESS_CHECK_ANSWER_JS) : false;
  await page.settle(900);
  evidence.choiceVerdict =
    (await liveRegions(page)).find((region) => QUIZ_VERDICT_OPENING.test(region.text)) ?? null;
  evidence.choiceVerdictCount = (await liveRegions(page)).filter((region) =>
    QUIZ_VERDICT_OPENING.test(region.text),
  ).length;

  // 2.8
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
 * 2.6 and 2.7 on the first numeric question. Input goes through Chrome's key pipeline, because
 * `.value = 'abc'` is discarded. It types `1e`, because Chrome 151 filters bare letters out of a number
 * field and `1e` is a partial exponent it accepts and reports as `badInput`.
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

  // 2.7
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
      // A `generic` container with an `aria-label` is not announced on entry, so the role must be a group.
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
      // "The prompt is not read twice" has one cause in the tree, the prompt in a second accessible name.
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
    what: 'selecting an option answers nothing; "Check answer" writes the verdict into one polite region',
    decide: (e) => {
      if (typeof e.verdictOnSelect === 'string' && e.verdictOnSelect.trim() !== '') {
        return fail(
          `selecting an option answered it before "Check answer" was pressed: "${e.verdictOnSelect.slice(0, 60)}". ` +
            'A keyboard reader arrowing through the group answers every option on the way',
        );
      }
      if (!e.choiceAnswered) return fail('no "Check answer" control to press after selecting an option');
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

/**
 * 2.9, decided by difference. A wording scan only catches the wordings somebody thought of, but a
 * score depends on correctness. So the quiz runs to its review panel twice, differing only in whether
 * the first answer is right, and `main` must read identically. A separate shape scan covers tallies
 * that do not depend on correctness. Only `main` is compared, because the units pill settles
 * asynchronously.
 */
const SPOKEN_TEXT_JS = `((root) => {
  if (root === null) return null;
  const copy = root.cloneNode(true);
  for (const decoration of copy.querySelectorAll('[aria-hidden="true"]')) decoration.remove();
  return (copy.textContent ?? '').replace(/\\s+/gu, ' ').trim();
})`;

const TALLY_SHAPE = /\b\d[\d,]*\s*(?:\/|of|out of)\s*\d[\d,]*\b|\b\d[\d,]*\s*%/u;

const QUIZ_STEP_LIMIT = 12;

async function gatherQuizReview(page, baseUrl) {
  const evidence = { runs: [] };
  for (const takeTheLessonAnswer of [true, false]) {
    const run = { takeTheLessonAnswer };
    await page.goto(`${baseUrl}/learn/pot-odds`);
    await page.settle(700);
    // Answer with the first option only to reveal which option is the lesson's answer.
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
    await page.settle(600);
    run.checked = await page.evaluate(PRESS_CHECK_ANSWER_JS);
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
    await page.settle(600);
    run.rechecked = await page.evaluate(PRESS_CHECK_ANSWER_JS);
    await page.settle(900);
    run.verdict = await page.evaluate(
      `(${SPOKEN_TEXT_JS})(document.querySelector('.prl-learn-quiz__verdict'))`,
    );

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
        if (run.checked === false || run.rechecked === false) {
          return fail(
            `${label} selected an option and found no "Check answer" to press, so nothing was answered`,
          );
        }
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
      // Two runs that answered the same way would agree about a score too.
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

export function firstDifference(left, right) {
  const a = left ?? '';
  const b = right ?? '';
  let at = 0;
  while (at < a.length && at < b.length && a[at] === b[at]) at += 1;
  const from = Math.max(0, at - 30);
  return `…${a.slice(from, at + 50)}…` + ` / …${b.slice(from, at + 50)}…`;
}

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

// Read as reading order, because Chrome 151 computes an empty name for a `<figure>` from its
// `figcaption`. 3.9 is about the board being announced before its cards.
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

// The computed name and its `aria-label` source. Without the label accname gives "Fold 0 units",
// which passes a name-only pattern. The first version of this check passed a build with every
// action `aria-label` deleted.
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

// A live table over a real socket with a guest session, a private room with five bots and one hand, read
// from the `SPEECH_PROBE` log. The API must allow this audit's origin in `PUBLIC_WEB_ORIGIN`.

const CONNECTION_REGION = /prl-play__connection-lines/u;
// `prl-play__table`, because `TableStage` mounts the narration region before `PokerTable` exists.
// A region inserted already holding its sentence is announced by nothing (3.3).
const TABLE_REGION = /prl-play__table>prl-live-region/u;
const TURN_REGION = /prl-play__decision>prl-live-region/u;

const TURN_DWELL_MS = 10_000;

// `setTimeout` is a minimum and `Date.now()` can be stepped, and the gate once failed on a 9999ms
// dwell. 250ms is 2.5% of the dwell, and anything that genuinely cut it short is off by seconds.
const TURN_DWELL_TOLERANCE_MS = 250;

const FOLD_ECHO = /^You chose to fold\./u;

const DEALT_ANNOUNCEMENT = /^A new hand was dealt\./u;

const entriesFrom = (log, region) => (log ?? []).filter((entry) => region.test(entry.key ?? ''));

// Real Enter rather than `click()`, because the focus rescues depend on the keyboard path. Returns
// the name pressed, or null.
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

function controlGone(page, pattern) {
  return page.evaluate(
    `(() => {
      const named = (b) => (b.getAttribute('aria-label') ?? b.textContent ?? '').replace(/\\s+/gu, ' ').trim();
      const wanted = new RegExp(${JSON.stringify(pattern.source)}, ${JSON.stringify(pattern.flags)});
      return ![...document.querySelectorAll('button')].some((b) => wanted.test(named(b)));
    })()`,
  );
}

async function waitInPage(page, expression, seconds) {
  for (let attempt = 0; attempt < seconds * 4; attempt += 1) {
    await page.settle(250);
    if ((await page.evaluate(expression).catch(() => false)) === true) return true;
  }
  return false;
}

const ENABLED_ACTION = `[...document.querySelectorAll('button.prl-action-btn')].some((b) => !b.disabled)`;

const MANUAL_CONTROL = /^(Take seat \d+|Deal the next hand|Stand up)$/u;

const TABLE_START_JS = `(() => {
  const named = (b) => (b.getAttribute('aria-label') ?? b.textContent ?? '').replace(/\\s+/gu, ' ').trim();
  const text = document.body.innerText;
  const lines = document.querySelector('.prl-play__connection-lines');
  return {
    reconnecting: /Reconnecting you to the table you were at/u.test(text),
    inProgress: /A hand is in progress/u.test(text),
    status: (lines?.textContent ?? '').replace(/\\s+/gu, ' ').trim().slice(0, 140),
    controls: [...document.querySelectorAll('button')]
      .map((b) => ({ name: named(b), enabled: !b.disabled }))
      .filter((c) => c.name !== '')
      .slice(0, 16),
  };
})()`;

/**
 * `first visit`, `reconnected`, or null while deciding. Since PR #32 a tab that remembers a room
 * reconnects and offers the manual controls instead of "Deal me in" (CI run 43245665934 failed 6.7 on
 * this). "Reconnecting" is waited out so a pass line can say which state it measured.
 */
export function tableStartPath(snapshot) {
  if (snapshot === null || snapshot === undefined || snapshot.reconnecting) return null;
  const controls = snapshot.controls ?? [];
  if (controls.some((c) => c.enabled && /^Deal me in$/u.test(c.name))) return 'first visit';
  if (controls.some((c) => MANUAL_CONTROL.test(c.name))) return 'reconnected';
  return null;
}

async function settleTableStart(page, seconds) {
  const started = Date.now();
  let snapshot = null;
  for (let attempt = 0; attempt < seconds * 4; attempt += 1) {
    snapshot = await page.evaluate(TABLE_START_JS).catch(() => null);
    const path = tableStartPath(snapshot);
    if (path !== null) return { path, snapshot, waitedMs: Date.now() - started };
    await page.settle(250);
  }
  return { path: null, snapshot, waitedMs: Date.now() - started };
}

export function summariseDrive(evidence) {
  return {
    path: evidence.path ?? null,
    pressed: [evidence.opened, evidence.sat, evidence.dealPressed].filter((name) => typeof name === 'string'),
    dealt: evidence.dealt ?? null,
    complete: evidence.complete === true,
    start: evidence.start ?? null,
  };
}

// A drive that dealt nothing says so in capitals, so downstream rows are not blamed on the screen.
export function describeDrive(drive) {
  const screen = (snapshot) =>
    `status ${JSON.stringify(snapshot?.status ?? null)}, controls ${JSON.stringify(
      (snapshot?.controls ?? []).map((c) => (c.enabled ? c.name : `${c.name} (disabled)`)),
    )}`;
  if (drive.path === null) {
    return (
      `/play never settled into a first visit or a reconnect after ${drive.start?.waitedMs ?? 0}ms — ` +
      screen(drive.start?.snapshot)
    );
  }
  const pressed =
    drive.pressed.length === 0
      ? 'pressed nothing'
      : `pressed ${drive.pressed.map((n) => `"${n}"`).join(' then ')}`;
  if (drive.dealt === null) {
    const after = drive.start?.after;
    return `${drive.path}: ${pressed}, DEALT NOTHING${after ? ` — the page then showed ${screen(after)}` : ''}`;
  }
  return `${drive.path}: ${pressed}, ${drive.complete ? 'played to completion' : 'dealt, never completed'}`;
}

export function describeDrives(drives) {
  if (drives.length === 0) return 'a hand already in this session, none played for it';
  return `${drives.length} hand(s) played for it — ${drives.map(describeDrive).join('; ')}`;
}

/**
 * "Deal me in", fold when the decision arrives, and let the hand finish, through the screen. `fresh`
 * clears cookies, which the replay route must not do. `decide` defaults to one Fold. 3.19 passes a
 * double press. A drive that settled into neither start state returns `dealt` null.
 */
async function driveLiveHand(page, baseUrl, { fresh = false, dwellMs = 0, decide = foldOnce } = {}) {
  const evidence = {
    steps: [],
    reachedTurn: false,
    dwellMs: 0,
    complete: false,
    turnOpenedAt: null,
    path: null,
    opened: null,
    dealt: null,
  };
  if (fresh) await page.clearCookies();
  await page.goto(`${baseUrl}/play`);
  await page.evaluate('window.__prlSpeechReset && window.__prlSpeechReset()');

  evidence.start = await settleTableStart(page, 45);
  evidence.path = evidence.start.path;
  if (evidence.path === null) return { ...evidence, ...(await speechSoFar(page)) };

  // Read before the press, because the narration region must exist before the hand starts (3.3).
  evidence.regionsBeforeDeal = await page.evaluate(
    'window.__prlSpeechRegions ? window.__prlSpeechRegions() : []',
  );
  if (evidence.path === 'reconnected') {
    if (!(await dealAtReconnectedTable(page, evidence))) return { ...evidence, ...(await speechSoFar(page)) };
    return finishLiveHand(page, evidence, { dwellMs, decide });
  }

  evidence.opened = await pressControl(page, /^Deal me in$/iu);
  if (evidence.opened === null) return { ...evidence, ...(await speechSoFar(page)) };
  await page.settle(700);
  evidence.steps.push({
    control: evidence.opened,
    gone: await controlGone(page, /^Deal me in$/iu),
    focus: await focusedAx(page),
  });

  evidence.socketLive = await waitInPage(
    page,
    '/Take seat|Deal the next hand|Stand up/u.test(document.body.innerText)',
    45,
  );
  if (!evidence.socketLive) return { ...evidence, ...(await speechSoFar(page)) };

  // Seat and deal unmount controls under the caret, so the end of the chain is a step for 3.2.
  const handInProgress = await waitInPage(page, '/A hand is in progress/u.test(document.body.innerText)', 45);
  evidence.dealt = handInProgress ? evidence.opened : null;
  if (evidence.dealt === null) return { ...evidence, ...(await speechSoFar(page)) };
  evidence.steps.push({
    control: 'the seat and the deal "Deal me in" sent',
    gone: await controlGone(page, /^(Deal me in|Take seat \d+)$/iu),
    focus: await focusedAx(page),
  });
  return finishLiveHand(page, evidence, { dwellMs, decide });
}

// "Deal the next hand" renders disabled until the first frame, so it is waited for enabled. It
// disables rather than unmounting, so it pushes no `steps` entry.
async function dealAtReconnectedTable(page, evidence) {
  const named = `(b) => (b.getAttribute('aria-label') ?? b.textContent ?? '').replace(/\\s+/gu, ' ').trim()`;
  const enabledDeal =
    `[...document.querySelectorAll('button')]` +
    `.some((b) => /^Deal the next hand$/u.test((${named})(b)) && !b.disabled)`;
  const inProgress = '/A hand is in progress/u.test(document.body.innerText)';
  const over = '/The hand is complete/u.test(document.body.innerText)';
  evidence.socketLive = true;
  let needsDeal = !evidence.start.snapshot.inProgress;
  if (!needsDeal) {
    // A tab that returns after folding is never offered a decision, so also stop when the hand ends.
    await waitInPage(page, `${ENABLED_ACTION} || ${over} || ${enabledDeal}`, 90);
    needsDeal = (await page.evaluate(ENABLED_ACTION)) !== true;
    evidence.joinedInProgress = needsDeal ? 'watched it finish, then dealt' : 'had a decision in it';
  }
  if (needsDeal) {
    evidence.sat = await pressControl(page, /^Take seat \d+$/iu);
    if (await waitInPage(page, `${enabledDeal} || ${inProgress}`, 20)) {
      evidence.dealPressed = await pressControl(page, /^Deal the next hand$/iu);
    }
  }
  const handInProgress = await waitInPage(page, inProgress, 45);
  evidence.dealt = handInProgress ? (evidence.dealPressed ?? 'a hand already in progress') : null;
  if (evidence.dealt === null) evidence.start.after = await page.evaluate(TABLE_START_JS).catch(() => null);
  return evidence.dealt !== null;
}

async function finishLiveHand(page, evidence, { dwellMs, decide }) {
  evidence.reachedTurn = await waitInPage(page, ENABLED_ACTION, 60);
  if (!evidence.reachedTurn) return { ...evidence, ...(await speechSoFar(page)) };
  const opened = await speechSoFar(page);
  evidence.turnOpenedAt = entriesFrom(opened.log, TURN_REGION).at(-1)?.at ?? null;

  // 3.6
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

const foldOnce = (page) => pressControl(page, /^fold\b/iu);

/**
 * Two decisions before the controls disable, the fixture for 3.19. `disabled` is applied on the next
 * render, so two `click()`s in one task both reach `act`. Measured, the server answered "It is not
 * your turn to act. (not_your_turn). Nothing was applied." The refusal code is not pinned, because it
 * depends on timing.
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

const gatherRefusedDecision = (page, baseUrl) =>
  driveLiveHand(page, baseUrl, { fresh: true, decide: foldTwiceInOneTask });

const PREPARING = /^Preparing: reading your session/u;
const LIVE_STATUS = /^Live\. Everything on this screen is the server/u;

const LIVE_TABLE_CHECKS = [
  {
    id: 'J3.1',
    what: 'the connection status is announced politely as it changes, preparing then live',
    decide: (e) => {
      // The drive cleared cookies, so a reconnect resumed a table with no session behind it.
      if (e.path === 'reconnected') {
        return fail(
          '/play reconnected to a table the tab remembered although the cookie jar had just been ' +
            'cleared, so there was no first visit to measure and no session that could own that table',
        );
      }
      if (e.path === null && e.start !== undefined) {
        return fail(`no first visit to measure: ${describeDrive(summariseDrive(e))}`);
      }
      if (e.opened === null) return fail('no "Deal me in" control on /play; the live table did not render');
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
          )}. A reader presses "Deal me in" and is told nothing until it works`,
        );
      }
      if (live < 0) {
        // `PUBLIC_WEB_ORIGIN` must allow this audit's origin, or every call answers `forbidden`.
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
      return pass(
        `${status.length} polite status changes, preparing -> live, on a ${e.path ?? 'first visit'}`,
      );
    },
  },
  {
    id: 'J3.2',
    what: 'after "Deal me in", and after the seat and deal it sends, the caret is on the status line',
    decide: (e) => {
      if (e.steps.length < 2) {
        return fail(
          `only ${e.steps.length} of the two setup steps were reached ` +
            `(pressed ${JSON.stringify(e.opened)}, dealt ${JSON.stringify(e.dealt ?? null)}); ` +
            'the seat and the deal unmount the controls under the caret, which is where it is most ' +
            'often dropped, so a run that never reached them proves nothing',
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
      3.3 must not regress (`onEventFrame` in `apps/web/src/lib/use-live-table.ts`):
        - the narration region exists when the hand is dealt;
        - the entry was observed held (`recovered !== true`);
        - it does not stand alone, because `handStarted` and `forcedBets` are one notice and a second
          write replaces the deal before a reader hears it;
        - it is said once.
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
      // See `TURN_DWELL_TOLERANCE_MS`.
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
      // A same-text rewrite is still a re-announcement, so mutations decide it.
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

const SERVER_REFUSED = /The server refused it/u;

// A shape, not a string, because which refusal arrives depends on timing. A contract code in the
// text fails, because the page stopped printing codes after the audit at 308fadf.
const SERVER_REFUSAL_REASON = /The server refused it\s*(\S[\s\S]*?[.!?])\s*Nothing was applied\./u;
const CONTRACT_CODE = /\([a-z]+(?:_[a-z]+)+\)/u;

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
      if (CONTRACT_CODE.test(interrupting.text)) {
        return fail(
          `the alert says "${interrupting.text.slice(0, 80)}", which reads a contract code out to the ` +
            'reader after the sentence that already said what happened',
        );
      }
      const reason = SERVER_REFUSAL_REASON.exec(interrupting.text);
      if (reason === null) {
        return fail(
          `the alert says "${interrupting.text.slice(0, 80)}", which carries the heading and none of ` +
            "the server's own wording. A reader is told something was refused and not what",
        );
      }
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
      return pass(`assertive, "${reason[1].slice(0, 56)}", sole interruption`);
    },
  },
];

// 3.20: `Network.setBlockedURLs` refuses `/api/*` and the socket, so the API stays up for the other
// assertions.
async function gatherTableOffline(page, baseUrl) {
  const evidence = {};
  try {
    await page.blockUrls(['*/api/*']);
    await page.goto(`${baseUrl}/play`);
    await page.evaluate('window.__prlSpeechReset && window.__prlSpeechReset()');
    evidence.opened = await pressControl(page, /^Deal me in$/iu);
    await page.settle(4000);
    Object.assign(evidence, await speechSoFar(page));
  } finally {
    // Always unblock, or every later route scores as an outage.
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
      if (e.opened === null) return fail('no "Deal me in" control on /play; the page did not render');
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

// Journey 6: the replay of a hand this browser played, read back from `/review/<handId>`.

const listHands = (page) =>
  page
    .evaluate(
      `fetch('/api/v1/hands?limit=5', { headers: { accept: 'application/json' } })
         .then((r) => (r.ok ? r.json() : { hands: [] }))
         .then((body) => (body.hands ?? []).map((hand) => hand.id))
         .catch(() => [])`,
    )
    .then((ids) => ids ?? []);

// A hand with at least one seat never shown, for 6.6. Bounded at three attempts.
async function handForReplay(page, baseUrl) {
  const tried = [];
  const drives = [];
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
      if (shape.faceDown > 0 && shape.faceUp > 0 && shape.markers > 1) {
        return { id: candidate, shape, tried, drives };
      }
    }
    drives.push(summariseDrive(await driveLiveHand(page, baseUrl, {})));
  }
  return { id: null, shape: null, tried, drives };
}

async function gatherReplay(page, baseUrl) {
  const evidence = { hand: null };
  const found = await handForReplay(page, baseUrl);
  evidence.hand = found.id;
  evidence.attempts = found.tried;
  evidence.drives = found.drives;
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

  await page.evaluate(
    `(() => {
      const marker = document.querySelector('.prl-timeline__marker[tabindex="0"]');
      if (marker !== null) marker.focus();
    })()`,
  );
  // Home first, because the replay opens on the reader's first decision and three right-arrows could
  // run off the end.
  await page.press('Home');
  await page.settle(300);
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

  // 6.5: "Next decision" disables itself at the last step.
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

const stepWrites = (log) => (log ?? []).filter((entry) => REPLAY_STEP.test(entry.text));

const REPLAY_CHECKS = [
  {
    id: 'J6.1',
    what: 'the replay announces a title, and the arrow-key instruction is reachable before the timeline',
    decide: (e) => {
      if (e.hand === null) {
        return fail(
          `no replayable hand: this run looked at ${e.attempts.length} hand(s) and none produced a ` +
            'timeline with both a face-down and a face-up card. Journey 6 cannot be reached without ' +
            `one. ${describeDrives(e.drives ?? [])}`,
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
      return pass(
        `"${e.title}", instructions before the timeline and wired to it; the hand: ` +
          describeDrives(e.drives ?? []),
      );
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

// Journey 6.7: `scripts/review-proxy.mjs` forwards the real review response with one hex digit of
// one salt flipped. A proxy that forwarded unchanged bytes would pass silently, so the check reads
// nothing until the proxy's log names the hand on screen.

const PROOF_FAILED_REASON = /position \d+ does not prove against the published root/u;

const VERIFIER_PENDING = 'Recomputing the deck proof in your browser.';

// `spoken` strips `aria-hidden` decoration, because a glyph and colour are not a sentence (8.2).
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
    // Decided against the tree, as 8.2 is.
    treeText: nodes.map((node) => node.name).filter((name) => name.length > 0),
  };
}

/**
 * Render a page server-side. This makes the proxy see a review, and proves the verdict is computed in
 * the browser, because an alert already in the server HTML would be announced by nothing.
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

const listHandSummaries = (page) =>
  page
    .evaluate(
      `fetch('/api/v1/hands?limit=10', { headers: { accept: 'application/json' } })
         .then((r) => (r.ok ? r.json() : { hands: [] }))
         .then((body) => (body.hands ?? []).map((hand) => ({ id: hand.id, board: (hand.board ?? []).length })))
         .catch(() => [])`,
    )
    .then((hands) => hands ?? []);

// Counted by hand id. CI run 43245665934 counted one hand read three times as three.
export function tallyListedHands(reads) {
  const listed = new Set();
  const boardless = new Set();
  for (const hands of reads) {
    for (const hand of hands) {
      listed.add(hand.id);
      if (hand.board === 0) boardless.add(hand.id);
    }
  }
  return { looks: reads.length, listed: listed.size, boardless: boardless.size };
}

/**
 * Play a hand without folding, so it reaches a flop and the reveal has a byte to flip. A reveal
 * proves only dealt board cards and shown hole cards. Reusing fold-first hands failed one run in
 * seven. A hero who calls or checks reaches a flop by the rules. Check before call, because a check
 * is free.
 */
async function stayInTheHand(page, evidence) {
  let first = null;
  const over = '/The hand is complete/u.test(document.body.innerText)';
  for (let decision = 0; decision < 12; decision += 1) {
    const acted = (await pressControl(page, /^check\b/iu)) ?? (await pressControl(page, /^call\b/iu));
    if (acted === null) break;
    first ??= acted;
    // Wait for the controls to go down first, or the next poll sees the previous turn's buttons.
    await waitInPage(page, `!(${ENABLED_ACTION})`, 10);
    if (!(await waitInPage(page, `${ENABLED_ACTION} || ${over}`, 60))) break;
    if ((await page.evaluate(over)) === true) break;
  }
  evidence.stayedIn = first;
  return first;
}

// Bounded at three attempts. Every candidate is recorded with what the proxy made of it.
async function findCorruptibleHand(page, proxiedBase, honestBase, proxy) {
  const tried = [];
  const reads = [];
  const drives = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.goto(`${proxiedBase}/review`);
    const hands = await listHandSummaries(page);
    reads.push(hands);
    for (const hand of hands) {
      if (tried.some((entry) => entry.id === hand.id)) continue;
      // A hand with no board card proves no deck position. See `stayInTheHand`.
      if (hand.board === 0) continue;
      const html = await renderedHtml(page, `/review/${hand.id}`);
      const record = proxy.log.mutated.find((entry) => entry.handId === hand.id) ?? null;
      // Match the path, so another hand's refusal is not reported as this one's.
      const refused = proxy.log.refused.findLast((e) => e.path.endsWith(`/${hand.id}`))?.why ?? null;
      tried.push({ id: hand.id, mutated: record !== null, why: record === null ? refused : null });
      if (record !== null) return { id: hand.id, html, record, tried, drives, ...tallyListedHands(reads) };
    }
    // Nothing reached a flop, so play a hand that will.
    if (attempt < 2) {
      drives.push(summariseDrive(await driveLiveHand(page, honestBase, { decide: stayInTheHand })));
    }
  }
  return { id: null, html: null, record: null, tried, drives, ...tallyListedHands(reads) };
}

// Waits for the verdict, which an effect computes, rather than a fixed settle.
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
  evidence.looks = found.looks;
  evidence.listed = found.listed;
  evidence.boardless = found.boardless;
  evidence.drives = found.drives;
  evidence.proxy = { reviews: proxy.log.reviews, refused: proxy.log.refused.slice(-3) };
  if (found.id === null) return evidence;
  evidence.hand = found.id;
  evidence.record = found.record;
  evidence.html = found.html;

  // Both halves read the same hand.
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
        // Without a corruption logged, a missing alert cannot be blamed on the application.
        return fail(
          `the proxy corrupted no reveal, so nothing was checked. This session listed ${e.listed ?? 0} ` +
            `distinct hand(s) over ${e.looks ?? 0} look(s), and ${e.boardless ?? 0} of them dealt no ` +
            `board card and could not carry one; the proxy saw ${e.proxy?.reviews ?? 0} review ` +
            `response(s) across the rest — ${JSON.stringify(
              (e.tried ?? []).map((entry) => `${entry.id}: ${entry.why ?? 'no record'}`),
            )}. To find one: ${describeDrives(e.drives ?? [])}. A hand that ended before the flop ` +
            'proves no deck position and has no byte to flip',
        );
      }
      if (e.record.serverOk !== true || !(e.record.serverPositions > 0)) {
        return fail(
          `the API's own verdict on the UNCORRUPTED payload was ${JSON.stringify(e.record.serverOk)} ` +
            `over ${e.record.serverPositions} position(s). This run would be measuring a broken API ` +
            'rather than a corrupted reveal',
        );
      }

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
          `"${e.corrupted.alert.spoken.slice(0, 56)}…" while the server still says ${corruptedServer.value}; ` +
          `the hand: ${describeDrives(e.drives ?? [])}`,
      );
    },
  },
];

const LAB_SUMMARY_JS = `(() => {
  const line = document.querySelector('.prl-lab-filters__summary');
  return line === null ? null : (line.textContent ?? '').replace(/\\s+/gu, ' ').trim();
})()`;

// Each option's count is computed against the other two facets, so "(0)" finds the empty case
// without knowing the catalogue.
const LAB_OPTIONS_JS = `(() => [...document.querySelectorAll('form.prl-lab-filters select')].map((select) => ({
  id: select.id,
  chosen: select.value,
  options: [...select.options].map((option) => {
    const text = (option.textContent ?? '').trim();
    const counted = /\\((\\d+)\\)\\s*$/u.exec(text);
    return { value: option.value, text, count: counted === null ? null : Number(counted[1]) };
  }),
})))()`;

const LAB_CONTEXT_MARKER = 'window.__prlLabContext';

// `wanting` is `'fewer'` or `'none'`, found from the counts the page prints.
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
        // The "any" option's own count is what this select shows with its own facet relaxed — on
        // an unfiltered page, the whole list — which is what makes "this option NARROWS the list"
        // decidable here rather than assumed. An option that matches everything would still change
        // the title and would prove nothing about a narrowing.
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
    // Absent means a full document load destroyed the context.
    contextSurvived: (await page.evaluate(`${LAB_CONTEXT_MARKER} ?? null`)) !== null,
    summaryIsLive: await page.evaluate(
      `(() => {
        const line = document.querySelector('.prl-lab-filters__summary');
        if (line === null) return null;
        return line.closest('[aria-live], [role="status"], [role="alert"]') !== null;
      })()`,
    ),
    // Recorded, not gated.
    regionMutations: speech.mutations.length,
  };
}

// The empty case needs an already-filtered page, because an option reads "(0)" only once another
// facet is set.
async function gatherLabIndex(page, baseUrl) {
  const evidence = {};
  evidence.title = await page.evaluate('document.title');
  evidence.summary = await page.evaluate(LAB_SUMMARY_JS);
  evidence.fields = await page.evaluate(LAB_OPTIONS_JS);

  await page.goto(`${baseUrl}/lab`);
  evidence.narrowed = await submitLabFilter(page, 'fewer');

  evidence.emptied = await submitLabFilter(page, 'none');
  return evidence;
}

function labOptionInventory(fields) {
  if (!Array.isArray(fields) || fields.length === 0) return 'nothing — the form rendered no selects';
  return fields
    .map(
      (field) =>
        `${field.id}: ${field.options.map((option) => `${option.value}(${option.count})`).join(' ')}`,
    )
    .join('; ');
}

const LAB_COUNT_PHRASE = /(?:all\s+\d+|\d+\s+of\s+\d+)/u;

// Read from the summary, not recomputed from the catalogue.
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
      4.2. The filter form is a plain GET, so a submit replaces the document and nothing can write into a
      live region. A filtered view carries its count in the title, which a new document announces.
        - the submit must still destroy the JavaScript context, because a client-side query change
          would announce nothing;
        - the unfiltered title carries no count;
        - narrowing and emptying submits put the page's own count in the title;
        - a run with no narrowing or zero-count option fails.
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

  // 4.3: read before the decision, because the analysis appears after it.
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
      // Bare means no unit element, percent or unit word, and digits only. "1.5 to 1" is not bare.
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

const SHEET_TAB_STOPS = 14;

// A floor under 7.4's negative sweep. Measured on `/` at 390x844, 188 elements match.
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

  // Put the caret back, so 7.5 tests the sheet and not this fixture.
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

// An element counts if it has its own text node, or is a control, image, landmark or explicit role.
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

// `axFlagsFor`, because `axFor` would fetch outer HTML for every ancestor.
async function gatherSheetBackground(page) {
  const elements = await page.evaluate(BACKGROUND_CONTENT_JS);
  if (elements === null) return null;
  const flags = await page.axFlagsFor('[data-prl-bg]');
  await page.evaluate(
    `document.querySelectorAll('[data-prl-bg]').forEach((el) => el.removeAttribute('data-prl-bg')); true`,
  );
  // Both lists come from one selector over one document. Check they line up.
  if (flags.length !== elements.length) return { misaligned: { dom: elements.length, ax: flags.length } };
  return elements.map((element, index) => ({ ...element, ...flags[index] }));
}

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
      7.4. `MobileNav` makes everything outside the open sheet `inert`. Measured before the fix: 29 of 34
      content-bearing elements behind the sheet were still in the tree.
        - the sheet's ancestors cannot be inert, because `inert` is inherited. They must carry no text
          of their own;
        - the route announcer is spared (`INERT_EXEMPT`) and must be empty and the only exemption;
        - fewer than `BACKGROUND_CONTENT_FLOOR` elements fails.
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

// 8.2: a second web app whose `PRL_API_ORIGIN` points at nothing, so `/learn` renders its bundled
// copy. See `OFFLINE_WEB_ORIGIN` in `ax-tree-audit.mjs`.

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
    // A `role="note"` takes no name from its contents, so the words must appear in the tree as text.
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
      // With `aria-hidden` glyphs stripped, what is left must still be a sentence.
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

// One entry per page visit, in the order the certification document walks them.
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
    // 2.9 needs two page visits. See `gatherQuizReview`.
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
  // Before the replay, so the replay reads back this hand instead of playing one (about 20s).
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
    // 6.7. It reads this session's hands, so it must run before `live-refusal` clears the cookies.
    key: 'deck-proof-alert',
    title: 'J6 Hand review, with one byte of the reveal flipped',
    origin: 'proxied',
    path: '/review',
    gather: gatherDeckProofAlert,
    checks: DECK_PROOF_CHECKS,
  },
  // 3.19 clears the cookies, so it runs after the replay.
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
    // 8.2 runs against the second web app, whose API origin points at nothing.
    key: 'bundled-copy',
    title: 'J8 Failure paths, with no API behind the web server',
    origin: 'offline',
    path: '/learn',
    gather: gatherBundledCopy,
    checks: BUNDLED_COPY_CHECKS,
  },
];

// `screen-reader-certify.test.mjs` asserts this equals the rows the document marks `auto`.
export const ASSERTION_IDS = ASSERTION_ROUTES.flatMap((route) =>
  route.checks.map((check) => check.id),
).sort();

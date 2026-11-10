/**
 * The accessibility rules this client keeps, checked over every component it ships.
 *
 * ## Why a scan, when there are already two audits and a keyboard gate
 *
 * `scripts/a11y-audit.mjs` reads delivered HTML, `scripts/keyboard-audit.mjs` presses real keys, and
 * `scripts/ax-tree-audit.mjs` walks the computed accessibility tree. All three need a running
 * server, a build and a browser, so none of them runs in `pnpm test` and none of them will fail a
 * pull request that reintroduces a rule this codebase has already learned the hard way. This file is
 * the cheap layer underneath them: it is source text, it runs in eighty milliseconds, and every rule
 * in it exists because breaking it produced a real defect in this app or in one exactly like it.
 *
 * It cannot decide whether a name is *useful*, whether a region fires, or whether anything is
 * announced. It decides whether the markup can possibly be right. That is a much weaker claim and it
 * is stated here so nobody quotes a green run as an accessibility result.
 *
 * ## Would this fail if the behaviour broke?
 *
 * Yes, and it was checked by breaking it rather than by reading it. `problemsIn` is a detector, and
 * the NEGATIVE CONTROL block below feeds it one synthetic component containing every violation it
 * knows about — a positive `tabIndex`, an assertive live region, an unlabelled `.prl-live-region`, an
 * `aria-hidden` wrapper around a tab stop — and asserts each one comes back named. The whole real
 * source tree is then run through the same detector and must come back clean, which is what makes
 * the first half meaningful.
 *
 * The scan additionally asserts on the SIZE of what it looked at. "No violations" and "no files" are
 * the same output, and only one of them is good news: if the glob ever stops matching, this file
 * fails rather than passing vacuously.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_SRC = resolve(HERE, '..', 'src');
/** The shared component package this app renders. Reached across the workspace deliberately — see below. */
const UI_SRC = resolve(HERE, '..', '..', '..', 'packages', 'ui', 'src');

const read = (path: string): string => readFileSync(path, 'utf8');

/**
 * Source with its comments removed.
 *
 * A rule stated in prose must not be read as a breach of itself: several files in this app document
 * exactly why they do not do the thing being scanned for, quoting the attribute by name.
 */
const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '');

/** Every component this app ships, as `{ name, code }` with comments already stripped. */
function components(): readonly { readonly name: string; readonly code: string }[] {
  return readdirSync(WEB_SRC, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.tsx'))
    .map((entry) => {
      const full = join(entry.parentPath, entry.name);
      return { name: full.slice(WEB_SRC.length + 1), code: withoutComments(read(full)) };
    });
}

/**
 * Every accessibility rule this codebase keeps, as a detector over one file.
 *
 * Each entry names the defect it exists for. A rule with no defect behind it is a style preference,
 * and a style preference enforced by a test is how a rule set stops being read.
 */
function problemsIn(name: string, code: string): readonly string[] {
  const problems: string[] = [];

  // 1. A positive tabindex forces an element ahead of document order, which desynchronises the tab
  //    sequence from the reading order for the whole page and cannot be reasoned about locally.
  for (const match of code.matchAll(/tabIndex=\{(\d+)\}/gu)) {
    if (Number(match[1]) > 0) {
      problems.push(`${name}: tabIndex={${String(match[1])}} forces this control ahead of document order`);
    }
  }

  // 2. Exactly one interrupting channel per screen, and it is `role="alert"`. An assertive region
  //    that is always present and merely changes its text interrupts on every update and is
  //    announced less reliably than an alert that is mounted when it applies.
  if (/aria-live="assertive"/u.test(code)) {
    problems.push(`${name}: aria-live="assertive" — use role="alert", mounted only when it applies`);
  }

  // 3. `.prl-live-region` is the visually-hidden announcement class. One with no role and no
  //    aria-live is a hidden div: it announces nothing at all, and looks exactly like one that does.
  for (const match of code.matchAll(/<[a-zA-Z]+[^>]*className="prl-live-region"[^>]*>/gu)) {
    const tag = match[0];
    if (!/role="/u.test(tag) && !/aria-live="/u.test(tag)) {
      problems.push(`${name}: a .prl-live-region with no role and no aria-live announces nothing`);
    }
  }

  // 4. An `aria-hidden` subtree containing a tab stop is reachable by keyboard and invisible to
  //    assistive technology — the reader lands on something that announces nothing (axe:
  //    aria-hidden-focus). Checked per element, which catches the common spelling of it.
  for (const match of code.matchAll(/<[a-zA-Z]+[^>]*aria-hidden="true"[^>]*>/gu)) {
    if (/tabIndex=\{0\}/u.test(match[0])) {
      problems.push(`${name}: an aria-hidden element is in the tab order`);
    }
  }

  // 5. A dialog must be modal and must be named, or a screen reader announces "dialog" and leaves
  //    the reader to work out what it is and whether the page behind it still matters.
  for (const match of code.matchAll(/<[a-zA-Z]+[^>]*role="dialog"[^>]*>/gsu)) {
    const tag = match[0];
    if (!/aria-modal="true"/u.test(tag)) problems.push(`${name}: role="dialog" without aria-modal`);
    if (!/aria-label(?:ledby)?=/u.test(tag)) problems.push(`${name}: role="dialog" with no accessible name`);
  }

  return problems;
}

describe('every component this app ships', () => {
  const files = components();

  it('keeps every rule, and says how many files it read', () => {
    const problems = files.flatMap((file) => problemsIn(file.name, file.code));
    assert.deepEqual(problems, [], problems.join('\n'));
    // The guard against a vacuous pass. If the glob breaks, this fails instead of reporting a clean
    // scan of nothing.
    assert.ok(
      files.length > 12,
      `only ${files.length} component(s) were scanned; a clean result over an empty set is the ` +
        'failure this assertion exists to rule out',
    );
  });

  it('has at least one live region to check, so rule 3 is not vacuous', () => {
    const regions = files.filter((file) => file.code.includes('prl-live-region'));
    assert.ok(
      regions.length >= 2,
      `only ${regions.length} file(s) use .prl-live-region; the rule about naming them is checking ` +
        'nothing',
    );
  });
});

describe('NEGATIVE CONTROL — a component that breaks every rule', () => {
  const broken = `
    export function Bad(): ReactElement {
      return (
        <div>
          <button tabIndex={3}>Ahead of everything</button>
          <p aria-live="assertive">Interrupting</p>
          <div className="prl-live-region">Announced by nothing</div>
          <span aria-hidden="true" tabIndex={0}>Reachable and invisible</span>
          <div role="dialog">A nameless, non-modal dialog</div>
        </div>
      );
    }
  `;
  const problems = problemsIn('Bad.tsx', broken);

  it('reports the positive tabindex', () => {
    assert.ok(
      problems.some((problem) => /tabIndex=\{3\}/u.test(problem)),
      problems.join('\n'),
    );
  });

  it('reports the assertive live region', () => {
    assert.ok(
      problems.some((problem) => /aria-live="assertive"/u.test(problem)),
      problems.join('\n'),
    );
  });

  it('reports the live region that announces nothing', () => {
    assert.ok(
      problems.some((problem) => /announces nothing/u.test(problem)),
      problems.join('\n'),
    );
  });

  it('reports the aria-hidden tab stop', () => {
    assert.ok(
      problems.some((problem) => /in the tab order/u.test(problem)),
      problems.join('\n'),
    );
  });

  it('reports both halves of the broken dialog', () => {
    assert.ok(
      problems.some((problem) => /without aria-modal/u.test(problem)),
      problems.join('\n'),
    );
    assert.ok(
      problems.some((problem) => /no accessible name/u.test(problem)),
      problems.join('\n'),
    );
  });

  it('reports six problems and not five', () => {
    // A count, so a rule that stops firing shows up here rather than in a green run six months
    // later. Six: one per rule, plus the dialog's two halves.
    assert.equal(problems.length, 6, problems.join('\n'));
  });
});

/**
 * The hidden-card rule, checked in the package that renders the cards.
 *
 * This file reaches across the workspace on purpose. `apps/web` is what puts these components on
 * screen, the rule is a hidden-INFORMATION rule before it is an accessibility one, and there is no
 * point owning a contract about face-down cards in the app while the component that could break it
 * is checked nowhere. `packages/ui` has its own render harness and its own tests; this is the
 * belt-and-braces assertion that the specific defence has not been deleted as redundant.
 *
 * ## What these three do NOT cover, said here because it was quoted as if they did
 *
 * They are regexes over source text and every one of them asks what this app does when
 * `holeCards === null` — the case where the server sent nothing and there is nothing to leak. All
 * three pass against an API that serves one player another player's cards, because the source they
 * read is correct and correct source renders a dishonest frame faithfully. `docs/VERIFICATION.md`
 * §12 carried that as an open residual until 2026-08-27.
 *
 * The other case — a `holeCards` pair on a seat that is neither the reader's nor one that showed
 * down — is `test/hole-card-entitlement.test.ts`, which runs real frames from `redactFor` through
 * the real narrowing rather than reading any source at all. Keep both: this file notices a defence
 * being deleted, that one notices the server lying, and neither sees the other's failure.
 */
describe('a card the server hid stays hidden', () => {
  const card = withoutComments(read(join(UI_SRC, 'components', 'PlayingCard.tsx')));
  const seat = withoutComments(read(join(UI_SRC, 'components', 'Seat.tsx')));

  it('names a face-down card as face-down, and names nothing else', () => {
    assert.match(
      card,
      /aria-label="face-down card"/u,
      'a face-down card that carries no name is announced as an unnamed image, so its state is a ' +
        'visual cue only — and a sighted reader can see it is face-down',
    );
  });

  it('short-circuits before it decodes the card', () => {
    const faceDownAt = card.indexOf('if (faceDown) {');
    const describeAt = card.indexOf('const described = describeCard(card);');
    assert.ok(faceDownAt > 0 && describeAt > 0, 'the two landmarks of this rule have moved');
    // `described` is computed above the branch, but the branch must return before anything derived
    // from it can reach the DOM. Asserted as "the face-down branch renders no `described` field".
    const branch = card.slice(faceDownAt, card.indexOf('}', card.indexOf('return (', faceDownAt)));
    assert.doesNotMatch(
      branch,
      /described/u,
      'the face-down branch must not touch the decoded card at all: rank, pip, suit letter and ' +
        'data-suit are all values the server deliberately did not send',
    );
  });

  it('decides face-down from the server’s silence, not from a flag the client owns', () => {
    assert.match(
      seat,
      /const faceDown = holeCards === null;/u,
      '`null` means "you are not entitled to see these", which is exactly the condition for drawing ' +
        'a back — so "should I show these?" is not a question this component can get wrong',
    );
    assert.match(
      seat,
      /const FACE_DOWN_PAIR: readonly number\[\] = \[-1, -1\];/u,
      '-1 and not 0: zero is the two of clubs, and leaving real card integers in the props of a ' +
        'hidden card is how an accidental leak starts',
    );
  });
});

/**
 * The one modal surface in the product.
 *
 * Every assertion here is a defence that a real audit of this app found missing somewhere, and each
 * one is cheap to delete while refactoring and expensive to notice afterwards.
 */
describe('the navigation sheet is a real modal', () => {
  const nav = withoutComments(read(join(WEB_SRC, 'components', 'MobileNav.tsx')));

  it('is a named, modal dialog', () => {
    assert.match(nav, /role="dialog"/u);
    assert.match(nav, /aria-modal="true"/u);
    assert.match(nav, /aria-label="Menu"/u);
  });

  it('is removed from the tree when closed rather than unmounted', () => {
    // `hidden` keeps it out of the accessibility tree AND out of the tab order, while leaving
    // `aria-controls` pointing at something that exists for the whole life of the page.
    assert.match(nav, /hidden=\{!open\}/u);
  });

  it('traps focus on Tab AND on anything else that moves it', () => {
    assert.match(nav, /event\.key !== 'Tab'/u, 'the Tab half');
    assert.match(
      nav,
      /document\.addEventListener\('focusin', onFocusIn\)/u,
      'the other half: arrow keys move focus inside a radio group natively, so a keydown handler ' +
        'never sees a decision it can cancel. Only watching where focus LANDS closes the class',
    );
  });

  it('lets Escape out, and hands focus back to the trigger', () => {
    assert.match(nav, /event\.key === 'Escape'/u);
    assert.match(nav, /triggerRef\.current\?\.focus\(\)/u);
  });

  it('counts a radio group as one tab stop, which is what the browser does', () => {
    assert.match(
      nav,
      /function tabbableWithin/u,
      'the raw focusable list makes the last theme radio the "last" element, which is only the tab ' +
        'stop for a reader who has already chosen Dark — and on the default, Tab walked out of the ' +
        'open sheet onto the fold, call and raise controls behind it',
    );
  });
});

/**
 * The boundary of last resort.
 *
 * `app/error.tsx` catches a failure inside a route and has done for a long time; a failure in the
 * root layout fell through to Next's unstyled default page, with no `lang`, no viewport meta, no
 * heading and nothing announced. These assertions pin the replacement.
 */
describe('the global error boundary', () => {
  const globalError = withoutComments(read(join(WEB_SRC, 'app', 'global-error.tsx')));

  it('renders a whole document, with a language and a viewport', () => {
    assert.match(globalError, /<html lang="en"/u);
    assert.match(globalError, /<body/u);
    assert.match(
      globalError,
      /<meta name="viewport" content="width=device-width, initial-scale=1" \/>/u,
      'without it a phone lays this page out at 980px and scales it down, so the message arrives at ' +
        'about a third of the reader’s chosen text size',
    );
  });

  it('announces itself, because nothing else is left to', () => {
    assert.match(
      globalError,
      /role="alert"/u,
      'this boundary replaces the ROOT, so it takes the route announcer and the whole shell with ' +
        'it, and it is reached by a render failure rather than by a navigation — nothing else on ' +
        'the page will say a word',
    );
    assert.match(globalError, /<h1/u, 'it is the page for as long as it is on screen, so it owns the h1');
  });

  it('is styled with attributes only, because the app’s own CSP blocks a <style> element', () => {
    assert.doesNotMatch(
      globalError,
      /<style/u,
      "src/lib/csp.ts ships `style-src 'self'` with no unsafe-inline and no nonce entry, so a " +
        '<style> element here is refused by the browser and the page renders unstyled anyway — ' +
        'which is the exact failure this file exists to remove',
    );
    assert.match(globalError, /style=\{PAGE\}/u, 'style ATTRIBUTES are allowed: style-src-attr is');
  });

  it('discloses the digest and never the exception', () => {
    assert.match(globalError, /error\.digest/u);
    assert.doesNotMatch(
      globalError,
      /error\.message/u,
      'in production that is a digest-shaped token with no meaning to a reader; in development it ' +
        'is an internal detail. Neither belongs on screen',
    );
  });
});

/**
 * The accessibility rules this client keeps, checked over every component it ships.
 * The cheap source-text layer under `scripts/a11y-audit.mjs`, `keyboard-audit.mjs` and
 * `ax-tree-audit.mjs`, which need a build and a browser. It decides only whether the markup can be
 * right, so a green run is not an accessibility result.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_SRC = resolve(HERE, '..', 'src');
const UI_SRC = resolve(HERE, '..', '..', '..', 'packages', 'ui', 'src');

const read = (path: string): string => readFileSync(path, 'utf8');

/** Comments removed, because several files quote a scanned attribute to explain why they avoid it. */
const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '');

function components(): readonly { readonly name: string; readonly code: string }[] {
  return readdirSync(WEB_SRC, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.tsx'))
    .map((entry) => {
      const full = join(entry.parentPath, entry.name);
      return { name: full.slice(WEB_SRC.length + 1), code: withoutComments(read(full)) };
    });
}

/** Every accessibility rule this codebase keeps. Each entry names the defect it exists for. */
function problemsIn(name: string, code: string): readonly string[] {
  const problems: string[] = [];

  // 1. A positive tabindex desynchronises the tab sequence from reading order for the whole page.
  for (const match of code.matchAll(/tabIndex=\{(\d+)\}/gu)) {
    if (Number(match[1]) > 0) {
      problems.push(`${name}: tabIndex={${String(match[1])}} forces this control ahead of document order`);
    }
  }

  // 2. One interrupting channel per screen, `role="alert"` mounted when it applies. A standing
  //    assertive region interrupts on every update and is announced less reliably.
  if (/aria-live="assertive"/u.test(code)) {
    problems.push(`${name}: aria-live="assertive" — use role="alert", mounted only when it applies`);
  }

  // 3. A `.prl-live-region` with no role and no aria-live is a hidden div that announces nothing.
  for (const match of code.matchAll(/<[a-zA-Z]+[^>]*className="prl-live-region"[^>]*>/gu)) {
    const tag = match[0];
    if (!/role="/u.test(tag) && !/aria-live="/u.test(tag)) {
      problems.push(`${name}: a .prl-live-region with no role and no aria-live announces nothing`);
    }
  }

  // 4. An `aria-hidden` tab stop is reachable by keyboard and silent (axe: aria-hidden-focus).
  for (const match of code.matchAll(/<[a-zA-Z]+[^>]*aria-hidden="true"[^>]*>/gu)) {
    if (/tabIndex=\{0\}/u.test(match[0])) {
      problems.push(`${name}: an aria-hidden element is in the tab order`);
    }
  }

  // 5. A dialog must be modal and named, or a screen reader announces only "dialog".
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
    // Six: one per rule, plus the dialog's two halves.
    assert.equal(problems.length, 6, problems.join('\n'));
  });
});

/**
 * The hidden-card rule, checked in `packages/ui`, which renders the cards. These cover only
 * `holeCards === null`. A server that sends a seat cards it is not entitled to is caught by
 * `test/hole-card-entitlement.test.ts`, so keep both.
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
    // `described` is computed above the branch, and the branch must return before it reaches the DOM.
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

/** The one modal surface in the product. */
describe('the navigation sheet is a real modal', () => {
  const nav = withoutComments(read(join(WEB_SRC, 'components', 'MobileNav.tsx')));

  it('is a named, modal dialog', () => {
    assert.match(nav, /role="dialog"/u);
    assert.match(nav, /aria-modal="true"/u);
    assert.match(nav, /aria-label="Menu"/u);
  });

  it('is removed from the tree when closed rather than unmounted', () => {
    // `hidden` removes it from the AX tree and the tab order, and `aria-controls` still resolves.
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
 * A failure in the root layout fell through to Next's unstyled default page, with no `lang`, no
 * viewport meta and nothing announced. These pin the replacement.
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

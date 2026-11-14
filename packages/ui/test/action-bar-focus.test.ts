/**
 * `ActionBar` while a decision is in flight: what the markup offers the caret, and where the code puts it.
 * A browser blurs a control the moment it becomes disabled, so the caret sat on `<body>` for the whole
 * round trip. The landing place is rendered. The focus move is an effect and there is no DOM (ADR 0008),
 * so it is read from the source, and each source predicate also runs over `WITHOUT_THE_FIX`.
 * `scripts/keyboard-audit.mjs` and `scripts/ax-tree-audit.mjs` cover it in a real browser.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LegalAction, TableAction } from '../src/view-types.ts';
import { loadComponent } from './support/render-component.ts';

interface ActionBarProps {
  readonly legalActions: readonly LegalAction[];
  readonly onAct: (action: TableAction) => void;
  readonly pot: number;
  readonly toCall: number;
  readonly committedThisStreet: number;
  readonly disabled?: boolean;
  readonly idleText?: string;
  readonly className?: string;
}

/** The spot the keyboard audit meets at `/play?state=decision`: fold, call, raise. */
const FACING_A_BET: readonly LegalAction[] = [
  { type: 'fold' },
  { type: 'call', minTo: 100, costAtMin: 100 },
  { type: 'raise', minTo: 200, maxTo: 840, note: 'The minimum raise is twice the current bet.' },
];

async function render(props: Partial<ActionBarProps> = {}): Promise<string> {
  const ActionBar = await loadComponent<ActionBarProps>('components/ActionBar', 'ActionBar');
  return renderToStaticMarkup(
    createElement(ActionBar, {
      legalActions: FACING_A_BET,
      onAct: () => undefined,
      pot: 300,
      toCall: 100,
      committedThisStreet: 0,
      ...props,
    }),
  );
}

/** Every `<button …>` start tag in the markup, so its attributes can be read together. */
function buttonTags(markup: string): readonly string[] {
  return [...markup.matchAll(/<button[^>]*>/gu)].map((match) => match[0]);
}

function actionButtonTags(markup: string): readonly string[] {
  return buttonTags(markup).filter((tag) => tag.includes('prl-action-btn'));
}

function paragraphWithClass(markup: string, className: string): string | null {
  const found = new RegExp(`<p[^>]*class="[^"]*${className}[^"]*"[^>]*>`, 'u').exec(markup);
  return found === null ? null : found[0];
}

const SOURCE_PATH = join(
  resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src'),
  'components',
  'ActionBar.tsx',
);
const SOURCE = readFileSync(SOURCE_PATH, 'utf8');

/** The source without the in-flight line and its effect. Every predicate must return false for it. */
const WITHOUT_THE_FIX = SOURCE.replace(
  /useLayoutEffect\(\(\) => \{[\s\S]*?\}, \[disabled, focus\]\);/u,
  '',
).replace(/\{disabled \? \(\n {10}<p[\s\S]*?<\/p>\n {8}\) : null\}/u, '');
const WITHOUT_ACTIVATION_MARK = SOURCE.replace(/focus\.claim\(\);\n {4}onAct\(action\);/u, 'onAct(action);');

describe('while a decision is in flight', () => {
  it('offers the caret a named place to land, inside the bar', async () => {
    const markup = await render({ disabled: true });
    const landing = paragraphWithClass(markup, 'prl-action-bar__idle');
    assert.ok(
      landing !== null,
      `no landing place while disabled; the caret has nowhere to go but <body>:\n${markup}`,
    );
    assert.match(
      landing,
      /tabindex="-1"/u,
      'the landing place must be focusable by script and NOT a tab stop: a reader tabbing past a ' +
        'table should not have to stop on a line that says a decision is in flight',
    );
    assert.match(
      landing,
      /role="status"/u,
      'a focused `role="group"` is not reported as the focused AX node in Chrome 151 — the tree ' +
        'keeps `RootWebArea` focused even while document.activeElement is the group. `status` is ' +
        'exposed as focused, and it can carry the accessible name.',
    );
    assert.match(
      landing,
      /aria-label="[^"]{10,}"/u,
      'the status needs a name, or the role is the only thing announced',
    );
  });

  it('leaves every control natively disabled rather than making it look operable', async () => {
    const markup = await render({ disabled: true });
    const tags = actionButtonTags(markup);
    // A sweep of nothing is not a pass.
    assert.ok(tags.length >= 3, `expected the decision row, found ${tags.length} action button(s)`);
    for (const tag of tags) {
      assert.match(tag, /\sdisabled(=""|\s|>)/u, `an action control is not disabled while in flight: ${tag}`);
    }
    // `aria-disabled` would keep the caret, but `components.css` styles only `:disabled`.
    assert.doesNotMatch(
      markup,
      /aria-disabled/u,
      'an aria-disabled control looks operable in this design system, because only `:disabled` is ' +
        'styled. A player pressing Fold twice because it looked live is worse than a lost caret.',
    );
  });

  it('says on the screen that the wait is the server’s, not the reader’s', async () => {
    const markup = await render({ disabled: true });
    assert.match(
      markup,
      /Waiting for the server\./u,
      'the landing place has to say something a sighted reader can read too; a caret moved to an ' +
        'empty line is a second silence',
    );
  });
});

describe('when nothing is in flight', () => {
  it('renders no landing place at all', async () => {
    const markup = await render({ disabled: false });
    // The control for the block above. It fails if that assertion matched something always present.
    assert.equal(
      paragraphWithClass(markup, 'prl-action-bar__idle'),
      null,
      'the in-flight line must exist only while there is a decision in flight',
    );
    assert.doesNotMatch(markup, /Waiting for the server/u);
  });

  it('leaves the controls enabled', async () => {
    const tags = actionButtonTags(await render({ disabled: false }));
    assert.ok(tags.length >= 3, `expected the decision row, found ${tags.length} action button(s)`);
    for (const tag of tags) {
      assert.doesNotMatch(tag, /\sdisabled(=""|\s|>)/u, `an action control is disabled at rest: ${tag}`);
    }
  });

  it('still gives the idle state its own landing place', async () => {
    // When the turn ends the whole row is replaced by one line, and the caret moves to it.
    const markup = await render({ legalActions: [] });
    const idle = paragraphWithClass(markup, 'prl-action-bar__idle');
    assert.ok(idle !== null, `the idle state renders no line to land on:\n${markup}`);
    assert.match(idle, /tabindex="-1"/u);
    assert.match(idle, /role="status"/u, 'the idle sentence is announced whether or not focus arrives');
  });
});

describe('where the caret is actually moved', () => {
  const rescuesOnDisable = (source: string): boolean =>
    /useLayoutEffect\(\(\) => \{/u.test(source) &&
    /inFlightRef\.current\?\.focus\(\{ preventScroll: true \}\);/u.test(source);

  const yieldsToAnOuterRescue = (source: string): boolean =>
    /layout effects run child-then-parent/u.test(source) &&
    /inFlightRef\.current\?\.focus\(\{ preventScroll: true \}\);/u.test(source);

  const returnsTheCaret = (source: string): boolean =>
    /if \(!returned \|\| !parked\.current\) return;/u.test(source) &&
    /control\.focus\(\{ preventScroll: true \}\);/u.test(source);

  it('moves it to the landing place when the controls are disabled under it', () => {
    assert.ok(
      rescuesOnDisable(SOURCE),
      'nothing moves the caret when `disabled` goes true, so it stays on <body> for the round trip',
    );
    assert.equal(rescuesOnDisable(WITHOUT_THE_FIX), false, 'the negative control did not remove the rescue');
  });

  it('stands down if the caller has already moved it somewhere better', () => {
    // `TableStage` moves the caret to its acknowledgement. Effects run child-first in one commit, so
    // an unconditional rescue here would replace it.
    assert.ok(
      yieldsToAnOuterRescue(SOURCE),
      'the rescue must park in a layout effect so a parent layout effect can overwrite it in ' +
        'the same frame — a microtask would run after the parent and steal the caret back',
    );
    assert.equal(yieldsToAnOuterRescue(WITHOUT_THE_FIX), false, 'the negative control left the yield in');
  });

  it('gives the caret back to the control it came from when the answer arrives', () => {
    assert.ok(
      returnsTheCaret(SOURCE),
      'the in-flight line unmounts when `disabled` clears, so without a restore the caret lands on ' +
        '<body> again — the same defect, moved to the other end of the round trip',
    );
    assert.equal(returnsTheCaret(WITHOUT_THE_FIX), false, 'the negative control did not remove the restore');
  });

  it('never moves the caret of a reader who was not in the bar', () => {
    // A reader halfway down the Coach panel must not be pulled back when an opponent acts. What counts
    // as leaving is `createFocusRescue`'s, tested in `focus-hooks.test.ts`.
    assert.match(SOURCE, /if \(!focus\.held\(\)\) return;/u);
    assert.match(SOURCE, /focus\.rescue\(idleRef\.current\);/u);
    assert.match(
      SOURCE,
      /if \(focus\.onBlurCapture\(event\)\) parked\.current = false;/u,
      'a reader who tabs away during the wait has left the bar, and must not be pulled back into it',
    );
  });

  it('records an activated control as in-bar before dispatching the action', () => {
    const activationMark =
      /const actFromBar = \(action: TableAction\): void => \{[\s\S]*?focus\.claim\(\);[\s\S]*?onAct\(action\);/u;
    assert.match(
      SOURCE,
      activationMark,
      'a keyboard activation can arrive without a focus event, so dispatch must record bar focus',
    );
    assert.doesNotMatch(
      WITHOUT_ACTIVATION_MARK,
      activationMark,
      'the regression control still contains the activation mark',
    );
    assert.doesNotMatch(
      SOURCE,
      /onClick=\{\(\) => onAct\(\{/u,
      'an action must not bypass the focus-preserving dispatch wrapper',
    );
  });
});

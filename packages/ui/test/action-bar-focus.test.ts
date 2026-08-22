/**
 * `ActionBar` while a decision is in flight: what the markup offers the caret, and where the code
 * puts it.
 *
 * ## The defect this exists for
 *
 * `disabled` goes true the instant a decision is sent, and a browser blurs the focused element the
 * moment it becomes disabled. Every action, every time, the caret sat on `<body>` for the whole
 * server round trip: a keyboard reader was returned to the top of the document with no
 * announcement, and a screen-reader reader was told nothing at all, because nothing that says
 * anything had focus. `ActionBar`'s existing rescue did not cover it — that one fires when
 * `legalActions` goes EMPTY, which happens when the server's next frame arrives, so the gap was
 * exactly the wait. On a fixture path, where no frame ever arrives, it was permanent.
 *
 * ## What is rendered here, and what is read from the source, and why the split is honest
 *
 * This package's tests run under `node --test` with no DOM and no client renderer (ADR 0008 — and
 * adding one is a dependency this project has declined), so `renderToStaticMarkup` is the whole of
 * what can be rendered and no effect ever runs. That splits this file in two, the same way
 * `action-bar-render.test.ts` split for the same reason:
 *
 *   - the DESTINATION is markup, and markup is rendered for real through `loadComponent` — by the
 *     same compiler and the same React the app ships. "While `disabled` holds there is a named,
 *     focusable, non-tab-stop place inside the bar, and while it does not there is nothing" is
 *     therefore a fact about the component and not about a copy of it;
 *   - the MOVE is an effect, and the one thing rendered markup cannot show is whether anything ever
 *     calls `.focus()`. That is asserted against the component's own source, with each assertion
 *     expressed as a predicate that is ALSO run against a mutated source in which the fix has been
 *     removed — see "Would this fail" below.
 *
 * The behaviour end to end is covered where a real browser exists: `scripts/keyboard-audit.mjs`
 * presses Enter on Fold at `/play?state=decision` with `Input.dispatchKeyEvent` and
 * `scripts/ax-tree-audit.mjs` reads the computed accessibility tree afterwards and fails if the
 * focused node is the document.
 *
 * ## Would this fail if the behaviour broke?
 *
 * Yes, and it was checked by breaking it rather than by reasoning about it.
 *
 *   - Every source predicate below is run twice: once over the real file, and once over a copy with
 *     the corresponding lines removed, asserting it comes back false. A predicate that cannot fail
 *     is a predicate that has never proved anything.
 *   - The markup assertions have their own control: the SAME assertions are run against the bar
 *     rendered with `disabled: false`, where the landing place must be absent. A test that matched
 *     something always present would fail that half.
 *   - And with the fix genuinely reverted in `src/components/ActionBar.tsx` — the in-flight line
 *     deleted from the render and the second effect deleted entirely — this file reported
 *     **6 of its 10 tests failing**. Restoring the fix returned it to 10 passing, 0 failing. The
 *     four that still passed with the fix out are the ones about the state where nothing is in
 *     flight, which is exactly what they claim to be about.
 *   - Every scan asserts the size of what it looked at (`assert.ok(tags.length >= 3)` and friends),
 *     because "nothing wrong was found" and "nothing was examined" are indistinguishable in a
 *     passing report and only one of them is good news.
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

/** The action buttons specifically: the ones inside the decision row carry `prl-action-btn`. */
function actionButtonTags(markup: string): readonly string[] {
  return buttonTags(markup).filter((tag) => tag.includes('prl-action-btn'));
}

/** The `<p …>` start tag carrying this class, or null. */
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

/**
 * The source with the fix taken back out, for the negative controls.
 *
 * Both halves are removed the way a regression would remove them: the in-flight landing place stops
 * being rendered, and the effect that moves and restores the caret stops existing. Every predicate
 * below has to come back false for this string, or it is not testing what it claims to test.
 */
const WITHOUT_THE_FIX = SOURCE.replace(/queueMicrotask\([\s\S]*?\n {6}\}\);/u, '')
  .replace(/ {4}if \(!returned \|\| !parked\.current\) return;[\s\S]*?control\.focus\(\);/u, '')
  .replace(/\{disabled \? \(\n {8}<p[\s\S]*?<\/p>\n {6}\) : null\}/u, '');

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
      /role="group"/u,
      'a bare focusable <p> computes an EMPTY accessible name (measured in Chrome 151 by ' +
        'TableStage.tsx), so a reader whose caret has just been moved would be told nothing about ' +
        'where it went. `group` is the role that can carry a name.',
    );
    assert.match(
      landing,
      /aria-label="[^"]{10,}"/u,
      'the group needs a name, or the role is the only thing announced',
    );
  });

  it('leaves every control natively disabled rather than making it look operable', async () => {
    const markup = await render({ disabled: true });
    const tags = actionButtonTags(markup);
    // The scan-size guard: three legal actions are offered above, so a pass over an empty set is
    // ruled out rather than assumed.
    assert.ok(tags.length >= 3, `expected the decision row, found ${tags.length} action button(s)`);
    for (const tag of tags) {
      assert.match(tag, /\sdisabled(=""|\s|>)/u, `an action control is not disabled while in flight: ${tag}`);
    }
    // The rejected alternative, held rejected. `aria-disabled` keeps the caret where it is — which
    // is why it was so nearly the answer — but nothing in `components.css` styles it, so the row
    // would keep its enabled colours and its pointer while doing nothing at all.
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
    // The control for the block above: if that assertion matched something always present, this
    // one would fail. An always-present labelled group also sits in every reader's rotor
    // announcing an empty container on a table where nothing has been sent.
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
    // The older rescue, which this change must not have broken: when the turn ENDS the whole row is
    // replaced by one line, and that line is what the caret is moved to.
    const markup = await render({ legalActions: [] });
    const idle = paragraphWithClass(markup, 'prl-action-bar__idle');
    assert.ok(idle !== null, `the idle state renders no line to land on:\n${markup}`);
    assert.match(idle, /tabindex="-1"/u);
    assert.match(idle, /role="status"/u, 'the idle sentence is announced whether or not focus arrives');
  });
});

describe('where the caret is actually moved', () => {
  // Not renderable here: no DOM, so no effect and no `document.activeElement`. Asserted over the
  // source, and every predicate is proved able to fail by running it over `WITHOUT_THE_FIX`.

  const rescuesOnDisable = (source: string): boolean =>
    /queueMicrotask\(\(\) => \{/u.test(source) && /inFlightRef\.current\?\.focus\(\);/u.test(source);

  const yieldsToAnOuterRescue = (source: string): boolean =>
    /queueMicrotask\(\(\) => \{\s*if \(!browserAbandonedFocus\(\)\) return;/u.test(source);

  const returnsTheCaret = (source: string): boolean =>
    /if \(!returned \|\| !parked\.current\) return;/u.test(source) && /control\.focus\(\);/u.test(source);

  it('moves it to the landing place when the controls are disabled under it', () => {
    assert.ok(
      rescuesOnDisable(SOURCE),
      'nothing moves the caret when `disabled` goes true, so it stays on <body> for the round trip',
    );
    assert.equal(rescuesOnDisable(WITHOUT_THE_FIX), false, 'the negative control did not remove the rescue');
  });

  it('stands down if the caller has already moved it somewhere better', () => {
    // `TableStage` moves the caret to the acknowledgement that says what became of the decision,
    // which carries more than this bar can know. Effects run child-first in one commit, so an
    // unconditional rescue here would win that race every time and silently replace it.
    assert.ok(
      yieldsToAnOuterRescue(SOURCE),
      'the rescue must yield a microtask and re-check that the browser really did give up on ' +
        'focus, or it fights the rescue its own caller performs',
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
    // The guard that stops this being a worse bug than the one it fixes: a table where the
    // opponent acts while the reader is halfway down the Coach panel must not yank them back.
    assert.match(SOURCE, /if \(!hadFocus\.current\) return;/u);
    assert.match(
      SOURCE,
      /if \(next !== null && !event\.currentTarget\.contains\(next\)\) \{/u,
      'a reader who tabs away during the wait has left the bar, and must not be pulled back into it',
    );
  });
});

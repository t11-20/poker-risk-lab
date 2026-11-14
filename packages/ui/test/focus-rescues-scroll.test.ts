/**
 * The live table's focus rescues move the caret and never the page.
 * A plain `.focus()` scrolls its target into view. At 390x844 every action jumped the page 566 to
 * 2,073px, so every rescue passes `{ preventScroll: true }`.
 * Asserted over the sources because the move happens in an effect and `node --test` has no DOM
 * (ADR 0008). `test:keyboard` measures the browser half.
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

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const WEB_SRC = resolve(SRC, '..', '..', '..', 'apps', 'web', 'src');

/** Every `.focus(` call in a file, with what it was passed, comments removed first. */
function focusCalls(path: string): readonly string[] {
  const source = readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/^\s*\/\/.*$/gmu, '');
  return [...source.matchAll(/\.focus\(([^)]*)\)/gu)].map((match) => match[1] ?? '');
}

/** Every `focus.rescue(` in a file. `useFocusRescue` does the move, and its own file is swept below. */
function rescueCalls(path: string): number {
  return [...readFileSync(path, 'utf8').matchAll(/\bfocus\.rescue\(/gu)].length;
}

/** Label, path, then the least number of `.focus(` calls and of `focus.rescue(` calls in it. */
const RESCUERS: readonly (readonly [string, string, number, number])[] = [
  ['ActionBar.tsx', join(SRC, 'components', 'ActionBar.tsx'), 2, 1],
  ['TableStage.tsx', join(WEB_SRC, 'components', 'TableStage.tsx'), 0, 2],
  ['LiveTable.tsx', join(WEB_SRC, 'app', 'play', 'LiveTable.tsx'), 0, 1],
  ['focus-rescue.ts', join(SRC, 'focus-rescue.ts'), 1, 0],
];

describe('the live table’s focus rescues pass preventScroll', () => {
  for (const [label, path, expected, rescues] of RESCUERS) {
    it(`${label}: every focus move is { preventScroll: true }`, () => {
      const calls = focusCalls(path);
      // A sweep of nothing is not a pass.
      assert.ok(
        calls.length >= expected,
        `${label}: expected at least ${expected} focus calls, found ${calls.length}`,
      );
      assert.ok(
        rescueCalls(path) >= rescues,
        `${label}: expected at least ${rescues} focus.rescue calls, found ${rescueCalls(path)}`,
      );
      assert.ok(calls.length + rescueCalls(path) > 0, `${label}: no focus move found at all`);
      for (const argument of calls) {
        assert.match(argument, /preventScroll:\s*true/u, `${label}: .focus(${argument}) scrolls the page`);
      }
    });
  }

  it('NEGATIVE CONTROL: the detector fires on a bare .focus()', () => {
    const bare = [...'idleRef.current?.focus();'.matchAll(/\.focus\(([^)]*)\)/gu)].map((m) => m[1] ?? '');
    assert.equal(bare.length, 1);
    assert.doesNotMatch(bare[0] ?? '', /preventScroll:\s*true/u);
  });
});

// A move that does not scroll has to land somewhere already on screen.

interface ActionBarProps {
  readonly legalActions: readonly LegalAction[];
  readonly onAct: (action: TableAction) => void;
  readonly pot: number;
  readonly toCall: number;
  readonly committedThisStreet: number;
  readonly disabled?: boolean;
}

function actionRow(markup: string): string {
  const start = markup.indexOf('<div class="prl-action-bar__actions">');
  assert.ok(start >= 0, `no action row rendered:\n${markup}`);
  let depth = 0;
  const tags = /<\/?div\b[^>]*>/gu;
  tags.lastIndex = start;
  for (let match = tags.exec(markup); match !== null; match = tags.exec(markup)) {
    depth += match[0].startsWith('</') ? -1 : 1;
    if (depth === 0) return markup.slice(start, match.index + match[0].length);
  }
  return assert.fail('the action row never closed');
}

const IN_FLIGHT = /<p[^>]*aria-label="Your decision is with the server"/u;

describe('the caret lands where it can be seen', () => {
  it('puts the in-flight line inside the action row, which is what sticks on a narrow column', async () => {
    // At 390x844, after the row the line sat at viewport y 1,099 under a sticky row at 620. Inside it, 751.
    const ActionBar = await loadComponent<ActionBarProps>('components/ActionBar', 'ActionBar');
    const markup = renderToStaticMarkup(
      createElement(ActionBar, {
        legalActions: [
          { type: 'fold' },
          { type: 'call', minTo: 100, costAtMin: 100 },
        ] as unknown as readonly LegalAction[],
        onAct: () => undefined,
        pot: 300,
        toCall: 100,
        committedThisStreet: 0,
        disabled: true,
      }),
    );
    assert.match(markup, IN_FLIGHT, 'no in-flight line rendered while disabled; the sweep is over nothing');
    assert.match(actionRow(markup), IN_FLIGHT, 'the in-flight line is outside the row that sticks');
  });

  it('NEGATIVE CONTROL: the detector fails the old placement, after the row', () => {
    const old =
      '<div class="prl-action-bar__actions"><button>Fold</button></div>' +
      '<p aria-label="Your decision is with the server" class="prl-action-bar__idle">Waiting</p>';
    assert.match(old, IN_FLIGHT);
    assert.doesNotMatch(actionRow(old), IN_FLIGHT);
  });

  it('follows the table by bringing the buttons in by the nearest edge, never the band by its bottom', () => {
    // At 390x844 the band is taller than the scroll-padded space, and `block: 'end'` hid the reader's
    // plate under the header (y -209..12). The buttons by 'nearest' left it at 316..537.
    const follow = (source: string): boolean =>
      /querySelector<HTMLElement>\('\.prl-action-bar__actions'\) \?\? element/u.test(source) &&
      /target\.scrollIntoView\(\{ block: 'nearest'/u.test(source) &&
      !/scrollIntoView\(\{ block: 'end'/u.test(source);
    const live = readFileSync(join(WEB_SRC, 'app', 'play', 'LiveTable.tsx'), 'utf8');
    assert.ok(follow(live), 'useFollowTheTable no longer brings the action row in by its nearest edge');
    const old = "element.scrollIntoView({ block: 'end', behavior: reduced ? 'auto' : 'smooth' });";
    assert.equal(follow(old), false, 'NEGATIVE CONTROL: the detector passed the band-by-its-bottom version');
  });

  it('spans the acknowledgement across the band, so it cannot squeeze the controls', () => {
    // Auto-placed in the plate's `auto` column, the callout widened it and wrapped the buttons.
    // At 1440x900 the row went from 72px to 232px tall.
    const stage = readFileSync(join(WEB_SRC, 'components', 'TableStage.tsx'), 'utf8');
    const css = readFileSync(join(WEB_SRC, 'styles', 'play.css'), 'utf8');
    assert.match(stage, /aria-label="What happened to your decision"\s+className="prl-play__ack"/u);
    assert.match(
      css,
      /\.prl-play__decision > \.prl-callout,\s*\.prl-play__decision > \.prl-play__ack \{\s*grid-column: 1 \/ -1;/u,
    );
  });
});

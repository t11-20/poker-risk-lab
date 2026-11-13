/**
 * The turn ring restarts for every new turn, including one whose remaining time equals the last.
 * The server arms every turn at `now + 240,000`, so consecutive turns often carry the same remaining
 * time (5 of 12 hero-to-hero transitions at 1440x900). There is no DOM to watch a remount (ADR 0008),
 * so the check reads the type and key React reconciles by. Two turns must differ, two frames of one
 * turn must match.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ReactElement } from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadComponent } from './support/render-component.ts';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');

interface Clock {
  readonly deadlineMs: number;
  readonly serverTimeMs: number;
  readonly budgetSeconds: number;
}

/** Two different deadlines, each first sent exactly 240,000ms before it fell due. */
const TURN: Clock = { deadlineMs: 1_794_496_100_000, serverTimeMs: 1_794_495_860_000, budgetSeconds: 240 };
const RIVER: Clock = { deadlineMs: 1_794_496_147_000, serverTimeMs: 1_794_495_907_000, budgetSeconds: 240 };
/** A later frame of the river turn, 47 seconds in. */
const RIVER_LATER: Clock = { ...RIVER, serverTimeMs: RIVER.serverTimeMs + 47_000 };

function identity(element: unknown): string {
  const node = element as ReactElement & { type: unknown; key: string | null };
  const type = typeof node.type === 'function' ? node.type.name : String(node.type);
  return `${type}#${String(node.key)}`;
}

describe('a new turn restarts the clock even when its remaining time equals the last', () => {
  it('the two turns really do carry the same remaining time, which is the case that broke', () => {
    assert.equal(TURN.deadlineMs - TURN.serverTimeMs, RIVER.deadlineMs - RIVER.serverTimeMs);
    assert.notEqual(TURN.deadlineMs, RIVER.deadlineMs);
  });

  it('gives each turn its own identity, and keeps one identity through a turn', async () => {
    type Props = { readonly clock: Clock; readonly label?: string };
    const TurnTimer = await loadComponent<Props>('components/TurnTimer', 'TurnTimer');
    let turn: string;
    let river: string;
    let riverLater: string;
    try {
      turn = identity(TurnTimer({ clock: TURN }));
      river = identity(TurnTimer({ clock: RIVER }));
      riverLater = identity(TurnTimer({ clock: RIVER_LATER }));
    } catch (error) {
      // A component that calls hooks at its top level throws outside a render, and is not keyed per turn.
      return assert.fail(`TurnTimer is not keyed on the turn: ${String(error)}`);
    }
    assert.notEqual(turn, river, `the river kept the turn's countdown: both are ${turn}`);
    assert.equal(river, riverLater, 'a later frame of the same turn would throw its countdown away');
    assert.match(river, new RegExp(`#${String(RIVER.deadlineMs)}$`, 'u'));
  });

  it('still renders the server figure and the budget in the accessible name', async () => {
    type Props = { readonly clock: Clock; readonly label?: string };
    const TurnTimer = await loadComponent<Props>('components/TurnTimer', 'TurnTimer');
    const markup = renderToStaticMarkup(
      createElement(TurnTimer, { clock: RIVER_LATER, label: 'Your turn timer' }),
    );
    assert.match(markup, /aria-label="Your turn timer: 240 seconds to act"/u);
    assert.match(markup, /--prl-turn-offset:-47000ms/u);
  });
});

describe('the source keys the countdown on the deadline', () => {
  const keyed = (source: string): boolean =>
    /<TurnCountdown \{\.\.\.props\} key=\{String\(props\.clock\.deadlineMs\)\} \/>/u.test(source);

  it('TurnTimer hands the countdown a key made of the server deadline', () => {
    const source = readFileSync(join(SRC, 'components', 'TurnTimer.tsx'), 'utf8');
    assert.ok(keyed(source), 'TurnTimer no longer keys its countdown on clock.deadlineMs');
  });

  it('NEGATIVE CONTROL: the predicate fails the old component, which keyed nothing', () => {
    const old = `export function TurnTimer(props: TurnTimerProps): ReactElement {
  const { clock, label = 'Turn timer', className } = props;
  }, [remainingAtFrameMs]);`;
    assert.equal(keyed(old), false);
  });
});

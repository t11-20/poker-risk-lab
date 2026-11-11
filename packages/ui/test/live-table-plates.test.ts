/**
 * The live table's components, rendered, against the usability defects an audit of the running build
 * found at the table — the core of the product, where every gate was green.
 *
 * ## What each block holds the line on
 *
 *   - **The turn ring's budget.** `TurnTimer` clamps what is left to the budget it is handed, so a
 *     240-second turn handed a 60-second budget drew 60s, reached 0s a minute in, and sat at 0s for
 *     three minutes. The fix is upstream (`turnClockFor` in `apps/web`), and this is the other half:
 *     handed the real budget, the ring says the real thing, digits and accessible name alike.
 *   - **What each seat did.** The server's "X raises to 124" only ever reached a 1x1 live region;
 *     the plates said "in the hand" through a whole street of raises.
 *   - **One preset at a time.** On a short stack two presets clamp to the same amount and both were
 *     ticked.
 *   - **A typed amount the clamp replaced** is said, rather than left in the field beside a button
 *     showing a different number.
 *   - **A showdown that never happened** is not the phase an uncontested hand ended on.
 *   - **Focus rescues do not scroll the page.** Measured at 1440x900: a Call at scrollY 1286 ended
 *     at the footer, 1851, with the next decision's buttons at viewport y -261.
 *
 * Each has a NEGATIVE CONTROL beside it that runs the same detector over what the old code produced.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { clampedFrom, pressedPreset, SIZING_PRESETS } from '../src/bet-sizing.ts';
import { lastActionsThisStreet } from '../src/seat-actions.ts';
import type { LegalAction, PlayerView, TableAction } from '../src/view-types.ts';
import { loadComponent } from './support/render-component.ts';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');

// ---------------------------------------------------------------------------
// The turn ring
// ---------------------------------------------------------------------------

interface TurnTimerProps {
  readonly clock: {
    readonly deadlineMs: number;
    readonly serverTimeMs: number;
    readonly budgetSeconds: number;
  };
  readonly label?: string;
}

/** The first `state` frame of the reader's turn, as captured from the running stack. */
const SERVER_TIME = 1_794_404_142_904;
const DEADLINE = 1_794_404_382_903;

async function ring(budgetSeconds: number): Promise<string> {
  const TurnTimer = await loadComponent<TurnTimerProps>('components/TurnTimer', 'TurnTimer');
  return renderToStaticMarkup(
    createElement(TurnTimer, {
      clock: { deadlineMs: DEADLINE, serverTimeMs: SERVER_TIME, budgetSeconds },
      label: 'Your turn timer',
    }),
  );
}

const digits = (markup: string): string =>
  /class="prl-turn-timer__value"[^>]*>([^<]*)</u.exec(markup)?.[1] ?? '<no digits>';
const name = (markup: string): string => /aria-label="([^"]*)"/u.exec(markup)?.[1] ?? '<no name>';

describe('the turn ring, handed the deadline the server set', () => {
  it('counts from 240 and says 240 seconds when the server gave the turn 240', async () => {
    const markup = await ring(240);
    assert.equal(digits(markup), '240');
    assert.equal(name(markup), 'Your turn timer: 240 seconds to act');
    assert.match(markup, /--prl-turn-duration:240000ms/u);
  });

  it('NEGATIVE CONTROL: handed the room clock (60), as the hook used to, it shows 60 for a 240s turn', async () => {
    const markup = await ring(60);
    assert.equal(digits(markup), '60', 'the clamp the defect came from has changed; update this control');
    assert.notEqual(name(markup), 'Your turn timer: 240 seconds to act');
  });
});

// ---------------------------------------------------------------------------
// What each seat did on this street
// ---------------------------------------------------------------------------

type Logged = PlayerView['actions'][number];

function logged(street: Logged['street'], seat: number, action: Logged['action'], extra = {}): Logged {
  return {
    sequence: 0,
    street,
    seat,
    playerId: `p${seat}`,
    action,
    amountPaid: 0,
    betLevelAfter: 10,
    potAfter: 0,
    wasAutomatic: false,
    actionId: null,
    ...extra,
  } as Logged;
}

/** The turn frame the auditor's log carried: the preflop and the flop are both still in `actions`. */
const TURN_LOG: readonly Logged[] = [
  logged('preflop', 0, { type: 'call' }, { betLevelAfter: 10 }),
  logged('preflop', 1, { type: 'fold' }),
  logged('preflop', 2, { type: 'call' }, { betLevelAfter: 10 }),
  logged('flop', 5, { type: 'check' }),
  logged('flop', 2, { type: 'bet', to: 27 }, { betLevelAfter: 27 }),
  logged('flop', 5, { type: 'fold' }),
  logged('flop', 0, { type: 'call' }, { betLevelAfter: 27 }),
  logged('turn', 2, { type: 'raise', to: 1240 }, { betLevelAfter: 1240 }),
  logged('turn', 0, { type: 'check' }, { wasAutomatic: true }),
];

describe('each seat says what it did on the street being played', () => {
  it('names the action, with the amount, for the current street only', () => {
    const flop = lastActionsThisStreet({ street: 'flop', actions: TURN_LOG });
    assert.deepEqual(flop, { 5: 'folded', 2: 'bet 27', 0: 'called 27' });
    const turn = lastActionsThisStreet({ street: 'turn', actions: TURN_LOG });
    assert.deepEqual(turn, { 2: 'raised to 1,240', 0: 'checked, timed out' });
  });

  it('says nothing once the betting is over', () => {
    assert.deepEqual(lastActionsThisStreet({ street: 'complete', actions: TURN_LOG }), {});
    assert.deepEqual(lastActionsThisStreet({ street: 'showdown', actions: TURN_LOG }), {});
  });

  it('NEGATIVE CONTROL: without the street filter, the turn would still show the flop call', () => {
    const unfiltered = lastActionsThisStreet({
      street: 'turn',
      actions: TURN_LOG.map((a) => ({ ...a, street: 'turn' })),
    });
    assert.equal(
      unfiltered[5],
      'folded',
      'seat 6 folded on the flop and would still be labelled on the turn',
    );
    assert.equal(lastActionsThisStreet({ street: 'turn', actions: TURN_LOG })[5], undefined);
  });
});

function seatView(seat: number, status: 'active' | 'folded', isSelf = false): PlayerView['seats'][number] {
  return {
    seat,
    playerId: `p${seat}`,
    stack: 900,
    committedThisStreet: 0,
    committedTotal: 0,
    status,
    position: null,
    holeCards: isSelf ? [0, 1] : null,
    isSelf,
    isButton: false,
    isToAct: false,
  } as PlayerView['seats'][number];
}

function view(street: PlayerView['street'], extra: Partial<PlayerView> = {}): PlayerView {
  return {
    handId: 'hand-1',
    roomId: 'room-1',
    handNumber: 4,
    config: { smallBlind: 5, bigBlind: 10, ante: 0, maxSeats: 6, actionTimeoutSeconds: 60 },
    street,
    board: street === 'preflop' ? [] : [10, 20, 30, 40],
    buttonSeat: 1,
    seats: [seatView(0, 'active', true), seatView(1, 'folded'), seatView(2, 'active'), seatView(5, 'folded')],
    toAct: null,
    betLevel: 0,
    minimumRaiseTo: 0,
    potTotal: 100,
    pots: [{ amount: 100, eligibleSeats: [0, 2], capPerSeat: null, index: 0 }],
    forcedBets: [],
    actions: TURN_LOG,
    actionSequence: TURN_LOG.length,
    legalActions: [],
    amountToCall: 0,
    result: null,
    viewerSeat: 0,
    ...extra,
  } as unknown as PlayerView;
}

interface PokerTableProps {
  readonly view: PlayerView;
  readonly showLastActions?: boolean;
}

async function table(props: PokerTableProps): Promise<string> {
  const PokerTable = await loadComponent<PokerTableProps>('components/PokerTable', 'PokerTable');
  return renderToStaticMarkup(createElement(PokerTable, props));
}

const statusLines = (markup: string): string[] =>
  [...markup.matchAll(/<p class="prl-seat__status">([^<]*)<\/p>/gu)].map((match) => match[1] ?? '');

describe('the plates, rendered', () => {
  it('show the last action on this street in place of "in the hand"', async () => {
    const lines = statusLines(await table({ view: view('turn'), showLastActions: true }));
    assert.ok(lines.length === 4, `expected four plates, read ${lines.length}`);
    assert.ok(lines.includes('raised to 1,240'), `no raise on any plate: ${lines.join(' | ')}`);
    assert.ok(
      lines.includes('checked, timed out'),
      `the timeout is not on the hero plate: ${lines.join(' | ')}`,
    );
    // Seat 6 folded on the flop: its status says so, and nothing from the flop leaks onto the turn.
    assert.equal(lines.filter((line) => line === 'folded').length, 2);
  });

  it('NEGATIVE CONTROL: without it, as before, every live plate says only "in the hand"', async () => {
    const lines = statusLines(await table({ view: view('turn') }));
    assert.deepEqual([...lines].sort(), ['folded', 'folded', 'in the hand', 'in the hand']);
  });
});

// ---------------------------------------------------------------------------
// The phase spine on a hand nobody showed down
// ---------------------------------------------------------------------------

const currentStep = (markup: string): string =>
  /<li class="prl-table__step"[^>]*aria-current="step"[^>]*>.*?<span class="prl-table__step-name">([^<]*)<\/span>/u.exec(
    markup,
  )?.[1] ?? '<none>';

describe('the phase a finished hand ended on', () => {
  const uncontested = { showdowns: [], awards: [] } as unknown as PlayerView['result'];
  const contested = { showdowns: [{ seat: 0, bestFive: [] }], awards: [] } as unknown as PlayerView['result'];

  it('is the street the betting stopped on when the pot was won uncontested', async () => {
    const preflop = await table({ view: view('complete', { board: [], result: uncontested }) });
    assert.equal(currentStep(preflop), 'preflop');
    assert.match(preflop, /\(where the hand ended\)/u);
    assert.equal(
      currentStep(await table({ view: view('complete', { board: [1, 2, 3], result: uncontested }) })),
      'flop',
    );
  });

  it('is the showdown when there was one', async () => {
    assert.equal(
      currentStep(await table({ view: view('complete', { board: [1, 2, 3, 4, 5], result: contested }) })),
      'showdown',
    );
  });

  it('NEGATIVE CONTROL: a live hand still marks its own street as the current phase', async () => {
    const markup = await table({ view: view('turn') });
    assert.equal(currentStep(markup), 'turn');
    assert.match(markup, /\(current phase\)/u);
  });
});

// ---------------------------------------------------------------------------
// The sizer
// ---------------------------------------------------------------------------

interface ActionBarProps {
  readonly legalActions: readonly LegalAction[];
  readonly onAct: (action: TableAction) => void;
  readonly pot: number;
  readonly toCall: number;
  readonly committedThisStreet: number;
}

describe('one preset is pressed at a time', () => {
  // A raise whose only legal size is all in: every preset clamps to the same 20.
  const onlyAllIn = { bounds: { min: 20, max: 20 }, pot: 15, toCall: 10, committedThisStreet: 0 };

  it('picks the last preset that matches, so "All in" names an all-in', () => {
    assert.equal(pressedPreset(onlyAllIn, 20), 'allIn');
    assert.equal(pressedPreset({ ...onlyAllIn, bounds: { min: 20, max: 1000 } }, 20), 'third');
    assert.equal(pressedPreset({ ...onlyAllIn, bounds: { min: 20, max: 1000 } }, 21), null);
  });

  it('renders exactly one pressed preset when they all resolve to the same amount', async () => {
    const ActionBar = await loadComponent<ActionBarProps>('components/ActionBar', 'ActionBar');
    const markup = renderToStaticMarkup(
      createElement(ActionBar, {
        legalActions: [
          { type: 'fold', note: '' },
          { type: 'call', minTo: 10, costAtMin: 10, allInAtMax: false, note: '' },
          { type: 'raise', minTo: 20, maxTo: 20, costAtMin: 20, allInAtMax: true, note: '' },
        ] as unknown as readonly LegalAction[],
        onAct: () => undefined,
        pot: 15,
        toCall: 10,
        committedThisStreet: 0,
      }),
    );
    const pressed = markup.match(/aria-pressed="true"/gu) ?? [];
    const offered = markup.match(/class="prl-preset"/gu) ?? [];
    assert.equal(offered.length, SIZING_PRESETS.length, 'no presets rendered; the sweep is over nothing');
    assert.equal(pressed.length, 1, `${pressed.length} presets were ticked at once`);
  });
});

describe('a typed amount the clamp replaced is said', () => {
  it('names the number when the field and the button disagree', () => {
    assert.equal(clampedFrom({ text: '2000', badInput: false }, 1050), 2000);
    assert.equal(clampedFrom({ text: '5', badInput: false }, 20), 5);
  });

  it('says nothing when they agree, when nothing is typed, or when the text is not a number', () => {
    assert.equal(clampedFrom(null, 20), null);
    assert.equal(clampedFrom({ text: '', badInput: false }, 20), null);
    assert.equal(clampedFrom({ text: '40', badInput: false }, 40), null);
    assert.equal(clampedFrom({ text: '', badInput: true }, 20), null);
    assert.equal(clampedFrom({ text: '1e3', badInput: false }, 20), null);
  });

  it('is wired into the sizer, first in the field’s description', () => {
    const source = readFileSync(join(SRC, 'components', 'ActionBar.tsx'), 'utf8');
    assert.match(source, /const clamped = clampedFrom\(draft, to\);/u);
    assert.match(source, /`\$\{clampedId\} \$\{boundsId\}`/u);
  });
});

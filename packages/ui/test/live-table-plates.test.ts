/**
 * The live table's components, rendered, against usability defects found at the running table.
 * `TurnTimer` clamps what is left to the budget it is handed, so the budget comes from `turnClockFor`
 * in `apps/web`. Each block has a negative control that runs its detector over the old output.
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

/** The ring as painted, `remainingMs` before its deadline, and whether an "s" is painted after the digits. */
async function ringAt(
  remainingMs: number,
): Promise<{ readonly digits: string; readonly unit: boolean; readonly tight: boolean }> {
  const TurnTimer = await loadComponent<TurnTimerProps>('components/TurnTimer', 'TurnTimer');
  const markup = renderToStaticMarkup(
    createElement(TurnTimer, {
      clock: { deadlineMs: SERVER_TIME + remainingMs, serverTimeMs: SERVER_TIME, budgetSeconds: 240 },
      label: 'Your turn timer',
    }),
  );
  return {
    digits: digits(markup),
    unit: /class="prl-turn-timer__unit"/u.test(markup),
    tight: /class="prl-turn-timer__value"[^>]*data-digits="3"/u.test(markup),
  };
}

/** At 1440x900 "196s" painted 31.7px of glyphs in the 24px hole of a 32px ring, so 3 digits drop the unit. */
describe('the countdown fits inside the ring', () => {
  it('paints a bare figure at three digits and keeps the "s" at two', async () => {
    // `tight` hooks the -0.05em in `components.css`. Three bare digits measured 25.4px in the 24px hole.
    assert.deepEqual(await ringAt(196_000), { digits: '196', unit: false, tight: true });
    assert.deepEqual(await ringAt(100_000), { digits: '100', unit: false, tight: true });
    assert.deepEqual(await ringAt(99_000), { digits: '99', unit: true, tight: false });
    assert.deepEqual(await ringAt(7_500), { digits: '8', unit: true, tight: false });
  });

  it('says seconds in the accessible name whatever is painted', async () => {
    const TurnTimer = await loadComponent<TurnTimerProps>('components/TurnTimer', 'TurnTimer');
    const markup = renderToStaticMarkup(
      createElement(TurnTimer, {
        clock: { deadlineMs: SERVER_TIME + 196_000, serverTimeMs: SERVER_TIME, budgetSeconds: 240 },
        label: 'Your turn timer',
      }),
    );
    assert.equal(name(markup), 'Your turn timer: 240 seconds to act');
  });
});

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
    // The flop frame's seat 1 has the 27 it called in front of it; the call is read off that.
    const flopSeats = [{ ...seatView(0, 'active', true), committedThisStreet: 27 }];
    const flop = lastActionsThisStreet({ street: 'flop', actions: TURN_LOG, seats: flopSeats });
    assert.deepEqual(flop, { 5: 'folded', 2: 'bet 27', 0: 'called 27' });
    const turn = lastActionsThisStreet({ street: 'turn', actions: TURN_LOG, seats: [] });
    assert.deepEqual(turn, { 2: 'raised to 1,240', 0: 'checked by the server' });
  });

  it('says nothing once the betting is over', () => {
    assert.deepEqual(lastActionsThisStreet({ street: 'complete', actions: TURN_LOG, seats: [] }), {});
    assert.deepEqual(lastActionsThisStreet({ street: 'showdown', actions: TURN_LOG, seats: [] }), {});
  });

  it('NEGATIVE CONTROL: without the street filter, the turn would still show the flop call', () => {
    const unfiltered = lastActionsThisStreet({
      street: 'turn',
      actions: TURN_LOG.map((a) => ({ ...a, street: 'turn' })),
      seats: [],
    });
    assert.equal(
      unfiltered[5],
      'folded',
      'seat 6 folded on the flop and would still be labelled on the turn',
    );
    assert.equal(lastActionsThisStreet({ street: 'turn', actions: TURN_LOG, seats: [] })[5], undefined);
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
      lines.includes('checked by the server'),
      `the automatic check is not on the hero plate: ${lines.join(' | ')}`,
    );
    assert.equal(lines.filter((line) => line === 'folded').length, 2);
  });

  it('NEGATIVE CONTROL: without it, as before, every live plate says only "in the hand"', async () => {
    const lines = statusLines(await table({ view: view('turn') }));
    assert.deepEqual([...lines].sort(), ['folded', 'folded', 'in the hand', 'in the hand']);
  });
});

describe('a finished hand’s pot', () => {
  // The reader's 1,000 into a 950 all-in: the engine layers the last 50 as a pot only the reader can
  // win, and pays it back.
  const pots = [
    { amount: 1_900, eligibleSeats: [0, 2], capPerSeat: 950, index: 0 },
    { amount: 50, eligibleSeats: [0], capPerSeat: 1_000, index: 1 },
  ];
  const paid = {
    showdowns: [{ seat: 0, bestFive: [] }],
    awards: [],
    pots,
  } as unknown as PlayerView['result'];
  const potFigure = (markup: string): string =>
    /<div class="prl-pot">.*?aria-live="polite"[^>]*>([^<]*)</u.exec(markup)?.[1] ?? '<none>';

  it('leaves out the chips that went back unmatched, as a total and as a side pot', async () => {
    const markup = await table({ view: view('complete', { potTotal: 1_950, pots, result: paid }) });
    assert.equal(potFigure(markup), 'Pot: 1,900 units');
    assert.doesNotMatch(markup, /side pot 1/u);
  });

  it('while the hand is live, shows the same layers as they stand', async () => {
    const markup = await table({ view: view('river', { potTotal: 1_950, pots }) });
    assert.equal(potFigure(markup), 'Pot: 1,950 units');
    assert.match(markup, /side pot 1/u);
  });
});

const currentStep = (markup: string): string =>
  /<li class="prl-table__step"[^>]*aria-current="step"[^>]*>.*?<span class="prl-table__step-name">([^<]*)<\/span>/u.exec(
    markup,
  )?.[1] ?? '<none>';

describe('the phase a finished hand ended on', () => {
  const uncontested = { showdowns: [], awards: [], pots: [] } as unknown as PlayerView['result'];
  const contested = {
    showdowns: [{ seat: 0, bestFive: [] }],
    awards: [],
    pots: [],
  } as unknown as PlayerView['result'];

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

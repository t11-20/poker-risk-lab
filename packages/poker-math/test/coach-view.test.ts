/**
 * `coachSpotForView` gives the reports the API gave before it existed, to the byte.
 * `fixtures/coach-views.json` holds five views dealt from fixed seeds (six-handed preflop, flop
 * heads-up, a preflop side pot with the reader short, the river, and a turn under a notation range),
 * stored as data so the pin does not move with the engine's dealing. The `report` halves were
 * re-pinned when the Coach began pricing `offeredSizes`. `apps/api/test/coach-task-pin.test.ts`
 * holds the tasks. Changing the assumed range to `top:39` fails the four default-range views.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { CoachReport } from '@prl/contracts';
import type { PlayerView } from '@prl/poker-engine';
import { buildCoachReport } from '../src/coach.ts';
import {
  type CoachPolicy,
  type CoachSpot,
  coachInputFor,
  coachSpotForView,
  LIVE_COACH_POLICY,
} from '../src/coach-view.ts';

interface PinnedView {
  readonly name: string;
  readonly view: PlayerView;
  readonly options: { readonly samples: number; readonly opponentRange?: string };
  readonly report: CoachReport;
}

const PINNED = JSON.parse(
  readFileSync(new URL('./fixtures/coach-views.json', import.meta.url), 'utf8'),
) as readonly PinnedView[];

function policyFor(pinned: PinnedView): CoachPolicy {
  const named = pinned.options.opponentRange;
  return {
    ...LIVE_COACH_POLICY,
    samples: pinned.options.samples,
    range: named === undefined ? LIVE_COACH_POLICY.range : { kind: 'notation', notation: named },
  };
}

test('the pin covers the spots it claims to', () => {
  assert.equal(PINNED.length, 5, 'a sweep of nothing is not a pass');
  const streets = new Set(PINNED.map((pinned) => pinned.view.street));
  assert.deepEqual([...streets].sort(), ['flop', 'preflop', 'river', 'turn']);
  assert.ok(
    PINNED.some((pinned) => pinned.view.seats.filter((seat) => seat.status !== 'folded').length >= 5),
    'one view is multiway',
  );
  assert.ok(
    PINNED.some((pinned) => pinned.report.potOdds.pot < pinned.view.potTotal),
    'one view leaves a side pot the reader cannot win',
  );
  assert.ok(
    PINNED.some((pinned) => pinned.options.opponentRange !== undefined),
    'one view names a notation range',
  );
});

for (const pinned of PINNED) {
  test(`same report, byte for byte: ${pinned.name}`, () => {
    const reading = coachSpotForView(pinned.view, policyFor(pinned));
    assert.equal(reading.kind, 'spot');
    assert.ok(reading.kind === 'spot');
    const report = buildCoachReport(coachInputFor(reading.spot));
    assert.equal(JSON.stringify(report), JSON.stringify(pinned.report));
  });
}

function pinnedAt(name: string): PinnedView {
  const found = PINNED.find((pinned) => pinned.name.startsWith(name));
  assert.ok(found !== undefined, `no pinned view named ${name}`);
  return found;
}

test('refuses a view with no seat holding cards', () => {
  const { view } = pinnedAt('river');
  const spectator: PlayerView = {
    ...view,
    seats: view.seats.map((seat) => ({ ...seat, isSelf: false, holeCards: null })),
  };
  assert.deepEqual(coachSpotForView(spectator, LIVE_COACH_POLICY), {
    kind: 'refused',
    refusal: { kind: 'not-seated' },
  });
});

test('refuses a view whose seat is not to act, rather than reading an empty legal set as "anything"', () => {
  const { view } = pinnedAt('river');
  const waiting: PlayerView = { ...view, legalActions: [], toAct: 0 };
  assert.deepEqual(coachSpotForView(waiting, LIVE_COACH_POLICY), {
    kind: 'refused',
    refusal: { kind: 'not-to-act', seat: 1, toAct: 0 },
  });
  const closed: PlayerView = { ...view, legalActions: [] };
  assert.deepEqual(coachSpotForView(closed, LIVE_COACH_POLICY), {
    kind: 'refused',
    refusal: { kind: 'betting-closed' },
  });
});

test('refuses a view with no live opponent, and one after the betting', () => {
  const { view } = pinnedAt('river');
  const alone: PlayerView = {
    ...view,
    seats: view.seats.map((seat) => (seat.isSelf ? seat : { ...seat, status: 'folded' })),
  };
  assert.deepEqual(coachSpotForView(alone, LIVE_COACH_POLICY), {
    kind: 'refused',
    refusal: { kind: 'no-opponent' },
  });
  const over: PlayerView = { ...view, street: 'showdown' };
  assert.deepEqual(coachSpotForView(over, LIVE_COACH_POLICY), {
    kind: 'refused',
    refusal: { kind: 'hand-over', street: 'showdown' },
  });
});

// Opponents are labelled with the names the API dealt in, not seat numbers the plates do not show.
test('names each opponent the way the caller names the seat, and says so in the assumptions', () => {
  const { view } = pinnedAt('preflop');
  const names = new Map(view.seats.map((seat) => [seat.seat, `Player at ${String(seat.seat)}`]));
  const reading = coachSpotForView(view, LIVE_COACH_POLICY, (seat) => names.get(seat));
  assert.ok(reading.kind === 'spot');
  const labels = reading.spot.opponents.map((opponent) => opponent.label);
  assert.ok(labels.length >= 2, `a sweep of nothing is not a pass: ${JSON.stringify(labels)}`);
  for (const label of labels) assert.match(label, /^Player at \d$/u);

  const report = buildCoachReport(coachInputFor({ ...reading.spot, samples: 50 }));
  const named = report.equity.perPlayer.slice(1).map((player) => player.label);
  assert.deepEqual(named, labels);
  for (const label of labels) {
    assert.ok(
      report.assumptions.some((line) => line.startsWith(`${label} holds any of`)),
      `no assumption names ${label}`,
    );
  }
});

test('falls back to the seat number for a seat with no usable name, and never to "you"', () => {
  const { view } = pinnedAt('preflop');
  const opponents = view.seats.filter((seat) => !seat.isSelf && seat.status === 'active');
  const [first, second, third] = opponents;
  assert.ok(first !== undefined && second !== undefined && third !== undefined);
  // "You" would read as the reader in `holdsClause`.
  const names = new Map([
    [first.seat, 'You'],
    [second.seat, '   '],
  ]);
  const reading = coachSpotForView(view, LIVE_COACH_POLICY, (seat) => names.get(seat));
  assert.ok(reading.kind === 'spot');
  const bySeat = new Map(opponents.map((seat, index) => [seat.seat, reading.spot.opponents[index]?.label]));
  assert.equal(bySeat.get(first.seat), `seat ${String(first.seat + 1)}`);
  assert.equal(bySeat.get(second.seat), `seat ${String(second.seat + 1)}`);
  assert.equal(bySeat.get(third.seat), `seat ${String(third.seat + 1)}`, 'a seat the caller has no name for');
});

function labelsBySeat(names: ReadonlyMap<number, string>): {
  readonly bySeat: ReadonlyMap<number, string | undefined>;
  readonly spot: CoachSpot;
} {
  const { view } = pinnedAt('preflop');
  const reading = coachSpotForView(view, LIVE_COACH_POLICY, (seat) => names.get(seat));
  assert.ok(reading.kind === 'spot');
  const opponents = view.seats.filter((seat) => !seat.isSelf && seat.status === 'active');
  // Seats 0, 1, 3 and 4 are live, the reader is seat 2 and seat 5 has folded.
  assert.deepEqual(
    opponents.map((seat) => seat.seat),
    [0, 1, 3, 4],
  );
  const bySeat = new Map(opponents.map((seat, index) => [seat.seat, reading.spot.opponents[index]?.label]));
  return { bySeat, spot: reading.spot };
}

// Guest names are not unique, so opponents who share a name are told apart by seat.
test('opponents who share a name are told apart by seat, in the equity rows and the assumptions alike', () => {
  const names = new Map([
    [0, 'Alex'],
    [1, 'Sam'],
    [3, 'Alex'],
    [4, 'Kim'],
  ]);
  const { bySeat, spot } = labelsBySeat(names);
  assert.deepEqual(
    [...bySeat],
    [
      [0, 'Alex (seat 1)'],
      [1, 'Sam'],
      [3, 'Alex (seat 4)'],
      [4, 'Kim'],
    ],
  );

  const report = buildCoachReport(coachInputFor({ ...spot, samples: 50 }));
  const rows = report.equity.perPlayer.slice(1).map((player) => player.label);
  assert.deepEqual(rows, [...bySeat.values()]);
  assert.equal(new Set(rows).size, rows.length, `equity rows repeat a label: ${JSON.stringify(rows)}`);
  for (const label of rows) {
    const lines = report.assumptions.filter((line) => line.startsWith(`${String(label)} holds any of`));
    assert.equal(lines.length, 1, `${String(label)} opens ${String(lines.length)} assumptions`);
  }
});

test('a name is shared ignoring case, and with a seat that has folded', () => {
  // `holdsClause` capitalises, so "alex" and "Alex" collide. The Alex who folded in seat 6 is still
  // on a plate.
  const { bySeat } = labelsBySeat(
    new Map([
      [0, 'alex'],
      [1, 'Sam'],
      [5, 'Alex'],
    ]),
  );
  assert.equal(bySeat.get(0), 'alex (seat 1)');
  assert.equal(bySeat.get(1), 'Sam');
});

test('a name in the shape of a seat label falls back to its own seat, so it cannot take another', () => {
  // A guest named "seat 2" or "Alex (seat 1)" must not collide with a generated label.
  const { bySeat } = labelsBySeat(
    new Map([
      [0, 'Alex'],
      [3, 'seat 2'],
      [4, 'Alex (seat 1)'],
      [5, 'Alex'],
    ]),
  );
  assert.deepEqual(
    [...bySeat],
    [
      [0, 'Alex (seat 1)'],
      [1, 'seat 2'],
      [3, 'seat 4'],
      [4, 'seat 5'],
    ],
  );
});

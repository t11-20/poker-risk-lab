/**
 * `coachSpotForView` gives the reports the API gave before it existed, to the byte.
 *
 * ## The pin
 *
 * `fixtures/coach-views.json` was written at the commit before this module, by dealing five hands
 * through the real engine from fixed seeds and asking the API's own `coachForView` and
 * `coachTaskForView` (then in `apps/api/src/ws/router.ts`) for each seat-to-act's view: preflop
 * six-handed, flop heads-up, a preflop side pot with the reader as the short stack, the river, and
 * a turn under a named notation range. The views are stored as data, so the pin does not move
 * when the engine's dealing does. `apps/api/test/coach-task-pin.test.ts` holds the tasks.
 *
 * The bot's copy, run over the same four default-range views, differed from the API's in every
 * one, and only in the opponent labels (`seat N+1` against `seat N`), which reach the learner
 * through the assumptions list. That disagreement is what this module ends.
 *
 * ## Would it fail if a figure moved? Yes, and that was checked by moving one
 *
 * The assumed range was changed from `top:40` to `top:39` in `LIVE_COACH_POLICY` and this file
 * run: the four default-range views failed and the notation one passed. The labels were changed to
 * the bot's old `seat N+1`: all five failed. Restored, all pass.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { CoachReport } from '@prl/contracts';
import type { PlayerView } from '@prl/poker-engine';
import { buildCoachReport } from '../src/coach.ts';
import { type CoachPolicy, coachInputFor, coachSpotForView, LIVE_COACH_POLICY } from '../src/coach-view.ts';

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

/**
 * The sizes the table offers, which are also the sizes the Coach prices.
 *
 * `apps/web/test/lab-sizes-priced.test.ts` is the sweep that matters — every bundled scenario, the
 * real bar's inputs against a real report. This file pins the arithmetic it rests on, in spots small
 * enough to check by hand.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseCards } from '@prl/poker-engine';
import { buildCoachReport } from '../src/coach.ts';
import { pricedSizesFor } from '../src/consistency.ts';
import { exactRange } from '../src/ranges.ts';
import { nearestPricedSizes, offeredSizes, presetTo, TABLE_SIZING_PRESETS } from '../src/table-sizing.ts';

const twoThirds = TABLE_SIZING_PRESETS.find((preset) => preset.id === 'twoThirds');

describe('offeredSizes', () => {
  it('is the floor and every preset, ascending, each named by the control that reaches it first', () => {
    // Facing 100 into 210 with nothing out: the floor is 200, the pot after the call 310.
    // ⅓ = 100 + 103 = 203, ½ = 100 + 155 = 255, ⅔ = 100 + 207 = 307, pot = 410, all in 1000.
    const sizes = offeredSizes({
      bounds: { min: 200, max: 1000 },
      pot: 210,
      toCall: 100,
      committedThisStreet: 0,
    });
    assert.deepEqual(sizes, [
      { id: 'minimum', to: 200 },
      { id: 'third', to: 203 },
      { id: 'half', to: 255 },
      { id: 'twoThirds', to: 307 },
      { id: 'pot', to: 410 },
      { id: 'allIn', to: 1000 },
    ]);
  });

  it('rounds the fraction to the nearest chip, which is what the bar sends (REGRESSION)', () => {
    // `eq-second-pair-vs-wide-range`: ⅔ of 310 is 206.67. The ladder floored it to 206 and the
    // bar rounded it to 207, and the 207 the button sent was a size nothing had priced.
    assert.ok(twoThirds !== undefined);
    const to = presetTo(twoThirds, {
      bounds: { min: 1, max: 1000 },
      pot: 310,
      toCall: 0,
      committedThisStreet: 0,
    });
    assert.equal(to, 207);
  });

  it('names a preset clamped onto the floor or the stack by the floor or the stack', () => {
    // 60 behind facing nothing in a pot of 300: every fraction clamps to the shove, and a "pot"
    // label on a size that is the whole stack would be a false sentence in the derivation.
    const short = offeredSizes({ bounds: { min: 10, max: 60 }, pot: 300, toCall: 0, committedThisStreet: 0 });
    assert.deepEqual(short, [
      { id: 'minimum', to: 10 },
      { id: 'allIn', to: 60 },
    ]);
    const allIn = offeredSizes({ bounds: { min: 60, max: 60 }, pot: 300, toCall: 0, committedThisStreet: 0 });
    assert.deepEqual(allIn, [{ id: 'minimum', to: 60 }], 'one legal size is one row');
  });
});

describe('the Coach prices what the table offers', () => {
  it('prices the floor and every preset, and nothing else', () => {
    // A heads-up turn facing a bet, with the bar's own context built from the same figures.
    const input = {
      heroCards: parseCards('Ah 6h'),
      board: parseCards('Kh 9h 4s 2c'),
      street: 'turn' as const,
      opponents: [{ label: 'the opponent', range: exactRange(parseCards('Kd 9c')) }],
      pot: 220,
      contestablePot: 220,
      toCall: 80,
      heroCommittedThisStreet: 0,
      heroStack: 300,
      opponentStacks: [300],
      bigBlind: 10,
    };
    const report = buildCoachReport(input);
    const offered = offeredSizes({
      bounds: { min: 160, max: 300 },
      pot: 220,
      toCall: 80,
      committedThisStreet: 0,
    });
    assert.deepEqual(
      pricedSizesFor(report, 'raise'),
      offered.map((size) => size.to),
    );
  });
});

describe('nearestPricedSizes', () => {
  it('names the priced sizes either side, or null where there is none', () => {
    assert.deepEqual(nearestPricedSizes(230, [200, 255, 307, 1000]), { below: 200, above: 255 });
    assert.deepEqual(nearestPricedSizes(150, [200, 255]), { below: null, above: 200 });
    assert.deepEqual(nearestPricedSizes(2000, [200, 255]), { below: 255, above: null });
    assert.deepEqual(
      nearestPricedSizes(255, [200, 255, 307]),
      { below: 200, above: 307 },
      'a priced size is not its own neighbour',
    );
    assert.deepEqual(nearestPricedSizes(10, []), { below: null, above: null });
  });
});

/**
 * Tests for the bet sizer's arithmetic.
 *
 * This file exists because of one promise `ActionBar` makes: **no out-of-range amount can
 * leave it**. The component cannot be tested here (no JSX under `node:test`), so the
 * arithmetic was pulled into `src/bet-sizing.ts` and the promise is pinned down here instead.
 *
 * The important test is the last one: a brute-force sweep over every combination of typed
 * input, preset and bounds asserting that the resolved amount is always an integer inside
 * `[min, max]`. A hand-written table of cases would miss exactly the case that matters —
 * which is always the one nobody thought of.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type BetBounds,
  clampBetTo,
  presetTotal,
  resolveDraft,
  resolveSizedAction,
  SIZING_PRESETS,
} from '../src/bet-sizing.ts';
import type { LegalAction } from '../src/view-types.ts';

const bounds = (min: number, max: number): BetBounds => ({ min, max });

describe('clampBetTo', () => {
  it('leaves a legal amount alone', () => {
    assert.equal(clampBetTo(600, bounds(200, 840)), 600);
    assert.equal(clampBetTo(200, bounds(200, 840)), 200);
    assert.equal(clampBetTo(840, bounds(200, 840)), 840);
  });

  it('pins a value below the minimum up to the minimum', () => {
    assert.equal(clampBetTo(1, bounds(200, 840)), 200);
    assert.equal(clampBetTo(-9999, bounds(200, 840)), 200);
    assert.equal(clampBetTo(199, bounds(200, 840)), 200);
  });

  it('pins a value above the maximum down to the maximum', () => {
    assert.equal(clampBetTo(9999, bounds(200, 840)), 840);
    assert.equal(clampBetTo(841, bounds(200, 840)), 840);
  });

  it('rounds to a whole chip before pinning, never after', () => {
    assert.equal(clampBetTo(600.4, bounds(200, 840)), 600);
    assert.equal(clampBetTo(600.5, bounds(200, 840)), 601);
    // 199.6 rounds to 200, which is legal — rounding first is what makes this reachable.
    assert.equal(clampBetTo(199.6, bounds(200, 840)), 200);
    // 840.4 rounds to 840 rather than being pinned from 841.
    assert.equal(clampBetTo(840.4, bounds(200, 840)), 840);
  });

  it('collapses a non-finite value to the minimum', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      assert.equal(clampBetTo(value, bounds(200, 840)), 200);
    }
  });

  it('collapses an impossible range to the minimum rather than inventing a value', () => {
    assert.equal(clampBetTo(500, bounds(800, 200)), 800);
    assert.equal(clampBetTo(500, bounds(200, Number.NaN)), 200);
    assert.equal(clampBetTo(500, bounds(200, Number.POSITIVE_INFINITY)), 200);
  });

  it('returns zero when even the minimum is unusable', () => {
    assert.equal(clampBetTo(500, bounds(Number.NaN, 800)), 0);
  });

  it('handles a range with no room at all', () => {
    // A seat whose only legal bet is its whole stack.
    assert.equal(clampBetTo(1, bounds(840, 840)), 840);
    assert.equal(clampBetTo(9999, bounds(840, 840)), 840);
  });
});

describe('resolveDraft', () => {
  it('resolves nothing typed to the minimum', () => {
    assert.equal(resolveDraft(null, bounds(200, 840)), 200);
  });

  it('resolves unparseable text to the minimum, so there is no NaN state', () => {
    for (const draft of ['', '   ', 'abc', '-', '.', '+', 'e5']) {
      assert.equal(resolveDraft(draft, bounds(200, 840)), 200, `draft "${draft}"`);
    }
  });

  it('parses and clamps a typed amount', () => {
    assert.equal(resolveDraft('600', bounds(200, 840)), 600);
    assert.equal(resolveDraft('9999', bounds(200, 840)), 840);
    assert.equal(resolveDraft('1', bounds(200, 840)), 200);
  });

  it('takes the leading integer from partly numeric text, as an input element would', () => {
    assert.equal(resolveDraft('600abc', bounds(200, 840)), 600);
    assert.equal(resolveDraft('600.9', bounds(200, 840)), 600);
  });
});

describe('SIZING_PRESETS', () => {
  it('offers ascending fractions plus an all-in', () => {
    assert.deepEqual(
      SIZING_PRESETS.map((preset) => preset.id),
      ['third', 'half', 'twoThirds', 'pot', 'allIn'],
    );
    assert.equal(SIZING_PRESETS.at(-1)?.fraction, null);
  });

  it('has unique ids, which is what the React keys rely on', () => {
    const ids = SIZING_PRESETS.map((preset) => preset.id);
    assert.equal(new Set(ids).size, ids.length);
  });
});

describe('presetTotal', () => {
  const openContext = { bounds: bounds(10, 1000), pot: 300, toCall: 0, committedThisStreet: 0 };

  it('is a plain fraction of the pot when nothing is owed', () => {
    const byId = new Map(SIZING_PRESETS.map((preset) => [preset.id, presetTotal(preset, openContext)]));
    assert.equal(byId.get('half'), 150);
    assert.equal(byId.get('pot'), 300);
    assert.equal(byId.get('third'), 100);
    assert.equal(byId.get('twoThirds'), 200);
  });

  it('is call-then-bet-a-fraction when facing a bet', () => {
    // Pot 420 already includes the opponent's 300. Calling 260 makes it 680; a pot-sized
    // raise is then 40 (already in) + 260 (the call) + 680 = 980.
    const context = { bounds: bounds(600, 2000), pot: 420, toCall: 260, committedThisStreet: 40 };
    const pot = SIZING_PRESETS.find((preset) => preset.id === 'pot');
    assert.ok(pot !== undefined);
    assert.equal(presetTotal(pot, context), 980);
    const half = SIZING_PRESETS.find((preset) => preset.id === 'half');
    assert.ok(half !== undefined);
    assert.equal(presetTotal(half, context), 640);
  });

  it('sends the all-in preset to the maximum', () => {
    const allIn = SIZING_PRESETS.find((preset) => preset.id === 'allIn');
    assert.ok(allIn !== undefined);
    assert.equal(presetTotal(allIn, { ...openContext, bounds: bounds(10, 777) }), 777);
  });

  it('clamps a preset that lands outside the legal range', () => {
    // A tiny stack: every preset has to collapse into [600, 620].
    const context = { bounds: bounds(600, 620), pot: 5000, toCall: 100, committedThisStreet: 0 };
    for (const preset of SIZING_PRESETS) {
      const total = presetTotal(preset, context);
      assert.ok(total >= 600 && total <= 620, `${preset.id} produced ${total}`);
    }
  });

  it('never produces a fractional chip', () => {
    const context = { bounds: bounds(1, 100000), pot: 331, toCall: 77, committedThisStreet: 13 };
    for (const preset of SIZING_PRESETS) {
      assert.ok(Number.isInteger(presetTotal(preset, context)), `${preset.id} was fractional`);
    }
  });
});

describe('resolveSizedAction', () => {
  it('finds a raise with both bounds', () => {
    const actions: readonly LegalAction[] = [
      { type: 'fold' },
      { type: 'call', minTo: 300, costAtMin: 260 },
      { type: 'raise', minTo: 600, maxTo: 840, note: 'Increase the bet.' },
    ];
    assert.deepEqual(resolveSizedAction(actions), {
      kind: 'raise',
      bounds: { min: 600, max: 840 },
      note: 'Increase the bet.',
    });
  });

  it('finds a bet the same way', () => {
    const found = resolveSizedAction([{ type: 'bet', minTo: 10, maxTo: 500 }]);
    assert.equal(found?.kind, 'bet');
    assert.equal(found?.note, null);
  });

  it('drops an aggressive action that is missing a bound, rather than guessing one', () => {
    assert.equal(resolveSizedAction([{ type: 'raise', minTo: 600 }]), null);
    assert.equal(resolveSizedAction([{ type: 'raise', maxTo: 840 }]), null);
    assert.equal(resolveSizedAction([{ type: 'raise' }]), null);
  });

  it('drops an aggressive action with a non-finite bound', () => {
    assert.equal(resolveSizedAction([{ type: 'bet', minTo: 10, maxTo: Number.POSITIVE_INFINITY }]), null);
    assert.equal(resolveSizedAction([{ type: 'bet', minTo: Number.NaN, maxTo: 500 }]), null);
  });

  it('returns null when there is nothing aggressive on offer', () => {
    assert.equal(resolveSizedAction([{ type: 'fold' }, { type: 'check', costAtMin: 0 }]), null);
    assert.equal(resolveSizedAction([]), null);
  });
});

describe('the invariant: nothing out of range can escape', () => {
  it('holds for every combination of draft, preset and bounds', () => {
    const drafts: readonly (string | null)[] = [
      null,
      '',
      'abc',
      '-1',
      '0',
      '1',
      '199',
      '200',
      '201',
      '599',
      '600',
      '601',
      '839',
      '840',
      '841',
      '99999',
      '1e9',
      '600.7',
      '  620  ',
    ];
    const ranges: readonly BetBounds[] = [
      bounds(0, 0),
      bounds(1, 1),
      bounds(10, 10),
      bounds(200, 840),
      bounds(600, 600),
      bounds(600, 601),
      bounds(1, 1_000_000),
    ];
    const contexts = [
      { pot: 0, toCall: 0, committedThisStreet: 0 },
      { pot: 300, toCall: 0, committedThisStreet: 0 },
      { pot: 420, toCall: 260, committedThisStreet: 40 },
      { pot: 1_000_000, toCall: 999, committedThisStreet: 7 },
    ];

    let checked = 0;
    for (const range of ranges) {
      for (const draft of drafts) {
        const resolved = resolveDraft(draft, range);
        assert.ok(
          Number.isInteger(resolved),
          `draft ${draft} in ${JSON.stringify(range)} was not an integer`,
        );
        assert.ok(
          resolved >= range.min && resolved <= range.max,
          `draft ${draft} escaped ${JSON.stringify(range)} as ${resolved}`,
        );
        checked += 1;
      }
      for (const context of contexts) {
        for (const preset of SIZING_PRESETS) {
          const total = presetTotal(preset, { ...context, bounds: range });
          assert.ok(Number.isInteger(total), `${preset.id} was fractional`);
          assert.ok(
            total >= range.min && total <= range.max,
            `${preset.id} escaped ${JSON.stringify(range)} as ${total}`,
          );
          checked += 1;
        }
      }
    }
    assert.ok(checked > 200, `expected a broad sweep, only checked ${checked}`);
  });
});

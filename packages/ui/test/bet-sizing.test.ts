/**
 * The bet sizer's arithmetic, which holds `ActionBar`'s promise that no out-of-range amount leaves it.
 * The last test sweeps every combination of draft, preset and bounds, because a hand-written table
 * misses the case nobody thought of.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { clampToBounds, presetTo, TABLE_SIZING_PRESETS } from '@prl/poker-math';
import {
  type BetBounds,
  clampBetTo,
  draftForBounds,
  isDraftMalformed,
  presetTotal,
  resolveDraft,
  resolveSizedAction,
  SIZING_PRESETS,
  sameBounds,
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
    assert.equal(clampBetTo(199.6, bounds(200, 840)), 200);
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

  it('accepts a decimal and rounds it to a whole chip, which the readout then prints', () => {
    // Not silent, because the readout and commit button both show the rounded total.
    assert.equal(resolveDraft('600.9', bounds(200, 840)), 601);
    assert.equal(resolveDraft('600.4', bounds(200, 840)), 600);
    assert.equal(isDraftMalformed({ text: '600.9', badInput: false }), false);
  });

  /**
   * `parseInt('1e3', 10)` is 1, while a number input keeps `1e3` with `badInput === false`.
   * In Chrome 151 typing `1e3` showed no correction and the button read "Raise to 70".
   */
  it('refuses shorthand rather than silently reading it as a different number', () => {
    for (const draft of ['1e3', '2e2', '600abc', '0x20', '1_000', 'Infinity', '1,000']) {
      assert.equal(resolveDraft(draft, bounds(200, 840)), 200, `draft "${draft}"`);
      assert.equal(
        isDraftMalformed({ text: draft, badInput: false }),
        true,
        `"${draft}" resolves to the minimum and is not marked invalid, which is the silent clamp`,
      );
    }
  });
});

/**
 * For every string a number input can hand this control, either the field is marked invalid or the
 * resolved amount is `Number(text)` clamped. This is the old `parseInt` parser, for the control.
 */
function silentlyReinterpreted(text: string, range: BetBounds): boolean {
  const meant = Number(text.trim());
  if (!Number.isFinite(meant) || text.trim() === '') return false;
  return clampBetTo(meant, range) !== clampBetTo(Number.parseInt(text, 10), range);
}

describe('no typed amount is silently re-read as a different one', () => {
  const range = bounds(200, 840);
  const TYPED = ['1e3', '2e2', '600', '9999', '1', '600.9', '600abc', '0x20', ' 300 ', '', '1e-3'];

  it('marks every string it cannot read as the reader wrote it', () => {
    for (const text of TYPED) {
      const meant = Number(text.trim());
      const agrees =
        text.trim() === '' ||
        (Number.isFinite(meant) && clampBetTo(meant, range) === resolveDraft(text, range));
      assert.ok(
        agrees || isDraftMalformed({ text, badInput: false }),
        `"${text}" resolves to ${resolveDraft(text, range)} without being marked invalid`,
      );
    }
  });

  it('NEGATIVE CONTROL: the parser this replaced fails that property', () => {
    const offenders = TYPED.filter((text) => silentlyReinterpreted(text, range));
    assert.ok(
      offenders.length > 0,
      'the old `parseInt` parser produced no disagreement on any of these, so the check above proves nothing',
    );
    // Named, so an edit to `TYPED` cannot quietly drop it.
    assert.ok(offenders.includes('1e3'), `expected 1e3 among the offenders, found ${String(offenders)}`);
    assert.equal(clampBetTo(Number.parseInt('1e3', 10), range), 200, 'parseInt("1e3") is 1');
    assert.equal(clampBetTo(Number('1e3'), range), 840, 'the characters mean 1000');
  });
});

/**
 * The invalid state of the bet field. Measured in Chrome 151 on a number input:
 *     after typing "one third"   value: ""      badInput: true
 *     after clearing it          value: ""      badInput: false
 * The same value must give different answers, so the predicate cannot read the text alone.
 */
describe('isDraftMalformed', () => {
  it('is not malformed before anything has been typed', () => {
    assert.equal(isDraftMalformed(null), false);
  });

  it('is not malformed when the field has simply been cleared', () => {
    // A blank field is a normal step on the way to a new number.
    assert.equal(isDraftMalformed({ text: '', badInput: false }), false);
    assert.equal(isDraftMalformed({ text: '   ', badInput: false }), false);
  });

  it('is not malformed for any amount the sizer can use, in range or out of it', () => {
    // Out of range is not invalid, because `resolveDraft` clamps it and the readout says so.
    for (const text of ['0', '1', '600', '9999', '-40', '600.9', ' 300 ']) {
      assert.equal(isDraftMalformed({ text, badInput: false }), false, `text "${text}"`);
      assert.ok(Number.isFinite(resolveDraft(text, bounds(200, 840))), `resolvable "${text}"`);
    }
  });

  it('is malformed when the browser reports text it could not parse', () => {
    assert.equal(isDraftMalformed({ text: '', badInput: true }), true);
  });

  it('cannot be satisfied by looking at the value, which is the whole point', () => {
    // The negative control. A predicate derived from `text` gives both the same answer.
    const typedLetters = { text: '', badInput: true } as const;
    const clearedField = { text: '', badInput: false } as const;
    assert.equal(typedLetters.text, clearedField.text);
    assert.notEqual(isDraftMalformed(typedLetters), isDraftMalformed(clearedField));
  });

  it('also catches non-numeric text from a browser that keeps it in the value', () => {
    // No current browser keeps unparseable text in a number input's value, so this would go unnoticed.
    for (const text of ['abc', 'e5', '-', '.', '+', 'one third', '1e3', '600abc']) {
      assert.equal(isDraftMalformed({ text, badInput: false }), true, `text "${text}"`);
    }
  });
});

describe('the sizer reads the sizes the Coach prices', () => {
  // The Lab grades a sized action only on an exact match with `offeredSizes`, so the sizer must use
  // `@prl/poker-math` itself. A copy sent 207 from a ⅔-pot button against a priced 206.
  it('re-exports the presets, the clamp and the preset arithmetic by identity', () => {
    assert.equal(SIZING_PRESETS, TABLE_SIZING_PRESETS);
    assert.equal(presetTotal, presetTo);
    assert.equal(clampBetTo, clampToBounds);
  });

  it('renders its presets from that list and defaults to the floor', () => {
    // `offeredSizes` is the floor plus every preset, and these are where the bar could drift from it.
    const bar = readFileSync(new URL('../src/components/ActionBar.tsx', import.meta.url), 'utf8');
    assert.match(bar, /SIZING_PRESETS\.map\(\(preset\) =>/u);
    assert.match(bar, /presetTotal\(preset, context\)/u);
    assert.match(bar, /const context(?:: SizingContext)? = \{ bounds, pot, toCall, committedThisStreet \}/u);
    assert.equal(resolveDraft(null, bounds(50, 500)), 50, 'an untouched sizer sends the floor');
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
    // Calling 260 makes the pot 680, so a pot-sized raise is 40 (in) + 260 (the call) + 680 = 980.
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

/**
 * The draft belongs to the spot it was typed in. The bounds move every street and the text does not,
 * so the field read `1000` on the flop while the slider and button read 980.
 */
describe('draftForBounds: a draft is read only in the spot it was typed in', () => {
  const typed = { text: '1000', badInput: false, bounds: bounds(20, 1_000) } as const;

  it('keeps the draft while the bounds have not moved', () => {
    assert.deepEqual(draftForBounds(typed, bounds(20, 1_000)), typed);
  });

  it('drops it when either bound moves', () => {
    assert.equal(draftForBounds(typed, bounds(10, 980)), null, 'the maximum moved');
    assert.equal(draftForBounds(typed, bounds(40, 1_000)), null, 'the minimum moved');
    assert.equal(draftForBounds(typed, bounds(10, 980)), null);
  });

  it('has nothing to drop before anything is typed', () => {
    assert.equal(draftForBounds(null, bounds(20, 1_000)), null);
  });

  it('makes the field agree with everything else in the sizer once the bounds move', () => {
    // With no draft the field shows `String(to)`, and `to` is what the slider and button show.
    const moved = bounds(10, 980);
    const live = draftForBounds(typed, moved);
    const to = resolveDraft(live?.text ?? null, moved);
    assert.equal(live, null);
    assert.equal(String(to), '10');

    // NEGATIVE CONTROL: without the stamp the field keeps the old text while `to` follows the bounds.
    const unstamped = resolveDraft(typed.text, moved);
    assert.equal(unstamped, 980, 'the clamp still holds: nothing illegal can be sent');
    assert.notEqual(
      typed.text,
      String(unstamped),
      'the old behaviour showed the same number the button did, so this defect was never real',
    );
  });

  it('is not fooled by a range that merely looks similar', () => {
    assert.equal(sameBounds(bounds(20, 1_000), bounds(20, 1_000)), true);
    assert.equal(sameBounds(bounds(20, 1_000), bounds(20, 1_001)), false);
    assert.equal(sameBounds(bounds(20, 1_000), bounds(21, 1_000)), false);
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

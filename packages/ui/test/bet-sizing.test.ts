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

  it('accepts a decimal and rounds it to a whole chip, which the readout then prints', () => {
    // Rounding is not silent: `clampBetTo` rounds, and the sizer's readout and commit button both
    // show the rounded total. A reader who types 600.9 is shown 601 before they press anything.
    assert.equal(resolveDraft('600.9', bounds(200, 840)), 601);
    assert.equal(resolveDraft('600.4', bounds(200, 840)), 600);
    assert.equal(isDraftMalformed({ text: '600.9', badInput: false }), false);
  });

  /**
   * The `1e3` defect.
   *
   * `Number.parseInt(text, 10)` was the parser, and `parseInt` stops at the first character it
   * cannot use: `parseInt('1e3', 10)` is **1**, which clamps to the minimum. `validity.badInput`
   * is false at the same moment, because a number input parses `1e3` perfectly well and keeps it
   * in `value` — so both halves of the invalid state said the field was fine.
   *
   * Measured in Chrome 151 on the built app at `/play?state=decision`, raise bounds 70–970:
   * typing `1e3` left `value === "1e3"`, `badInput === false`, no `aria-invalid`, no correction on
   * screen, and the commit button reading "Raise to 70". `2e2` — an ordinary way to write 200 —
   * behaved the same.
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
 * The property the two functions above exist to hold together, stated once.
 *
 * For every string a number input can hand this control: EITHER the field is marked invalid, OR
 * the amount the sizer resolves is the amount the characters mean. "What the characters mean" is
 * `Number(text)` — the platform's own reading of a numeric literal — clamped, because clamping is
 * declared behaviour that the readout prints.
 *
 * A silent clamp is precisely the case where neither holds: the reader is shown a legal-looking
 * field, and the button offers something else.
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
    // The old implementation, restated, run against the same strings. If this ever stops finding
    // a violation the property above has stopped being about anything.
    const offenders = TYPED.filter((text) => silentlyReinterpreted(text, range));
    assert.ok(
      offenders.length > 0,
      'the old `parseInt` parser produced no disagreement on any of these, so the check above proves nothing',
    );
    // And name the headline one explicitly, so a future edit to `TYPED` cannot quietly empty it.
    assert.ok(offenders.includes('1e3'), `expected 1e3 among the offenders, found ${String(offenders)}`);
    assert.equal(clampBetTo(Number.parseInt('1e3', 10), range), 200, 'parseInt("1e3") is 1');
    assert.equal(clampBetTo(Number('1e3'), range), 840, 'the characters mean 1000');
  });
});

/**
 * The invalid state of the bet field.
 *
 * ## The defect these exist for
 *
 * The field silently clamped and never marked itself. Type `one third` into the bet amount and
 * the browser holds the characters on screen, hands the change handler `value === ''`, and the
 * sizer quietly resolves that to the minimum — so the commit button changed its number, the field
 * still showed letters, and nothing anywhere said the two were related. The web app's quiz and
 * invite-code fields were given `aria-invalid` for exactly this; this control lives in the shared
 * package and was missed.
 *
 * ## Why the cases below are shaped the way they are
 *
 * `{ text: '', badInput: true }` is not a contrived pair — it is *literally* what an
 * `<input type="number">` reports for text it could not parse, and the reason this predicate
 * cannot be written against the text alone.
 *
 * Verified against a real browser rather than assumed. Typing `one third` into a number input in
 * Chrome 151 and then clearing it produced, in order:
 *
 *     after typing "one third"   value: ""      badInput: true    valid: false
 *     after clearing it          value: ""      badInput: false   valid: true
 *     after typing 600           value: "600"   badInput: false   valid: true
 *
 * The first two rows have the SAME value and must not have the same answer — which is the whole
 * argument in one table. On that first row `resolveDraft` still returned the minimum (200) and
 * would have sent it; `isDraftMalformed` returned true and a value-derived predicate returned
 * false, which is exactly the defect. The negative control below is that pair, and the first
 * version of the same fix elsewhere in this repo did get it wrong.
 */
describe('isDraftMalformed', () => {
  it('is not malformed before anything has been typed', () => {
    assert.equal(isDraftMalformed(null), false);
  });

  it('is not malformed when the field has simply been cleared', () => {
    // A blank field is a legitimate state on the way to a new number, and `resolveDraft` already
    // resolves it to the minimum. Marking it invalid would tell a screen reader that deleting the
    // contents was a mistake.
    assert.equal(isDraftMalformed({ text: '', badInput: false }), false);
    assert.equal(isDraftMalformed({ text: '   ', badInput: false }), false);
  });

  it('is not malformed for any amount the sizer can use, in range or out of it', () => {
    // Out of range is NOT invalid: `resolveDraft` clamps it, and the readout says what will be
    // sent. Only text that is not an amount at all is invalid.
    for (const text of ['0', '1', '600', '9999', '-40', '600.9', ' 300 ']) {
      assert.equal(isDraftMalformed({ text, badInput: false }), false, `text "${text}"`);
      // The pairing that makes the claim mean something: everything called well-formed here has
      // to be something `resolveDraft` can actually turn into a number.
      assert.ok(Number.isFinite(resolveDraft(text, bounds(200, 840))), `resolvable "${text}"`);
    }
  });

  it('is malformed when the browser reports text it could not parse', () => {
    // THE case. The browser has sanitised the value to '' and the only evidence that anything was
    // typed is the flag beside it.
    assert.equal(isDraftMalformed({ text: '', badInput: true }), true);
  });

  it('cannot be satisfied by looking at the value, which is the whole point', () => {
    // The negative control. These two drafts have IDENTICAL text and must disagree; an
    // implementation that derives the invalid state from `text` returns the same answer for both
    // and fails here. That implementation is the defect this predicate replaces, and it is
    // undetectable by any test that does not state this pair explicitly.
    const typedLetters = { text: '', badInput: true } as const;
    const clearedField = { text: '', badInput: false } as const;
    assert.equal(typedLetters.text, clearedField.text);
    assert.notEqual(isDraftMalformed(typedLetters), isDraftMalformed(clearedField));
  });

  it('also catches non-numeric text from a browser that keeps it in the value', () => {
    // Defence in depth for the second branch: `badInput` false, unparseable text present. No
    // current browser produces this on a number input, which is exactly why it would go unnoticed
    // if one ever did.
    for (const text of ['abc', 'e5', '-', '.', '+', 'one third', '1e3', '600abc']) {
      assert.equal(isDraftMalformed({ text, badInput: false }), true, `text "${text}"`);
    }
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

/**
 * The draft belongs to the spot it was typed in.
 *
 * ## The defect these exist for
 *
 * `ActionBar`'s header claimed that "blur normalises the text back to" the clamped amount. It does
 * — at the instant of blur, and not afterwards, because the bounds move at every street and the
 * text does not. So the number field went on showing an amount belonging to a spot that no longer
 * existed, while the slider, the readout and the commit button had all moved on. The clamp
 * invariant still held, so nothing illegal could be sent; what the reader was looking at was
 * simply not what the button would do.
 *
 * Measured in Chrome 151 at a live table on the built app. Preflop, raise bounds 20–1,000: type
 * `999999`, blur — field, slider, readout and button all read 1,000. Call, call. On the flop the
 * bounds are 10–980, and the field still reads `1000` while the slider reads 980, the readout
 * reads "Total commitment this street: 980 units" and the button reads "Bet to 980".
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
    // The property, stated as the four things the reader compares. `String(to)` is what the field
    // falls back to when there is no draft for this spot, and `to` is what the slider, the readout
    // and the commit button all show.
    const moved = bounds(10, 980);
    const live = draftForBounds(typed, moved);
    const to = resolveDraft(live?.text ?? null, moved);
    assert.equal(live, null);
    assert.equal(String(to), '10');

    // NEGATIVE CONTROL: without the stamp — which is what the component did — the field keeps the
    // old text while `to` follows the new bounds, and the two disagree on screen.
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

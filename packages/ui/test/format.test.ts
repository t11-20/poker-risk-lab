/**
 * The formatters. Assertions are on exact strings, because a formatter's contract is its output and a
 * digits-only check would miss the `Intl` locale drift that made these functions hand-rolled.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sprBandFor } from '@prl/poker-math';
import {
  describeSpr,
  FormatError,
  formatChips,
  formatConfidenceInterval,
  formatIndex,
  formatOdds,
  formatPercent,
  formatPoints,
  formatSignedUnits,
  formatUnits,
  NOT_AVAILABLE,
  pluralise,
  SPR_BANDS,
} from '../src/format.ts';

describe('formatPercent', () => {
  it('renders a fraction as a percentage with one decimal by default', () => {
    assert.equal(formatPercent(0.6237), '62.4%');
    assert.equal(formatPercent(0), '0.0%');
    assert.equal(formatPercent(1), '100.0%');
  });

  it('honours the decimals option', () => {
    assert.equal(formatPercent(0.6237, { decimals: 0 }), '62%');
    assert.equal(formatPercent(0.6237, { decimals: 2 }), '62.37%');
    assert.equal(formatPercent(0.6237, { decimals: 3 }), '62.370%');
  });

  it('adds a leading plus only when asked, and never on zero', () => {
    assert.equal(formatPercent(0.082, { signed: true }), '+8.2%');
    assert.equal(formatPercent(-0.082, { signed: true }), '-8.2%');
    assert.equal(formatPercent(0, { signed: true }), '0.0%');
    assert.equal(formatPercent(0.082), '8.2%');
  });

  it('does not clamp, because an impossible equity should be visible', () => {
    assert.equal(formatPercent(1.03), '103.0%');
    assert.equal(formatPercent(-0.5), '-50.0%');
  });

  it('normalises negative zero away', () => {
    assert.equal(formatPercent(-0.0001, { decimals: 1 }), '0.0%');
    assert.equal(formatPercent(-0), '0.0%');
  });

  it('groups thousands, for the percentages that are not probabilities', () => {
    assert.equal(formatPercent(12.5, { decimals: 0 }), '1,250%');
    assert.equal(formatPercent(1234.5, { decimals: 0 }), '123,450%');
  });

  it('returns the not-available marker for a non-finite input', () => {
    assert.equal(formatPercent(Number.NaN), NOT_AVAILABLE);
    assert.equal(formatPercent(Number.POSITIVE_INFINITY), NOT_AVAILABLE);
    assert.equal(formatPercent(Number.NEGATIVE_INFINITY), NOT_AVAILABLE);
  });
});

describe('formatPoints', () => {
  it('spells out the unit, because points and percent are different things', () => {
    assert.equal(formatPoints(0.8), '0.8 points');
    assert.equal(formatPoints(2), '2.0 points');
  });

  it('uses the singular at exactly one', () => {
    assert.equal(formatPoints(1), '1.0 point');
    assert.equal(formatPoints(1, { decimals: 0 }), '1 point');
    assert.equal(formatPoints(-1), '-1.0 point');
  });

  it('signs on request', () => {
    assert.equal(formatPoints(1.5, { signed: true }), '+1.5 points');
    assert.equal(formatPoints(-1.5, { signed: true }), '-1.5 points');
    assert.equal(formatPoints(0, { signed: true }), '0.0 points');
  });

  it('returns the marker for a non-finite input', () => {
    assert.equal(formatPoints(Number.NaN), NOT_AVAILABLE);
  });
});

describe('formatChips', () => {
  it('groups thousands and rounds to whole chips', () => {
    assert.equal(formatChips(0), '0');
    assert.equal(formatChips(7), '7');
    assert.equal(formatChips(999), '999');
    assert.equal(formatChips(1000), '1,000');
    assert.equal(formatChips(1250), '1,250');
    assert.equal(formatChips(1234567), '1,234,567');
    assert.equal(formatChips(120.4), '120');
    assert.equal(formatChips(120.6), '121');
  });

  it('keeps decimals when asked, for EV-shaped numbers', () => {
    assert.equal(formatChips(120.45, { decimals: 2 }), '120.45');
    assert.equal(formatChips(1200.5, { decimals: 1 }), '1,200.5');
  });

  it('renders negatives with a leading minus and no negative zero', () => {
    assert.equal(formatChips(-1250), '-1,250');
    assert.equal(formatChips(-0.4), '0');
  });

  it('returns the marker for a non-finite input', () => {
    assert.equal(formatChips(Number.NaN), NOT_AVAILABLE);
    assert.equal(formatChips(Number.POSITIVE_INFINITY), NOT_AVAILABLE);
  });
});

describe('formatUnits', () => {
  it('always says the word', () => {
    assert.equal(formatUnits(1250), '1,250 units');
    assert.equal(formatUnits(0), '0 units');
  });

  it('uses the singular for exactly one unit, either sign', () => {
    assert.equal(formatUnits(1), '1 unit');
    assert.equal(formatUnits(-1), '-1 unit');
    assert.equal(formatUnits(1.0, { decimals: 1 }), '1.0 unit');
    assert.equal(formatUnits(1.5, { decimals: 1 }), '1.5 units');
  });

  it('returns the marker with no unit word when there is no figure', () => {
    assert.equal(formatUnits(Number.NaN), NOT_AVAILABLE);
  });
});

describe('formatSignedUnits', () => {
  it('carries the sign in the text, so colour is never load-bearing', () => {
    assert.equal(formatSignedUnits(120), '+120 units');
    assert.equal(formatSignedUnits(-45), '-45 units');
  });

  it('leaves zero unsigned', () => {
    assert.equal(formatSignedUnits(0), '0 units');
    assert.equal(formatSignedUnits(-0), '0 units');
    assert.equal(formatSignedUnits(-0.4), '0 units');
  });

  it('uses the singular at one in each direction', () => {
    assert.equal(formatSignedUnits(1), '+1 unit');
    assert.equal(formatSignedUnits(-1), '-1 unit');
  });

  it('takes decimals, which is what EV figures need', () => {
    assert.equal(formatSignedUnits(12.44, { decimals: 1 }), '+12.4 units');
    assert.equal(formatSignedUnits(-12.46, { decimals: 1 }), '-12.5 units');
    assert.equal(formatSignedUnits(1234.5, { decimals: 1 }), '+1,234.5 units');
  });

  it('returns the marker for a non-finite input', () => {
    assert.equal(formatSignedUnits(Number.NaN), NOT_AVAILABLE);
  });
});

describe('formatOdds', () => {
  it('renders words, not a colon', () => {
    assert.equal(formatOdds(3.5), '3.5 to 1');
    assert.equal(formatOdds(2), '2 to 1');
    assert.equal(formatOdds(2.25), '2.3 to 1');
    assert.equal(formatOdds(2.25, { decimals: 2 }), '2.25 to 1');
  });

  it('drops a trailing zero so a whole ratio reads as one', () => {
    assert.equal(formatOdds(4.0), '4 to 1');
    assert.equal(formatOdds(0), '0 to 1');
  });

  it('describes a free continuation in words, and never as a price', () => {
    // `null` is what `@prl/poker-math` and `@prl/contracts` report when there is nothing to call,
    // because it is the only such value that survives JSON.
    const free = formatOdds(null);
    assert.equal(free, 'no cost to continue');
    assert.equal(free.includes('Infinity'), false);
    assert.equal(free.includes('null'), false);
    assert.notEqual(free, '0 to 1');
    assert.equal(formatOdds(null, { decimals: 2 }), 'no cost to continue');
  });

  it('refuses a negative or unusable ratio', () => {
    assert.equal(formatOdds(-1), NOT_AVAILABLE);
    assert.equal(formatOdds(Number.NaN), NOT_AVAILABLE);
    assert.equal(formatOdds(Number.NEGATIVE_INFINITY), NOT_AVAILABLE);
    // `Infinity` cannot cross JSON, so here it is a division by zero in the caller, not a free call.
    assert.equal(formatOdds(Number.POSITIVE_INFINITY), NOT_AVAILABLE);
  });
});

describe('formatConfidenceInterval', () => {
  it('shows the centre, the half-width and the level', () => {
    assert.equal(formatConfidenceInterval(0.6237, 0.82), '62.4% ± 0.8 points (95% interval)');
  });

  it('uses the supplied level', () => {
    assert.equal(formatConfidenceInterval(0.5, 1.5, { level: 0.99 }), '50.0% ± 1.5 points (99% interval)');
    assert.equal(formatConfidenceInterval(0.5, 1.5, { level: 0.9 }), '50.0% ± 1.5 points (90% interval)');
  });

  it('honours decimals on both halves of the figure', () => {
    assert.equal(
      formatConfidenceInterval(0.6237, 0.824, { decimals: 2 }),
      '62.37% ± 0.82 points (95% interval)',
    );
  });

  it('takes the absolute value of a half-width, since an interval has no direction', () => {
    assert.equal(formatConfidenceInterval(0.5, -0.8), '50.0% ± 0.8 points (95% interval)');
  });

  it('says the interval is MISSING, never that the figure is exact', () => {
    const text = formatConfidenceInterval(0.6237, null);
    assert.equal(text, '62.4% (no interval reported)');
    assert.ok(!text.includes('exact'), 'a missing interval must not be reported as exactness');
  });

  it('treats a non-finite half-width as a missing interval', () => {
    assert.equal(formatConfidenceInterval(0.5, Number.NaN), '50.0% (no interval reported)');
  });
});

describe('describeSpr', () => {
  it('bands a ratio at the shared edges, not its own (REGRESSION)', () => {
    // The edges are `sprBandFor` in `@prl/poker-math`, because `CoachPanel` renders this label above
    // that module's sentence. Both sides of each edge are asserted, and `high` closes inclusively at 13.
    assert.equal(describeSpr(0.5).band, 'committed');
    assert.equal(describeSpr(0.99).band, 'committed');
    assert.equal(describeSpr(1).band, 'low');
    assert.equal(describeSpr(2.99).band, 'low');
    assert.equal(describeSpr(3).band, 'medium');
    assert.equal(describeSpr(5.99).band, 'medium');
    assert.equal(describeSpr(6).band, 'high');
    assert.equal(describeSpr(13).band, 'high');
    assert.equal(describeSpr(13.01).band, 'deep');
    assert.equal(describeSpr(200).band, 'deep');
  });

  it('agrees with @prl/poker-math on every band, so the two cannot drift again', () => {
    // Sampled, because the defect was an edge that moved on one side only.
    const vocabulary: Readonly<Record<string, string>> = {
      'very-low': 'committed',
      low: 'low',
      medium: 'medium',
      high: 'high',
      'very-high': 'deep',
    };
    let compared = 0;
    for (let spr = 0; spr <= 2000; spr += 1) {
      const ratio = spr / 100;
      assert.equal(
        describeSpr(ratio).band,
        vocabulary[sprBandFor(ratio)],
        `SPR ${ratio}: the tile and the shared classifier disagree`,
      );
      compared += 1;
    }
    assert.ok(compared > 100, 'a sweep of nothing is not a pass');
  });

  it('labels the value, trimming a pointless decimal', () => {
    assert.equal(describeSpr(2).label, '2 — low');
    assert.equal(describeSpr(2.44).label, '2.4 — low');
    assert.equal(describeSpr(0.5).label, '0.5 — committed');
  });

  it('has no defined band for an undefined ratio', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const described = describeSpr(value);
      assert.equal(described.band, 'unknown');
      assert.equal(described.label, 'not defined');
    }
  });

  it('never tells the reader what to do', () => {
    // The product guardrails forbid claiming universal optimality.
    const forbidden = [' should ', ' must ', 'always ', 'never ', 'correct', 'optimal', 'best play'];
    for (const value of [0.5, 2, 5, 10, 40, Number.NaN]) {
      const meaning = describeSpr(value).meaning.toLowerCase();
      for (const word of forbidden) {
        assert.ok(!meaning.includes(word), `"${word}" appeared in an SPR meaning: ${meaning}`);
      }
    }
  });

  it('reports a band that is in the published list', () => {
    for (const value of [-1, 0, 0.5, 1, 4, 8, 15, 100]) {
      assert.ok(SPR_BANDS.includes(describeSpr(value).band));
    }
  });

  it('echoes the value it was given', () => {
    assert.equal(describeSpr(3.25).value, 3.25);
  });
});

describe('formatIndex', () => {
  it('pads to two digits, because the motif is fixed-width', () => {
    assert.equal(formatIndex(1), '01');
    assert.equal(formatIndex(9), '09');
    assert.equal(formatIndex(10), '10');
    assert.equal(formatIndex(16), '16');
  });

  it('does not truncate a number wider than the padding', () => {
    assert.equal(formatIndex(100), '100');
    assert.equal(formatIndex(1234), '1234');
  });

  it('takes a width when a longer sequence needs one', () => {
    assert.equal(formatIndex(7, { digits: 3 }), '007');
    assert.equal(formatIndex(7, { digits: 1 }), '7');
  });

  it('truncates a fractional position towards zero', () => {
    assert.equal(formatIndex(3.7), '03');
    assert.equal(formatIndex(0), '00');
  });

  it('keeps the sign on a negative index rather than hiding the bug', () => {
    assert.equal(formatIndex(-1), '-01');
  });

  it('returns the marker for a non-finite position', () => {
    assert.equal(formatIndex(Number.NaN), NOT_AVAILABLE);
    assert.equal(formatIndex(Number.POSITIVE_INFINITY), NOT_AVAILABLE);
  });
});

describe('pluralise', () => {
  it('agrees the noun with the count', () => {
    assert.equal(pluralise(0, 'out'), '0 outs');
    assert.equal(pluralise(1, 'out'), '1 out');
    assert.equal(pluralise(2, 'out'), '2 outs');
    assert.equal(pluralise(9, 'card'), '9 cards');
  });

  it('takes an explicit plural for anything irregular', () => {
    assert.equal(pluralise(3, 'penny', 'pence'), '3 pence');
    assert.equal(pluralise(1, 'penny', 'pence'), '1 penny');
    assert.equal(pluralise(2, 'sixes', 'sixes'), '2 sixes');
  });

  it('treats -1 as singular, which is what English does', () => {
    assert.equal(pluralise(-1, 'unit'), '-1 unit');
    assert.equal(pluralise(-2, 'unit'), '-2 units');
  });

  it('groups large counts', () => {
    assert.equal(pluralise(1712304, 'board'), '1,712,304 boards');
  });

  it('renders a fractional count to at most two decimals', () => {
    assert.equal(pluralise(1.5, 'unit'), '1.5 units');
    assert.equal(pluralise(2.005, 'unit'), '2 units');
    assert.equal(pluralise(2.125, 'unit'), '2.13 units');
  });

  it('marks a non-finite count but keeps the plural noun', () => {
    assert.equal(pluralise(Number.NaN, 'out'), `${NOT_AVAILABLE} outs`);
    assert.equal(pluralise(Number.POSITIVE_INFINITY, 'penny', 'pence'), `${NOT_AVAILABLE} pence`);
  });

  it('rejects an empty noun, which is always a caller bug', () => {
    assert.throws(() => pluralise(1, ''), FormatError);
  });
});

describe('argument validation', () => {
  /** The `FormatError` guards exist for values from JSON, so the fixture comes from `JSON.parse`. */
  const fromWire = JSON.parse('{"equity":"0.62","chips":null}') as {
    readonly equity: number;
    readonly chips: number;
  };

  it('throws for a value that is not a number at all', () => {
    // A string equity is a contract bug, and throwing surfaces it at the component that passed it.
    assert.throws(() => formatPercent(fromWire.equity), FormatError);
    assert.throws(() => formatPoints(fromWire.equity), FormatError);
    assert.throws(() => formatChips(fromWire.chips), FormatError);
    assert.throws(() => formatUnits(fromWire.chips), FormatError);
    assert.throws(() => formatSignedUnits(fromWire.chips), FormatError);
    assert.throws(() => formatOdds(fromWire.equity), FormatError);
    assert.throws(() => formatIndex(fromWire.chips), FormatError);
    assert.throws(() => describeSpr(fromWire.equity), FormatError);
    assert.throws(() => pluralise(fromWire.chips, 'out'), FormatError);
  });

  it('distinguishes "not a number" from "a number with no value"', () => {
    // NaN and Infinity are real arithmetic outcomes (an SPR with an empty pot), so they do not throw.
    assert.equal(formatPercent(Number.NaN), NOT_AVAILABLE);
    assert.doesNotThrow(() => formatChips(Number.POSITIVE_INFINITY));
  });
});

describe('cross-cutting guarantees', () => {
  it('produces no locale-dependent separators', () => {
    // Output must be byte-identical on server and client, or React reports a hydration mismatch.
    const samples = [
      formatChips(1234567),
      formatUnits(1234567),
      formatSignedUnits(-1234567),
      formatPercent(1234.5, { decimals: 2 }),
    ];
    for (const sample of samples) {
      assert.ok(/^[-+0-9,.%a-z ]+$/.test(sample), `unexpected characters in ${sample}`);
      assert.ok(!sample.includes(' '), 'no non-breaking spaces');
      assert.ok(!sample.includes('−'), 'no Unicode minus sign');
    }
  });

  it('never renders a negative zero', () => {
    // Anything that rounds to zero at the formatter's precision loses its sign. -0.004 rounds to
    // `0` chips, but as a percent it is a real negative figure and keeps its minus.
    for (const tiny of [-0, -1e-9]) {
      assert.ok(!formatChips(tiny).includes('-'), `formatChips(${tiny})`);
      assert.ok(!formatUnits(tiny).includes('-'), `formatUnits(${tiny})`);
      assert.ok(!formatSignedUnits(tiny).includes('-'), `formatSignedUnits(${tiny})`);
      assert.ok(!formatPercent(tiny).includes('-'), `formatPercent(${tiny})`);
      assert.ok(!formatPoints(tiny).includes('-'), `formatPoints(${tiny})`);
    }
    assert.equal(formatChips(-0.004), '0');
    assert.equal(formatSignedUnits(-0.004), '0 units');
    assert.equal(formatPercent(-0.004), '-0.4%');
  });
});

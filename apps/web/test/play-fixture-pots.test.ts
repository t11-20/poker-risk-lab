/**
 * The play fixture's pot obeys the engine's rule. `FLOP_DECISION_VIEW` is hand-authored and owned by no
 * regenerator, so `fixtures:check` cannot see it. The rule is asserted, not the literal.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

// Read as text, because `src/fixtures/table.ts` pulls in `@prl/ui`'s `.tsx`, which Node cannot load.
const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, '..', 'src', 'fixtures', 'table.ts'), 'utf8');

/** Just the `FLOP_DECISION_VIEW` literal, so a neighbouring export cannot be read by mistake. */
const VIEW = (() => {
  const start = SOURCE.indexOf('export const FLOP_DECISION_VIEW');
  assert.ok(start > 0, 'FLOP_DECISION_VIEW has been renamed or removed');
  const end = SOURCE.indexOf('export const', start + 1);
  assert.ok(end > start, 'the view literal must be followed by another export');
  return SOURCE.slice(start, end);
})();

function seatEntries(): readonly string[] {
  const seats = /seats:\s*\[([\s\S]*?)\n {2}\]/u.exec(VIEW);
  const body = seats?.[1];
  // Narrowed here, because the `tsc -p test/tsconfig.json` step does not narrow on `assert.ok(match)`.
  assert.ok(body !== undefined, 'the view no longer states a seats array this test can read');
  return [...body.matchAll(/\{[^{}]*\}/gu)].map((match) => match[0]);
}

function numberIn(field: string, text: string): number | null {
  const found = new RegExp(`${field}:\\s*(-?\\d+)`, 'u').exec(text);
  return found === null ? null : Number(found[1]);
}

describe('the play fixture states a pot the engine would state', () => {
  it('shows one pot, because no seat in it is all in (REGRESSION)', () => {
    const contesting = seatEntries().filter((seat) => !seat.includes("status: 'folded'"));
    assert.ok(contesting.length >= 2, 'a sweep of nothing is not a pass');
    const allIn = contesting.filter((seat) => numberIn('stack', seat) === 0);
    assert.equal(allIn.length, 0, 'this fixture is the no-side-pot case; it must have nobody all in');

    const pots = [...VIEW.matchAll(/\{\s*amount:[^{}]*\}/gu)].map((match) => match[0]);
    assert.equal(pots.length, 1, `with nobody all in there is one pot, not ${pots.length} layers`);
  });

  it('accounts for every chip in the middle, and caps at the deepest commitment', () => {
    const potTotal = numberIn('potTotal', VIEW);
    assert.ok(potTotal !== null, 'the view must state a potTotal');

    const pot = /\{\s*amount:[^{}]*\}/u.exec(VIEW)?.[0];
    assert.ok(pot !== undefined, 'the view must state a pot');
    assert.equal(numberIn('amount', pot), potTotal, 'the single layer holds the whole pot');
    assert.equal(numberIn('index', pot), 0);

    const contesting = seatEntries().filter((seat) => !seat.includes("status: 'folded'"));
    const cap = Math.max(...contesting.map((seat) => numberIn('committedTotal', seat) ?? 0));
    assert.equal(numberIn('capPerSeat', pot), cap, 'the cap is the deepest commitment among them');
  });
});

/**
 * `COMPLETED_HAND_VIEW` once showed "You, STACK 0" after winning the main pot. This settles the hand
 * as `settle` in `@prl/poker-engine` does. Starting stacks: hero 300, everybody else 1,000.
 */
describe('the completed-hand fixture shows the stacks the hand settled to', () => {
  const view = (() => {
    const start = SOURCE.indexOf('export const COMPLETED_HAND_VIEW');
    assert.ok(start > 0, 'COMPLETED_HAND_VIEW has been renamed or removed');
    const end = SOURCE.indexOf('export const', start + 1);
    assert.ok(end > start, 'the view literal must be followed by another export');
    return SOURCE.slice(start, end);
  })();
  const summary = (() => {
    const start = SOURCE.indexOf('export const COMPLETED_HAND_SUMMARY');
    assert.ok(start > 0, 'COMPLETED_HAND_SUMMARY has been renamed or removed');
    return SOURCE.slice(start, SOURCE.indexOf('];', start));
  })();

  const seats = (() => {
    const body = /seats:\s*\[([\s\S]*?)\n {2}\]/u.exec(view)?.[1];
    assert.ok(body !== undefined, 'the view no longer states a seats array this test can read');
    return [...body.matchAll(/\{[^{}]*\}/gu)].map((match) => {
      const text = match[0];
      const seat = numberIn('seat', text);
      const stack = numberIn('stack', text);
      const committed = numberIn('committedTotal', text);
      assert.ok(seat !== null && stack !== null && committed !== null, `unreadable seat entry: ${text}`);
      return { seat, stack, committed };
    });
  })();
  const pots = [...view.matchAll(/\{\s*amount:[^{}]*\}/gu)].map((match) => numberIn('amount', match[0]));

  const STARTING_STACK: readonly number[] = [300, 1000, 1000, 1000, 1000, 1000];
  /** Pot index to the seat the summary says took it: the main pot to "you", the side pot to seat 3. */
  const WINNER_OF_POT: Readonly<Record<number, number>> = { 0: 0, 1: 3 };

  it('reads the hand it is about to settle', () => {
    assert.equal(seats.length, 6, 'a sweep of nothing is not a pass');
    assert.deepEqual(pots, [905, 600]);
    // The winners above are the summary's; if the summary changes hands, this line changes with it.
    assert.match(summary, /Main pot, 905 units: your/u);
    assert.match(summary, /Side pot, 600 units: three queens/u);
    assert.match(view, /seat: 3,[\s\S]*?holeCards: pair\('Qs Qd'\)/u);
  });

  it('puts every chip committed into a pot', () => {
    const committed = seats.reduce((sum, seat) => sum + seat.committed, 0);
    const inPots = pots.reduce<number>((sum, amount) => sum + (amount ?? 0), 0);
    assert.equal(inPots, committed);
    assert.equal(numberIn('potTotal', view), committed);
  });

  it('pays each pot to its winner, so "You" is not on 0 after winning the main pot (REGRESSION)', () => {
    for (const { seat, stack, committed } of seats) {
      const start = STARTING_STACK[seat];
      assert.ok(start !== undefined, `no starting stack stated for seat ${seat}`);
      const won = pots.reduce<number>(
        (sum, amount, index) => sum + (WINNER_OF_POT[index] === seat ? (amount ?? 0) : 0),
        0,
      );
      assert.equal(
        stack,
        start - committed + won,
        `seat ${seat} started on ${start}, put in ${committed} and won ${won}, so settled on ` +
          `${start - committed + won} — not ${stack}`,
      );
    }
  });
});

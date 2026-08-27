/**
 * The play fixture's pot obeys the same rule the engine does.
 *
 * ## The gap this closes
 *
 * `FLOP_DECISION_VIEW` is hand-authored demo data — it never goes through `redactFor` — and it is
 * the state `/play?state=decision` renders, which is a route `test:ax`, `test:layout` and
 * `design:contrast` all walk. Nothing asserted its `pots`:
 *
 *   - `table-fixture-figures.test.ts` extracts only the `FLOP_DECISION_REPORT` literal.
 *   - `regenerate-web-fixtures.mjs` rewrites `scenarios.ts` and `review.ts`; `table.ts` is not a
 *     target, so `fixtures:check` cannot see it.
 *
 * That mattered because the engine and the fixture disagreed, and the FIXTURE was right. `redactFor`
 * used to fill `pots` with `buildPots`, which layers by `committedTotal` and is correct only at
 * settlement; on a live state it turns an uncalled bet into a side pot. For these very seats it
 * produced two layers where the fixture correctly showed one:
 *
 *     buildPots: [{amount:65, eligible:[0,3], cap:30}, {amount:35, eligible:[3], cap:65}]
 *     fixture:   [{amount:100, eligible:[0,3], cap:65}]
 *
 * The engine now agrees with the fixture. This asserts the rule rather than the literal, so it
 * holds if the fixture is re-authored.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

// Read as TEXT, not imported. `src/fixtures/table.ts` transitively pulls in `@prl/ui`'s `.tsx`
// components, which the package's plain `node --test` runner cannot load — importing it fails the
// whole file with ERR_UNKNOWN_FILE_EXTENSION. `table-fixture-figures.test.ts` next door reads the
// same file the same way for the same reason.
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

/** Every `{...}` seat entry in the view, as its raw text. */
function seatEntries(): readonly string[] {
  const seats = /seats:\s*\[([\s\S]*?)\n {2}\]/u.exec(VIEW);
  assert.ok(seats !== null, 'the view no longer states a seats array this test can read');
  return [...seats[1].matchAll(/\{[^{}]*\}/gu)].map((match) => match[0]);
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

#!/usr/bin/env node
/**
 * Tests for the screen-reader certification harness.
 *
 * Run with:  node --test scripts/screen-reader-certify.test.mjs
 *
 * ## The failure this is written against
 *
 * The harness reads its assertions out of `docs/production/accessibility-certification.md` rather
 * than carrying a copy, which is the right design and has one dangerous failure mode: a parser
 * that matches FEWER rows than the document contains still produces a complete-looking session and
 * a filled-in artefact. A reviewer would work through what they were shown, see "73 of 73", and
 * certify a tenth of the document.
 *
 * That is not hypothetical — the first version of this parser matched only the global table's
 * `| G1 |` shape and found **10** of the 73, because the journey tables number their rows `1.4`
 * and put the assertion in the third cell rather than the second.
 *
 * So the control is not "does it find some assertions". It is that the parse agrees with the
 * document's OWN declared totals, which §8 states per section and in a total row. Two independent
 * statements in one file, and this asserts they match. If somebody adds Journey 9 and forgets to
 * update §8, or updates §8 and writes the table in a third shape, this fails.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ASSERTION_IDS } from './ax-assertions.mjs';
import { assertionsIn, needsAPerson, plainText } from './screen-reader-certify.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOC = readFileSync(join(REPO_ROOT, 'docs', 'production', 'accessibility-certification.md'), 'utf8');

/**
 * The per-section counts the document states about itself in §9.
 *
 * Three numbers per row now — the assertions in the section, how many are machine-covered, and how
 * many still need a person — because the split has the same failure mode the total had. A section
 * that quietly moved two rows from `person` to `auto` without a check behind them would still add
 * up to 73.
 */
function declaredTotals(markdown) {
  const totals = new Map();
  let grand = null;
  for (const line of markdown.split('\n')) {
    // `| J3 Table and Coach | 21 | 10 | 11 | … |` and `| **Total** | **73** | **45** | **28** | …`
    const cell = String.raw`\s*(?:\*\*)?(\d+)(?:\*\*)?\s*\|`;
    const row = new RegExp(String.raw`^\|\s*(?:\*\*)?([^|*]+?)(?:\*\*)?\s*\|${cell}${cell}${cell}`).exec(
      line,
    );
    if (row === null) continue;
    const label = row[1].trim();
    const entry = { count: Number(row[2]), auto: Number(row[3]), person: Number(row[4]) };
    if (/^total$/i.test(label)) grand = entry;
    else if (/^(global|J\d)/i.test(label)) totals.set(label, entry);
  }
  return { totals, grand: grand?.count ?? null, grandSplit: grand };
}

describe('the harness reads the whole document', () => {
  it('finds exactly as many assertions as the document says it has (REGRESSION)', () => {
    const { grand } = declaredTotals(DOC);
    assert.ok(typeof grand === 'number' && grand > 0, '§8 no longer states a total; the control is gone');
    const found = assertionsIn(DOC);
    assert.equal(
      found.length,
      grand,
      `parsed ${found.length} assertions, §8 declares ${grand}. The first version of this parser ` +
        'found 10 — a session that looks complete and covers a tenth of the document.',
    );
  });

  it('agrees with the per-section counts, so a shortfall cannot hide in an average', () => {
    // The total alone is a weak control: losing six from one journey and gaining six of something
    // else nets to zero. The section breakdown is what makes it specific.
    const { totals } = declaredTotals(DOC);
    assert.ok(totals.size >= 8, 'the §9 breakdown is missing; the per-section control is gone');
    const parsed = new Map();
    for (const entry of assertionsIn(DOC)) {
      const key = /^Journey (\d)/.exec(entry.section)?.[1] ?? 'Global';
      parsed.set(key, (parsed.get(key) ?? 0) + 1);
    }
    for (const [label, declared] of totals) {
      const key = /^J(\d)/.exec(label)?.[1] ?? 'Global';
      assert.equal(
        parsed.get(key),
        declared.count,
        `${label}: parsed ${parsed.get(key)}, §9 declares ${declared.count}`,
      );
    }
  });

  it('agrees with the per-section auto/person split (REGRESSION)', () => {
    // Same control, one level down. The split is what decides which rows the human session asks
    // for, so a section whose markers drift from its declared breakdown silently changes the size
    // of that session while the document still reads 73.
    const { totals, grandSplit } = declaredTotals(DOC);
    const parsed = new Map();
    for (const entry of assertionsIn(DOC)) {
      const key = /^Journey (\d)/.exec(entry.section)?.[1] ?? 'Global';
      const seen = parsed.get(key) ?? { auto: 0, person: 0 };
      seen[entry.coverage] += 1;
      parsed.set(key, seen);
    }
    for (const [label, declared] of totals) {
      const key = /^J(\d)/.exec(label)?.[1] ?? 'Global';
      const seen = parsed.get(key) ?? { auto: 0, person: 0 };
      assert.equal(
        seen.auto,
        declared.auto,
        `${label}: ${seen.auto} rows marked auto, §9 declares ${declared.auto}`,
      );
      assert.equal(
        seen.person,
        declared.person,
        `${label}: ${seen.person} rows marked person, §9 declares ${declared.person}`,
      );
      assert.equal(
        declared.auto + declared.person,
        declared.count,
        `${label}: §9's own split does not add up`,
      );
    }
    const rows = assertionsIn(DOC);
    assert.equal(rows.filter((row) => row.coverage === 'auto').length, grandSplit.auto);
    assert.equal(needsAPerson(rows).length, grandSplit.person);
  });

  it('carries the journey step, not only the assertion', () => {
    // A journey row's second cell is the keys to press. An assertion presented without it tells a
    // reviewer what should have been announced and nothing about how to make it happen.
    const journey = assertionsIn(DOC).filter((entry) => entry.id.startsWith('J'));
    assert.ok(journey.length > 50);
    assert.ok(
      journey.every((entry) => typeof entry.step === 'string' && entry.step.length > 0),
      'a journey assertion arrived with no step',
    );
  });

  it('does not mistake a separator or a header row for an assertion', () => {
    const parsed = assertionsIn(
      [
        '| # | Checked by | Step | Assertion | Result |',
        '|---|---|---|---|---|',
        '| 1.1 | person | Load `/x` | It speaks. | |',
      ].join('\n'),
    );
    assert.deepEqual(
      parsed.map((entry) => entry.id),
      ['J1.1'],
    );
  });

  it('every assertion has text a reviewer can act on', () => {
    for (const entry of assertionsIn(DOC)) {
      assert.ok(entry.text.length > 10, `${entry.id} parsed to "${entry.text}"`);
      assert.ok(plainText(entry.text).length > 0);
    }
  });
});

describe('the auto/person split is a mapping, not a claim', () => {
  /**
   * The control the whole split rests on.
   *
   * A row marked `auto` is DROPPED from the human session. If the check behind it is deleted,
   * renamed, or never written, that row is checked by nobody: the document still says a machine has
   * it, and the reviewer is never asked. It reads as covered twice and is covered zero times, and
   * nothing else in the repository would notice.
   *
   * So this asserts set equality in BOTH directions, and the message on each half names the
   * specific rows, because "the sets differ" sends somebody diffing two files by hand.
   */
  it('every row marked auto has a check, and every check has a row marked auto (REGRESSION)', () => {
    const rows = assertionsIn(DOC);
    const markedAuto = new Set(rows.filter((row) => row.coverage === 'auto').map((row) => row.id));
    const checked = new Set(ASSERTION_IDS);

    const uncheckedButClaimed = [...markedAuto].filter((id) => !checked.has(id));
    assert.deepEqual(
      uncheckedButClaimed,
      [],
      `${uncheckedButClaimed.length} row(s) are marked "auto" in the document with no check in ` +
        'scripts/ax-assertions.mjs. They have been dropped from the human session and are asserted ' +
        `by nothing: ${uncheckedButClaimed.join(', ')}`,
    );

    const checkedButNotClaimed = [...checked].filter((id) => !markedAuto.has(id));
    assert.deepEqual(
      checkedButNotClaimed,
      [],
      `${checkedButNotClaimed.length} check(s) name an assertion the document does not mark "auto". ` +
        'Either the check is pointed at an ID that no longer exists, or a row was re-marked ' +
        `"person" and its check left behind: ${checkedButNotClaimed.join(', ')}`,
    );
  });

  it('the checked set is a real share of the document, not a token one', () => {
    // A guard against the split being satisfied by deleting checks until the sets happen to agree.
    const rows = assertionsIn(DOC);
    assert.ok(
      ASSERTION_IDS.length >= 40,
      `only ${ASSERTION_IDS.length} assertions are machine-checked; the split was worth doing at 45`,
    );
    assert.ok(needsAPerson(rows).length > 0, 'a residual set of zero would mean the blocker was deleted');
    assert.equal(new Set(ASSERTION_IDS).size, ASSERTION_IDS.length, 'an assertion ID is checked twice');
  });

  it('NEGATIVE CONTROL — a row with no "Checked by" marker is refused, not defaulted', () => {
    // Both defaults are wrong. Defaulting to `person` hides a check that was meant to exist;
    // defaulting to `auto` drops a row out of the human session on the strength of a typo. The only
    // safe answer is to stop, so this asserts it stops.
    const table = [
      '| # | Checked by | Step | Assertion | Result |',
      '|---|---|---|---|---|',
      '| 1.1 | | Load `/x` | It speaks. | |',
    ].join('\n');
    assert.throws(() => assertionsIn(table), /neither "auto" nor "person"/u);
    const typo = table.replace('| 1.1 | |', '| 1.1 | manual |');
    assert.throws(() => assertionsIn(typo), /"manual"/u);
  });

  it('NEGATIVE CONTROL — re-marking a row moves it between the two sets', () => {
    const asAuto = [
      '| # | Checked by | Step | Assertion | Result |',
      '|---|---|---|---|---|',
      '| 9.1 | auto | Load `/x` | It announces its name. | |',
    ].join('\n');
    assert.deepEqual(needsAPerson(assertionsIn(asAuto)), []);
    const asPerson = asAuto.replace('| auto |', '| person |');
    assert.deepEqual(
      needsAPerson(assertionsIn(asPerson)).map((row) => row.id),
      ['J9.1'],
    );
  });
});

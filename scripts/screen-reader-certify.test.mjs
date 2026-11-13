#!/usr/bin/env node
/**
 * Tests for the screen-reader certification harness. The parse must agree with the totals the
 * document declares about itself. The first parser read only the `| G1 |` shape and found 10 of 73
 * rows while the session still looked complete.
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
 * The per-section counts the document declares: total, machine-covered, and needing a person. The
 * split is checked too, because moving rows between markers keeps the total at 73.
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
    // Per section, because a loss in one journey and a gain elsewhere net to zero.
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
   * An `auto` row is dropped from the human session, so a missing check leaves it covered by nobody.
   * Set equality is asserted in both directions and each failure names the rows.
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
    const rows = assertionsIn(DOC);
    assert.ok(
      ASSERTION_IDS.length >= 40,
      `only ${ASSERTION_IDS.length} assertions are machine-checked; the split was worth doing at 45`,
    );
    assert.ok(needsAPerson(rows).length > 0, 'a residual set of zero would mean the blocker was deleted');
    assert.equal(new Set(ASSERTION_IDS).size, ASSERTION_IDS.length, 'an assertion ID is checked twice');
  });

  it('NEGATIVE CONTROL — a row with no "Checked by" marker is refused, not defaulted', () => {
    // A missing marker must stop the parse. Both defaults hide a row.
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

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
import { assertionsIn, plainText } from './screen-reader-certify.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOC = readFileSync(join(REPO_ROOT, 'docs', 'production', 'accessibility-certification.md'), 'utf8');

/** The per-section counts the document states about itself in §8. */
function declaredTotals(markdown) {
  const totals = new Map();
  let grand = null;
  for (const line of markdown.split('\n')) {
    // `| J3 Table and Coach | 21 | | | | | |` and `| **Total** | **73** | …`
    const row = /^\|\s*(?:\*\*)?([^|*]+?)(?:\*\*)?\s*\|\s*(?:\*\*)?(\d+)(?:\*\*)?\s*\|/.exec(line);
    if (row === null) continue;
    const label = row[1].trim();
    const count = Number(row[2]);
    if (/^total$/i.test(label)) grand = count;
    else if (/^(global|J\d)/i.test(label)) totals.set(label, count);
  }
  return { totals, grand };
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
    assert.ok(totals.size >= 8, 'the §8 breakdown is missing; the per-section control is gone');
    const parsed = new Map();
    for (const entry of assertionsIn(DOC)) {
      const key = /^Journey (\d)/.exec(entry.section)?.[1] ?? 'Global';
      parsed.set(key, (parsed.get(key) ?? 0) + 1);
    }
    for (const [label, declared] of totals) {
      const key = /^J(\d)/.exec(label)?.[1] ?? 'Global';
      assert.equal(parsed.get(key), declared, `${label}: parsed ${parsed.get(key)}, §8 declares ${declared}`);
    }
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
      ['| # | Step | Assertion | Result |', '|---|---|---|---|', '| 1.1 | Load `/x` | It speaks. | |'].join(
        '\n',
      ),
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

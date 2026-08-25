/**
 * `apps/api/scripts/enrolments.mjs`, proved capable of refusing.
 *
 * ## What this covers and what it deliberately does not
 *
 * Everything the operator tool does to the DATABASE is asserted against a real schema in
 * `apps/api/test/enrolments-database.test.ts` — the window arithmetic, the partial unique index,
 * the transaction that binds a grant to its audit entry, and the grant that stops the request-path
 * role writing one. None of that is repeated here.
 *
 * What is here is the argument parser, because it is the layer between an operator's typing and
 * thirty rows, and because its failure mode is silent. `--refernce PO-4471` on a bulk grant, under
 * a parser that ignored what it did not recognise, would enrol thirty people with an empty
 * reference and no way afterwards to tell which run they came from — the enrolment is written, the
 * command exits 0, and the defect surfaces months later as a class nobody can account for.
 *
 * `parseInstant` is here for the same reason with a sharper edge: `new Date('26/06/2026')` is
 * `Invalid Date`, which would reach the database as NULL and silently produce an entitlement with
 * no end.
 *
 * Needs no database: both functions are pure. Importing the module does not run `main()` — see
 * `startedFromCommandLine` in that file.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseArgs, parseInstant } from './enrolments.mjs';

describe('the enrolment CLI argument parser', () => {
  it('reads a command, values in both forms, flags and repeated --user', () => {
    const options = parseArgs([
      'grant',
      '--cohort',
      'spring-2026',
      '--by=J. Okafor',
      '--reference',
      'PO-4471',
      '--user',
      'usr_a',
      '--user',
      'usr_b',
      '--dry-run',
    ]);
    assert.equal(options.command, 'grant');
    assert.equal(options.values.get('cohort'), 'spring-2026');
    assert.equal(options.values.get('by'), 'J. Okafor');
    assert.equal(options.values.get('reference'), 'PO-4471');
    assert.deepEqual(options.users, ['usr_a', 'usr_b']);
    assert.equal(options.flags.has('dry-run'), true);
  });

  it('refuses an option it does not know (NEGATIVE CONTROL)', () => {
    // The whole reason the parser is not permissive. A tolerant parser would accept this and
    // write thirty rows whose `reference` nobody chose.
    assert.throws(() => parseArgs(['grant', '--refernce', 'PO-4471']), /Unknown option "--refernce"/u);
  });

  it('refuses a value option with nothing after it (NEGATIVE CONTROL)', () => {
    // `--reference --user usr_a` must not silently take `--user` as the reference and then enrol
    // nobody, which is what a parser that read the next token unconditionally would do.
    assert.throws(() => parseArgs(['grant', '--reference']), /Option --reference needs a value/u);
    assert.throws(() => parseArgs(['grant', '--reference', '--user', 'usr_a']), /needs a value/u);
  });

  it('refuses a value handed to a bare flag, and a second command', () => {
    assert.throws(() => parseArgs(['grant', '--dry-run=yes']), /takes no value/u);
    assert.throws(() => parseArgs(['grant', 'revoke']), /One command at a time/u);
  });

  it('keeps an empty string as a value rather than treating it as absent', () => {
    // `--reference ''` must reach the required() check as an empty value and be refused there,
    // not vanish into "not supplied" and take a default nobody wrote.
    const options = parseArgs(['grant', '--reference', '']);
    assert.equal(options.values.get('reference'), '');
  });
});

describe('the enrolment CLI date parser', () => {
  it('reads an ISO instant and a plain date', () => {
    assert.equal(parseInstant('2026-06-26T17:00:00Z', '--expires').toISOString(), '2026-06-26T17:00:00.000Z');
    assert.equal(parseInstant('2026-06-26', '--ends').toISOString(), '2026-06-26T00:00:00.000Z');
  });

  it('refuses anything Date cannot read (NEGATIVE CONTROL)', () => {
    // Without this, `--expires 26/06/2026` becomes `Invalid Date`, reaches the column as NULL and
    // produces an entitlement with no end — the exact mistake the cohort period exists to bound.
    assert.throws(() => parseInstant('26/06/2026', '--expires'), /is not a date this can read/u);
    assert.throws(() => parseInstant('next tuesday', '--expires'), /is not a date this can read/u);
  });
});

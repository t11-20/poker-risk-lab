/**
 * The enrolments.mjs argument and date parsers, whose failures are silent. No database.
 * Database behaviour is covered in `apps/api/test/enrolments-database.test.ts`.
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
    assert.throws(() => parseArgs(['grant', '--refernce', 'PO-4471']), /Unknown option "--refernce"/u);
  });

  it('refuses a value option with nothing after it (NEGATIVE CONTROL)', () => {
    // A parser that read the next token unconditionally would take `--user` as the reference.
    assert.throws(() => parseArgs(['grant', '--reference']), /Option --reference needs a value/u);
    assert.throws(() => parseArgs(['grant', '--reference', '--user', 'usr_a']), /needs a value/u);
  });

  it('refuses a value handed to a bare flag, and a second command', () => {
    assert.throws(() => parseArgs(['grant', '--dry-run=yes']), /takes no value/u);
    assert.throws(() => parseArgs(['grant', 'revoke']), /One command at a time/u);
  });

  it('keeps an empty string as a value rather than treating it as absent', () => {
    // It must reach required() as empty and be refused there, not fall back to a default.
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
    // An `Invalid Date` would reach the column as NULL and grant an entitlement with no end.
    assert.throws(() => parseInstant('26/06/2026', '--expires'), /is not a date this can read/u);
    assert.throws(() => parseInstant('next tuesday', '--expires'), /is not a date this can read/u);
  });
});

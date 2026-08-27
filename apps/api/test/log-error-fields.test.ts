/**
 * A database error carries the failing row, and the log must not.
 *
 * `PostgresError` arrives from postgres.js with `detail` set to
 * `Failing row contains (usr_…, ["Ah","Ks"], …)` — the row that violated the constraint, hole cards
 * and all, on an enumerable own property. Anything that logs an error by spreading it, or by
 * `JSON.stringify`, writes two players' cards into the log.
 *
 * Nothing here does. `serializeError` reads a FIXED set of five fields — type, message, stack, code,
 * cause — and `detail` is not among them, and postgres.js `debug` is never enabled so the driver
 * never logs statements or parameters either.
 *
 * **Both of those were true by construction and pinned by nothing**, which is the state a
 * hidden-information sweep found them in on 2026-08-27. A sixth field added to `serializeError` for
 * a good reason, or a `debug` flag switched on for an afternoon's troubleshooting, would each have
 * been a silent leak of exactly the thing this codebase is most careful about everywhere else.
 * `docs/VERIFICATION.md` §12 recorded it as a residual risk; this is the risk closed.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { serializeError } from '../src/logging.ts';

const API_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** The shape postgres.js really produces, with the fields that matter here. */
function postgresErrorLike(): Error & Record<string, unknown> {
  const error = new Error('new row for relation "hand_seats" violates check constraint') as Error &
    Record<string, unknown>;
  error.code = '23514';
  error.severity = 'ERROR';
  error.table_name = 'hand_seats';
  error.constraint_name = 'hand_seats_hole_cards_shape';
  // The leak, verbatim in the shape postgres.js hands over.
  error.detail = 'Failing row contains (hnd_probe, 0, usr_probe, ["Ah","Ks"], 200, null).';
  error.where = "SQL statement \"insert into prl.hand_seats ... ['Ah','Ks']\"";
  return error;
}

describe('a database error does not carry the failing row into the log', () => {
  it('serializeError emits five fields and none of them is `detail` (REGRESSION)', () => {
    const serialised = serializeError(postgresErrorLike());
    assert.deepEqual(
      Object.keys(serialised).sort(),
      ['cause', 'code', 'message', 'stack', 'type'],
      'serializeError emits a field set this test does not know about; if a new field can carry ' +
        'caller data, the log can now carry a hole card',
    );
  });

  it('no hole card survives, by any spelling', () => {
    const text = JSON.stringify(serializeError(postgresErrorLike()));
    for (const fragment of ['Ah', 'Ks', 'Failing row', 'hole_cards', 'insert into']) {
      assert.ok(!text.includes(fragment), `"${fragment}" reached the serialised error: ${text}`);
    }
    // And the control: the fragments really are in the input, so the assertion above is not
    // passing over an error that never had them.
    const raw = postgresErrorLike();
    assert.ok(String(raw.detail).includes('"Ah"'), 'the fixture no longer carries a card');
  });

  it('the message and code DO survive, so this is redaction and not silence', () => {
    // A serialiser that dropped everything would satisfy the two checks above and leave an
    // operator unable to diagnose a constraint violation at all.
    const serialised = serializeError(postgresErrorLike());
    assert.match(serialised.message, /violates check constraint/u);
    assert.equal(serialised.code, '23514');
  });

  it('NEGATIVE CONTROL — a serialiser that passed `detail` through is caught', () => {
    const leaky = { ...serializeError(postgresErrorLike()), detail: postgresErrorLike().detail };
    // `Ah`, not `"Ah"`: JSON.stringify escapes the inner quotes, so the quoted form never appears
    // literally. Getting this wrong made the control fail on its own first line the first time.
    assert.ok(JSON.stringify(leaky).includes('Ah'), 'the control does not actually leak');
    assert.notDeepEqual(Object.keys(leaky).sort(), ['cause', 'code', 'message', 'stack', 'type']);
  });

  it('postgres.js `debug` is never enabled, so the driver never logs a statement', () => {
    // `debug` receives the query text and its PARAMETERS — hole cards among them on an insert into
    // `hand_seats`. It is off because nothing sets it, which is exactly the kind of safety that
    // survives until somebody switches it on to chase a bug and forgets.
    const files = ['db.ts', join('repositories', 'sql.ts')];
    let scanned = 0;
    for (const file of files) {
      const text = readFileSync(join(API_SRC, file), 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '');
      scanned += 1;
      assert.ok(
        !/\bdebug\s*:/u.test(text),
        `${file} passes a \`debug\` option to postgres.js. That callback receives every statement ` +
          'and its parameters, which on an insert into hand_seats is two players’ hole cards.',
      );
    }
    assert.equal(scanned, files.length, 'the scan did not read both files');
  });
});

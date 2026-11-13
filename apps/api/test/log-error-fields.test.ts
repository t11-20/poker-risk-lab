/**
 * A postgres.js error carries the failing row, hole cards included, in its enumerable `detail`.
 * The log must not. `serializeError` emits a fixed set of five fields without `detail`, and
 * postgres.js `debug` stays off so the driver never logs statements or parameters.
 * This file pins both.
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
    // Control: the input really carries the fragments.
    const raw = postgresErrorLike();
    assert.ok(String(raw.detail).includes('"Ah"'), 'the fixture no longer carries a card');
  });

  it('the message and code DO survive, so this is redaction and not silence', () => {
    const serialised = serializeError(postgresErrorLike());
    assert.match(serialised.message, /violates check constraint/u);
    assert.equal(serialised.code, '23514');
  });

  it('NEGATIVE CONTROL — a serialiser that passed `detail` through is caught', () => {
    const leaky = { ...serializeError(postgresErrorLike()), detail: postgresErrorLike().detail };
    // `Ah`, not `"Ah"`, because JSON.stringify escapes the inner quotes.
    assert.ok(JSON.stringify(leaky).includes('Ah'), 'the control does not actually leak');
    assert.notDeepEqual(Object.keys(leaky).sort(), ['cause', 'code', 'message', 'stack', 'type']);
  });

  it('postgres.js `debug` is never enabled, so the driver never logs a statement', () => {
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

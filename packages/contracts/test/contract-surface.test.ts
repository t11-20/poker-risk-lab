/**
 * The contract package's own tests: type guards on hostile input, the error catalogue and its status
 * map, close codes and limits, `PATTERNS` against near-misses, and the structural rules every schema in
 * `ALL_SCHEMAS` must meet. Compiling schemas needs Ajv, which this package does not depend on, so
 * accept/reject fixtures live in the API suites (`test/wiring.test.ts`).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ALL_SCHEMAS,
  ERROR_CODES,
  ERROR_MESSAGES,
  ERROR_STATUS,
  isClientMessageType,
  isErrorCode,
  PATTERNS,
  WS_CLOSE,
  WS_LIMITS,
  WS_PROTOCOL_VERSION,
  wsError,
} from '../src/index.ts';

/** Values that are not strings, plus strings that look like they might pass. */
const HOSTILE: readonly unknown[] = [
  undefined,
  null,
  0,
  1,
  Number.NaN,
  true,
  false,
  {},
  [],
  () => 'internal_error',
  Symbol('internal_error'),
  new String('internal_error'),
  'INTERNAL_ERROR',
  'internal_error ',
  ' internal_error',
  '',
  'toString',
  'constructor',
  '__proto__',
  'hasOwnProperty',
];

describe('isErrorCode', () => {
  it('accepts every code in the catalogue and nothing else', () => {
    assert.ok(ERROR_CODES.length > 10, `expected a real catalogue, got ${ERROR_CODES.length} codes`);
    for (const code of ERROR_CODES) {
      assert.equal(isErrorCode(code), true, `${code} is in ERROR_CODES and must be recognised`);
    }
    for (const value of HOSTILE) {
      assert.equal(
        isErrorCode(value),
        false,
        `isErrorCode must refuse ${String(typeof value)} ${String(value)}`,
      );
    }
  });

  it('is not fooled by inherited object properties', () => {
    // Every object inherits `toString` and `constructor`, so a naive `code in ERROR_MESSAGES` accepts them.
    assert.equal(isErrorCode('constructor'), false);
    assert.equal(isErrorCode('toString'), false);
    assert.equal(isErrorCode('__proto__'), false);
  });
});

describe('isClientMessageType', () => {
  const KNOWN = ['hello', 'sit', 'stand', 'action', 'requestCoach', 'startHand', 'ping'] as const;

  it('accepts exactly the protocol’s client message types', () => {
    for (const type of KNOWN) assert.equal(isClientMessageType(type), true, `${type} is a client type`);
    for (const value of HOSTILE) assert.equal(isClientMessageType(value), false);
    // A guard that accepted server types would let a client claim server authority.
    for (const serverType of ['welcome', 'state', 'event', 'coach', 'ack', 'error', 'pong']) {
      assert.equal(
        isClientMessageType(serverType),
        false,
        `${serverType} travels server -> client only and must not be accepted inbound`,
      );
    }
  });
});

describe('wsError', () => {
  it('builds the one error shape both transports use, and carries no extra field', () => {
    const frame = wsError('req-12345678', 'not_your_turn', ERROR_MESSAGES.not_your_turn, 'ws-abcdef12');
    assert.deepEqual(frame, {
      type: 'error',
      requestId: 'req-12345678',
      error: {
        code: 'not_your_turn',
        message: ERROR_MESSAGES.not_your_turn,
        requestId: 'ws-abcdef12',
      },
    });
    // The client's correlation id and the server's log id are different, and a swap would be invisible.
    assert.notEqual(frame.requestId, frame.error.requestId);
  });

  it('accepts a null requestId, for a frame that answers nothing in particular', () => {
    const frame = wsError(null, 'invalid_request', ERROR_MESSAGES.invalid_request, 'ws-00000001');
    assert.equal(frame.requestId, null);
    assert.equal(frame.error.code, 'invalid_request');
  });
});

describe('the error catalogue', () => {
  it('gives every code a status and a message, with no orphan in either table', () => {
    const codes = new Set<string>(ERROR_CODES);
    assert.deepEqual(
      Object.keys(ERROR_STATUS).filter((key) => !codes.has(key)),
      [],
      'ERROR_STATUS has an entry for a code that does not exist',
    );
    assert.deepEqual(
      Object.keys(ERROR_MESSAGES).filter((key) => !codes.has(key)),
      [],
      'ERROR_MESSAGES has an entry for a code that does not exist',
    );
    for (const code of ERROR_CODES) {
      const status = ERROR_STATUS[code];
      assert.equal(typeof status, 'number', `${code} has no status`);
      assert.ok(status >= 400 && status <= 599, `${code} maps to ${status}, which is not an error status`);
      const message = ERROR_MESSAGES[code];
      assert.equal(typeof message, 'string', `${code} has no message`);
      assert.ok(message.length > 0, `${code}'s message is empty`);
    }
  });

  it('never puts an identifier, a value or a stack trace in a user-facing message', () => {
    // These are the only text either transport sends, so anything leaked here is leaked everywhere.
    for (const code of ERROR_CODES) {
      const message = ERROR_MESSAGES[code];
      assert.doesNotMatch(
        message,
        /\b(?:usr|ses|room|hand|act|mem)_[A-Za-z0-9_-]{8,}/,
        `${code} names an id`,
      );
      assert.doesNotMatch(message, /\bat\s+\S+\s+\(/, `${code} looks like a stack frame`);
      assert.doesNotMatch(message, /postgres|sql|ECONN|undefined|null/i, `${code} leaks an internal detail`);
    }
  });

  it('has no duplicate code', () => {
    assert.equal(new Set(ERROR_CODES).size, ERROR_CODES.length, 'ERROR_CODES contains a duplicate');
  });
});

describe('the WebSocket tables', () => {
  it('gives every close reason a distinct code in the private range, or 1000', () => {
    const codes = Object.values(WS_CLOSE);
    assert.equal(new Set(codes).size, codes.length, 'two close reasons share a code');
    for (const [name, code] of Object.entries(WS_CLOSE)) {
      const inPrivateRange = code >= 4000 && code <= 4999;
      assert.ok(
        code === 1000 || inPrivateRange,
        `${name} is ${code}; application close codes must be 1000 or in the 4000-4999 private range`,
      );
    }
  });

  it('publishes limits a client can actually behave well against', () => {
    for (const [name, value] of Object.entries(WS_LIMITS)) {
      assert.equal(typeof value, 'number', `${name} must be a number`);
      assert.ok(value > 0, `${name} must be positive, got ${value}`);
      assert.ok(Number.isFinite(value), `${name} must be finite`);
    }
    // A client that trusted the published numbers would otherwise be disconnected for obeying them.
    assert.ok(
      WS_LIMITS.burstAllowance >= WS_LIMITS.messagesPerSecond,
      'the burst allowance must be at least the sustained rate',
    );
    // Otherwise a silent client would be closed by the heartbeat instead of the handshake timeout.
    assert.ok(
      WS_LIMITS.handshakeTimeoutMs < WS_LIMITS.heartbeatIntervalMs,
      'the handshake window must close before the first heartbeat is due',
    );
    assert.ok(WS_LIMITS.maxSocketsPerSession >= 2, 'a learner with two tabs is not an attacker');
    assert.equal(typeof WS_PROTOCOL_VERSION, 'number');
  });
});

describe('the shared patterns', () => {
  /** Each pattern with values it must accept and near-misses it must refuse. */
  const CASES: readonly {
    readonly name: keyof typeof PATTERNS;
    readonly accept: readonly string[];
    readonly reject: readonly string[];
  }[] = [
    {
      name: 'CARD',
      accept: ['Ah', 'ah', '2c', 'Ts', '10d', 'KD'],
      reject: ['', 'A', 'h', 'Ahh', '1h', 'Az', 'Ah ', ' Ah', '11h', 'Ah\nKs'],
    },
    {
      name: 'CARDS',
      // A newline between two cards is accepted, because the pattern separates cards with `\s*`.
      // The single-card CARD pattern has no `\s` and refuses it.
      accept: ['AhKs', 'Ah Ks', 'Ah, Ks', '  Ah  Ks  ', 'Ah\nKs'],
      reject: ['', 'A', 'AhKz', 'Ah;Ks', 'Ah Ks!'],
    },
    {
      name: 'RANGE',
      accept: ['top:40', 'top:100', 'top:1', 'AA,KK', 'A2s+'],
      reject: ['', 'top:0', 'top:101', 'top:040', 'x', 'AA;KK', 'AA\nKK'],
    },
    {
      name: 'ID',
      accept: ['room_abc123', 'a', 'usr_a-b_c'],
      reject: ['', '_leading', '-leading', 'Room_ABC', 'room abc', `a${'b'.repeat(64)}`, 'ok\nnot'],
    },
    {
      name: 'CONTENT_ID',
      accept: ['pot-odds', 'lesson1', 'a'],
      reject: ['', '-leading', 'Pot-Odds', 'pot_odds', 'pot odds'],
    },
    {
      name: 'REQUEST_ID',
      accept: ['req-12345678', 'A_-01234567', 'a'.repeat(64)],
      reject: ['', 'short', 'a'.repeat(65), 'req 12345678', 'req.12345678'],
    },
    {
      name: 'DISPLAY_NAME',
      accept: ['Ada', 'Ada Lovelace', "O'Hara", 'A1'],
      reject: ['', 'A', ' Ada', 'Ada ', '<script>', 'Ada\nLovelace'],
    },
  ];

  for (const testCase of CASES) {
    it(`${testCase.name} accepts what it must and refuses the near-misses`, () => {
      const source = PATTERNS[testCase.name];
      assert.equal(typeof source, 'string', `${testCase.name} must be a pattern string`);
      // `u` so the pattern is checked as JavaScript reads it. Ajv uses the anchors in the source.
      const pattern = new RegExp(source, 'u');
      for (const value of testCase.accept) {
        assert.match(value, pattern, `${testCase.name} must accept ${JSON.stringify(value)}`);
      }
      for (const value of testCase.reject) {
        assert.doesNotMatch(value, pattern, `${testCase.name} must refuse ${JSON.stringify(value)}`);
      }
    });
  }

  it('anchors every pattern at both ends', () => {
    // Unanchored, `"Ah<script>"` would satisfy a card check. Ajv adds no anchors.
    for (const [name, source] of Object.entries(PATTERNS)) {
      assert.ok(source.startsWith('^'), `${name} is not anchored at the start`);
      assert.ok(source.endsWith('$'), `${name} is not anchored at the end`);
    }
  });
});

describe('every registered schema', () => {
  it('has a unique prl: id', () => {
    assert.ok(ALL_SCHEMAS.length >= 8, `expected the schema set, found ${ALL_SCHEMAS.length}`);
    const ids = ALL_SCHEMAS.map((schema) => schema.$id);
    for (const id of ids) {
      assert.equal(typeof id, 'string');
      assert.ok(id.startsWith('prl:'), `${id} must be namespaced, or it can collide with a route schema`);
    }
    assert.equal(new Set(ids).size, ids.length, 'two schemas share an $id; app.addSchema would throw');
  });

  it('closes every object, at every depth', () => {
    // The app's Ajv has `removeAdditional` off, so only `additionalProperties: false` rejects a
    // misspelled field instead of silently ignoring it.
    const open: string[] = [];
    let objectsChecked = 0;

    const walk = (node: unknown, path: string): void => {
      if (Array.isArray(node)) {
        for (const [index, item] of node.entries()) walk(item, `${path}[${index}]`);
        return;
      }
      if (node === null || typeof node !== 'object') return;
      const record = node as Record<string, unknown>;
      if (record['type'] === 'object' && record['properties'] !== undefined) {
        objectsChecked += 1;
        if (record['additionalProperties'] !== false) open.push(path);
      }
      for (const [key, value] of Object.entries(record)) walk(value, `${path}.${key}`);
    };

    for (const schema of ALL_SCHEMAS) walk(schema, schema.$id);
    assert.ok(
      objectsChecked >= ALL_SCHEMAS.length,
      `only ${objectsChecked} objects found; the walk is broken`,
    );
    assert.deepEqual(open, [], `these schema objects accept unknown properties:\n${open.join('\n')}`);
  });

  it('bounds every string and every number', () => {
    // An unbounded string is a body-size problem, and an unbounded integer reaches the engine as a bet size.
    const unbounded: string[] = [];
    let checked = 0;

    const walk = (node: unknown, path: string): void => {
      if (Array.isArray(node)) {
        for (const [index, item] of node.entries()) walk(item, `${path}[${index}]`);
        return;
      }
      if (node === null || typeof node !== 'object') return;
      const record = node as Record<string, unknown>;
      const type = record['type'];
      if (type === 'string' && record['enum'] === undefined && record['const'] === undefined) {
        checked += 1;
        const bounded = record['maxLength'] !== undefined || typeof record['pattern'] === 'string';
        if (!bounded) unbounded.push(`${path} (string)`);
      }
      if (type === 'integer' || type === 'number') {
        checked += 1;
        if (record['maximum'] === undefined && record['exclusiveMaximum'] === undefined) {
          unbounded.push(`${path} (${String(type)})`);
        }
      }
      for (const [key, value] of Object.entries(record)) walk(value, `${path}.${key}`);
    };

    for (const schema of ALL_SCHEMAS) walk(schema, schema.$id);
    assert.ok(checked > 20, `only ${checked} scalars found; the walk is broken`);
    assert.deepEqual(unbounded, [], `these fields have no upper bound:\n${unbounded.join('\n')}`);
  });
});

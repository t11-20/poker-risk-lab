/**
 * An oversized WebSocket frame is an incident to count, not a stack trace to page on.
 *
 * ## The defect
 *
 * `@fastify/websocket` attaches `socket.on('error', (error) => fastify.log.error(error))` inside
 * its own `handleUpgrade`, before the hub's connection handler ever runs. So a frame larger than
 * `LIBRARY_PAYLOAD_CEILING` — which `ws` refuses with a `RangeError: Max payload size exceeded`
 * from `Receiver.haveLength` — produced a **level 50** log record carrying the whole stack. Any
 * client can send one at will, so that is noise on the level operators alert on, and it is a
 * small amplification primitive: a few bytes of frame becomes a multi-line error record.
 *
 * The router's own ceiling (`WS_LIMITS.maxMessageBytes`) has always handled the identical event
 * properly — count it, close the socket, one line. The two paths now agree.
 *
 * ## What is asserted, and against what
 *
 * Both ceilings are driven with real frames over a real socket, and the log is captured as
 * NDJSON from the instance's own pino stream rather than inspected through a spy — so what these
 * tests read is exactly what would have been written to a production log.
 *
 * ## Would these fail if the behaviour broke?
 *
 * Checked by reverting: with `socket.removeAllListeners('error')` deleted from `hub.ts`, `a
 * frame past the library ceiling` fails on the level-50 record it then finds, naming
 * `Max payload size exceeded`. `stacksAtErrorLevel` is additionally fed a fabricated record of
 * exactly that shape and required to report it, so a detector that had quietly stopped matching
 * could not pass by finding nothing.
 */

import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';
import { API_PATHS, WS_CLOSE, WS_LIMITS } from '@prl/contracts';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { buildApp, registerRoutes } from '../src/app.ts';
import { type AppConfig, type EnvRecord, loadConfig } from '../src/config.ts';
import type { DatabaseHandle } from '../src/db.ts';
import { AppMetrics } from '../src/observability/metrics.ts';
import { sessionCookieName } from '../src/plugins/security.ts';
import { RoomRegistry } from '../src/rooms/registry.ts';
import { createWsHub } from '../src/ws/hub.ts';
import { accountFor, fixedSessionStore, seatingOnlyStore } from './helpers/live-room.ts';

const ALLOWED_ORIGIN = 'http://localhost:3000';
/** Long enough for a close handshake over loopback; short enough to fail rather than hang. */
const CLOSE_TIMEOUT_MS = 10_000;

/**
 * The library ceiling, restated here rather than imported.
 *
 * `hub.ts` derives it as `WS_LIMITS.maxMessageBytes * 4` and does not export it. Restating the
 * derivation means a change to it makes these tests fail loudly instead of silently sending a
 * frame that lands on the other side of a boundary that moved.
 */
const LIBRARY_CEILING_BYTES = WS_LIMITS.maxMessageBytes * 4;

function testConfig(overrides: EnvRecord = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    // Nothing here connects: `buildApp` gets a stub handle and the registry a fake store.
    DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:5432/unused',
    PUBLIC_WEB_ORIGIN: ALLOWED_ORIGIN,
    SESSION_COOKIE_SECRET: 'Zk7pQ2vR9tX4bN6mL1sD8gH3jF5wC0yA',
    RATE_LIMIT_MAX: '5000',
    ...overrides,
  });
}

const stubDatabase: DatabaseHandle = {
  ping: () => Promise.resolve({ ok: true }),
  close: () => Promise.resolve(),
};

/** One pino record, as far as this file cares. */
interface LogRecord {
  readonly level: number;
  readonly msg?: string;
  readonly err?: { readonly message?: string; readonly stack?: string };
  readonly [key: string]: unknown;
}

/**
 * Records at error level or above that carry a stack.
 *
 * The detector, written as a function so the same code that reads the real log can be shown a
 * fabricated violation and required to fire on it.
 */
function stacksAtErrorLevel(records: readonly LogRecord[]): LogRecord[] {
  return records.filter((record) => record.level >= 50 && record.err?.stack !== undefined);
}

interface Harness {
  readonly url: string;
  readonly cookie: string;
  readonly metrics: AppMetrics;
  readonly records: () => LogRecord[];
}

const openApps: FastifyInstance[] = [];
const openSockets: WebSocket[] = [];

after(async () => {
  for (const socket of openSockets) socket.terminate();
  for (const app of openApps) await app.close();
});

/**
 * An app with the hub registered exactly as `routes/index.ts` does, logging into an array.
 *
 * The logger is replaced through `serverOptions`, which `buildApp` merges last. That is the seam
 * the option exists for: everything else about the instance — the security layer, the hook
 * order, the real `@fastify/websocket` registration — is the shipped wiring.
 */
async function startHub(idPrefix: string): Promise<Harness> {
  const config = testConfig();
  const captured: LogRecord[] = [];
  const metrics = new AppMetrics();
  const app = await buildApp({
    config,
    database: stubDatabase,
    metrics,
    serverOptions: {
      logger: {
        level: 'info',
        stream: {
          write: (line: string) => {
            captured.push(JSON.parse(line) as LogRecord);
          },
        },
      },
    },
  });
  openApps.push(app);

  const registry = new RoomRegistry({ store: seatingOnlyStore(), botThinkingDelayMs: 0 });
  const roomId = `room_${idPrefix}`;
  const userId = `usr_${idPrefix}`;
  const token = `tok_oversize_${idPrefix}_abcdefghijklmnop`;
  await registry.open({
    record: {
      id: roomId,
      name: 'Oversize table',
      ownerUserId: userId,
      config: { smallBlind: 5, bigBlind: 10, ante: 0, maxSeats: 2, actionTimeoutSeconds: 30 },
      startingStack: 1_000,
      createdAt: '2026-08-17T12:00:00.000Z',
      closed: false,
    },
    members: [{ userId, displayName: 'Ada', isBot: false, botProfile: null }],
  });
  const sessions = new Map([[token, { sessionId: `ses_${idPrefix}`, user: accountFor(userId, 'Ada') }]]);
  await registerRoutes(app, [createWsHub({ registry, sessionStore: fixedSessionStore(sessions), metrics })]);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as AddressInfo;

  return {
    url: `ws://127.0.0.1:${address.port}${API_PATHS.ws()}`,
    cookie: `${sessionCookieName(config)}=${app.signCookie(token)}`,
    metrics,
    records: () => [...captured],
  };
}

/** Opens a socket, sends one frame of `bytes`, and reports how the server closed it. */
async function sendOneFrameOf(harness: Harness, bytes: number): Promise<{ code: number; reason: string }> {
  const socket = new WebSocket(harness.url, {
    headers: { cookie: harness.cookie, origin: ALLOWED_ORIGIN },
    // The client must be willing to hold what it is about to send; this is the SERVER's ceiling
    // under test, not the client library's.
    maxPayload: bytes * 2,
  });
  openSockets.push(socket);

  const closed = new Promise<{ code: number; reason: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the server never closed the socket')), CLOSE_TIMEOUT_MS);
    timer.unref();
    socket.once('close', (code: number, reason: Buffer) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString('utf8') });
    });
    // A refused frame surfaces on the client as an error too; the close is what is being
    // measured, so this only has to stop an unhandled 'error' event from throwing.
    socket.once('error', () => undefined);
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the upgrade did not complete')), CLOSE_TIMEOUT_MS);
    timer.unref();
    socket.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('error', (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  // Valid JSON of the right size, so nothing can be refused for being malformed instead.
  const padding = 'x'.repeat(Math.max(0, bytes - 40));
  socket.send(JSON.stringify({ type: 'ping', nonce: padding }));
  return closed;
}

describe('a frame past the library ceiling', () => {
  it('is counted and closed with one log line, never an error-level stack', async () => {
    const harness = await startHub('lib');
    const closed = await sendOneFrameOf(harness, LIBRARY_CEILING_BYTES + 1_024);

    // `ws` sends 1009 from `receiverOnError` before it emits the event this hub listens for, so
    // 1009 is what the peer sees and `closeCodeLabel` already treats it as a known code.
    assert.equal(closed.code, 1009, 'the peer must be told the frame was too large');

    const records = harness.records();
    assert.ok(records.length > 0, 'the log captured nothing at all, so this proves nothing');

    const stacks = stacksAtErrorLevel(records);
    assert.deepEqual(
      stacks.map((record) => record.err?.message ?? record.msg ?? ''),
      [],
      'an oversized frame must not put an error-level stack in the log; any client can send one',
    );

    const noted = records.filter((record) => record.msg === 'websocket frame over the ceiling');
    assert.equal(noted.length, 1, 'exactly one line, saying what happened');
    const line = noted[0];
    assert.ok(line !== undefined);
    assert.equal(line.level, 40, 'a client-caused refusal is a warning, not an error');
    assert.equal(line['ceilingBytes'], LIBRARY_CEILING_BYTES, 'the line names the limit that fired');
    assert.equal(line.err, undefined, 'no error object, so pino writes no stack');

    // Counted the same way the router counts its own ceiling: one metric answers "how many
    // oversized frames", whichever limit caught it.
    assert.match(
      harness.metrics.render(),
      /prl_websocket_frames_rejected_total\{reason="too_large"\} 1/,
      'the refusal must be visible in the metrics, not only in the log',
    );
  });

  it('has a detector that fires on the record the defect used to write', () => {
    // NEGATIVE CONTROL. `stacksAtErrorLevel` returning an empty list above has to mean "there was
    // no such record", not "this function no longer recognises one". Fed the exact shape pino
    // produced from `fastify.log.error(rangeError)`, it must report it.
    const asItWas: LogRecord[] = [
      { level: 30, msg: 'incoming request' },
      {
        level: 50,
        msg: 'Max payload size exceeded',
        err: {
          message: 'Max payload size exceeded',
          stack: 'RangeError: Max payload size exceeded\n    at Receiver.haveLength (ws/lib/receiver.js)',
        },
      },
    ];
    const found = stacksAtErrorLevel(asItWas);
    assert.equal(found.length, 1, 'the detector must see the defect it exists to catch');
    assert.match(found[0]?.err?.stack ?? '', /Receiver\.haveLength/);
  });
});

describe('a frame past the protocol ceiling but under the library one', () => {
  it('still takes the router’s documented path, with the protocol’s own close code', async () => {
    // The comparison that makes the change above meaningful: this is the behaviour the library's
    // path was made to match. Under `LIBRARY_PAYLOAD_CEILING`, so `ws` hands the frame over and
    // the router refuses it with the contract's code rather than the library's generic one.
    const bytes = WS_LIMITS.maxMessageBytes * 2;
    assert.ok(bytes < LIBRARY_CEILING_BYTES, 'this frame must sit between the two ceilings');

    const harness = await startHub('router');
    const closed = await sendOneFrameOf(harness, bytes);
    assert.equal(closed.code, WS_CLOSE.rateLimited, 'the router closes 4429, not 1009');
    assert.equal(closed.reason, 'frame too large');

    assert.deepEqual(
      stacksAtErrorLevel(harness.records()).map((record) => record.msg ?? ''),
      [],
      'the router path has never logged a stack either, and must not start',
    );
    assert.match(
      harness.metrics.render(),
      /prl_websocket_frames_rejected_total\{reason="too_large"\} 1/,
      'both ceilings feed one counter',
    );
  });
});

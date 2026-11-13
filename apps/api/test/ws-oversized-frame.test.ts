/**
 * An oversized WebSocket frame is counted, not logged as a stack. `@fastify/websocket` attaches
 * `socket.on('error', ...)` that logs at level 50, so any client could put a stack trace on the
 * alerting level at will. Both ceilings are driven with real frames, and the log is read as NDJSON
 * from the instance's own pino stream.
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
const CLOSE_TIMEOUT_MS = 10_000;

/** `hub.ts` derives it and does not export it. Restating it makes a change fail loudly. */
const LIBRARY_CEILING_BYTES = WS_LIMITS.maxMessageBytes * 4;

function testConfig(overrides: EnvRecord = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
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

interface LogRecord {
  readonly level: number;
  readonly msg?: string;
  readonly err?: { readonly message?: string; readonly stack?: string };
  readonly [key: string]: unknown;
}

/** A function so a fabricated violation can be shown to fire it. */
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

/** The logger is replaced through `serverOptions`, which `buildApp` merges last. The rest is shipped. */
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

async function sendOneFrameOf(harness: Harness, bytes: number): Promise<{ code: number; reason: string }> {
  const socket = new WebSocket(harness.url, {
    headers: { cookie: harness.cookie, origin: ALLOWED_ORIGIN },
    // The server's ceiling is under test, not the client's.
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
    // Only stops an unhandled 'error' event from throwing.
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

  // Valid JSON, so nothing is refused as malformed instead.
  const padding = 'x'.repeat(Math.max(0, bytes - 40));
  socket.send(JSON.stringify({ type: 'ping', nonce: padding }));
  return closed;
}

describe('a frame past the library ceiling', () => {
  it('is counted and closed with one log line, never an error-level stack', async () => {
    const harness = await startHub('lib');
    const closed = await sendOneFrameOf(harness, LIBRARY_CEILING_BYTES + 1_024);

    // `ws` sends 1009 from `receiverOnError` before emitting the event this hub listens for.
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

    // One metric for oversized frames, whichever limit caught it.
    assert.match(
      harness.metrics.render(),
      /prl_websocket_frames_rejected_total\{reason="too_large"\} 1/,
      'the refusal must be visible in the metrics, not only in the log',
    );
  });

  it('has a detector that fires on the record the defect used to write', () => {
    // NEGATIVE CONTROL. The exact shape pino produced from `fastify.log.error(rangeError)`.
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
    // Under the library ceiling, so the router refuses with the contract's code.
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

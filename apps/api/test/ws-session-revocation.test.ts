/**
 * A WebSocket is authenticated once. This file is about what happens next.
 *
 * ## The defect
 *
 * `ws/hub.ts` resolves `request.session` during the HTTP upgrade and the router never asks again.
 * Every REST request re-reads the session row, so expiry and revocation are enforced there by
 * `repositories/sessions.ts` and nothing else has to think about it — and a socket goes through
 * none of that. Measured against the code this file was written for:
 *
 *     POST /auth/logout            -> 204, session row revoked
 *     ws  {"type":"sit",...}       -> {"type":"ack","requestId":"..."}
 *     ws  {"type":"ping",...}      -> {"type":"pong","nonce":"...","serverTimeMs":...}
 *     socket close frames          -> none
 *
 * So `POST /auth/logout`, `POST /me/delete` and signing in a second time all revoked the
 * credential and left the channel it had opened fully live: a stolen cookie whose holder has a
 * socket open keeps an authenticated connection to the table after the victim signs out, and an
 * erased account keeps one after the account is gone.
 *
 * The same gap swallows expiry. `auth/session.ts` imposes `SESSION_ABSOLUTE_TTL_SECONDS` because
 * "sliding expiry with no ceiling means a stolen cookie stays valid forever provided the thief
 * keeps using it, which is precisely the property an attacker wants" — and that ceiling lives in
 * `findValidByToken`'s `expires_at > now()`, which a socket passes through exactly once. A peer
 * that answers pings therefore held an authenticated channel with no lifetime at all: neither the
 * fourteen-day idle window nor the sixty-day ceiling reached it.
 *
 * ## Would these fail if the behaviour broke?
 *
 * Checked by breaking it, which is how the transcript above was taken. With
 * `noteSessionRevoked` removed from `destroySession`, `signing out closes the socket it opened`
 * and `erasing an account closes every socket that account holds` both fail with the socket still
 * open and the `ack` still arriving. With the `sessionExpiresAtMs` check removed from the hub's
 * message handler, `a socket cannot outlive the session that opened it` fails on the `pong`.
 *
 * ## What is faked, and what is not
 *
 * Only the two stores — `prl.sessions`/`prl.users` and room persistence. The routes are the real
 * `createAuthRoutes`, the hub is the real `createWsHub` registered at the shipped path, the CSRF
 * token and the signed cookie are the real ones, and the socket is a real `ws` client over
 * loopback. The revocation path under test runs from `POST /auth/logout` end to end.
 */

import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';
import { ACCOUNT_DELETE_CONFIRMATION, API_PATHS, type DeleteAccountResponse, WS_CLOSE } from '@prl/contracts';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { buildApp, registerRoutes } from '../src/app.ts';
import type { IssuedSession, SessionAccount, SessionStore, StoredSession } from '../src/auth/session.ts';
import { type AppConfig, loadConfig } from '../src/config.ts';
import type { DatabaseHandle } from '../src/db.ts';
import { AppError } from '../src/errors.ts';
import { sessionCookieName } from '../src/plugins/security.ts';
import { RoomRegistry } from '../src/rooms/registry.ts';
import { type AuthStore, createAuthRoutes } from '../src/routes/auth.ts';
import { createWsHub } from '../src/ws/hub.ts';
import { accountFor, seatingOnlyStore } from './helpers/live-room.ts';

const ALLOWED_ORIGIN = 'http://localhost:3000';
/** The one learner. A fixed id, so the room's roster can name them. */
const LEARNER = 'usr_ada';
const ROOM = 'room_revocation';
/** Long enough for a close frame to cross loopback; short enough to fail rather than hang. */
const CLOSE_TIMEOUT_MS = 5_000;

function testConfig(): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:5432/unused',
    PUBLIC_WEB_ORIGIN: ALLOWED_ORIGIN,
    SESSION_COOKIE_SECRET: 'Zk7pQ2vR9tX4bN6mL1sD8gH3jF5wC0yA',
    RATE_LIMIT_MAX: '5000',
  });
}

const stubDatabase: DatabaseHandle = {
  ping: () => Promise.resolve({ ok: true }),
  close: () => Promise.resolve(),
};

// ---------------------------------------------------------------------------
// The two stores
// ---------------------------------------------------------------------------

interface Row {
  readonly sessionId: string;
  readonly user: SessionAccount;
  expiresAt: Date;
  revoked: boolean;
}

/**
 * `prl.sessions` and `prl.users` as a `Map`, with the one property that matters kept honest:
 * `findValidByToken` refuses a revoked or expired row, exactly as the SQL does.
 *
 * `sessionTtlMs` is a parameter so the expiry test can open a socket on a session that is about to
 * lapse. Nothing else in this file uses it.
 */
function fakeAuthStore(sessionTtlMs: number): AuthStore & { readonly rows: Map<string, Row> } {
  const rows = new Map<string, Row>();
  let counter = 0;
  const sessions: SessionStore = {
    findValidByToken: (token) => {
      const row = rows.get(token);
      if (row === undefined || row.revoked || row.expiresAt.getTime() <= Date.now()) {
        return Promise.resolve(null);
      }
      const stored: StoredSession = { sessionId: row.sessionId, expiresAt: row.expiresAt, user: row.user };
      return Promise.resolve(stored);
    },
    create: (userId) => {
      counter += 1;
      const token = `tok-${String(counter).padStart(4, '0')}`;
      const expiresAt = new Date(Date.now() + sessionTtlMs);
      rows.set(token, {
        sessionId: `ses_${String(counter).padStart(4, '0')}`,
        user: accountFor(userId, 'Ada'),
        expiresAt,
        revoked: false,
      });
      const issued: IssuedSession = {
        sessionId: `ses_${String(counter).padStart(4, '0')}`,
        token,
        expiresAt,
      };
      return Promise.resolve(issued);
    },
    extendExpiry: () => Promise.resolve(null),
    revoke: (sessionId) => {
      for (const row of rows.values()) {
        if (row.sessionId !== sessionId || row.revoked) continue;
        row.revoked = true;
        return Promise.resolve(true);
      }
      return Promise.resolve(false);
    },
    touchLastSeen: () => Promise.resolve(true),
  };

  const summary: DeleteAccountResponse = {
    deleted: { sessions: 1, lessonsCompleted: 0, quizAttempts: 0, scenarioAttempts: 0, roomMemberships: 0 },
    anonymised: { handSeats: 0, auditEvents: 0, roomsCreated: 0 },
  };

  return {
    rows,
    sessions,
    users: {
      // Always the same account, so the room roster below can name it before it exists.
      createGuest: () => Promise.resolve(accountFor(LEARNER, 'Ada')),
      findOrCreateOidc: () => Promise.reject(new AppError('internal_error', { logDetail: 'no oidc here' })),
      readUnits: () => Promise.resolve(10_000),
      resetUnits: () => Promise.resolve(10_000),
      // The real one revokes every session inside the deletion transaction. Doing the same here is
      // what makes `erasing an account…` a test of the hub rather than of this fake.
      deleteAccount: (userId) => {
        for (const row of rows.values()) {
          if (row.user.id === userId) row.revoked = true;
        }
        return Promise.resolve(summary);
      },
    },
    oidcAttempts: {
      create: () => Promise.reject(new AppError('internal_error', { logDetail: 'no oidc here' })),
      consume: () => Promise.resolve(null),
    },
  };
}

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

const openApps: FastifyInstance[] = [];
const openSockets: WebSocket[] = [];

after(async () => {
  for (const socket of openSockets) socket.terminate();
  for (const app of openApps) await app.close();
});

interface Harness {
  readonly app: FastifyInstance;
  readonly url: string;
  readonly config: AppConfig;
}

async function harness(sessionTtlMs = 60 * 60_000): Promise<Harness> {
  const config = testConfig();
  const app = await buildApp({ config, database: stubDatabase });
  openApps.push(app);
  const store = fakeAuthStore(sessionTtlMs);
  const registry = new RoomRegistry({
    store: seatingOnlyStore(),
    nextHandId: () => 'hand_revocation',
    botThinkingDelayMs: 0,
    onProblem: () => undefined,
  });
  await registry.open({
    record: {
      id: ROOM,
      name: 'Revocation table',
      ownerUserId: LEARNER,
      config: { smallBlind: 5, bigBlind: 10, ante: 0, maxSeats: 2, actionTimeoutSeconds: 30 },
      startingStack: 1_000,
      createdAt: '2026-08-17T12:00:00.000Z',
      closed: false,
    },
    members: [{ userId: LEARNER, displayName: 'Ada', isBot: false, botProfile: null }],
  });
  await registerRoutes(app, [
    createAuthRoutes({ store }),
    createWsHub({ registry, sessionStore: store.sessions }),
  ]);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as AddressInfo;
  return { app, config, url: `ws://127.0.0.1:${address.port}${API_PATHS.ws()}` };
}

function cookieValue(response: { cookies: { name: string; value: string }[] }, name: string): string | null {
  return response.cookies.find((entry) => entry.name === name)?.value ?? null;
}

/** A signed-in browser: the session cookie and the CSRF pair that goes with it. */
interface Browser {
  readonly sessionCookie: string;
  readonly csrfToken: string;
  readonly csrfCookie: string;
}

async function signIn(harnessed: Harness): Promise<Browser> {
  const read = await harnessed.app.inject({ method: 'GET', url: '/api/v1/auth/session' });
  assert.equal(read.statusCode, 200, read.payload);
  const body: { readonly csrfToken?: unknown } = read.json();
  const csrfCookie = cookieValue(read, 'prl_csrf');
  assert.ok(csrfCookie !== null, 'the session read must set the paired CSRF cookie');
  const created = await harnessed.app.inject({
    method: 'POST',
    url: '/api/v1/auth/guest',
    payload: {},
    cookies: { prl_csrf: csrfCookie },
    headers: { 'x-csrf-token': String(body.csrfToken) },
  });
  assert.equal(created.statusCode, 201, created.payload);
  const sessionCookie = cookieValue(created, sessionCookieName(harnessed.config));
  assert.ok(sessionCookie !== null, 'guest creation must set the session cookie');
  return { sessionCookie, csrfToken: String(body.csrfToken), csrfCookie };
}

interface Frame {
  readonly type: string;
  readonly [key: string]: unknown;
}

/** One real socket, recording frames and the close it eventually gets. */
class Client {
  readonly frames: Frame[] = [];
  readonly closes: { readonly code: number; readonly reason: string }[] = [];
  private socket: WebSocket | null = null;
  private readonly waiters: { predicate: (frame: Frame) => boolean; settle: (frame: Frame) => void }[] = [];
  private closeWaiters: (() => void)[] = [];

  async connect(harnessed: Harness, browser: Browser): Promise<void> {
    const socket = new WebSocket(harnessed.url, {
      headers: {
        cookie: `${sessionCookieName(harnessed.config)}=${browser.sessionCookie}`,
        origin: ALLOWED_ORIGIN,
      },
    });
    this.socket = socket;
    openSockets.push(socket);
    socket.on('message', (data: Buffer) => {
      const frame = JSON.parse(data.toString('utf8')) as Frame;
      this.frames.push(frame);
      for (const waiter of [...this.waiters]) {
        if (!waiter.predicate(frame)) continue;
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.settle(frame);
      }
    });
    socket.on('close', (code: number, reason: Buffer) => {
      this.closes.push({ code, reason: reason.toString('utf8') });
      for (const settle of this.closeWaiters) settle();
      this.closeWaiters = [];
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
  }

  send(message: Record<string, unknown>): void {
    this.socket?.send(JSON.stringify(message));
  }

  waitFor(predicate: (frame: Frame) => boolean, what: string): Promise<Frame> {
    const existing = this.frames.find(predicate);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), CLOSE_TIMEOUT_MS);
      timer.unref();
      this.waiters.push({
        predicate,
        settle: (frame) => {
          clearTimeout(timer);
          resolve(frame);
        },
      });
    });
  }

  waitForClose(): Promise<{ readonly code: number; readonly reason: string }> {
    const existing = this.closes[0];
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('the socket was never closed; the revocation did not reach it')),
        CLOSE_TIMEOUT_MS,
      );
      timer.unref();
      this.closeWaiters.push(() => {
        clearTimeout(timer);
        const close = this.closes[0];
        if (close === undefined) reject(new Error('closed with no close event'));
        else resolve(close);
      });
    });
  }

  async helloInto(roomId: string, nonce: string): Promise<void> {
    this.send({ type: 'hello', protocolVersion: 1, roomId, clientNonce: nonce });
    await this.waitFor((frame) => frame.type === 'welcome', 'welcome');
  }
}

// ---------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------

describe('a websocket and the session that opened it', () => {
  it('signing out closes the socket it opened', async () => {
    const harnessed = await harness();
    const browser = await signIn(harnessed);
    const client = new Client();
    await client.connect(harnessed, browser);
    await client.helloInto(ROOM, 'nonce-signout01');

    const signedOut = await harnessed.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      cookies: {
        [sessionCookieName(harnessed.config)]: browser.sessionCookie,
        prl_csrf: browser.csrfCookie,
      },
      headers: { 'x-csrf-token': browser.csrfToken },
    });
    assert.equal(signedOut.statusCode, 204, signedOut.payload);

    const close = await client.waitForClose();
    assert.equal(
      close.code,
      WS_CLOSE.unauthenticated,
      'a signed-out learner’s socket must be closed 4401, not left carrying a revoked session',
    );
  });

  it('leaves the socket usable while the session is still live', async () => {
    // The positive control. Without it, a hub that closed every socket on every revocation — or
    // simply on a timer — would pass the test above.
    const harnessed = await harness();
    const browser = await signIn(harnessed);
    const client = new Client();
    await client.connect(harnessed, browser);
    await client.helloInto(ROOM, 'nonce-control01');
    client.send({ type: 'ping', nonce: 'nonce-control02' });
    const pong = await client.waitFor((frame) => frame.type === 'pong', 'pong');
    assert.equal(pong['nonce'], 'nonce-control02');
    assert.equal(client.closes.length, 0, 'a live session’s socket must not be closed');
  });

  it('erasing an account closes every socket that account holds', async () => {
    const harnessed = await harness();
    // Two browsers, two sessions, two sockets — which is the case a per-session revocation cannot
    // reach: the deletion transaction revokes every row and hands back none of their ids.
    const first = await signIn(harnessed);
    const firstSocket = new Client();
    await firstSocket.connect(harnessed, first);
    await firstSocket.helloInto(ROOM, 'nonce-erase0001');

    const second = await signIn(harnessed);
    const secondSocket = new Client();
    await secondSocket.connect(harnessed, second);
    await secondSocket.helloInto(ROOM, 'nonce-erase0002');

    const erased = await harnessed.app.inject({
      method: 'POST',
      url: '/api/v1/me/delete',
      payload: { confirm: ACCOUNT_DELETE_CONFIRMATION },
      cookies: {
        [sessionCookieName(harnessed.config)]: second.sessionCookie,
        prl_csrf: second.csrfCookie,
      },
      headers: { 'x-csrf-token': second.csrfToken },
    });
    assert.equal(erased.statusCode, 200, erased.payload);

    for (const [name, socket] of [
      ['the other device', firstSocket],
      ['the device that asked', secondSocket],
    ] as const) {
      const close = await socket.waitForClose();
      assert.equal(close.code, WS_CLOSE.unauthenticated, `${name}’s socket stayed open after erasure`);
    }
  });

  it('a socket cannot outlive the session that opened it', async () => {
    // A session with 250 ms to live. The point is not the number: it is that the ceiling
    // `SESSION_ABSOLUTE_TTL_SECONDS` exists to impose is enforced on the CONNECTION and not only
    // on the requests that re-read the row.
    const harnessed = await harness(250);
    const browser = await signIn(harnessed);
    const client = new Client();
    await client.connect(harnessed, browser);
    await client.helloInto(ROOM, 'nonce-expiry001');

    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 400);
      timer.unref();
    });

    client.send({ type: 'ping', nonce: 'nonce-expiry002' });
    const close = await client.waitForClose();
    assert.equal(close.code, WS_CLOSE.unauthenticated, 'an expired session kept an open socket');
    assert.equal(
      client.frames.filter((frame) => frame.type === 'pong').length,
      0,
      'an expired session was answered',
    );
  });
});

/**
 * Graceful shutdown, against a real process holding a real socket — keep-alive HTTP, and WebSocket.
 *
 * ## The third defect, and why this file did not catch it either
 *
 * The WebSocket section below was added when the second defect was found, and the suite stopped
 * there. It therefore proved that every *upgraded* connection drains, and said nothing at all about
 * a connection that never became a request — which was still the original bug, untouched. Measured
 * on the build that had just been declared fixed:
 *
 *     idle websocket                        0.010 s / exit 0
 *     websocket mid-hand                    0.044 s / exit 0
 *     peer ignores the close frame          1.014 s / exit 0
 *     a TCP connection that sends nothing  10.022 s / exit 1
 *
 * `closeIdleConnections()` only drops a connection that has FINISHED a request; one that never
 * started one is invisible to it, and `server.close()` waits for it anyway. So a load balancer's
 * TCP health probe, a port scanner, a stalled TLS handshake, or any client that connects a moment
 * before it is ready to speak was enough to turn every deploy back into a hard kill — the exact
 * failure the first two fixes were for, reached by a connection that is easier to produce than
 * either of them.
 *
 * `SIGTERM with a connection that never became a request` below is that coverage. All three of its
 * tests fail against the old behaviour with code 1 after the full grace.
 *
 * ## The second defect, and why this file did not catch it
 *
 * This suite passed 3/3 while graceful shutdown was broken for **every WebSocket connection**,
 * because it contained no WebSocket: it locked in the keep-alive fix described below and never
 * touched an upgraded connection. `ws/hub.ts` registered `@fastify/websocket` with
 * `clientTracking: false`, and the library's `defaultPreClose` closes sockets inside
 * `if (server.clients)` — a Set `ws` only builds when tracking is on. So the close loop silently
 * did nothing, `server.close()` waited forever on the upgraded socket, `app.close()` never
 * resolved, and the grace deadline fired `process.exit(1)`. Measured on the same build, with only
 * the connection state differing:
 *
 *     idle                                 0.012 s / exit 0
 *     one socket at a table               10.012 s / exit 1, and the client saw 1006
 *     one socket that had not said hello   5.061 s / exit 0, and the client saw 4408
 *
 * One socket. No load. Every deploy while a learner had a table open was a hard kill, on the one
 * connection type this product is built on — and the client could not tell it from a lost network,
 * so `apps/web/src/lib/table-socket.ts`'s "the server is restarting" state was unreachable.
 *
 * `SIGTERM with a WebSocket open` below is the coverage that was missing. Both of its tests fail
 * against the old behaviour — the first with code 1 after the full grace and close code 1006, the
 * second with code 1 after the full grace.
 *
 * ## The first defect this exists for
 *
 * `forceCloseConnections: 'idle'` makes Fastify call `closeIdleConnections()` exactly once, when
 * `app.close()` is invoked. A keep-alive socket that is mid-request at that moment is not idle, is
 * never revisited, and then sits until `keepAliveTimeout` (72 s) expires. `server.close()` waits for
 * every connection, so `app.close()` never resolved, the `onClose` hooks never ran, the four
 * calculation threads were never terminated, and the 10 s deadline fired with `process.exit(1)` —
 * *after* the in-flight request had been answered 200. Browsers always use keep-alive, so that was
 * the ordinary deploy case, and adding `Connection: close` to the client made it pass, which is
 * exactly why it survived review.
 *
 * ## Why these tests are shaped the way they are
 *
 * Both hold a real request open across the signal, because that is the only state in which the bug
 * appears. The first does it deterministically — the request headers are sent, the body is not, so
 * the socket is unambiguously mid-request at SIGTERM whatever the machine's speed — and the second
 * does it the way a user would, with a Monte Carlo request that is genuinely computing on a worker
 * thread. The second asserts *that the response had not arrived yet* before it signals; if the
 * machine were fast enough to finish first the test fails rather than passing for the wrong reason.
 *
 * Neither test is allowed to pass on a timeout: each asserts exit code 0 and an elapsed time well
 * inside the grace, and asserts the process logged `shutdown complete` and never logged
 * `shutdown timed out`. With the fix reverted, both fail with code 1 after the full grace.
 */

import assert from 'node:assert/strict';
import { type ChildProcessByStdio, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { connect, createServer, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Readable } from 'node:stream';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { WS_CLOSE, WS_PROTOCOL_VERSION } from '@prl/contracts';
import WebSocket from 'ws';
import { databaseSkip, TEST_DATABASE_URL } from './helpers/database.ts';

const API_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = join(API_DIR, '..', '..');
const ENTRY = join(API_DIR, 'src', 'server.ts');

/**
 * Short enough that a hung drain is obvious rather than tedious, long enough that a clean drain has
 * room. The whole point is to finish far inside it: the assertions below allow a third of it.
 */
const GRACE_MS = 4_500;

/**
 * The grace for the test that holds a real Monte Carlo calculation open across the signal.
 *
 * Deliberately far larger than that calculation takes, and it is worth saying why rather than
 * tuning it silently. A correct drain MUST wait for an in-flight response, so the elapsed time
 * legitimately includes however long the calculation had left to run — which is a function of how
 * loaded the machine is. At the shared 4.5 s grace this test failed on a busy machine by exiting
 * hard mid-request: a real drain, correctly waiting, ruled a timeout. That would be a flaky test
 * reporting a defect that is not there, and the honest fix is to stop making the machine's speed
 * part of the assertion. Nothing is weakened by it: a drain that HANGS still hits this grace and
 * still fails, and the promptness that matters — the gap between the last response and the process
 * exiting — is asserted separately and tightly.
 */
const COMPUTE_GRACE_MS = 25_000;
const WEB_ORIGIN = 'http://localhost:3000';

/**
 * What `spawn` returns for `stdio: ['ignore', 'pipe', 'pipe']`.
 *
 * Named rather than cast: `ChildProcessWithoutNullStreams` claims a writable `stdin` this child does
 * not have, and asserting it with `as` would be a lie the compiler correctly refuses.
 */
type PipedChild = ChildProcessByStdio<null, Readable, Readable>;

interface RunningServer {
  readonly child: PipedChild;
  readonly port: number;
  readonly output: () => string;
  /** The grace this server was started with, so its own assertions can be scaled to it. */
  readonly graceMs: number;
}

const running: PipedChild[] = [];

after(() => {
  for (const child of running) if (child.exitCode === null) child.kill('SIGKILL');
});

/**
 * A port the kernel has just told us is free.
 *
 * `config.ts` refuses `PORT=0` (a deliberate check: a server that binds an arbitrary port is
 * almost always a mistake), so the port has to be chosen here. The window between closing this
 * listener and the child binding is a race in principle; in practice the kernel does not hand the
 * same ephemeral port to two consecutive `listen(0)` calls, and a collision would surface as a
 * loud EADDRINUSE rather than as a wrong result.
 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        probe.close();
        reject(new Error('could not obtain an ephemeral port'));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Starts the real entry point and waits for its own `listening` line.
 *
 * `NODE_ENV=development` is needed only because `logging.ts` switches the logger off entirely under
 * `test`, and the log is what proves the process reached `listening` and later `shutdown complete`.
 *
 * Values passed here win over `.env`: node's `--env-file` never overrides a variable that is
 * already in the environment.
 */
async function startServer(
  graceMs: number = GRACE_MS,
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<RunningServer> {
  const chosenPort = await freePort();
  const child = spawn(process.execPath, ['--env-file-if-exists=.env', ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      HOST: '127.0.0.1',
      PORT: String(chosenPort),
      PUBLIC_WEB_ORIGIN: WEB_ORIGIN,
      SHUTDOWN_GRACE_MS: String(graceMs),
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.push(child);

  let text = '';
  const collect = (chunk: Buffer): void => {
    text += chunk.toString('utf8');
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);

  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`the server did not report a listening address in 20s. Output:\n${text}`));
    }, 20_000);
    timer.unref();
    const check = (): void => {
      // The `listening` line carries the resolved address, which is where the ephemeral port is.
      const match = /"address":"http:\/\/127\.0\.0\.1:(\d+)"/.exec(text);
      if (match?.[1] === undefined) return;
      clearTimeout(timer);
      child.stdout.off('data', check);
      resolve(Number(match[1]));
    };
    child.stdout.on('data', check);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`the server exited with ${String(code)} before listening. Output:\n${text}`));
    });
  });

  return { child, port, output: () => text, graceMs };
}

interface Exit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly elapsedMs: number;
  /** `performance.now()` at exit, for measuring the gap after a response was delivered. */
  readonly at: number;
}

/** Sends SIGTERM and waits for the process to go, timing it. */
function terminate(server: RunningServer): Promise<Exit> {
  const startedAt = performance.now();
  return new Promise<Exit>((resolve, reject) => {
    const budget = server.graceMs * 3;
    const timer = setTimeout(() => {
      reject(
        new Error(`the process did not exit within ${budget}ms of SIGTERM. Output:\n${server.output()}`),
      );
    }, budget);
    timer.unref();
    server.child.on('exit', (code, signal) => {
      clearTimeout(timer);
      const at = performance.now();
      resolve({ code, signal, elapsedMs: at - startedAt, at });
    });
    server.child.kill('SIGTERM');
  });
}

/** A CSRF token and the cookies that go with it, since every mutating route needs both. */
async function csrfCredentials(port: number): Promise<{ readonly cookie: string; readonly token: string }> {
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/auth/session`, {
    headers: { origin: WEB_ORIGIN, accept: 'application/json' },
  });
  assert.equal(response.status, 200, 'the session probe must succeed before anything is signalled');
  const body: unknown = await response.json();
  const token = (body as { csrfToken?: unknown }).csrfToken;
  assert.equal(typeof token, 'string', 'GET /auth/session must hand out a CSRF token');
  const cookie = response.headers
    .getSetCookie()
    .map((raw) => raw.split(';', 1)[0] ?? '')
    .filter((pair) => pair.includes('='))
    .join('; ');
  assert.ok(cookie.length > 0, 'the CSRF secret cookie must be set');
  return { cookie, token: String(token) };
}

/**
 * Asserts a shutdown was clean, quick, and said so.
 *
 * `budgetMs` is the time the drain itself is allowed, and it is not the whole story when the
 * in-flight request is genuinely computing: the process must not exit before that response is
 * delivered, so the elapsed time legitimately includes however long the calculation had left. Each
 * caller therefore states its own budget and, where relevant, measures the gap between the response
 * arriving and the process going — which is the part that must be prompt.
 */
function assertCleanExit(
  exit: Exit,
  output: string,
  budgetMs: number = GRACE_MS / 3,
  graceMs = GRACE_MS,
): void {
  assert.doesNotMatch(output, /shutdown timed out/, 'the drain must not have hit its deadline');
  assert.match(output, /shutdown complete/, 'a clean shutdown logs that it completed');
  assert.equal(exit.signal, null, 'the process must exit of its own accord, not by signal');
  assert.equal(
    exit.code,
    0,
    `a drain that answered every in-flight request must exit 0, exited ${String(exit.code)}`,
  );
  assert.ok(
    exit.elapsedMs < budgetMs,
    `shutdown took ${exit.elapsedMs.toFixed(0)}ms against a ${budgetMs.toFixed(0)}ms budget ` +
      `(grace ${graceMs}ms); it should be prompt, not merely inside the deadline`,
  );
}

describe('SIGTERM with a request in flight on a keep-alive socket', () => {
  it('answers the request, exits 0, and does not wait out the grace', async () => {
    const server = await startServer();
    const { cookie, token } = await csrfCredentials(server.port);

    // Sent by hand rather than with fetch, because the defect is about a socket that is mid-request
    // at the instant of the signal and this is the only way to hold one there deterministically:
    // the headers and part of the body go now, the rest goes after SIGTERM. No timing assumption,
    // no dependence on how fast this machine computes anything.
    const body = JSON.stringify({ heroCards: 'AhAd', opponents: ['KsKc'], samples: 20_000 });
    const split = Math.floor(body.length / 2);
    const socket = connect(server.port, '127.0.0.1');
    socket.setNoDelay(true);
    let received = '';
    socket.on('data', (chunk: Buffer) => {
      received += chunk.toString('utf8');
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    socket.write(
      'POST /api/v1/math/equity HTTP/1.1\r\n' +
        `host: 127.0.0.1:${server.port}\r\n` +
        `origin: ${WEB_ORIGIN}\r\n` +
        'content-type: application/json\r\n' +
        `content-length: ${Buffer.byteLength(body)}\r\n` +
        `cookie: ${cookie}\r\n` +
        `x-csrf-token: ${token}\r\n` +
        'connection: keep-alive\r\n\r\n' +
        body.slice(0, split),
    );
    // Give the server time to read the headers and start the request. Nothing is being asserted on
    // this delay: the request cannot complete until the rest of the body arrives below.
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(received, '', 'the request cannot have been answered: half its body is unsent');

    const exiting = terminate(server);
    // Still nothing sent; the socket is unambiguously mid-request while the process drains.
    await new Promise((resolve) => setTimeout(resolve, 150));
    socket.write(body.slice(split));

    const exit = await exiting;
    socket.destroy();

    assert.match(
      received,
      /^HTTP\/1\.1 200 /,
      `the in-flight request must be answered: ${received.slice(0, 200)}`,
    );
    assert.match(received, /"heroEquity"/, 'and answered with the calculation, not an error body');
    assertCleanExit(exit, server.output());
  });

  it('exits 0 with a worker-thread calculation still running, and leaves no thread behind', async () => {
    const server = await startServer(COMPUTE_GRACE_MS);
    const { cookie, token } = await csrfCredentials(server.port);

    // A real Monte Carlo request on the worker pool: this is the path on which the four threads
    // were still alive at the deadline. `keepalive: true` is the point — undici reuses the
    // connection, which is what a browser does and what made this bug the normal deploy case.
    let answeredBeforeSignal = false;
    const inFlight = fetch(`http://127.0.0.1:${server.port}/api/v1/math/equity`, {
      method: 'POST',
      keepalive: true,
      headers: {
        origin: WEB_ORIGIN,
        'content-type': 'application/json',
        cookie,
        'x-csrf-token': token,
      },
      body: JSON.stringify({
        heroCards: 'AhAd',
        opponents: ['top:40', 'top:40', 'top:40'],
        samples: 200_000,
      }),
    }).then(async (response) => {
      const text = await response.text();
      return { status: response.status, text };
    });
    void inFlight.then(() => {
      answeredBeforeSignal = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(
      answeredBeforeSignal,
      false,
      'the calculation finished before the signal, so this run proved nothing about a request in ' +
        'flight — raise `samples` or add opponents',
    );

    const exiting = terminate(server);
    const answered = await inFlight;
    const answeredAt = performance.now();
    const exit = await exiting;

    assert.equal(
      answered.status,
      200,
      `the in-flight calculation must complete: ${answered.text.slice(0, 200)}`,
    );
    // The whole grace is the budget here, because the process is not allowed to exit before the
    // calculation it is still running has been delivered — the drain waiting for that is the
    // correct behaviour, and it is what the deadline is for. What must be prompt is the part after:
    // once the last response is out, the socket is idle and nothing may hold the process open.
    assertCleanExit(exit, server.output(), COMPUTE_GRACE_MS, COMPUTE_GRACE_MS);
    const trailingMs = exit.at - answeredAt;
    assert.ok(
      trailingMs < 1_000,
      `the process took ${trailingMs.toFixed(0)}ms to exit after the last response was delivered; ` +
        'a finished keep-alive socket must be dropped, not waited out',
    );
  });

  it('exits 0 with nothing in flight at all', async () => {
    // The control. It passed before the fix too, which is precisely why the bug was invisible:
    // every shutdown that happened to have no request open looked perfect.
    const server = await startServer();
    const health = await fetch(`http://127.0.0.1:${server.port}/api/v1/health`);
    assert.equal(health.status, 200);
    await health.text();

    const exit = await terminate(server);
    assertCleanExit(exit, server.output());
  });
});

// ---------------------------------------------------------------------------
// WebSockets
//
// Everything below exists because the suite above proved a shutdown correct without ever opening
// the connection this product runs on. See the second section of this file's header.
// ---------------------------------------------------------------------------

/** A cookie jar as one header value, with a response's `Set-Cookie` folded in. */
function mergeCookies(existing: string, response: Response): string {
  const jar = new Map<string, string>();
  const remember = (pair: string): void => {
    const name = pair.split('=', 1)[0];
    if (name !== undefined && name !== '' && pair.includes('=')) jar.set(name, pair);
  };
  for (const pair of existing.split('; ')) remember(pair);
  for (const raw of response.headers.getSetCookie()) remember(raw.split(';', 1)[0] ?? '');
  return [...jar.values()].join('; ');
}

/**
 * A guest account, and the cookies that authenticate its WebSocket upgrade.
 *
 * The socket carries no credential of its own — `ws/hub.ts` reads the session from the same signed
 * cookie every REST route uses — so a real upgrade needs a real sign-in, and that needs the
 * database. Hence the `databaseSkip` on the test that calls this.
 */
async function guestSession(port: number): Promise<{ readonly cookie: string; readonly token: string }> {
  const { cookie, token } = await csrfCredentials(port);
  const created = await fetch(`http://127.0.0.1:${port}/api/v1/auth/guest`, {
    method: 'POST',
    headers: {
      origin: WEB_ORIGIN,
      'content-type': 'application/json',
      cookie,
      'x-csrf-token': token,
    },
    body: JSON.stringify({ displayName: 'Shutdown Probe' }),
  });
  const body = await created.text();
  assert.equal(created.status, 201, `guest sign-in must succeed before a socket is opened: ${body}`);
  return { cookie: mergeCookies(cookie, created), token };
}

/** A room for the socket to join, so one of the two sockets is in the state a learner's is. */
async function createRoom(
  port: number,
  credentials: { readonly cookie: string; readonly token: string },
): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/rooms`, {
    method: 'POST',
    headers: {
      origin: WEB_ORIGIN,
      'content-type': 'application/json',
      cookie: credentials.cookie,
      'x-csrf-token': credentials.token,
    },
    body: JSON.stringify({
      name: 'Shutdown Probe',
      maxSeats: 2,
      smallBlind: 1,
      bigBlind: 2,
      startingStack: 200,
    }),
  });
  const body: unknown = await response.json();
  assert.equal(response.status, 201, `the room must exist before a socket joins it: ${JSON.stringify(body)}`);
  const id = (body as { room?: { id?: unknown } }).room?.id;
  assert.equal(typeof id, 'string', 'POST /rooms must answer with the room it created');
  return String(id);
}

/** Opens a real socket over loopback, rejecting with the close code if the upgrade is refused. */
function openSocket(port: number, cookie: string): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws`, {
    headers: { origin: WEB_ORIGIN, cookie },
  });
  return new Promise<WebSocket>((resolve, reject) => {
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
    socket.once('close', (code: number, reason: Buffer) => {
      reject(new Error(`the upgrade was refused: ${code} ${reason.toString('utf8')}`));
    });
  });
}

/** Sends `hello` and settles when the server has welcomed the socket into the room. */
function joinRoom(socket: WebSocket, roomId: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no welcome frame within 10s')), 10_000);
    timer.unref();
    const onMessage = (data: Buffer): void => {
      const frame: unknown = JSON.parse(data.toString('utf8'));
      if ((frame as { type?: unknown }).type !== 'welcome') return;
      clearTimeout(timer);
      socket.off('message', onMessage);
      resolve();
    };
    socket.on('message', onMessage);
    socket.once('close', (code: number) => {
      clearTimeout(timer);
      reject(new Error(`the socket closed ${code} before it was welcomed`));
    });
    socket.send(
      JSON.stringify({
        type: 'hello',
        protocolVersion: WS_PROTOCOL_VERSION,
        roomId,
        // 12 base64url characters, which is inside the contract's 8..64 for a request id.
        clientNonce: randomBytes(9).toString('base64url'),
      }),
    );
  });
}

interface ObservedClose {
  readonly code: number;
  readonly reason: string;
}

/** What the client saw when the socket ended, which is the half of this the server cannot assert. */
function closeOf(socket: WebSocket): Promise<ObservedClose> {
  return new Promise<ObservedClose>((resolve) => {
    socket.once('close', (code: number, reason: Buffer) => {
      resolve({ code, reason: reason.toString('utf8') });
    });
  });
}

/**
 * Completes a WebSocket upgrade by hand, and then never says another word.
 *
 * Written on a raw TCP socket precisely because a `ws` client is well behaved: it answers a close
 * frame, and the failure being tested is what happens when nothing does. No cookie is sent, so the
 * hub refuses the upgrade — but only *after* the protocol-level upgrade has completed, which is the
 * point: this is a real WebSocket that `http.Server#close()` counts, and any client on the internet
 * can open one without a session.
 */
async function muteSocket(port: number): Promise<{ readonly socket: Socket; readonly reply: string }> {
  const socket = connect(port, '127.0.0.1');
  socket.setNoDelay(true);
  let received = Buffer.alloc(0);
  socket.on('data', (chunk: Buffer) => {
    received = Buffer.concat([received, chunk]);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  socket.write(
    'GET /api/v1/ws HTTP/1.1\r\n' +
      `host: 127.0.0.1:${port}\r\n` +
      `origin: ${WEB_ORIGIN}\r\n` +
      'upgrade: websocket\r\n' +
      'connection: Upgrade\r\n' +
      `sec-websocket-key: ${randomBytes(16).toString('base64')}\r\n` +
      'sec-websocket-version: 13\r\n\r\n',
  );
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`no upgrade reply within 5s: ${received.toString('latin1')}`));
    }, 5_000);
    timer.unref();
    const check = (): void => {
      if (!received.toString('latin1').includes('\r\n\r\n')) return;
      clearTimeout(timer);
      socket.off('data', check);
      resolve();
    };
    socket.on('data', check);
    check();
  });
  return { socket, reply: received.toString('latin1').split('\r\n')[0] ?? '' };
}

describe('SIGTERM with a WebSocket open', () => {
  it('closes every socket with the protocol shutdown code and exits 0', {
    skip: databaseSkip('a real WebSocket upgrade, which needs a signed-in session'),
  }, async () => {
    const server = await startServer(GRACE_MS, {
      // The database the availability guard probed, so this test and that one agree on which
      // schema they are talking about even when `.env` names another.
      ...(TEST_DATABASE_URL === undefined ? {} : { DATABASE_URL: TEST_DATABASE_URL }),
    });
    const credentials = await guestSession(server.port);
    const roomId = await createRoom(server.port, credentials);

    // Two sockets, in the two states a socket can be in, because they are closed by different
    // code. `atTable` is in a room and so is indexed by `WsRouter`; `connecting` has not sent
    // `hello`, is in no room, and is therefore invisible to `router.closeAll` — it is only
    // reachable through the hub's own `live` map, which is why the drain reads that instead.
    const atTable = await openSocket(server.port, credentials.cookie);
    await joinRoom(atTable, roomId);
    const connecting = await openSocket(server.port, credentials.cookie);
    assert.equal(atTable.readyState, WebSocket.OPEN, 'the table socket must be open at the signal');
    assert.equal(connecting.readyState, WebSocket.OPEN, 'the second socket must be open at the signal');

    const closes = Promise.all([closeOf(atTable), closeOf(connecting)]);
    const exit = await terminate(server);
    const [tableClose, connectingClose] = await closes;

    // The close code is the assertion that matters as much as the exit code. A client cannot tell
    // a deploy from a lost network unless the server says so, and 1006 — no close frame at all,
    // which is what `process.exit` leaves behind — is exactly "lost network" to
    // `apps/web/src/lib/table-socket.ts`.
    assert.equal(
      tableClose.code,
      WS_CLOSE.serverShuttingDown,
      `a socket at a table must be told the server is shutting down, saw ${tableClose.code} ` +
        `${tableClose.reason}`,
    );
    assert.equal(
      connectingClose.code,
      WS_CLOSE.serverShuttingDown,
      `a socket that had not finished its handshake must be too, saw ${connectingClose.code} ` +
        `${connectingClose.reason}`,
    );
    assertCleanExit(exit, server.output());
    // The hub's own cleanup hangs off `onClose`, which only runs once `app.close()` resolves —
    // the very thing that did not happen. Asserting the line proves the cleanup ran rather than
    // inferring it from the exit code.
    assert.match(server.output(), /websocket hub closed/, 'the hub onClose cleanup must run');
  });

  it('is not held open by a client that never answers the close frame', async () => {
    // No SQL anywhere on this path: an upgrade with no cookie is refused before a query is issued
    // (`resolveSession` short-circuits on a missing cookie), so a placeholder URL is honest and
    // this test runs in `test:without-database` too — where it belongs, because a socket that will
    // not close has nothing to do with the schema.
    const server = await startServer(GRACE_MS, {
      DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:5432/unused',
    });
    const { socket, reply } = await muteSocket(server.port);
    assert.match(reply, /^HTTP\/1\.1 101 /, `the upgrade must complete before it is refused: ${reply}`);

    const exit = await terminate(server);
    socket.destroy();

    // Before the fix this exited 1 after the whole grace: the hub refuses the upgrade with a close
    // frame, this client ignores it, and `ws`'s own fallback is a 30 s `closeTimeout` — three times
    // the default grace. One socket, no session, any origin.
    assertCleanExit(exit, server.output());
  });
});

// ---------------------------------------------------------------------------
// Connections that never became a request
//
// See the first section of this file's header. Everything above holds a request or a WebSocket
// open across the signal; none of it opens a connection that does less than that, which is the
// cheapest thing a client can do and was still enough to hang the drain.
// ---------------------------------------------------------------------------

/**
 * Opens a TCP connection to the API and sends exactly what it is given — including nothing at all.
 *
 * Raw rather than through a client library on purpose: no HTTP client will hold a connection in
 * these states, because they are all states a correct client never enters. That is not a reason to
 * ignore them — nothing stops a peer on the network from producing them, and several kinds of
 * ordinary infrastructure do so by design.
 */
async function rawConnection(
  port: number,
  prelude = '',
): Promise<{ readonly socket: Socket; readonly received: () => string }> {
  const socket = connect(port, '127.0.0.1');
  socket.setNoDelay(true);
  let received = '';
  socket.on('data', (chunk: Buffer) => {
    received += chunk.toString('utf8');
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  // The drain is *supposed* to destroy these, so ECONNRESET on this end is the expected outcome
  // rather than a failure — and an unhandled 'error' would take the test process down with it.
  socket.on('error', () => undefined);
  if (prelude !== '') socket.write(prelude);
  // Long enough for the server to have accepted the connection and parsed whatever was sent, so
  // the state under test is the state the process is really in when the signal lands.
  await new Promise((resolve) => setTimeout(resolve, 200));
  return { socket, received: () => received };
}

describe('SIGTERM with a connection that never became a request', () => {
  // None of these three reaches a route, let alone a query, so a placeholder DSN is honest and they
  // run under `test:without-database` too — where they belong, because a connection that hangs a
  // deploy has nothing to do with the schema.
  const noDatabase = { DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:5432/unused' };

  it('is not held open by a TCP connection that sends nothing', async () => {
    const server = await startServer(GRACE_MS, noDatabase);
    const { socket, received } = await rawConnection(server.port);
    assert.equal(received(), '', 'nothing was sent, so nothing may come back');

    const exit = await terminate(server);
    socket.destroy();

    // The whole original defect in its simplest form. A connection with no request on it can never
    // be owed an answer, so there is nothing for the drain to wait for and no reason to be slower
    // than the sweep interval.
    assertCleanExit(exit, server.output());
  });

  it('is not held open by a request whose headers never end', async () => {
    const server = await startServer(GRACE_MS, noDatabase);
    // A request line and one header, and no blank line — so the parser has a message started and
    // never completed, and Fastify has never been handed a request at all. This is what a client
    // that dies mid-write leaves behind, and what a slowloris does on purpose.
    const { socket } = await rawConnection(
      server.port,
      `GET /api/v1/health HTTP/1.1\r\nhost: 127.0.0.1:${server.port}\r\n`,
    );

    const exit = await terminate(server);
    socket.destroy();

    assertCleanExit(exit, server.output());
  });

  it('is not held open by a Content-Length whose body never arrives', async () => {
    const server = await startServer(GRACE_MS, noDatabase);
    const { cookie, token } = await csrfCredentials(server.port);

    // The hardest of the three, and the one that says what "in flight" has to mean. The headers are
    // complete and announce a body, so Fastify HAS been handed a request and is waiting for it —
    // byte for byte the state the first test in this file requires the drain to wait for. The only
    // difference is that this client never sends the rest, and the drain cannot know that in
    // advance. So it waits for the client's half of the exchange for a bounded slice of the grace
    // and then drops the connection, rather than waiting out the deadline and exiting 1.
    const body = JSON.stringify({ heroCards: 'AhAd', opponents: ['KsKc'], samples: 20_000 });
    const { socket, received } = await rawConnection(
      server.port,
      'POST /api/v1/math/equity HTTP/1.1\r\n' +
        `host: 127.0.0.1:${server.port}\r\n` +
        `origin: ${WEB_ORIGIN}\r\n` +
        'content-type: application/json\r\n' +
        `content-length: ${Buffer.byteLength(body)}\r\n` +
        `cookie: ${cookie}\r\n` +
        `x-csrf-token: ${token}\r\n` +
        'connection: keep-alive\r\n\r\n',
    );
    assert.equal(received(), '', 'the request cannot have been answered: its body was never sent');

    const exit = await terminate(server);
    socket.destroy();

    // Half the grace rather than the usual third: this one legitimately spends the send grace
    // waiting to find out whether the client is merely slow, and that wait is the point. What must
    // not happen — and did — is spending the whole grace and then exiting 1.
    assertCleanExit(exit, server.output(), GRACE_MS / 2);
  });
});

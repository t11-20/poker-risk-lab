/**
 * Graceful shutdown against a real process holding a real socket, over keep-alive HTTP, WebSocket, and
 * connections that never became a request. Each shape can hang `app.close()` until the grace deadline
 * fires `process.exit(1)`.
 * No test may pass on a timeout. Each asserts exit 0, an elapsed time well inside the grace,
 * `shutdown complete` in the log, and no `shutdown timed out`.
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

/** A clean drain must finish far inside this. The assertions allow a third of it. */
const GRACE_MS = 4_500;

/**
 * Grace for the Monte Carlo test. A correct drain waits for the in-flight response, so elapsed time
 * depends on machine load, and at 4.5 s a busy machine failed a correct drain. A hung drain still
 * fails here, and the gap from last response to exit is asserted tightly on its own.
 */
const COMPUTE_GRACE_MS = 25_000;
const WEB_ORIGIN = 'http://localhost:3000';

/** `ChildProcessWithoutNullStreams` would claim a `stdin` this child does not have. */
type PipedChild = ChildProcessByStdio<null, Readable, Readable>;

interface RunningServer {
  readonly child: PipedChild;
  readonly port: number;
  readonly output: () => string;
  readonly graceMs: number;
}

const running: PipedChild[] = [];

after(() => {
  for (const child of running) if (child.exitCode === null) child.kill('SIGKILL');
});

/** `config.ts` refuses `PORT=0`, so the port is chosen here. A collision fails loudly with EADDRINUSE. */
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
 * `NODE_ENV=development` because `logging.ts` turns the logger off under `test`, and the log is the
 * evidence. Values passed here win over `.env`, since `--env-file` never overrides the environment.
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

/** Traffic before `/ready` queues behind the thread warmup and is then blamed on the drain. */
async function waitUntilReady(port: number, timeoutMs = 20_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  let last = 'never reached';
  while (performance.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/ready`).catch((error: unknown) => {
      last = error instanceof Error ? error.message : String(error);
      return null;
    });
    if (response !== null) {
      last = `HTTP ${String(response.status)}`;
      if (response.status === 200) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`the server did not become ready within ${timeoutMs}ms (last: ${last})`);
}

interface Exit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly elapsedMs: number;
  readonly at: number;
}

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
    await waitUntilReady(server.port);
    const { cookie, token } = await csrfCredentials(server.port);

    // Half the body before SIGTERM and half after holds the socket mid-request deterministically.
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
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(received, '', 'the request cannot have been answered: half its body is unsent');

    const exiting = terminate(server);
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
    await waitUntilReady(server.port);
    const { cookie, token } = await csrfCredentials(server.port);

    // `keepalive: true` reuses the connection as a browser does, which made this the normal deploy case.
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
        board: '2s7dQh',
        // The largest sampled request the work ceiling accepts (200,000 x 5 players = 1,000,000).
        opponents: ['top:40', 'top:40', 'top:40', 'top:40'],
        samples: 200_000,
      }),
    }).then(async (response) => {
      const text = await response.text();
      return { status: response.status, text };
    });
    void inFlight.then(() => {
      answeredBeforeSignal = true;
    });

    // A warmed run can finish inside 120ms, so wait on the busy gauge instead of a fixed sleep.
    const busyDeadline = performance.now() + 5_000;
    let sawBusy = false;
    while (performance.now() < busyDeadline) {
      const exposition = await fetch(`http://127.0.0.1:${server.port}/metrics`).then((response) =>
        response.text(),
      );
      if (/prl_worker_pool_busy \d*[1-9]/u.test(exposition)) {
        sawBusy = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(
      sawBusy,
      true,
      'a thread must be busy before the signal, or this is not an in-flight calculation',
    );
    assert.equal(
      answeredBeforeSignal,
      false,
      'the calculation finished before the signal, so this run proved nothing about a request in flight',
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
    // The drain must wait for the calculation, so the budget is the whole grace. The exit after the
    // last response is what must be prompt.
    assertCleanExit(exit, server.output(), COMPUTE_GRACE_MS, COMPUTE_GRACE_MS);
    const trailingMs = exit.at - answeredAt;
    assert.ok(
      trailingMs < 1_000,
      `the process took ${trailingMs.toFixed(0)}ms to exit after the last response was delivered; ` +
        'a finished keep-alive socket must be dropped, not waited out',
    );
  });

  it('exits 0 with nothing in flight at all', async () => {
    // The control: nothing here depends on the drain fixes.
    const server = await startServer();
    const health = await fetch(`http://127.0.0.1:${server.port}/api/v1/health`);
    assert.equal(health.status, 200);
    await health.text();

    const exit = await terminate(server);
    assertCleanExit(exit, server.output());
  });
});

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

/** The upgrade reads the same session cookie as REST, so a real upgrade needs a real sign-in. */
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
        clientNonce: randomBytes(9).toString('base64url'),
      }),
    );
  });
}

interface ObservedClose {
  readonly code: number;
  readonly reason: string;
}

function closeOf(socket: WebSocket): Promise<ObservedClose> {
  return new Promise<ObservedClose>((resolve) => {
    socket.once('close', (code: number, reason: Buffer) => {
      resolve({ code, reason: reason.toString('utf8') });
    });
  });
}

/**
 * Completes an upgrade on raw TCP and then never answers a close frame, which a `ws` client would.
 * With no cookie the hub refuses only after the upgrade, so any client can open one of these.
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
      ...(TEST_DATABASE_URL === undefined ? {} : { DATABASE_URL: TEST_DATABASE_URL }),
    });
    await waitUntilReady(server.port);
    const credentials = await guestSession(server.port);
    const roomId = await createRoom(server.port, credentials);

    // `connecting` has sent no `hello`, so `router.closeAll` cannot see it. Only the hub's `live` map can.
    const atTable = await openSocket(server.port, credentials.cookie);
    await joinRoom(atTable, roomId);
    const connecting = await openSocket(server.port, credentials.cookie);
    assert.equal(atTable.readyState, WebSocket.OPEN, 'the table socket must be open at the signal');
    assert.equal(connecting.readyState, WebSocket.OPEN, 'the second socket must be open at the signal');

    const closes = Promise.all([closeOf(atTable), closeOf(connecting)]);
    const exit = await terminate(server);
    const [tableClose, connectingClose] = await closes;

    // 1006, which `process.exit` leaves, reads as a lost network to `apps/web/src/lib/table-socket.ts`.
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
    // `onClose` runs only once `app.close()` resolves, which is what a missed socket hangs.
    assert.match(server.output(), /websocket hub closed/, 'the hub onClose cleanup must run');
  });

  it('is not held open by a client that never answers the close frame', {
    skip: databaseSkip('a completed upgrade, which needs a verified schema'),
  }, async () => {
    // The feature gate answers 503 until the schema is verified, so a close frame after a completed
    // upgrade needs a real database. The no-database half is the next case.
    const server = await startServer(GRACE_MS, {
      ...(TEST_DATABASE_URL === undefined ? {} : { DATABASE_URL: TEST_DATABASE_URL }),
    });
    const { socket, reply } = await muteSocket(server.port);
    assert.match(reply, /^HTTP\/1\.1 101 /, `the upgrade must complete before it is refused: ${reply}`);

    const exit = await terminate(server);
    socket.destroy();

    // `ws` falls back to a 30 s `closeTimeout`, three times the default grace.
    assertCleanExit(exit, server.output());
  });
});

describe('SIGTERM with an upgrade refused by the feature gate', () => {
  it('is not held open by an upgrade answered 503 before the schema was verified', async () => {
    // The gate answers before `@fastify/websocket` flags the request, which skips the plugin's socket
    // cleanup, so the gate destroys the socket itself or the connection stays open after the 503.
    const server = await startServer(GRACE_MS, {
      DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:5432/unused',
    });
    const { socket, reply } = await muteSocket(server.port);
    assert.match(reply, /^HTTP\/1\.1 503 /, `an unverified schema must refuse the upgrade: ${reply}`);

    const exit = await terminate(server);
    socket.destroy();

    assertCleanExit(exit, server.output());
  });
});

/** Raw TCP, because no HTTP client enters these states. Health probes and scanners do. */
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
  // The drain is meant to destroy these, and an unhandled ECONNRESET would kill the test process.
  socket.on('error', () => undefined);
  if (prelude !== '') socket.write(prelude);
  await new Promise((resolve) => setTimeout(resolve, 200));
  return { socket, received: () => received };
}

describe('SIGTERM with a connection that never became a request', () => {
  // The first two never reach a route, so they run without a database. The third needs a feature
  // route, which the feature gate keeps shut until the schema is verified.
  const noDatabase = { DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:5432/unused' };

  it('is not held open by a TCP connection that sends nothing', async () => {
    const server = await startServer(GRACE_MS, noDatabase);
    const { socket, received } = await rawConnection(server.port);
    assert.equal(received(), '', 'nothing was sent, so nothing may come back');

    const exit = await terminate(server);
    socket.destroy();

    assertCleanExit(exit, server.output());
  });

  it('is not held open by a request whose headers never end', async () => {
    const server = await startServer(GRACE_MS, noDatabase);
    // No blank line, so Fastify never receives a request. A slowloris does this on purpose.
    const { socket } = await rawConnection(
      server.port,
      `GET /api/v1/health HTTP/1.1\r\nhost: 127.0.0.1:${server.port}\r\n`,
    );

    const exit = await terminate(server);
    socket.destroy();

    assertCleanExit(exit, server.output());
  });

  it('is not held open by a Content-Length whose body never arrives', {
    skip: databaseSkip('a session and a feature route, which wait for a verified schema'),
  }, async () => {
    const server = await startServer(GRACE_MS, {
      ...(TEST_DATABASE_URL === undefined ? {} : { DATABASE_URL: TEST_DATABASE_URL }),
    });
    const { cookie, token } = await csrfCredentials(server.port);

    // Byte for byte the state the first test requires the drain to wait for. The drain waits a
    // bounded slice of the grace for the body, then drops the connection.
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

    // Half the grace, because this case spends the send grace waiting for a slow client.
    assertCleanExit(exit, server.output(), GRACE_MS / 2);
  });
});

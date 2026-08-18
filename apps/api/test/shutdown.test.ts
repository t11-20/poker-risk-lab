/**
 * Graceful shutdown, against a real process holding a real keep-alive socket.
 *
 * ## The defect this exists for
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
import { connect, createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Readable } from 'node:stream';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

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
async function startServer(graceMs: number = GRACE_MS): Promise<RunningServer> {
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

/**
 * The machinery every reliability drill borrows: a real server, a real client, a real database,
 * and the ability to break all three.
 *
 * Not a script — it has no shebang and is never invoked directly. `scripts/reliability-drills.mjs`
 * is the entry point and this is what it stands on. It is split out because the drills
 * themselves should read as "do this awful thing, then check these properties", and sixteen
 * copies of "spawn a server and wait for its listening line" would bury that entirely.
 *
 * ## Everything here talks to the real thing
 *
 * There is no in-process `buildApp` anywhere in this suite. A drill kills a process, pauses a
 * container, or drops a TCP connection, and none of those can be simulated by a test double:
 * the whole class of defect being hunted lives in the seam between the process and the
 * operating system. So the API is a spawned child of the real entry point, the database is a
 * real Postgres, and the client speaks HTTP and WebSocket over loopback exactly as a browser
 * does.
 *
 * ## Only node: builtins
 *
 * The repo's script convention, and here it earns its keep twice over. The WebSocket client is
 * Node's own global (Node 24), and SQL goes through `docker exec ... psql` rather than through
 * the `postgres` package, which means the drills can create and drop databases and pause
 * containers without this file depending on anything the API depends on. A harness that shared
 * the application's driver could be broken by the same defect it is meant to find.
 *
 * ## What this file does NOT do
 *
 * It makes no assertions. Everything it returns is evidence — output text, frames, timings,
 * exit codes — and `invariants.mjs` is what decides whether the evidence is acceptable. The
 * split is deliberate: a harness that both breaks the system and judges the result is one
 * refactor away from judging it kindly.
 *
 * If this file were removed, every drill would have to open its own sockets and spawn its own
 * children, and the suite's guarantee that each drill cleans up after itself — which is what
 * makes the suite re-runnable — would become sixteen separate promises instead of one.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const API_ENTRY = join(REPO_ROOT, 'apps', 'api', 'src', 'server.ts');
const MIGRATE_SCRIPT = join(REPO_ROOT, 'apps', 'api', 'scripts', 'migrate.mjs');

const NO_COLOR = process.env.NO_COLOR !== undefined || !process.stdout.isTTY;
export const paint = (code, s) => (NO_COLOR ? s : `\u001b[${code}m${s}\u001b[0m`);
export const dim = (s) => paint('2', s);
export const bold = (s) => paint('1', s);
export const red = (s) => paint('31', s);
export const green = (s) => paint('32', s);
export const yellow = (s) => paint('33', s);

/** The protocol version this harness speaks. Must match `WS_PROTOCOL_VERSION` in @prl/contracts. */
export const WS_PROTOCOL_VERSION = 1;

/**
 * The routes, as the server registers them.
 *
 * Copied rather than imported because this file may not import from the workspace: the point of
 * the suite is to exercise a built, running server, and importing its source would tie the
 * harness to a build. `scripts/reliability-drills.test.mjs` cross-checks every path here against
 * `apps/api/test/wiring.test.ts`'s manifest, so a rename breaks a test rather than the suite.
 */
export const ROUTES = {
  health: '/api/v1/health',
  ready: '/api/v1/ready',
  metrics: '/metrics',
  session: '/api/v1/auth/session',
  guest: '/api/v1/auth/guest',
  rooms: '/api/v1/rooms',
  joinRoom: '/api/v1/rooms/join',
  room: '/api/v1/rooms/:roomId',
  legendMatches: '/api/v1/legends/matches',
  hands: '/api/v1/hands',
  hand: '/api/v1/hands/:handId',
  equity: '/api/v1/math/equity',
  ws: '/api/v1/ws',
};

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Polls until a predicate holds, returning how long it took.
 *
 * Returns `null` rather than throwing on expiry, because "it never recovered" is a result a
 * drill has to report rather than an error that aborts it — the drill still has cleanup to do
 * and other properties to check. `recoveryBound` in `invariants.mjs` turns the null into the
 * finding.
 */
export async function measureUntil(predicate, budgetMs, pollMs = 50) {
  const startedAt = performance.now();
  const deadline = startedAt + budgetMs;
  for (;;) {
    let held = false;
    try {
      held = await predicate();
    } catch {
      // A predicate that throws is a predicate that is not yet true: during an outage every
      // probe here is expected to fail with ECONNREFUSED for a while, and that is the point.
      held = false;
    }
    if (held) return performance.now() - startedAt;
    if (performance.now() >= deadline) return null;
    await sleep(pollMs);
  }
}

/**
 * A port the kernel has just told us is free.
 *
 * `config.ts` refuses `PORT=0` on purpose — a server that binds an arbitrary port is almost
 * always a mistake — so the port has to be chosen out here. The window between closing this
 * listener and the child binding is a race in principle; in practice consecutive `listen(0)`
 * calls do not repeat, and a collision surfaces as a loud EADDRINUSE rather than a wrong result.
 */
export function freePort() {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.on('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        probe.close();
        fail(new Error('could not obtain an ephemeral port'));
        return;
      }
      const { port } = address;
      probe.close(() => done(port));
    });
  });
}

// ---------------------------------------------------------------------------
// Child processes
// ---------------------------------------------------------------------------

/**
 * Runs a command to completion, capturing both streams.
 *
 * Never throws on a non-zero exit: several drills deliberately run commands that must fail
 * (a migration against a poisoned database, for one), and the exit code is the evidence.
 */
export function run(command, args, options = {}) {
  return new Promise((done, fail) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? REPO_ROOT,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', fail);
    child.on('close', (code, signal) => done({ code, signal, stdout, stderr }));
  });
}

// ---------------------------------------------------------------------------
// Postgres, through the container rather than through a driver
// ---------------------------------------------------------------------------

/**
 * The pieces of a `postgres://` DSN the harness needs.
 *
 * Parsed with `URL` rather than a regex, and the password is decoded because a DSN carries it
 * percent-encoded. Nothing here logs the password; it goes into `docker exec -e PGPASSWORD`
 * and into the child's `DATABASE_URL`, and both of those are the credentials the developer
 * already has in `.env`.
 */
export function parseDsn(dsn) {
  const url = new URL(dsn);
  return {
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    host: url.hostname,
    port: url.port === '' ? '5432' : url.port,
    database: url.pathname.replace(/^\//, ''),
    /** The same DSN pointed at a different database on the same server. */
    withDatabase(name) {
      const next = new URL(dsn);
      next.pathname = `/${name}`;
      return next.toString();
    },
  };
}

/**
 * One SQL statement, run inside the Postgres container as the DSN's own user.
 *
 * `docker exec` rather than a client library, for the reason in the file header, and `-tAc` so
 * the result is bare tab-separated values that a drill can compare without parsing a table.
 * `ON_ERROR_STOP=1` makes a failing statement a non-zero exit rather than a warning buried in
 * stdout, which is what several drills assert on.
 */
// Not `async`: it has nothing to await, and the promise `run` returns is the one the caller wants.
export function psql(container, dsn, database, sql) {
  const parts = parseDsn(dsn);
  return run('docker', [
    'exec',
    '-e',
    `PGPASSWORD=${parts.password}`,
    container,
    'psql',
    '-U',
    parts.user,
    '-d',
    database,
    '-v',
    'ON_ERROR_STOP=1',
    '-tAc',
    sql,
  ]);
}

/**
 * Creates a database for this run to destroy.
 *
 * The developer's own database is never touched by any drill: every one of them connects to a
 * database this function made, and `dropScratchDatabase` removes it even when the drill failed.
 * `create database` cannot run inside a transaction and cannot be parameterised, so the name is
 * checked against a strict pattern here rather than escaped — it is generated by this suite and
 * a name that does not match is a bug in the suite, not untrusted input.
 */
export async function createScratchDatabase(container, dsn, name) {
  if (!/^prl_drills_[a-z0-9_]{1,40}$/.test(name)) {
    throw new Error(`refusing to create "${name}": a scratch database must be named prl_drills_*`);
  }
  await psql(container, dsn, 'postgres', `drop database if exists ${name} with (force)`);
  const created = await psql(container, dsn, 'postgres', `create database ${name}`);
  if (created.code !== 0) {
    throw new Error(`could not create ${name}: ${created.stderr.trim() || created.stdout.trim()}`);
  }
  return parseDsn(dsn).withDatabase(name);
}

/** Removes a scratch database. Tolerant of every failure: this runs on the cleanup path. */
export function dropScratchDatabase(container, dsn, name) {
  // Resolved rather than thrown, so a cleanup path never turns a refusal into a second failure.
  if (!/^prl_drills_[a-z0-9_]{1,40}$/.test(name)) {
    return Promise.resolve({ code: 1, stdout: '', stderr: 'refused' });
  }
  return psql(container, dsn, 'postgres', `drop database if exists ${name} with (force)`);
}

/** Applies every migration to a DSN. Returns the runner's own exit code and output. */
export function migrate(dsn, command = 'up') {
  return run(process.execPath, [MIGRATE_SCRIPT, command], { env: { DATABASE_URL: dsn } });
}

/** Docker, for the drills that pause and restart the database. */
export function docker(args) {
  return run('docker', args);
}

/** The container's health as Docker reports it, or its raw state when it has no health check. */
export async function containerHealth(container) {
  const result = await docker([
    'inspect',
    '-f',
    '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}',
    container,
  ]);
  return result.stdout.trim();
}

// ---------------------------------------------------------------------------
// The API under test
// ---------------------------------------------------------------------------

/**
 * Starts the real entry point and waits for its own `listening` line.
 *
 * `NODE_ENV=development` because `logging.ts` switches the logger off entirely under `test`, and
 * the log is a large part of the evidence every drill collects — "useful logging" is one of the
 * properties being checked, and it cannot be checked against silence.
 *
 * Values passed here beat `.env`: Node's `--env-file` never overrides a variable that is already
 * in the environment. That is what lets a drill point the same code at its own scratch database
 * while the developer's `.env` still supplies the cookie secret and everything else.
 *
 * The whole output is buffered and printed only when a drill fails, per the repo's script
 * convention. A passing drill that dumps a server's log makes the next failing one invisible.
 */
export async function startServer(options = {}) {
  const port = await freePort();
  const graceMs = options.graceMs ?? 5_000;
  const child = spawn(process.execPath, ['--env-file-if-exists=.env', API_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      HOST: '127.0.0.1',
      PORT: String(port),
      PUBLIC_WEB_ORIGIN: options.webOrigin ?? 'http://localhost:3000',
      SHUTDOWN_GRACE_MS: String(graceMs),
      DATABASE_URL: options.databaseUrl,
      // The suite drives one machine hard: several drills open dozens of sessions in a few
      // seconds, and the shipped guest limit of ten per minute would refuse them. Raised rather
      // than disabled, so a drill that trips a limiter by accident still sees a 429 rather than
      // nothing at all, and `malformed-ws-traffic` still has a working limiter to be closed by.
      RATE_LIMIT_MAX: options.rateLimitMax ?? '5000',
      RATE_LIMIT_GUEST_MAX: options.guestRateLimitMax ?? '2000',
      RATE_LIMIT_EXPENSIVE_MAX: options.expensiveRateLimitMax ?? '2000',
      METRICS_TOKEN: options.metricsToken ?? '',
      ...(options.env ?? {}),
    },
    // `detached` so the child leads its own process group and `stop()` below can signal the
    // whole group: the API spawns worker threads rather than child processes today, but a
    // harness that can only kill one pid is one refactor away from leaking a process tree.
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let text = '';
  const collect = (chunk) => {
    text += chunk.toString('utf8');
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);

  let exited = null;
  child.on('exit', (code, signal) => {
    exited = { code, signal };
  });

  const listeningPort = await new Promise((done, fail) => {
    const timer = setTimeout(() => {
      fail(new Error(`the server did not report a listening address in 30s. Output:\n${text}`));
    }, 30_000);
    timer.unref();
    const check = () => {
      const match = /"address":"http:\/\/127\.0\.0\.1:(\d+)"/.exec(text);
      if (match?.[1] === undefined) return;
      clearTimeout(timer);
      done(Number(match[1]));
    };
    child.stdout.on('data', check);
    child.on('exit', (code) => {
      clearTimeout(timer);
      fail(new Error(`the server exited with ${String(code)} before listening. Output:\n${text}`));
    });
    check();
  });

  return {
    child,
    port: listeningPort,
    graceMs,
    output: () => text,
    exited: () => exited,
    origin: `http://127.0.0.1:${listeningPort}`,
    /** Sends a signal to the process group and resolves with the exit, timing it. */
    signal: (name) => signalAndWait(child, name, graceMs * 4, () => text),
    /** Cleanup. Safe to call twice, and on a process that has already gone. */
    stop: async () => {
      if (exited !== null) return exited;
      try {
        return await signalAndWait(child, 'SIGKILL', 5_000, () => text);
      } catch {
        return exited;
      }
    },
  };
}

/**
 * Signals a server's process group and waits for it to go, timing it.
 *
 * The negative pid signals the group. ESRCH is tolerated because the process may have exited
 * between the check and the call, which is a race no amount of care removes and which means
 * exactly what the caller wanted.
 */
function signalAndWait(child, name, budgetMs, output) {
  const startedAt = performance.now();
  return new Promise((done, fail) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      done({ code: child.exitCode, signal: child.signalCode, elapsedMs: 0 });
      return;
    }
    const timer = setTimeout(() => {
      fail(new Error(`the process did not exit within ${budgetMs}ms of ${name}. Output:\n${output()}`));
    }, budgetMs);
    timer.unref();
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      done({ code, signal, elapsedMs: performance.now() - startedAt });
    });
    try {
      process.kill(-child.pid, name);
    } catch (error) {
      if (error?.code !== 'ESRCH') {
        clearTimeout(timer);
        fail(error);
        return;
      }
    }
  });
}

// ---------------------------------------------------------------------------
// A client that behaves like a browser
// ---------------------------------------------------------------------------

/**
 * One guest identity: cookie jar, CSRF token, and a record of everything it received.
 *
 * The transcript is the point. Every drill has to answer "did anything leak while this was
 * failing", and the only honest way to answer it is to keep every byte the client was sent and
 * scan the lot afterwards — including the bodies of error responses served while the database
 * was down, which is where a driver message naming a host or a query would surface.
 *
 * The jar ignores Domain, Path, Expires and Secure. Correct for a client talking to one origin
 * for a few seconds; wrong for anything else.
 */
export class Session {
  constructor(origin, webOrigin, name) {
    this.origin = origin;
    this.webOrigin = webOrigin;
    this.name = name;
    this.cookies = new Map();
    this.csrfToken = null;
    this.userId = null;
    /** Every response body this session received, for the leak scan. */
    this.transcript = [];
  }

  cookieHeader() {
    return [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; ');
  }

  absorb(response) {
    // `getSetCookie()`, not `get('set-cookie')`: the singular accessor comma-joins multiple
    // cookies and cookie attributes legally contain commas.
    for (const raw of response.headers.getSetCookie()) {
      const pair = raw.split(';', 1)[0] ?? '';
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  /**
   * A request. Never throws for a non-2xx: a drill usually WANTS the 503, and turning it into
   * an exception would make the interesting case the hard one to write.
   */
  async request(path, options = {}) {
    const headers = { accept: 'application/json', origin: this.webOrigin };
    const cookie = this.cookieHeader();
    if (cookie !== '') headers.cookie = cookie;
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    const method = options.method ?? 'GET';
    if (this.csrfToken !== null && method !== 'GET') headers['x-csrf-token'] = this.csrfToken;

    const startedAt = performance.now();
    let response;
    try {
      response = await fetch(new URL(path, this.origin), {
        method,
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error) {
      return {
        ok: false,
        status: 0,
        body: null,
        text: '',
        elapsedMs: performance.now() - startedAt,
        transportError: error?.cause?.code ?? error?.name ?? 'fetch-failed',
      };
    }
    this.absorb(response);
    const text = await response.text();
    let body = null;
    if (text !== '') {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    this.transcript.push({ label: `${method} ${path}`, text, body });
    return {
      ok: response.ok,
      status: response.status,
      body,
      text,
      elapsedMs: performance.now() - startedAt,
      transportError: null,
    };
  }

  /**
   * Creates the guest identity.
   *
   * The GET comes first and that is load-bearing: `POST /auth/guest` is mutating, so the CSRF
   * hook demands both the header and the matching secret cookie, and both come from
   * `GET /auth/session`, which is exempt. POSTing first is rejected `csrf_failed` every time.
   */
  async createGuest() {
    const seed = await this.request(ROUTES.session);
    this.csrfToken = seed.body?.csrfToken ?? null;
    if (this.csrfToken === null) {
      throw new Error(`no CSRF token from GET ${ROUTES.session} (status ${seed.status})`);
    }
    const created = await this.request(ROUTES.guest, {
      method: 'POST',
      body: { displayName: this.name },
    });
    if (!created.ok) {
      throw new Error(`POST ${ROUTES.guest} -> ${created.status} ${created.text.slice(0, 200)}`);
    }
    this.csrfToken = created.body?.csrfToken ?? this.csrfToken;
    this.userId = created.body?.user?.id ?? null;
    if (this.userId === null) throw new Error('the guest response carried no user id');
    return this;
  }
}

/**
 * One WebSocket client at a table, keeping every frame it was sent.
 *
 * Node's global `WebSocket` accepts a non-standard options bag as its SECOND argument and
 * forwards those headers on the upgrade — which is the only way to send the session cookie,
 * without which every socket here would be refused 4401. Passing it third silently does
 * nothing.
 */
export class TableClient {
  constructor(session, roomId, options = {}) {
    this.session = session;
    this.roomId = roomId;
    this.wsPath = options.wsPath ?? ROUTES.ws;
    this.socket = null;
    this.welcomed = false;
    this.closed = false;
    this.closeCode = null;
    this.closeReason = '';
    /** Every frame, raw and parsed, in arrival order. This is the leak-scan corpus. */
    this.frames = [];
    /** Views in arrival order, for the chip ledger. */
    this.views = [];
    this.errors = [];
    this.events = [];
    this.acks = [];
    this.seat = null;
    this.lastView = null;
  }

  url() {
    const url = new URL(this.wsPath, this.session.origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.toString();
  }

  /**
   * Opens the socket and completes the handshake.
   *
   * `expectWelcome: false` is for the drills that expect to be refused: they still want the
   * close code, and waiting for a welcome that will never arrive would just be a timeout.
   */
  connect(options = {}) {
    const expectWelcome = options.expectWelcome ?? true;
    const protocolVersion = options.protocolVersion ?? WS_PROTOCOL_VERSION;
    return new Promise((done, fail) => {
      let settled = false;
      const socket = new WebSocket(this.url(), {
        headers: { cookie: this.session.cookieHeader(), origin: this.session.webOrigin },
      });
      this.socket = socket;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        fail(new Error('the socket neither opened nor closed within 15s'));
      }, 15_000);
      timer.unref();

      socket.addEventListener('open', () => {
        if (options.sendHello === false) {
          if (!settled && !expectWelcome) {
            settled = true;
            clearTimeout(timer);
            done(this);
          }
          return;
        }
        this.send({
          type: 'hello',
          protocolVersion,
          roomId: this.roomId,
          clientNonce: randomUUID(),
        });
      });

      socket.addEventListener('message', (message) => {
        const text = typeof message.data === 'string' ? message.data : String(message.data);
        let frame = null;
        try {
          frame = JSON.parse(text);
        } catch {
          frame = null;
        }
        this.frames.push({ text, frame });
        this.absorb(frame);
        if (!settled && frame?.type === 'welcome') {
          settled = true;
          clearTimeout(timer);
          done(this);
        }
      });

      socket.addEventListener('error', () => {
        // Deliberately empty of detail: the event carries none by design, and the close frame
        // that follows is where the reason is.
      });

      socket.addEventListener('close', (event) => {
        this.closed = true;
        this.closeCode = event.code;
        this.closeReason = event.reason ?? '';
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (expectWelcome) {
          fail(new Error(`closed with ${event.code} before welcome`));
          return;
        }
        done(this);
      });
    });
  }

  absorb(frame) {
    if (frame === null || typeof frame !== 'object') return;
    switch (frame.type) {
      case 'welcome':
        this.welcomed = true;
        this.seat = frame.seat ?? null;
        return;
      case 'state':
        this.lastView = frame.view ?? null;
        this.views.push({ label: `state r${String(frame.revision)}`, view: frame.view ?? null });
        return;
      case 'event':
        this.events.push(frame.event);
        return;
      case 'ack':
        this.acks.push(frame);
        return;
      case 'error':
        this.errors.push(frame.error);
        return;
      default:
    }
  }

  send(message) {
    if (this.socket === null || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  /** Raw bytes or text, for the malformed-traffic drill. Bypasses JSON entirely. */
  sendRaw(payload) {
    if (this.socket === null || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(payload);
    return true;
  }

  /**
   * Waits for a frame matching a predicate, or null on expiry.
   *
   * `from` is the index in `frames` to start looking at, and it is not an optimisation. The scan
   * begins at the start of the whole transcript by default, so calling this twice with the same
   * predicate returns the SAME frame twice — which is how the out-of-order drill quietly re-read
   * a decision it had already acted on, submitted against a spot that had moved on, and was
   * answered `not_your_turn` instead of the `stale_action_sequence` it was written to prove. A
   * caller that wants the NEXT match must record `client.frames.length` first and pass it here.
   */
  async waitForFrame(predicate, budgetMs = 10_000, from = 0) {
    const startedAt = performance.now();
    let index = from;
    for (;;) {
      while (index < this.frames.length) {
        const entry = this.frames[index];
        index += 1;
        if (entry.frame !== null && predicate(entry.frame)) return entry.frame;
      }
      if (this.closed) return null;
      if (performance.now() - startedAt > budgetMs) return null;
      await sleep(20);
    }
  }

  /** Waits until the socket is closed, returning the close code or null on expiry. */
  async waitForClose(budgetMs = 10_000) {
    const startedAt = performance.now();
    while (!this.closed) {
      if (performance.now() - startedAt > budgetMs) return null;
      await sleep(20);
    }
    return this.closeCode;
  }

  /**
   * Waits until it is this client's turn to act, returning the view or null.
   *
   * `view.legalActions` is empty in every frame that is not this seat's decision, which makes
   * "is it my turn" and "what may I do" the same question with one answer from one authority.
   * `from` is the transcript index to look forward from; see `waitForFrame`.
   */
  async waitForTurn(budgetMs = 20_000, from = 0) {
    const frame = await this.waitForFrame(
      (f) =>
        f.type === 'state' &&
        f.view !== null &&
        f.view !== undefined &&
        Array.isArray(f.view.legalActions) &&
        f.view.legalActions.length > 0 &&
        f.view.toAct !== null &&
        f.view.toAct === f.view.viewerSeat,
      budgetMs,
      from,
    );
    return frame?.view ?? null;
  }

  close(code = 1000, reason = 'drill complete') {
    if (this.socket === null) return;
    const { readyState } = this.socket;
    if (readyState === WebSocket.OPEN || readyState === WebSocket.CONNECTING) {
      this.socket.close(code, reason);
    }
  }

  /** Drops the TCP connection without a close handshake, the way a lost network does. */
  terminate() {
    // Node's WebSocket has no `terminate`, so the abrupt path is a close with a code the server
    // will not have sent a handshake for. `close(1006)` is refused by the API (reserved), so the
    // socket is closed with 4000, which no server code path uses, and the drill asserts on what
    // the SERVER does next rather than on the code the client chose.
    if (this.socket !== null && this.socket.readyState === WebSocket.OPEN) this.socket.close(4000, 'gone');
  }
}

// ---------------------------------------------------------------------------
// Table setup, shared by every drill that needs a live hand
// ---------------------------------------------------------------------------

/**
 * A two-seat table: the caller in seat 0, one bot in seat 1, connected and seated.
 *
 * A bot opponent rather than a second human client, for one reason that matters to the drills:
 * a bot acts on its own, so a hand keeps moving while the harness is busy killing something.
 * A table of two synthetic humans stalls the moment the harness stops driving it, and a stalled
 * hand is not a hand in progress.
 *
 * `actionTimeoutSeconds` is the server's own turn clock, left at a value long enough that no
 * drill's failure window can be mistaken for a seat timing out.
 */
export async function seatWithBot(session, options = {}) {
  const created = await session.request(ROUTES.rooms, {
    method: 'POST',
    body: {
      name: options.name ?? 'Reliability drill',
      maxSeats: 2,
      smallBlind: 1,
      bigBlind: 2,
      startingStack: options.startingStack ?? 200,
      actionTimeoutSeconds: options.actionTimeoutSeconds ?? 60,
      bots: [{ profile: options.botProfile ?? 'calling-station', count: 1 }],
    },
  });
  if (!created.ok) {
    throw new Error(`POST ${ROUTES.rooms} -> ${created.status} ${created.text.slice(0, 200)}`);
  }
  const roomId = created.body?.room?.id;
  if (typeof roomId !== 'string') throw new Error('room creation returned no room id');

  const client = new TableClient(session, roomId);
  await client.connect();
  const requestId = randomUUID();
  client.send({ type: 'sit', seat: 0, requestId });
  const ack = await client.waitForFrame((f) => f.type === 'ack' && f.requestId === requestId, 10_000);
  if (ack === null) throw new Error('the server never acknowledged the sit');
  return { roomId, client, inviteCode: created.body?.inviteCode ?? null };
}

/** Asks the owner's table to deal, and waits until the hand is under way. */
export async function dealHand(client, budgetMs = 15_000) {
  const requestId = randomUUID();
  client.send({ type: 'startHand', requestId });
  const started = await client.waitForFrame(
    (f) => f.type === 'event' && f.event?.kind === 'handStarted',
    budgetMs,
  );
  if (started === null) return null;
  return started.event;
}

/**
 * Plays one legal action from a view, the way `load-test.mjs` does: never a guessed action.
 *
 * `expectedSequence` is copied from the view being responded to and `actionId` is fresh, so
 * the two pieces of the protocol's anti-race machinery are exercised rather than bypassed.
 * Returns the identifiers so a drill can replay exactly the same action — which is what the
 * duplicate and out-of-order drills do.
 */
export function actOn(client, view, choose = passive) {
  const action = choose(view.legalActions);
  const requestId = randomUUID();
  const actionId = randomUUID();
  client.send({
    type: 'action',
    actionId,
    expectedSequence: view.actionSequence,
    action,
    requestId,
  });
  return { requestId, actionId, expectedSequence: view.actionSequence, action };
}

/** Check if it is free, otherwise call, otherwise fold. Chosen to keep hands going. */
export function passive(legal) {
  const byType = new Map(legal.map((entry) => [entry.type, entry]));
  if (byType.has('check')) return { type: 'check' };
  if (byType.has('call')) return { type: 'call' };
  if (byType.has('fold')) return { type: 'fold' };
  const first = legal[0];
  if (first.type === 'bet' || first.type === 'raise') return { type: first.type, to: Number(first.minTo) };
  return { type: first.type };
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/** Fetches the exposition text, or null when the scrape was refused. */
export async function scrapeMetrics(origin, token) {
  const response = await fetch(new URL(ROUTES.metrics, origin), {
    headers: token === null || token === '' ? {} : { authorization: `Bearer ${token}` },
  });
  if (!response.ok) return null;
  return response.text();
}

/**
 * One sample from the exposition text.
 *
 * Deliberately a plain scan rather than a parser: the drills need three numbers out of this
 * format and a full Prometheus parser in a harness is a second implementation of something the
 * API already has tests for. Returns null when the series is absent, which several drills
 * distinguish from zero — a metric that is never fed and a metric that is zero look identical
 * on a graph and mean completely different things.
 */
export function metricValue(text, series) {
  if (text === null) return null;
  for (const line of text.split('\n')) {
    if (line.startsWith('#')) continue;
    const trimmed = line.trim();
    if (!trimmed.startsWith(series)) continue;
    const rest = trimmed.slice(series.length);
    // Either the series name is followed by whitespace (no labels) or by the exact label set
    // the caller included in `series`. Anything else is a different series with a shared prefix.
    if (rest.length > 0 && !/^\s/.test(rest)) continue;
    const value = Number(rest.trim());
    return Number.isFinite(value) ? value : null;
  }
  return null;
}

/**
 * The count in a histogram bucket, by upper bound.
 *
 * Buckets are cumulative in this format, so "how many probes took longer than 50 ms" is
 * `_count` minus the `le="0.05"` bucket. That subtraction is the saturation signal the pool
 * drill asserts on, and doing it here keeps the drill readable.
 */
export function histogramBucket(text, name, upperBound) {
  return metricValue(text, `${name}_bucket{le="${upperBound}"}`);
}

/**
 * The shape every drill returns.
 *
 * Deliberately a bag of arrays rather than a class with methods: a drill collects evidence in
 * whatever order it happens and the runner formats it, and anything cleverer would tempt a
 * drill into deciding its own verdict. `failures` non-empty is the only thing that fails a
 * drill, and `skipped` non-null is the only thing that makes it a skip — which the runner
 * treats as a failure unless the caller excluded the drill by name.
 */
export function newReport() {
  return {
    observations: [],
    failures: [],
    warnings: [],
    /** Real quoted lines from a real log, so the report is the system's own words. */
    evidence: [],
    /** Named numbers, printed in the summary: recovery bounds, exit codes, elapsed times. */
    measurements: {},
    skipped: null,
  };
}

/**
 * Plays one hand to its `handComplete` event, acting only on decision points the server offers.
 *
 * The `handId:actionSequence` key is not decoration. `actionSequence` restarts at zero for every
 * deal, so a bare sequence number matches the first decision of the NEXT hand as well — which
 * reads as "already acted", the seat never acts, and the drill sits there until the turn clock
 * folds it. `load-test.mjs` found that exact bug and this is the same guard.
 *
 * Returns whether the hand completed, so a drill can distinguish "the table stalled" from "the
 * table played on", which is the difference between a recovered process and a hung one.
 */
export async function playHandToCompletion(client, options = {}) {
  const budgetMs = options.budgetMs ?? 40_000;
  const choose = options.choose ?? passive;
  const from = client.events.length;
  const deadline = performance.now() + budgetMs;
  let lastActedKey = null;
  let actions = 0;

  while (performance.now() < deadline) {
    if (client.events.slice(from).some((event) => event?.kind === 'handComplete')) {
      return { completed: true, actions };
    }
    if (client.closed) {
      // The close code is the whole diagnosis — 4429 is a rate limit, 4503 a shutdown, 1006 a
      // dropped connection — and a drill that reported only "the socket closed" sent whoever read
      // it back to the server log to find out which.
      return { completed: false, actions, reason: `the socket closed with ${String(client.closeCode)}` };
    }
    const view = client.lastView;
    const legal = Array.isArray(view?.legalActions) ? view.legalActions : [];
    if (legal.length > 0 && view.toAct !== null && view.toAct === view.viewerSeat) {
      const key = `${String(view.handId)}:${String(view.actionSequence)}`;
      if (key !== lastActedKey) {
        lastActedKey = key;
        actOn(client, view, choose);
        actions += 1;
      }
    }
    await sleep(25);
  }
  return { completed: false, actions, reason: 'the hand did not complete inside its budget' };
}

/** Every event of one kind this client has seen since an index. */
export function eventsSince(client, index, kind) {
  return client.events.slice(index).filter((event) => event?.kind === kind);
}

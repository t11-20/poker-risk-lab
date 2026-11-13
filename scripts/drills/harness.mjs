/**
 * Shared machinery for `scripts/reliability-drills.mjs`: a spawned real API, a real Postgres, and a
 * real HTTP and WebSocket client. Only node: builtins, and SQL goes through `docker exec psql`, so
 * a defect in the application's driver cannot also break the harness. It makes no assertions;
 * `invariants.mjs` judges the evidence it returns.
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

/** Must match `WS_PROTOCOL_VERSION` in @prl/contracts. */
export const WS_PROTOCOL_VERSION = 1;

/**
 * Copied, not imported, so the harness does not depend on a build. `reliability-drills.test.mjs`
 * cross-checks every path against `apps/api/test/wiring.test.ts`.
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

/** Returns elapsed ms, or `null` on expiry so the drill can still clean up and report it. */
export async function measureUntil(predicate, budgetMs, pollMs = 50) {
  const startedAt = performance.now();
  const deadline = startedAt + budgetMs;
  for (;;) {
    let held = false;
    try {
      held = await predicate();
    } catch {
      // During an outage every probe fails with ECONNREFUSED for a while.
      held = false;
    }
    if (held) return performance.now() - startedAt;
    if (performance.now() >= deadline) return null;
    await sleep(pollMs);
  }
}

/** `config.ts` refuses `PORT=0`, so the port is chosen here. A collision is a loud EADDRINUSE. */
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

/** Never throws on a non-zero exit, because several drills run commands that must fail. */
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

/** The password is decoded from percent-encoding and never logged or put in argv. */
export function parseDsn(dsn) {
  const url = new URL(dsn);
  return {
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    host: url.hostname,
    port: url.port === '' ? '5432' : url.port,
    database: url.pathname.replace(/^\//, ''),
    withDatabase(name) {
      const next = new URL(dsn);
      next.pathname = `/${name}`;
      return next.toString();
    },
  };
}

/**
 * `-e PGPASSWORD` with no `=value` makes Docker forward the variable from this process's
 * environment. The password in argv would be readable by every user via `/proc/<pid>/cmdline`.
 * Exported so `reliability-drills.test.mjs` can assert no argv element contains it.
 */
export function psqlCommand(container, dsn, database, sql) {
  const parts = parseDsn(dsn);
  return {
    command: 'docker',
    args: [
      'exec',
      // Bare on purpose. Adding `=${parts.password}` puts the password in argv.
      '-e',
      'PGPASSWORD',
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
    ],
    env: { PGPASSWORD: parts.password },
  };
}

/** `-tAc` gives bare tab-separated values, and `ON_ERROR_STOP=1` makes a failing statement exit non-zero. */
export function psql(container, dsn, database, sql) {
  const { command, args, env } = psqlCommand(container, dsn, database, sql);
  return run(command, args, { env });
}

/**
 * Every drill uses a database made here, never the developer's. `create database` cannot be
 * parameterised, so the generated name is checked against a strict pattern.
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

/** Never rejects, because this runs on the cleanup path. */
export function dropScratchDatabase(container, dsn, name) {
  if (!/^prl_drills_[a-z0-9_]{1,40}$/.test(name)) {
    return Promise.resolve({ code: 1, stdout: '', stderr: 'refused' });
  }
  return psql(container, dsn, 'postgres', `drop database if exists ${name} with (force)`);
}

export function migrate(dsn, command = 'up') {
  return run(process.execPath, [MIGRATE_SCRIPT, command], { env: { DATABASE_URL: dsn } });
}

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

/**
 * `NODE_ENV=development` because `logging.ts` silences the logger under `test`, and the log is
 * evidence. Values passed here beat `.env`, since `--env-file` never overrides a set variable.
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
      // Raised, not disabled, so drills that open many sessions pass and `malformed-ws-traffic`
      // still has a limiter to trip.
      RATE_LIMIT_MAX: options.rateLimitMax ?? '5000',
      RATE_LIMIT_GUEST_MAX: options.guestRateLimitMax ?? '2000',
      RATE_LIMIT_EXPENSIVE_MAX: options.expensiveRateLimitMax ?? '2000',
      METRICS_TOKEN: options.metricsToken ?? '',
      ...(options.env ?? {}),
    },
    // Leads its own process group so `stop()` can signal the whole tree.
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

  /** Safe to call twice, and on a process that has already gone. */
  const stop = async () => {
    if (exited !== null) return exited;
    try {
      return await signalAndWait(child, 'SIGKILL', 5_000, () => text);
    } catch {
      return exited;
    }
  };

  // Handed over before the 30 s wait can reject, because a rejection carries no pid and a detached
  // child would survive the run holding a port.
  options.onSpawn?.({ child, stop, output: () => text });

  let listeningPort;
  try {
    listeningPort = await new Promise((done, fail) => {
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
  } catch (error) {
    // Kill before rethrowing so no path out of `startServer` leaves a process. `stop()` is idempotent.
    await stop().catch(() => {
      // Keep the original start error.
    });
    throw error;
  }

  return {
    child,
    port: listeningPort,
    graceMs,
    output: () => text,
    exited: () => exited,
    origin: `http://127.0.0.1:${listeningPort}`,
    signal: (name) => signalAndWait(child, name, graceMs * 4, () => text),
    stop,
  };
}

/** Signals the process group (negative pid). ESRCH means it already exited, which is the goal. */
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

/**
 * One guest identity that keeps every response body, including error bodies served during an
 * outage, for the leak scan. The cookie jar ignores Domain, Path, Expires and Secure.
 */
export class Session {
  constructor(origin, webOrigin, name) {
    this.origin = origin;
    this.webOrigin = webOrigin;
    this.name = name;
    this.cookies = new Map();
    this.csrfToken = null;
    this.userId = null;
    this.transcript = [];
  }

  cookieHeader() {
    return [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; ');
  }

  absorb(response) {
    // `get('set-cookie')` comma-joins cookies, and cookie attributes may contain commas.
    for (const raw of response.headers.getSetCookie()) {
      const pair = raw.split(';', 1)[0] ?? '';
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  /** Never throws for a non-2xx, because a drill usually wants the 503. */
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

  /** `GET /auth/session` first: it issues the CSRF cookie and token that `POST /auth/guest` requires. */
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
 * Node's `WebSocket` takes a non-standard options bag as its SECOND argument and sends its headers
 * on the upgrade. That is how the session cookie travels. Passed third, it is silently ignored.
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
    /** The leak-scan corpus. */
    this.frames = [];
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

  /** `expectWelcome: false` is for drills that expect to be refused and want the close code. */
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
        // The event carries no detail. The close frame has the reason.
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

  sendRaw(payload) {
    if (this.socket === null || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(payload);
    return true;
  }

  /**
   * Returns the first match at or after `from`. To get the NEXT match, pass `client.frames.length`
   * recorded beforehand, or a repeat call returns the same frame again.
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

  async waitForClose(budgetMs = 10_000) {
    const startedAt = performance.now();
    while (!this.closed) {
      if (performance.now() - startedAt > budgetMs) return null;
      await sleep(20);
    }
    return this.closeCode;
  }

  /** `view.legalActions` is non-empty only on this seat's decision. */
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

  terminate() {
    // Node's WebSocket has no `terminate`, and the API refuses 1006, so 4000 stands in. Drills
    // assert on what the server does next.
    if (this.socket !== null && this.socket.readyState === WebSocket.OPEN) this.socket.close(4000, 'gone');
  }
}

/**
 * Seat 0 for the caller and one bot, because a bot keeps the hand moving while the harness is busy
 * breaking something.
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

/** Copies `expectedSequence` and uses a fresh `actionId`, and returns both so a drill can replay. */
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

/** Check, else call, else fold, to keep hands going. */
export function passive(legal) {
  const byType = new Map(legal.map((entry) => [entry.type, entry]));
  if (byType.has('check')) return { type: 'check' };
  if (byType.has('call')) return { type: 'call' };
  if (byType.has('fold')) return { type: 'fold' };
  const first = legal[0];
  if (first.type === 'bet' || first.type === 'raise') return { type: first.type, to: Number(first.minTo) };
  return { type: first.type };
}

export async function scrapeMetrics(origin, token) {
  const response = await fetch(new URL(ROUTES.metrics, origin), {
    headers: token === null || token === '' ? {} : { authorization: `Bearer ${token}` },
  });
  if (!response.ok) return null;
  return response.text();
}

/** Returns null for an absent series, which drills distinguish from zero. */
export function metricValue(text, series) {
  if (text === null) return null;
  for (const line of text.split('\n')) {
    if (line.startsWith('#')) continue;
    const trimmed = line.trim();
    if (!trimmed.startsWith(series)) continue;
    const rest = trimmed.slice(series.length);
    // Only whitespace or the exact label set may follow, else it is another series with this prefix.
    if (rest.length > 0 && !/^\s/.test(rest)) continue;
    const value = Number(rest.trim());
    return Number.isFinite(value) ? value : null;
  }
  return null;
}

/** Buckets are cumulative, so "slower than 50 ms" is `_count` minus `le="0.05"`. */
export function histogramBucket(text, name, upperBound) {
  return metricValue(text, `${name}_bucket{le="${upperBound}"}`);
}

/** `failures` non-empty fails a drill. `skipped` non-null skips it, which fails unless excluded by name. */
export function newReport() {
  return {
    observations: [],
    failures: [],
    warnings: [],
    evidence: [],
    measurements: {},
    skipped: null,
  };
}

/**
 * `actionSequence` restarts at zero each deal, so the key includes `handId`. A bare sequence
 * matched the next hand's first decision and the seat never acted.
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
      // 4429 is a rate limit, 4503 a shutdown, 1006 a dropped connection.
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

export function eventsSince(client, index, kind) {
  return client.events.slice(index).filter((event) => event?.kind === kind);
}

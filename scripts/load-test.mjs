#!/usr/bin/env node
/**
 * A dependency-free load harness for the live-table path: REST session creation,
 * room creation and joining, WebSocket connect, sit, and then real hands driven by
 * real actions.
 *
 * This is what `pnpm run test:load` does.
 *
 * ## READ THIS BEFORE QUOTING ANY NUMBER FROM IT
 *
 * This measures ONE Node process on the same machine as the load generator, over
 * loopback, against a development database, with no proxy, no TLS termination, no
 * other tenants, and no network. It tells you whether a change made the server
 * meaningfully slower or introduced errors under concurrency. It does NOT tell you
 * how many players the app can host. Capacity numbers require a real deployment,
 * real network latency, a database with real data volume, and a load generator
 * that is not competing with the server for CPU. Any sentence of the form "we
 * measured N concurrent players" that traces back to this script is wrong.
 *
 * ## The clients never guess an action
 *
 * The server sends `legalActions` in every `state` frame where it is that seat's
 * turn, with exact bounds (`minTo`, `maxTo`). This harness picks one of those
 * entries and, for a bet or a raise, sends `minTo` clamped into `[minTo, maxTo]`.
 * It never constructs an action from its own model of the rules. That is not
 * politeness: a load test that guesses actions spends its time measuring the
 * server's rejection path and reports a latency figure for a request that was
 * never valid, while the interesting path goes untested.
 *
 * Likewise `expectedSequence` is copied from the `view.actionSequence` the client
 * is responding to, and `actionId` is unique per attempt, so a retry cannot
 * double-apply. Both are the protocol's own anti-race machinery (see
 * @prl/contracts ws-protocol.ts) and using them properly is part of what is being
 * exercised.
 *
 * ## Randomness
 *
 * Which legal action a synthetic client takes is chosen by a small seeded PRNG
 * (mulberry32), not by Math.random and not by a CSPRNG. Two deliberate reasons:
 * a load run has to be repeatable to be comparable, so `--seed` must produce the
 * same decision sequence twice; and this choice has nothing to do with fairness or
 * secrecy, because the server deals every card from its own CSPRNG and this side
 * of the wire cannot influence any outcome. The repo's ban on Math.random is about
 * anything that could touch a game outcome — this cannot, and it still is not
 * Math.random, because reproducibility is worth more here than entropy.
 *
 * ## Two things that are easy to get wrong and are handled here
 *
 * 1. **The WebSocket handshake needs the session cookie.** The standard
 *    `WebSocket` constructor takes only (url, protocols) and has no way to set a
 *    header, which would make every socket here fail the upgrade with close code
 *    4401. Node's implementation accepts a non-standard options bag as the SECOND
 *    argument — `new WebSocket(url, { headers })` — and forwards those headers on
 *    the upgrade request. Passing it as a third argument silently does nothing,
 *    which is a fun half hour. Verified on Node 24.18.0.
 *
 * 2. **`fetch` has no cookie jar.** Every session here keeps its own tiny jar,
 *    populated from `response.headers.getSetCookie()` — the plural accessor,
 *    because `get('set-cookie')` folds multiple cookies into one comma-joined
 *    string that cannot be reliably split (expiry dates contain commas).
 *
 * ## Routes
 *
 * The REST paths and the WebSocket path are configurable, and the defaults are
 * listed in `ROUTES` below. If the API moves an endpoint, pass the flag rather
 * than editing this file in a way that hides the mismatch.
 */

import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const NO_COLOR = process.env.NO_COLOR !== undefined || !process.stdout.isTTY;
const paint = (code, s) => (NO_COLOR ? s : `\u001b[${code}m${s}\u001b[0m`);
const dim = (s) => paint('2', s);
const bold = (s) => paint('1', s);
const red = (s) => paint('31', s);
const green = (s) => paint('32', s);
const yellow = (s) => paint('33', s);

/** Protocol version this harness speaks. Must match WS_PROTOCOL_VERSION. */
const WS_PROTOCOL_VERSION = 1;

/**
 * The endpoints, as the server actually registers them.
 *
 * ## These were wrong from the first commit, and the harness had never once run
 *
 * `guest` was `/api/v1/session/guest`, `session` was `/api/v1/session`, and joining was
 * `POST /api/v1/rooms/:roomId/join`. None of the three exists. The real ones are
 * `POST /auth/guest` (routes/auth.ts:382), `GET /auth/session` (auth.ts:400) and
 * `POST /rooms/join` with the invite code in the BODY (rooms.ts:278). The mistake never
 * surfaced as a 404 because every unrouted path answers `content_not_found`, and the
 * first call was a POST, so the CSRF hook refused it before routing and the error read
 * `csrf_failed` — which looks like a client problem and is why this survived so long.
 *
 * `apps/api/test/wiring.test.ts` maintains the route manifest, and
 * `scripts/load-test.routes.test.mjs` now cross-checks every path below against it, so a
 * future rename breaks a test rather than this harness in silence.
 */
const ROUTES = {
  health: '/api/v1/health',
  guest: '/api/v1/auth/guest',
  session: '/api/v1/auth/session',
  rooms: '/api/v1/rooms',
  joinRoom: '/api/v1/rooms/join',
  ws: '/api/v1/ws',
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Defaults are deliberately tiny: three sockets, one table, five hands. Someone
 * who runs `pnpm run test:load` to see what it does should get an answer in a few
 * seconds, not a hot laptop. Every number below is printed before the run starts,
 * so what was measured is never in doubt.
 */
const DEFAULTS = {
  baseUrl: process.env.PRL_API_ORIGIN ?? 'http://127.0.0.1:3001',
  /**
   * Must match an entry in the server's `PUBLIC_WEB_ORIGIN` allowlist, which is compared as an
   * exact string — `http://127.0.0.1:3000` and `http://localhost:3000` are different origins to
   * it, and the shipped `.env.example` ships the latter. The old default was the former, so even
   * after the routes were right every mutating request would have been refused `forbidden`.
   */
  origin: process.env.PUBLIC_WEB_ORIGIN ?? 'http://localhost:3000',
  wsPath: ROUTES.ws,
  tables: 1,
  /** Seats filled per table. The schema caps a room at 6 (db/migrations). */
  seats: 3,
  /** Hands to complete per table before the run stops. */
  hands: 5,
  smallBlind: 1,
  bigBlind: 2,
  startingStack: 200,
  actionTimeoutSeconds: 15,
  seed: 1,
  /** Whole-run budget. The run fails if it has not finished by then. */
  timeoutSeconds: 120,
  // --- pass/fail thresholds ---
  maxErrorRate: 0.01,
  maxP99Ms: 250,
};

const HELP = `
${bold('pnpm run test:load')} — drive real hands against a local API and measure it

  ${yellow('This measures a local dev server. It is not a capacity measurement.')}
  See the header of scripts/load-test.mjs for why that distinction matters.

  Connection
    --base-url <url>       API origin                      (default ${DEFAULTS.baseUrl})
    --origin <url>         Origin header sent on the WS upgrade and REST calls
                                                           (default ${DEFAULTS.origin})
    --ws-path <path>       WebSocket path                  (default ${DEFAULTS.wsPath})

  Load shape
    --tables <n>           tables to run in parallel       (default ${DEFAULTS.tables})
    --seats <n>            seats filled per table, 2-6     (default ${DEFAULTS.seats})
    --hands <n>            hands to complete per table     (default ${DEFAULTS.hands})
    --timeout <secs>       whole-run budget                (default ${DEFAULTS.timeoutSeconds})

  Table setup
    --small-blind <n>                                      (default ${DEFAULTS.smallBlind})
    --big-blind <n>                                        (default ${DEFAULTS.bigBlind})
    --starting-stack <n>                                   (default ${DEFAULTS.startingStack})
    --action-timeout <secs> server-side turn clock          (default ${DEFAULTS.actionTimeoutSeconds})
    --seed <n>             seeds the action policy         (default ${DEFAULTS.seed})

  Thresholds (exceeding either exits non-zero, so this can gate CI)
    --max-error-rate <r>   errors / operations, 0-1         (default ${DEFAULTS.maxErrorRate})
    --max-p99-ms <ms>      action round-trip p99            (default ${DEFAULTS.maxP99Ms})

    --json                 also print the report as one JSON object
    -h, --help             this text

  Total sockets opened = tables x seats. Each seat is its own guest session, so
  the per-session socket cap (WS_LIMITS.maxSocketsPerSession) is never the limit.
`;

function parseArgs(argv) {
  const options = { ...DEFAULTS, json: false, help: false };
  const numeric = new Map([
    ['--tables', 'tables'],
    ['--seats', 'seats'],
    ['--hands', 'hands'],
    ['--timeout', 'timeoutSeconds'],
    ['--small-blind', 'smallBlind'],
    ['--big-blind', 'bigBlind'],
    ['--starting-stack', 'startingStack'],
    ['--action-timeout', 'actionTimeoutSeconds'],
    ['--seed', 'seed'],
    ['--max-error-rate', 'maxErrorRate'],
    ['--max-p99-ms', 'maxP99Ms'],
  ]);
  const strings = new Map([
    ['--base-url', 'baseUrl'],
    ['--origin', 'origin'],
    ['--ws-path', 'wsPath'],
  ]);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // `pnpm run test:load -- --tables 2` forwards the `--` itself, so absorb it
    // rather than rejecting the conventional invocation as an unknown option.
    if (arg === '--') continue;
    if (arg === '-h' || arg === '--help') {
      options.help = true;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    const value = argv[i + 1];
    if (numeric.has(arg)) {
      if (value === undefined) throw new Error(`${arg} needs a value`);
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) throw new Error(`${arg} needs a number, got "${value}"`);
      options[numeric.get(arg)] = parsed;
      i += 1;
      continue;
    }
    if (strings.has(arg)) {
      if (value === undefined) throw new Error(`${arg} needs a value`);
      options[strings.get(arg)] = value;
      i += 1;
      continue;
    }
    throw new Error(`unknown option ${arg} (try --help)`);
  }

  // Validation, with the reason rather than just "invalid". The seat bound is the
  // database's: rooms.max_seats has a CHECK BETWEEN 2 AND 6.
  if (!Number.isInteger(options.seats) || options.seats < 2 || options.seats > 6) {
    throw new Error('--seats must be an integer from 2 to 6 (rooms.max_seats CHECK)');
  }
  if (!Number.isInteger(options.tables) || options.tables < 1) {
    throw new Error('--tables must be a positive integer');
  }
  if (!Number.isInteger(options.hands) || options.hands < 1) {
    throw new Error('--hands must be a positive integer');
  }
  if (options.bigBlind <= options.smallBlind) {
    throw new Error('--big-blind must exceed --small-blind (rooms CHECK constraint)');
  }
  if (options.startingStack < options.bigBlind * 2) {
    throw new Error('--starting-stack must be at least twice --big-blind (rooms CHECK constraint)');
  }
  if (options.maxErrorRate < 0 || options.maxErrorRate > 1) {
    throw new Error('--max-error-rate is a fraction between 0 and 1');
  }
  return options;
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/**
 * Counters and latency samples.
 *
 * Latency is stored as every individual sample rather than as a running summary,
 * because you cannot compute a p99 from a mean and a count, and the sample count
 * here (thousands at most) makes the memory question irrelevant. If this is ever
 * pointed at a run large enough for that to matter, switch to a histogram with
 * fixed buckets — and say so in the report, because bucketed percentiles are
 * approximations and the report should not pretend otherwise.
 */
class Metrics {
  constructor() {
    this.connectionsAttempted = 0;
    this.connectionsEstablished = 0;
    this.sessionsCreated = 0;
    this.roomsCreated = 0;
    this.joins = 0;
    this.seated = 0;
    this.actionsSent = 0;
    this.actionsApplied = 0;
    this.handsCompleted = 0;
    this.serverMessages = 0;
    this.timeouts = 0;
    /** Latency samples in milliseconds, action send to matching ack. */
    this.actionLatencies = [];
    /** code -> count. Protocol error codes and synthetic transport ones. */
    this.errors = new Map();
    this.startedAt = null;
    this.finishedAt = null;
  }

  error(code) {
    this.errors.set(code, (this.errors.get(code) ?? 0) + 1);
  }

  get errorCount() {
    let total = 0;
    for (const count of this.errors.values()) total += count;
    return total;
  }

  /**
   * The denominator for the error rate: every operation that could have failed.
   * Deliberately explicit — an error rate whose denominator is unstated is a
   * number you can make say anything.
   */
  get operationCount() {
    return (
      this.sessionsCreated +
      this.roomsCreated +
      this.joins +
      this.connectionsAttempted +
      this.seated +
      this.actionsSent
    );
  }

  get errorRate() {
    const operations = this.operationCount + this.errorCount;
    return operations === 0 ? 0 : this.errorCount / operations;
  }
}

/**
 * Nearest-rank percentile: the smallest sample at or above the requested rank.
 *
 * No interpolation. Interpolated percentiles invent a latency that no request
 * actually experienced, which is exactly the wrong property for a tail metric.
 */
function percentile(sortedSamples, fraction) {
  if (sortedSamples.length === 0) return null;
  const rank = Math.ceil(fraction * sortedSamples.length);
  const index = Math.min(Math.max(rank, 1), sortedSamples.length) - 1;
  return sortedSamples[index];
}

// ---------------------------------------------------------------------------
// Seeded PRNG — see the module comment for why this is not Math.random
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// REST
// ---------------------------------------------------------------------------

/**
 * One guest identity: its cookie jar, its CSRF token, and its display name.
 *
 * The jar is a plain Map of name -> value. It ignores Domain, Path, Expires and
 * Secure, which is correct for a harness talking to exactly one origin for a few
 * seconds, and would be wrong for anything else.
 */
class Session {
  constructor(baseUrl, origin, name, metrics) {
    this.baseUrl = baseUrl;
    this.origin = origin;
    this.name = name;
    this.metrics = metrics;
    this.cookies = new Map();
    this.csrfToken = null;
    this.userId = null;
  }

  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  absorb(response) {
    // getSetCookie(), not get('set-cookie'): the singular accessor joins multiple
    // cookies with a comma, and cookie attributes legally contain commas
    // ("Expires=Wed, 21 Oct 2026 ..."), so splitting it back apart is guesswork.
    for (const raw of response.headers.getSetCookie()) {
      const pair = raw.split(';', 1)[0] ?? '';
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  /**
   * A request, with cookies, CSRF header and error accounting.
   *
   * Errors are classified into the protocol's own `error.code` where the server
   * gave one, and into `transport:*` buckets otherwise, so the report can
   * distinguish "the server said no" from "the server was not reachable".
   */
  async request(path, { method = 'GET', body } = {}) {
    const headers = { accept: 'application/json', origin: this.origin };
    const cookie = this.cookieHeader();
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    // Sent on every mutating request; paired with the SameSite=Strict cookie.
    if (this.csrfToken && method !== 'GET') headers['x-csrf-token'] = this.csrfToken;

    let response;
    try {
      response = await fetch(new URL(path, this.baseUrl), {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (err) {
      const code = typeof err?.cause?.code === 'string' ? err.cause.code : 'fetch-failed';
      this.metrics.error(`transport:${code}`);
      throw new Error(`${method} ${path} failed: ${err.message}`);
    }

    this.absorb(response);

    const text = await response.text();
    let payload = null;
    if (text.length > 0) {
      try {
        payload = JSON.parse(text);
      } catch {
        this.metrics.error('transport:non-json-response');
        throw new Error(`${method} ${path} returned ${response.status} with a non-JSON body`);
      }
    }

    if (!response.ok) {
      const code = payload?.error?.code ?? `http-${response.status}`;
      this.metrics.error(code);
      const message = payload?.error?.message ?? response.statusText;
      throw new Error(`${method} ${path} -> ${response.status} ${code}: ${message}`);
    }
    return payload;
  }

  /**
   * Creates the guest identity and captures the cookie and CSRF token.
   *
   * ## The GET comes first, and that is the whole point
   *
   * `POST /auth/guest` is a mutating request, so the CSRF hook demands the `x-csrf-token`
   * header AND the matching secret cookie. Both come from `GET /auth/session`, which is
   * exempt (GET changes nothing) and hands out a token to anyone. The original code POSTed
   * first, with `this.csrfToken` still null, and `request()` only attaches the header when a
   * token is already held — so the very first call of the run was rejected `csrf_failed`,
   * every time, and the fallback GET written to handle "a server that stops returning the
   * token" was never reached because the POST never returned at all. The comment there
   * anticipated the exact failure it caused.
   *
   * `scripts/smoke-test.mjs` already did it in this order; this is now the same sequence.
   */
  async createGuest() {
    const seed = await this.request(ROUTES.session);
    this.csrfToken = seed?.csrfToken ?? null;
    if (this.csrfToken === null) {
      throw new Error(`no CSRF token from GET ${ROUTES.session} — every mutation would be rejected`);
    }

    const created = await this.request(ROUTES.guest, {
      method: 'POST',
      body: { displayName: this.name },
    });
    // The guest response is a SessionResponse and carries a fresh token bound to the new
    // session cookie. Keep the seeded one if it ever stops doing so, rather than dropping to
    // null and failing every later request.
    this.csrfToken = created?.csrfToken ?? this.csrfToken;
    this.userId = created?.user?.id ?? null;
    if (this.userId === null) {
      throw new Error(`POST ${ROUTES.guest} returned no user id; the session is unusable`);
    }
    this.metrics.sessionsCreated += 1;
    return this;
  }
}

// ---------------------------------------------------------------------------
// One WebSocket client
// ---------------------------------------------------------------------------

class Client {
  constructor({ session, roomId, seat, options, metrics, random, onEvent }) {
    this.session = session;
    this.roomId = roomId;
    this.seat = seat;
    this.options = options;
    this.metrics = metrics;
    this.random = random;
    this.onEvent = onEvent;

    this.socket = null;
    this.welcomed = false;
    this.sat = false;
    this.closed = false;
    this.closeCode = null;
    /** requestId -> { sentAt, kind }, for round-trip measurement. */
    this.pending = new Map();
    /**
     * The last decision point acted on, as `handId:actionSequence`.
     *
     * The hand id has to be in the key. `actionSequence` is per-hand and starts
     * again at zero for every deal, so a bare sequence number matches the first
     * decision of the *next* hand as well — which reads as "already acted", the
     * seat never acts, the hand never advances, and the run sits there until the
     * turn clock times every seat out. Found exactly that way.
     */
    this.lastActedKey = null;
  }

  wsUrl() {
    const url = new URL(this.options.wsPath, this.options.baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.toString();
  }

  connect() {
    this.metrics.connectionsAttempted += 1;
    return new Promise((resolve, reject) => {
      let settled = false;
      // See the module comment: the options bag must be the SECOND argument, and
      // the cookie is how the server authenticates the upgrade. The Origin header
      // is checked too — a mismatch closes with WS_CLOSE.badOrigin (4406).
      const socket = new WebSocket(this.wsUrl(), {
        headers: {
          cookie: this.session.cookieHeader(),
          origin: this.options.origin,
        },
      });
      this.socket = socket;

      const fail = (reason, code) => {
        if (settled) return;
        settled = true;
        this.metrics.error(code);
        reject(new Error(reason));
      };

      socket.addEventListener('open', () => {
        this.metrics.connectionsEstablished += 1;
        // `hello` must be the first frame; a socket that does not send it within
        // WS_LIMITS.handshakeTimeoutMs is closed with 4408.
        this.send({
          type: 'hello',
          protocolVersion: WS_PROTOCOL_VERSION,
          roomId: this.roomId,
          clientNonce: randomUUID(),
        });
      });

      socket.addEventListener('message', (message) => {
        this.metrics.serverMessages += 1;
        let frame;
        try {
          frame = JSON.parse(typeof message.data === 'string' ? message.data : String(message.data));
        } catch {
          this.metrics.error('transport:unparseable-frame');
          return;
        }
        this.handle(frame);
        if (!settled && frame.type === 'welcome') {
          settled = true;
          resolve(this);
        }
      });

      socket.addEventListener('error', () => {
        // The event carries no useful detail by design (it would be a
        // cross-origin information leak in a browser), so the close frame that
        // follows is where the reason comes from.
        fail('websocket error before welcome', 'transport:ws-error');
      });

      socket.addEventListener('close', (event) => {
        this.closed = true;
        this.closeCode = event.code;
        if (event.code !== 1000 && event.code !== 1005) {
          this.metrics.error(`transport:close-${event.code}`);
        }
        // 4401 before welcome almost always means the cookie did not arrive on the
        // upgrade. Say so explicitly: the alternative is a wall of auth failures
        // with no hint that the cause is a header, not a credential.
        if (!this.welcomed && event.code === 4401) {
          fail(
            'closed 4401 (unauthenticated) before welcome — the session cookie did not reach ' +
              'the upgrade request. Node must support the non-standard WebSocket options bag; ' +
              'see the header of this script.',
            'transport:close-4401',
          );
          return;
        }
        fail(`closed before welcome with code ${event.code}`, `transport:close-${event.code}`);
      });
    });
  }

  send(message) {
    if (this.socket === null || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  handle(frame) {
    switch (frame.type) {
      case 'welcome':
        this.welcomed = true;
        return;
      case 'state':
        this.onState(frame);
        return;
      case 'ack':
        this.onAck(frame);
        return;
      case 'event':
        this.onEvent(frame.event, this);
        if (frame.event?.kind === 'seatTimedOut') this.metrics.timeouts += 1;
        return;
      case 'error': {
        const code = frame.error?.code ?? 'unknown';
        this.metrics.error(code);
        // Resolve the waiter so a failed request does not sit in `pending`
        // forever and quietly inflate nothing.
        if (frame.requestId) this.pending.delete(frame.requestId);
        return;
      }
      case 'coach':
      case 'pong':
        return;
      default:
        this.metrics.error(`transport:unknown-frame-${String(frame.type)}`);
    }
  }

  onAck(frame) {
    const waiting = this.pending.get(frame.requestId);
    if (waiting === undefined) return;
    this.pending.delete(frame.requestId);
    if (waiting.kind === 'action') {
      this.metrics.actionLatencies.push(performance.now() - waiting.sentAt);
      // A deduplicated ack means the server recognised a repeated actionId and
      // did NOT apply anything new, so counting it as applied would overstate
      // throughput.
      if (frame.deduplicated !== true) this.metrics.actionsApplied += 1;
    }
    if (waiting.kind === 'sit') {
      this.sat = true;
      this.metrics.seated += 1;
    }
  }

  sit() {
    const requestId = randomUUID();
    this.pending.set(requestId, { sentAt: performance.now(), kind: 'sit' });
    return this.send({ type: 'sit', seat: this.seat, requestId });
  }

  startHand() {
    const requestId = randomUUID();
    this.pending.set(requestId, { sentAt: performance.now(), kind: 'startHand' });
    return this.send({ type: 'startHand', requestId });
  }

  /**
   * Acts if and only if the server says it is this seat's turn and has supplied
   * the legal actions.
   *
   * `view.legalActions` is empty in every frame that is not this seat's decision,
   * which makes "is it my turn" and "what may I do" the same question with one
   * answer from one authority.
   */
  onState(frame) {
    const view = frame.view;
    if (view === null || view === undefined) return;
    const legal = Array.isArray(view.legalActions) ? view.legalActions : [];
    if (legal.length === 0) return;
    if (view.toAct === null || view.toAct !== view.viewerSeat) return;
    // The same decision point can arrive more than once (a reconnect, or a state
    // resend after an unrelated change). Acting twice on it would burn an actionId
    // and earn a stale_action_sequence for the second.
    const key = `${String(view.handId)}:${view.actionSequence}`;
    if (key === this.lastActedKey) return;
    this.lastActedKey = key;

    const chosen = this.choose(legal);
    const requestId = randomUUID();
    this.pending.set(requestId, { sentAt: performance.now(), kind: 'action' });
    this.metrics.actionsSent += 1;
    this.send({
      type: 'action',
      actionId: randomUUID(),
      expectedSequence: view.actionSequence,
      action: chosen,
      requestId,
    });
  }

  /**
   * Picks one of the offered legal actions and shapes it into a WsAction payload.
   *
   * The policy is biased hard towards passive play, because the purpose is to
   * complete hands: a table of maniacs ends most hands preflop with one all-in
   * and measures almost no postflop code. Aggression is included at a low rate so
   * that betting, raising and side-pot paths are exercised at all. Folding is
   * only ever chosen when there is something to fold to, and never when checking
   * is free — a fold with a free check available is legal but would just end hands
   * without playing them.
   *
   * `to` for a bet or raise is `minTo` clamped into the server's own
   * `[minTo, maxTo]`. Never a computed size: sizing rules are the server's.
   */
  choose(legal) {
    const byType = new Map(legal.map((action) => [action.type, action]));
    const roll = this.random();

    const aggressive = byType.get('raise') ?? byType.get('bet');
    if (aggressive !== undefined && roll < 0.15) {
      const min = Number(aggressive.minTo);
      const max = Number(aggressive.maxTo);
      if (Number.isFinite(min)) {
        const to = Number.isFinite(max) ? Math.min(min, max) : min;
        return { type: aggressive.type, to };
      }
    }

    const check = byType.get('check');
    if (check !== undefined) return { type: 'check' };

    const call = byType.get('call');
    if (call !== undefined && roll < 0.9) return { type: 'call' };

    const fold = byType.get('fold');
    if (fold !== undefined) return { type: 'fold' };

    // Nothing recognised. Fall back to the first thing the server offered rather
    // than inventing one; if it needs a size, use its own minimum.
    const first = legal[0];
    if (first.type === 'bet' || first.type === 'raise') {
      return { type: first.type, to: Number(first.minTo) };
    }
    return { type: first.type };
  }

  close() {
    if (this.socket === null) return;
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.close(1000, 'load test complete');
    }
  }
}

// ---------------------------------------------------------------------------
// A table: sessions, a room, sockets, and hands
// ---------------------------------------------------------------------------

/**
 * Runs one table to completion.
 *
 * The owner (seat 0) is the only client that sends `startHand`, because that is
 * what the protocol says: "Ask the owner's table to deal the next hand". Hand
 * completion is also counted from the owner's socket only — every seated client
 * receives the same `handComplete` event, so counting all of them would multiply
 * the hand count by the number of seats.
 */
async function runTable({ index, options, metrics, random, deadline }) {
  const sessions = [];
  for (let seat = 0; seat < options.seats; seat++) {
    const session = new Session(options.baseUrl, options.origin, `Load T${index}S${seat}`, metrics);
    sessions.push(await session.createGuest());
  }

  const owner = sessions[0];
  const created = await owner.request(ROUTES.rooms, {
    method: 'POST',
    body: {
      name: `Load test table ${index}`,
      maxSeats: options.seats,
      smallBlind: options.smallBlind,
      bigBlind: options.bigBlind,
      startingStack: options.startingStack,
      actionTimeoutSeconds: options.actionTimeoutSeconds,
    },
  });
  metrics.roomsCreated += 1;

  const roomId = created?.room?.id;
  const inviteCode = created?.inviteCode;
  if (typeof roomId !== 'string' || typeof inviteCode !== 'string') {
    throw new Error('room creation did not return { room: { id }, inviteCode }');
  }

  // The invite code is returned exactly once, at creation, and only a hash is
  // stored — so it has to be carried from here to the joiners in memory. The room id is
  // NOT in the path: the server looks the room up by the code, so that a caller who does
  // not hold the code cannot join by guessing an id.
  for (const session of sessions.slice(1)) {
    await session.request(ROUTES.joinRoom, { method: 'POST', body: { inviteCode } });
    metrics.joins += 1;
  }

  let handsCompleted = 0;
  let settleTable;
  const tableDone = new Promise((resolve) => {
    settleTable = resolve;
  });

  const clients = sessions.map(
    (session, seat) =>
      new Client({
        session,
        roomId,
        seat,
        options,
        metrics,
        random,
        onEvent: (event, client) => {
          if (event?.kind !== 'handComplete') return;
          if (client.seat !== 0) return;
          handsCompleted += 1;
          metrics.handsCompleted += 1;
          if (handsCompleted >= options.hands) {
            settleTable('complete');
            return;
          }
          client.startHand();
        },
      }),
  );

  try {
    // Sequential connect, not Promise.all: a rate limiter that sees N
    // simultaneous upgrades from one machine is measuring the limiter, and a
    // failure in the middle of a parallel connect is much harder to attribute.
    for (const client of clients) await client.connect();
    for (const client of clients) client.sit();

    // Wait for every seat to be acknowledged before dealing. Sitting is what
    // makes a player part of the hand, so dealing early produces a heads-up hand
    // at a table that was meant to have six players.
    await waitFor(() => clients.every((client) => client.sat), deadline, 'all seats to be taken');

    clients[0].startHand();

    const outcome = await Promise.race([tableDone, sleepUntil(deadline).then(() => 'timeout')]);
    return { index, roomId, handsCompleted, outcome };
  } finally {
    for (const client of clients) client.close();
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sleepUntil(deadline) {
  return sleep(Math.max(0, deadline - Date.now()));
}

/** Polls a predicate until true or the deadline passes. */
async function waitFor(predicate, deadline, what) {
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function buildReport(options, metrics, tables) {
  const samples = [...metrics.actionLatencies].sort((a, b) => a - b);
  const wallSeconds = ((metrics.finishedAt ?? performance.now()) - (metrics.startedAt ?? 0)) / 1000;
  const handsTarget = options.tables * options.hands;

  const latency = {
    samples: samples.length,
    p50Ms: percentile(samples, 0.5),
    p90Ms: percentile(samples, 0.9),
    p99Ms: percentile(samples, 0.99),
    maxMs: samples.length > 0 ? samples[samples.length - 1] : null,
  };

  const failures = [];
  if (metrics.connectionsEstablished < metrics.connectionsAttempted) {
    failures.push(
      `${metrics.connectionsAttempted - metrics.connectionsEstablished} of ` +
        `${metrics.connectionsAttempted} connections did not establish`,
    );
  }
  if (metrics.handsCompleted < handsTarget) {
    failures.push(`completed ${metrics.handsCompleted} of ${handsTarget} hands`);
  }
  if (metrics.errorRate > options.maxErrorRate) {
    failures.push(
      `error rate ${(metrics.errorRate * 100).toFixed(2)}% exceeds the ` +
        `${(options.maxErrorRate * 100).toFixed(2)}% threshold`,
    );
  }
  if (latency.p99Ms !== null && latency.p99Ms > options.maxP99Ms) {
    failures.push(`action p99 ${latency.p99Ms.toFixed(1)}ms exceeds the ${options.maxP99Ms}ms threshold`);
  }

  return {
    measuredAgainst: 'a local development server; NOT a production capacity measurement',
    settings: options,
    wallSeconds,
    counts: {
      sessionsCreated: metrics.sessionsCreated,
      roomsCreated: metrics.roomsCreated,
      joins: metrics.joins,
      connectionsAttempted: metrics.connectionsAttempted,
      connectionsEstablished: metrics.connectionsEstablished,
      seated: metrics.seated,
      handsCompleted: metrics.handsCompleted,
      handsTarget,
      actionsSent: metrics.actionsSent,
      actionsApplied: metrics.actionsApplied,
      serverMessages: metrics.serverMessages,
      seatTimeouts: metrics.timeouts,
    },
    throughput: {
      serverMessagesPerSecond: wallSeconds > 0 ? metrics.serverMessages / wallSeconds : 0,
      actionsPerSecond: wallSeconds > 0 ? metrics.actionsApplied / wallSeconds : 0,
    },
    latency,
    errors: Object.fromEntries([...metrics.errors].sort((a, b) => b[1] - a[1])),
    errorRate: metrics.errorRate,
    errorRateDenominator: metrics.operationCount + metrics.errorCount,
    tables: tables.map((t) => ({
      index: t.index,
      handsCompleted: t.handsCompleted,
      outcome: t.outcome,
    })),
    thresholds: { maxErrorRate: options.maxErrorRate, maxP99Ms: options.maxP99Ms },
    failures,
    passed: failures.length === 0,
  };
}

const ms = (value) => (value === null ? '   -  ' : `${value.toFixed(1)}ms`);

function printReport(report) {
  const { counts, latency, throughput } = report;
  console.log(bold('\nResults'));
  console.log(`  guest sessions          ${counts.sessionsCreated}`);
  console.log(`  rooms created           ${counts.roomsCreated}`);
  console.log(`  joins                   ${counts.joins}`);
  console.log(
    `  connections             ${counts.connectionsEstablished} established of ${counts.connectionsAttempted} attempted`,
  );
  console.log(`  seats taken             ${counts.seated}`);
  console.log(`  hands completed         ${counts.handsCompleted} of ${counts.handsTarget}`);
  console.log(`  actions sent/applied    ${counts.actionsSent} / ${counts.actionsApplied}`);
  if (counts.seatTimeouts > 0) {
    console.log(yellow(`  seat timeouts           ${counts.seatTimeouts} (the server acted for a seat)`));
  }
  console.log(`  wall clock              ${report.wallSeconds.toFixed(2)}s`);

  console.log(bold('\nAction round-trip latency') + dim('  (send -> matching ack)'));
  console.log(
    `  p50 ${ms(latency.p50Ms)}   p90 ${ms(latency.p90Ms)}   p99 ${ms(latency.p99Ms)}   max ${ms(latency.maxMs)}` +
      dim(`   n=${latency.samples}`),
  );

  console.log(bold('\nThroughput'));
  console.log(`  server messages/second  ${throughput.serverMessagesPerSecond.toFixed(1)}`);
  console.log(`  actions applied/second  ${throughput.actionsPerSecond.toFixed(1)}`);

  console.log(bold('\nErrors'));
  const entries = Object.entries(report.errors);
  if (entries.length === 0) {
    console.log(`  ${green('none')}`);
  } else {
    for (const [code, count] of entries) console.log(`  ${count.toString().padStart(5)}  ${code}`);
  }
  // A rate_limited error is a harness misconfiguration, not a server defect, and it is not
  // obvious from the code alone. Every seat is its own guest session, so a run needs at least
  // (tables x seats) guest creations inside one window plus the room and join calls — well
  // above the shipped GUEST_RATE_LIMIT_MAX for anything but the default shape.
  if (report.errors.rate_limited !== undefined) {
    const needed = report.settings.tables * report.settings.seats * 3;
    console.log(
      yellow(
        '\n  The API rate-limited this run. That is the server behaving correctly, not a defect:\n' +
          '  every seat opens its own guest session. Re-run the API with RATE_LIMIT_MAX and\n' +
          `  GUEST_RATE_LIMIT_MAX at or above ${needed} for this shape, or reduce --tables/--seats.`,
      ),
    );
  }
  console.log(
    dim(
      `  rate ${(report.errorRate * 100).toFixed(3)}% of ${report.errorRateDenominator} operations ` +
        '(sessions + rooms + joins + connects + sits + actions)',
    ),
  );

  console.log(bold('\nThresholds'));
  console.log(
    dim(
      `  error rate <= ${(report.thresholds.maxErrorRate * 100).toFixed(2)}%,  action p99 <= ${report.thresholds.maxP99Ms}ms,` +
        '  every requested hand completed,  every connection established',
    ),
  );

  if (report.passed) {
    console.log(green(bold('\nPASS')));
  } else {
    console.log(red(bold('\nFAIL')));
    for (const failure of report.failures) console.log(red(`  - ${failure}`));
  }
  console.log(
    yellow(
      '\nThis measured a local development server over loopback. It is a regression\n' +
        'check, not a capacity measurement — see the header of scripts/load-test.mjs.\n',
    ),
  );
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error(red(`load-test — ${err.message}`));
  process.exit(1);
}

if (options.help) {
  console.log(HELP);
  process.exit(0);
}

const metrics = new Metrics();
const random = mulberry32(options.seed);

console.log(bold('\nPoker Risk Lab load test'));
console.log(yellow('  Measures a LOCAL DEV SERVER. Not a capacity measurement. See the file header.'));
console.log(bold('\nEffective settings'));
for (const [key, value] of Object.entries(options)) {
  if (key === 'help' || key === 'json') continue;
  console.log(`  ${key.padEnd(22)} ${value}`);
}
console.log(`  ${'total sockets'.padEnd(22)} ${options.tables * options.seats}`);

// Fail fast and legibly when the server is not there, rather than reporting a
// hundred identical connection errors.
try {
  const probe = new Session(options.baseUrl, options.origin, 'probe', new Metrics());
  const health = await probe.request(ROUTES.health);
  console.log(dim(`\n  health   ${health?.status ?? 'unknown'}  version ${health?.version ?? 'unknown'}`));
} catch (err) {
  console.error(red(`\n  x cannot reach the API at ${options.baseUrl}${ROUTES.health}`));
  console.error(dim(`      ${err.message}`));
  console.error(dim('      start it with `pnpm run dev` or `docker compose up api`\n'));
  process.exit(1);
}

metrics.startedAt = performance.now();
const deadline = Date.now() + options.timeoutSeconds * 1000;

const results = await Promise.allSettled(
  Array.from({ length: options.tables }, (_unused, index) =>
    runTable({ index, options, metrics, random, deadline }),
  ),
);
metrics.finishedAt = performance.now();

const tables = [];
for (const [index, result] of results.entries()) {
  if (result.status === 'fulfilled') {
    tables.push(result.value);
    continue;
  }
  metrics.error('transport:table-failed');
  tables.push({ index, handsCompleted: 0, outcome: `failed: ${result.reason?.message ?? 'unknown'}` });
  console.error(red(`\n  x table ${index} failed: ${result.reason?.message ?? result.reason}`));
}

const report = buildReport(options, metrics, tables);
printReport(report);
if (options.json) console.log(JSON.stringify(report, null, 2));

// Non-zero on any threshold breach so this can gate CI unchanged.
process.exit(report.passed ? 0 : 1);

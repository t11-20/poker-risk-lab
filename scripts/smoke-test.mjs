#!/usr/bin/env node
/**
 * End-to-end smoke test against a RUNNING API.
 *
 * This is deliberately not a unit test and does not import the application. It speaks HTTP to a
 * real server with a real database, the way a browser does, because the two most serious bugs
 * found in this codebase were both invisible to unit tests:
 *
 *   - the session decorator was registered inside one module's encapsulated Fastify scope, so
 *     every other module returned 500 for an authenticated caller;
 *   - the room registry defaulted to a no-op archive, so hands were played and never persisted.
 *
 * Both pass every in-process test and both break the running product. So this walks the
 * critical journeys and, most importantly, asserts the confidentiality property that matters:
 * **one player must never receive another player's private cards or any undealt card.**
 *
 * Usage:
 *     node scripts/smoke-test.mjs [--origin http://127.0.0.1:3001]
 *
 * Exits non-zero on the first hard failure, so it is usable as a release gate.
 */

const args = process.argv.slice(2);
const originFlag = args.indexOf('--origin');
const ORIGIN =
  originFlag >= 0 ? (args[originFlag + 1] ?? '') : (process.env['PRL_API_ORIGIN'] ?? 'http://127.0.0.1:3001');
const WEB_ORIGIN = process.env['PRL_WEB_ORIGIN'] ?? 'http://localhost:3000';

/**
 * `--strict` promotes every warning to a failure.
 *
 * Warnings could not fail the run at all, and two of them are security properties: "no 429 after 60
 * guest creations" means rate limiting has silently stopped working, and "unknown hand returned 500
 * rather than 404" means an error path is leaking a server fault to a caller. Both printed a yellow
 * line and exited 0. CI passes `--strict`, so a warning there is a red build; a developer running it
 * by hand still gets the softer report, because a local run against a half-configured server should
 * not read as a catastrophe.
 */
const STRICT = args.includes('--strict') || process.env['PRL_SMOKE_STRICT'] === '1';

/** The WebSocket protocol version this script speaks. Must match WS_PROTOCOL_VERSION. */
const WS_PROTOCOL_VERSION = 1;

const RED = '\u001b[31m';
const GREEN = '\u001b[32m';
const YELLOW = '\u001b[33m';
const DIM = '\u001b[2m';
const BOLD = '\u001b[1m';
const RESET = '\u001b[0m';

let passed = 0;
const failures = [];
const warnings = [];

const ok = (label, detail = '') => {
  passed += 1;
  console.log(`${GREEN}  ✓${RESET} ${label}${detail ? ` ${DIM}${detail}${RESET}` : ''}`);
};
const bad = (label, detail) => {
  failures.push(`${label} — ${detail}`);
  console.log(`${RED}  ✗${RESET} ${label}\n${DIM}      ${detail}${RESET}`);
};
const warn = (label, detail) => {
  if (STRICT) {
    bad(label, `${detail}  (a warning, promoted to a failure by --strict)`);
    return;
  }
  warnings.push(`${label} — ${detail}`);
  console.log(`${YELLOW}  !${RESET} ${label} ${DIM}${detail}${RESET}`);
};
const section = (name) => console.log(`\n${BOLD}${name}${RESET}`);

/** A browser-like client: keeps cookies, sends Origin, echoes the CSRF token. */
function createClient(name) {
  const cookies = new Map();
  let csrfToken = null;

  const request = async (method, path, body) => {
    const headers = { origin: WEB_ORIGIN, accept: 'application/json' };
    if (cookies.size > 0) {
      headers['cookie'] = [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (csrfToken !== null && method !== 'GET') headers['x-csrf-token'] = csrfToken;

    const response = await fetch(`${ORIGIN}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'manual',
    });

    for (const raw of response.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const eq = (pair ?? '').indexOf('=');
      if (eq > 0) cookies.set((pair ?? '').slice(0, eq), (pair ?? '').slice(eq + 1));
    }

    const text = await response.text();
    let json = null;
    try {
      json = text === '' ? null : JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: response.status, json, text, headers: response.headers };
  };

  return {
    name,
    request,
    setCsrf(token) {
      csrfToken = token;
    },
    get cookieNames() {
      return [...cookies.keys()];
    },
    /** The jar as a `Cookie` header, for the WebSocket upgrade — which `fetch` cannot do for us. */
    get cookieHeader() {
      return [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
    },
  };
}

/** Recursively collect every string in an object graph, for leak scanning. */
function collectStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out);
  else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, out);
  }
  return out;
}

/**
 * Sits at a room over a REAL WebSocket and plays one hand to completion against the seated bot.
 *
 * ## Why the smoke test now opens a socket
 *
 * Section 8 asserts the confidentiality property this product is judged on — one player must never
 * receive another player's private cards. It used to assert it against two EMPTY hand histories,
 * because nothing in this script had ever played a hand: `collectKeys({hands: []})` cannot contain
 * `deck`, and comparing two empty sets of hand ids always finds no overlap. Three green ticks,
 * every one of them unconditional. A check that cannot fail is not a check.
 *
 * So a hand is played first, and section 8 refuses to run its scan against an empty list.
 *
 * Uses the global `WebSocket` (Node 24) with the non-standard options bag as the SECOND argument,
 * which is the only way to attach the session cookie to an upgrade — see the header of
 * scripts/load-test.mjs for the full explanation.
 *
 * Returns what was observed, so the caller can assert on it. Never throws: a failure here is
 * reported through `bad()` like every other check, and the caller degrades to reporting it rather
 * than the whole script dying half way through.
 */
async function playOneHandOverSocket(client, roomId, seat, timeoutMs = 30_000) {
  const url = new URL('/api/v1/ws', ORIGIN);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const observed = {
    welcomed: false,
    sat: false,
    completed: false,
    frames: [],
    closeCode: null,
    error: null,
  };

  await new Promise((resolve) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      observed.error = error;
      clearTimeout(timer);
      if (socket.readyState === WebSocket.OPEN) socket.close(1000, 'smoke test complete');
      resolve();
    };
    const timer = setTimeout(() => finish('timed out waiting for the hand to complete'), timeoutMs);

    const socket = new WebSocket(url, {
      headers: { cookie: client.cookieHeader, origin: WEB_ORIGIN },
    });
    let lastActedKey = null;
    const send = (message) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    };

    socket.addEventListener('open', () => {
      send({ type: 'hello', protocolVersion: WS_PROTOCOL_VERSION, roomId, clientNonce: 'smoke-nonce-1' });
    });

    socket.addEventListener('close', (event) => {
      observed.closeCode = event.code;
      finish(observed.completed ? null : `socket closed with ${event.code} before the hand completed`);
    });
    socket.addEventListener('error', () => finish('websocket error'));

    socket.addEventListener('message', (message) => {
      let frame;
      try {
        frame = JSON.parse(typeof message.data === 'string' ? message.data : String(message.data));
      } catch {
        finish('a frame did not parse as JSON');
        return;
      }
      observed.frames.push(frame);

      if (frame.type === 'welcome') {
        observed.welcomed = true;
        send({ type: 'sit', seat, requestId: 'req-smokesit1' });
        return;
      }
      if (frame.type === 'ack' && frame.requestId === 'req-smokesit1') {
        observed.sat = true;
        send({ type: 'startHand', requestId: 'req-smokedeal' });
        return;
      }
      if (frame.type === 'error') {
        finish(`server refused a frame: ${frame.error?.code ?? 'unknown'}`);
        return;
      }
      if (frame.type !== 'state' || frame.view === null || frame.view === undefined) return;

      const view = frame.view;
      if (view.street === 'complete') {
        observed.completed = true;
        finish(null);
        return;
      }
      // Act only when the server says it is this seat's turn, and only with an action it offered.
      const legal = Array.isArray(view.legalActions) ? view.legalActions : [];
      if (legal.length === 0 || view.toAct === null || view.toAct !== view.viewerSeat) return;
      const key = `${String(view.handId)}:${view.actionSequence}`;
      if (key === lastActedKey) return;
      lastActedKey = key;
      const types = new Set(legal.map((action) => action.type));
      const chosen = types.has('check') ? 'check' : types.has('call') ? 'call' : 'fold';
      send({
        type: 'action',
        actionId: `act-smoke${String(view.actionSequence).padStart(4, '0')}`,
        expectedSequence: view.actionSequence,
        requestId: `req-smokeact${String(view.actionSequence).padStart(2, '0')}`,
        action: { type: chosen },
      });
    });
  });

  return observed;
}

/** Every key name anywhere in an object graph. */
function collectKeys(value, out = new Set()) {
  if (Array.isArray(value)) for (const item of value) collectKeys(item, out);
  else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      out.add(key);
      collectKeys(item, out);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------

section(`Poker Risk Lab smoke test  ${DIM}${ORIGIN}${RESET}`);

// ---- 1. Liveness and readiness ----
section('1. Health');
{
  const health = await createClient('probe').request('GET', '/api/v1/health');
  if (health.status === 200 && health.json?.status === 'ok') {
    ok('health responds', `version ${health.json.version}, protocol ${health.json.protocolVersion}`);
  } else {
    bad('health', `expected 200 {status:"ok"}, got ${health.status} ${health.text.slice(0, 120)}`);
    console.log(`\n${RED}The API is not reachable. Start it with: pnpm run dev:api${RESET}\n`);
    process.exit(1);
  }

  const ready = await createClient('probe').request('GET', '/api/v1/ready');
  if (ready.status === 200 && ready.json?.status === 'ready') {
    ok('readiness passes', `database ${ready.json.checks?.database?.ok === true ? 'ok' : 'DEGRADED'}`);
  } else if (ready.json?.status === 'degraded') {
    warn('readiness degraded', JSON.stringify(ready.json.checks));
  } else {
    bad('readiness', `got ${ready.status} ${ready.text.slice(0, 120)}`);
  }
}

// ---- 2. Guest session, CSRF, and the units framing ----
section('2. Guest session');
const alice = createClient('alice');
{
  const anon = await alice.request('GET', '/api/v1/auth/session');
  if (anon.status === 200 && anon.json?.user === null) {
    ok('an anonymous session read returns 200 with user:null', 'guest-first, not a 401');
  } else {
    bad('anonymous session read', `expected 200 user:null, got ${anon.status} ${anon.text.slice(0, 120)}`);
  }
  if (typeof anon.json?.csrfToken === 'string') alice.setCsrf(anon.json.csrfToken);

  const guest = await alice.request('POST', '/api/v1/auth/guest', { displayName: 'Alice' });
  if (guest.status === 200 || guest.status === 201) {
    const user = guest.json?.user;
    ok('guest created', `${user?.displayName} with ${user?.units} units`);
    if (typeof user?.units !== 'number' || user.units <= 0) {
      bad('guest units', `expected a positive unit balance, got ${String(user?.units)}`);
    }
    if (typeof guest.json?.csrfToken === 'string') alice.setCsrf(guest.json.csrfToken);
    if (!alice.cookieNames.some((name) => /session/i.test(name))) {
      bad('session cookie', `no session cookie was set; got ${alice.cookieNames.join(', ')}`);
    } else {
      ok('session cookie set', alice.cookieNames.join(', '));
    }
    // No currency framing anywhere in the payload.
    const strings = collectStrings(guest.json).join(' ');
    if (/[$£€]|\bUSD\b|\bbalance\b/i.test(strings)) {
      bad('units framing', 'the session payload uses currency or "balance" wording');
    } else {
      ok('no currency framing in the session payload');
    }
  } else {
    bad('guest creation', `got ${guest.status} ${guest.text.slice(0, 160)}`);
  }

  const authed = await alice.request('GET', '/api/v1/auth/session');
  if (authed.json?.user?.id !== undefined) ok('the session persists across requests', authed.json.user.id);
  else bad('session persistence', `got ${authed.status} ${authed.text.slice(0, 120)}`);
}

// ---- 3. CSRF is actually enforced ----
section('3. CSRF');
{
  const noToken = createClient('csrf-probe');
  const seed = await noToken.request('GET', '/api/v1/auth/session');
  // Deliberately do NOT set the csrf token.
  void seed;
  const attempt = await noToken.request('POST', '/api/v1/auth/guest', { displayName: 'Mallory' });
  if (attempt.status === 403 && attempt.json?.error?.code === 'csrf_failed') {
    ok('a mutating request without a CSRF token is rejected', 'csrf_failed');
  } else if (attempt.status === 403) {
    ok('a mutating request without a CSRF token is rejected', `403 ${attempt.json?.error?.code}`);
  } else {
    bad('CSRF', `expected 403 csrf_failed, got ${attempt.status} ${attempt.text.slice(0, 140)}`);
  }
}

// ---- 4. Content, computed live ----
section('4. Content');
{
  const lessons = await alice.request('GET', '/api/v1/content/lessons');
  const count = lessons.json?.lessons?.length ?? 0;
  if (lessons.status === 200 && count >= 12) ok('lessons served', `${count} lessons`);
  else bad('lessons', `expected >= 12, got ${count} (status ${lessons.status})`);

  const scenarios = await alice.request('GET', '/api/v1/content/scenarios');
  const scenarioCount = scenarios.json?.scenarios?.length ?? 0;
  if (scenarios.status === 200 && scenarioCount >= 30) ok('scenarios served', `${scenarioCount} scenarios`);
  else bad('scenarios', `expected >= 30, got ${scenarioCount} (status ${scenarios.status})`);

  const first = scenarios.json?.scenarios?.[0]?.id;
  if (typeof first === 'string') {
    const detail = await alice.request('GET', `/api/v1/content/scenarios/${first}`);
    const analysis = detail.json?.analysis;
    if (detail.status === 200 && analysis !== undefined && analysis !== null) {
      ok('a scenario carries live analysis', `equity ${(analysis.equity?.heroEquity * 100).toFixed(1)}%`);
      // The guardrail that matters: assumptions and uncertainty are never absent.
      if (!Array.isArray(analysis.assumptions) || analysis.assumptions.length === 0) {
        bad('scenario analysis', 'assumptions are missing or empty — a figure without them is a guess');
      } else {
        ok('the analysis states its assumptions', `${analysis.assumptions.length} of them`);
      }
      if (analysis.uncertainty?.method === undefined) {
        bad('scenario analysis', 'uncertainty does not state its method');
      } else {
        ok('the analysis states its method', analysis.uncertainty.method);
      }
      const text = collectStrings(analysis).join(' ');
      if (/\b(?:the )?(?:correct|optimal) play\b/i.test(text)) {
        bad('scenario analysis', 'claims a uniquely correct play');
      } else {
        ok('the analysis never claims a correct or optimal play');
      }
    } else {
      bad('scenario detail', `no analysis returned (status ${detail.status})`);
    }
  }

  const glossary = await alice.request('GET', '/api/v1/content/glossary');
  const terms = glossary.json?.entries?.length ?? 0;
  if (terms >= 45) ok('glossary served', `${terms} terms`);
  else bad('glossary', `expected >= 45, got ${terms}`);
}

// ---- 5. The calculation endpoints ----
section('5. Calculation');
{
  const equity = await alice.request('POST', '/api/v1/math/equity', {
    heroCards: 'AhAd',
    opponents: ['KsKc'],
  });
  const heroEquity = equity.json?.equity?.heroEquity;
  if (equity.status === 200 && typeof heroEquity === 'number') {
    // AA vs KK is ~81%. A figure outside 75-88% means something is badly wrong.
    const percent = heroEquity * 100;
    if (percent > 75 && percent < 88) {
      ok('AA vs KK equity is plausible', `${percent.toFixed(2)}% by ${equity.json.equity.method}`);
    } else {
      bad('equity', `AA vs KK returned ${percent.toFixed(2)}%, which is not credible`);
    }
    if (
      equity.json.equity.method === 'monte-carlo' &&
      equity.json.equity.confidenceHalfWidthPoints === null
    ) {
      bad('equity', 'a sampled result reported no confidence interval');
    }
  } else {
    bad('equity endpoint', `got ${equity.status} ${equity.text.slice(0, 160)}`);
  }

  const coach = await alice.request('POST', '/api/v1/math/coach', {
    heroCards: 'AhKh',
    board: 'Qh 7h 2c',
    opponents: ['QsQd'],
    pot: 100,
    toCall: 50,
    heroStack: 400,
    opponentStacks: [400],
    bigBlind: 10,
    street: 'flop',
  });
  const report = coach.json?.report;
  if (coach.status === 200 && report !== undefined) {
    ok('coach report returned', `suggests ${report.suggestion?.action} (${report.suggestion?.confidence})`);
    if (!Array.isArray(report.assumptions) || report.assumptions.length === 0) {
      bad('coach report', 'assumptions empty');
    } else ok('coach states assumptions', `${report.assumptions.length}`);
    if (report.uncertainty?.limitations?.length === 0) bad('coach report', 'no limitations stated');
    if (
      !Array.isArray(report.suggestion?.whatWouldChangeIt) ||
      report.suggestion.whatWouldChangeIt.length === 0
    ) {
      bad('coach report', 'the suggestion does not say what would change it');
    } else ok('the suggestion says what would change it');
  } else {
    bad('coach endpoint', `got ${coach.status} ${coach.text.slice(0, 200)}`);
  }

  // Hostile input must be rejected, not absorbed.
  const hostile = [
    [{ heroCards: 'ZZZZ', opponents: ['KsKc'] }, 'nonsense cards'],
    [{ heroCards: 'AhAd', opponents: ['T9s+'] }, 'ambiguous range notation'],
    [{ heroCards: 'AhAd', opponents: ['KsKc'], samples: 10 ** 12 }, 'absurd sample count'],
    [{ heroCards: 'AhAh', opponents: ['KsKc'] }, 'duplicate card'],
    [{ heroCards: 'AhAd', opponents: [] }, 'no opponents'],
    [{ heroCards: 'AhAd', opponents: ['KsKc'], unexpectedField: 1 }, 'unknown field (closed schema)'],
  ];
  let rejected = 0;
  for (const [body, label] of hostile) {
    const response = await alice.request('POST', '/api/v1/math/equity', body);
    if (response.status >= 400 && response.status < 500) rejected += 1;
    else bad('hostile input accepted', `${label} returned ${response.status}`);
  }
  if (rejected === hostile.length) ok(`all ${hostile.length} hostile calculation inputs rejected`);
}

// ---- 6. AI Legends labelling ----
section('6. AI Legends');
{
  const profiles = await alice.request('GET', '/api/v1/legends/profiles');
  const list = profiles.json?.profiles ?? [];
  if (profiles.status === 200 && list.length >= 11) {
    ok('legend profiles served', `${list.length} profiles, naming mode "${profiles.json.namingMode}"`);
  } else {
    bad('legend profiles', `expected >= 11, got ${list.length} (status ${profiles.status})`);
  }
  if (profiles.json?.namingMode !== undefined && profiles.json.namingMode !== 'archetype') {
    warn('naming mode', `is "${profiles.json.namingMode}"; archetype is the safe production default`);
  } else if (profiles.json?.namingMode === 'archetype') {
    ok('the safe archetype naming mode is the default');
  }
  let missingDisclaimer = 0;
  for (const profile of list) {
    if (!Array.isArray(profile.disclosure?.disclaimers) || profile.disclosure.disclaimers.length === 0) {
      missingDisclaimer += 1;
    }
  }
  if (missingDisclaimer === 0 && list.length > 0) ok('every profile carries at least one disclaimer');
  else if (missingDisclaimer > 0) bad('legend disclaimers', `${missingDisclaimer} profile(s) carry none`);

  // No profile may claim to BE a person or be endorsed.
  const text = collectStrings(profiles.json).join(' ');
  if (/\bdigital twin\b|\bendorsed by\b(?!\s+anyone)|\bofficial (?:profile|partner)\b/i.test(text)) {
    bad('legend framing', 'a profile implies endorsement or a digital twin');
  } else {
    ok('no profile implies endorsement or a digital twin');
  }
}

// ---- 7. Rooms, and the confidentiality property ----
section('7. Rooms and hidden information');
const bob = createClient('bob');
{
  const seed = await bob.request('GET', '/api/v1/auth/session');
  if (typeof seed.json?.csrfToken === 'string') bob.setCsrf(seed.json.csrfToken);
  const guest = await bob.request('POST', '/api/v1/auth/guest', { displayName: 'Bob' });
  if (typeof guest.json?.csrfToken === 'string') bob.setCsrf(guest.json.csrfToken);
  if (guest.status === 200 || guest.status === 201) ok('a second guest session created', 'Bob');
  else bad('second guest', `got ${guest.status} ${guest.text.slice(0, 140)}`);

  // A bot takes seat 1 so that Alice can actually PLAY a hand below. Without an opponent there is
  // nothing to deal, the hand history stays empty, and section 8's confidentiality checks scan an
  // empty list and pass unconditionally — which is exactly what they used to do.
  const created = await alice.request('POST', '/api/v1/rooms', {
    name: 'Smoke Table',
    // Three seats: Alice plays, a bot fills seat 1 so there is a hand to deal, and Bob still has
    // room to join as a member. At maxSeats 2 the bot fills the table and Bob's join — which is
    // what the isolation check below depends on — is refused room_full.
    maxSeats: 3,
    smallBlind: 5,
    bigBlind: 10,
    startingStack: 1000,
    bots: [{ profile: 'tight-aggressive', count: 1 }],
  });
  const roomId = created.json?.room?.id;
  const inviteCode = created.json?.inviteCode;
  if (created.status === 200 || created.status === 201) {
    ok('room created', `${roomId}, invite code returned once`);
    if (typeof inviteCode !== 'string' || inviteCode.length < 8) {
      bad('invite code', `expected a code of >= 8 chars, got ${String(inviteCode)}`);
    }
    if (created.json?.room?.visibility !== 'invite_only') {
      bad('room visibility', `expected invite_only, got ${String(created.json?.room?.visibility)}`);
    } else ok('the room is invite-only');
  } else {
    bad('room creation', `got ${created.status} ${created.text.slice(0, 200)}`);
  }

  // Bob must NOT be able to read a room he was not invited to, and the error must not
  // confirm the room exists.
  if (typeof roomId === 'string') {
    const peek = await bob.request('GET', `/api/v1/rooms/${roomId}`);
    if (peek.status === 404) {
      ok('an uninvited user gets 404, not 403', 'the error does not confirm the room exists');
    } else if (peek.status === 403) {
      bad('room enumeration', '403 confirms the room exists; the threat model requires 404');
    } else if (peek.status === 200) {
      bad('authorization', 'an uninvited user could read the room');
    } else {
      warn('room read by non-member', `status ${peek.status}`);
    }

    // A wrong invite code must fail.
    const wrong = await bob.request('POST', '/api/v1/rooms/join', { inviteCode: 'AAAAAAAA' });
    if (wrong.status >= 400)
      ok('a wrong invite code is rejected', `${wrong.json?.error?.code ?? wrong.status}`);
    else bad('invite code', 'a wrong code was accepted');
  }

  // Join properly, then check what each player can see.
  if (typeof inviteCode === 'string') {
    const joined = await bob.request('POST', '/api/v1/rooms/join', { inviteCode });
    if (joined.status === 200 || joined.status === 201) ok('Bob joined with the invite code');
    else bad('room join', `got ${joined.status} ${joined.text.slice(0, 200)}`);
  }

  // ---- The live table, over a real socket ----
  if (typeof roomId === 'string') {
    const played = await playOneHandOverSocket(alice, roomId, 0);
    if (played.welcomed) ok('the WebSocket upgrade succeeded', 'session cookie carried on the handshake');
    else bad('websocket upgrade', played.error ?? `closed with ${String(played.closeCode)}`);
    if (played.sat) ok('Alice took a seat over the socket');
    else if (played.welcomed) bad('sit', played.error ?? 'no ack for the sit request');

    if (played.completed) {
      ok('a hand was played to completion against a bot', `${played.frames.length} frames`);
    } else {
      bad('live hand', played.error ?? 'the hand did not reach a completed state');
    }

    // The confidentiality property, on the live wire rather than on a stored row. Every frame this
    // socket received is scanned; the bot's hole cards may appear only in a completed hand that
    // actually reached showdown, and the deck may never appear at all.
    const frameKeys = collectKeys(played.frames);
    const leakedKeys = ['deck', 'deckCursor', 'deckSalts', 'salts'].filter((key) => frameKeys.has(key));
    if (leakedKeys.length > 0) {
      bad('hidden information', `a socket frame carried ${leakedKeys.join(', ')}`);
    } else if (played.frames.length > 0) {
      ok('no socket frame carried a deck, cursor or salt', `${played.frames.length} frames scanned`);
    } else {
      bad('hidden information', 'no frames were received, so the socket scan proved nothing');
    }

    const preShowdownLeak = played.frames.some((frame) => {
      if (frame.type !== 'state' || frame.view === null || frame.view === undefined) return false;
      if (frame.view.street === 'complete') return false;
      const seats = Array.isArray(frame.view.seats) ? frame.view.seats : [];
      return seats.some((seat) => seat.holeCards !== null && seat.seat !== frame.view.viewerSeat);
    });
    if (preShowdownLeak) bad('hidden information', "a live frame carried another seat's hole cards mid-hand");
    else if (played.frames.length > 0) ok("no live frame carried another seat's hole cards mid-hand");
  }
}

// ---- 8. Hand history isolation ----
section('8. Hand history isolation');
{
  const aliceHands = await alice.request('GET', '/api/v1/hands');
  const aliceRows = aliceHands.json?.hands ?? [];
  if (aliceHands.status === 200) {
    ok('hand history reads', `${aliceRows.length} hand(s)`);
    // THE PRECONDITION. Every check below scans Alice's rows, and a scan of an empty list finds
    // nothing wrong with anything: `collectKeys({hands: []})` cannot contain "deck", and comparing
    // an empty set of ids to Bob's finds no overlap. All three used to pass unconditionally because
    // this script had never played a hand. An empty list is now a failure, not a free pass.
    if (aliceRows.length < 1) {
      bad(
        'hand history',
        'Alice has no hands, so every isolation check below would scan an empty list and pass ' +
          'for free. The live hand in section 7 did not reach the archive.',
      );
    } else {
      ok('the isolation checks below have rows to be wrong about', `${aliceRows.length} archived`);
    }
    // The regression that returned 500 for every caller.
    const keys = collectKeys(aliceHands.json);
    const leaked = ['deck', 'deckCursor', 'deckSalts', 'salts'].filter((key) => keys.has(key));
    if (leaked.length > 0) bad('hidden information', `the hand list exposes ${leaked.join(', ')}`);
    else if (aliceRows.length >= 1) ok('the hand list exposes no deck, cursor or salt key');

    // A row in your own history must carry your own cards and nobody else's, unless they showed
    // down. Only checkable now that there is a row.
    const foreignCards = aliceRows.filter((hand) => {
      const seats = Array.isArray(hand.seats) ? hand.seats : [];
      return seats.some((seat) => seat.holeCards != null && seat.isSelf !== true && seat.showedDown !== true);
    });
    if (foreignCards.length > 0) {
      bad('hidden information', `${foreignCards.length} archived hand(s) carry an opponent's unshown cards`);
    } else if (aliceRows.length >= 1) {
      ok("an archived hand carries no opponent's unshown hole cards");
    }
  } else {
    bad(
      'hand history',
      `got ${aliceHands.status} ${aliceHands.text.slice(0, 200)} — this route returned 500 for every caller before the session plugin was moved to the root scope`,
    );
  }

  const bobHands = await bob.request('GET', '/api/v1/hands');
  if (bobHands.status !== 200) {
    // The `else` that was missing. A 500 from Bob's history used to produce no check at all —
    // neither a pass nor a failure — so the isolation assertion simply vanished on the one status
    // code that most needed reporting.
    bad('hand isolation', `Bob's history returned ${bobHands.status} ${bobHands.text.slice(0, 200)}`);
  }
  if (bobHands.status === 200) {
    const aliceIds = new Set(aliceRows.map((h) => h.id));
    const overlap = (bobHands.json?.hands ?? []).filter((h) => aliceIds.has(h.id));
    if (aliceIds.size === 0) {
      bad('hand isolation', 'Alice has no hand ids, so the overlap comparison is two empty sets');
    } else if (overlap.length === 0) {
      ok("Bob's hand history does not contain Alice's hands", `${aliceIds.size} of Alice's ids checked`);
    } else {
      bad('hand isolation', `${overlap.length} of Alice's hands appear in Bob's history`);
    }
  }

  // Requesting a hand that does not exist must 404, not 403 or 500.
  const missing = await alice.request('GET', '/api/v1/hands/hand_doesnotexist');
  if (missing.status === 404) ok('an unknown hand returns 404');
  else warn('unknown hand', `status ${missing.status}`);
}

// ---- 9. Progress carries no score ----
section('9. Progress');
{
  const progress = await alice.request('GET', '/api/v1/me/progress');
  if (progress.status === 200) {
    ok('progress reads', `${progress.json?.handsPlayed ?? 0} hands played`);
    const keys = [...collectKeys(progress.json)];
    const gamified = keys.filter((k) => /^(?:score|streak|level|rank|xp|points|badge)$/i.test(k));
    if (gamified.length > 0) bad('gamification', `progress exposes ${gamified.join(', ')}`);
    else ok('progress carries no score, streak, level or rank');
  } else {
    bad('progress', `got ${progress.status} ${progress.text.slice(0, 200)}`);
  }
}

// ---- 10. Rate limiting exists ----
section('10. Rate limiting');
{
  const client = createClient('flood');
  const seed = await client.request('GET', '/api/v1/auth/session');
  if (typeof seed.json?.csrfToken === 'string') client.setCsrf(seed.json.csrfToken);
  let limited = false;
  for (let attempt = 0; attempt < 60 && !limited; attempt += 1) {
    const response = await client.request('POST', '/api/v1/auth/guest', { displayName: `Flood${attempt}` });
    if (response.status === 429) limited = true;
  }
  if (limited) ok('guest creation is rate limited', '429 after repeated attempts');
  else warn('rate limiting', 'no 429 after 60 guest creations — check the limit for this route');
}

// ---------------------------------------------------------------------------

console.log(`\n${BOLD}Summary${RESET}`);
console.log(`  ${GREEN}${passed} check(s) passed${RESET}`);
if (warnings.length > 0) {
  console.log(`  ${YELLOW}${warnings.length} warning(s)${RESET}`);
  console.log(`  ${DIM}re-run with --strict (as CI does) to make these fail the run${RESET}`);
}
if (failures.length > 0) {
  console.log(`  ${RED}${failures.length} failure(s)${RESET}`);
  for (const failure of failures) console.log(`${RED}    - ${failure}${RESET}`);
  console.log('');
  process.exit(1);
}
console.log(`${GREEN}${BOLD}\nSmoke test passed.${RESET}\n`);

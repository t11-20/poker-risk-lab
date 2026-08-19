/**
 * The WebSocket hub, over a real socket.
 *
 * ## Why this file had to exist
 *
 * Every other WebSocket test in this repository drives `WsRouter` with a recorder object, or calls
 * one of the two pure functions `hub.ts` exports. `createWsHub` itself — the plugin that turns an
 * HTTP upgrade into a live connection — was instantiated by no test at all. So none of this was
 * covered: the real upgrade with a cookie-borne session, the per-session socket counter that a
 * reconnect leak would lock a user out of, `toBytes` on a binary or fragmented frame, and the whole
 * central journey of the product — connect, sit, play a hand, see the result.
 *
 * These tests therefore use the production wiring: `buildApp` (real helmet, CORS, CSRF, rate limit
 * and Ajv), the real `sessionPlugin` in front of the real signed cookie, `createWsHub` registered
 * through `registerRoutes` so the path is the shipped `/api/v1/ws`, a real `ws` client over
 * loopback, and a real `LiveTable` with a real bot. Only two seams are faked, and both are
 * database rows rather than behaviour: room/member persistence and the session row lookup (see
 * `test/helpers/live-room.ts`).
 *
 * ## The assertion that matters most
 *
 * `two sessions at one table` and `a hand that ends by a fold` prove the hidden-information
 * guarantee **over the wire**, against ground truth rather than against the frames themselves. The
 * server-side deal is read out of the table, the set of cards each viewer is entitled to see is
 * computed from it (own hole cards, the board, and the hole cards of seats that actually showed
 * down), and then every one of the remaining 43-50 cards in the deck — the opponent's unshown
 * holding and every undealt card — is required to be absent from every frame that socket ever
 * received, both structurally and as text. That is the property the brief names: one player must
 * never receive another player's private cards, and no client may ever learn future deck state.
 *
 * ## The other assertion that matters: a chair is not a person
 *
 * `a chair that changes owner` covers the case the two tests above cannot reach, because both seat
 * their players once and never move them. A `HandState` outlives its seating — the table keeps the
 * finished hand for the terminal frame and for a reconnect between deals — so the moment a player
 * stands and somebody else takes their chair, "seat 0" in the retained hand and "seat 0" at the
 * table are two different human beings. Deciding what a socket may see from the seat index rather
 * than from the user id therefore posts the previous occupant's unshown hole cards to the new one.
 * That test plays a hand out, stands the player up, seats a second session in the vacated chair,
 * and requires every byte that second session ever received to be free of the first's cards.
 *
 * ## Would these fail if the behaviour broke?
 *
 * Checked by breaking it. With `redactFor`'s `maySeeCards` forced to `true`, the two
 * hidden-information tests fail on the first state frame. With the `bySession` decrement in
 * `hub.ts`'s close handler removed, `the per-session socket cap` fails at the reconnect. With
 * `broadcast` changed to build one view and send it to everybody, the redaction tests fail. With
 * `viewFor` reverted to looking the caller's seat up in the current seating and passing that index
 * to `redactFor`, `a chair that changes owner` fails on the frame that follows the second session
 * taking the chair — reported as a leaked card value, a leaked notation, AND a seat marked as the
 * recipient's own whose `playerId` is somebody else's.
 */

import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';
import { API_PATHS, WS_CLOSE, WS_LIMITS } from '@prl/contracts';
import { type Card, cardToString, DECK_SIZE, makeCard, orderedDeck, RANKS, SUITS } from '@prl/poker-engine';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { buildApp, registerRoutes } from '../src/app.ts';
import { type AppConfig, type EnvRecord, loadConfig } from '../src/config.ts';
import type { DatabaseHandle } from '../src/db.ts';
import { sessionCookieName } from '../src/plugins/security.ts';
import { botDisplayName, resolveProfile, seedFor } from '../src/rooms/bots.ts';
import { type LiveRoom, RoomRegistry } from '../src/rooms/registry.ts';
import { createWsHub } from '../src/ws/hub.ts';
import { accountFor, fixedSessionStore, seatingOnlyStore } from './helpers/live-room.ts';

const ALLOWED_ORIGIN = 'http://localhost:3000';
/** Long enough for a bot to think and a hand to play out; short enough to fail rather than hang. */
const FRAME_TIMEOUT_MS = 15_000;

function testConfig(overrides: EnvRecord = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    // Nothing here connects: `buildApp` gets a stub handle and the registry gets a fake store.
    DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:5432/unused',
    PUBLIC_WEB_ORIGIN: ALLOWED_ORIGIN,
    SESSION_COOKIE_SECRET: 'Zk7pQ2vR9tX4bN6mL1sD8gH3jF5wC0yA',
    // Generous, so the limiter is never why an assertion fails. The limits themselves are covered
    // by `test/security-headers.test.ts` and `test/ws-router.test.ts`.
    RATE_LIMIT_MAX: '5000',
    ...overrides,
  });
}

const stubDatabase: DatabaseHandle = {
  ping: () => Promise.resolve({ ok: true }),
  close: () => Promise.resolve(),
};

// ---------------------------------------------------------------------------
// Cards: the ground truth this file measures leaks against
// ---------------------------------------------------------------------------

/**
 * Keys whose numeric values are card indices.
 *
 * `card` covers `result.reveal.cards[].card`; `holeCards` and `board` cover the view. Anything
 * numeric outside these keys is a stack, a pot, a sequence or a timestamp.
 */
const CARD_VALUE_KEYS = new Set(['holeCards', 'board', 'card']);

const NOTATION = /^([2-9TJQKA])([cdhs])$/;

/** A card from its two-character notation, or null. Used to catch a leak in a string field. */
function cardFromNotation(text: string): Card | null {
  const match = NOTATION.exec(text);
  if (match === null) return null;
  const rank = RANKS.indexOf(match[1] as (typeof RANKS)[number]);
  const suit = SUITS.indexOf(match[2] as (typeof SUITS)[number]);
  return rank < 0 || suit < 0 ? null : makeCard(rank, suit);
}

/**
 * Every card mentioned anywhere in a frame, whether as an index under a card key or as notation.
 *
 * Two forms because the protocol uses both: the view carries indices, and a `street` event carries
 * `newCards` as notation strings. A scan that only understood one of them would be blind to a leak
 * through the other.
 */
function collectCards(value: unknown, out: Set<Card>, underCardKey = false): Set<Card> {
  if (typeof value === 'number') {
    if (underCardKey) out.add(value);
    return out;
  }
  if (typeof value === 'string') {
    const card = cardFromNotation(value);
    if (card !== null) out.add(card);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectCards(item, out, underCardKey);
    return out;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      collectCards(item, out, CARD_VALUE_KEYS.has(key));
    }
  }
  return out;
}

/**
 * A card's notation as a word, so `Ad` does not match inside `Ada` and `9c` does not match inside a
 * hex digest.
 *
 * `_` is in the boundary class because ids look like `hand_ws1`.
 */
function notationPattern(card: Card): RegExp {
  return new RegExp(`(?<![A-Za-z0-9_])${cardToString(card)}(?![A-Za-z0-9_])`);
}

/** Keys that must never appear in a frame, at any depth. */
const FORBIDDEN_KEYS = ['deck', 'deckCursor', 'deckSalts', 'salts', 'salt', 'secret'];

function collectKeys(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, out);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      out.add(key);
      collectKeys(item, out);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

interface Frame {
  readonly type: string;
  readonly [key: string]: unknown;
}

interface Seated {
  readonly userId: string;
  readonly displayName: string;
  readonly token: string;
  readonly sessionId: string;
}

interface Hub {
  readonly app: FastifyInstance;
  readonly registry: RoomRegistry;
  readonly room: LiveRoom;
  readonly roomId: string;
  readonly url: string;
  readonly cookieFor: (token: string) => string;
  readonly problems: string[];
}

const openApps: FastifyInstance[] = [];
const openSockets: WebSocket[] = [];

after(async () => {
  for (const socket of openSockets) socket.terminate();
  for (const app of openApps) await app.close();
});

/** Readable, sequential hand ids, so a failure names the hand it happened in. */
function incrementingHandIds(prefix: string): () => string {
  let count = 0;
  return () => {
    count += 1;
    return `hand_${prefix}${count}`;
  };
}

/**
 * Starts an app on an ephemeral port with the hub registered exactly as `routes/index.ts` does.
 *
 * `botThinkingDelayMs: 0` so a bot answers on the next tick rather than after 700 ms of legibility
 * delay — the delay is a UI property and waiting it out per action would make this suite slow for
 * no extra coverage. The clock is the real one: this test is about real sockets in real time.
 */
async function startHub(options: {
  readonly players: readonly Seated[];
  readonly maxSeats?: number;
  readonly idPrefix: string;
}): Promise<Hub> {
  const config = testConfig();
  const app = await buildApp({ config, database: stubDatabase });
  openApps.push(app);
  const problems: string[] = [];
  const registry = new RoomRegistry({
    store: seatingOnlyStore(),
    nextHandId: incrementingHandIds(options.idPrefix),
    botThinkingDelayMs: 0,
    onProblem: (message, detail) => problems.push(`${message} ${JSON.stringify(detail ?? {})}`),
  });
  const roomId = `room_${options.idPrefix}`;
  const room = await registry.open({
    record: {
      id: roomId,
      name: 'Socket table',
      ownerUserId: options.players[0]?.userId ?? 'usr_a',
      config: {
        smallBlind: 5,
        bigBlind: 10,
        ante: 0,
        maxSeats: options.maxSeats ?? 2,
        actionTimeoutSeconds: 30,
      },
      startingStack: 1_000,
      createdAt: '2026-08-17T12:00:00.000Z',
      closed: false,
    },
    members: options.players.map((player) => ({
      userId: player.userId,
      displayName: player.displayName,
      isBot: false,
      botProfile: null,
    })),
  });

  const sessions = new Map(
    options.players.map((player) => [
      player.token,
      { sessionId: player.sessionId, user: accountFor(player.userId, player.displayName) },
    ]),
  );
  await registerRoutes(app, [createWsHub({ registry, sessionStore: fixedSessionStore(sessions) })]);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as AddressInfo;

  return {
    app,
    registry,
    room,
    roomId,
    // Built from the contract's published path rather than from a literal `/api/v1${WS_PATH}`.
    // The upgrade path is half a contract like every other path: `API_PATHS.ws()` is what the
    // browser client opens, so driving the real handshake from that same constant is what makes
    // `web-api-paths.test.ts`' route lookup a check on something a client actually uses.
    url: `ws://127.0.0.1:${address.port}${API_PATHS.ws()}`,
    cookieFor: (token) => `${sessionCookieName(config)}=${app.signCookie(token)}`,
    problems,
  };
}

/** Seats a bot at the live table, the way `POST /rooms` does. */
function seatBot(hub: Hub, seat: number, legacyName = 'tight-aggressive'): Promise<unknown> {
  const profile = resolveProfile(legacyName);
  return hub.registry.seatBot(hub.roomId, {
    userId: `usr_bot${seat}`,
    displayName: botDisplayName(profile.naming.id),
    seat,
    profileId: profile.naming.id,
    difficulty: 'realistic',
    seed: seedFor(hub.roomId, seat, 7),
  });
}

type Policy = (legal: readonly { readonly type: string; readonly minTo?: number }[]) => {
  readonly type: string;
  readonly to?: number;
};

/** Check when free, otherwise call, otherwise fold. Plays hands out rather than ending them. */
const PASSIVE: Policy = (legal) => {
  const types = new Set(legal.map((action) => action.type));
  if (types.has('check')) return { type: 'check' };
  if (types.has('call')) return { type: 'call' };
  return { type: 'fold' };
};

/** Fold at the first opportunity, so the hand ends with nobody's cards shown. */
const FOLD_AT_ONCE: Policy = (legal) => {
  const types = new Set(legal.map((action) => action.type));
  if (types.has('fold')) return { type: 'fold' };
  return PASSIVE(legal);
};

let requestCounter = 0;
function nextRequestId(): string {
  requestCounter += 1;
  return `req-${String(requestCounter).padStart(8, '0')}`;
}

/** A distinct `actionId` per attempt, so a retry can be told from a new decision. */
function nextActionId(): string {
  requestCounter += 1;
  return String(requestCounter).padStart(8, '0');
}

/**
 * One real socket, recording every byte the server sent it.
 *
 * `raw` is kept as text as well as parsed, because the strongest leak assertion is a text scan: a
 * card that reached this client through a field nobody thought to check is still in `raw`.
 */
class SocketClient {
  readonly raw: string[] = [];
  readonly frames: Frame[] = [];
  readonly closes: { readonly code: number; readonly reason: string }[] = [];
  readonly actionsAcked: number[] = [];
  private socket: WebSocket | null = null;
  private readonly waiters: { predicate: (frame: Frame) => boolean; settle: (frame: Frame) => void }[] = [];
  private closeWaiters: ((event: { code: number; reason: string }) => void)[] = [];
  private policy: Policy | null = null;
  private lastActedKey: string | null = null;
  private readonly hub: Hub;
  readonly player: Seated;

  // Written out rather than declared as constructor parameter properties: Node's type stripping is
  // strip-only, and a parameter property is the one TypeScript feature that emits code.
  constructor(hub: Hub, player: Seated) {
    this.hub = hub;
    this.player = player;
  }

  /** Opens the socket. Resolves on the TCP/HTTP upgrade, not on `welcome`. */
  async connect(
    overrides: { readonly cookie?: string | null; readonly origin?: string | null } = {},
  ): Promise<void> {
    const headers: Record<string, string> = {};
    const cookie = overrides.cookie === undefined ? this.hub.cookieFor(this.player.token) : overrides.cookie;
    if (cookie !== null) headers['cookie'] = cookie;
    const origin = overrides.origin === undefined ? ALLOWED_ORIGIN : overrides.origin;
    if (origin !== null) headers['origin'] = origin;

    const socket = new WebSocket(this.hub.url, { headers });
    this.socket = socket;
    openSockets.push(socket);

    socket.on('message', (data: Buffer) => {
      const text = data.toString('utf8');
      this.raw.push(text);
      const parsed: unknown = JSON.parse(text);
      assert.ok(
        parsed !== null && typeof parsed === 'object' && 'type' in parsed,
        `every server frame is an object with a type: ${text.slice(0, 120)}`,
      );
      const frame = parsed as Frame;
      this.frames.push(frame);
      if (frame.type === 'ack' && typeof frame['appliedSequence'] === 'number') {
        this.actionsAcked.push(frame['appliedSequence']);
      }
      if (frame.type === 'state') this.maybeAct(frame);
      for (const waiter of [...this.waiters]) {
        if (!waiter.predicate(frame)) continue;
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.settle(frame);
      }
    });
    socket.on('close', (code: number, reason: Buffer) => {
      const event = { code, reason: reason.toString('utf8') };
      this.closes.push(event);
      for (const settle of this.closeWaiters) settle(event);
      this.closeWaiters = [];
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the upgrade did not complete')), FRAME_TIMEOUT_MS);
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

  send(
    message: Record<string, unknown>,
    options: { readonly binary?: boolean; readonly fragments?: number } = {},
  ): void {
    const socket = this.socket;
    assert.ok(socket !== null, 'the socket is not open');
    const text = JSON.stringify(message);
    if (options.fragments !== undefined && options.fragments > 1) {
      // A genuinely fragmented message: the server's `ws` receiver reassembles the continuation
      // frames before the hub's handler sees them, which is the path `toBytes` exists for. (Its
      // `Buffer[]` branch needs `binaryType: 'fragments'`, which the hub does not set, so it is
      // unreachable from a conformant client — noted rather than pretended to be covered.)
      const size = Math.ceil(text.length / options.fragments);
      for (let offset = 0; offset < text.length; offset += size) {
        const chunk = text.slice(offset, offset + size);
        socket.send(Buffer.from(chunk, 'utf8'), {
          binary: options.binary ?? false,
          fin: offset + size >= text.length,
        });
      }
      return;
    }
    socket.send(options.binary === true ? Buffer.from(text, 'utf8') : text, {
      binary: options.binary ?? false,
    });
  }

  /** Sends `hello` and waits for `welcome`. */
  handshake(): Promise<Frame> {
    this.send({
      type: 'hello',
      protocolVersion: 1,
      roomId: this.hub.roomId,
      clientNonce: `nonce-${this.player.userId}`,
    });
    return this.waitFor((frame) => frame.type === 'welcome', 'a welcome');
  }

  /** Takes a seat and waits for the ack. */
  async sit(seat: number): Promise<void> {
    const requestId = nextRequestId();
    this.send({ type: 'sit', seat, requestId });
    await this.waitFor((frame) => frame.type === 'ack' && frame['requestId'] === requestId, 'a sit ack');
  }

  /** Stands up and waits for the ack. */
  async stand(): Promise<void> {
    const requestId = nextRequestId();
    this.send({ type: 'stand', requestId });
    await this.waitFor((frame) => frame.type === 'ack' && frame['requestId'] === requestId, 'a stand ack');
  }

  startHand(): void {
    this.send({ type: 'startHand', requestId: nextRequestId() });
  }

  /** From now on, act whenever the server says it is this seat's turn. */
  play(policy: Policy): void {
    this.policy = policy;
  }

  private maybeAct(frame: Frame): void {
    const policy = this.policy;
    if (policy === null) return;
    const view = frame['view'];
    if (view === null || typeof view !== 'object') return;
    const record = view as Record<string, unknown>;
    const legal = record['legalActions'];
    if (!Array.isArray(legal) || legal.length === 0) return;
    if (record['toAct'] === null || record['toAct'] !== record['viewerSeat']) return;
    // The same decision point can arrive twice (an unrelated change re-sends the state). Acting on
    // it twice would earn a `stale_action_sequence` for the second, which is correct server
    // behaviour and would look like a client bug here.
    const key = `${String(record['handId'])}:${String(record['actionSequence'])}`;
    if (key === this.lastActedKey) return;
    this.lastActedKey = key;
    const chosen = policy(legal as readonly { type: string; minTo?: number }[]);
    const action: Record<string, unknown> = { type: chosen.type };
    if (chosen.to !== undefined) action['to'] = chosen.to;
    this.send({
      type: 'action',
      actionId: `act-${nextActionId()}`,
      expectedSequence: record['actionSequence'],
      requestId: nextRequestId(),
      action,
    });
  }

  /** The first frame, already received or yet to arrive, that matches. */
  waitFor(predicate: (frame: Frame) => boolean, what: string, timeoutMs = FRAME_TIMEOUT_MS): Promise<Frame> {
    const existing = this.frames.find(predicate);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `timed out after ${timeoutMs}ms waiting for ${what}; ` +
              `saw ${this.frames.map((frame) => frame.type).join(', ')} and closes ` +
              JSON.stringify(this.closes),
          ),
        );
      }, timeoutMs);
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

  waitForClose(timeoutMs = FRAME_TIMEOUT_MS): Promise<{ readonly code: number; readonly reason: string }> {
    const existing = this.closes.at(0);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the socket was never closed')), timeoutMs);
      timer.unref();
      this.closeWaiters.push((event) => {
        clearTimeout(timer);
        resolve(event);
      });
    });
  }

  /** The last frame of a type, for reading the final state. */
  last(type: string): Frame | null {
    return this.frames.filter((frame) => frame.type === type).at(-1) ?? null;
  }

  get text(): string {
    return this.raw.join('\n');
  }

  close(): void {
    this.socket?.close(1000, 'test complete');
  }
}

/**
 * One test identity.
 *
 * `id` is a readable slug rather than a number so a failure names the test it came from. The token
 * is long because `sessionCookieName`'s signed cookie is the real one and a short token would be
 * indistinguishable from a truncated signature while debugging.
 */
function player(id: string, displayName: string): Seated {
  return {
    userId: `usr_${id}`,
    displayName,
    token: `tok_socket_${id}_abcdefghijklmnop`,
    sessionId: `ses_${id}`,
  };
}

/** Waits until the table reports the hand complete, or fails saying where it got stuck. */
async function playToCompletion(clients: readonly SocketClient[], hub: Hub): Promise<Frame> {
  const owner = clients[0];
  assert.ok(owner !== undefined);
  owner.startHand();
  const complete = await owner.waitFor((frame) => {
    if (frame.type !== 'state') return false;
    const view = frame['view'];
    return (
      view !== null && typeof view === 'object' && (view as Record<string, unknown>)['street'] === 'complete'
    );
  }, 'a completed hand');
  assert.deepEqual(hub.problems, [], 'the table logged a problem while the hand was played');
  return complete;
}

/**
 * Asserts that a socket never saw a card it was not entitled to.
 *
 * `entitled` is built from the SERVER's own deal — not from the frames — so the check cannot be
 * satisfied by a leak that also widens the expectation. Everything else in the 52-card deck is
 * forbidden: the opponent's unshown holding, and every card that was never dealt at all, which is
 * what "no future deck state" means in practice.
 */
function assertSawOnly(client: SocketClient, entitled: ReadonlySet<Card>, label: string): void {
  const forbidden = orderedDeck().filter((card) => !entitled.has(card));
  assert.equal(entitled.size + forbidden.length, DECK_SIZE, 'the entitled set must be a subset of one deck');
  assert.ok(entitled.size >= 2, `${label} must at least have seen its own two cards`);

  const seen = new Set<Card>();
  for (const frame of client.frames) collectCards(frame, seen);
  const structural = [...seen].filter((card) => !entitled.has(card)).map(cardToString);
  assert.deepEqual(
    structural,
    [],
    `${label} received card values it is not entitled to: ${structural.join(', ')}`,
  );
  assert.ok(seen.size >= 2, `${label} saw no cards at all, so this scan proved nothing`);

  const text = client.text;
  const textual = forbidden.filter((card) => notationPattern(card).test(text)).map(cardToString);
  assert.deepEqual(
    textual,
    [],
    `${label} received the notation of a card it is not entitled to: ${textual.join(', ')}`,
  );

  const keys = new Set<string>();
  for (const frame of client.frames) collectKeys(frame, keys);
  const leakedKeys = FORBIDDEN_KEYS.filter((key) => keys.has(key));
  assert.deepEqual(leakedKeys, [], `${label} received a frame carrying ${leakedKeys.join(', ')}`);
}

/**
 * Asserts that none of `forbidden` ever reached this socket, in any field or as text.
 *
 * The looser sibling of `assertSawOnly`, for a recipient whose entitlement can legitimately be
 * empty — a spectator at a hand that ended before a flop is entitled to no card at all, and
 * `assertSawOnly` requires the recipient to have seen at least two so that its scan is provably
 * live. Here the scan is proved live by a separate socket in the same test, which received exactly
 * these cards and is required to have done so.
 */
function assertNeverReceived(client: SocketClient, forbidden: readonly Card[], label: string): void {
  assert.ok(forbidden.length > 0, `${label} has an empty forbidden set, so this scan proves nothing`);
  const seen = new Set<Card>();
  for (const frame of client.frames) collectCards(frame, seen);
  const structural = [...seen].filter((card) => forbidden.includes(card)).map(cardToString);
  assert.deepEqual(
    structural,
    [],
    `${label} received card values it must never see: ${structural.join(', ')}`,
  );

  const text = client.text;
  const textual = forbidden.filter((card) => notationPattern(card).test(text)).map(cardToString);
  assert.deepEqual(textual, [], `${label} received the notation of ${textual.join(', ')}`);
}

/** One seat as it appears inside a `state` frame's view. */
interface WireSeat {
  readonly seat: number;
  readonly playerId: string;
  readonly holeCards: readonly number[] | null;
  readonly isSelf: boolean;
}

interface WireView {
  readonly street: string;
  readonly handId: string;
  readonly viewerSeat: number | null;
  readonly seats: readonly WireSeat[];
  readonly result: { readonly showdowns: readonly { readonly seat: number }[] } | null;
}

/** The views out of every `state` frame this socket received, in order. */
function viewsReceivedBy(client: SocketClient): WireView[] {
  const views: WireView[] = [];
  for (const frame of client.frames) {
    if (frame.type !== 'state') continue;
    const view = frame['view'];
    if (view === null || typeof view !== 'object') continue;
    views.push(view as unknown as WireView);
  }
  return views;
}

/**
 * The property, over every frame a socket received: `isSelf` means "that seat's player IS me".
 *
 * Asserted on `playerId` rather than on the seat index deliberately. A recipient's seat index is
 * whatever the server says it is, so an implementation that mixed up two rosters would satisfy an
 * index-based check by construction; the user id is the one thing in the frame that the recipient
 * and the server independently agree on. Hole cards are then required to be absent everywhere the
 * flag is false and the seat did not show down — so the flag cannot be right while the cards are
 * wrong, or the other way about.
 */
function assertSelfMeansIdentity(client: SocketClient, userId: string, label: string): void {
  const views = viewsReceivedBy(client);
  assert.ok(views.length > 0, `${label} received no state frame, so this check proves nothing`);
  for (const view of views) {
    const shown = new Set(
      view.street === 'complete' ? (view.result?.showdowns ?? []).map((entry) => entry.seat) : [],
    );
    const own = view.seats.find((seat) => seat.playerId === userId) ?? null;
    assert.equal(
      view.viewerSeat,
      own?.seat ?? null,
      `${label} was told it holds seat ${String(view.viewerSeat)} in hand ${view.handId}, which it does not`,
    );
    for (const seat of view.seats) {
      assert.equal(
        seat.isSelf,
        seat.playerId === userId,
        `${label}: seat ${seat.seat} belongs to ${seat.playerId} but was marked isSelf=${seat.isSelf}`,
      );
      if (seat.playerId === userId || shown.has(seat.seat)) continue;
      assert.equal(
        seat.holeCards,
        null,
        `${label} received ${seat.playerId}'s hole cards from seat ${seat.seat} in ${view.street}`,
      );
    }
  }
}

/**
 * What a seat is entitled to see, from the server's own state.
 *
 * Own hole cards, the board as dealt, and the hole cards of seats that actually showed at showdown —
 * which is exactly `redactFor`'s contract, read from the table rather than from the wire.
 */
function entitlementFor(hub: Hub, userId: string): Set<Card> {
  const table = hub.room.table;
  const view = table.viewFor(userId);
  assert.ok(view !== null, 'the table has no hand to read an entitlement from');
  const entitled = new Set<Card>(view.board);
  const deal = table.archivedDeal();
  assert.ok(deal !== null, 'the table has no deal to read');
  const own = deal.seats.find((seat) => seat.userId === userId);
  assert.ok(own !== undefined, `${userId} is not seated in the deal`);
  // A seat that was dealt in always holds two cards; the type is nullable because a seat can be
  // sitting out. Asserted rather than defaulted, because an empty entitlement would make the leak
  // scan below stricter by accident and mask what actually happened.
  assert.ok(own.holeCards !== null, `${userId} was dealt no cards, so there is no entitlement to build`);
  for (const card of own.holeCards) entitled.add(card);
  const shown = new Set((view.result?.showdowns ?? []).map((showdown) => showdown.seat));
  for (const seat of deal.seats) {
    if (!shown.has(seat.seat) || seat.holeCards === null) continue;
    for (const card of seat.holeCards) entitled.add(card);
  }
  return entitled;
}

// ---------------------------------------------------------------------------
// The upgrade, for real
// ---------------------------------------------------------------------------

describe('the real WebSocket upgrade', () => {
  it('completes the handshake and answers hello with a welcome and the current view', async () => {
    const ada = player('handshake_a', 'Ada');
    const hub = await startHub({ players: [ada], idPrefix: 'hs' });
    const client = new SocketClient(hub, ada);
    await client.connect();

    const welcome = await client.handshake();
    assert.equal(welcome['userId'], ada.userId);
    assert.equal(welcome['protocolVersion'], 1);
    assert.equal(welcome['clientNonce'], `nonce-${ada.userId}`);
    const room = welcome['room'] as { id: string; visibility: string };
    assert.equal(room.id, hub.roomId);
    assert.equal(room.visibility, 'invite_only');
    // The welcome is followed by the current state, which is what makes reconnect trivial.
    const state = await client.waitFor((frame) => frame.type === 'state', 'the first state frame');
    assert.equal(state['revision'], 1);
    client.close();
  });

  it('refuses an upgrade with no session cookie, and one from a foreign origin', async () => {
    const ada = player('refusals', 'Ada');
    const hub = await startHub({ players: [ada], idPrefix: 'rf' });

    const anonymous = new SocketClient(hub, ada);
    await anonymous.connect({ cookie: null });
    const noCookie = await anonymous.waitForClose();
    assert.equal(noCookie.code, WS_CLOSE.unauthenticated, 'no cookie must close 4401');
    assert.equal(anonymous.frames.length, 0, 'a refused upgrade must receive no frame at all');

    const foreign = new SocketClient(hub, ada);
    await foreign.connect({ origin: 'https://evil.example.test' });
    const badOrigin = await foreign.waitForClose();
    assert.equal(badOrigin.code, WS_CLOSE.badOrigin, 'a foreign origin must close 4406');

    // A cookie this server never signed. The signature is checked before any lookup, so this is the
    // `malformed` path rather than the `unknown` one — and either way the upgrade is refused.
    const forged = new SocketClient(hub, ada);
    await forged.connect({ cookie: `${sessionCookieName(testConfig())}=tok_forged.not-a-signature` });
    const tampered = await forged.waitForClose();
    assert.equal(tampered.code, WS_CLOSE.unauthenticated, 'a cookie we did not sign must close 4401');
  });

  it('accepts a binary and a fragmented frame, and answers both', async () => {
    const ada = player('frames', 'Ada');
    const hub = await startHub({ players: [ada], idPrefix: 'fr' });
    const client = new SocketClient(hub, ada);
    await client.connect();
    await client.handshake();

    client.send({ type: 'ping', nonce: 'nonce-binary1' }, { binary: true });
    const binaryPong = await client.waitFor(
      (frame) => frame.type === 'pong' && frame['nonce'] === 'nonce-binary1',
      'a pong for the binary frame',
    );
    assert.equal(binaryPong['nonce'], 'nonce-binary1');

    client.send({ type: 'ping', nonce: 'nonce-fragment' }, { fragments: 4 });
    const fragmentedPong = await client.waitFor(
      (frame) => frame.type === 'pong' && frame['nonce'] === 'nonce-fragment',
      'a pong for the fragmented frame',
    );
    assert.equal(fragmentedPong['nonce'], 'nonce-fragment');
    client.close();
  });

  it('counts sockets per session, refuses the one over the cap, and frees the slot on close', async () => {
    const ada = player('cap', 'Ada');
    const hub = await startHub({ players: [ada], idPrefix: 'cp' });
    const cap = WS_LIMITS.maxSocketsPerSession;

    // The counter is the hub's own `bySession` map, which no previous test ever exercised: the cap
    // was only ever asserted by handing `socketsForSession` to a pure function.
    const held: SocketClient[] = [];
    for (let index = 0; index < cap; index += 1) {
      const client = new SocketClient(hub, ada);
      await client.connect();
      await client.handshake();
      held.push(client);
    }

    const overCap = new SocketClient(hub, ada);
    await overCap.connect();
    const refused = await overCap.waitForClose();
    assert.equal(refused.code, WS_CLOSE.rateLimited, `socket ${cap + 1} of one session must close 4429`);

    // Close one and the slot must come back. If the decrement or the `delete` at zero were missing,
    // a user who reconnected `cap` times would be locked out of their own table for ever.
    const released = held.pop();
    assert.ok(released !== undefined);
    released.close();
    await released.waitForClose();

    const reconnected = new SocketClient(hub, ada);
    await reconnected.connect();
    const welcome = await reconnected.handshake();
    assert.equal(welcome['userId'], ada.userId, 'closing a socket must free its slot');

    for (const client of [...held, reconnected]) client.close();
  });
});

// ---------------------------------------------------------------------------
// The journey: sit, play a hand against a bot, read the result
// ---------------------------------------------------------------------------

describe('a whole hand over a real socket', () => {
  it('sits, plays to completion against a bot, and reports a settled terminal state', async () => {
    const ada = player('journey', 'Ada');
    const hub = await startHub({ players: [ada], idPrefix: 'jy' });
    await seatBot(hub, 1);

    const client = new SocketClient(hub, ada);
    await client.connect();
    await client.handshake();
    await client.sit(0);
    client.play(PASSIVE);

    const complete = await playToCompletion([client], hub);
    const view = complete['view'] as {
      street: string;
      handId: string;
      config: { smallBlind: number; bigBlind: number };
      seats: readonly {
        seat: number;
        stack: number;
        committedTotal: number;
        holeCards: readonly number[] | null;
      }[];
      result: {
        netBySeat: Readonly<Record<string, number>>;
        pots: readonly { amount: number }[];
        awards: readonly { seat: number; amount: number }[];
        endedByFold: boolean;
        showdowns: readonly { seat: number }[];
      } | null;
    };

    assert.equal(view.street, 'complete', 'the terminal street is `complete`');
    assert.ok(view.result !== null, 'a completed hand carries a result');
    const result = view.result;
    // Chips are conserved: every hand is a zero-sum transfer between the seats.
    const net = Object.values(result.netBySeat).reduce((total, value) => total + value, 0);
    assert.equal(net, 0, `the hand must not create or destroy chips, netBySeat summed to ${net}`);
    const awarded = result.awards.reduce((total, award) => total + award.amount, 0);
    assert.ok(awarded > 0, 'a completed hand awards the pot to somebody');
    assert.ok(
      result.endedByFold || result.showdowns.length >= 2,
      'a hand that did not end by a fold must have shown at least two hands down',
    );
    // Chips really moved: the blinds were posted, every chip in every pot was paid out, and each
    // seat closed on exactly the stack its net says it should have. A "completed" hand in which
    // nothing actually happened fails all three, and every other assertion here would still pass.
    //
    // ## Why this is no longer "somebody's stack changed"
    //
    // It used to be `stacks.some((stack) => stack !== 1_000)`, and that is NOT a property of a
    // settled hand — it is a property of a settled hand *somebody won*. A CHOPPED pot returns
    // every seat exactly what it put in, so both seats close on the 1,000 they started with while
    // the hand was completely normal. The deal here is a real CSPRNG deal, so that outcome arrived
    // on its own schedule: it was measured on 2 of 40 runs of this file in isolation, and on 15 of
    // 400 hands of this same line-up driven through the table directly. The captured terminal view
    // of a failing run is unambiguous — two seats dealt in, `smallBlind 5` and `bigBlind 10` in
    // `forcedBets`, eight logged actions, a 50-chip pot, and a board of 5d 5s 4s 4h Ad that played
    // for both 6sTc and 3hTs, so both `showdowns` carry the same score and the same `bestFive` and
    // `awards` is 25 each with `wasSplit: true`. Nothing was wrong except the expectation.
    //
    // A release gate that fails nondeterministically cannot tell a regression from noise, so the
    // fix is not to retry or to relax: it is to assert the thing the comment always meant. These
    // three are strictly stronger than the check they replace. A hand whose blinds were never
    // posted commits nothing and fails the first; a pot that is formed and then not paid out fails
    // the second (the old check passed happily as long as *some* stack differed); and a settlement
    // that credits the wrong seat, or credits nobody, fails the third — which the old check could
    // not see at all, and which was verified by mutation: withholding one seat's award in the
    // engine's `settle` left the old predicate perfectly happy and fails this one. None of the
    // three can be satisfied by a hand that never started.
    const committed = view.seats.reduce((total, seat) => total + seat.committedTotal, 0);
    assert.ok(
      committed >= view.config.smallBlind + view.config.bigBlind,
      `the blinds were never posted: the seats committed ${committed} in total`,
    );
    const potted = result.pots.reduce((total, pot) => total + pot.amount, 0);
    assert.equal(awarded, potted, 'every chip in every pot is awarded to somebody');
    assert.deepEqual(
      view.seats.map((seat) => seat.stack),
      view.seats.map((seat) => 1_000 + (result.netBySeat[seat.seat] ?? 0)),
      'every seat closes on the stack it started with plus its net for the hand',
    );
    // The action log has real actions in it, so "complete" did not mean "never started".
    assert.ok(client.actionsAcked.length >= 1, 'the player acted at least once and was acked');

    assertSawOnly(client, entitlementFor(hub, ada.userId), 'the seated player');
    client.close();
  });
});

// ---------------------------------------------------------------------------
// The guarantee, over the wire
// ---------------------------------------------------------------------------

describe('hidden information over a live socket', () => {
  it('never sends either of two sessions the other’s hole cards or any undealt card', async () => {
    const ada = player('two_a', 'Ada');
    const bo = player('two_b', 'Bo');
    const hub = await startHub({ players: [ada, bo], idPrefix: 'hi' });

    const first = new SocketClient(hub, ada);
    const second = new SocketClient(hub, bo);
    await first.connect();
    await first.handshake();
    await first.sit(0);
    await second.connect();
    await second.handshake();
    await second.sit(1);
    first.play(PASSIVE);
    second.play(PASSIVE);

    const complete = await playToCompletion([first, second], hub);
    const finalView = complete['view'] as { street: string };
    assert.equal(finalView.street, 'complete');

    // Every frame, in order: a seat's cards may be present only for its own recipient, or after a
    // showdown that seat actually took part in. Checked on nullness, so it cannot be satisfied by a
    // leak that also widened the expectation.
    for (const [client, ownSeat] of [
      [first, 0],
      [second, 1],
    ] as const) {
      let framesChecked = 0;
      for (const frame of client.frames) {
        if (frame.type !== 'state') continue;
        const view = frame['view'];
        if (view === null || typeof view !== 'object') continue;
        const record = view as {
          street: string;
          seats: readonly { seat: number; holeCards: readonly number[] | null }[];
          result: { showdowns: readonly { seat: number }[] } | null;
        };
        framesChecked += 1;
        const shown = new Set(
          record.street === 'complete' ? (record.result?.showdowns ?? []).map((s) => s.seat) : [],
        );
        for (const seat of record.seats) {
          const permitted = seat.seat === ownSeat || shown.has(seat.seat);
          if (permitted) continue;
          assert.equal(
            seat.holeCards,
            null,
            `seat ${ownSeat} received seat ${seat.seat}'s hole cards during ${record.street}`,
          );
        }
      }
      assert.ok(framesChecked >= 2, 'expected several state frames to check, not one');
    }

    assertSawOnly(first, entitlementFor(hub, ada.userId), 'seat 0');
    assertSawOnly(second, entitlementFor(hub, bo.userId), 'seat 1');

    // The scan is proved to fire, on this very frame stream rather than on a fixture. Seat 0's own
    // first card is certainly in its frames, so narrowing the entitlement by exactly that one card
    // must be reported — a scan that silently matched nothing would satisfy every assertion above
    // while proving nothing at all. (The alternative check, flipping `redactFor` and re-running, is
    // not available here: `packages/poker-engine/src` belongs to another workstream.)
    const deal = hub.room.table.archivedDeal();
    assert.ok(deal !== null);
    const ownFirstCard = deal.seats.find((seat) => seat.userId === ada.userId)?.holeCards?.[0];
    assert.ok(ownFirstCard !== undefined, 'seat 0 must hold cards to narrow the entitlement by');
    const narrowed = new Set(entitlementFor(hub, ada.userId));
    narrowed.delete(ownFirstCard);
    assert.throws(
      () => assertSawOnly(first, narrowed, 'a deliberately narrowed entitlement'),
      new RegExp(`not entitled to[^\\n]*${cardToString(ownFirstCard)}`),
      'the leak scan must fire on a card the socket received but was not entitled to',
    );

    // And the two sockets genuinely received different pictures. One shared view object serialised
    // to both — the mistake `broadcast` is written to prevent — would be identical text.
    const firstState = first.last('state');
    const secondState = second.last('state');
    assert.ok(firstState !== null && secondState !== null);
    assert.notEqual(
      JSON.stringify(firstState['view']),
      JSON.stringify(secondState['view']),
      'two recipients must not receive one shared view',
    );

    first.close();
    second.close();
  });

  it('reveals nothing at all when the hand ends by a fold', async () => {
    const ada = player('fold_a', 'Ada');
    const bo = player('fold_b', 'Bo');
    const hub = await startHub({ players: [ada, bo], idPrefix: 'fd' });

    const first = new SocketClient(hub, ada);
    const second = new SocketClient(hub, bo);
    await first.connect();
    await first.handshake();
    await first.sit(0);
    await second.connect();
    await second.handshake();
    await second.sit(1);
    // Whoever is asked to act first folds; the other never has to act.
    first.play(FOLD_AT_ONCE);
    second.play(FOLD_AT_ONCE);

    const complete = await playToCompletion([first, second], hub);
    const view = complete['view'] as {
      result: { endedByFold: boolean; showdowns: readonly unknown[] } | null;
    };
    assert.ok(view.result !== null);
    assert.equal(view.result.endedByFold, true, 'this hand is meant to end by a fold');
    assert.equal(
      view.result.showdowns.length,
      0,
      'a folded hand shows nothing — revealing it would say whether the folder was bluffing',
    );

    // Ground truth: with no showdown, each socket is entitled to its own two cards and the board,
    // and to nothing else in the deck — including the other player's holding, which stays private
    // permanently rather than until the hand ends.
    assertSawOnly(first, entitlementFor(hub, ada.userId), 'the folded hand’s seat 0');
    assertSawOnly(second, entitlementFor(hub, bo.userId), 'the folded hand’s seat 1');
    assertSelfMeansIdentity(first, ada.userId, 'the folded hand’s seat 0');
    assertSelfMeansIdentity(second, bo.userId, 'the folded hand’s seat 1');

    first.close();
    second.close();
  });
});

// ---------------------------------------------------------------------------
// The guarantee when the seating moves underneath a finished hand
// ---------------------------------------------------------------------------

describe('a chair that changes owner over a live socket', () => {
  it('never sends the new occupant the previous occupant’s cards, and survives a reconnect', async () => {
    const ada = player('reuse_a', 'Ada');
    const bo = player('reuse_b', 'Bo');
    const hub = await startHub({ players: [ada, bo], idPrefix: 'sr' });
    // The bot is seated first, so the button lands on Ada: heads-up the button posts the small
    // blind and acts first, which makes Ada the one who is offered the first decision and folds it.
    await seatBot(hub, 1);

    const first = new SocketClient(hub, ada);
    await first.connect();
    await first.handshake();
    await first.sit(0);

    // Bo watches the whole thing from the start without a seat, so his frames cover the live hand
    // as well as everything after it.
    const watcher = new SocketClient(hub, bo);
    await watcher.connect();
    await watcher.handshake();

    first.play(FOLD_AT_ONCE);
    const complete = await playToCompletion([first], hub);
    const finished = complete['view'] as {
      handId: string;
      street: string;
      result: { endedByFold: boolean; showdowns: readonly unknown[] } | null;
    };
    assert.equal(finished.street, 'complete');
    assert.equal(finished.result?.endedByFold, true, 'this hand is meant to end by a fold');
    assert.equal(finished.result?.showdowns.length, 0, 'so nobody’s cards ever became public');

    // Ground truth for the rest of the test: the cards Ada was actually dealt, from the server's
    // own deal record rather than from anything that went over a wire.
    const deal = hub.room.table.archivedDeal();
    assert.ok(deal !== null);
    const adaCards = deal.seats.find((seat) => seat.userId === ada.userId)?.holeCards ?? null;
    assert.ok(adaCards !== null && adaCards.length === 2, 'Ada must hold two cards to leak');

    // Ada stands. The hand is over, so the chair is released immediately.
    await first.stand();
    assert.equal(hub.room.table.seatOf(ada.userId), null, 'Ada gave up the chair');

    // A reconnect is a new socket for the same session. Identity is what carries entitlement, so
    // Ada's own hand comes back to her over the new socket even though she no longer holds a chair.
    first.close();
    await first.waitForClose();
    const reconnected = new SocketClient(hub, ada);
    await reconnected.connect();
    await reconnected.handshake();
    const resumed = await reconnected.waitFor((frame) => frame.type === 'state', 'the reconnected state');
    const resumedView = resumed['view'] as WireView;
    assert.equal(resumedView.handId, finished.handId, 'the reconnect lands on the retained hand');
    const adaSeat = resumedView.seats.find((seat) => seat.playerId === ada.userId);
    assert.equal(adaSeat?.isSelf, true, 'Ada is still Ada after a reconnect');
    assert.deepEqual(
      [...(adaSeat?.holeCards ?? [])].sort((left, right) => left - right),
      [...adaCards].sort((left, right) => left - right),
      'Ada must still be shown the hand she played',
    );

    // Bo now takes the chair Ada just left, while her finished hand is still in memory. This is the
    // frame the defect leaked on, so it has to be a frame from AFTER the sit — Bo has been watching
    // as a spectator all along and every one of those earlier frames says `viewerSeat: null`
    // legitimately, which would satisfy the assertions below while proving nothing.
    const beforeSitting = new Set(watcher.frames);
    await watcher.sit(0);
    assert.equal(hub.room.table.seatOf(bo.userId), 0, 'Bo holds the chair Ada played');
    const afterSitting = await watcher.waitFor(
      (frame) => frame.type === 'state' && !beforeSitting.has(frame),
      'a state frame issued after Bo took the chair',
    );
    const boView = afterSitting['view'] as WireView;
    assert.equal(boView.handId, finished.handId, 'Bo is being shown the retained finished hand');
    assert.equal(boView.street, 'complete');

    // The two rosters genuinely disagree, which is what makes this test worth having: the table's
    // seat 0 is Bo, and the retained hand's seat 0 is Ada.
    assert.equal(
      boView.seats.find((seat) => seat.seat === 0)?.playerId,
      ada.userId,
      'the retained hand must still record Ada in seat 0',
    );
    assert.equal(boView.viewerSeat, null, 'Bo was not in that hand, so Bo is a spectator of it');
    assert.deepEqual(
      boView.seats.filter((seat) => seat.isSelf),
      [],
      'no seat of a hand Bo never played may be marked as Bo’s own',
    );

    // Every frame Bo ever received — spectating the live hand and after taking the chair — checked
    // as a property, then as raw card values, then as text.
    assertSelfMeansIdentity(watcher, bo.userId, 'the new occupant');
    const publicBoard = new Set(hub.room.table.viewFor(bo.userId)?.board ?? []);
    assertNeverReceived(
      watcher,
      orderedDeck().filter((card) => !publicBoard.has(card)),
      'the new occupant',
    );

    // And the scan is proved live on this very frame stream: the same two cards ARE detectable, in
    // the frames of the one session entitled to them.
    const adaSeen = new Set<Card>();
    for (const frame of reconnected.frames) collectCards(frame, adaSeen);
    assert.deepEqual(
      adaCards.filter((card) => !adaSeen.has(card)).map(cardToString),
      [],
      'Ada’s own socket must carry her cards, or the scan above proves nothing',
    );
    assert.throws(
      () => assertNeverReceived(reconnected, adaCards, 'a deliberately mis-scoped recipient'),
      /must never see/,
      'the leak scan must fire on a socket that did receive these cards',
    );

    assert.deepEqual(hub.problems, [], 'none of this may log a problem');
    reconnected.close();
    watcher.close();
  });
});

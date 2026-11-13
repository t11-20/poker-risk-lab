/**
 * The socket client's three load-bearing decisions, driven through the `RawSocketFactory` and
 * `Scheduler` seams with a fake clock. Every frame is narrowed and a refusal names the member, a retry
 * carries the same `actionId`, and a `4401` close never schedules a reconnect. React and rendering
 * were verified in a real browser and are not asserted here.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WS_CLOSE, WS_LIMITS, WS_PROTOCOL_VERSION } from '@prl/contracts';
import {
  describeClose,
  newRequestId,
  openTableSocket,
  type RawSocket,
  type RawSocketHandlers,
  readServerMessage,
  type Scheduler,
  tableSocketUrl,
} from '../src/lib/table-socket.ts';

interface FakeSocket extends RawSocket {
  readonly sent: string[];
  readonly closes: { readonly code: number | undefined; readonly reason: string | undefined }[];
}

interface Harness {
  readonly sockets: FakeSocket[];
  readonly handlers: RawSocketHandlers[];
  readonly urls: string[];
}

function harness(): {
  readonly rig: Harness;
  readonly factory: (url: string, h: RawSocketHandlers) => RawSocket;
} {
  const rig: Harness = { sockets: [], handlers: [], urls: [] };
  return {
    rig,
    factory: (url, handlers) => {
      const sent: string[] = [];
      const closes: { code: number | undefined; reason: string | undefined }[] = [];
      const socket: FakeSocket = {
        sent,
        closes,
        send: (data) => sent.push(data),
        close: (code, reason) => closes.push({ code, reason }),
      };
      rig.urls.push(url);
      rig.sockets.push(socket);
      rig.handlers.push(handlers);
      return socket;
    },
  };
}

/** A clock that only moves when a test tells it to, so a 15-second backoff costs no seconds. */
function fakeScheduler(): Scheduler & {
  readonly run: (label?: string) => void;
  readonly pending: () => number;
} {
  let now = 1_000;
  let queue: { at: number; run: () => void; cancelled: boolean }[] = [];
  return {
    now: () => now,
    delay: (ms, run) => {
      const entry = { at: now + ms, run, cancelled: false };
      queue.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    run: () => {
      const live = queue.filter((entry) => !entry.cancelled);
      if (live.length === 0) return;
      const soonest = Math.min(...live.map((entry) => entry.at));
      const due = live.filter((entry) => entry.at === soonest);
      now = soonest;
      queue = queue.filter((entry) => !due.includes(entry));
      for (const entry of due) entry.run();
    },
    pending: () => queue.filter((entry) => !entry.cancelled).length,
  };
}

const ROOM = 'room_test0001';

/** A `state` frame the narrower accepts, so a test can vary one member at a time. */
function stateFrame(overrides: Record<string, unknown> = {}): string {
  const view = {
    handId: 'hand_1',
    roomId: ROOM,
    handNumber: 1,
    config: { smallBlind: 5, bigBlind: 10, ante: 0, maxSeats: 6, actionTimeoutSeconds: 60 },
    street: 'flop',
    board: [0, 13, 26],
    buttonSeat: 0,
    seats: [
      {
        seat: 0,
        playerId: 'usr_a',
        stack: 990,
        committedThisStreet: 0,
        committedTotal: 10,
        status: 'active',
        position: 'BTN',
        holeCards: [51, 50],
        isSelf: true,
        isButton: true,
        isToAct: true,
      },
    ],
    toAct: 0,
    betLevel: 0,
    minimumRaiseTo: 20,
    potTotal: 30,
    pots: [{ amount: 30, eligibleSeats: [0], capPerSeat: 15, index: 0 }],
    forcedBets: [],
    actions: [],
    actionSequence: 4,
    legalActions: [{ type: 'check' }],
    amountToCall: 0,
    commitmentRoot: 'abc',
    commitmentContext: 'ctx',
    result: null,
    viewerSeat: 0,
    randomSourceKind: 'csprng',
    ...overrides,
  };
  return JSON.stringify({
    type: 'state',
    view,
    room: {
      id: ROOM,
      name: 'Bot table',
      ownerUserId: 'usr_a',
      maxSeats: 6,
      smallBlind: 5,
      bigBlind: 10,
      ante: 0,
      startingStack: 1000,
      actionTimeoutSeconds: 60,
      status: 'playing',
      visibility: 'invite_only',
      members: [],
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    deadlineMs: 2_000,
    serverTimeMs: 1_000,
    revision: 1,
  });
}

test('the socket URL is same-origin and its scheme is derived from the page', () => {
  assert.equal(
    tableSocketUrl({ protocol: 'http:', host: 'localhost:3000' }),
    'ws://localhost:3000/api/v1/ws',
  );
  assert.equal(
    tableSocketUrl({ protocol: 'https:', host: 'poker.example' }),
    'wss://poker.example/api/v1/ws',
  );
  // A secure page must never open an insecure socket, which the browser blocks as mixed content.
  assert.ok(!tableSocketUrl({ protocol: 'https:', host: 'x.test' }).startsWith('ws:'));
});

test('a frame that is not JSON, not an object, or names no known type is refused', () => {
  for (const raw of ['not json', '[]', '"a string"', '{"type":"gotcha"}', '{}']) {
    const outcome = readServerMessage(raw);
    assert.equal(outcome.ok, false, `expected ${raw} to be refused`);
  }
});

test('a well-formed state frame is accepted and its view survives narrowing', () => {
  const outcome = readServerMessage(stateFrame());
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.frame.type, 'state');
  if (outcome.frame.type !== 'state') return;
  assert.equal(outcome.frame.view?.actionSequence, 4);
  assert.equal(outcome.frame.revision, 1);
});

test('a state frame whose view has a member of the wrong type is refused, not coerced', () => {
  // `potTotal` as a string is the shape a lenient client would render as "NaN units".
  assert.equal(readServerMessage(stateFrame({ potTotal: '30' })).ok, false);
  // A card outside the deck is not a card.
  assert.equal(readServerMessage(stateFrame({ board: [0, 13, 99] })).ok, false);
  assert.equal(readServerMessage(stateFrame({ street: 'fourth' })).ok, false);
});

test('a state frame carrying an opponent’s hole cards is refused, and the refusal is not silent', () => {
  // The shape is valid and the content is a leak. `test/hole-card-entitlement.test.ts` owns the rule.
  // This asserts the seats reach the caller, so `use-live-table.ts` need not parse a sentence.
  const leaking = stateFrame({
    seats: [
      {
        seat: 0,
        playerId: 'usr_a',
        stack: 990,
        committedThisStreet: 0,
        committedTotal: 10,
        status: 'active',
        position: 'BTN',
        holeCards: [51, 50],
        isSelf: true,
        isButton: true,
        isToAct: true,
      },
      {
        seat: 1,
        playerId: 'usr_b',
        stack: 990,
        committedThisStreet: 0,
        committedTotal: 10,
        status: 'active',
        position: 'BB',
        holeCards: [4, 5],
        isSelf: false,
        isButton: false,
        isToAct: false,
      },
    ],
  });

  const { rig, factory } = harness();
  const rejections: { claimedType: string | null; seats: readonly number[] | undefined }[] = [];
  const frames: string[] = [];
  const handle = openTableSocket({
    roomId: ROOM,
    url: 'ws://x/api/v1/ws',
    onFrame: (frame) => frames.push(frame.type),
    onStatus: () => undefined,
    onClose: () => undefined,
    onRejected: (rejection) =>
      rejections.push({ claimedType: rejection.claimedType, seats: rejection.unentitledSeats }),
    socketFactory: factory,
    scheduler: fakeScheduler(),
  });
  rig.handlers[0]?.onOpen();
  rig.handlers[0]?.onMessage(leaking);

  assert.deepEqual(frames, [], 'nothing reached the renderer');
  assert.deepEqual(rejections, [{ claimedType: 'state', seats: [1] }]);
  handle.dispose();
});

test('an ack distinguishes "applied" from "deduplicated" and omits what it was not sent', () => {
  const plain = readServerMessage('{"type":"ack","requestId":"req-1","appliedSequence":7}');
  assert.equal(plain.ok, true);
  if (!plain.ok || plain.frame.type !== 'ack') return assert.fail('expected an ack');
  assert.equal(plain.frame.appliedSequence, 7);
  assert.equal('deduplicated' in plain.frame, false);

  const retry = readServerMessage(
    '{"type":"ack","requestId":"req-1","appliedSequence":7,"deduplicated":true}',
  );
  assert.equal(retry.ok, true);
  if (!retry.ok || retry.frame.type !== 'ack') return assert.fail('expected an ack');
  assert.equal(retry.frame.deduplicated, true);
});

/** A coach report, with the pot-odds members a caller wants to vary. */
function coachFrame(potOdds: Record<string, unknown>): string {
  const report = {
    street: 'flop',
    potTotal: 20,
    toCall: potOdds['toCall'],
    outs: null,
    equity: {},
    potOdds,
    candidates: [],
    suggestion: {},
    stackContext: {},
    assumptions: ['a'],
    uncertainty: {},
    teachingNotes: [],
  };
  return JSON.stringify({ type: 'coach', requestId: 'req-1', report });
}

/**
 * `oddsRatio` is `number | null` in `@prl/contracts`, and `null` means the call is free. It was once
 * `Infinity`, which `JSON.stringify` turns into `null`, and this client refused such frames. A check
 * spot's report must now be accepted, and that refusal must not creep back.
 */
test('a coach report with a null oddsRatio is accepted: null is the contract, not a defect', () => {
  const outcome = readServerMessage(
    coachFrame({
      pot: 20,
      toCall: 0,
      breakEvenEquity: 0,
      oddsRatio: null,
      equitySurplus: 0.2,
      explanation: 'x',
    }),
  );
  assert.equal(outcome.ok, true, 'a free-call report is a valid frame and must reach the panel');
  if (!outcome.ok || outcome.frame.type !== 'coach') return assert.fail('expected a coach frame');
  assert.equal(outcome.frame.report.potOdds.oddsRatio, null, 'the null must survive narrowing intact');
});

test('a coach report with a finite oddsRatio is accepted', () => {
  const outcome = readServerMessage(
    coachFrame({
      pot: 20,
      toCall: 5,
      breakEvenEquity: 0.2,
      oddsRatio: 4,
      equitySurplus: 0.1,
      explanation: 'x',
    }),
  );
  assert.equal(outcome.ok, true);
  if (!outcome.ok || outcome.frame.type !== 'coach') return assert.fail('expected a coach frame');
  assert.equal(outcome.frame.report.potOdds.oddsRatio, 4);
});

test('a coach report whose oddsRatio is neither a number nor null is still refused', () => {
  // Widening to `number | null` added exactly one value, so anything else is still refused by name.
  // `NaN` is not listed, because `JSON.stringify(NaN)` is `"null"` and it cannot arrive.
  for (const ratio of ['4', true, {}, [], undefined]) {
    const outcome = readServerMessage(
      coachFrame({
        pot: 20,
        toCall: 5,
        breakEvenEquity: 0.2,
        oddsRatio: ratio,
        equitySurplus: 0.1,
        explanation: 'x',
      }),
    );
    assert.equal(outcome.ok, false, `oddsRatio of ${JSON.stringify(ratio)} must be refused`);
    if (outcome.ok) continue;
    assert.equal(outcome.rejection.claimedType, 'coach');
    assert.match(outcome.rejection.reason, /potOdds\.oddsRatio/);
  }
});

test('every close code the server can send produces its own message', () => {
  const codes = Object.values(WS_CLOSE);
  const titles = codes.map((code) => describeClose(code, true).title);
  assert.equal(new Set(titles).size, titles.length, `titles repeat: ${titles.join(' | ')}`);
  for (const detail of codes.map((code) => describeClose(code, true).detail)) {
    assert.ok(detail.length > 40, 'a close message must say what happened, not just that it happened');
  }
});

test('the codes a reader cannot retry past are not retried, and the ones they can are', () => {
  for (const code of [
    WS_CLOSE.protocolMismatch,
    WS_CLOSE.unauthenticated,
    WS_CLOSE.forbidden,
    WS_CLOSE.badOrigin,
  ]) {
    assert.equal(describeClose(code, true).retryable, false, `${code} must not be retried`);
  }
  for (const code of [WS_CLOSE.serverShuttingDown, WS_CLOSE.rateLimited, WS_CLOSE.handshakeTimeout, 1006]) {
    assert.equal(describeClose(code, false).retryable, true, `${code} must be retried`);
  }
  assert.equal(describeClose(WS_CLOSE.unauthenticated, true).action, 'signIn');
  assert.equal(describeClose(WS_CLOSE.protocolMismatch, true).action, 'reload');
});

test('the first frame is hello, carrying the protocol version and the room', () => {
  const { rig, factory } = harness();
  const scheduler = fakeScheduler();
  const handle = openTableSocket({
    roomId: ROOM,
    url: 'ws://x/api/v1/ws',
    onFrame: () => undefined,
    onStatus: () => undefined,
    onClose: () => undefined,
    socketFactory: factory,
    scheduler,
  });
  rig.handlers[0]?.onOpen();
  const first: unknown = JSON.parse(rig.sockets[0]?.sent[0] ?? '{}');
  assert.deepEqual(first, {
    type: 'hello',
    protocolVersion: WS_PROTOCOL_VERSION,
    roomId: ROOM,
    clientNonce: (first as { clientNonce: string }).clientNonce,
  });
  assert.match((first as { clientNonce: string }).clientNonce, /^[A-Za-z0-9_-]{8,64}$/);
  handle.dispose();
});

test('nothing but hello is sent before the socket is open, and dispose stops everything', () => {
  const { rig, factory } = harness();
  const scheduler = fakeScheduler();
  const handle = openTableSocket({
    roomId: ROOM,
    url: 'ws://x/api/v1/ws',
    onFrame: () => undefined,
    onStatus: () => undefined,
    onClose: () => undefined,
    socketFactory: factory,
    scheduler,
  });
  handle.dispose();
  assert.equal(rig.sockets[0]?.closes.length, 1);
  // A leaked socket per navigation reaches the four-per-session cap in four page views.
  rig.handlers[0]?.onClose(1006, 'gone', false);
  scheduler.run();
  assert.equal(rig.sockets.length, 1);
});

test('a retryable close reconnects with backoff; a non-retryable one does not reconnect at all', () => {
  const { rig, factory } = harness();
  const scheduler = fakeScheduler();
  const statuses: string[] = [];
  const handle = openTableSocket({
    roomId: ROOM,
    url: 'ws://x/api/v1/ws',
    onFrame: () => undefined,
    onStatus: (status) => statuses.push(status),
    onClose: () => undefined,
    socketFactory: factory,
    scheduler,
  });
  rig.handlers[0]?.onOpen();
  rig.handlers[0]?.onClose(1006, 'dropped', false);
  assert.ok(statuses.includes('reconnecting'));
  scheduler.run();
  assert.equal(rig.sockets.length, 2, 'a dropped socket is replaced');

  rig.handlers[1]?.onOpen();
  rig.handlers[1]?.onClose(WS_CLOSE.unauthenticated, 'no session', true);
  assert.equal(statuses.at(-1), 'closed');
  scheduler.run();
  assert.equal(rig.sockets.length, 2, 'a 4401 must not be retried: the answer will not change');
  handle.dispose();
});

test('an action frame carries the actionId and expectedSequence it was given, unchanged', () => {
  const { rig, factory } = harness();
  const scheduler = fakeScheduler();
  const handle = openTableSocket({
    roomId: ROOM,
    url: 'ws://x/api/v1/ws',
    onFrame: () => undefined,
    onStatus: () => undefined,
    onClose: () => undefined,
    socketFactory: factory,
    scheduler,
  });
  rig.handlers[0]?.onOpen();
  const decision = {
    action: { type: 'call' } as const,
    actionId: 'act-stable-0001',
    expectedSequence: 12,
    requestId: 'req-stable-0001',
  };
  handle.action(decision);
  // The server refuses a repeated actionId, so the retry is a no-op rather than a second bet.
  handle.action(decision);
  const frames = (rig.sockets[0]?.sent ?? [])
    .slice(1)
    .map((raw) => JSON.parse(raw) as Record<string, unknown>);
  assert.equal(frames.length, 2);
  assert.equal(frames[0]?.['actionId'], 'act-stable-0001');
  assert.equal(frames[1]?.['actionId'], 'act-stable-0001');
  assert.equal(frames[0]?.['expectedSequence'], 12);
  assert.equal(frames[1]?.['expectedSequence'], 12);
  handle.dispose();
});

test('the client refuses to exceed the protocol rate limit rather than losing its socket to a 4429', () => {
  const { rig, factory } = harness();
  const scheduler = fakeScheduler();
  const handle = openTableSocket({
    roomId: ROOM,
    url: 'ws://x/api/v1/ws',
    onFrame: () => undefined,
    onStatus: () => undefined,
    onClose: () => undefined,
    socketFactory: factory,
    scheduler,
  });
  rig.handlers[0]?.onOpen();
  let accepted = 0;
  // The clock does not advance, so `burstAllowance` frames get through, minus the spent `hello`.
  for (let index = 0; index < WS_LIMITS.burstAllowance + 10; index += 1) {
    if (handle.startHand(`deal-${String(index).padStart(6, '0')}`) === 'sent') accepted += 1;
  }
  assert.equal(accepted, WS_LIMITS.burstAllowance - 1);
  handle.dispose();
});

test('a request id always satisfies the contract pattern', () => {
  for (const prefix of ['act', 'req', 'coach', 'hello']) {
    for (let index = 0; index < 20; index += 1) {
      assert.match(newRequestId(prefix), /^[A-Za-z0-9_-]{8,64}$/);
    }
  }
});

/**
 * Coming back to `/play` puts the reader back at the table they were at — and never makes one.
 *
 * ## The defect
 *
 * Navigating away from `/play` and back showed "Not connected yet. “Deal me in” creates a guest
 * session … and a private room with bots already seated" (UI audit of 308fadf, item 15). Both halves
 * were wrong for a returning reader: the server was still holding their seat, the tab remembered the
 * room (`prl.play.roomId`), and "Deal me in" would rejoin it, not create anything. Only that press
 * ever read the memory, so the page looked as if the table had been dropped.
 *
 * ## What is held here
 *
 * The page-load reconnect runs without a press, so the guard on it is about what it must NOT do: no
 * request at all on a first visit, no guest minted, no room created and no other room chosen in
 * place of the remembered one. Those are asserted on `resumeRememberedTable` with its network
 * injected, and on `readSession` against a stubbed `fetch`. There is no renderer in this repository
 * (ADR 0008), so the hook's wiring and the panel's sentence are read from source, as
 * `live-regions.test.ts` reads `statusSentence`.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, describe, it } from 'node:test';
import type { RoomMember, RoomSummary } from '@prl/contracts';
import {
  type ResumeDependencies,
  readSession,
  resumableRoom,
  resumeRememberedTable,
  type TableSession,
} from '../src/lib/table-rooms.ts';

const READER = 'usr_reader';

function member(userId: string, seat: number | null, isBot: boolean): RoomMember {
  return {
    userId,
    displayName: userId,
    seat,
    stack: 1_000,
    isBot,
    botProfile: isBot ? 'calling-station' : null,
    connected: true,
    awaitingBigBlind: false,
  };
}

function room(id: string, overrides: Partial<RoomSummary> = {}): RoomSummary {
  return {
    id,
    name: 'Practice table',
    ownerUserId: READER,
    maxSeats: 6,
    smallBlind: 5,
    bigBlind: 10,
    ante: 0,
    startingStack: 1_000,
    actionTimeoutSeconds: 60,
    status: 'open',
    visibility: 'invite_only',
    members: [member(READER, 0, false), member('bot_1', 1, true)],
    ...overrides,
  } as RoomSummary;
}

const SESSION: TableSession = {
  user: {
    id: READER,
    kind: 'guest',
    displayName: 'Guest 12D91B',
    units: 1_000,
    createdAt: '2026-11-12T00:00:00Z',
  },
  csrfToken: 'token-abc',
};

/** The network, counted. Only reads are offered: a resume that wanted to create could not. */
function network(session: TableSession | null, rooms: readonly RoomSummary[]) {
  const calls: string[] = [];
  const dependencies: ResumeDependencies = {
    readSession: () => {
      calls.push('readSession');
      return Promise.resolve(session);
    },
    listRooms: () => {
      calls.push('listRooms');
      return Promise.resolve(rooms);
    },
  };
  return { calls, dependencies };
}

const signal = new AbortController().signal;

describe('the table a returning reader is put back at', () => {
  it('is the room the tab remembers, while the server still lists it (REGRESSION)', async () => {
    const { calls, dependencies } = network(SESSION, [room('room_other'), room('room_mine')]);
    const resumed = await resumeRememberedTable('room_mine', signal, dependencies);
    assert.equal(resumed?.room.id, 'room_mine');
    assert.equal(resumed?.session.user.id, READER);
    assert.deepEqual(calls, ['readSession', 'listRooms']);
  });

  it('includes a room reached by invite code, which the reader sits at but does not own', () => {
    const joined = room('room_friend', {
      ownerUserId: 'usr_friend',
      members: [member('usr_friend', 0, false), member(READER, 1, false)],
    });
    assert.equal(resumableRoom([joined], 'room_friend')?.id, 'room_friend');
  });

  it('asks the network nothing on a first visit, when the tab remembers no room', async () => {
    const { calls, dependencies } = network(SESSION, [room('room_mine')]);
    assert.equal(await resumeRememberedTable(null, signal, dependencies), null);
    assert.deepEqual(calls, [], 'a first visit made no request before the reader pressed anything');
  });

  it('stops at a missing session rather than minting one', async () => {
    const { calls, dependencies } = network(null, [room('room_mine')]);
    assert.equal(await resumeRememberedTable('room_mine', signal, dependencies), null);
    assert.deepEqual(calls, ['readSession']);
  });

  it('chooses no other room when the remembered one has gone', async () => {
    // `chooseRoom` would take `room_spare` (owned, with a bot): right for a press of "Deal me in",
    // which asks for a table; wrong here, where nothing was asked for but THAT table.
    const { dependencies } = network(SESSION, [room('room_spare')]);
    assert.equal(await resumeRememberedTable('room_mine', signal, dependencies), null);
  });

  it('does not reopen a closed room, or a legend match the tab also remembers', () => {
    assert.equal(resumableRoom([room('room_mine', { status: 'closed' })], 'room_mine'), null);
    assert.equal(resumableRoom([room('room_legend', { maxSeats: 2 })], 'room_legend'), null);
    assert.equal(resumableRoom([room('room_mine')], null), null);
  });
});

describe('readSession', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function stubSession(user: unknown): { method: string; url: string }[] {
    const calls: { method: string; url: string }[] = [];
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      calls.push({ method: init?.method ?? 'GET', url: String(input) });
      const body = JSON.stringify({ user, csrfToken: 'token-abc', protocolVersion: 1, oidcEnabled: false });
      return Promise.resolve(
        new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
      );
    }) as typeof fetch;
    return calls;
  }

  it('answers null for a browser with no user, and posts nothing to get one', async () => {
    const calls = stubSession(null);
    assert.equal(await readSession(), null);
    assert.equal(calls.length, 1, 'one read, and no `POST /auth/guest` after it');
    assert.equal(calls[0]?.method, 'GET');
    assert.match(calls[0]?.url ?? '', /\/auth\/session$/u);
  });

  it('answers the session that exists', async () => {
    stubSession(SESSION.user);
    assert.equal((await readSession())?.user.id, READER);
  });
});

describe('the page that does the reconnecting', () => {
  const hook = readFileSync(new URL('../src/lib/use-live-table.ts', import.meta.url), 'utf8');
  const panel = readFileSync(new URL('../src/app/play/LiveTable.tsx', import.meta.url), 'utf8');

  /** The body of the effect that reconnects on load, so a neighbouring call cannot satisfy this. */
  const effect = (() => {
    const start = hook.indexOf('resumeRememberedTable(remembered');
    assert.ok(start > 0, 'useLiveTable no longer reconnects on load through resumeRememberedTable');
    const open = hook.lastIndexOf('useEffect(', start);
    const close = hook.indexOf('}, [legendMatch]);', start);
    assert.ok(open > 0 && close > start, 'the reconnect effect has moved; this assertion needs updating');
    return hook.slice(open, close);
  })();

  it('reconnects from an effect that can neither mint a session, make a room, nor deal', () => {
    for (const forbidden of ['ensureSession', 'createRoom', 'createLegendMatch', 'openPracticeRoom']) {
      assert.ok(!effect.includes(forbidden), `the page-load reconnect calls ${forbidden}`);
    }
    assert.ok(!/setDealIn\(/u.test(effect), 'being reconnected is not being dealt in');
    assert.match(
      effect,
      /if \(legendMatch !== undefined\) return;/u,
      'a Legends page opens a match by its press',
    );
  });

  it('no longer tells a returning reader that "Deal me in" creates a room (REGRESSION)', () => {
    const start = panel.indexOf('function statusSentence');
    const end = panel.indexOf('\n}\n', start);
    assert.ok(start >= 0 && end > start, 'statusSentence has moved; this assertion needs updating');
    const sentence = panel.slice(start, end);
    assert.doesNotMatch(sentence, /creates a guest session/u);
    assert.match(sentence, /the one you already have, or a new one/u);
    assert.match(sentence, /live\.resuming/u, 'and it says so while it reconnects');
  });
});

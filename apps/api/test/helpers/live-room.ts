/**
 * The fakes a live table needs, shared by the two suites that drive one.
 *
 * `test/ws-router.test.ts` drives the protocol with no socket; `test/ws-socket.test.ts` drives it
 * over a real one. Both need the same two seams — room/member persistence and session lookup — and
 * two divergent copies of a fake are two different servers to reason about, so they live here.
 *
 * Every method that a test is not supposed to reach throws. A fake that quietly answers a call the
 * test did not intend is a fake that hides a missing assertion.
 *
 * Not a `.test.ts` file, so the runner's glob does not pick it up.
 */

import type { SessionAccount, SessionStore, StoredSession } from '../../src/auth/session.ts';
import { AppError } from '../../src/errors.ts';
import type { RoomStore } from '../../src/rooms/registry.ts';

/**
 * A room store with only the three methods seating needs.
 *
 * `seatMember`/`unseatMember` keep a `Map` so `memberOf` reports the seat the test just took —
 * which is what `registry.sitAtTable` reads back before it touches the live table.
 */
export function seatingOnlyStore(units = 10_000): RoomStore {
  const refuse = (name: string): never => {
    throw new AppError('internal_error', { logDetail: `the fake store has no ${name}` });
  };
  const seats = new Map<string, number | null>();
  return {
    create: () => refuse('create'),
    byId: () => Promise.resolve(null),
    byInviteCode: () => Promise.resolve(null),
    listForUser: () => Promise.resolve([]),
    membersOfRooms: () => Promise.resolve([]),
    memberOf: (roomId, userId) =>
      Promise.resolve({
        id: 'mem_fake',
        room_id: roomId,
        user_id: userId,
        display_name: userId,
        seat: seats.get(userId) ?? null,
        stack: 1_000,
        is_bot: false,
        bot_profile: null,
        joined_at: new Date(),
        left_at: null,
      }),
    addMember: () => refuse('addMember'),
    seatMember: (_roomId, userId, seat) => {
      seats.set(userId, seat);
      return Promise.resolve();
    },
    unseatMember: (_roomId, userId) => {
      seats.set(userId, null);
      return Promise.resolve();
    },
    removeMember: () => Promise.resolve(),
    close: () => Promise.resolve(true),
    createBotUser: () => refuse('createBotUser'),
    readUnits: () => Promise.resolve(units),
  };
}

export function accountFor(userId: string, displayName: string): SessionAccount {
  return { id: userId, kind: 'guest', displayName, createdAt: '2026-08-17T12:00:00.000Z' };
}

/**
 * Session lookup over a fixed token table.
 *
 * The *real* `sessionPlugin` is what runs in front of this, so the cookie name, the HMAC signature
 * and the `preHandler` ordering are all the production ones — only the row lookup is replaced. That
 * is the seam the upgrade actually depends on: `hub.ts` reads `request.session` and nothing else.
 *
 * `expiresAt` is far enough out that `shouldRefresh` is false, so no test accidentally exercises the
 * sliding-expiry write path (which belongs to `test/auth.test.ts` and needs a database).
 */
export function fixedSessionStore(
  sessions: ReadonlyMap<string, { readonly sessionId: string; readonly user: SessionAccount }>,
): SessionStore {
  const refuse = (name: string): never => {
    throw new AppError('internal_error', { logDetail: `the fake session store has no ${name}` });
  };
  const expiresAt = new Date(Date.now() + 60 * 60_000);
  return {
    findValidByToken: (token) => {
      const found = sessions.get(token);
      if (found === undefined) return Promise.resolve(null);
      const stored: StoredSession = { sessionId: found.sessionId, expiresAt, user: found.user };
      return Promise.resolve(stored);
    },
    create: () => refuse('create'),
    extendExpiry: () => refuse('extendExpiry'),
    revoke: () => refuse('revoke'),
    touchLastSeen: () => refuse('touchLastSeen'),
  };
}

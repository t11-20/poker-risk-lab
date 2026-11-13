/**
 * The live-table fakes shared by `ws-router.test.ts` and `ws-socket.test.ts`, so there is one fake
 * server to reason about. Every method a test should not reach throws, so a stray call cannot hide
 * a missing assertion.
 */

import type { SessionAccount, SessionStore, StoredSession } from '../../src/auth/session.ts';
import { AppError } from '../../src/errors.ts';
import type { RoomStore } from '../../src/rooms/registry.ts';

/** `memberOf` reports the seat just taken, which `registry.sitAtTable` reads back. */
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
        bot_difficulty: null,
        bot_seed: null,
        joined_at: new Date(),
        left_at: null,
      }),
    addMember: () => refuse('addMember'),
    seatMember: (_roomId, userId, seat) => {
      seats.set(userId, seat);
      return Promise.resolve(`mem_${userId}`);
    },
    unseatMember: (_roomId, userId) => {
      seats.set(userId, null);
      return Promise.resolve();
    },
    recordFirstSit: () => Promise.resolve(true),
    removeMember: () => Promise.resolve(),
    close: () => Promise.resolve(true),
    closePracticeTable: () => refuse('closePracticeTable'),
    createBotUser: () => refuse('createBotUser'),
    readUnits: () => Promise.resolve(units),
  };
}

export function accountFor(userId: string, displayName: string): SessionAccount {
  return { id: userId, kind: 'guest', displayName, createdAt: '2026-08-17T12:00:00.000Z' };
}

/**
 * Only the row lookup is replaced. The real `sessionPlugin` runs in front, and `hub.ts` reads only
 * `request.session`. `expiresAt` is far enough out that the sliding-expiry write never runs.
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

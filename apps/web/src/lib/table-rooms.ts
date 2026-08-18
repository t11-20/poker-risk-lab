/**
 * The REST half of a live table: the session the socket authenticates with, and the room it joins.
 *
 * A WebSocket upgrade carries no body and no headers page script can set, so both of those have to
 * exist before the socket is opened. This module is the ordered set of ordinary HTTP calls that put
 * them there — nothing more. It holds no state, decides nothing about poker, and every response it
 * returns came from the server.
 *
 * ## The contract gap that used to be here is closed
 *
 * `API_PATHS` in `@prl/contracts` is the only place a request path may be constructed, and its own
 * header explains why: a path written on one side of the wire drifts the moment the other side is
 * renamed, which is exactly how every path in this client once omitted `/api/v1`. It used to
 * publish no entry for `POST /auth/guest` or for `/rooms`, so this module kept its own `TABLE_PATHS`
 * table with a comment saying where it belonged — which meant the whole live table sat outside the
 * one test that proves the client and the server agree about where anything is.
 *
 * Those paths are published now (`API_PATHS.guest`, `API_PATHS.rooms`, and `API_PATHS.ws` for the
 * socket), and `apps/api/test/web-api-paths.test.ts` drives every one of them against a real
 * `buildApp()`. Nothing in this file builds a path any more.
 *
 * Sitting and standing are still deliberately absent from the REST surface: they happen over the
 * socket, where they are ordered against the hand the seat is in. Doing them over REST as well would
 * give two paths to the same mutation with no ordering between them.
 */

import type {
  CreateRoomRequest,
  CreateRoomResponse,
  RoomListResponse,
  RoomSummary,
  SessionResponse,
} from '@prl/contracts';
import { API_PATHS } from '@prl/contracts';
import { apiGet, apiSend } from './api.ts';

/** The opponents a bot table is dealt against, and why this particular mix. */
export const BOT_TABLE: readonly { readonly profile: string; readonly count: number }[] = [
  // Two of the same profile so a learner can watch one style twice in a session and see that it is
  // a policy rather than a personality, then three others so the table is not one idea repeated.
  { profile: 'tight-aggressive', count: 2 },
  { profile: 'calling-station', count: 1 },
  { profile: 'loose-aggressive', count: 1 },
  { profile: 'nit', count: 1 },
];

/**
 * The table this page asks for.
 *
 * Six seats, because the page's heading says six-handed and the five bots above fill seats 1 to 5,
 * leaving seat 0 for the reader — `seatRequestedBots` in the API seats bots from 1 upwards for
 * exactly that reason. The clock is generous on purpose: the Coach panel beside the buttons is the
 * thing a learner is here to read, and a 15-second clock would teach them to skip it.
 */
export const BOT_TABLE_REQUEST: CreateRoomRequest = {
  name: 'Bot table',
  maxSeats: 6,
  smallBlind: 5,
  bigBlind: 10,
  startingStack: 1000,
  actionTimeoutSeconds: 60,
  bots: BOT_TABLE,
};

/** The seat the reader takes. Seat 0 is the one `seatRequestedBots` leaves free. */
export const READER_SEAT = 0;

export interface TableSession {
  readonly user: NonNullable<SessionResponse['user']>;
  readonly csrfToken: string;
}

/**
 * Reads the session, and creates a guest one if there is none.
 *
 * Two calls rather than one, and in this order, because `POST /auth/guest` is a mutation and the
 * API requires the double-submit CSRF token on every mutation. The token comes from the anonymous
 * session read, which is why that read happens even when the answer is going to be `user: null`.
 *
 * A guest account is an account in one request: no email, no password, no confirmation. There is
 * nothing of value attached to it to protect, and putting a form between a reader and the table
 * would buy no security.
 */
export async function ensureSession(signal?: AbortSignal): Promise<TableSession> {
  const options = signal === undefined ? {} : { signal };
  const current = await apiGet<SessionResponse>(API_PATHS.session(), options);
  if (current.user !== null && current.csrfToken !== null) {
    return { user: current.user, csrfToken: current.csrfToken };
  }
  if (current.csrfToken === null) {
    throw new Error('the session endpoint returned no CSRF token, so no mutation can be made');
  }
  const created = await apiSend<SessionResponse>(
    'POST',
    API_PATHS.guest(),
    {},
    {
      ...options,
      csrfToken: current.csrfToken,
    },
  );
  if (created.user === null || created.csrfToken === null) {
    throw new Error('the guest endpoint answered without a user');
  }
  return { user: created.user, csrfToken: created.csrfToken };
}

/** Every room this session owns or is sitting at. */
export async function listRooms(signal?: AbortSignal): Promise<readonly RoomSummary[]> {
  const options = signal === undefined ? {} : { signal };
  const response = await apiGet<RoomListResponse>(API_PATHS.rooms(), options);
  return response.rooms;
}

/**
 * Creates a private table with bots already seated.
 *
 * The invite code comes back exactly once and is not stored anywhere by this client. That is the
 * server's design — only a hash is kept — and it is what makes "private, invite-only" true rather
 * than a label: a room nobody has the code for cannot be joined, and there is no list to browse.
 */
export async function createBotRoom(csrfToken: string, signal?: AbortSignal): Promise<CreateRoomResponse> {
  const options = signal === undefined ? { csrfToken } : { csrfToken, signal };
  return await apiSend<CreateRoomResponse>('POST', API_PATHS.rooms(), BOT_TABLE_REQUEST, options);
}

/**
 * The room to open, reusing one this session already owns where that is possible.
 *
 * Reuse matters because a reload that created a new table every time would leave a trail of
 * abandoned rooms and lose the hand in progress. `preferredId` is what the tab remembered; it is
 * checked against the server's list rather than trusted, so a stale id simply falls through to
 * "make a new one" instead of producing a socket that will be closed 4403.
 */
export function chooseRoom(
  rooms: readonly RoomSummary[],
  userId: string,
  preferredId: string | null,
): RoomSummary | null {
  const mine = rooms.filter((room) => room.ownerUserId === userId && room.status !== 'closed');
  if (preferredId !== null) {
    const remembered = mine.find((room) => room.id === preferredId);
    if (remembered !== undefined) return remembered;
  }
  // A room with a bot already seated is one a hand can actually be dealt at. One without is a room
  // whose bots were lost to a server restart, and choosing it would seat the reader at a table where
  // nobody else can act.
  return mine.find((room) => room.members.some((member) => member.isBot)) ?? null;
}

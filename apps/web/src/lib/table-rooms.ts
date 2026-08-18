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
 *
 * ## Joining by invite code, which is the half of "private table" that had no client
 *
 * `POST /rooms/join` has always worked on the server. Nothing in this client had ever called it —
 * `grep -rn inviteCode apps/web/src` returned one comment and no code — so the invite code that
 * `createRoom` receives was discarded on arrival, no screen displayed it, and there was no way
 * for a second person to reach a private room at all. The README's "private, invite-only tables
 * with people you already know" was a sentence about the server.
 *
 * `joinRoomByInviteCode` below is that missing call, and `normaliseInviteCode` is what makes a
 * pasted code work. Its path is not in `API_PATHS` and is built in `unpublished-api-paths.ts`
 * instead — read that file's header before copying the pattern; it is a temporary arrangement with
 * a documented way out, not a licence to build paths at call sites again.
 */

import type {
  CreateRoomRequest,
  CreateRoomResponse,
  JoinRoomRequest,
  JoinRoomResponse,
  RoomListResponse,
  RoomSummary,
  SessionResponse,
} from '@prl/contracts';
import { API_PATHS } from '@prl/contracts';
import { apiGet, apiSend } from './api.ts';
import { UNPUBLISHED_API_PATHS } from './unpublished-api-paths.ts';

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

/**
 * A table for people, which is the one an invite code is actually for.
 *
 * ## Why the bot table cannot be this table
 *
 * `BOT_TABLE_REQUEST` above asks for six seats and seats five bots, so the room is FULL the moment
 * it is created — the owner takes the sixth. Handing somebody the invite code to it gets them
 * `room_full` from the server, correctly. When the invite code was first surfaced on this screen
 * that is exactly what happened: the code was real, the join worked, and there was nowhere to sit.
 *
 * So "start a private table" is its own act with its own room. Two bots rather than none, and the
 * reason is that an invite-only table with nobody in it cannot deal a hand at all: a table needs two
 * seats occupied to play, and a reader who creates a room, shares the code and waits would otherwise
 * be looking at a table that does nothing until their friend arrives. Two bots means the table is
 * playable immediately, and three seats stay free for the people the code is for.
 */
export const FRIENDS_TABLE: readonly { readonly profile: string; readonly count: number }[] = [
  { profile: 'tight-aggressive', count: 1 },
  { profile: 'calling-station', count: 1 },
];

export const FRIENDS_TABLE_REQUEST: CreateRoomRequest = {
  name: 'Private table',
  maxSeats: 6,
  smallBlind: 5,
  bigBlind: 10,
  startingStack: 1000,
  actionTimeoutSeconds: 60,
  bots: FRIENDS_TABLE,
};

/** The seat the reader takes at the BOT table. Seat 0 is the one `seatRequestedBots` leaves free. */
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
 * Creates a room to the given specification.
 *
 * Takes the request rather than building one, because there are two: the bot table a learner
 * practises at (`BOT_TABLE_REQUEST`) and the private table they invite somebody to
 * (`FRIENDS_TABLE_REQUEST`). They differ only in how many seats the bots take, and nothing about
 * creating a room, reading its code or opening a socket to it differs between them.
 *
 * The invite code comes back exactly once and is not stored anywhere by this client. That is the
 * server's design — only a hash is kept — and it is what makes "private, invite-only" true rather
 * than a label: a room nobody has the code for cannot be joined, and there is no list to browse.
 * The caller is therefore the only thing that can surface it; see `LiveTable.inviteCode` in
 * `use-live-table.ts` for the one that does, and what it deliberately does not do with it.
 */
export async function createRoom(
  csrfToken: string,
  request: CreateRoomRequest,
  signal?: AbortSignal,
): Promise<CreateRoomResponse> {
  const options = signal === undefined ? { csrfToken } : { csrfToken, signal };
  return await apiSend<CreateRoomResponse>('POST', API_PATHS.rooms(), request, options);
}

// ---------------------------------------------------------------------------
// Joining somebody else's private table
// ---------------------------------------------------------------------------

/**
 * The longest string a person may paste into the invite field.
 *
 * Mirrors `MAX_INVITE_CODE_INPUT` in `apps/api/src/repositories/ids.ts`, and the server refuses
 * anything longer rather than truncating it — truncation would make two different long strings
 * normalise to the same code, which is a way to turn a typo into somebody else's table. Enforced
 * here as well so the field says no before a request goes out, not instead of the server saying it.
 */
export const MAX_INVITE_CODE_INPUT = 64;

/** The shape a generated code has: four groups of four, hyphenated. Used for the field's hint. */
export const INVITE_CODE_EXAMPLE = 'ABCD-EFGH-JKMN-PQRS';

/**
 * A typed or pasted code, in the form the wire schema accepts — or null when it cannot be one.
 *
 * ## Why this exists on the client at all
 *
 * The server normalises too (`normaliseInviteCode` in `repositories/ids.ts`) and is the authority,
 * but its normaliser runs *after* Fastify has validated the body against
 * `^[A-Za-z0-9-]{8,32}$`. So a code pasted out of a chat message as `UESA H2PM SZ2S M5BJ` — spaces
 * and all, which is exactly what a copy out of a message thread gives you — is rejected as a
 * malformed REQUEST before the forgiving normaliser ever sees it. Doing the same two operations
 * here means the paste works and the learner is not told their correct code is invalid.
 *
 * ## What it deliberately does not do
 *
 *  - **It does not strip hyphens.** They are part of the code and are hashed with it; a normaliser
 *    that removed them would make the seeded development room unjoinable by its own documented
 *    code (`db/seeds/0001_dev_seed.sql`). The comment on `generateInviteCode` in the API says the
 *    same thing from the other side.
 *  - **It does not validate the alphabet.** A code with a `Z` where a `2` should be is not
 *    something this client can know is wrong, and guessing would produce a confident local error
 *    for a code the server would have accepted. An unknown code hashes to nothing and comes back
 *    `invite_code_invalid`, which is one code path and fails closed.
 */
export function normaliseInviteCode(raw: string): string | null {
  if (raw.length > MAX_INVITE_CODE_INPUT) return null;
  const collapsed = raw.replace(/\s+/gu, '').toUpperCase();
  // The wire schema's own floor. Below it there is nothing to send: a two-character "code" is a
  // half-finished paste, and the round trip would spend a rate-limit token to say so.
  return collapsed.length < 8 ? null : collapsed;
}

/**
 * Joins a private room with the code its owner shared.
 *
 * The code travels in the request BODY and never in a URL — see the note in
 * `unpublished-api-paths.ts`. It is the only thing protecting a private table, and a URL is written
 * to the access log of every proxy it passes and sent onwards in `Referer`.
 *
 * Joining a room this session is already in is not an error; the server adds the membership only if
 * it is missing. So a reader who reloads the page and pastes the code again lands back at the same
 * table rather than being told they are already there.
 */
export async function joinRoomByInviteCode(
  csrfToken: string,
  inviteCode: string,
  signal?: AbortSignal,
): Promise<RoomSummary> {
  const options = signal === undefined ? { csrfToken } : { csrfToken, signal };
  const body: JoinRoomRequest = { inviteCode };
  const response = await apiSend<JoinRoomResponse>('POST', UNPUBLISHED_API_PATHS.roomJoin(), body, options);
  return response.room;
}

/**
 * The seat this reader should ask for at a room, or null when there is none free.
 *
 * `READER_SEAT` is right for the bot table this page creates — `seatRequestedBots` fills from seat
 * 1 upwards specifically to leave seat 0 — but it is wrong the moment a second person joins by
 * invite code, because seat 0 is where the owner is sitting. Asking for it anyway produced a
 * refusal the joiner could do nothing about, which is what made the private path unusable even
 * once the join worked.
 *
 * The server is still the authority: two people tapping the same free seat in the same instant is
 * settled by `room_members_live_seat_key`, and the loser gets a refusal with the server's own
 * wording. This only picks which seat to ask for.
 */
export function firstFreeSeat(room: RoomSummary, userId: string): number | null {
  const mine = room.members.find((member) => member.userId === userId)?.seat ?? null;
  if (mine !== null) return mine;
  const taken = new Set(room.members.map((member) => member.seat).filter((seat) => seat !== null));
  if (!taken.has(READER_SEAT)) return READER_SEAT;
  for (let seat = 0; seat < room.maxSeats; seat += 1) {
    if (!taken.has(seat)) return seat;
  }
  return null;
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

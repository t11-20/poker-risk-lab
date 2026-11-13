/**
 * The REST half of a live table: the session the socket authenticates with, and the room it joins.
 * A WebSocket upgrade carries no body and no settable headers, so both must exist before it opens.
 * Every path comes from `API_PATHS`. Sitting and standing stay on the socket, where they are ordered
 * against the hand.
 */

import type {
  CreateLegendMatchRequest,
  CreateLegendMatchResponse,
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

export const BOT_TABLE: readonly { readonly profile: string; readonly count: number }[] = [
  // Two of one profile, so a learner sees a style is a policy rather than a personality.
  { profile: 'tight-aggressive', count: 2 },
  { profile: 'calling-station', count: 1 },
  { profile: 'loose-aggressive', count: 1 },
  { profile: 'nit', count: 1 },
];

/**
 * Six seats with bots in 1 to 5, leaving seat 0 for the reader (`seatRequestedBots` fills from 1).
 * The 60s clock leaves time to read the Coach panel.
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
 * The private table. The bot table is full once the owner sits, so an invitee would get `room_full`.
 * Two bots so a hand can deal before a friend arrives, with three seats free.
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

/** The reader's seat at the bot table. */
export const READER_SEAT = 0;

export interface TableSession {
  readonly user: NonNullable<SessionResponse['user']>;
  readonly csrfToken: string;
}

/**
 * Reads the session, minting a guest if there is none. The anonymous read supplies the CSRF token
 * that `POST /auth/guest` requires.
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

/**
 * Never mints. `resumeRememberedTable` runs on page load, and minting there would give an expired tab
 * a new stranger's account.
 */
export async function readSession(signal?: AbortSignal): Promise<TableSession | null> {
  const options = signal === undefined ? {} : { signal };
  const current = await apiGet<SessionResponse>(API_PATHS.session(), options);
  if (current.user === null || current.csrfToken === null) return null;
  return { user: current.user, csrfToken: current.csrfToken };
}

export async function listRooms(signal?: AbortSignal): Promise<readonly RoomSummary[]> {
  const options = signal === undefined ? {} : { signal };
  const response = await apiGet<RoomListResponse>(API_PATHS.rooms(), options);
  return response.rooms;
}

/**
 * The invite code comes back exactly once and this client never stores it. The server keeps only a
 * hash, so a room nobody has the code for cannot be joined.
 */
export async function createRoom(
  csrfToken: string,
  request: CreateRoomRequest,
  signal?: AbortSignal,
): Promise<CreateRoomResponse> {
  const options = signal === undefined ? { csrfToken } : { csrfToken, signal };
  return await apiSend<CreateRoomResponse>('POST', API_PATHS.rooms(), request, options);
}

export async function createLegendMatch(
  csrfToken: string,
  request: CreateLegendMatchRequest,
  signal?: AbortSignal,
): Promise<CreateLegendMatchResponse> {
  const options = signal === undefined ? { csrfToken } : { csrfToken, signal };
  return await apiSend<CreateLegendMatchResponse>('POST', API_PATHS.legendMatches(), request, options);
}

/**
 * Mirrors `MAX_INVITE_CODE_INPUT` in `apps/api/src/repositories/ids.ts`. The server refuses longer
 * input rather than truncating, since truncation could map a typo onto another table.
 */
export const MAX_INVITE_CODE_INPUT = 64;

export const INVITE_CODE_EXAMPLE = 'ABCD-EFGH-JKMN-PQRS';

/**
 * Fastify validates `^[A-Za-z0-9-]{8,32}$` before the server's normaliser runs, so a code pasted with
 * spaces would be refused as malformed. This strips whitespace and uppercases.
 * Hyphens are kept because they are hashed with the code (the dev seed's room depends on it).
 * The alphabet is not checked. An unknown code comes back `invite_code_invalid`.
 */
export function normaliseInviteCode(raw: string): string | null {
  if (raw.length > MAX_INVITE_CODE_INPUT) return null;
  const collapsed = raw.replace(/\s+/gu, '').toUpperCase();
  // The wire schema's floor; shorter is a half-finished paste and would spend a rate-limit token.
  return collapsed.length < 8 ? null : collapsed;
}

/**
 * The code travels in the request body, never a URL, because URLs reach proxy logs and `Referer`.
 * Joining a room this session is already in is not an error.
 */
export async function joinRoomByInviteCode(
  csrfToken: string,
  inviteCode: string,
  signal?: AbortSignal,
): Promise<RoomSummary> {
  const options = signal === undefined ? { csrfToken } : { csrfToken, signal };
  const body: JoinRoomRequest = { inviteCode };
  const response = await apiSend<JoinRoomResponse>('POST', API_PATHS.roomJoin(), body, options);
  return response.room;
}

/**
 * `READER_SEAT` is the owner's seat once a second person joins. The server settles races via
 * `room_members_live_seat_key`. This only picks which seat to ask for.
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
 * The remembered id is checked against the server's list, so a stale id falls through to a new room
 * rather than a socket closed 4403.
 */
export function chooseRoom(
  rooms: readonly RoomSummary[],
  userId: string,
  preferredId: string | null,
): RoomSummary | null {
  // Only rooms as wide as `/play` (six seats). A legend match is two seats wide and must not reopen
  // under the six-handed heading (Devin Review on #24). Width, because room names and profiles drift
  // or overlap.
  const mine = rooms.filter(
    (room) =>
      room.ownerUserId === userId && room.status !== 'closed' && room.maxSeats === BOT_TABLE_REQUEST.maxSeats,
  );
  if (preferredId !== null) {
    const remembered = mine.find((room) => room.id === preferredId);
    if (remembered !== undefined) return remembered;
  }
  // A room with no seated bot lost them to a restart, and nobody else could act there.
  return mine.find((room) => room.members.some((member) => member.isBot)) ?? null;
}

/**
 * Runs on page load without a press, so it may only reconnect. It mints no session, creates no room,
 * and returns only the remembered room while the server lists it open and six seats wide. It never
 * sits or deals, since the reader may be mid-hand.
 */
export function resumableRoom(
  rooms: readonly RoomSummary[],
  rememberedId: string | null,
): RoomSummary | null {
  if (rememberedId === null) return null;
  const room = rooms.find((entry) => entry.id === rememberedId);
  if (room === undefined || room.status === 'closed') return null;
  return room.maxSeats === BOT_TABLE_REQUEST.maxSeats ? room : null;
}

export interface ResumeDependencies {
  readonly readSession: (signal: AbortSignal) => Promise<TableSession | null>;
  readonly listRooms: (signal: AbortSignal) => Promise<readonly RoomSummary[]>;
}

/** Asks nothing when the tab remembers no room, so a first visit makes no request before a press. */
export async function resumeRememberedTable(
  rememberedId: string | null,
  signal: AbortSignal,
  dependencies: ResumeDependencies = { readSession, listRooms },
): Promise<{ readonly session: TableSession; readonly room: RoomSummary } | null> {
  if (rememberedId === null) return null;
  const session = await dependencies.readSession(signal);
  if (session === null) return null;
  const room = resumableRoom(await dependencies.listRooms(signal), rememberedId);
  return room === null ? null : { session, room };
}

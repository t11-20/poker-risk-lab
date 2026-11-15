/**
 * The practice table a press would close. A learner holds one at a time, and each keeps its own units,
 * so starting a bot table or a Legends match closes the other (`RoomRegistry.retirePracticeTables`).
 */

import type { CreateRoomRequest, RoomSummary } from '@prl/contracts';
import { BOT_TABLE_REQUEST, type LegendMatch, runningLegendMatchOf } from './table-rooms.ts';

export type PracticeTableKind = 'botTable' | 'legendMatch';

export type PracticeTableInPlay = {
  readonly roomId: string;
  /** Null while the reader stands, because a live table reports 0 for a member with no seat. */
  readonly stack: number | null;
} & (
  | { readonly kind: 'botTable' }
  /** Null once the match is finished, so there is nothing to go back to. */
  | { readonly kind: 'legendMatch'; readonly match: LegendMatch | null }
);

/** `POST /rooms` replaces a practice table only when its bots fill every chair but the owner's. */
export function createsPracticeTable(request: CreateRoomRequest): boolean {
  const bots = (request.bots ?? []).reduce((total, entry) => total + entry.count, 0);
  return bots > 0 && bots + 1 === request.maxSeats;
}

/**
 * The server's rule, clause for clause. Null when the press reuses a room, since a reuse creates
 * nothing and so closes nothing. The kind is read from the width, as `chooseRoom` reads it.
 */
export function practiceTableToRetire(
  rooms: readonly RoomSummary[],
  userId: string,
  reused: RoomSummary | null,
): PracticeTableInPlay | null {
  if (reused !== null) return null;
  for (const room of rooms) {
    if (room.ownerUserId !== userId || room.status === 'closed') continue;
    const bots = room.members.filter((member) => member.isBot).length;
    const anotherPerson = room.members.some((member) => !member.isBot && member.userId !== userId);
    if (anotherPerson || bots === 0 || room.maxSeats !== bots + 1) continue;
    const reader = room.members.find((member) => member.userId === userId);
    const stack = reader === undefined || reader.seat === null ? null : reader.stack;
    return room.maxSeats === BOT_TABLE_REQUEST.maxSeats
      ? { roomId: room.id, kind: 'botTable', stack }
      : { roomId: room.id, kind: 'legendMatch', stack, match: runningLegendMatchOf(room, userId) };
  }
  return null;
}

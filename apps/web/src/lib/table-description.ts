/**
 * Who is at the table the reader actually joined, in one line.
 *
 * ## The defect
 *
 * `/play` is headed "Six-handed table" and its lede said "A private table against five bots" — true
 * of the bot table "Deal me in" builds, and false of the other two tables the same page seats a
 * reader at: the private table "Start a private table…" builds (two bots, three seats left for
 * people) and a friend's table reached by invite code. The audit at 308fadf read that lede over a
 * room line saying "3 at the table". The heading and the lede are rendered on the server from the
 * URL, before any room exists, so they cannot know which table it will be; the lede now says
 * something true of all three, and the composition is said here, where the room is already known.
 *
 * The heading stays: every room this page creates asks for six seats (`BOT_TABLE_REQUEST`,
 * `FRIENDS_TABLE_REQUEST`), and `chooseRoom` reuses only a room of that width.
 *
 * Counted from SEATED members. A member with `seat: null` is watching, holds no chair and is dealt
 * nothing, so counting them would report a seat as taken that anybody can sit in.
 */

import type { RoomSummary } from '@prl/contracts';

function count(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

/** "a", "a and b", "a, b and c". No Oxford comma, matching the rest of the table's sentences. */
function listed(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1] ?? ''}`;
}

export function describeTable(room: RoomSummary, readerId: string | null): string {
  const seated = room.members.filter((member) => member.seat !== null);
  const readerSeated = seated.some((member) => member.userId === readerId);
  const bots = seated.filter((member) => member.isBot).length;
  const people = seated.filter((member) => !member.isBot && member.userId !== readerId).length;
  const who = [
    ...(readerSeated ? ['you'] : []),
    ...(bots > 0 ? [count(bots, 'bot', 'bots')] : []),
    ...(people > 0
      ? [count(people, readerSeated ? 'other person' : 'person', readerSeated ? 'other people' : 'people')]
      : []),
  ];
  const free = Math.max(0, room.maxSeats - seated.length);
  const seats = free === 0 ? 'every seat taken' : `${count(free, 'seat', 'seats')} free`;
  return who.length === 0
    ? `${room.name}: nobody seated, ${seats}`
    : `${room.name}: ${listed(who)}, ${seats}`;
}

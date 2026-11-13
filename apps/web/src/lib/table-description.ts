/**
 * Who is at the table the reader joined, in one line. The server-rendered lede cannot know which of
 * the three tables `/play` seats a reader at, so the composition is said here. Counted from SEATED
 * members, because a watcher holds no chair.
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

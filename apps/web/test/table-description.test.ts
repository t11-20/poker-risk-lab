/**
 * `/play` says who is at the table the reader joined, and its lede claims nothing the table is not.
 * The lede renders before any room exists, so it says what is true of every table, and the room line
 * says which one this is. The rooms are `BOT_TABLE_REQUEST`, `FRIENDS_TABLE_REQUEST`, and a friend's
 * table after a second person joined.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import type { RoomMember, RoomSummary } from '@prl/contracts';
import { describeTable } from '../src/lib/table-description.ts';

const ME = 'usr_reader';

function member(userId: string, seat: number | null, isBot: boolean): RoomMember {
  return {
    userId,
    displayName: userId,
    seat,
    stack: 1000,
    isBot,
    botProfile: isBot ? 'nit' : null,
    connected: true,
    awaitingBigBlind: false,
  } as RoomMember;
}

function room(name: string, members: readonly RoomMember[]): RoomSummary {
  return { name, maxSeats: 6, members } as unknown as RoomSummary;
}

const bots = (n: number): RoomMember[] =>
  Array.from({ length: n }, (_, index) => member(`bot_${String(index)}`, index + 1, true));

describe('the room line says who is at the table', () => {
  it('the bot table: the reader and five bots, full', () => {
    assert.equal(
      describeTable(room('Bot table', [member(ME, 0, false), ...bots(5)]), ME),
      'Bot table: you and 5 bots, every seat taken',
    );
  });

  it('the private table: two bots, and three chairs left for people (REGRESSION)', () => {
    assert.equal(
      describeTable(room('Private table', [member(ME, 0, false), ...bots(2)]), ME),
      'Private table: you and 2 bots, 3 seats free',
    );
  });

  it('a friend’s table, before and after the reader sits', () => {
    const friend = member('usr_friend', 0, false);
    const watching = member(ME, null, false);
    assert.equal(
      describeTable(room('Private table', [friend, ...bots(2), watching]), ME),
      'Private table: 2 bots and 1 person, 3 seats free',
      'a member watching holds no chair and is not counted as sitting in one',
    );
    const seated = member(ME, 3, false);
    assert.equal(
      describeTable(room('Private table', [friend, ...bots(2), seated]), ME),
      'Private table: you, 2 bots and 1 other person, 2 seats free',
    );
  });
});

describe('the lede is true of every table the page can seat a reader at', () => {
  const page = readFileSync(new URL('../src/app/play/page.tsx', import.meta.url), 'utf8');
  const lede = /const LIVE_LEDE =([\s\S]*?);\n/u.exec(page)?.[1];

  it('does not call every table a table against five bots (REGRESSION)', () => {
    assert.ok(lede !== undefined, 'LIVE_LEDE was not found in app/play/page.tsx');
    const words = lede.replace(/'\s*\+\s*'/gu, '');
    assert.doesNotMatch(words, /A private table against five bots/u);
    assert.match(words, /a private table with seats kept for people you invite/u);
  });

  it('puts the room line where the room is known', () => {
    const live = readFileSync(new URL('../src/app/play/LiveTable.tsx', import.meta.url), 'utf8');
    assert.match(live, /\{describeTable\(room, live\.table\.userId\)\}/u);
    assert.doesNotMatch(live, /at the table`\}/u);
  });
});

/**
 * Plain `/play` opens a bot table, never the legend match the reader just left.
 *
 * ## The defect
 *
 * A legend match links to the bot table ("open the bot table", `/play`) for playing with somebody
 * you know. Following it could leave the reader at the legend match under "Six-handed table"
 * (Devin Review on #24), by two separate paths:
 *
 *  - **No remount.** `/play?profile=…` and `/play` are one route. A client-side navigation between
 *    them re-renders `PlayPage` with new `searchParams` and React keeps `<LiveTable>` where it was,
 *    so `useLiveTable` kept its `roomId` and its open socket to the legend room. Only the heading,
 *    the lede and `legendMatch` (now undefined) changed; `start()` returns early at `ready`.
 *  - **Remount or reload.** `openPracticeRoom` with no `legendMatch` calls `chooseRoom` with the
 *    tab's remembered room — the legend room, remembered when the match opened — and even without
 *    that memory its fallback takes any owned room with a bot seated, which the match is.
 *
 * PR #25's `retirePracticeTables` does not reach either: it runs on `POST /rooms` and
 * `POST /legends/matches`, and reusing a room makes no request at all.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { RoomMember, RoomSummary } from '@prl/contracts';
import { BOT_TABLE_REQUEST, chooseRoom, FRIENDS_TABLE_REQUEST } from '../src/lib/table-rooms.ts';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const READER = 'user-reader';

function member(userId: string, seat: number | null, isBot: boolean, botProfile: string | null): RoomMember {
  return {
    userId,
    displayName: userId,
    seat,
    stack: 1_000,
    isBot,
    botProfile,
    connected: true,
    awaitingBigBlind: false,
  };
}

/** A room the reader owns, shaped like what the API answers for each of the three kinds. */
function room(id: string, name: string, maxSeats: number, bots: readonly string[]): RoomSummary {
  return {
    id,
    name,
    ownerUserId: READER,
    maxSeats,
    smallBlind: 5,
    bigBlind: 10,
    ante: 0,
    startingStack: 1_000,
    actionTimeoutSeconds: 60,
    status: 'open',
    visibility: 'invite_only',
    members: [
      member(READER, 0, false, null),
      ...bots.map((profile, index) => member(`bot-${id}-${String(index)}`, index + 1, true, profile)),
    ],
    createdAt: '2026-11-11T00:00:00.000Z',
  };
}

// `POST /legends/matches` with the one profile the web client sends: `maxSeats` is profiles + 1 and
// the name is the server's own. Calling Station on purpose — it is also a `BOT_TABLE` profile, so a
// rule keyed on which profiles are seated could not tell this room from the bot table.
const LEGEND_MATCH = room('room-legend', 'Legends practice', 2, ['calling-station']);
const BOT_TABLE = room('room-bots', BOT_TABLE_REQUEST.name, BOT_TABLE_REQUEST.maxSeats, [
  'tight-aggressive',
  'tight-aggressive',
  'calling-station',
  'loose-aggressive',
  'nit',
]);
const FRIENDS_TABLE = room('room-friends', FRIENDS_TABLE_REQUEST.name, FRIENDS_TABLE_REQUEST.maxSeats, [
  'tight-aggressive',
  'calling-station',
]);

describe('chooseRoom on the bot table path', () => {
  it('does not hand back a remembered legend match', () => {
    assert.equal(chooseRoom([LEGEND_MATCH], READER, LEGEND_MATCH.id), null);
  });

  it('does not fall back to a legend match either, and prefers a bot table the reader owns', () => {
    assert.equal(chooseRoom([LEGEND_MATCH], READER, null), null);
    assert.equal(chooseRoom([LEGEND_MATCH, BOT_TABLE], READER, LEGEND_MATCH.id)?.id, BOT_TABLE.id);
  });

  it('still resumes the tables /play itself made, so a reload rejoins instead of building another', () => {
    assert.equal(chooseRoom([LEGEND_MATCH, BOT_TABLE], READER, BOT_TABLE.id)?.id, BOT_TABLE.id);
    assert.equal(chooseRoom([BOT_TABLE, FRIENDS_TABLE], READER, FRIENDS_TABLE.id)?.id, FRIENDS_TABLE.id);
  });
});

describe('a change of match on /play remounts the live table', () => {
  it('<LiveTable> is keyed by the match, so a client-side navigation drops the old room and socket', () => {
    const page = readFileSync(join(SRC, 'app', 'play', 'page.tsx'), 'utf8');
    const element = /<LiveTable\b[^>]*\/>/u.exec(page);
    assert.ok(element !== null, '<LiveTable … /> was not found in app/play/page.tsx');
    assert.match(element[0], /\bkey=\{tableKey\}/u);
    assert.match(page, /const tableKey =\s*legendMatch === undefined\s*\?/u);
    assert.match(page, /legendMatch\.profileId/u);
    assert.match(page, /legendMatch\.difficulty/u);
  });
});

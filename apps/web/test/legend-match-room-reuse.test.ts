/**
 * Plain `/play` opens a bot table, never the legend match the reader just left. `/play?profile=…` and
 * `/play` are one route, so React kept `<LiveTable>` and its socket across the navigation, and
 * `chooseRoom` took the remembered legend room on a reload. `retirePracticeTables` reaches neither,
 * because reusing a room makes no request.
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

// `maxSeats` is profiles + 1. Calling Station is also a `BOT_TABLE` profile, so a rule keyed on the
// seated profiles could not tell this room from the bot table.
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

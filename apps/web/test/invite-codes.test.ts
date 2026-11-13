/**
 * Private tables, from both ends. `POST /rooms` returns the code exactly once, and ignoring it is legal
 * TypeScript, so the source assertions check it reaches a screen.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { RoomSummary } from '@prl/contracts';
import {
  firstFreeSeat,
  MAX_INVITE_CODE_INPUT,
  normaliseInviteCode,
  READER_SEAT,
} from '../src/lib/table-rooms.ts';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (...parts: readonly string[]): string => readFileSync(join(SRC, ...parts), 'utf8');

describe('a pasted invite code reaches the wire in a shape the schema accepts', () => {
  it('keeps a clean code exactly as it is', () => {
    assert.equal(normaliseInviteCode('UESA-H2PM-SZ2S-M5BJ'), 'UESA-H2PM-SZ2S-M5BJ');
  });

  it('folds case, because a code is transcribed by a person', () => {
    assert.equal(normaliseInviteCode('uesa-h2pm-sz2s-m5bj'), 'UESA-H2PM-SZ2S-M5BJ');
  });

  it('drops the spaces a copy out of a chat message picks up', () => {
    // This body fails `^[A-Za-z0-9-]{8,32}$` before the server's own normaliser is reached.
    assert.equal(normaliseInviteCode('  UESA H2PM SZ2S M5BJ '), 'UESA-H2PM-SZ2S-M5BJ'.replace(/-/gu, ''));
  });

  it('keeps hyphens, because they are part of the code', () => {
    // `db/seeds/0001_dev_seed.sql` hashes `PRL-DEV-ROOM-1` with its hyphens in place.
    assert.equal(normaliseInviteCode('prl-dev-room-1'), 'PRL-DEV-ROOM-1');
  });

  it('refuses something too short to be a code rather than spending a request on it', () => {
    assert.equal(normaliseInviteCode(''), null);
    assert.equal(normaliseInviteCode('   '), null);
    assert.equal(normaliseInviteCode('ABC-1'), null);
  });

  it('refuses an over-long string rather than truncating it', () => {
    // Truncation would let a typo normalise to somebody else's table.
    assert.equal(normaliseInviteCode('A'.repeat(MAX_INVITE_CODE_INPUT + 1)), null);
    assert.equal(normaliseInviteCode('A'.repeat(MAX_INVITE_CODE_INPUT)), 'A'.repeat(MAX_INVITE_CODE_INPUT));
  });
});

function roomWith(seats: readonly (number | null)[], maxSeats = 6): RoomSummary {
  return {
    id: 'room_test',
    name: 'Private table',
    ownerUserId: 'usr_owner',
    maxSeats,
    smallBlind: 5,
    bigBlind: 10,
    ante: 0,
    startingStack: 1000,
    actionTimeoutSeconds: 60,
    status: 'open',
    visibility: 'invite_only',
    members: seats.map((seat, index) => ({
      userId: `usr_${String(index)}`,
      displayName: `Player ${String(index)}`,
      seat,
      stack: 1000,
      isBot: index > 0,
      botProfile: null,
      connected: true,
      // `firstFreeSeat` is about occupied chairs; a member owing a blind occupies theirs all the same.
      awaitingBigBlind: false,
    })),
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('the seat a joiner is offered', () => {
  it('is seat 0 at the bot table, which is the one the server leaves free', () => {
    // `seatRequestedBots` fills from seat 1 upwards so seat 0 is the reader's.
    const room = roomWith([null, 1, 2, 3, 4, 5]);
    assert.equal(firstFreeSeat(room, 'usr_0'), READER_SEAT);
  });

  it('is NOT seat 0 at a room somebody else owns', () => {
    const room = roomWith([0, 1]);
    assert.equal(firstFreeSeat(room, 'usr_joiner'), 2);
  });

  it('is the seat the reader already holds, so a re-render does not move them', () => {
    const room = roomWith([0, 3]);
    assert.equal(firstFreeSeat(room, 'usr_1'), 3);
  });

  it('is null at a full table, so no control offers a seat that cannot be taken', () => {
    const room = roomWith([0, 1], 2);
    assert.equal(firstFreeSeat(room, 'usr_joiner'), null);
  });
});

describe('the invite code reaches a screen, in both directions', () => {
  it('is rendered by the play screen rather than read and discarded', () => {
    const live = read('app', 'play', 'LiveTable.tsx');
    assert.match(
      live,
      /live\.inviteCode/u,
      'LiveTable must render the code `POST /rooms` returned. It is issued exactly once — only ' +
        'sha256(code) is stored — so a client that does not display it has thrown away the only ' +
        'copy, which is what made "private, invite-only tables" a claim about the server alone.',
    );
    assert.match(
      live,
      /joinByInviteCode/u,
      'LiveTable must offer a way IN to somebody else’s private room. Showing a code with no field ' +
        'to type one into is half a feature.',
    );
  });

  it('is never written to storage or a URL by this client', () => {
    const hook = read('lib', 'use-live-table.ts');
    // The room ID is remembered across a reload; the code is not, so the browser holds no durable key.
    const remembered = hook.slice(hook.indexOf('function rememberRoom'), hook.indexOf('// ------'));
    assert.doesNotMatch(remembered, /inviteCode/u);
    for (const file of ['use-live-table.ts', 'table-rooms.ts'] as const) {
      const text = read('lib', file);
      assert.doesNotMatch(
        text,
        /(?:localStorage|sessionStorage)\.setItem\([^)]*[iI]nvite/u,
        `${file} must not persist an invite code.`,
      );
    }
  });
});

describe('the invite code is on screen when it arrives', () => {
  function inviteCodeSource(): string {
    const live = read('app', 'play', 'LiveTable.tsx');
    const start = live.indexOf('function InviteCode(');
    assert.ok(start >= 0, 'InviteCode is no longer declared in LiveTable.tsx');
    const end = live.indexOf('\nfunction ', start + 1);
    return live.slice(start, end < 0 ? undefined : end).replace(/\s+/gu, ' ');
  }

  it('brings its own block into view by the nearest edge, unless it is already in view', () => {
    // The code once appeared under the Coach sheet's 780px peek at 390x844. A source read pins the move.
    const body = inviteCodeSource();
    assert.match(body, /className="prl-play__invite" ref=\{block\}/u, 'the block must be the thing moved');
    assert.match(body, /if \(element === null \|\| inView\(element\)\) return;/u);
    assert.match(
      body,
      /element\.scrollIntoView\(\{ block: 'nearest', behavior: reduced \? 'auto' : 'smooth' \}\)/u,
    );
  });

  it('remounts for a new code, so the second code of a session is brought in too', () => {
    const live = read('app', 'play', 'LiveTable.tsx').replace(/\s+/gu, ' ');
    assert.match(live, /<InviteCode code=\{live\.inviteCode\} key=\{live\.inviteCode\} \/>/u);
  });
});

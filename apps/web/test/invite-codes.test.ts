/**
 * Private tables, from both ends: the code a room gives its owner, and the code somebody types in.
 *
 * ## What went wrong, and what a test could have caught
 *
 * The API has supported invite-only rooms from the beginning — an audit reviewer played a whole
 * hand across two independent sessions against it — and `grep -rn "inviteCode" apps/web/src`
 * returned nothing at all. `POST /rooms` returns the code exactly once, this client read the
 * response, took `.room` out of it and discarded the rest, and no screen had a field to type one
 * into. The README's "private, invite-only tables with people you already know" described the
 * server.
 *
 * Nothing about that is visible to a type checker: `CreateRoomResponse.inviteCode` being ignored is
 * legal TypeScript, and every test passed. So the source-level assertions below are the ones that
 * would actually have failed — they check that the value reaches a screen at all — and the unit
 * tests around them cover the two pure decisions that make the feature usable rather than merely
 * present.
 *
 * ## Why `normaliseInviteCode` is worth its own tests
 *
 * The server has a forgiving normaliser, and it runs AFTER Fastify has validated the body against
 * `^[A-Za-z0-9-]{8,32}$`. So a code pasted out of a chat message with its spaces intact — the most
 * likely way a code actually travels — is rejected as a malformed request before the forgiving code
 * ever sees it. The client-side normaliser is what closes that gap, and the case that matters is
 * the one nobody would think to try by hand.
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
    // The case the server cannot fix for us: this body fails `^[A-Za-z0-9-]{8,32}$` and is refused
    // as a malformed request before the server's own normaliser is reached.
    assert.equal(normaliseInviteCode('  UESA H2PM SZ2S M5BJ '), 'UESA-H2PM-SZ2S-M5BJ'.replace(/-/gu, ''));
  });

  it('keeps hyphens, because they are part of the code', () => {
    // `db/seeds/0001_dev_seed.sql` hashes `PRL-DEV-ROOM-1` with its hyphens in place. A normaliser
    // that stripped them would make the development room unjoinable by its own documented code.
    assert.equal(normaliseInviteCode('prl-dev-room-1'), 'PRL-DEV-ROOM-1');
  });

  it('refuses something too short to be a code rather than spending a request on it', () => {
    assert.equal(normaliseInviteCode(''), null);
    assert.equal(normaliseInviteCode('   '), null);
    assert.equal(normaliseInviteCode('ABC-1'), null);
  });

  it('refuses an over-long string rather than truncating it', () => {
    // Truncation would make two different long strings normalise to the same code, which is a way
    // to turn a typo into somebody else's table.
    assert.equal(normaliseInviteCode('A'.repeat(MAX_INVITE_CODE_INPUT + 1)), null);
    assert.equal(normaliseInviteCode('A'.repeat(MAX_INVITE_CODE_INPUT)), 'A'.repeat(MAX_INVITE_CODE_INPUT));
  });
});

/** A room roster, as `GET /rooms` returns one. Only the members and seat count matter here. */
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
      // Everyone in this fixture is already dealt in. `firstFreeSeat` is about which chairs are
      // occupied, and a member owing a blind occupies theirs exactly as much as anyone else does —
      // so the flag is false here rather than absent, and varying it would change nothing below.
      awaitingBigBlind: false,
    })),
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('the seat a joiner is offered', () => {
  it('is seat 0 at the bot table, which is the one the server leaves free', () => {
    // `seatRequestedBots` fills from seat 1 upwards precisely so seat 0 is the reader's.
    const room = roomWith([null, 1, 2, 3, 4, 5]);
    assert.equal(firstFreeSeat(room, 'usr_0'), READER_SEAT);
  });

  it('is NOT seat 0 at a room somebody else owns', () => {
    // The defect this closes: a second person arriving by invite code could only ever ask for the
    // seat the room's owner was already sitting in, and the refusal was not something they could
    // act on.
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
    // The room ID is remembered across a reload; the code deliberately is not. Storing it would give
    // the browser a durable key to a private room that the server itself cannot reproduce.
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

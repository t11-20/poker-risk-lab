/**
 * What the live table says to a reader who is out of units, and three sentences that were wrong.
 *
 *   - A seated reader with a zero stack is recognised from the roster. The server deals them out
 *     and keeps them seated; the page said "Your seat: seat 1" and kept "Deal the next hand" enabled,
 *     dealing bot-only hands with no word about why.
 *   - The decision acknowledgement read "The server applied it at sequence 11".
 *   - The Coach-ready sentence said the panel was "below the table on a narrow screen", which on a
 *     phone is a bottom sheet.
 *   - A refused invite code showed "(invite_code_invalid)" after the server's own sentence.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { WsServerMessage } from '@prl/contracts';
import {
  COACH_READY_ANNOUNCEMENT,
  EMPTY_TABLE_STATE,
  outOfUnits,
  type TableState,
  tableReducer,
} from '../src/lib/use-live-table.ts';

const ME = 'usr_reader';

function room(stack: number, seat: number | null): unknown {
  return {
    id: 'room-1',
    name: 'Bot table',
    maxSeats: 6,
    actionTimeoutSeconds: 60,
    members: [
      { userId: ME, displayName: 'Guest 12D91B', seat, stack, isBot: false },
      { userId: 'bot-1', displayName: 'Patient Technician 1', seat: 1, stack: 1000, isBot: true },
    ],
  };
}

describe('a seated reader with nothing left is out of units', () => {
  const at = (stack: number, seat: number | null = 0): Pick<TableState, 'room' | 'userId' | 'seat'> => ({
    room: room(stack, seat) as TableState['room'],
    userId: ME,
    seat,
  });

  it('is read off the roster', () => {
    assert.equal(outOfUnits(at(0)), true);
    assert.equal(outOfUnits(at(1)), false);
    assert.equal(outOfUnits(at(0, null)), false, 'a reader who is not seated is not dealt out of anything');
    assert.equal(outOfUnits({ room: null, userId: ME, seat: 0 }), false);
  });

  // Review on PR #27: after a units reset the notice stayed and Deal stayed disabled. The client half
  // of the answer is that nothing here remembers the bust — it is re-read from every frame — so the
  // `seating` frame PR #25's `LiveTable.restack` publishes clears it. That frame still carries the
  // finished hand, whose view says 0 at the reader's seat; only the roster has the reset figure. This
  // held before the review too: it guards the property the fix relies on, and is not a regression
  // demonstration.
  it('clears on the frame that shows the reset stack at the seat, though the last hand said 0', () => {
    const finished = { handId: 'hand-9', street: 'complete', seats: [{ seat: 0, isSelf: true, stack: 0 }] };
    const frame = (revision: number, stack: number): WsServerMessage =>
      ({
        type: 'state',
        view: finished,
        room: room(stack, 0),
        deadlineMs: null,
        serverTimeMs: 0,
        revision,
      }) as unknown as WsServerMessage;
    const welcomed = tableReducer(EMPTY_TABLE_STATE, {
      kind: 'frame',
      frame: { type: 'welcome', userId: ME, room: room(0, 0), seat: 0, serverTimeMs: 0 } as WsServerMessage,
    });
    const busted = tableReducer(welcomed, { kind: 'frame', frame: frame(1, 0) });
    assert.equal(outOfUnits(busted), true);
    const restacked = tableReducer(busted, { kind: 'frame', frame: frame(2, 1000) });
    assert.equal(outOfUnits(restacked), false);
  });

  it('offers a way on that works when a reset does not reach the seat', () => {
    // Before PR #25 a reset left the live seat at 0, and a reset made while standing, then a seat,
    // was the way to the reset units. The notice used to end at "reset them … to play on".
    const source = readFileSync(
      join(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src'), 'app', 'play', 'LiveTable.tsx'),
      'utf8',
    );
    const notice = /title="You are out of units">([\s\S]*?)<\/Callout>/u.exec(source)?.[1];
    assert.ok(notice !== undefined, 'the out-of-units notice was not found in LiveTable.tsx');
    const words = notice.replace(/\s+/gu, ' ');
    assert.match(words, /stand up, reset once more, then take your seat again/u);
  });
});

describe('the sentences say true things in the reader’s words', () => {
  const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');

  it('does not report the protocol’s sequence number to the reader', () => {
    const pending = {
      action: { type: 'call' },
      actionId: 'a',
      expectedSequence: 10,
      requestId: 'r',
    } as const;
    const submitted = tableReducer(EMPTY_TABLE_STATE, { kind: 'submit', pending, delivery: 'sent' });
    const acked = tableReducer(submitted, {
      kind: 'frame',
      frame: { type: 'ack', requestId: 'r', appliedSequence: 11 } as unknown as WsServerMessage,
    });
    assert.equal(acked.submission?.status, 'accepted');
    assert.doesNotMatch(acked.submission?.message ?? '', /sequence|\d/u);
  });

  it('does not tell a phone the Coach is below the table, where it is a sheet', () => {
    assert.doesNotMatch(COACH_READY_ANNOUNCEMENT, /below the table/u);
    // J3.11 in `scripts/ax-assertions.mjs` keys on these opening words, and refuses any digit.
    assert.match(COACH_READY_ANNOUNCEMENT, /^The analysis of this decision is ready in the Coach panel/u);
    assert.doesNotMatch(COACH_READY_ANNOUNCEMENT, /\d/u);
  });

  it('does not show a contract code under the invite field', () => {
    const source = readFileSync(join(SRC, 'lib', 'use-live-table.ts'), 'utf8');
    assert.match(source, /setJoin\(\{ state: 'refused', message: joinRefusalOf\(cause\) \}\)/u);
    assert.doesNotMatch(source, /setJoin\(\{ state: 'refused', message: messageOf\(cause\) \}\)/u);
  });
});

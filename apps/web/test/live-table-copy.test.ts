/**
 * What the live table says to a reader who is out of units, and three sentences that were wrong.
 *
 *   - A seated reader with a zero stack is recognised from the roster. The server deals them out
 *     and keeps them seated; the page said "Your seat: seat 1" and kept "Deal the next hand" enabled,
 *     dealing bot-only hands with no word about why.
 *   - The decision acknowledgement read "The server applied it at sequence 11".
 *   - The Coach-ready sentence said the panel was "below the table on a narrow screen", which on a
 *     phone is a bottom sheet.
 *   - A refused invite code showed "(invite_code_invalid)" after the server's own sentence, and the
 *     refusal panel and the refused-decision alert did the same with every other code.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { WsServerMessage } from '@prl/contracts';
import { ApiRequestError } from '../src/lib/api.ts';
import {
  COACH_READY_ANNOUNCEMENT,
  EMPTY_TABLE_STATE,
  outOfUnits,
  refusalSentence,
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

  // Audit at 308fadf: "That invite code is not valid. (invite_code_invalid)" under the field, and the
  // same shape in the refusal panel and the refused-decision alert. Driven through the reducer and
  // the one function every REST refusal goes through, rather than read out of the source.
  it('does not show a contract code after any refusal (REGRESSION)', () => {
    const CODE = /\([a-z]+(?:_[a-z]+)+\)|\b[a-z]+_[a-z_]+\b/u;
    const refused = new ApiRequestError({
      message: 'That invite code is not valid.',
      status: 404,
      code: 'invite_code_invalid',
    });
    assert.equal(refusalSentence(refused), 'That invite code is not valid.');

    const notice = tableReducer(EMPTY_TABLE_STATE, {
      kind: 'frame',
      frame: {
        type: 'error',
        requestId: null,
        error: { code: 'insufficient_units', message: 'You do not have enough units for that seat.' },
      } as unknown as WsServerMessage,
    });
    assert.equal(notice.notice, 'You do not have enough units for that seat.');
    assert.equal(notice.noticeCode, 'insufficient_units', 'the code is kept for the screen that branches');

    const pending = { action: { type: 'fold' }, actionId: 'a', expectedSequence: 3, requestId: 'r' } as const;
    const submitted = tableReducer(EMPTY_TABLE_STATE, { kind: 'submit', pending, delivery: 'sent' });
    const rejected = tableReducer(submitted, {
      kind: 'frame',
      frame: {
        type: 'error',
        requestId: 'r',
        error: { code: 'not_your_turn', message: 'It is not your turn to act.' },
      } as unknown as WsServerMessage,
    });
    assert.equal(rejected.submission?.status, 'rejected');
    // J3.19 in `scripts/ax-assertions.mjs` keys on the server's sentence before "Nothing was applied."
    assert.equal(rejected.submission?.message, 'It is not your turn to act. Nothing was applied.');
    for (const shown of [refusalSentence(refused), notice.notice ?? '', rejected.submission?.message ?? '']) {
      assert.doesNotMatch(shown, CODE, `"${shown}" carries a contract code`);
    }
  });
});

/**
 * The reader's own seat is "you" wherever the table narrates it.
 *
 * Audit at 308fadf: "How the hand ended" read "Guest 12D91B wins 1529 from the pot." to the reader
 * who was Guest 12D91B, and the live region said their blinds and their folds the same way. The
 * sentences below are the server's shapes (`apps/api/src/rooms/narration.ts`); the roster is the
 * one `room()` above builds, with the reader at seat 0 as "Guest 12D91B".
 */
describe('the table narrates the reader’s own seat as “you”', () => {
  const welcomed = tableReducer(EMPTY_TABLE_STATE, {
    kind: 'frame',
    frame: { type: 'welcome', userId: ME, room: room(1000, 0), seat: 0, serverTimeMs: 0 } as WsServerMessage,
  });
  const after = (...events: readonly unknown[]): TableState =>
    events.reduce<TableState>(
      (state, event) =>
        tableReducer(state, {
          kind: 'frame',
          frame: { type: 'event', event, serverTimeMs: 0 } as unknown as WsServerMessage,
        }),
      welcomed,
    );

  it('in the result under the table, and in the region (REGRESSION)', () => {
    const done = after(
      {
        kind: 'showdown',
        summaries: ['Guest 12D91B shows a flush, ace high.', 'Patient Technician 1 shows a pair.'],
      },
      { kind: 'handComplete', summaries: ['Guest 12D91B wins 1,529 from the pot.'] },
    );
    assert.deepEqual(done.summary, [
      'You show a flush, ace high.',
      'Patient Technician 1 shows a pair.',
      'You win 1,529 from the pot.',
    ]);
    assert.equal(done.announcement, 'The hand is complete. You win 1,529 from the pot.');
  });

  it('in the blinds and the actions, and nobody else’s', () => {
    const blinds = after({
      kind: 'forcedBets',
      detail: 'Patient Technician 1 posts the small blind, 5. Guest 12D91B posts the big blind, 10.',
    });
    assert.equal(
      blinds.announcement,
      'Patient Technician 1 posts the small blind, 5. You post the big blind, 10.',
    );
    const mine = after({
      kind: 'action',
      seat: 0,
      description: 'Guest 12D91B raises to 1,050',
      wasAutomatic: false,
    });
    assert.equal(mine.announcement, 'You raise to 1,050');
    const theirs = after({
      kind: 'action',
      seat: 1,
      description: 'Patient Technician 1 calls 1,050',
      wasAutomatic: false,
    });
    assert.equal(theirs.announcement, 'Patient Technician 1 calls 1,050');
  });

  it('when the clock runs out at the reader’s seat, and only there', () => {
    assert.equal(
      after({ kind: 'seatTimedOut', seat: 0 }).announcement,
      'You ran out of time and the server acted for you.',
    );
    assert.equal(
      after({ kind: 'seatTimedOut', seat: 1 }).announcement,
      'Seat 2 ran out of time and the server acted for it.',
    );
  });

  it('leaves a sentence it does not recognise exactly as the server wrote it', () => {
    const odd = after({ kind: 'handComplete', summaries: ['Guest 12D91B collects 30 from the pot.'] });
    assert.deepEqual(odd.summary, ['Guest 12D91B collects 30 from the pot.']);
  });
});

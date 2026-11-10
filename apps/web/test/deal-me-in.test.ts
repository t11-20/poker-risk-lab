/**
 * "Deal me in": one press from an empty page to a dealt hand, each step sent once.
 *
 * ## Why these exist
 *
 * `/play` took three presses to reach a first decision — "Open the table", "Take seat 1", "Deal the
 * next hand" — with an empty "Waiting for the table." block between them. `start` now asks for the
 * seat and the deal itself, which turns two intents the reader used to send by hand into intents
 * this page sends on its own. Each of those is a request a server rate-limits and refuses, so what
 * these hold is the part that can go wrong without anybody seeing it: a second `sit` on every
 * whole-state frame, a deal re-sent by a reconnect, a refusal answered by asking again.
 *
 * ## How they drive it
 *
 * There is no renderer in this repository (ADR 0008), so the hook's effect is reproduced here as
 * what it is: after every frame the reducer commits, `dealInStep` is asked for the next step and
 * any send is recorded. The frames are the protocol's own, through the real `tableReducer`, so a
 * `notice` is a real `error` frame and a seat is a real roster.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { WsServerMessage } from '@prl/contracts';
import type { PlayerView } from '@prl/ui';
import { firstFreeSeat } from '../src/lib/table-rooms.ts';
import {
  type DealIn,
  type DealInSend,
  dealInStep,
  EMPTY_TABLE_STATE,
  type TableState,
  tableReducer,
} from '../src/lib/use-live-table.ts';

const ME = 'user-reader';

function member(userId: string, seat: number | null): Record<string, unknown> {
  return { userId, displayName: userId, seat, isBot: userId !== ME };
}

/** The bot table `BOT_TABLE_REQUEST` builds: five bots from seat 2 up, seat 1 left for the reader. */
function room(readerSeat: number | null): unknown {
  return {
    id: 'room-1',
    name: 'Bot table',
    maxSeats: 6,
    members: [
      member(ME, readerSeat),
      member('bot-1', 1),
      member('bot-2', 2),
      member('bot-3', 3),
      member('bot-4', 4),
      member('bot-5', 5),
    ],
  };
}

function welcome(seat: number | null): WsServerMessage {
  return {
    type: 'welcome',
    protocolVersion: 1,
    clientNonce: 'nonce',
    userId: ME,
    room: room(seat),
    seat,
    serverTimeMs: 0,
  } as unknown as WsServerMessage;
}

/** A hand in progress, as far as `onStateFrame` reads one: a view whose street is not `complete`. */
const DEALT = {
  handId: 'hand-1',
  street: 'preflop',
  actionSequence: 1,
  viewerSeat: 0,
  toAct: 3,
  legalActions: [],
  seats: [],
} as unknown as PlayerView;

function state(revision: number, seat: number | null, view: PlayerView | null): WsServerMessage {
  return {
    type: 'state',
    view,
    room: room(seat),
    deadlineMs: null,
    serverTimeMs: 0,
    revision,
  } as unknown as WsServerMessage;
}

const ack: WsServerMessage = { type: 'ack', requestId: 'any' } as WsServerMessage;

function refusal(code: string, message: string): WsServerMessage {
  return { type: 'error', requestId: 'sit-1', error: { code, message } } as unknown as WsServerMessage;
}

/** The hook's state and effect, one commit at a time. */
class Table {
  table: TableState = EMPTY_TABLE_STATE;
  step: DealIn;
  live = true;
  readonly sent: Exclude<DealInSend, null>[] = [];

  constructor(step: DealIn) {
    this.step = step;
  }

  frame(frame: WsServerMessage): this {
    this.table = tableReducer(this.table, { kind: 'frame', frame });
    return this.settle();
  }

  /** What `useEffect` does: re-run until a commit changes nothing. */
  settle(): this {
    for (let commit = 0; commit < 10; commit += 1) {
      const readerSeat =
        this.table.room === null || this.table.userId === null ? 0 : firstFreeSeat(this.table.room, ME);
      const { next, send } = dealInStep(this.step, { live: this.live, table: this.table, readerSeat });
      if (send !== null) this.sent.push(send);
      if (next === this.step) return this;
      this.step = next;
    }
    throw new Error('the deal-in step never settled');
  }
}

describe('Deal me in, at the bot table `start` builds', () => {
  it('sits at the free seat, then deals, and stops once the hand is dealt', () => {
    const table = new Table('wantSeat');
    table.frame(welcome(null)).frame(state(1, null, null));
    assert.deepEqual(table.sent, [{ kind: 'sit', seat: 0 }], 'the seat is asked for once the socket is live');

    table.frame(ack).frame(state(2, 0, null));
    assert.deepEqual(
      table.sent.map((send) => send.kind),
      ['sit', 'deal'],
      'the deal goes out only once the roster shows the reader seated',
    );

    table.frame(state(3, 0, DEALT));
    assert.equal(table.step, 'off', 'a dealt hand is the end of it; later hands are dealt by hand');
  });

  it('sends each step once, through whole-state frames and a reconnect', () => {
    const table = new Table('wantSeat');
    table.frame(welcome(null));
    for (let revision = 1; revision <= 5; revision += 1) table.frame(state(revision, null, null));
    assert.equal(table.sent.length, 1, 'five frames before the seat is confirmed asked for it once');

    // The socket drops before the seat is confirmed. The chain ends rather than wait: the seat the
    // server never confirmed is the reader's to ask for again, with the button that is back.
    table.live = false;
    table.settle();
    table.live = true;
    table.frame(welcome(null)).frame(state(1, null, null));
    assert.equal(table.sent.length, 1, 'a reconnect `welcome` does not re-send the sit');
    assert.equal(table.step, 'off');
  });

  it('does not re-send the deal across a reconnect either', () => {
    const table = new Table('wantSeat');
    table
      .frame(welcome(null))
      .frame(state(1, null, null))
      .frame(state(2, 0, null));
    assert.deepEqual(
      table.sent.map((send) => send.kind),
      ['sit', 'deal'],
    );
    table.live = false;
    table.settle();
    table.live = true;
    table.frame(welcome(0)).frame(state(1, 0, null));
    assert.deepEqual(
      table.sent.map((send) => send.kind),
      ['sit', 'deal'],
      'a deal that may already have been applied is never asked for twice',
    );
  });

  it('stops at a refused seat and does not ask again or deal', () => {
    const table = new Table('wantSeat');
    table.frame(welcome(null)).frame(state(1, null, null));
    table.frame(refusal('enrolment_required', 'A seat at a table is part of a course.'));
    assert.equal(table.step, 'off', 'the refusal ends the chain, so the manual buttons come back');
    table.frame(state(2, null, null)).frame(state(3, null, null));
    assert.deepEqual(table.sent, [{ kind: 'sit', seat: 0 }], 'nothing is re-sent after a refusal');
  });

  it('stops at a refused deal', () => {
    const table = new Table('wantSeat');
    table
      .frame(welcome(null))
      .frame(state(1, null, null))
      .frame(state(2, 0, null));
    table.frame(refusal('rate_limited', 'Too many requests.'));
    assert.equal(table.step, 'off');
    table.frame(state(3, 0, null));
    assert.equal(table.sent.filter((send) => send.kind === 'deal').length, 1);
  });

  it('converges without sending anything at a room where the reader is already in a hand', () => {
    // `chooseRoom` reuses a room the reader owns, and a reader can be mid-hand in it.
    const table = new Table('wantSeat');
    table.frame(welcome(0)).frame(state(1, 0, DEALT));
    assert.deepEqual(table.sent, []);
    assert.equal(table.step, 'off');
  });

  it('deals without sitting when the reused room already has the reader seated', () => {
    const table = new Table('wantSeat');
    table.frame(welcome(0)).frame(state(1, 0, null));
    assert.deepEqual(table.sent, [{ kind: 'deal' }]);
  });

  it('waits for the socket instead of sending into a connection that is not live', () => {
    const table = new Table('wantSeat');
    table.live = false;
    table.frame(welcome(null)).frame(state(1, null, null));
    assert.deepEqual(table.sent, [], 'nothing goes out before the socket is live');
    assert.equal(table.step, 'wantSeat', 'and the intent is still held for when it is');
  });
});

describe('Deal me in is off everywhere `start` did not ask for it', () => {
  it('sends nothing at a table joined by invite code, or built for friends', () => {
    // `joinByInviteCode`, `startPrivateTable` and `startFreshTable` all set `off`. At somebody
    // else's table seat 1 is the owner's and dealing is theirs to ask for.
    const table = new Table('off');
    table
      .frame(welcome(null))
      .frame(state(1, null, null))
      .frame(state(2, 0, null));
    assert.deepEqual(table.sent, []);
  });
});

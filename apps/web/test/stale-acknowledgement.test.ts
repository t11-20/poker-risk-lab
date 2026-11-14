/**
 * The server sends a decision's new state before its ack (logged order: action, event, state, ack). An
 * ack that arrives after the table has moved on must not put "Decision applied" back on screen.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { WsServerMessage } from '@prl/contracts';
import type { PlayerView } from '@prl/ui';
import {
  EMPTY_TABLE_STATE,
  type PendingDecision,
  type TableState,
  tableReducer,
} from '../src/lib/use-live-table.ts';

const ME = 'usr_reader';
const SERVER_TIME = 1_794_404_142_904;

const ROOM = {
  id: 'room-1',
  name: 'Bot table',
  maxSeats: 6,
  actionTimeoutSeconds: 60,
  members: [
    { userId: ME, displayName: 'Guest 12D91B', seat: 0, stack: 1000, isBot: false },
    { userId: 'bot-1', displayName: 'Patient Technician 1', seat: 1, stack: 1000, isBot: true },
  ],
};

function view(actionSequence: number, street: string, toAct: number | null): PlayerView {
  return {
    handId: 'hand-1',
    street,
    actionSequence,
    viewerSeat: 0,
    toAct,
    legalActions: toAct === 0 ? [{ type: 'check' }, { type: 'bet', min: 10, max: 1000 }] : [],
    seats: [{ seat: 0, isSelf: true, stack: 990 }],
    amountToCall: 0,
    potTotal: 30,
  } as unknown as PlayerView;
}

function frame(message: unknown): WsServerMessage {
  return message as WsServerMessage;
}

const CALL: PendingDecision = {
  action: { type: 'call' },
  actionId: 'act-1',
  expectedSequence: 4,
  requestId: 'req-1',
};

function decidingAt(sequence: number): TableState {
  let s = tableReducer(EMPTY_TABLE_STATE, {
    kind: 'frame',
    frame: frame({ type: 'welcome', userId: ME, room: ROOM, seat: 0, serverTimeMs: SERVER_TIME }),
  });
  s = tableReducer(s, {
    kind: 'frame',
    frame: frame({
      type: 'state',
      view: view(sequence, 'preflop', 0),
      room: ROOM,
      deadlineMs: SERVER_TIME + 60_000,
      serverTimeMs: SERVER_TIME,
      revision: 1,
    }),
  });
  return tableReducer(s, { kind: 'submit', pending: CALL, delivery: 'sent' });
}

function stateFrame(s: TableState, next: PlayerView | null, revision: number): TableState {
  return tableReducer(s, {
    kind: 'frame',
    frame: frame({
      type: 'state',
      view: next,
      room: ROOM,
      deadlineMs: null,
      serverTimeMs: SERVER_TIME,
      revision,
    }),
  });
}

const ACK = { kind: 'frame', frame: frame({ type: 'ack', requestId: 'req-1' }) } as const;

describe('an acknowledgement that arrives after the table moved on', () => {
  it('shows nothing when the state frame already moved to the next decision', () => {
    const moved = stateFrame(decidingAt(4), view(6, 'flop', 0), 2);
    const acked = tableReducer(moved, ACK);
    assert.equal(acked.pending, null, 'the decision is no longer in flight');
    assert.equal(acked.submission, null, 'no "Decision applied" beside controls that are already back');
  });

  it('shows nothing when the state frame already ended the hand', () => {
    const ended = stateFrame(decidingAt(4), view(5, 'complete', null), 2);
    const acked = tableReducer(ended, ACK);
    assert.equal(acked.submission, null, 'no acknowledgement under "This hand is complete"');
  });

  it('still says "accepted" when the ack beats the state frame', () => {
    const acked = tableReducer(decidingAt(4), ACK);
    assert.equal(acked.pending, null);
    assert.equal(acked.submission?.status, 'accepted');
  });
});

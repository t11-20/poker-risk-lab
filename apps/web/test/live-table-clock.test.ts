/**
 * The live table's reducer against defects found in the running build, each block with a NEGATIVE
 * CONTROL. The turn ring's budget is the deadline the server set for THIS turn, not the room's clock.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { WsServerMessage } from '@prl/contracts';
import type { PlayerView } from '@prl/ui';
import {
  AUTO_ACTED_NOTICE,
  EMPTY_TABLE_STATE,
  type TableState,
  tableReducer,
  turnClockFor,
} from '../src/lib/use-live-table.ts';

const ME = 'usr_reader';
const SERVER_TIME = 1_794_404_142_904;
const READER_DEADLINE = 1_794_404_382_903; // 239,999ms later: the learner's clock
const BOT_DEADLINE = SERVER_TIME + 60_000; // the room's own clock, which bots get

function room(stack = 1000, seat: number | null = 0): unknown {
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

const LIVE_VIEW = {
  handId: 'hand-1',
  street: 'preflop',
  actionSequence: 0,
  viewerSeat: 0,
  toAct: 0,
  legalActions: [{ type: 'fold' }],
  seats: [{ seat: 0, isSelf: true, stack: 1000 }],
  amountToCall: 10,
  potTotal: 15,
} as unknown as PlayerView;

function welcome(): WsServerMessage {
  return {
    type: 'welcome',
    userId: ME,
    room: room(),
    seat: 0,
    serverTimeMs: SERVER_TIME,
  } as unknown as WsServerMessage;
}

function state(
  revision: number,
  deadlineMs: number | null,
  serverTimeMs: number,
  extra = {},
): WsServerMessage {
  return {
    type: 'state',
    view: LIVE_VIEW,
    room: room(),
    deadlineMs,
    serverTimeMs,
    revision,
    ...extra,
  } as unknown as WsServerMessage;
}

function event(body: unknown): WsServerMessage {
  return { type: 'event', event: body, serverTimeMs: SERVER_TIME } as unknown as WsServerMessage;
}

function drive(frames: readonly WsServerMessage[], from: TableState = EMPTY_TABLE_STATE): TableState {
  return frames.reduce((table, frame) => tableReducer(table, { kind: 'frame', frame }), from);
}

describe('the turn ring is told the budget the server set for this turn', () => {
  it('is 240 seconds when the first frame of the turn carries a 239,999ms deadline', () => {
    const table = drive([welcome(), state(1, READER_DEADLINE, SERVER_TIME)]);
    assert.equal(turnClockFor(table)?.budgetSeconds, 240);
  });

  it('keeps the budget while the turn runs, instead of shrinking it frame by frame', () => {
    // The same deadline 90 seconds later is the same turn, so it is a 240s ring with 150s left.
    const table = drive([
      welcome(),
      state(1, READER_DEADLINE, SERVER_TIME),
      state(2, READER_DEADLINE, SERVER_TIME + 90_000),
    ]);
    assert.equal(turnClockFor(table)?.budgetSeconds, 240);
    assert.equal(table.serverTimeMs, SERVER_TIME + 90_000);
  });

  it('takes a new deadline as a new turn — a bot’s 60s clock is drawn as 60', () => {
    const table = drive([
      welcome(),
      state(1, READER_DEADLINE, SERVER_TIME),
      state(2, BOT_DEADLINE, SERVER_TIME),
    ]);
    assert.equal(turnClockFor(table)?.budgetSeconds, 60);
  });

  it('keeps the room clock as a floor for a page that arrives mid-turn', () => {
    // A reload 15 seconds into a bot's 60-second turn sees 45 seconds left; the turn was still 60.
    const table = drive([welcome(), state(1, BOT_DEADLINE, SERVER_TIME + 15_000)]);
    assert.equal(turnClockFor(table)?.budgetSeconds, 60);
  });

  it('has no clock between hands', () => {
    const table = drive([welcome(), state(1, null, SERVER_TIME, { view: null })]);
    assert.equal(turnClockFor(table), null);
  });

  it('NEGATIVE CONTROL: the old derivation — the room clock — says 60 for the same frame', () => {
    const table = drive([welcome(), state(1, READER_DEADLINE, SERVER_TIME)]);
    const old =
      table.room === null
        ? null
        : (table.room as unknown as { actionTimeoutSeconds: number }).actionTimeoutSeconds;
    assert.equal(old, 60, 'the fixture no longer reproduces the defect it was captured from');
    assert.notEqual(turnClockFor(table)?.budgetSeconds, old);
  });
});

describe('a fold the server made for the reader stays on screen', () => {
  const timedOut = [
    event({ kind: 'seatTimedOut', seat: 0 }),
    event({ kind: 'action', seat: 0, description: 'Guest 12D91B folds', wasAutomatic: true }),
  ];

  it('is set by the automatic action at the reader’s own seat and survives the next state frame', () => {
    const table = drive([
      welcome(),
      state(1, READER_DEADLINE, SERVER_TIME),
      ...timedOut,
      state(2, BOT_DEADLINE, SERVER_TIME),
    ]);
    assert.equal(table.autoActed, AUTO_ACTED_NOTICE);
    // The reader submitted nothing, so it does not live in `submission`.
    assert.equal(table.submission, null);
  });

  it('is cleared when the next hand is dealt', () => {
    const table = drive([
      welcome(),
      ...timedOut,
      event({ kind: 'handStarted', handId: 'hand-2', commitmentRoot: 'x' }),
    ]);
    assert.equal(table.autoActed, null);
  });

  it('is not set by somebody else timing out, or by the reader acting themselves', () => {
    const bot = drive([
      welcome(),
      event({ kind: 'action', seat: 1, description: 'x folds', wasAutomatic: true }),
    ]);
    assert.equal(bot.autoActed, null);
    const mine = drive([
      welcome(),
      event({ kind: 'action', seat: 0, description: 'x folds', wasAutomatic: false }),
    ]);
    assert.equal(mine.autoActed, null);
  });

  // "Stand up" while holding cards folds with `{ automatic: true }`, the same flag as a timeout, but with
  // no `seatTimedOut` before it.
  const stoodUp = [event({ kind: 'action', seat: 0, description: 'Guest 12D91B folds', wasAutomatic: true })];

  it('is not set by the fold the server makes for a reader who stood up', () => {
    const table = drive([
      welcome(),
      state(1, READER_DEADLINE, SERVER_TIME),
      ...stoodUp,
      state(2, BOT_DEADLINE, SERVER_TIME),
    ]);
    assert.equal(table.autoActed, null, 'a reader who pressed "Stand up" was told their clock ran out');
  });

  it('does not narrate that fold as a clock running out, and still narrates a real one that way', () => {
    const left = drive([welcome(), state(1, READER_DEADLINE, SERVER_TIME), ...stoodUp]);
    assert.doesNotMatch(left.announcement, /clock|time/u);
    assert.match(left.announcement, /^You fold \(the server acted for you\)$/u);
    const expired = drive([welcome(), state(1, READER_DEADLINE, SERVER_TIME), ...timedOut]);
    assert.match(expired.announcement, /the clock ran out/u);
  });

  it('is not set by another seat’s expiry followed by the reader’s own automatic fold', () => {
    // The marker belongs to the seat the event named, and to the one event after it.
    const table = drive([
      welcome(),
      event({ kind: 'seatTimedOut', seat: 1 }),
      event({ kind: 'action', seat: 1, description: 'x checks', wasAutomatic: true }),
      ...stoodUp,
    ]);
    assert.equal(table.autoActed, null);
  });
});

describe('how the hand ended keeps the showdown', () => {
  const showdown = event({
    kind: 'showdown',
    summaries: [
      'Guest 12D91B shows high card king, queen ten kickers.',
      'Reading Pressure shows flush, ace high.',
    ],
  });
  const complete = event({
    kind: 'handComplete',
    summaries: [
      'Reading Pressure wins 1622 from the main pot.',
      'Reading Pressure wins 646 from side pot 1.',
    ],
  });

  it('lists what was shown, then who was paid', () => {
    const table = drive([welcome(), showdown, complete]);
    assert.deepEqual(table.summary, [
      'You show high card king, queen ten kickers.',
      'Reading Pressure shows flush, ace high.',
      'Reading Pressure wins 1622 from the main pot.',
      'Reading Pressure wins 646 from side pot 1.',
    ]);
  });

  it('starts empty again on the next deal', () => {
    const table = drive([
      welcome(),
      showdown,
      complete,
      event({ kind: 'handStarted', handId: 'h2', commitmentRoot: 'x' }),
    ]);
    assert.deepEqual(table.summary, []);
  });

  it('NEGATIVE CONTROL: the detector fails a summary that has lost the showdown lines', () => {
    const table = drive([welcome(), showdown, complete]);
    assert.ok(
      table.summary.some((line) => /flush, ace high/u.test(line)),
      'the showdown line was overwritten',
    );
    const overwritten = ['Reading Pressure wins 1622 from the main pot.'];
    assert.equal(
      overwritten.some((line) => /flush, ace high/u.test(line)),
      false,
    );
  });
});

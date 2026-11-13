/**
 * A Coach report belongs to the spot it was COMPUTED for. The `coach` frame carries only a `requestId`,
 * so a late report must be dropped, not filed under the spot on screen. The on-time case is asserted too.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CoachReport, WsServerMessage } from '@prl/contracts';
import type { PlayerView, SeatView } from '@prl/ui';
import {
  COACH_READY_ANNOUNCEMENT,
  decisionKey,
  EMPTY_TABLE_STATE,
  tableReducer,
} from '../src/lib/use-live-table.ts';

/** Typed views, because `src/fixtures/table.ts` imports `@prl/ui`, whose `.tsx` Node cannot load. */
const HERO_SEAT: SeatView = {
  seat: 0,
  playerId: 'test-hero',
  stack: 970,
  committedThisStreet: 0,
  committedTotal: 30,
  status: 'active',
  position: 'BB',
  holeCards: [51, 47],
  isSelf: true,
  isButton: false,
  isToAct: true,
};

const OPPONENT_SEAT: SeatView = {
  seat: 2,
  playerId: 'test-bot',
  stack: 965,
  committedThisStreet: 35,
  committedTotal: 45,
  status: 'active',
  position: 'CO',
  holeCards: null,
  isSelf: false,
  isButton: true,
  isToAct: false,
};

/** The spot the analysis is asked about: `hand-1:7`, 35 to call into a pot of 100. */
const DECISION_VIEW: PlayerView = {
  handId: 'hand-1',
  roomId: 'room-1',
  handNumber: 12,
  config: { smallBlind: 5, bigBlind: 10, ante: 0, maxSeats: 6, actionTimeoutSeconds: 30 },
  street: 'flop',
  board: [20, 8, 3],
  buttonSeat: 2,
  seats: [HERO_SEAT, OPPONENT_SEAT],
  toAct: 0,
  betLevel: 35,
  minimumRaiseTo: 70,
  potTotal: 100,
  pots: [{ amount: 100, eligibleSeats: [0, 2], capPerSeat: 45, index: 0 }],
  forcedBets: [
    { kind: 'smallBlind', seat: 2, amount: 5, wasShort: false },
    { kind: 'bigBlind', seat: 0, amount: 10, wasShort: false },
  ],
  actions: [],
  actionSequence: 7,
  legalActions: [
    { type: 'fold' },
    { type: 'call', minTo: 35, costAtMin: 35 },
    { type: 'raise', minTo: 70, maxTo: 970, costAtMin: 70, allInAtMax: true },
  ],
  amountToCall: 35,
  commitmentRoot: 'a'.repeat(64),
  commitmentContext: 'prl/test',
  result: null,
  viewerSeat: 0,
  randomSourceKind: 'csprng',
};

/** The same hand after the fold: `hand-1:11`, a pot of 1,505 and nothing to call. */
const SETTLED_VIEW: PlayerView = {
  ...DECISION_VIEW,
  street: 'complete',
  seats: [
    { ...HERO_SEAT, isToAct: false, status: 'folded' },
    { ...OPPONENT_SEAT, isToAct: false },
  ],
  toAct: null,
  legalActions: [],
  amountToCall: 0,
  potTotal: 1_505,
  pots: [{ amount: 1_505, eligibleSeats: [2], capPerSeat: 800, index: 0 }],
  actionSequence: 11,
};

function stateFrame(view: PlayerView | null, revision: number): WsServerMessage {
  return {
    type: 'state',
    view,
    room: { id: 'room-1', name: 'Fixture room', members: [] },
    deadlineMs: null,
    serverTimeMs: 0,
    revision,
  } as unknown as WsServerMessage;
}

function coachFrame(requestId: string): WsServerMessage {
  const report = { street: 'flop', potTotal: 100, amountToCall: 35 } as unknown as CoachReport;
  return { type: 'coach', requestId, report } as WsServerMessage;
}

function askedAtTheDecision(): ReturnType<typeof tableReducer> {
  const dealt = tableReducer(EMPTY_TABLE_STATE, { kind: 'frame', frame: stateFrame(DECISION_VIEW, 1) });
  assert.equal(decisionKey(dealt.view), 'hand-1:7');
  return tableReducer(dealt, {
    kind: 'coachRequested',
    requestId: 'coach-1',
    key: decisionKey(dealt.view),
  });
}

describe('a Coach report is filed under the spot it was computed for', () => {
  it('keeps the report when it arrives while that spot is still on screen', () => {
    const arrived = tableReducer(askedAtTheDecision(), {
      kind: 'frame',
      frame: coachFrame('coach-1'),
    });
    assert.deepEqual(arrived.coach?.key, 'hand-1:7', 'the report is keyed on the spot it was asked about');
    assert.equal(arrived.announcement, COACH_READY_ANNOUNCEMENT);
  });

  it('keys it on the REQUESTED spot even when a repeat frame for the same spot has landed', () => {
    // ADR 0009 sends state whole, so several `state` frames for one decision are normal.
    const asked = askedAtTheDecision();
    const again = tableReducer(asked, { kind: 'frame', frame: stateFrame(DECISION_VIEW, 2) });
    const arrived = tableReducer(again, { kind: 'frame', frame: coachFrame('coach-1') });
    assert.deepEqual(arrived.coach?.key, 'hand-1:7');
  });

  it('drops a report that arrives after the hand has moved on, rather than re-keying it', () => {
    const asked = askedAtTheDecision();
    // The last `state` frame of the hand arrives BEFORE the analysis of the spot that is now over.
    const over = tableReducer(asked, { kind: 'frame', frame: stateFrame(SETTLED_VIEW, 2) });
    assert.equal(decisionKey(over.view), 'hand-1:11');

    const late = tableReducer(over, { kind: 'frame', frame: coachFrame('coach-1') });

    assert.notEqual(
      late.coach?.key,
      'hand-1:11',
      'a report may never take the key of the spot that happened to be on screen when it arrived',
    );
    assert.equal(
      late.coach,
      null,
      'the report was computed for hand-1:7. Filing it under hand-1:11 puts "100 units in the pot, ' +
        '35 to call" beside a finished hand whose pot is 1,505 and whose price to call is 0.',
    );
    assert.equal(
      late.announcement,
      over.announcement,
      'nothing appeared in the Coach panel, so there is nothing to announce — announcing an arrival ' +
        'that is not on screen sends a reader to look for a panel that never filled',
    );
  });

  it('clears the outstanding request the moment the spot changes', () => {
    const asked = askedAtTheDecision();
    const over = tableReducer(asked, { kind: 'frame', frame: stateFrame(SETTLED_VIEW, 2) });
    assert.equal(
      over.coachRequest,
      null,
      'the analysis of a spot nobody is in any more is not wanted, so the request that would let a ' +
        'late frame in is closed with the spot',
    );
  });
});

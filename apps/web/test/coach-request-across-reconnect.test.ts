/**
 * A Coach request does not survive its socket, and the client must notice. The server answers a
 * `requestId` only on the connection it arrived on, so an outstanding request is never answered after
 * a reconnect, and a reconnect usually lands the reader back in the same spot. The hook half
 * (`coachRequestRef`) has no renderer under `node --test` (ADR 0008); a Chrome run is its evidence.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CoachReport, WsServerMessage } from '@prl/contracts';
import type { PlayerView, SeatView } from '@prl/ui';
import { decisionKey, EMPTY_TABLE_STATE, tableReducer } from '../src/lib/use-live-table.ts';

/** Typed rather than imported from `src/fixtures/table.ts`, which `node --test` cannot load. */
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

const DECISION_VIEW: PlayerView = {
  handId: 'hand-1',
  roomId: 'room-1',
  handNumber: 12,
  config: { smallBlind: 5, bigBlind: 10, ante: 0, maxSeats: 6, actionTimeoutSeconds: 30 },
  street: 'flop',
  board: [20, 8, 3],
  buttonSeat: 2,
  seats: [HERO_SEAT],
  toAct: 0,
  betLevel: 35,
  minimumRaiseTo: 70,
  potTotal: 100,
  pots: [{ amount: 100, eligibleSeats: [0], capPerSeat: 45, index: 0 }],
  forcedBets: [],
  actions: [],
  actionSequence: 7,
  legalActions: [{ type: 'fold' }, { type: 'call', minTo: 35, costAtMin: 35 }],
  amountToCall: 35,
  commitmentRoot: 'a'.repeat(64),
  commitmentContext: 'prl/test',
  result: null,
  viewerSeat: 0,
  randomSourceKind: 'csprng',
};

const ROOM = { id: 'room-1', name: 'Fixture room', members: [] };

function stateFrame(view: PlayerView | null, revision: number): WsServerMessage {
  return {
    type: 'state',
    view,
    room: ROOM,
    deadlineMs: null,
    serverTimeMs: 0,
    revision,
  } as unknown as WsServerMessage;
}

/** The frame a reconnect opens with. `revision` restarts at zero on the new socket. */
function welcomeFrame(): WsServerMessage {
  return {
    type: 'welcome',
    protocolVersion: 1,
    clientNonce: 'nonce',
    userId: 'user-1',
    room: ROOM,
    seat: 0,
    serverTimeMs: 0,
  } as unknown as WsServerMessage;
}

function coachFrame(requestId: string): WsServerMessage {
  const report = { street: 'flop', potTotal: 100, amountToCall: 35 } as unknown as CoachReport;
  return { type: 'coach', requestId, report } as WsServerMessage;
}

/** The reader's turn at `hand-1:7`, with the automatic request already out and unanswered. */
function askedAtTheDecision(): ReturnType<typeof tableReducer> {
  const dealt = tableReducer(EMPTY_TABLE_STATE, { kind: 'frame', frame: stateFrame(DECISION_VIEW, 1) });
  assert.equal(decisionKey(dealt.view), 'hand-1:7');
  return tableReducer(dealt, { kind: 'coachRequested', requestId: 'coach-1', key: 'hand-1:7' });
}

describe('an outstanding Coach request and a reconnect', () => {
  it('closes the request on `welcome`, because nothing is ever going to answer it', () => {
    const asked = askedAtTheDecision();
    assert.notEqual(asked.coachRequest, null, 'the request is outstanding before the socket dies');

    const reconnected = tableReducer(asked, { kind: 'frame', frame: welcomeFrame() });

    assert.equal(
      reconnected.coachRequest,
      null,
      'the request belonged to the socket that has just been replaced; leaving it open is what ' +
        'stopped anything asking again',
    );
  });

  it('leaves a report that is already on screen alone, because its spot has not moved', () => {
    const answered = tableReducer(askedAtTheDecision(), { kind: 'frame', frame: coachFrame('coach-1') });
    assert.equal(answered.coach?.key, 'hand-1:7');

    const reconnected = tableReducer(answered, { kind: 'frame', frame: welcomeFrame() });

    assert.equal(
      reconnected.coach?.key,
      'hand-1:7',
      'a socket going away does not change the spot the analysis was computed for',
    );
  });

  it('still refuses an answer to the dead socket if one somehow arrives afterwards', () => {
    const reconnected = tableReducer(askedAtTheDecision(), { kind: 'frame', frame: welcomeFrame() });
    const late = tableReducer(reconnected, { kind: 'frame', frame: coachFrame('coach-1') });
    assert.equal(late.coach, null, 'nothing is waiting for it any more');
  });
});

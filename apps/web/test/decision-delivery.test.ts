/**
 * What the table says about a decision it could not send. `sendRaw` once returned `false` both when
 * the token bucket refused a frame and when there was no socket at all, so a fold pressed during the
 * reconnect backoff (up to 15s) was reported as refused by the rate limit and then applied on replay.
 * The socket now names the refusal, and the reducer produces exactly one sentence per outcome.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { WS_LIMITS } from '@prl/contracts';
import {
  openTableSocket,
  type RawSocket,
  type RawSocketHandlers,
  type Scheduler,
  type SendOutcome,
} from '../src/lib/table-socket.ts';
import { EMPTY_TABLE_STATE, type PendingDecision, tableReducer } from '../src/lib/use-live-table.ts';

const FOLD: PendingDecision = {
  action: { type: 'fold' },
  actionId: 'act-1',
  expectedSequence: 7,
  requestId: 'req-1',
};

function fakeTransport(): {
  readonly sent: string[][];
  readonly handlers: RawSocketHandlers[];
  readonly factory: (url: string, handlers: RawSocketHandlers) => RawSocket;
} {
  const sent: string[][] = [];
  const handlers: RawSocketHandlers[] = [];
  return {
    sent,
    handlers,
    factory: (_url, socketHandlers) => {
      const mine: string[] = [];
      sent.push(mine);
      handlers.push(socketHandlers);
      return { send: (data) => mine.push(data), close: () => undefined };
    },
  };
}

/** A clock that never moves, so a fifteen-second backoff costs no seconds. */
function frozenScheduler(): Scheduler {
  return { now: () => 1_000, delay: () => () => undefined };
}

describe('the socket says WHICH refusal it was', () => {
  it('reports a decision it had no socket for as disconnected, not as a rate limit', () => {
    const transport = fakeTransport();
    const handle = openTableSocket({
      roomId: 'room_test0001',
      url: 'ws://x/api/v1/ws',
      onFrame: () => undefined,
      onStatus: () => undefined,
      onClose: () => undefined,
      socketFactory: transport.factory,
      scheduler: frozenScheduler(),
    });
    transport.handlers[0]?.onOpen();
    assert.equal(handle.action(FOLD), 'sent', 'the frame goes out while the socket is open');

    // 1006, the ordinary drop. `socket` is null from here until the backoff fires.
    transport.handlers[0]?.onClose(1006, 'gone', false);
    assert.equal(
      handle.action(FOLD),
      'disconnected',
      'there is no socket to refuse anything: the token bucket was never consulted, so blaming it ' +
        'invents a cause and tells the reader to slow down when what they should do is wait',
    );
    handle.dispose();
  });

  it('reports its own token bucket as exactly that', () => {
    const transport = fakeTransport();
    const handle = openTableSocket({
      roomId: 'room_test0001',
      url: 'ws://x/api/v1/ws',
      onFrame: () => undefined,
      onStatus: () => undefined,
      onClose: () => undefined,
      socketFactory: transport.factory,
      scheduler: frozenScheduler(),
    });
    transport.handlers[0]?.onOpen();
    // The clock never advances, so the bucket never refills. `hello` has already spent one token.
    for (let index = 0; index < WS_LIMITS.burstAllowance; index += 1) handle.action(FOLD);
    assert.equal(
      handle.action(FOLD),
      'rate-limited',
      'the socket is open and the bucket is empty — this is the one case the old message described',
    );
    handle.dispose();
  });
});

const DELIVERIES: readonly SendOutcome[] = ['sent', 'disconnected', 'rate-limited', 'undeliverable'];

describe('the table tells the reader what actually happened to their decision', () => {
  it('says it was sent only when it was sent', () => {
    const sent = tableReducer(EMPTY_TABLE_STATE, { kind: 'submit', pending: FOLD, delivery: 'sent' });
    assert.equal(sent.submission?.status, 'pending');
    assert.match(sent.submission?.message ?? '', /^Sent\./u);
    assert.equal(sent.notice, null, 'nothing was refused, so there is nothing to alert about');
    assert.deepEqual(sent.pending, FOLD);
  });

  it('says a decision it could not send is held, and keeps it to replay', () => {
    const held = tableReducer(EMPTY_TABLE_STATE, {
      kind: 'submit',
      pending: FOLD,
      delivery: 'disconnected',
    });
    assert.equal(held.submission?.status, 'held');
    assert.doesNotMatch(
      held.submission?.message ?? '',
      /rate limit/u,
      'the rate limiter refused nothing here; naming it is the defect this test exists for',
    );
    assert.match(held.submission?.message ?? '', /connection/u);
    assert.deepEqual(
      held.pending,
      FOLD,
      'the decision has to survive: `onFrame` replays it on the next `welcome`, with the same ' +
        'actionId, and the server dedupes — so it really is going to be applied',
    );
    assert.equal(held.notice, null, 'one sentence about one decision, in the region that owns it');
  });

  it('says the page itself refused, and clears the decision, when the bucket refused it', () => {
    const refused = tableReducer(EMPTY_TABLE_STATE, {
      kind: 'submit',
      pending: FOLD,
      delivery: 'rate-limited',
    });
    assert.equal(refused.submission?.status, 'not-sent');
    assert.match(refused.submission?.message ?? '', /rate limit/u);
    assert.equal(
      refused.pending,
      null,
      'the socket is live, so no reconnect will ever replay it. Leaving it pending disables the ' +
        'controls against a decision nothing is going to send.',
    );
  });

  it('never lets the two regions contradict each other', () => {
    for (const delivery of DELIVERIES) {
      const state = tableReducer(EMPTY_TABLE_STATE, { kind: 'submit', pending: FOLD, delivery });
      const claimsSent = state.submission?.status === 'pending';
      assert.equal(
        claimsSent,
        delivery === 'sent',
        `only a sent decision may be reported as sent (delivery: ${delivery})`,
      );
      if (state.notice !== null) {
        assert.equal(claimsSent, false, `the notice contradicts the submission (delivery: ${delivery})`);
      }
      assert.equal(
        state.pending !== null,
        delivery === 'sent' || delivery === 'disconnected',
        `a decision is kept exactly when something will still send it (delivery: ${delivery})`,
      );
    }
  });
});

/**
 * What the table says about a decision it could not send.
 *
 * ## The defect these exist for
 *
 * `sendRaw` returned `false` for two unrelated conditions — the client's own token bucket refused
 * the frame, OR there is no socket at all — and `useLiveTable.act` read that single `false` as
 * "the rate limit refused it". `socket` is null for the whole reconnect backoff, which runs to
 * fifteen seconds, and `stageStatusOf` still reports `ready` in that window, so `ActionBar` is live
 * and a reader can and does press Fold there.
 *
 * They then got both of these at once:
 *
 *  - "Decision sent — the server is the only authority on a hand, so the controls stay disabled
 *    until it answers." (`submission.status === 'pending'`, a polite `role="status"`)
 *  - "The decision was not sent: this page is refusing to exceed the socket rate limit."
 *    (`table.notice`, a `role="alert"`)
 *
 * Three things wrong, in one press. The two announcements contradict each other. The attributed
 * cause is false: no token was ever taken, because the frame never reached the bucket. And the
 * conclusion is false too — `pending` survives, the reconnect replays the frame unchanged
 * (`onFrame`'s `welcome` branch), and the fold is applied after all, so the reader is told their
 * decision was refused by a hand that then gets folded.
 *
 * ## Observed
 *
 *  - **Before the fix:** `handle.action(...)` returned `false` in both conditions, so the two cases
 *    were indistinguishable at the call site; `act` dispatched `submit` (message: "Sent…") and then
 *    a `notice` naming the rate limit, and both were on screen together.
 *  - **After the fix:** the socket reports WHICH refusal it was (`'disconnected'` vs
 *    `'rate-limited'`), the reducer is told, and exactly one of the two sentences is produced:
 *    "held until the connection returns" with the decision still pending, or "this page did not
 *    send it" with the decision cleared so the reader can press again. A `pending` submission and a
 *    notice can no longer coexist.
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

// ---------------------------------------------------------------------------
// The socket half: two refusals, told apart
// ---------------------------------------------------------------------------

/** A transport that records what was written and lets the test decide when it closes. */
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

/** A clock that never moves on its own, so a fifteen-second backoff costs no seconds. */
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

    // 1006, the ordinary drop. `socket` is null from here until the backoff fires — up to 15s.
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

// ---------------------------------------------------------------------------
// The reducer half: one sentence per fate, and never two that disagree
// ---------------------------------------------------------------------------

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
    // The shape of the original defect, asserted as a property rather than as one example: a
    // `role="alert"` saying the decision was not sent, beside a `role="status"` saying it was.
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

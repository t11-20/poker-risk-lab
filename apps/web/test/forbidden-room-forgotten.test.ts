/**
 * A table closed under this tab, by a fresh table started in another tab, answers the reconnect with
 * `4403`. That close never retries, so the hook must let go of the room and offer "Deal me in" again,
 * or the tab sits at "Not connected." with no button that does anything. The hook is read from source,
 * because there is no renderer here (ADR 0008).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { WS_CLOSE } from '@prl/contracts';
import { describeClose } from '../src/lib/table-socket.ts';
import { closeForgetsRoom } from '../src/lib/use-live-table.ts';

describe('a refused room is let go of', () => {
  it('forgets the room on 4403, which never retries', () => {
    const refused = describeClose(WS_CLOSE.forbidden, true);
    assert.equal(refused.retryable, false);
    assert.equal(closeForgetsRoom(refused), true);
  });

  it('keeps it for a close that retries, one with its own button, and a connection live again', () => {
    assert.equal(closeForgetsRoom(describeClose(WS_CLOSE.normal, true)), false);
    assert.equal(closeForgetsRoom(describeClose(1006, false)), false);
    assert.equal(closeForgetsRoom(describeClose(WS_CLOSE.unauthenticated, true)), false);
    assert.equal(closeForgetsRoom(null), false);
  });

  it('puts the tab back where "Deal me in" is offered', () => {
    const source = readFileSync(new URL('../src/lib/use-live-table.ts', import.meta.url), 'utf8');
    const handler = source.slice(source.indexOf('onClose: (meaning)'), source.indexOf('onProblem:'));
    assert.match(handler, /closeForgetsRoom\(meaning\)/u, 'the socket close is not asked about the room');
    assert.match(handler, /setRoomId\(null\)/u);
    // A stale `notice` turns "Deal me in" off before it sits (`dealInStep`).
    assert.match(handler, /dispatch\(\{ kind: 'reset' \}\)/u);
    assert.match(handler, /setPhase\(\(current\) => \(current === 'preparing' \? current : 'idle'\)\)/u);
  });

  it('leaves a join or a new table that is still being prepared to finish (REGRESSION)', () => {
    // A bare `setPhase('idle')` offered "Deal me in" mid-join, and pressing it aborted the join.
    const source = readFileSync(new URL('../src/lib/use-live-table.ts', import.meta.url), 'utf8');
    const handler = source.slice(source.indexOf('onClose: (meaning)'), source.indexOf('onProblem:'));
    assert.doesNotMatch(handler, /setPhase\('idle'\)/u);
  });
});

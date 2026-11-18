/**
 * Joining by invite code the room already open in this tab: pressing "Join that table" twice, or the
 * owner pasting their own code. The socket follows the room id, so tearing it down for a room id that
 * does not change leaves the tab at "Ready to connect." with no socket at all. The hook is read from
 * source, because there is no renderer here (ADR 0008).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { joinMovesTables } from '../src/lib/use-live-table.ts';

describe('a join replaces the socket only when it names another room', () => {
  it('keeps the socket for the room already open here', () => {
    assert.equal(joinMovesTables('room_a', 'room_a'), false);
  });

  it('moves to a different room, and from no room', () => {
    assert.equal(joinMovesTables('room_a', 'room_b'), true);
    assert.equal(joinMovesTables(null, 'room_b'), true);
  });

  it('is asked by the hook before it disposes the socket', () => {
    const source = readFileSync(new URL('../src/lib/use-live-table.ts', import.meta.url), 'utf8');
    const join = source.slice(source.indexOf('await joinRoomByInviteCode('));
    const asked = join.indexOf('joinMovesTables(roomIdRef.current, room.id)');
    assert.ok(asked > 0, 'the join disposes the socket without asking whether the room changed');
    assert.ok(asked < join.indexOf('socketRef.current?.dispose()'), 'the socket is disposed before asking');
  });
});

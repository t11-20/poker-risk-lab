/**
 * Two actions for the same hand submitted in one synchronous turn and awaited together. Every body
 * handed to `LiveTable.enqueue` is synchronous today, so dropping the queue's chain still passes.
 * The memo and the sequence check are what protect a hand now, and breaking either fails these.
 * The queue becomes load-bearing the moment one of those bodies gains an `await`. The tests assert
 * the client contract, which holds either way.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createSecureRandom } from '@prl/poker-engine';
import { AppError } from '../src/errors.ts';
import { LiveTable } from '../src/rooms/table.ts';
import { systemClock } from '../src/rooms/timers.ts';

function incrementingHandIds(): () => string {
  let count = 0;
  return () => {
    count += 1;
    return `hand_cc${count}`;
  };
}

interface Table {
  readonly table: LiveTable;
  readonly problems: string[];
}

/**
 * Three seats so the second submission can come from the next live seat, which reaches
 * `stale_action_sequence` rather than `not_your_turn`. A manual clock would remove the asynchrony.
 */
async function tableWithHand(): Promise<Table> {
  const problems: string[] = [];
  const table = new LiveTable({
    roomId: 'room_cc',
    config: { smallBlind: 5, bigBlind: 10, ante: 0, maxSeats: 3, actionTimeoutSeconds: 300 },
    clock: systemClock,
    random: createSecureRandom(),
    nextHandId: incrementingHandIds(),
    onProblem: (message, detail) => problems.push(`${message} ${JSON.stringify(detail ?? {})}`),
  });
  await table.sit({ userId: 'usr_a', displayName: 'Ada', seat: 0, stack: 1_000 });
  await table.sit({ userId: 'usr_b', displayName: 'Bo', seat: 1, stack: 1_000 });
  await table.sit({ userId: 'usr_c', displayName: 'Cy', seat: 2, stack: 1_000 });
  await table.startHand();
  return { table, problems };
}

function toAct(table: LiveTable): { readonly userId: string; readonly sequence: number } {
  const view = table.viewFor('usr_a');
  assert.ok(view !== null, 'the table has no hand in progress');
  assert.ok(view.toAct !== null, 'the hand is not waiting on anybody');
  const seat = view.seats.find((entry) => entry.seat === view.toAct);
  assert.ok(seat !== undefined, `seat ${String(view.toAct)} is not in the view`);
  return { userId: seat.playerId, sequence: view.actionSequence };
}

function nextToAct(table: LiveTable, current: string): string {
  const view = table.viewFor('usr_a');
  assert.ok(view !== null);
  const live = view.seats.filter((seat) => seat.status === 'active');
  const index = live.findIndex((seat) => seat.playerId === current);
  assert.ok(index >= 0, 'the acting seat is not active');
  const next = live[(index + 1) % live.length];
  assert.ok(next !== undefined && next.playerId !== current, 'expected a second live seat');
  return next.playerId;
}

function codeOf(reason: unknown): string {
  assert.ok(reason instanceof AppError, `expected an AppError, got ${String(reason)}`);
  return reason.code;
}

function progress(table: LiveTable): { readonly sequence: number; readonly actions: number } {
  const view = table.viewFor('usr_a');
  assert.ok(view !== null);
  return { sequence: view.actionSequence, actions: view.actions.length };
}

describe('two actions submitted for one hand at the same time', () => {
  it('applies exactly one of two simultaneous actions and rejects the other as stale', async () => {
    const { table, problems } = await tableWithHand();
    const actor = toAct(table);
    const follower = nextToAct(table, actor.userId);
    const before = progress(table);

    // Whichever runs second acts on a view that no longer exists.
    const [first, second] = await Promise.allSettled([
      table.submitAction(actor.userId, {
        action: { type: 'call' },
        actionId: 'act-simul001',
        expectedSequence: actor.sequence,
      }),
      table.submitAction(follower, {
        action: { type: 'call' },
        actionId: 'act-simul002',
        expectedSequence: actor.sequence,
      }),
    ]);

    assert.equal(first?.status, 'fulfilled', 'the seat whose turn it was must be applied');
    assert.equal(second?.status, 'rejected', 'the other submission must not also be applied');
    assert.equal(
      codeOf(second?.status === 'rejected' ? second.reason : null),
      'stale_action_sequence',
      'the loser acted on a sequence the hand had already moved past, and must be told exactly that',
    );

    const after = progress(table);
    assert.equal(
      after.actions - before.actions,
      1,
      `exactly one action may be logged, ${after.actions - before.actions} were`,
    );
    assert.ok(after.sequence > before.sequence, 'the applied action must have advanced the hand');
    assert.deepEqual(problems, [], 'a serialised table must not log a problem');
  });

  it('treats a replayed actionId submitted concurrently as one application', async () => {
    const { table, problems } = await tableWithHand();
    const actor = toAct(table);
    const before = progress(table);

    // A retry after a dropped response, arriving while the original is still queued.
    const submission = {
      action: { type: 'call' } as const,
      actionId: 'act-replay01',
      expectedSequence: actor.sequence,
    };
    const [first, second] = await Promise.all([
      table.submitAction(actor.userId, submission),
      table.submitAction(actor.userId, submission),
    ]);

    assert.equal(first.deduplicated, false, 'the first application is not a duplicate');
    assert.equal(second.deduplicated, true, 'the replay must be reported as deduplicated');
    assert.equal(
      second.appliedSequence,
      first.appliedSequence,
      'a replay must return the ORIGINAL outcome, not a new one',
    );

    const after = progress(table);
    assert.equal(
      after.actions - before.actions,
      1,
      'a replayed actionId must be a no-op: the hand may only have advanced once',
    );
    assert.deepEqual(problems, []);
  });

  it('rejects a stale expectedSequence in either direction, leaving the hand untouched', async () => {
    const { table } = await tableWithHand();

    // At sequence zero, "one behind" is `max(0, 0 - 1) === 0`, which is current and legal.
    const opener = toAct(table);
    await table.submitAction(opener.userId, {
      action: { type: 'call' },
      actionId: 'act-opener01',
      expectedSequence: opener.sequence,
    });

    const actor = toAct(table);
    assert.ok(actor.sequence >= 1, 'the opening action must have advanced the sequence');

    // A client that ran ahead is as wrong as one that fell behind.
    const results = await Promise.allSettled([
      table.submitAction(actor.userId, {
        action: { type: 'call' },
        actionId: 'act-stale001',
        expectedSequence: actor.sequence + 3,
      }),
      table.submitAction(actor.userId, {
        action: { type: 'call' },
        actionId: 'act-stale002',
        expectedSequence: actor.sequence - 1,
      }),
    ]);

    for (const result of results) {
      assert.equal(result.status, 'rejected', 'neither stale submission may be applied');
      assert.equal(codeOf(result.status === 'rejected' ? result.reason : null), 'stale_action_sequence');
    }
    const after = progress(table);
    assert.equal(after.sequence, actor.sequence, 'a rejected action changes nothing');

    // `enqueue` swallows the rejection on the chain and rethrows to the caller, or one refusal
    // would wedge the table.
    const stillLive = toAct(table);
    const recovered = await table.submitAction(stillLive.userId, {
      action: { type: 'call' },
      actionId: 'act-after001',
      expectedSequence: stillLive.sequence,
    });
    assert.equal(recovered.deduplicated, false);
    assert.ok(recovered.appliedSequence > actor.sequence, 'the table must still accept actions');
  });

  it('serialises a burst of submissions so the hand advances once per legal action', async () => {
    const { table, problems } = await tableWithHand();
    const actor = toAct(table);
    const before = progress(table);

    // A stuck retry loop. Exactly one can be legal.
    const submissions = Array.from({ length: 8 }, (_unused, index) =>
      table.submitAction(actor.userId, {
        action: { type: 'call' },
        actionId: `act-burst${String(index).padStart(3, '0')}`,
        expectedSequence: actor.sequence,
      }),
    );
    const settled = await Promise.allSettled(submissions);

    const applied = settled.filter((result) => result.status === 'fulfilled');
    assert.equal(applied.length, 1, `exactly one of eight may be applied, ${applied.length} were`);
    for (const result of settled.filter((entry) => entry.status === 'rejected')) {
      const code = codeOf(result.status === 'rejected' ? result.reason : null);
      assert.ok(
        code === 'stale_action_sequence' || code === 'not_your_turn',
        `a losing submission must be refused for a reason the client can act on, got ${code}`,
      );
    }
    const after = progress(table);
    assert.equal(after.actions - before.actions, 1, 'the hand may only have advanced once');
    assert.deepEqual(problems, []);
  });
});

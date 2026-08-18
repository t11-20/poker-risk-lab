/**
 * Two actions submitted for the same hand at the same time.
 *
 * ## Why this file exists
 *
 * `LiveTable.enqueue` is the only thing standing between two overlapping submissions and a hand
 * that applies both to the same state:
 *
 * ```ts
 * private enqueue<T>(work: () => T): Promise<T> {
 *   const result = this.queue.then(work);
 *   this.queue = result.then(() => undefined, () => undefined);
 *   return result;
 * }
 * ```
 *
 * Every mutation on a table goes through it, and nothing tested it. The existing tests are strictly
 * sequential — the "deduplicates a repeated actionId" case sends the duplicate *after* the first
 * has resolved — so they exercise the memo and the sequence check but never the interleaving that
 * serialisation exists to prevent. `grep -rn "enqueue" apps/api/test/*.test.ts` returned nothing.
 *
 * ## What "at the same time" means here, precisely
 *
 * Both calls are made in the same synchronous turn, before any `await`, and are then awaited
 * together with `Promise.all` / `allSettled`. That is the strongest form available in a
 * single-threaded runtime and it is exactly the shape that breaks a table with no queue: with the
 * chain removed, both callers read `live.state` before either writes it.
 *
 * ## Would these fail if the behaviour broke? Checked, with one honest correction
 *
 * Three breaks were applied to `table.ts` and reverted:
 *
 *   - `lookupMemo` forced to return null  -> `treats a replayed actionId` fails (applied twice).
 *   - the `expectedSequence` check disabled -> both `applies exactly one` and `rejects a stale
 *     expectedSequence` fail.
 *   - `enqueue` replaced by `Promise.resolve().then(work)`, dropping the chain -> **everything still
 *     passed.**
 *
 * That last result is worth recording rather than hiding, because it says what actually protects a
 * hand today. Every body handed to `enqueue` — `sit`, `startHand`, `submitAction`, `applyTimeout` —
 * is *synchronous*, so the runtime already runs each to completion before the next microtask, and
 * no interleaving is reachable however the promises are chained. The queue is therefore ordering
 * and defence in depth right now, not the thing standing between two callers and a double-applied
 * action; the memo and the sequence check are. The moment any one of those bodies gains an `await`
 * — an archive write moved inline, a store lookup — the queue becomes load-bearing, and these tests
 * become the ones that notice. They assert the observable contract (exactly one application, a
 * replay is a no-op returning the original outcome, a stale sequence is refused) which holds either
 * way and is what a client depends on.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createSecureRandom } from '@prl/poker-engine';
import { AppError } from '../src/errors.ts';
import { LiveTable } from '../src/rooms/table.ts';
import { systemClock } from '../src/rooms/timers.ts';

/** Readable, sequential hand ids, so a failure names the hand it happened in. */
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
 * A three-seat table with a hand in progress.
 *
 * Three seats rather than two so that after the first action the turn moves to a *different* seat
 * that is still live — which is what lets the second, simultaneous submission come from the seat
 * that is about to be asked to act. Heads-up, the same interleaving is only reachable through the
 * `not_your_turn` check, and it is the `stale_action_sequence` path that matters here.
 *
 * The real clock and the real CSPRNG: nothing about this file depends on which cards were dealt,
 * and a manual clock would remove the asynchrony the test is about.
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

/** Whose turn it is, and the sequence they must quote. Read from the table, never assumed. */
function toAct(table: LiveTable): { readonly userId: string; readonly sequence: number } {
  const view = table.viewFor('usr_a');
  assert.ok(view !== null, 'the table has no hand in progress');
  assert.ok(view.toAct !== null, 'the hand is not waiting on anybody');
  const seat = view.seats.find((entry) => entry.seat === view.toAct);
  assert.ok(seat !== undefined, `seat ${String(view.toAct)} is not in the view`);
  return { userId: seat.playerId, sequence: view.actionSequence };
}

/** The next seat that will be asked to act after the current one. */
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

/** How far the hand has moved, as the two numbers that must not double-count. */
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

    // Both quote the sequence they can both see right now, and both are submitted before either is
    // awaited. Whichever the queue runs second is acting on a view that no longer exists.
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

    // The retry a dropped response produces, arriving while the original is still in the queue.
    // Identical actionId, identical everything.
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

    // One legal action first, purely so the sequence is above zero. Without it, "one behind" is
    // `max(0, 0 - 1) === 0`, which is the CURRENT sequence and therefore legal — the first draft of
    // this test asserted that submission would be rejected and was simply wrong about the arithmetic.
    const opener = toAct(table);
    await table.submitAction(opener.userId, {
      action: { type: 'call' },
      actionId: 'act-opener01',
      expectedSequence: opener.sequence,
    });

    const actor = toAct(table);
    assert.ok(actor.sequence >= 1, 'the opening action must have advanced the sequence');

    // Stale in both directions, submitted together: a client that has run ahead is as wrong as one
    // that has fallen behind, and both must be refused rather than applied to a different situation
    // than the player saw.
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

    // And the table is still usable afterwards. `enqueue` deliberately swallows the rejection on
    // the chain while rethrowing it to the caller; without that split, one refused action would
    // wedge the table for good, which is a far worse failure than the error itself.
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

    // Eight simultaneous submissions, all quoting the same sequence, all with distinct ids: the
    // shape a client with a stuck retry loop produces. Exactly one can be legal.
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

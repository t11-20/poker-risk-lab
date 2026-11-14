/**
 * A learner alone with bots gets `learnerTurnSeconds` or the room's clock, whichever is longer,
 * because a 60 s clock folds hands while the learner reads the Coach panel. Every other seat keeps
 * the room's clock (`LiveTable.turnSecondsFor`). Some tests fail if that reverts to the room clock,
 * and the rest are guarantees the longer clock must not trade away. The acting seat is always read
 * from the table, never assumed.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSecureRandom } from '@prl/poker-engine';
import { DEFAULT_LEARNER_TURN_SECONDS, loadConfig } from '../src/config.ts';
import { LiveTable } from '../src/rooms/table.ts';
import { createManualClock, type ManualClock } from '../src/rooms/timers.ts';

const ROOM_SECONDS = 60;

interface Fixture {
  readonly table: LiveTable;
  readonly clock: ManualClock;
  readonly problems: string[];
}

/** The bot lets the turn move on. A second person turns the floor off. */
async function tableWithHand(options: {
  readonly withSecondPerson: boolean;
  readonly roomSeconds?: number;
  readonly learnerTurnSeconds?: number;
}): Promise<Fixture> {
  const problems: string[] = [];
  const clock = createManualClock();
  let handCount = 0;
  const table = new LiveTable({
    roomId: 'room_y3',
    config: {
      smallBlind: 5,
      bigBlind: 10,
      ante: 0,
      maxSeats: 3,
      actionTimeoutSeconds: options.roomSeconds ?? ROOM_SECONDS,
    },
    clock,
    random: createSecureRandom(),
    nextHandId: () => {
      handCount += 1;
      return `hand_y3${handCount}`;
    },
    ...(options.learnerTurnSeconds === undefined ? {} : { learnerTurnSeconds: options.learnerTurnSeconds }),
    onProblem: (message, detail) => problems.push(`${message} ${JSON.stringify(detail ?? {})}`),
  });
  await table.sit({ userId: 'usr_learner', displayName: 'Lee', seat: 0, stack: 1_000 });
  await table.sit({
    userId: 'usr_bot',
    displayName: 'Bot',
    seat: 1,
    stack: 1_000,
    isBot: true,
    botProfile: 'tight',
  });
  if (options.withSecondPerson) {
    await table.sit({ userId: 'usr_person', displayName: 'Ari', seat: 2, stack: 1_000 });
  }
  await table.startHand();
  return { table, clock, problems };
}

/**
 * `ManualClock.advance` runs the callback synchronously, but it only enqueues the timeout, so the
 * fold lands a turn of the loop later.
 */
function settle(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

function actorId(table: LiveTable): string {
  const view = table.viewFor('usr_learner');
  assert.ok(view !== null, 'no hand in progress');
  assert.ok(view.toAct !== null, 'nobody is being asked to act');
  const seat = view.seats.find((entry) => entry.seat === view.toAct);
  assert.ok(seat !== undefined, 'the acting seat is not in the view');
  return seat.playerId;
}

function secondsOnTheClock(fixture: Fixture): number {
  const deadline = fixture.table.snapshot().deadlineMs;
  assert.ok(deadline !== null, 'no deadline is armed');
  return (deadline - fixture.clock.now()) / 1_000;
}

async function passTheTurnTo(fixture: Fixture, userId: string): Promise<void> {
  for (let step = 0; step < 4; step++) {
    const acting = actorId(fixture.table);
    if (acting === userId) return;
    const view = fixture.table.viewFor(acting);
    assert.ok(view !== null);
    await fixture.table.submitAction(acting, {
      action: { type: 'call' },
      actionId: `act_y3_${step}`,
      expectedSequence: view.actionSequence,
    });
  }
  assert.fail(`the action never reached ${userId}`);
}

test('a learner alone with bots gets four minutes on a room configured for one', async () => {
  const fixture = await tableWithHand({ withSecondPerson: false });
  await passTheTurnTo(fixture, 'usr_learner');

  assert.equal(
    secondsOnTheClock(fixture),
    DEFAULT_LEARNER_TURN_SECONDS,
    'a learner must have longer than the room clock to read the Coach panel',
  );
  assert.ok(
    DEFAULT_LEARNER_TURN_SECONDS > ROOM_SECONDS,
    'the default has to actually raise the audited 60-second clock, or this proves nothing',
  );
});

test('the learner is not folded at the old sixty seconds', async () => {
  const fixture = await tableWithHand({ withSecondPerson: false });
  await passTheTurnTo(fixture, 'usr_learner');
  const before = fixture.table.viewFor('usr_learner');
  assert.ok(before !== null);

  fixture.clock.advance((ROOM_SECONDS + 1) * 1_000);
  await settle();

  const after = fixture.table.viewFor('usr_learner');
  assert.ok(after !== null, 'the hand is still live');
  assert.equal(after.actionSequence, before.actionSequence, 'nothing was applied — no automatic fold');
  assert.equal(actorId(fixture.table), 'usr_learner', 'and the learner is still the seat being waited on');
  assert.deepEqual(fixture.problems, [], 'no timer problem was reported');
});

test('an abandoned seat is still folded — the mechanism is longer, not gone', async () => {
  // A clock that never expires lets one absent player stall a table for ever.
  const fixture = await tableWithHand({ withSecondPerson: false });
  await passTheTurnTo(fixture, 'usr_learner');
  const before = fixture.table.viewFor('usr_learner');
  assert.ok(before !== null);

  fixture.clock.advance(DEFAULT_LEARNER_TURN_SECONDS * 1_000 + 1);
  await settle();

  const view = fixture.table.viewFor('usr_learner');
  assert.ok(view !== null);
  assert.notEqual(view.actionSequence, before.actionSequence, 'the timeout still applies an action');

  // Fold or check is `timeoutAction`'s choice. This test owns that the seat was acted for and lost no chip.
  const learnerSeat = view.seats.find((seat) => seat.playerId === 'usr_learner')?.seat;
  assert.ok(learnerSeat !== undefined, 'the learner is in the hand');
  const automatic = view.actions.filter((action) => action.seat === learnerSeat && action.wasAutomatic);
  assert.equal(automatic.length, 1, 'the timeout applied exactly one automatic action for that seat');
  assert.equal(automatic[0]?.amountPaid, 0, 'and a timeout must never spend a chip');
  assert.ok(
    automatic[0]?.action.type === 'fold' || automatic[0]?.action.type === 'check',
    'a timeout folds or checks; it never calls',
  );
});

test('a bot keeps the room clock — the extra time is for reading, and a bot reads nothing', async () => {
  // For a bot the timer is a safety net, and four minutes is four minutes of frozen table.
  const fixture = await tableWithHand({ withSecondPerson: false });
  await passTheTurnTo(fixture, 'usr_bot');

  assert.equal(secondsOnTheClock(fixture), ROOM_SECONDS, 'a bot seat is not given the learner floor');
});

test('a second person at the table restores the room clock for everybody', async () => {
  // With another human present the room's `action_timeout_seconds` is the agreed pace.
  const fixture = await tableWithHand({ withSecondPerson: true });
  await passTheTurnTo(fixture, 'usr_learner');

  assert.equal(secondsOnTheClock(fixture), ROOM_SECONDS);
});

test('a room configured longer than the floor keeps its own clock', async () => {
  const fixture = await tableWithHand({ withSecondPerson: false, roomSeconds: 300 });
  await passTheTurnTo(fixture, 'usr_learner');

  assert.equal(secondsOnTheClock(fixture), 300);
});

test('the floor is configurable, and LEARNER_TURN_SECONDS is what configures it', async () => {
  const fixture = await tableWithHand({ withSecondPerson: false, learnerTurnSeconds: 120 });
  await passTheTurnTo(fixture, 'usr_learner');
  assert.equal(secondsOnTheClock(fixture), 120);

  const base = {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://poker:poker-dev-only@127.0.0.1:5432/prl_fix_y3',
    SESSION_COOKIE_SECRET: 'y3-turn-clock-test-secret-value-long-enough',
    WEB_ORIGINS: 'http://localhost:3000',
  };
  assert.equal(loadConfig(base).learnerTurnSeconds, DEFAULT_LEARNER_TURN_SECONDS);
  assert.equal(loadConfig({ ...base, LEARNER_TURN_SECONDS: '90' }).learnerTurnSeconds, 90);

  // Out of bounds is reported, not clamped, like every other read in `config.ts`.
  assert.throws(() => loadConfig({ ...base, LEARNER_TURN_SECONDS: '4' }), /LEARNER_TURN_SECONDS/);
  assert.throws(() => loadConfig({ ...base, LEARNER_TURN_SECONDS: '901' }), /LEARNER_TURN_SECONDS/);
});

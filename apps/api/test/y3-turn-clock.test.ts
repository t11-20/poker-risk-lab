/**
 * The turn clock a learner alone at a table of bots gets, against the one everybody else gets.
 *
 * ## The defect
 *
 * A browser-level verification pass lost two hands to `prl.hand_actions` rows reading
 * `seat 0 | fold | was_automatic = t`, both times while the learner was reading the Coach
 * panel. The room's `action_timeout_seconds` was 60. Nothing was hidden — the countdown is
 * on screen and folding rather than calling on expiry is the correct rule — but the panel a
 * learner is *meant to read at that moment* runs to thousands of characters plus a five-row
 * EV table and a card-by-card table with one row per unseen card. The product's two headline
 * features were in direct tension: you could read the analysis or you could act, not both.
 *
 * `LiveTable.turnSecondsFor` now takes the longer of the room's clock and
 * `learnerTurnSeconds` for a person with no other person waiting on them, and leaves every
 * other seat on the room's clock. That method sets out the three conditions and why each one
 * is there; `DEFAULT_LEARNER_TURN_SECONDS` in `src/config.ts` carries the number.
 *
 * ## Would these fail if the behaviour broke? Yes — checked, by reverting
 *
 * With `turnSecondsFor` reduced to `return this.config.actionTimeoutSeconds`, three of the
 * seven tests below fail: the deadline lands 60 seconds out rather than 240, the automatic
 * fold arrives at 61 seconds, and the per-table override is not honoured because there is no
 * floor left to configure. The other four pass either way, on purpose, and each is a
 * guarantee the fix must not trade away rather than a test of the fix — the bot clock, the
 * clock at a table with a second person in it, the abandoned seat that still gets folded, and
 * the room that already allows longer than the floor (`Math.max(300, 240)` is 300 whichever
 * side of the change you are on).
 *
 * ## Nothing here is assumed about the seating
 *
 * Who acts first is the engine's business (the button posts the small blind and acts first
 * heads-up, and the button is seeded from the first player to sit). Every test reads the
 * acting seat out of the table rather than asserting a seat index, so a change in the
 * rotation shows up as a different clock, not as a mysteriously failing helper.
 *
 * ## No database
 *
 * A `LiveTable` is constructed directly, as `table-concurrency.test.ts` does. The clock is
 * the manual one from `src/rooms/timers.ts`, so a four-minute timeout runs in microseconds
 * and nothing here depends on wall time.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSecureRandom } from '@prl/poker-engine';
import { DEFAULT_LEARNER_TURN_SECONDS, loadConfig } from '../src/config.ts';
import { LiveTable } from '../src/rooms/table.ts';
import { createManualClock, type ManualClock } from '../src/rooms/timers.ts';

/** The clock the audited room was running: one minute to read the panel and act. */
const ROOM_SECONDS = 60;

interface Fixture {
  readonly table: LiveTable;
  readonly clock: ManualClock;
  readonly problems: string[];
}

/**
 * A hand in progress: the learner in seat 0, a bot in seat 1, and optionally a second person
 * in seat 2.
 *
 * The bot is always there because the audited table is a learner against bots, and because a
 * seat that is not the learner's has to be able to act for the turn to move on. The second
 * person is the switch that turns the floor off.
 */
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
 * Lets the table's queue drain.
 *
 * `ManualClock.advance` runs the due callback synchronously, but the callback only *enqueues*
 * the timeout (`this.enqueue(() => this.applyTimeout(expiry))`, deliberately — see the queue
 * banner in `table.ts`), so the fold lands a turn of the loop later. Without this, a test
 * asserting straight after `advance` reads the state as it was before the timer did anything
 * and passes for the wrong reason.
 */
function settle(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/** The user id of the seat currently being asked to act. Read from the table, never assumed. */
function actorId(table: LiveTable): string {
  const view = table.viewFor('usr_learner');
  assert.ok(view !== null, 'no hand in progress');
  assert.ok(view.toAct !== null, 'nobody is being asked to act');
  const seat = view.seats.find((entry) => entry.seat === view.toAct);
  assert.ok(seat !== undefined, 'the acting seat is not in the view');
  return seat.playerId;
}

/** Seconds between now and the armed deadline. */
function secondsOnTheClock(fixture: Fixture): number {
  const deadline = fixture.table.snapshot().deadlineMs;
  assert.ok(deadline !== null, 'no deadline is armed');
  return (deadline - fixture.clock.now()) / 1_000;
}

/** Moves the action round to `userId`, calling for everyone asked before them. */
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

  // One second past the clock that folded two hands during verification.
  fixture.clock.advance((ROOM_SECONDS + 1) * 1_000);
  await settle();

  const after = fixture.table.viewFor('usr_learner');
  assert.ok(after !== null, 'the hand is still live');
  assert.equal(after.actionSequence, before.actionSequence, 'nothing was applied — no automatic fold');
  assert.equal(actorId(fixture.table), 'usr_learner', 'and the learner is still the seat being waited on');
  assert.deepEqual(fixture.problems, [], 'no timer problem was reported');
});

test('an abandoned seat is still folded — the mechanism is longer, not gone', async () => {
  // The half of this that must not regress. A clock that never expires lets one absent
  // player stall a table forever, which is a worse failure than the one being fixed.
  const fixture = await tableWithHand({ withSecondPerson: false });
  await passTheTurnTo(fixture, 'usr_learner');
  const before = fixture.table.viewFor('usr_learner');
  assert.ok(before !== null);

  fixture.clock.advance(DEFAULT_LEARNER_TURN_SECONDS * 1_000 + 1);
  await settle();

  const view = fixture.table.viewFor('usr_learner');
  assert.ok(view !== null);
  assert.notEqual(view.actionSequence, before.actionSequence, 'the timeout still applies an action');

  // Which action it is, is `timeoutAction`'s business and not this test's: it checks where that
  // is free and folds where it is not, and asserting one of the two here would be asserting
  // which seat the deal happened to put the learner in. What this test owns is that the seat
  // was acted for automatically, and that being acted for never costs a chip.
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
  // A control. "Give every seat four minutes" would pass the three tests above and would be a
  // different change: for a bot the timer is a safety net against a policy that threw, and four
  // minutes is four minutes of frozen table before the net catches anything.
  const fixture = await tableWithHand({ withSecondPerson: false });
  await passTheTurnTo(fixture, 'usr_bot');

  assert.equal(secondsOnTheClock(fixture), ROOM_SECONDS, 'a bot seat is not given the learner floor');
});

test('a second person at the table restores the room clock for everybody', async () => {
  // The other control, and the clause that keeps the extra time free. Against bots a long clock
  // costs nobody anything. With another human in the room it costs them their evening, and the
  // room's `action_timeout_seconds` is the pace they all agreed to — that room can configure up
  // to 300 seconds for itself if it wants them.
  const fixture = await tableWithHand({ withSecondPerson: true });
  await passTheTurnTo(fixture, 'usr_learner');

  assert.equal(secondsOnTheClock(fixture), ROOM_SECONDS);
});

test('a room configured longer than the floor keeps its own clock', async () => {
  // `Math.max`, not a replacement. A room that deliberately allows five minutes is not
  // shortened to four by a floor whose whole job is to lengthen short clocks.
  const fixture = await tableWithHand({ withSecondPerson: false, roomSeconds: 300 });
  await passTheTurnTo(fixture, 'usr_learner');

  assert.equal(secondsOnTheClock(fixture), 300);
});

test('the floor is configurable, and LEARNER_TURN_SECONDS is what configures it', async () => {
  // Per table, for a deployment that wires it through.
  const fixture = await tableWithHand({ withSecondPerson: false, learnerTurnSeconds: 120 });
  await passTheTurnTo(fixture, 'usr_learner');
  assert.equal(secondsOnTheClock(fixture), 120);

  // And in the environment, where an operator sets it. `loadConfig` is pure, so this needs no
  // process environment and no server.
  const base = {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://poker:poker-dev-only@127.0.0.1:5432/prl_fix_y3',
    SESSION_COOKIE_SECRET: 'y3-turn-clock-test-secret-value-long-enough',
    WEB_ORIGINS: 'http://localhost:3000',
  };
  assert.equal(loadConfig(base).learnerTurnSeconds, DEFAULT_LEARNER_TURN_SECONDS);
  assert.equal(loadConfig({ ...base, LEARNER_TURN_SECONDS: '90' }).learnerTurnSeconds, 90);

  // Out of bounds is reported rather than silently clamped, like every other read in `config.ts`.
  assert.throws(() => loadConfig({ ...base, LEARNER_TURN_SECONDS: '4' }), /LEARNER_TURN_SECONDS/);
  assert.throws(() => loadConfig({ ...base, LEARNER_TURN_SECONDS: '901' }), /LEARNER_TURN_SECONDS/);
});

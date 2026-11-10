import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { type HandState, legalActions } from '@prl/poker-engine';
import { NEW_SESSION, type Session, STALE, type StepResult, step } from '../src/step.ts';
import { READER_SEAT, STARTING_STACK } from '../src/table.ts';
import { cardText, decodePress } from '../src/view.ts';
import {
  actionButtonsOf,
  buttonsOf,
  find,
  legalSummary,
  message,
  passiveChoice,
  press,
  testDeps,
} from './helpers.ts';

function start(deps: ReturnType<typeof testDeps>): StepResult {
  const menu = step(NEW_SESSION, { kind: 'command', name: 'start', args: '' }, deps);
  return press(menu.session, find(buttonsOf(menu), /^Play a hand$/), deps);
}

function stateOf(session: Session): HandState {
  if (session.phase.kind !== 'deciding' && session.phase.kind !== 'over') throw new Error('no hand');
  return session.phase.state;
}

/** Plays the hand on screen to the end, checking the buttons against the engine at every decision. */
function playOut(first: StepResult, deps: ReturnType<typeof testDeps>, pick: number): StepResult[] {
  const results = [first];
  let current = first;
  while (current.session.phase.kind === 'deciding') {
    const state = current.session.phase.state;
    const legal = legalActions(state, READER_SEAT);
    const offered = actionButtonsOf(current).map((button) => decodePress(button.data));
    for (const pressed of offered) {
      assert.ok(pressed?.kind === 'act', 'every action button decodes to an action');
      const match = legal.find((entry) => entry.type === pressed.action.type);
      assert.ok(match, `${pressed.action.type} offered outside ${legalSummary(legal)}`);
      if (pressed.action.type === 'bet' || pressed.action.type === 'raise') {
        const to = pressed.action.to;
        assert.ok(
          to >= (match.minTo ?? 0) && to <= (match.maxTo ?? 0),
          `size ${to} outside ${legalSummary(legal)}`,
        );
      }
    }
    const offeredTypes = new Set(offered.map((entry) => (entry?.kind === 'act' ? entry.action.type : '')));
    assert.deepEqual([...offeredTypes].sort(), [...new Set(legal.map((entry) => entry.type))].sort());
    for (const [index, hidden] of state.seats.entries()) {
      if (index === READER_SEAT || hidden.holeCards === null || hidden.seat === READER_SEAT) continue;
      for (const card of hidden.holeCards) {
        assert.ok(
          !message(current).text.includes(cardText(card)),
          `seat ${hidden.seat}'s ${cardText(card)} leaked`,
        );
      }
    }
    current = press(current.session, passiveChoice(actionButtonsOf(current), pick + results.length), deps);
    results.push(current);
  }
  return results;
}

describe('a hand through step', () => {
  test('hands reach a result, buttons are the engine legal set, and one reaches showdown', () => {
    const deps = testDeps(7);
    let current = start(deps);
    let showdowns = 0;
    let decisions = 0;
    let resets = 0;
    for (let hand = 1; hand <= 12; hand += 1) {
      const played = playOut(current, deps, hand);
      decisions += played.length - 1;
      const end = played[played.length - 1] as StepResult;
      assert.equal(end.session.phase.kind, 'over', `hand ${hand} ended`);
      const result = stateOf(end.session).result;
      assert.ok(result !== null, `hand ${hand} has a result`);
      if (result.showdowns.length > 0) {
        showdowns += 1;
        assert.match(message(end).text, /Shown at showdown:/);
      }
      assert.match(message(end).text, /Your result this hand: [+-]?\d/);
      const reset = buttonsOf(end).find((button) => button.label === 'Reset units');
      if (reset === undefined) {
        current = press(end.session, find(buttonsOf(end), /^Deal the next hand$/), deps);
        continue;
      }
      // Calling everything down goes broke; units are free, and reset is one press.
      resets += 1;
      assert.equal(stateOf(end.session).seats.find((seat) => seat.seat === READER_SEAT)?.stack, 0);
      const fresh = press(end.session, reset, deps);
      assert.match(message(fresh).text, /Every seat is back to 1,000 units/);
      current = press(fresh.session, find(buttonsOf(fresh), /^Play a hand$/), deps);
      const reader = stateOf(current.session).seats.find((seat) => seat.seat === READER_SEAT);
      if (current.session.phase.kind === 'deciding') {
        assert.equal((reader?.stack ?? 0) + (reader?.committedTotal ?? 0), STARTING_STACK, 'reset to 1,000');
      }
    }
    assert.ok(decisions > 12, `the reader decided ${decisions} times`);
    assert.ok(showdowns > 0, 'at least one of twelve scripted hands reached showdown');
    assert.ok(resets > 0, 'the scripted run went broke at least once, so the reset path was played');
  });

  test('stacks carry over into the next hand', () => {
    const deps = testDeps(11);
    const played = playOut(start(deps), deps, 1);
    const end = played[played.length - 1] as StepResult;
    const after = stateOf(end.session).seats.map((seat) => seat.stack);
    assert.notDeepEqual(
      after,
      after.map(() => STARTING_STACK),
      'units moved during the hand',
    );
    const next = press(end.session, find(buttonsOf(end), /^Deal the next hand$/), deps);
    const dealt = stateOf(next.session);
    for (const seat of dealt.seats) {
      const posted = dealt.forcedBets
        .filter((bet) => bet.seat === seat.seat)
        .reduce((sum, bet) => sum + bet.amount, 0);
      const actedFor = dealt.actions
        .filter((entry) => entry.seat === seat.seat)
        .reduce((sum, a) => sum + a.amountPaid, 0);
      assert.equal(
        seat.stack + posted + actedFor,
        after[seat.seat],
        `seat ${seat.seat} starts where it ended`,
      );
    }
  });
});

describe('stale and repeated presses', () => {
  test('a double press applies once; the second is a toast and changes nothing', () => {
    const deps = testDeps(3);
    const first = start(deps);
    const button = passiveChoice(actionButtonsOf(first), 1);
    const once = press(first.session, button, deps);
    assert.ok(once.session.revision > first.session.revision, 'the first press changed the session');
    const twice = press(once.session, button, deps);
    assert.equal(twice.session, once.session, 'the second press returned the session untouched');
    assert.deepEqual(twice.out, [{ kind: 'toast', text: STALE }]);
  });

  test('Why? and Deal the next hand from an earlier moment are refused', () => {
    const deps = testDeps(5);
    const first = start(deps);
    const why = find(buttonsOf(first), /^Why\?$/);
    const played = playOut(first, deps, 2);
    const end = played[played.length - 1] as StepResult;
    assert.deepEqual(press(end.session, why, deps).out, [{ kind: 'toast', text: STALE }]);

    const deal = find(buttonsOf(end), /^Deal the next hand$/);
    const next = press(end.session, deal, deps);
    assert.equal(next.session.phase.kind === 'idle' ? null : stateOf(next.session).handNumber, 2);
    const again = press(next.session, deal, deps);
    assert.equal(again.session, next.session, 'a second Deal does not deal a third hand');
    assert.deepEqual(again.out, [{ kind: 'toast', text: STALE }]);
  });

  test('data this process did not write is refused without touching the session', () => {
    const deps = testDeps(9);
    const first = start(deps);
    const state = stateOf(first.session);
    const forged = `a:${state.handId}:${state.actionSequence}:r1`;
    const refused = step(first.session, { kind: 'button', data: forged }, deps);
    assert.equal(refused.session, first.session);
    assert.deepEqual(refused.out, [{ kind: 'toast', text: 'That action is not available here.' }]);
    for (const data of ['', 'x', 'a:nope:1:f', `a:${state.handId}:${state.actionSequence}:q`]) {
      const garbage = step(first.session, { kind: 'button', data }, deps);
      assert.equal(garbage.session, first.session, `"${data}" changed nothing`);
      assert.equal(garbage.out[0]?.kind, 'toast');
    }
  });

  test('Play a hand mid-hand re-posts the live table instead of dealing another', () => {
    const deps = testDeps(13);
    const first = start(deps);
    const again = step(first.session, { kind: 'button', data: 'p' }, deps);
    assert.equal(again.session, first.session);
    assert.equal(message(again).kind, 'send');
    assert.deepEqual(
      message(again).buttons,
      message(first).buttons,
      'the same live buttons, on a new message',
    );
  });
});

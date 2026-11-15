import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Action, HandState } from '@prl/poker-engine';
import { type Deps, NEW_SESSION, type Session, STALE, type StepResult, step } from '../src/step.ts';
import { READER_SEAT } from '../src/table.ts';
import { actionButtonsOf, buttonsOf, find, message, press, testDeps } from './helpers.ts';

/** Seed 1 opens on raise [20, 1,000], and a call leads to bet [10, 990] in the same hand. */
function asked(): { deps: Deps; table: StepResult; ask: StepResult } {
  const deps = testDeps(1);
  const menu = step(NEW_SESSION, { kind: 'command', name: 'start', args: '' }, deps);
  const table = press(menu.session, find(buttonsOf(menu), /^Play a hand$/), deps);
  const ask = press(table.session, find(buttonsOf(table), /^Other size…$/), deps);
  return { deps, table, ask };
}

function typed(session: Session, text: string, deps: Deps): StepResult {
  return step(session, { kind: 'text', text }, deps);
}

function stateOf(session: Session): HandState {
  if (session.phase.kind !== 'deciding' && session.phase.kind !== 'over') throw new Error('no hand');
  return session.phase.state;
}

function readerMoves(session: Session): Action[] {
  return stateOf(session)
    .actions.filter((logged) => logged.seat === READER_SEAT)
    .map((logged) => logged.action);
}

describe('a size typed after Other size…', () => {
  test('a whole number in range is played as that raise, exactly as a pressed one', () => {
    const { deps, table, ask } = asked();
    assert.match(message(ask).text, /Allowed range 20 to 1,000 units/);
    const played = typed(ask.session, '150', deps);
    assert.ok(
      played.out.every((out) => out.kind === 'send'),
      'a typed answer has no message to edit',
    );
    assert.deepEqual(readerMoves(played.session)[0], { type: 'raise', to: 150 });

    const same = asked();
    const state = stateOf(table.session);
    const pressed = step(
      same.table.session,
      { kind: 'button', data: `a:${state.handId}:${state.actionSequence}:r150` },
      same.deps,
    );
    assert.deepEqual(stateOf(played.session), stateOf(pressed.session));
  });

  test('out of range, a fraction, another unit or words are refused with the range, and nothing is sent', () => {
    const { deps, ask } = asked();
    const cases: [string, RegExp][] = [
      ['1001', /^1,001 is above the most you can put in/],
      ['19', /^19 is below the minimum/],
      ['150.5', /^Units are whole/],
      ['100bb', /^That is not a whole number of units/],
      ['30%', /^That is not a whole number of units/],
      ['a lot', /^That is not a whole number of units/],
    ];
    for (const [text, says] of cases) {
      const refused = typed(ask.session, text, deps);
      assert.equal(refused.session, ask.session, `"${text}" changed nothing`);
      assert.equal(message(refused).kind, 'send');
      assert.match(message(refused).text, says);
      assert.match(message(refused).text, /Allowed range 20 to 1,000 units/, `"${text}" states the range`);
    }
  });

  test('the most you can put in says it is all in', () => {
    const { deps, ask } = asked();
    assert.match(message(ask).text, /1,000 is all in/);
    const played = typed(ask.session, '1,000', deps);
    assert.deepEqual(played.out[0], { kind: 'send', text: 'You raise to 1,000, all in.', buttons: [] });
    assert.deepEqual(readerMoves(played.session)[0], { type: 'raise', to: 1000 });
  });

  test('a size typed after the hand moved on is refused as stale', () => {
    const { deps, table, ask } = asked();
    const moved = press(ask.session, find(actionButtonsOf(table), /^Call/), deps);
    const before = stateOf(moved.session);
    // 50 is a legal bet at the new decision, so only staleness can refuse it.
    const late = typed(moved.session, '50', deps);
    assert.deepEqual(late.out, [
      {
        kind: 'send',
        text: 'That size is from an earlier moment in the hand, so nothing was sent.',
        buttons: [],
      },
    ]);
    assert.equal(stateOf(late.session), before);
    assert.deepEqual(press(moved.session, find(buttonsOf(table), /^Other size…$/), deps).out, [
      { kind: 'toast', text: STALE },
    ]);
    assert.match(message(typed(late.session, '50', deps)).text, /^Use the buttons/);

    const again = press(late.session, find(buttonsOf(moved), /^Other size…$/), deps);
    assert.match(message(again).text, /^Bet how much\? .*Allowed range 10 to 990 units/);
    assert.deepEqual(typed(again.session, '50', deps).out[0], {
      kind: 'send',
      text: 'You bet 50.',
      buttons: [],
    });
  });

  test('words typed after the hand moved on get the usual reply, and end the stale prompt', () => {
    const { deps, table, ask } = asked();
    const moved = press(ask.session, find(actionButtonsOf(table), /^Call/), deps);
    const hello = typed(moved.session, 'hi', deps);
    assert.match(message(hello).text, /^Use the buttons/, 'chat that is not a size is not answered as one');
    assert.equal(hello.session.sizing, null);
    assert.match(message(typed(hello.session, '50', deps)).text, /^Use the buttons/);
  });
});

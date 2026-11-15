/**
 * A Lab call that takes hero's whole stack is flagged `allInAtMax`, which is what makes the ActionBar
 * print and speak "Call all in". The expectation comes from each scenario's own `toCall` and stack.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { content } from '@prl/content';
import { scenarioToPlayerView } from '../src/lib/scenario-view.ts';

function callFor(scenarioId: string) {
  const scenario = content().scenarios.find((entry) => entry.id === scenarioId);
  assert.ok(scenario !== undefined, `no scenario ${scenarioId}`);
  const call = scenarioToPlayerView(scenario)?.legalActions.find((action) => action.type === 'call');
  assert.ok(call !== undefined, `${scenarioId} offers no call`);
  return call;
}

describe('a Lab call says when it is all in', () => {
  it('flags a call of the whole stack behind, and no other, in every scenario (REGRESSION)', () => {
    const wrong: string[] = [];
    let allIn = 0;
    let covered = 0;
    for (const scenario of content().scenarios) {
      const hero = scenario.seats.find((seat) => seat.isHero === true);
      const call = scenarioToPlayerView(scenario)?.legalActions.find((action) => action.type === 'call');
      if (hero === undefined || call === undefined) continue;
      const expected = scenario.toCall === hero.stack;
      if (expected) allIn += 1;
      else covered += 1;
      if ((call.allInAtMax ?? false) !== expected) {
        wrong.push(
          `${scenario.id}: calls ${scenario.toCall} with ${hero.stack} behind, flag ${call.allInAtMax}`,
        );
      }
    }
    assert.ok(allIn >= 3, `only ${allIn} all-in call(s); a sweep of nothing is not a pass`);
    assert.ok(covered >= 10, `only ${covered} covered call(s); a sweep of nothing is not a pass`);
    assert.deepEqual(wrong, [], wrong.join('\n'));
  });

  for (const id of [
    'rk-an-all-in-that-is-nearly-even',
    'rk-nine-big-blinds-call-or-fold',
    'rk-when-survival-outweighs-chip-ev',
  ]) {
    it(`${id} calls all in, with the sentence the ActionBar prints beside it`, () => {
      const call = callFor(id);
      assert.equal(call.allInAtMax, true);
      assert.equal(call.note, 'Calling puts your whole remaining stack in.');
    });
  }

  // Both face an all-in that hero covers, so "an opponent shoved" must not read as hero being all in.
  for (const id of ['eq-rule-of-four-big-draw-flop', 'eq-set-on-connected-flop-jam']) {
    it(`${id} is an ordinary call: hero covers the shove`, () => {
      assert.notEqual(callFor(id).allInAtMax, true);
    });
  }
});

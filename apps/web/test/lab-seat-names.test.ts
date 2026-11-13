/**
 * A Lab seat's name says something its position badge does not. Every bundled scenario labels its
 * seats by position, so passing the label through printed "BTN / BTN" on every plate. The reader's
 * plate says "You", as on the live table and the offline fixture.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { scenarios } from '@prl/content';
import { scenarioSeatName, scenarioToPlayerView } from '../src/lib/scenario-view.ts';

describe('Lab seat names', () => {
  const all = scenarios();

  it('reads every bundled scenario', () => {
    assert.ok(
      all.length >= 36,
      `only ${String(all.length)} scenario(s) were read; a sweep of nothing passes`,
    );
  });

  it('never repeats the position as the name', () => {
    const repeats: string[] = [];
    for (const scenario of all) {
      const table = scenarioToPlayerView(scenario);
      assert.ok(table !== null, `${scenario.id} did not stage`);
      for (const seat of scenario.seats) {
        const position = table.view.seats.find((view) => view.seat === seat.seat)?.position ?? null;
        if (position !== null && scenarioSeatName(seat) === position)
          repeats.push(`${scenario.id}#${seat.seat}`);
      }
    }
    assert.deepEqual(repeats, [], 'a plate printed its position twice');
  });

  it('names the reader and the opponents by role', () => {
    for (const scenario of all) {
      for (const seat of scenario.seats) {
        assert.equal(scenarioSeatName(seat), seat.isHero === true ? 'You' : 'Opponent', `${scenario.id}`);
      }
    }
  });

  it('keeps a label that is not a position', () => {
    assert.equal(
      scenarioSeatName({ seat: 3, label: 'The pre-flop raiser', stack: 1000 }),
      'The pre-flop raiser',
    );
  });
});

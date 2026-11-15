/**
 * A seat a scenario marks as folded is drawn as the live table draws one, because `Seat` takes its
 * words, card row and surface from `status`. Drawn as active, three folded players read as callers.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { scenarios } from '@prl/content';
import { scenarioToPlayerView } from '../src/lib/scenario-view.ts';

describe('Lab folded seats', () => {
  const all = scenarios();

  it('gives every seat the status its scenario states', () => {
    let foldedSeen = 0;
    const wrong: string[] = [];
    for (const scenario of all) {
      const table = scenarioToPlayerView(scenario);
      assert.ok(table !== null, `${scenario.id} did not stage`);
      for (const seat of scenario.seats) {
        const expected = seat.folded === true ? 'folded' : 'active';
        if (expected === 'folded') foldedSeen += 1;
        const drawn = table.view.seats.find((view) => view.seat === seat.seat)?.status;
        if (drawn !== expected) wrong.push(`${scenario.id}#${seat.seat} ${seat.label}: ${drawn}`);
      }
    }
    assert.ok(
      foldedSeen >= 18,
      `only ${String(foldedSeen)} folded seat(s) were read; a sweep of nothing passes`,
    );
    assert.deepEqual(wrong, [], 'a seat was drawn with a status its scenario does not state');
  });

  it('draws UTG, HJ and CO folded when the button opens', () => {
    const scenario = all.find((entry) => entry.id === 'fl-same-cards-on-the-button');
    assert.ok(scenario !== undefined);
    const table = scenarioToPlayerView(scenario);
    const folded = table?.view.seats.filter((seat) => seat.status === 'folded').map((seat) => seat.position);
    assert.deepEqual(folded, ['UTG', 'HJ', 'CO']);
  });
});

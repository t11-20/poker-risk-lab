/**
 * The home page's hand is computed, not written down.
 *
 * The product's first claim about itself is that nothing is looked up. The hand on the home page is
 * the first figure a visitor sees, so a literal "45.6%" in the markup would make the first number on
 * the site the exact thing the site says it does not contain. These pin the figures to the maths
 * and keep percentages out of the source that renders them.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { exactEquity, exactRange, potOdds } from '@prl/poker-math';
import { homeSpot } from '../src/lib/home-spot.ts';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

describe('the home page hand', () => {
  const spot = homeSpot();

  it('prices the call from the pot and the bet', () => {
    assert.equal(spot.need, potOdds(spot.pot, spot.toCall).breakEvenEquity);
    assert.equal(spot.need, spot.toCall / (spot.pot + spot.toCall));
  });

  it('takes its equity from an exact enumeration of the runouts still to come', () => {
    const result = exactEquity({
      players: [
        { label: 'you', range: exactRange(spot.yours) },
        { label: 'them', range: exactRange(spot.theirs) },
      ],
      board: spot.board,
    });
    assert.equal(result.method, 'exact-enumeration');
    assert.equal(spot.have, result.players[0]?.equity);
    // A flop leaves 45 unseen cards for the turn and river: C(45, 2) runouts.
    assert.equal(spot.runouts, (45 * 44) / 2);
  });

  it('writes no percentage into the markup that shows it', () => {
    for (const file of [join('components', 'HomeSpot.tsx'), join('app', 'page.tsx')]) {
      const source = readFileSync(join(SRC, file), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gmu, '');
      assert.doesNotMatch(source, /\d+(?:\.\d+)?\s*%/u, `${file} carries a literal percentage`);
    }
  });
});

/**
 * The home page's hand is computed, not written down. The product's first claim is that nothing is
 * looked up, so no literal percentage may sit in the markup that shows the first figure.
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

  it('states the assumption its conclusion rests on (PR #40 review)', () => {
    // Equity is computed to the river with no more betting, so the conclusion must carry that condition.
    const source = readFileSync(join(SRC, 'components', 'HomeSpot.tsx'), 'utf8');
    assert.match(source, /If nobody bets again before the river/u);
  });
});

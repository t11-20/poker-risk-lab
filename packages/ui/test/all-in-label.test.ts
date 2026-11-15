/**
 * The primary button's words at every size the sizer can reach. A render without a DOM sits at the
 * minimum, so the All in preset on a stack deeper than the minimum is only reachable here.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sizedButtonText } from '../src/bet-sizing.ts';

const bounds = { min: 200, max: 924 };

describe('sizedButtonText', () => {
  it('names a raise of the whole stack as all in, on the face and in the spoken name (REGRESSION)', () => {
    assert.deepEqual(sizedButtonText('raise', 924, bounds, 0), {
      label: 'Raise to 924, all in',
      cost: '924 units',
      spoken: 'raise to 924 units, which is all in: 924 units out of your stack',
    });
  });

  it('names a bet of the whole stack the same way, counting only what leaves the stack', () => {
    assert.deepEqual(sizedButtonText('bet', 924, bounds, 24), {
      label: 'Bet to 924, all in',
      cost: '900 units',
      spoken: 'bet to 924 units, which is all in: 900 units out of your stack',
    });
  });

  it('NEGATIVE CONTROL: one unit short of the stack is a plain raise', () => {
    assert.deepEqual(sizedButtonText('raise', 923, bounds, 0), {
      label: 'Raise to 923',
      cost: '923 units',
      spoken: 'raise to 923 units, 923 units out of your stack',
    });
  });
});

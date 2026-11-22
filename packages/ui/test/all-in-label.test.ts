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
      label: 'Raise to 924',
      cost: 'All in',
      spoken: 'raise to 924 units, all in',
    });
  });

  it('names a bet of the whole stack the same way', () => {
    assert.deepEqual(sizedButtonText('bet', 924, bounds, 0), {
      label: 'Bet 924',
      cost: 'All in',
      spoken: 'bet 924 units, all in',
    });
  });

  it('speaks what leaves the stack for an all-in raise with chips already in (REGRESSION)', () => {
    assert.deepEqual(sizedButtonText('raise', 924, bounds, 24), {
      label: 'Raise to 924',
      cost: 'All in',
      spoken: 'raise to 924 units, all in, 900 more',
    });
  });

  it('NEGATIVE CONTROL: one unit short of the stack is a plain raise, with no second line', () => {
    assert.deepEqual(sizedButtonText('raise', 923, bounds, 0), {
      label: 'Raise to 923',
      cost: '',
      spoken: 'raise to 923 units',
    });
  });

  it('says what leaves the stack only when it differs from the total', () => {
    assert.deepEqual(sizedButtonText('raise', 300, bounds, 50), {
      label: 'Raise to 300',
      cost: '250 more',
      spoken: 'raise to 300 units, 250 more',
    });
  });
});

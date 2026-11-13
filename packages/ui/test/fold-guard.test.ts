/**
 * The guard on Fold beside a free Check, as a pure decision.
 * `ActionBar` cannot be clicked under `node:test` (no DOM, ADR 0008), so the decision lives in
 * `src/fold-guard.ts`, and `action-bar-render.test.ts` checks the component passes it `event.detail`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { foldPress, spotSignature } from '../src/fold-guard.ts';
import type { LegalAction } from '../src/view-types.ts';

const CHECK_IS_FREE: readonly LegalAction[] = [
  { type: 'fold' },
  { type: 'check' },
  { type: 'bet', minTo: 10, maxTo: 840 },
];

describe('foldPress', () => {
  it('asks once when a pointer presses Fold and checking is free (REGRESSION)', () => {
    assert.equal(foldPress({ canCheck: true, pointer: true, armed: false }), 'arm');
  });

  it('folds on the second pointer press in the same spot', () => {
    assert.equal(foldPress({ canCheck: true, pointer: true, armed: true }), 'fold');
  });

  it('folds at once from the keyboard, whose label already said checking is free', () => {
    // Harnesses in scripts/ press by key or `.click()` (`detail === 0`), so this keeps them deterministic.
    assert.equal(foldPress({ canCheck: true, pointer: false, armed: false }), 'fold');
  });

  it('folds at once when folding saves something, whatever pressed it', () => {
    assert.equal(foldPress({ canCheck: false, pointer: true, armed: false }), 'fold');
    assert.equal(foldPress({ canCheck: false, pointer: false, armed: false }), 'fold');
  });
});

describe('spotSignature', () => {
  it('is the same for a whole-state frame that redraws the same spot', () => {
    // A fresh array with the same contents, which is what every `state` frame delivers.
    const again = CHECK_IS_FREE.map((action) => ({ ...action }));
    assert.equal(spotSignature(CHECK_IS_FREE, 0, 120, 0), spotSignature(again, 0, 120, 0));
  });

  it('changes when anything the row is drawn from changes', () => {
    const base = spotSignature(CHECK_IS_FREE, 0, 120, 0);
    assert.notEqual(spotSignature(CHECK_IS_FREE, 0, 160, 0), base, 'the pot');
    assert.notEqual(spotSignature(CHECK_IS_FREE, 20, 120, 0), base, 'the price');
    assert.notEqual(spotSignature(CHECK_IS_FREE, 0, 120, 10), base, 'this street’s commitment');
    const widerBet: readonly LegalAction[] = [
      { type: 'fold' },
      { type: 'check' },
      { type: 'bet', minTo: 10, maxTo: 700 },
    ];
    assert.notEqual(spotSignature(widerBet, 0, 120, 0), base, 'the bet bounds');
    const facing: readonly LegalAction[] = [{ type: 'fold' }, { type: 'call', minTo: 20 }];
    assert.notEqual(spotSignature(facing, 0, 120, 0), base, 'the actions on offer');
  });
});

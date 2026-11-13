/**
 * The browser's deck proof has to be bound to the hand beside it. `verifyDeckReveal` checks against the
 * root inside the payload, so `checkDeckProof` first compares the page's published root and context.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Card, DeckReveal } from '@prl/poker-engine';
import { commitToDeckOrder, revealPositions, SALT_BYTES, verifyDeckReveal } from '@prl/poker-engine';
import { checkDeckProof, outcomeOf } from '../src/lib/deck-proof.ts';

const CONTEXT = 'room-lab-01:42:hand-0042';
const PUBLIC_POSITIONS = [0, 1, 10, 11, 12];

/** Deterministic salts, so every run produces the same two roots. The salts are published in the reveal. */
function salts(seed: number): Uint8Array {
  const bytes = new Uint8Array(52 * SALT_BYTES);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 7 + seed * 31) % 251;
  return bytes;
}

const ORDER_A: readonly Card[] = Array.from({ length: 52 }, (_unused, index) => index as Card);
const ORDER_B: readonly Card[] = [...ORDER_A].reverse();

const DEAL_A = commitToDeckOrder(CONTEXT, ORDER_A, salts(1));
const DEAL_B = commitToDeckOrder(CONTEXT, ORDER_B, salts(2));

const REVEAL_A = revealPositions(DEAL_A.commitment, DEAL_A.secret, PUBLIC_POSITIONS);
const REVEAL_B = revealPositions(DEAL_B.commitment, DEAL_B.secret, PUBLIC_POSITIONS);

const asWire = (reveal: DeckReveal): unknown => JSON.parse(JSON.stringify(reveal)) as unknown;

describe('a proof that verifies against itself proves nothing about this hand', () => {
  it('is what `verifyDeckReveal` does when it is handed one argument', () => {
    assert.notEqual(DEAL_A.commitment.root, DEAL_B.commitment.root, 'two deck orders, two roots');
    assert.equal(DEAL_A.commitment.context, DEAL_B.commitment.context, 'the same hand context');

    const selfCheck = verifyDeckReveal(REVEAL_B);
    assert.equal(selfCheck.ok, true);
    assert.equal(
      selfCheck.verifiedIndices.length,
      PUBLIC_POSITIONS.length,
      'five positions check out — against deck B’s root, which is the one inside the payload',
    );
    // The page beside it would be showing deck A's root, which nothing in the call above looked at.
  });
});

describe('the browser refuses a reveal that is not bound to the hand on screen', () => {
  it('proves the hand it was given, when the roots agree', () => {
    const check = checkDeckProof(asWire(REVEAL_A), DEAL_A.commitment.root, CONTEXT);
    assert.equal(outcomeOf(check), 'proved');
    assert.equal(check.state === 'checked' ? check.result.verifiedIndices.length : 0, 5);
  });

  it('refuses a reveal whose root is a different hand’s, without hashing anything', () => {
    const check = checkDeckProof(asWire(REVEAL_B), DEAL_A.commitment.root, CONTEXT);
    assert.equal(
      outcomeOf(check),
      'other-hand',
      'this is the reproduction: the proofs are sound and `verifyDeckReveal` says ok, but they are ' +
        'proofs of deck B while the page is showing deck A’s root',
    );
    assert.notEqual(outcomeOf(check), 'proved', 'and it must not be reported as this hand’s proof holding');
    assert.match(
      check.state === 'not-this-hand' ? check.why : '',
      /root/u,
      'the reader is told WHICH binding failed; "it did not check out" would name the wrong fault',
    );
  });

  it('refuses a reveal bound to a different hand context', () => {
    const check = checkDeckProof(asWire(REVEAL_A), DEAL_A.commitment.root, 'room-lab-01:41:hand-0041');
    assert.equal(outcomeOf(check), 'other-hand');
    assert.match(check.state === 'not-this-hand' ? check.why : '', /context|hand/u);
  });

  it('refuses when the page has published no root to bind to', () => {
    // Checking against itself and reporting "proof holds" would be the same false claim in a quieter place.
    const check = checkDeckProof(asWire(REVEAL_A), '', CONTEXT);
    assert.equal(outcomeOf(check), 'other-hand');
  });

  it('keeps "for a different hand" and "did not check out" apart', () => {
    // A reader told "the proof failed" about an honestly dealt hand is pointed at the wrong problem.
    const corrupted = asWire(REVEAL_A) as { cards: { saltHex: string }[] };
    const firstCard = corrupted.cards[0];
    assert.ok(firstCard !== undefined);
    firstCard.saltHex = 'f'.repeat(64);
    const broken = checkDeckProof(corrupted, DEAL_A.commitment.root, CONTEXT);
    assert.equal(broken.state, 'checked', 'the binding holds, so the proofs are actually run');
    assert.equal(outcomeOf(broken), 'mismatch');

    const foreign = checkDeckProof(asWire(REVEAL_B), DEAL_A.commitment.root, CONTEXT);
    assert.notEqual(outcomeOf(foreign), outcomeOf(broken));
  });

  it('still calls a malformed payload unreadable rather than either of those', () => {
    // A payload that is not a reveal is not a failed proof.
    assert.equal(outcomeOf(checkDeckProof(null, DEAL_A.commitment.root, CONTEXT)), 'unreadable');
    assert.equal(outcomeOf(checkDeckProof({ cards: [] }, DEAL_A.commitment.root, CONTEXT)), 'unreadable');
  });

  it('calls an empty reveal for this hand nothing to prove, not a failure', () => {
    const folded = revealPositions(DEAL_A.commitment, DEAL_A.secret, []);
    assert.equal(
      outcomeOf(checkDeckProof(asWire(folded), DEAL_A.commitment.root, CONTEXT)),
      'nothing-to-prove',
    );
  });
});

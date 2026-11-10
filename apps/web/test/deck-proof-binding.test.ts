/**
 * The browser's deck proof has to be bound to the hand it is shown beside.
 *
 * ## The defect these exist for
 *
 * `CommitmentVerifier` called `verifyDeckReveal(parsed.reveal)`. That function takes ONE argument
 * and checks the proofs against `reveal.commitment.root` and `reveal.commitment.context` — values
 * carried inside the very payload being checked. The component's own `commitmentRoot` and
 * `commitmentContext` props, the ones printed under "Merkle root" and "Bound to", were used for
 * display and compared with nothing.
 *
 * So a reveal belonging to a different commitment verified perfectly against itself: the chip read
 * "proof holds", and the callout told the reader their browser had "walked the six sibling hashes
 * up the tree, and arrived at the root above" — where "the root above" was a value the browser had
 * never computed and never compared. The section closes with "You do not have to take its word for
 * the result, and you do not have to take ours", and the component's header exists to say that a
 * server which dealt dishonestly is exactly the server whose self-assessment cannot be trusted.
 * The only thing standing between the reader and that claim was `apps/api`'s own check in
 * `build-review.ts` — the server, again.
 *
 * ## Observed
 *
 * The first test below is the reproduction, and it passes both before and after the fix, because it
 * is a statement about the engine rather than about the client: two decks committed under the SAME
 * context produce different roots, and a reveal built from the second verifies `ok: true` with five
 * verified positions while the first root is what the page displays. That is the fact the client
 * has to defend against, and `verifyDeckReveal` alone cannot: it is not given the published root.
 *
 * The rest drive `checkDeckProof`, which is the client-side check as it now stands:
 *
 *  - **Before the fix:** there was no `checkDeckProof`; the component's pipeline was
 *    `readReveal` + `verifyDeckReveal(reveal)`, which on the payload below returns `ok: true` and
 *    reaches the `proved` outcome — the wrong hand's proof, presented as this hand's proof holding.
 *  - **After the fix:** the mismatched payload reaches `not-this-hand`/`other-hand`, is never
 *    hashed at all, and the wording says it is a proof of a different deal rather than a proof that
 *    failed. The matching payload still reaches `proved` with all five positions.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Card, DeckReveal } from '@prl/poker-engine';
import { commitToDeckOrder, revealPositions, SALT_BYTES, verifyDeckReveal } from '@prl/poker-engine';
import { checkDeckProof, outcomeOf } from '../src/lib/deck-proof.ts';

const CONTEXT = 'room-lab-01:42:hand-0042';
/** The positions a hand legitimately opens: two hole cards that showed, and a three-card flop. */
const PUBLIC_POSITIONS = [0, 1, 10, 11, 12];

/**
 * Deterministic salts. Not from the CSPRNG on purpose: this file has to produce the SAME two roots
 * on every run so a failure names a mismatch rather than a coincidence, and nothing here is a
 * secret — the salts are published in the reveal.
 */
function salts(seed: number): Uint8Array {
  const bytes = new Uint8Array(52 * SALT_BYTES);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 7 + seed * 31) % 251;
  return bytes;
}

const ORDER_A: readonly Card[] = Array.from({ length: 52 }, (_unused, index) => index as Card);
const ORDER_B: readonly Card[] = [...ORDER_A].reverse();

/** Deck order A, committed under `CONTEXT`. This is the hand the page is displaying. */
const DEAL_A = commitToDeckOrder(CONTEXT, ORDER_A, salts(1));
/** A different deck order under the same context: a different hand, and a different root. */
const DEAL_B = commitToDeckOrder(CONTEXT, ORDER_B, salts(2));

const REVEAL_A = revealPositions(DEAL_A.commitment, DEAL_A.secret, PUBLIC_POSITIONS);
const REVEAL_B = revealPositions(DEAL_B.commitment, DEAL_B.secret, PUBLIC_POSITIONS);

/** The reveal as it reaches the component: off the wire, typed `unknown`. */
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
    // And the page beside it would be showing deck A's root. Nothing in the call above looked at it.
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
    // A hand with no published commitment cannot be verified by anybody. Checking the proof against
    // itself and reporting "proof holds" would be the same false claim in a quieter place.
    const check = checkDeckProof(asWire(REVEAL_A), '', CONTEXT);
    assert.equal(outcomeOf(check), 'other-hand');
  });

  it('keeps "for a different hand" and "did not check out" apart', () => {
    // Two payloads, two faults, two outcomes. A reader who is told "the proof failed" about a hand
    // that was dealt honestly is being pointed at the wrong problem — and so is the operator they
    // report it to.
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
    // The parse boundary predates this fix and is kept: a payload that is not a reveal is not a
    // failed proof, and reporting it as one is the loudest possible signal for a parse error.
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

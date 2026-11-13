/**
 * The reader's own check of a published deal: parse the reveal, bind it to THIS hand, then verify.
 *
 * `verifyDeckReveal` checks proofs against the root and context inside the payload, so a reveal of a
 * different deal verifies against itself (`test/deck-proof-binding.test.ts`). The binding to the
 * page's published root and context is checked here, in the browser, because trusting the server's
 * own check is what this screen exists to avoid. A failed binding hashes nothing.
 * `other-hand` and `mismatch` stay distinct. The first proves nothing either way, and the second is
 * the one result that should never happen.
 * A module so `node --test` drives it against the real engine. This is the one deliberate use of
 * `@prl/poker-engine` in the browser, a pure function over data already published.
 */

import type { DeckReveal, RevealVerification } from '@prl/poker-engine';
import { verifyDeckReveal } from '@prl/poker-engine';

/** What the browser has to say about a reveal. `pending` until the check has actually run. */
export type DeckProofCheck =
  | { readonly state: 'pending' }
  /** Nothing in the payload to work on. A parse failure, never a verification failure. */
  | { readonly state: 'unreadable'; readonly why: string }
  /** A well-formed reveal of a DIFFERENT commitment. Not verified, because verifying it proves nothing. */
  | { readonly state: 'not-this-hand'; readonly why: string; readonly reveal: DeckReveal }
  | { readonly state: 'checked'; readonly result: RevealVerification; readonly reveal: DeckReveal };

/** The five outcomes, each with its own tone on screen. Two of them are errors, in different ways. */
export type DeckProofOutcome =
  | 'pending'
  | 'proved'
  | 'nothing-to-prove'
  | 'other-hand'
  | 'mismatch'
  | 'unreadable';

const HEX_32_BYTES = /^[0-9a-f]{64}$/;

/** Field by field, not a cast, so a malformed payload is a parse failure, never a verification failure. */
function readCommitment(
  value: unknown,
): { readonly commitment: DeckReveal['commitment'] } | { readonly why: string } {
  if (value === null || typeof value !== 'object') return { why: 'the reveal carries no commitment' };
  const algorithm: unknown = Reflect.get(value, 'algorithm');
  const version: unknown = Reflect.get(value, 'version');
  const root: unknown = Reflect.get(value, 'root');
  const context: unknown = Reflect.get(value, 'context');
  if (algorithm !== 'sha256') return { why: 'the reveal uses a hash this build cannot verify' };
  if (typeof version !== 'string' || version === '') return { why: 'the reveal has no scheme version' };
  if (typeof root !== 'string' || !HEX_32_BYTES.test(root)) {
    return { why: 'the published root is not a 32-byte hex hash' };
  }
  if (typeof context !== 'string' || context === '') return { why: 'the reveal has no hand context' };
  // `verifyDeckReveal` refuses an unknown `version`. Deciding the scheme is not this module's job.
  return {
    commitment: {
      algorithm: 'sha256',
      version: version as DeckReveal['commitment']['version'],
      root,
      context,
    },
  };
}

function readProof(
  value: unknown,
): { readonly card: DeckReveal['cards'][number] } | { readonly why: string } {
  if (value === null || typeof value !== 'object') return { why: 'one of the proofs is not an object' };
  const index: unknown = Reflect.get(value, 'index');
  const card: unknown = Reflect.get(value, 'card');
  const saltHex: unknown = Reflect.get(value, 'saltHex');
  const proof: unknown = Reflect.get(value, 'proof');
  if (typeof index !== 'number' || !Number.isInteger(index)) return { why: 'a proof has no position' };
  if (typeof card !== 'number' || !Number.isInteger(card)) return { why: 'a proof has no card' };
  if (typeof saltHex !== 'string') return { why: 'a proof has no salt' };
  if (!Array.isArray(proof)) return { why: 'a proof has no sibling hashes' };
  const hashes: string[] = [];
  for (const hash of proof) {
    if (typeof hash !== 'string') return { why: 'a sibling hash is not a string' };
    hashes.push(hash);
  }
  return { card: { index, card, saltHex, proof: hashes } };
}

export function readReveal(value: unknown): { readonly reveal: DeckReveal } | { readonly why: string } {
  if (value === null || value === undefined) {
    return { why: 'this hand has not published a reveal, so there is nothing for the browser to check' };
  }
  if (typeof value !== 'object') return { why: 'the reveal is not an object' };

  const commitment = readCommitment(Reflect.get(value, 'commitment'));
  if ('why' in commitment) return commitment;

  const rawCards: unknown = Reflect.get(value, 'cards');
  if (!Array.isArray(rawCards)) return { why: 'the reveal has no list of proved positions' };

  const cards: DeckReveal['cards'][number][] = [];
  for (const entry of rawCards) {
    const proof = readProof(entry);
    if ('why' in proof) return proof;
    cards.push(proof.card);
  }

  return {
    reveal: {
      commitment: commitment.commitment,
      cards,
      complete: Reflect.get(value, 'complete') === true,
    },
  };
}

/**
 * Which half of the binding failed, or null when it holds. A wrong root is a different deck. A wrong
 * context (`room:hand-number:hand-id`, hashed into every leaf) is a different hand or room.
 */
function bindingFailure(reveal: DeckReveal, publishedRoot: string, publishedContext: string): string | null {
  if (publishedRoot === '') {
    return (
      'this page has no published Merkle root for the hand, so there is nothing here for the proof ' +
      'to be checked against'
    );
  }
  const rootDiffers = reveal.commitment.root !== publishedRoot;
  const contextDiffers = reveal.commitment.context !== publishedContext;
  if (rootDiffers && contextDiffers) {
    return 'the reveal names a different Merkle root AND a different hand context from the ones published above';
  }
  if (rootDiffers) return 'the reveal names a different Merkle root from the one published for this hand';
  if (contextDiffers) return 'the reveal is bound to a different hand context from the one published above';
  return null;
}

/** Parse, bind, verify, in that order. The published root and context are the page's own. */
export function checkDeckProof(
  reveal: unknown,
  publishedRoot: string,
  publishedContext: string,
): DeckProofCheck {
  const parsed = readReveal(reveal);
  if ('why' in parsed) return { state: 'unreadable', why: parsed.why };
  const unbound = bindingFailure(parsed.reveal, publishedRoot, publishedContext);
  if (unbound !== null) return { state: 'not-this-hand', why: unbound, reveal: parsed.reveal };
  return { state: 'checked', result: verifyDeckReveal(parsed.reveal), reveal: parsed.reveal };
}

export function outcomeOf(check: DeckProofCheck): DeckProofOutcome {
  if (check.state === 'pending') return 'pending';
  if (check.state === 'unreadable') return 'unreadable';
  if (check.state === 'not-this-hand') return 'other-hand';
  if (!check.result.ok) return 'mismatch';
  return check.result.verifiedIndices.length === 0 ? 'nothing-to-prove' : 'proved';
}

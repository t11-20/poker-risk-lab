/**
 * The reader's own check of a published deal: parse the reveal, bind it to THIS hand, then verify.
 *
 * ============================================================================
 * WHY THE ROOT IS COMPARED BEFORE A SINGLE HASH IS COMPUTED
 * ============================================================================
 *
 * `verifyDeckReveal` takes one argument. It verifies each proof against `reveal.commitment.root`
 * and `reveal.commitment.context` — values carried *inside the payload being checked*. That is the
 * right shape for the engine, and it means the function can say only one thing: "these proofs are
 * internally consistent with the root they came with". It cannot say "these proofs are about the
 * hand you are looking at", because it is never told which hand that is.
 *
 * `CommitmentVerifier` used to call it with the reveal alone and present the answer as if it had.
 * The page displayed `commitmentRoot` under "Merkle root" and told the reader their browser had
 * "walked the six sibling hashes up the tree, and arrived at the root above" — while nothing had
 * ever compared the two. A reveal belonging to a different commitment verified perfectly against
 * itself, the chip read "proof holds", and the section closed with "You do not have to take its
 * word for the result, and you do not have to take ours."
 *
 * Reproduced against the real engine, in `test/deck-proof-binding.test.ts`: deck order A committed
 * under context C gives root R; a different order under the same context gives R′; a reveal built
 * from the second returns `ok: true` with five verified positions while the page shows R.
 *
 * The server does make this check — `apps/api/src/review/build-review.ts` refuses a reveal whose
 * root or context does not match the hand's. Leaning on it is precisely the dependency this whole
 * screen exists to remove: a server that dealt dishonestly is the server whose self-assessment
 * cannot be trusted, and "the server checked it" is not an answer a reader can verify.
 *
 * So the binding is checked here, first, against the values the page was given — and when it fails
 * nothing is hashed at all. There is no point: the proofs would check out, and reporting that would
 * be answering a question nobody asked.
 *
 * ## "For a different hand" is not "invalid", and the difference is the reader's next move
 *
 * Four distinct outcomes, four different things to do about them:
 *
 *  - `proved` / `nothing-to-prove` — this hand's deal is on the record. (An empty reveal is the
 *    CORRECT result for a hand nobody showed in; `CommitmentVerifier`'s header says why at length.)
 *  - `other-hand` — the payload is a proof of some other deal. The hashes may be perfectly sound.
 *    Nothing has been established about the hand on screen, and nothing has been disproved either.
 *  - `mismatch` — the payload IS this hand's, and its proofs do not reach this hand's root. That is
 *    the one result on the screen that should never happen.
 *  - `unreadable` — there is nothing in the payload to work on, so the browser made no claim.
 *
 * Collapsing the middle two would tell a reader that a hand dealt honestly failed its proof, or
 * that a mismatched deal was merely a mix-up. Both send the reader — and whoever they report it to
 * — at the wrong problem.
 *
 * ## Why this is a module and not part of the component
 *
 * Two reasons, and the second is the load-bearing one. It keeps `CommitmentVerifier.tsx` to
 * rendering; and `apps/web`'s tests run under `node --test`, which cannot load `.tsx`, so a check
 * that lives in the component is a check no test can drive against the real engine. This one is
 * driven with real commitments, real reveals and the real `verifyDeckReveal`.
 *
 * This module is the deliberate exception to the rule that `@prl/poker-engine` stays out of the
 * browser bundle (`packages/ui/src/view-types.ts`, `lib/hand-replay.ts`): client-side verification
 * is not achievable any other way. What crosses the boundary is a pure function over data the
 * server already published; nothing here can ask the engine for a card it was not given.
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

/**
 * Narrows the wire's `unknown` into a `DeckReveal`, field by field.
 *
 * Field by field rather than a cast, for the same reason `redactFor` builds a new object instead of
 * deleting fields: this value came off the network. A cast would let a malformed payload reach
 * `verifyDeckReveal`, which would then report a *verification* failure — the loudest possible
 * signal — for what is really a parse failure. Those two must not be confused, so anything that does
 * not fit the shape is refused here with its own explanation.
 */
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
  // `version` is pinned to a literal in `DeckCommitment`. `verifyDeckReveal` re-checks it and refuses
  // anything it does not know, which is where that check belongs — not here, where refusing an
  // unfamiliar version would be this module deciding what the scheme is.
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
 * Says which half of the binding failed, in the reader's terms, or null when it holds.
 *
 * Both halves matter and they fail for different reasons. A wrong ROOT is a proof of a different
 * deck — the same hand re-dealt would produce one. A wrong CONTEXT is a proof from a different hand
 * or a different room entirely: the context is `room:hand-number:hand-id`, and it is hashed into
 * every leaf, which is what stops a proof from one hand being replayed against another.
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

/**
 * The whole client-side check, in the order it has to happen: parse, bind, verify.
 *
 * `publishedRoot` and `publishedContext` are the hand's own, as the review payload published them
 * and as the page displays them. They are the only reason any of this means anything — see the
 * header.
 */
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

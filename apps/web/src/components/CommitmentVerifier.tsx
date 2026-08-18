'use client';

/**
 * The commitment verifier: re-runs the deck proof **in the reader's own browser**.
 *
 * ============================================================================
 * WHY THIS RUNS CLIENT-SIDE, AND WHY THAT IS THE ENTIRE POINT
 * ============================================================================
 *
 * The server already verified the reveal and sent its verdict in
 * `HandReviewResponse.verification`. Rendering that verdict alone would be worthless: a server that
 * dealt dishonestly is exactly the server whose self-assessment cannot be trusted. The value of a
 * commitment scheme is that **somebody other than the server can check it**, so this component runs
 * `verifyDeckReveal` from `@prl/poker-engine` — the same function the server ran, byte for byte —
 * against the published Merkle root, in the browser, and shows both answers side by side.
 *
 * If they ever disagree, the reader is looking at the most important thing this app could tell them.
 *
 * ## The one place the engine is allowed into the browser bundle
 *
 * `packages/ui/src/view-types.ts` explains at length why `@prl/ui` does not depend on
 * `@prl/poker-engine`: the engine's module graph contains the shuffler, the deck commitment and
 * `HandState`, and the browser has no business linking against the rules engine. That reasoning
 * still holds everywhere else — `src/lib/hand-replay.ts` runs on the server for exactly this reason
 * — and this file is the deliberate exception, because client-side verification is not achievable
 * any other way. What crosses the boundary is a pure function over data the server already
 * published; nothing here can ask the engine for a card it was not given.
 *
 * ### The `node:crypto` question, answered by measurement rather than assumption
 *
 * `verifyDeckReveal` hashes with `node:crypto`'s `createHash` and walks the proof with `Buffer`,
 * neither of which exists in a browser. Next 16's client bundler supplies both (`crypto` maps to its
 * bundled `crypto-browserify`, and `Buffer` is provided by a `ProvidePlugin`), so the import
 * resolves and the Merkle walk runs. This was checked in a real browser against the real
 * nine-position proof in `src/fixtures/review.ts`, not inferred from the bundler's source: the
 * empty-reveal case short-circuits before it hashes anything, so a fold-out hand would have "passed"
 * without ever exercising SHA-256.
 *
 * No dependency was added and no bundler alias was needed. If a future bundler change breaks the
 * resolution the build fails loudly at that import, which is the right failure — the alternative,
 * a hand-rolled SHA-256 in app code, would be a second hash implementation that could silently
 * disagree with the server's.
 *
 * ============================================================================
 * AN EMPTY REVEAL IS A RESULT, NOT A FAILURE
 * ============================================================================
 *
 * This is the part most likely to be got wrong, so it is worth stating plainly.
 *
 * A hand that ends with everybody folding has **nothing to prove**. No board card was dealt and
 * nobody showed, so no card legitimately became public, so the reveal contains zero positions and
 * `verifyDeckReveal` returns `ok: true` with an empty list. That is the correct outcome.
 *
 * Revealing more would mean publishing the hole cards of players who folded — and whether a folder
 * was bluffing or holding a monster is precisely the information the whole scheme exists to keep
 * sealed. A verifier that painted this red would be teaching the reader that the honest case looks
 * broken, and after a week of that they would stop reading the indicator at all. So the empty case
 * gets its own state, its own words, and the same calm treatment as a nine-position proof: it says
 * what was proved (nothing), why there was nothing (nobody showed), and why proving more would be
 * the bug rather than the fix.
 *
 * ## What the proof does and does not establish
 *
 * Stated on screen, not just here, because a verifier that overclaims is worse than none. It proves
 * each revealed card sat at that deck position and was fixed before the first action, so a server
 * could not reorder undealt cards mid-hand. It does **not** prove the deck was *chosen* fairly: the
 * server generates the deck and the salts, so a dishonest one could grind candidate decks before
 * committing. Ruling that out needs entropy the server cannot predict, and that is an accepted,
 * documented limitation rather than something this component may quietly imply away.
 */

import type { HandReviewResponse } from '@prl/contracts';
import type { DeckReveal, RevealVerification } from '@prl/poker-engine';
import { verifyDeckReveal } from '@prl/poker-engine';
import { Callout, Chip, PlayingCard, pluralise } from '@prl/ui';
import { type ReactElement, useEffect, useId, useState } from 'react';

/** 52 deck positions. Named so the "9 of 52" copy cannot drift from the engine's deck size. */
const DECK_POSITIONS = 52;

export interface CommitmentVerifierProps {
  readonly commitmentRoot: string;
  readonly commitmentContext: string;
  /** `HandReviewResponse.reveal`, which the contract types as `unknown`. */
  readonly reveal: unknown;
  /** The server's own verdict, shown beside the browser's so a disagreement is visible. */
  readonly serverVerification: HandReviewResponse['verification'];
  readonly className?: string;
}

/** What the browser has to say. `pending` until the effect has actually run client-side. */
type BrowserCheck =
  | { readonly state: 'pending' }
  | { readonly state: 'unreadable'; readonly why: string }
  | { readonly state: 'checked'; readonly result: RevealVerification; readonly reveal: DeckReveal };

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
  // unfamiliar version would be this component deciding what the scheme is.
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

function readReveal(value: unknown): { readonly reveal: DeckReveal } | { readonly why: string } {
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

/** The four outcomes, each with its own tone. Only one of them is an error. */
type Outcome = 'pending' | 'proved' | 'nothing-to-prove' | 'mismatch' | 'unreadable';

function outcomeOf(check: BrowserCheck): Outcome {
  if (check.state === 'pending') return 'pending';
  if (check.state === 'unreadable') return 'unreadable';
  if (!check.result.ok) return 'mismatch';
  return check.result.verifiedIndices.length === 0 ? 'nothing-to-prove' : 'proved';
}

export function CommitmentVerifier(props: CommitmentVerifierProps): ReactElement {
  const { commitmentRoot, commitmentContext, reveal, serverVerification, className } = props;
  const [check, setCheck] = useState<BrowserCheck>({ state: 'pending' });
  const headingId = useId();
  const rootId = useId();

  useEffect(() => {
    // In an effect, not a lazy `useState` initialiser: an initialiser also runs during the server
    // render, and then "checked in your browser" would be a claim the component could not support.
    // Running it here means the `checked` state is only ever reached client-side.
    const parsed = readReveal(reveal);
    if ('why' in parsed) {
      setCheck({ state: 'unreadable', why: parsed.why });
      return;
    }
    setCheck({ state: 'checked', result: verifyDeckReveal(parsed.reveal), reveal: parsed.reveal });
  }, [reveal]);

  const outcome = outcomeOf(check);
  const proved = check.state === 'checked' ? check.result.verifiedIndices.length : 0;

  return (
    <section
      className={['prl-verifier', className].filter((p) => p !== undefined).join(' ')}
      aria-labelledby={headingId}
    >
      <header className="prl-verifier__head">
        <span className="prl-eyebrow">Deal verification</span>
        <h2 className="prl-verifier__title" id={headingId}>
          Check the deal yourself
        </h2>
        <Chip tone={CHIP_TONE[outcome]} glyph={CHIP_GLYPH[outcome]}>
          {CHIP_LABEL[outcome]}
        </Chip>
      </header>

      <dl className="prl-verifier__facts">
        <dt className="prl-label">Merkle root</dt>
        <dd className="prl-mono prl-verifier__hash" id={rootId}>
          {commitmentRoot === '' ? 'not published' : commitmentRoot}
        </dd>
        <dt className="prl-label">Bound to</dt>
        <dd className="prl-mono prl-verifier__hash">{commitmentContext}</dd>
        <dt className="prl-label">Proved in your browser</dt>
        <dd className="prl-verifier__count">
          {check.state === 'pending'
            ? 'checking…'
            : `${proved} of ${DECK_POSITIONS} deck ${proved === 1 ? 'position' : 'positions'}`}
        </dd>
        <dt className="prl-label">The server said</dt>
        <dd className="prl-verifier__count">
          {`${serverVerification.ok ? 'verified' : 'not verified'}, ${pluralise(
            serverVerification.verifiedPositions,
            'position',
          )}`}
        </dd>
      </dl>

      {/* The reader's own result, stated before any caveat about it. */}
      {outcome === 'pending' ? (
        <p className="prl-verifier__status">
          <span className="prl-skeleton prl-skeleton--line prl-verifier__skeleton" aria-hidden="true" />
          <span className="prl-visually-hidden">Recomputing the deck proof in your browser.</span>
        </p>
      ) : null}

      {outcome === 'proved' ? (
        <Callout tone="insight" title={`${pluralise(proved, 'position')} proved against the published root`}>
          {`Your browser recomputed each leaf hash from the card, its salt and its deck position, walked the six sibling hashes up the tree, and arrived at the root above — ${pluralise(
            proved,
            'time',
          )}. That proves each of these cards sat at that exact position in the deck and was fixed before anybody acted. The other ${DECK_POSITIONS - proved} positions stay sealed, which is the point: they are the cards nobody was entitled to see.`}
        </Callout>
      ) : null}

      {/* An empty reveal is the CORRECT result for a hand nobody showed in. See the header. */}
      {outcome === 'nothing-to-prove' ? (
        <Callout tone="insight" title="Nothing became public in this hand, so there is nothing to prove">
          Every player folded, so no community card was dealt and no hand was shown. The reveal is empty
          because no card legitimately became public — and an empty reveal that checks out is the right answer
          here, not a missing proof. Publishing more would mean publishing the cards of players who folded,
          and whether somebody folded a bluff or a monster is exactly what the commitment exists to keep
          sealed. The root above was still fixed before the first action, so the deal for this hand is on the
          record even though none of it was opened.
        </Callout>
      ) : null}

      {outcome === 'mismatch' ? (
        <div className="prl-error" role="alert">
          <p className="prl-error__title">
            <span aria-hidden="true">! </span>
            Error — the proof did not check out
          </p>
          <p>
            {check.state === 'checked' && check.result.reason !== undefined
              ? check.result.reason
              : 'The recomputed hashes did not match the published root.'}
          </p>
          <p>
            This is the one result on this screen that should not happen. It means the cards the server
            published cannot be shown to have occupied the deck positions it claims for them. Nothing in this
            app can tell you why; the root and the context above are what an operator needs to investigate.
          </p>
        </div>
      ) : null}

      {outcome === 'unreadable' ? (
        <Callout tone="warning" title="There was no reveal for your browser to check">
          {check.state === 'unreadable' ? check.why : ''}
          {'. '}
          That is not the same as a failed proof, and it is not the same as an empty one: a failed proof means
          the published cards do not match the root, and an empty proof means nothing was ever opened. Here
          there is nothing in the payload to work on at all, so the browser made no claim either way.
        </Callout>
      ) : null}

      {check.state === 'checked' && check.reveal.cards.length > 0 ? (
        <div className="prl-verifier__cards">
          <p className="prl-label">The proved positions</p>
          <ol className="prl-verifier__card-list">
            {check.reveal.cards.map((entry) => (
              <li className="prl-verifier__card" key={entry.index}>
                <span className="prl-index" aria-hidden="true">
                  {formatPosition(entry.index)}
                </span>
                <PlayingCard card={entry.card} size="sm" />
                <span className="prl-visually-hidden">{`at deck position ${entry.index}`}</span>
              </li>
            ))}
          </ol>
          <p className="prl-note">
            The number above each card is its position in the deck, counted in the order the cards came off
            it: hole cards first, one at a time round the table, then the board.
          </p>
        </div>
      ) : null}

      <details className="prl-disclose">
        <summary className="prl-disclose__summary">What this proves, and what it does not</summary>
        <div className="prl-disclose__body">
          <p className="prl-note">
            <strong>It proves</strong> that each revealed card occupied the deck position claimed for it, and
            that the whole 52-card order was fixed before the first action. A server that reordered undealt
            cards mid-hand — to hit a draw, break a cooler, or protect a bot — could not produce a proof that
            reaches this root.
          </p>
          <p className="prl-note">
            <strong>It does not prove</strong> that the deck was <em>chosen</em> fairly. The server generates
            both the order and the salts, so a dishonest one could try many candidate decks and commit to a
            favourable one before dealing. Ruling that out needs randomness the server cannot predict — each
            player contributing a committed value of their own — which this build does not do. It is recorded
            as an accepted limitation rather than left for you to assume away.
          </p>
          <p className="prl-note">
            The check ran on this page, in your browser, using the same verification function the server used.
            You do not have to take its word for the result, and you do not have to take ours.
          </p>
        </div>
      </details>
    </section>
  );
}

/** Deck positions as `00`…`51`, so the column of indexes aligns. */
function formatPosition(index: number): string {
  return String(index).padStart(2, '0');
}

const CHIP_TONE: Readonly<Record<Outcome, 'neutral' | 'favourable' | 'adverse' | 'caution'>> = {
  pending: 'neutral',
  proved: 'favourable',
  'nothing-to-prove': 'favourable',
  mismatch: 'adverse',
  unreadable: 'caution',
};

/** A glyph as well as a tone, so the state never depends on hue. */
const CHIP_GLYPH: Readonly<Record<Outcome, string>> = {
  pending: '…',
  proved: '✓',
  'nothing-to-prove': '✓',
  mismatch: '!',
  unreadable: '?',
};

const CHIP_LABEL: Readonly<Record<Outcome, string>> = {
  pending: 'checking',
  proved: 'proof holds',
  'nothing-to-prove': 'nothing to prove',
  mismatch: 'proof failed',
  unreadable: 'no reveal',
};

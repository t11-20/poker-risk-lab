'use client';

/**
 * The commitment verifier: re-runs the deck proof in the reader's own browser.
 *
 * The server's verdict alone is worthless, because a dishonest server would vouch for itself. So
 * `lib/deck-proof.ts` runs the engine's `verifyDeckReveal` client-side and this shows both answers.
 * `checkDeckProof` first binds the reveal to the published root and context, because a payload's
 * proofs always verify against the root they carry (`test/deck-proof-binding.test.ts`).
 *
 * Through `lib/deck-proof.ts` this is the only engine code in the browser bundle. Next's bundler
 * supplies `crypto` and `Buffer`, checked in a real browser on a nine-position proof. A hand-rolled
 * SHA-256 could disagree with the server's.
 *
 * An empty reveal is a result, not a failure. A hand where everybody folded has nothing public to
 * prove, and revealing more would publish folded hole cards. The proof shows cards were fixed before
 * the first action. It does not show the deck was chosen fairly, and the screen says so.
 */

import type { HandReviewResponse } from '@prl/contracts';
import { Callout, Chip, PlayingCard, pluralise } from '@prl/ui';
import { type ReactElement, useEffect, useId, useState } from 'react';
import { checkDeckProof, type DeckProofCheck, type DeckProofOutcome, outcomeOf } from '../lib/deck-proof.ts';

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

/** The root and context props are what `checkDeckProof` binds the reveal to. */
export function CommitmentVerifier(props: CommitmentVerifierProps): ReactElement {
  const { commitmentRoot, commitmentContext, reveal, serverVerification, className } = props;
  const [check, setCheck] = useState<DeckProofCheck>({ state: 'pending' });
  const headingId = useId();
  const rootId = useId();

  useEffect(() => {
    // In an effect, not a `useState` initialiser, which also runs on the server and would make
    // "checked in your browser" untrue.
    setCheck(checkDeckProof(reveal, commitmentRoot, commitmentContext));
  }, [reveal, commitmentRoot, commitmentContext]);

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
          {/* "0 of 52" would read as a check that ran, so `other-hand` says nothing was checked. */}
          {check.state === 'pending' ? 'checking…' : null}
          {check.state === 'not-this-hand' ? 'not checked — this proof is for another hand' : null}
          {check.state === 'pending' || check.state === 'not-this-hand'
            ? null
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
          {/* The binding check is stated first, because it is what makes the rest true. */}
          {`Your browser first checked that the reveal names the same Merkle root and the same hand context as the ones published above, and refused to go any further unless they matched. Then it recomputed each leaf hash from the card, its salt and its deck position, walked the six sibling hashes up the tree, and arrived at that same root — ${pluralise(
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

      {/*
        A proof of a different deal, distinct from `mismatch` and `unreadable`. Nothing is established
        or disproved about this hand. `role="alert"` as for `mismatch`, because the page cannot answer
        the reader's question.
      */}
      {outcome === 'other-hand' ? (
        <div className="prl-error" role="alert">
          <p className="prl-error__title">
            <span aria-hidden="true">! </span>
            This proof is for a different hand
          </p>
          <p>{check.state === 'not-this-hand' ? `${check.why}.` : ''}</p>
          <p>
            Your browser stopped there and hashed nothing. A set of proofs carries its own root, so checking
            it against itself would have succeeded and told you nothing about this hand — which is exactly the
            mistake this page is here not to make.
          </p>
          <p>
            This is not a failed proof: the cards for whatever hand these proofs do belong to may sit exactly
            where they claim. It is not an empty reveal either. What it means is that nothing on this screen
            has been verified about the hand you are reading, in either direction. The root and the context
            above are what an operator needs to find out how a reveal for another hand came to be served with
            this one.
          </p>
        </div>
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
            The check ran on this page, in your browser, using the same verification function the server used
            — and against the root and context printed above, which is what makes it a check of <em>this</em>
            hand rather than of the payload against itself. You do not have to take its word for the result,
            and you do not have to take ours.
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

const CHIP_TONE: Readonly<Record<DeckProofOutcome, 'neutral' | 'favourable' | 'adverse' | 'caution'>> = {
  pending: 'neutral',
  proved: 'favourable',
  'nothing-to-prove': 'favourable',
  'other-hand': 'adverse',
  mismatch: 'adverse',
  unreadable: 'caution',
};

/** A glyph as well as a tone. `other-hand` and `mismatch` share a tone, so they must not share a glyph. */
const CHIP_GLYPH: Readonly<Record<DeckProofOutcome, string>> = {
  pending: '…',
  proved: '✓',
  'nothing-to-prove': '✓',
  'other-hand': '≠',
  mismatch: '!',
  unreadable: '?',
};

/** The label is the state. See `Chip`, where a chip never conveys its meaning by colour. */
const CHIP_LABEL: Readonly<Record<DeckProofOutcome, string>> = {
  pending: 'checking',
  proved: 'proof holds',
  'nothing-to-prove': 'nothing to prove',
  'other-hand': 'different hand',
  mismatch: 'proof failed',
  unreadable: 'no reveal',
};

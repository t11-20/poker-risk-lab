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
 * commitment scheme is that **somebody other than the server can check it**, so `lib/deck-proof.ts`
 * runs `verifyDeckReveal` from `@prl/poker-engine` — the same function the server ran, byte for
 * byte — against the published Merkle root, in the browser, and this component shows both answers
 * side by side.
 *
 * If they ever disagree, the reader is looking at the most important thing this app could tell them.
 *
 * ## "Against the published Merkle root" was once a claim this file did not keep
 *
 * It called `verifyDeckReveal(parsed.reveal)`. That function takes ONE argument and checks the
 * proofs against the root and context carried *inside the payload it is checking*, and this
 * component never compared either with the `commitmentRoot` / `commitmentContext` props it prints
 * above. So a reveal belonging to a different commitment verified perfectly against itself, the
 * chip read "proof holds", and the callout told the reader their browser had "arrived at the root
 * above" — a value it had never computed and never looked at. The only thing standing between the
 * reader and that sentence was the server's own check in `apps/api/src/review/build-review.ts`,
 * which is the exact dependency the paragraph above says this screen exists to remove.
 *
 * The binding is now checked first, in `checkDeckProof`, and a reveal that is not this hand's gets
 * its own outcome and its own words: `other-hand` says the proof is about a different deal, which
 * is not the same claim as `mismatch` ("this hand's proofs do not reach this hand's root"). See
 * that module's header, and `test/deck-proof-binding.test.ts`, which drives the reproduction
 * against real commitments.
 *
 * ## The one place the engine is allowed into the browser bundle
 *
 * `packages/ui/src/view-types.ts` explains at length why `@prl/ui` does not depend on
 * `@prl/poker-engine`: the engine's module graph contains the shuffler, the deck commitment and
 * `HandState`, and the browser has no business linking against the rules engine. That reasoning
 * still holds everywhere else — `src/lib/hand-replay.ts` runs on the server for exactly this reason
 * — and this component, through `lib/deck-proof.ts`, is the deliberate exception: client-side
 * verification is not achievable any other way. What crosses the boundary is a pure function over
 * data the server already published; nothing here can ask the engine for a card it was not given.
 *
 * ### The `node:crypto` question, answered by measurement rather than assumption
 *
 * (The engine import lives in `lib/deck-proof.ts` now; everything below is about the same import
 * and the same bundle, one module along.)
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

/**
 * The props say WHICH hand this is, and they are load-bearing rather than decorative.
 *
 * They are what `checkDeckProof` binds the reveal to. Printing them beside a result computed
 * without them is the defect described in the header.
 */
export function CommitmentVerifier(props: CommitmentVerifierProps): ReactElement {
  const { commitmentRoot, commitmentContext, reveal, serverVerification, className } = props;
  const [check, setCheck] = useState<DeckProofCheck>({ state: 'pending' });
  const headingId = useId();
  const rootId = useId();

  useEffect(() => {
    // In an effect, not a lazy `useState` initialiser: an initialiser also runs during the server
    // render, and then "checked in your browser" would be a claim the component could not support.
    // Running it here means the `checked` state is only ever reached client-side.
    //
    // The two published values go in with the payload. Without them this is a check of the reveal
    // against itself, which is what it used to be.
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
          {/*
            "0 of 52" would be a lie in the `other-hand` case: it reads as a check that ran and
            found nothing, when no hash was computed at all. The row says which of the two it is.
          */}
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
          {/*
            The first sentence is the one that used to be untrue. "Arrived at the root above" is only
            a claim worth making if the root above is the root the walk was checked against, and
            nothing compared them — see the header. The comparison is now stated, in order, because
            it is the step that makes the rest of the paragraph mean anything.
          */}
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
        A proof of a DIFFERENT deal. Deliberately not folded into `mismatch`, and deliberately not
        softened into `unreadable`: those two say "this hand's proofs do not reach this hand's root"
        and "there was nothing to check", and this says neither. The payload is well formed and its
        hashes may be perfectly sound — for some other hand. Nothing has been established about the
        hand on this page, and nothing has been disproved about it either, and the wording has to
        leave the reader with exactly that and not a shade more.

        `role="alert"` for the same reason `mismatch` has one: the reader is on this page to find
        out whether the deal is on the record, and the answer is that this page cannot tell them.
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

/**
 * A glyph as well as a tone, so the state never depends on hue.
 *
 * `other-hand` and `mismatch` share the adverse tone and must NOT share a glyph: they are the two
 * results that mean something is wrong, they mean different things, and a reader who distinguishes
 * chips by shape would otherwise see one state where there are two.
 */
const CHIP_GLYPH: Readonly<Record<DeckProofOutcome, string>> = {
  pending: '…',
  proved: '✓',
  'nothing-to-prove': '✓',
  'other-hand': '≠',
  mismatch: '!',
  unreadable: '?',
};

/** The label is the state. See `Chip`: a chip never conveys its meaning by colour. */
const CHIP_LABEL: Readonly<Record<DeckProofOutcome, string>> = {
  pending: 'checking',
  proved: 'proof holds',
  'nothing-to-prove': 'nothing to prove',
  'other-hand': 'different hand',
  mismatch: 'proof failed',
  unreadable: 'no reveal',
};

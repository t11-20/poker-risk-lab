/** The evidence behind the home page's figures (see `lib/checks.ts`), as a `<dl>` of claim and test. */

import type { Metadata } from 'next';
import type { ReactElement } from 'react';
import { PROOF } from '@/lib/checks.ts';
import '@/styles/page.css';
import '@/styles/checks.css';

export const metadata: Metadata = {
  title: 'How the numbers are checked',
  description:
    'The tests behind every figure in Poker Risk Lab: every seven-card hand enumerated, hand ordering ' +
    'checked against an independent evaluator, and every teaching claim re-checked on each build.',
};

export default function ChecksPage(): ReactElement {
  return (
    <div className="prl-container prl-checks-page">
      <header className="prl-page-head">
        <h1 className="prl-display-2 prl-page-head__title">How the numbers are checked</h1>
        <p className="prl-page-head__standfirst">
          An educational tool that teaches a wrong number is worse than no tool at all, so this is the part of
          the product with the most work in it. Each claim below names the test or document that backs it, and
          every test runs before a release.
        </p>
      </header>

      <dl className="prl-checks">
        {PROOF.map((entry) => (
          <div className="prl-checks__row" key={entry.claim}>
            <dt className="prl-checks__claim">{entry.claim}</dt>
            <dd className="prl-checks__detail">
              {entry.detail}
              <code className="prl-checks__command">{entry.check}</code>
            </dd>
          </div>
        ))}
      </dl>

      {/* Claims only that nothing is looked up. Read `SiteFooter.tsx`'s header on that scope first. */}
      <section aria-labelledby="checks-source" className="prl-checks__source">
        <h2 id="checks-source">Where the numbers come from</h2>
        <p className="prl-checks__prose">
          Every equity, out, price and expected value is computed from the actual deck at the moment you ask
          for it. Nothing is looked up: there is no odds table inside the calculation, so there is no lookup
          that can be quietly wrong. Each figure arrives with its method — exact enumeration or Monte Carlo
          with an interval — and with the assumptions it was computed under.
        </p>
        <p className="prl-checks__prose">
          There is one exception, and the page tells you about it rather than this paragraph. When the service
          that computes those figures cannot be reached, a screen falls back to a bundled copy of the same
          worked example so it is still readable, and says so at the top in a notice you cannot miss. A
          bundled figure ships with the app instead of being computed for you, so it can be stale — which is
          exactly why it is labelled where you are reading it and not only down here.
        </p>
      </section>
    </div>
  );
}

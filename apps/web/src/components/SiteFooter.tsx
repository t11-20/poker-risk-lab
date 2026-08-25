/**
 * The footer: the site map, the product statement, where the maths comes from, and the documents.
 *
 * ## The documents are here and not in the navigation, deliberately
 *
 * Terms of use, the data inventory and the responsible-use notes are real pages with real content,
 * and none of them is in `NAV_DESTINATIONS`. `/record` is the precedent: the five numbered
 * destinations are an argument about learning order, and an entry that is not a step in that
 * argument blunts it. A document is something a reader goes looking for rather than a place the
 * product sends them, and the foot of every page is where people look. The list itself is
 * `DOCUMENT_DESTINATIONS` in `lib/nav.ts`, so the footer and any other surface that needs it cannot
 * disagree about a route.
 *
 * Its landmark is labelled `Documents`. The site map above is `Sections`, the header's is `Primary`
 * and the mobile sheet's is `All sections` — four navigation landmarks with four names, because two
 * that share one is the `landmark-unique` failure and a rotor listing the same word twice tells a
 * reader nothing about which is which.
 *
 * ## What is deliberately NOT hidden down here
 *
 * The "this is not a gambling product" statement appears in the hero, at full size, because a
 * disclosure that only exists in a footer is a disclosure written to be missed. What is here is the
 * *detail* — units are free, resettable and valueless; there is nothing to buy and nothing to win —
 * which belongs somewhere permanent and reachable from every page, and this is that place.
 *
 * The wording is the footer's own rather than a reuse of `UNITS_EXPLANATION` from `@prl/ui`. That
 * constant describes a *control* ("what does this badge mean"), and it is exported from a
 * `'use client'` module, so importing it into a server component would hand this file a client
 * reference rather than a string. Two sentences with two jobs, each written where it is read.
 *
 * ## No social proof, by construction
 *
 * No testimonials, no logos, no "trusted by", no counters of other people's activity. There is
 * nothing to be sceptical about here: the only claims the product makes are the verifiable ones
 * (every seven-card hand enumerated, every scenario's claim re-checked), and those are stated on
 * the home page next to how they are checked.
 *
 * ## "Where the numbers come from" is scoped on purpose — do not tighten it back
 *
 * That block used to end with: "There is no stored odds table anywhere in this product, so there is
 * no table that can be quietly wrong." It read well and it was false. `src/fixtures/*.ts` ships
 * eighteen stored `ruleOfThumb` blocks and twenty-one stored `heroEquity` values — stored odds
 * tables by any reading — as the offline fallback every screen in this app is built to survive on,
 * and a release audit found four of them disagreeing with the live calculation. A product whose
 * footer disclaims the exact defect it has is worse off than one that says nothing.
 *
 * The claim now says what is actually true and is still worth saying: no figure is produced by a
 * LOOKUP, and where a bundled copy is shown instead the page itself says so. The fallback being
 * labelled on-page is what makes the second paragraph honest rather than a hedge, so if that
 * labelling is ever removed, this paragraph becomes false again and must change with it.
 *
 * A server component: no state, no effects, no JavaScript shipped for a list of links.
 */

import { formatIndex } from '@prl/ui';
import Link from 'next/link';
import type { ReactElement } from 'react';
import { DOCUMENT_DESTINATIONS, NAV_DESTINATIONS } from '@/lib/nav.ts';
import { RECORD_PATH } from '@/lib/record-data.ts';
import { SessionDuration } from './SessionDuration.tsx';
import { ThemeToggle } from './ThemeToggle.tsx';

/**
 * A fixed id, not `useId()`, because the footer renders exactly once per document and the
 * certification's G3 quotes the name it produces. A generated id would be just as correct and would
 * make the name impossible to grep for from the document that asserts it.
 */
const FOOTER_HEADING_ID = 'prl-footer-heading';

export function SiteFooter(): ReactElement {
  return (
    <footer aria-labelledby={FOOTER_HEADING_ID} className="prl-footer" role="contentinfo">
      <div className="prl-container prl-footer__inner">
        {/* The landmark needs a name in the accessibility tree and does not need a heading on
            screen — the content below announces itself. `h2` rather than `h3`, because a page's
            `h1` is its subject and this is a sibling section of it.

            `aria-labelledby` rather than proximity, and that is not a nicety. A heading INSIDE a
            landmark does not name it: measured in Chrome 151, this footer's computed name was the
            empty string for as long as the heading was merely nested here, so the landmark rotor
            offered an unlabelled "content information" while G3 of the screen-reader certification
            quoted a name it did not have. Caught by that assertion's automated check
            (`scripts/ax-assertions.mjs`, G3) the first time it was run.

            `role="contentinfo"` is written out even though `<footer>` already maps to it, because
            Biome's `useAriaPropsSupportedByRole` does not apply the implicit mapping and refuses
            `aria-labelledby` on a bare `<footer>`. Stating the role satisfies the rule without a
            suppression comment, and it changes nothing in the computed tree — the landmark was
            `contentinfo` either way. */}
        <h2 className="prl-visually-hidden" id={FOOTER_HEADING_ID}>
          About Poker Risk Lab
        </h2>

        <nav aria-label="Sections" className="prl-footer__map">
          <p className="prl-footer__heading prl-label">Sections</p>
          <ul className="prl-footer__list">
            {NAV_DESTINATIONS.map((destination, position) => (
              <li className="prl-footer__item" key={destination.href}>
                <Link className="prl-footer__link" href={destination.href}>
                  <span aria-hidden="true" className="prl-index">
                    {formatIndex(position + 1)}
                  </span>
                  <span className="prl-footer__link-label">{destination.label}</span>
                </Link>
                <span className="prl-footer__summary">{destination.summary}</span>
              </li>
            ))}
          </ul>
        </nav>

        <div className="prl-footer__statement">
          <p className="prl-footer__heading prl-label">What this is</p>
          <p className="prl-footer__prose">
            An educational tool for studying probability, expected value, risk and variance in No-Limit
            Hold’em. It is <strong>not a gambling product</strong>: there is no real money in it, nothing to
            buy, nothing to win and no way to cash anything out.
          </p>
          <p className="prl-footer__prose">
            Chips are <strong>units</strong> — free practice counters with no monetary value, which you can{' '}
            {/*
              A link, because for a long time this sentence was the whole of the feature: it stated a
              right on every page of the product and there was no control anywhere that exercised it.
              `POST /me/units/reset` had worked from the beginning. If this link is ever removed, the
              claim it points at has to go with it.
            */}
            <Link className="prl-footer__link" href={RECORD_PATH}>
              reset to the starting amount whenever you like
            </Link>
            . Nothing here is a recommendation, and no figure is presented as the one correct play.
          </p>
        </div>

        <div className="prl-footer__statement">
          <p className="prl-footer__heading prl-label">Where the numbers come from</p>
          <p className="prl-footer__prose">
            Every equity, out, price and expected value is computed from the actual deck at the moment you ask
            for it. Nothing is looked up: there is no odds table inside the calculation, so there is no lookup
            that can be quietly wrong. Each figure arrives with its method — exact enumeration or Monte Carlo
            with an interval — and with the assumptions it was computed under.
          </p>
          <p className="prl-footer__prose">
            There is one exception, and the page tells you about it rather than this paragraph. When the
            service that computes those figures cannot be reached, a screen falls back to a bundled copy of
            the same worked example so it is still readable, and says so at the top in a notice you cannot
            miss. A bundled figure ships with the app instead of being computed for you, so it can be stale —
            which is exactly why it is labelled where you are reading it and not only down here.
          </p>
        </div>

        {/*
          The documents. Not indexed: the `01…05` motif belongs to the numbered argument above, and
          numbering these would say they are the next steps in it.
        */}
        <nav aria-label="Documents" className="prl-footer__map">
          <p className="prl-footer__heading prl-label">Documents</p>
          <ul className="prl-footer__list">
            {DOCUMENT_DESTINATIONS.map((destination) => (
              <li className="prl-footer__item" key={destination.href}>
                <Link className="prl-footer__link" href={destination.href}>
                  <span className="prl-footer__link-label">{destination.label}</span>
                </Link>
                <span className="prl-footer__summary">{destination.summary}</span>
              </li>
            ))}
          </ul>
        </nav>

        {/*
          The sitting clock. A client island in an otherwise static footer, and the only reason it is
          here rather than on one screen is that "how long have I been here" has the same answer
          everywhere, so the control has to be everywhere too. It renders nothing until it has
          mounted and read `sessionStorage`, which the server cannot see.
        */}
        <SessionDuration />

        {/*
          The theme control's permanent home, and — above the navigation breakpoint — its only one.

          This comment used to say the control was also in the pill bar above 1280px. It is not:
          `SiteHeader.tsx` renders no `ThemeToggle` at any width. There are exactly two copies, this
          one and the one in `MobileNav`'s sheet, and the sheet is `display: none` above 860px — so
          for most readers this is the only theme control in the product, which is what makes "where
          do I change the theme" answerable without a caveat. Both render the same `ThemeToggle`:
          three real radios in a named group, subscribed to `<html data-theme>` rather than to local
          state, so the two copies cannot disagree about which theme is on.
        */}
        <div className="prl-footer__appearance">
          <p className="prl-footer__heading prl-label">Appearance</p>
          <ThemeToggle className="prl-footer__theme" />
        </div>
      </div>
    </footer>
  );
}

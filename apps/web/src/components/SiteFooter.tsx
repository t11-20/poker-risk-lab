/**
 * The footer: the site map, the product statement, and where the maths comes from.
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
import { NAV_DESTINATIONS } from '@/lib/nav.ts';
import { RECORD_PATH } from '@/lib/record-data.ts';
import { ThemeToggle } from './ThemeToggle.tsx';

export function SiteFooter(): ReactElement {
  return (
    <footer className="prl-footer">
      <div className="prl-container prl-footer__inner">
        {/* The landmark needs a name in the accessibility tree and does not need a heading on
            screen — the content below announces itself. `h2` rather than `h3`, because a page's
            `h1` is its subject and this is a sibling section of it. */}
        <h2 className="prl-visually-hidden">About Poker Risk Lab</h2>

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
          The theme control's permanent home.

          It is in the pill bar as well above 1280px, and in the navigation sheet below 860px, but
          only this copy is on every page at every width — which is what makes "where do I change
          the theme" answerable without a caveat. All three render the same `ThemeToggle`: three
          real radios in a named group, subscribed to `<html data-theme>` rather than to local
          state, so no two copies can ever disagree about which theme is on.
        */}
        <div className="prl-footer__appearance">
          <p className="prl-footer__heading prl-label">Appearance</p>
          <ThemeToggle className="prl-footer__theme" />
        </div>
      </div>
    </footer>
  );
}

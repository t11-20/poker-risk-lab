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
 * A server component: no state, no effects, no JavaScript shipped for a list of links.
 */

import { formatIndex } from '@prl/ui';
import Link from 'next/link';
import type { ReactElement } from 'react';
import { NAV_DESTINATIONS } from '@/lib/nav.ts';
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
            Chips are <strong>units</strong> — free practice counters with no monetary value, which you can
            reset to the starting amount whenever you like. Nothing here is a recommendation, and no figure is
            presented as the one correct play.
          </p>
        </div>

        <div className="prl-footer__statement">
          <p className="prl-footer__heading prl-label">Where the numbers come from</p>
          <p className="prl-footer__prose">
            Every equity, out, price and expected value is computed from the actual deck when you ask for it.
            There is no stored odds table anywhere in this product, so there is no table that can be quietly
            wrong. Each figure arrives with its method — exact enumeration or Monte Carlo with an interval —
            and with the assumptions it was computed under.
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

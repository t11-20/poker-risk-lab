/**
 * The footer. Documents live here, not in `NAV_DESTINATIONS`, whose five entries are a learning order.
 * Every navigation landmark needs a distinct name (`landmark-unique`).
 * Units copy is the footer's own because `UNITS_EXPLANATION` comes from a client module.
 * "Where the numbers come from" claims only that nothing is looked up (honesty-claims.test.ts).
 * That stays true only while the bundled fallback is labelled on the page that shows it.
 */

import Link from 'next/link';
import type { ReactElement } from 'react';
import { SuitMark } from '@/components/SuitMark.tsx';
import { CHECKS_PATH } from '@/lib/checks.ts';
import { DOCUMENT_DESTINATIONS, NAV_DESTINATIONS, RECORD_DESTINATION } from '@/lib/nav.ts';
import { RECORD_PATH } from '@/lib/record-data.ts';
import { SessionDuration } from './SessionDuration.tsx';

/** A fixed id, not `useId()`, so the name G3 of the screen-reader certification quotes is greppable. */
const FOOTER_HEADING_ID = 'prl-footer-heading';

export function SiteFooter(): ReactElement {
  return (
    <footer aria-labelledby={FOOTER_HEADING_ID} className="prl-footer" role="contentinfo">
      <div className="prl-container prl-footer__inner">
        {/* A nested heading does not name a landmark (Chrome 151), hence `aria-labelledby`. */}
        {/* The explicit role satisfies Biome's `useAriaPropsSupportedByRole` without a suppression. */}
        <h2 className="prl-visually-hidden" id={FOOTER_HEADING_ID}>
          About Poker Risk Lab
        </h2>

        <nav aria-label="Sections" className="prl-footer__map">
          <p className="prl-footer__heading prl-label">Sections</p>
          <ul className="prl-footer__list">
            {NAV_DESTINATIONS.map((destination) => (
              <li className="prl-footer__item" key={destination.href}>
                <Link className="prl-footer__link" href={destination.href}>
                  <SuitMark area={destination.area ?? null} />
                  <span className="prl-footer__link-label">{destination.label}</span>
                </Link>
              </li>
            ))}
            {/* After the five and unmarked: see `RECORD_DESTINATION`. */}
            <li className="prl-footer__item">
              <Link className="prl-footer__link" href={RECORD_DESTINATION.href}>
                <SuitMark area={null} />
                <span className="prl-footer__link-label">{RECORD_DESTINATION.label}</span>
              </Link>
            </li>
          </ul>
        </nav>

        <div className="prl-footer__statement">
          <p className="prl-footer__heading prl-label">What this is</p>
          <p className="prl-footer__prose">
            An educational No-Limit Hold’em lab — <strong>not a gambling product</strong>. No real money,
            purchases or cash-outs. Chips are free practice <strong>units</strong> you can{' '}
            {/* The claim needs this link. Plain, because `prl-footer__link` is an inline-flex box. */}
            <Link href={RECORD_PATH}>reset at any time</Link>.
          </p>
        </div>

        <div className="prl-footer__statement">
          <p className="prl-footer__heading prl-label">Where the numbers come from</p>
          <p className="prl-footer__prose">
            Figures are computed from the deck on request with their method and assumptions, never looked up.{' '}
            <Link href={CHECKS_PATH}>How the numbers are checked</Link> lists the tests and any bundled offline
            examples.
          </p>
        </div>

        {/* No suit marks, because suits belong to the five sections above. */}
        <nav aria-label="Documents" className="prl-footer__map">
          <p className="prl-footer__heading prl-label">Documents</p>
          <ul className="prl-footer__list">
            {DOCUMENT_DESTINATIONS.map((destination) => (
              <li className="prl-footer__item" key={destination.href}>
                <Link className="prl-footer__link" href={destination.href}>
                  <span className="prl-footer__link-label">{destination.label}</span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <SessionDuration />
      </div>
    </footer>
  );
}

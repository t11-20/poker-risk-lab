'use client';

/**
 * The floating pill bar: the wordmark, the destinations, the call to action, the units readout and
 * the narrow-viewport menu.
 *
 * `<nav aria-label="Primary">` wraps the pill and the `Play` call to action, so all five destinations
 * are in one landmark. The theme control lives in the footer and the sheet, because at 1280px the bar
 * needs 1067 of 1200px and the switch needs 217 more.
 *
 * The `/lab` count is fetched, never typed, and renders nothing when the request fails. The floating
 * state comes from an `IntersectionObserver` on a sentinel, never a `scroll` listener (design system
 * §5.4).
 *
 * The units badge is never hidden at any width (a product guardrail) and links to `/record`. It
 * tracks a `UnitsReadout`, so a failed session read shows no figure instead of the starting balance.
 * It re-reads the session after any accepted mutation, so it never disagrees with another screen.
 * The active link carries a heavier weight as well as a fill, for WCAG 1.4.1.
 */

import type { ScenarioListResponse } from '@prl/contracts';
import { UnitsBadge } from '@prl/ui';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactElement, useEffect, useRef, useState } from 'react';
import { SuitMark } from '@/components/SuitMark.tsx';
import { API_PATHS, apiGet, fetchSession, safeFetch, subscribeToAcceptedMutations } from '@/lib/api.ts';
import { isCurrentDestination, NAV_DESTINATIONS, RECORD_DESTINATION } from '@/lib/nav.ts';
import { MobileNav } from './MobileNav.tsx';
import { NavigationPending } from './NavigationPending.tsx';

/** The destination promoted out of the link list and into the accent pill. */
const CTA_HREF = '/play';

/** The destination that carries a count badge, and the only one that does. */
const COUNTED_HREF = '/lab';

const PILL_DESTINATIONS = NAV_DESTINATIONS.filter((destination) => destination.href !== CTA_HREF);

/** The fallback keeps the root layout rendering if `/play` is ever renamed in `NAV_DESTINATIONS`. */
const CTA_DESTINATION = NAV_DESTINATIONS.find((destination) => destination.href === CTA_HREF) ?? {
  href: CTA_HREF,
  label: 'Play',
  summary: '',
};

/** Shared by every mount of the header, so a remount never re-asks for a count already shown. */
let cachedScenarioCount: number | null = null;

/**
 * What the bar may say about the reader's units. `assumed` is the starting balance nothing has
 * confirmed (server render, or no session). `known` is the session user's figure. `unknown` means
 * the session read failed, and no figure is shown.
 */
type UnitsReadout =
  | { readonly state: 'assumed'; readonly units: number }
  | { readonly state: 'known'; readonly units: number }
  | { readonly state: 'unknown' };

/**
 * The pill with no figure, wearing `UnitsBadge`'s classes so the layout holds and the word `units`
 * stays. Two words, because a longer label wrapped the bar at 360px. No `i` disclosure, because
 * `SiteFooter` carries `UNITS_EXPLANATION` on every page.
 */
function UnitsUnknown(): ReactElement {
  return (
    <span className="prl-units prl-shell__units">
      <span className="prl-units__value">
        <span className="prl-units__word prl-label">units offline</span>
        <span className="prl-visually-hidden">
          Your practice units could not be fetched, so no figure is shown here. Nothing about your units has
          changed.
        </span>
      </span>
    </span>
  );
}

export interface SiteHeaderProps {
  /** The fixture's starting balance, shown before the API answers. */
  readonly fallbackUnits: number;
}

export function SiteHeader(props: SiteHeaderProps): ReactElement {
  const { fallbackUnits } = props;
  const pathname = usePathname();
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const [stuck, setStuck] = useState(false);
  const [units, setUnits] = useState<UnitsReadout>({ state: 'assumed', units: fallbackUnits });
  const [scenarioCount, setScenarioCount] = useState<number | null>(cachedScenarioCount);

  useEffect(() => {
    const node = sentinelRef.current;
    if (node === null) return;
    // No observer means the pills keep their resting edge, failing towards no state change.
    if (typeof IntersectionObserver !== 'function') return;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) setStuck(!entry.isIntersecting);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let mounted = true;

    const readSession = (): void => {
      void fetchSession({ signal: controller.signal }).then((result) => {
        // For the read already in flight at unmount.
        if (!mounted) return;
        if (!result.ok) {
          // The failure is the answer. Keeping the starting balance here stated a figure nobody
          // confirmed for as long as the API was down.
          setUnits({ state: 'unknown' });
          return;
        }
        const user = result.data.user;
        setUnits(
          user === null ? { state: 'assumed', units: fallbackUnits } : { state: 'known', units: user.units },
        );
      });
    };

    readSession();
    // Re-read after any accepted mutation instead of trusting the echo.
    const unsubscribe = subscribeToAcceptedMutations(readSession);
    return () => {
      mounted = false;
      unsubscribe();
      controller.abort();
    };
  }, [fallbackUnits]);

  useEffect(() => {
    if (cachedScenarioCount !== null) return;
    const controller = new AbortController();
    void safeFetch(() =>
      apiGet<ScenarioListResponse>(API_PATHS.scenarios(), { signal: controller.signal }),
    ).then((result) => {
      // Not answering is a fine answer, so the badge stays absent rather than inventing a number.
      if (!result.ok) return;
      cachedScenarioCount = result.data.scenarios.length;
      setScenarioCount(cachedScenarioCount);
    });
    return () => controller.abort();
  }, []);

  const ctaCurrent = isCurrentDestination(CTA_DESTINATION.href, pathname);

  return (
    <>
      <div className="prl-shell__sentinel-anchor">
        <div aria-hidden="true" className="prl-shell__sentinel" ref={sentinelRef} />
      </div>

      {/* Named, because routes render their own `<header>` blocks and two unnamed banners are ambiguous. */}
      {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: `<header>` maps to `banner` unless it
          descends from article/aside/main/nav/section (HTML-AAM). This one is a direct child of the
          shell, so it IS a banner, and `banner` supports `aria-label`. The rule assumes the
          `generic` mapping, which it cannot distinguish from markup alone; an explicit
          `role="banner"` trades this for a different false positive from `noInteractiveElementToNoninteractiveRole`. */}
      <header aria-label="Site" className="prl-shell__header" data-stuck={stuck ? 'true' : 'false'}>
        <div className="prl-shell__header-inner prl-pillbar prl-container">
          <Link className="prl-shell__brand prl-pillbar__brand" href="/">
            {/* Ace over diamond is the mark. It identifies the app below 1280px, where the name hides. */}
            <span aria-hidden="true" className="prl-shell__brand-index">
              <span className="prl-shell__brand-rank">A</span>
              <span className="prl-shell__brand-suit">{'\u2666\uFE0E'}</span>
            </span>
            {/* The visible name is `display: none` at some widths. This copy keeps the link named. */}
            <span className="prl-visually-hidden">Poker Risk Lab, home</span>
            <span className="prl-shell__brand-name" aria-hidden="true">
              Poker Risk<span className="prl-shell__brand-tail"> Lab</span>
            </span>
          </Link>

          {/* One landmark for all five. `.prl-nav` hides below 860px, taking the button with the links. */}
          <nav aria-label="Primary" className="prl-nav prl-pillbar__nav">
            <ul className="prl-nav--pill prl-pill-group">
              {PILL_DESTINATIONS.map((destination) => {
                const current = isCurrentDestination(destination.href, pathname);
                const counted = destination.href === COUNTED_HREF && scenarioCount !== null;
                return (
                  <li key={destination.href}>
                    <Link
                      aria-current={current ? 'page' : undefined}
                      className="prl-nav__link"
                      href={destination.href}
                    >
                      <SuitMark area={destination.area ?? null} className="prl-nav__mark" />
                      <span className="prl-nav__label">{destination.label}</span>
                      {/* Always rendered. `:empty` collapses it when there is no count. */}
                      <span className="prl-nav__count">
                        {counted ? scenarioCount : null}
                        {counted ? <span className="prl-visually-hidden"> scenarios</span> : null}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>

            <Link
              aria-current={ctaCurrent ? 'page' : undefined}
              className="prl-pillbar__cta prl-pill-group"
              href={CTA_DESTINATION.href}
            >
              <SuitMark area="play" className="prl-pillbar__cta-mark" />
              <span>{CTA_DESTINATION.label}</span>
            </Link>
          </nav>

          <div className="prl-shell__header-tools">
            {units.state === 'unknown' ? (
              <UnitsUnknown />
            ) : (
              <UnitsBadge
                className="prl-shell__units"
                label="Practice units"
                linkAs={Link}
                recordHref={RECORD_DESTINATION.href}
                resetHref={RECORD_DESTINATION.href}
                route={pathname}
                units={units.units}
              />
            )}
            <MobileNav pathname={pathname} />
          </div>
        </div>
      </header>
      <NavigationPending pathname={pathname} />
    </>
  );
}

'use client';

/**
 * The floating pill bar: the wordmark, the destinations, the call to action, the units readout,
 * and the narrow-viewport menu.
 *
 * ## The shape, and why it is four separate objects
 *
 * The bar is not a strip of chrome welded to the top of the window. It is a set of rounded,
 * OPAQUE groups lying on the page with air above them and gaps between them:
 *
 *   1. the wordmark — a `00` mark plus the product name, which is not a pill because it is not
 *      a control and should not invite a press;
 *   2. the navigation pill — the four study destinations;
 *   3. the call to action — `Play`, in the accent fill, because it is the thing the product is
 *      for and it was previously the fourth of five equally quiet links;
 *   4. the units readout — the figure pill and its round `i`, which is the icon-only circle in
 *      this design and is a real disclosure rather than decoration.
 *
 * `<nav aria-label="Primary">` wraps the pill AND the call to action, so all five destinations are
 * inside one landmark. Splitting them would leave a screen-reader user who jumps to the primary
 * navigation with four of the app's five sections and no hint that a fifth exists.
 *
 * ## What was removed, and why
 *
 * **The `01…05` ordinals.** They cost horizontal room in the one control a reader SCANS rather
 * than reads, and the room came out of the word beside them — the labels were 11px. The series is
 * still stated where the list is read rather than scanned: the sheet and the footer.
 *
 * **`Play` from the link list.** It is the call to action now. It is not duplicated as a link as
 * well, because two controls with the same destination in the same landmark is two things to
 * choose between for no benefit, and `aria-current="page"` on the call to action still marks it
 * when the reader is on `/play`.
 *
 * **The theme control**, which used to be a boxy segmented widget wedged into the corner beside
 * the units. It is rehoused rather than deleted: `SiteFooter` renders it under an `Appearance`
 * heading on every page and at every width, and `MobileNav` renders it in the sheet. Both copies
 * take the bar's pill shape, and both are the same three real radios subscribed to
 * `<html data-theme>`, so they cannot disagree about which theme is on.
 *
 * The reason is arithmetic rather than taste, and it was measured rather than assumed. At 1280px
 * the container is 1200px; the wordmark, the pill, the button and the units readout need 1067 of
 * it, and the switch needs 217 more. Keeping all five meant either dropping the product's name
 * from its own header or letting the bar wrap to two rows on a laptop. A preference control that
 * is one scroll away is a smaller cost than either.
 *
 * ## The count badge is fetched, never typed
 *
 * One destination carries a count, and it is a REAL one: the number of scenarios the API is
 * actually serving. It is not a constant — the fixture has six and the API has thirty-six, and a
 * hard-coded badge would confidently state whichever number a developer saw once. If the request
 * fails the badge renders nothing at all, which is the honest answer to "how many are there" when
 * the thing that knows is not answering.
 *
 * The answer is cached in a module-level variable, so a client-side navigation between routes does
 * not re-ask a question whose answer did not change, and the badge does not flicker in and out.
 *
 * ## The sentinel, and why there is no scroll listener
 *
 * The pills carry a stronger edge once they are floating over content (§9). The obvious
 * implementation — a `scroll` handler reading `window.scrollY` — is the one the design system
 * forbids (§5.4), and for a good reason: a scroll handler runs on the main thread at scroll
 * frequency, on every page, forever, to answer a question whose answer changes twice.
 *
 * So the question is asked structurally instead. A zero-cost sentinel is parked over the top 40px
 * of the document (absolutely positioned inside a zero-height anchor, so it takes part in no
 * layout), and an `IntersectionObserver` reports when it leaves the viewport. The browser
 * delivers that off the main thread and only when the answer flips. `--prl-shell-sentinel` in
 * `globals.css` owns the 40px, so the threshold is a token rather than a number in a comparison.
 *
 * The observer is NOT unobserved after firing — unlike a reveal, this state is not one-shot: it
 * has to come back when the reader scrolls to the top again.
 *
 * ## The units badge
 *
 * Permanent, in the bar, on every route, with the word `units` spelled out and never a currency
 * symbol (`UnitsBadge` in `@prl/ui` enforces that and carries the "free, valueless, resettable"
 * explanation as a real disclosure rather than a `title` tooltip). It is never hidden, shortened
 * or dropped at any viewport width: it is a product guardrail, and the whole bar is laid out
 * around keeping it visible.
 *
 * It renders the fixture's starting balance on the server and asks the API for the real figure
 * after mount. That order is deliberate: the badge is part of the shell, the shell is on every
 * page, and awaiting a session in the root layout would make every route in the app dynamic and
 * add a round trip to first byte — to change one number that the fixture already gets right for a
 * new player.
 *
 * ### It stops claiming a figure the moment it learns it cannot check one
 *
 * The session effect used to read `if (!result.ok) return;`, which left the bundled starting
 * balance standing whenever the API could not be reached. With the API stopped the bar therefore
 * stated `1,000 UNITS`, unqualified, on every page, to a reader whose real figure was 2,000 — and
 * on `/record` it sat directly above that page's own "your record could not be fetched" notice.
 * Two statements about the same reader, on one screen, one of them invented.
 *
 * So the badge now tracks a `UnitsReadout` rather than a number, and when nothing has told it a
 * figure it shows no figure. The precedent is its own sibling three fields down: the scenario
 * count renders nothing at all when the request fails, because not answering is a fine answer and
 * a made-up count is not. The difference here is that the readout says which of the two happened
 * instead of going quiet — the pill stays in the bar, holding the word `units` and the sentence
 * that no figure could be fetched, so the guardrail is intact and nothing on screen is a guess.
 *
 * ### And it re-asks when the reader changes something
 *
 * Pressing "reset my units" on `/record` produced "Done. Your units are back to 2000" while this
 * badge went on reading `3,308 UNITS` until a reload: it read the session once, on mount, and
 * nothing told it the number had moved. It now subscribes to `subscribeToAcceptedMutations`
 * (`lib/api.ts`), which fires after any mutating request the API accepts, and re-reads the
 * session. It re-reads rather than being handed the new figure on purpose — see that function's
 * note. The header shows what `GET /auth/session` says and nothing else, which is what makes it
 * incapable of disagreeing with any other screen.
 *
 * ## What the active destination is marked with
 *
 * `aria-current="page"` for assistive tech, plus an accent FILL and a heavier weight on the link.
 * The weight is what carries the state where colour cannot — forced colors, monochrome print, or
 * a reader who cannot separate the two hues (WCAG 1.4.1).
 */

import type { ScenarioListResponse } from '@prl/contracts';
import { UnitsBadge } from '@prl/ui';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactElement, useEffect, useRef, useState } from 'react';
import { API_PATHS, apiGet, fetchSession, safeFetch, subscribeToAcceptedMutations } from '@/lib/api.ts';
import { isCurrentDestination, NAV_DESTINATIONS } from '@/lib/nav.ts';
import { MobileNav } from './MobileNav.tsx';

/** The destination promoted out of the link list and into the accent pill. */
const CTA_HREF = '/play';

/** The destination that carries a count badge, and the only one that does. */
const COUNTED_HREF = '/lab';

/** Everything the navigation pill lists — the destinations, less the one that became the button. */
const PILL_DESTINATIONS = NAV_DESTINATIONS.filter((destination) => destination.href !== CTA_HREF);

/**
 * The call to action's own entry, read from the same table as the links.
 *
 * The fallback is not defensive noise: `NAV_DESTINATIONS` is data, and if somebody renames
 * `/play` this component must still render a bar rather than throw inside the root layout of
 * every route. A wrong label is a bug report; a blank app is an outage.
 */
const CTA_DESTINATION = NAV_DESTINATIONS.find((destination) => destination.href === CTA_HREF) ?? {
  href: CTA_HREF,
  label: 'Play',
  summary: '',
};

/**
 * The last count this browser was told, shared by every mount of the header.
 *
 * The header remounts on nothing (it is in the root layout), but React's development double-invoke
 * and a full client-side remount both exist, and re-asking is a request that can only produce the
 * answer already on screen.
 */
let cachedScenarioCount: number | null = null;

/**
 * What the bar is entitled to say about the reader's units.
 *
 * Three states rather than a number, because "1,000" and "1,000, and nobody has confirmed that"
 * and "we could not find out" are three different claims and the bar was making the first one for
 * all three. The union is what stops a future edit collapsing them again: there is no number to
 * read without first saying which of the three you are in.
 *
 *  - `assumed` — the figure on screen is the starting balance the shell was handed, and no answer
 *    from the API has either confirmed or replaced it. This is the server render, the moment
 *    before the session read lands, and the reader who has no session at all: a visitor with no
 *    account has no figure of their own, and the starting balance is exactly what the product will
 *    give them, so showing it is a statement about the product rather than about them.
 *  - `known` — `GET /auth/session` named a user and this is that user's figure.
 *  - `unknown` — the session read failed. No figure is shown at all.
 */
type UnitsReadout =
  | { readonly state: 'assumed'; readonly units: number }
  | { readonly state: 'known'; readonly units: number }
  | { readonly state: 'unknown' };

/**
 * The pill, when there is no figure to put in it.
 *
 * Shaped like `UnitsBadge` and wearing its classes, so the bar's layout does not move and the
 * word `units` stays where the guardrail requires it. What it does not have is a number, a
 * placeholder digit or a dash that could be mistaken for one: the whole point is that this
 * component knows nothing and says so.
 *
 * No `i` disclosure here. That button explains what a unit is, and it is attached to a figure —
 * `SiteFooter` carries the same `UNITS_EXPLANATION` on every page and at every width, so nothing
 * about what units ARE is lost while the API is unreachable.
 */
function UnitsUnknown(): ReactElement {
  return (
    <span className="prl-units prl-shell__units">
      <span className="prl-units__value">
        <span className="prl-units__word prl-label">units — not available</span>
        <span className="prl-visually-hidden">
          Your practice units could not be fetched, so no figure is shown here. Nothing about your units has
          changed.
        </span>
      </span>
    </span>
  );
}

export interface SiteHeaderProps {
  /**
   * The units to show before the API answers — the fixture's starting balance. Passed in rather
   * than imported so the shell has no opinion about where the fallback comes from.
   */
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
    // No observer (a very old browser, or a test environment): the pills simply keep their resting
    // edge, which is legible on every surface. Failing towards "no state change" is right here —
    // failing towards "permanently floating" would look like a bug.
    if (typeof IntersectionObserver !== 'function') return;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) setStuck(!entry.isIntersecting);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    // Aborted on unmount so a navigation away does not leave a request resolving into a component
    // that is gone. `safeFetch` never throws, so there is no rejection to swallow either.
    const controller = new AbortController();
    let mounted = true;

    const readSession = (): void => {
      void fetchSession({ signal: controller.signal }).then((result) => {
        // The unsubscribe below runs before the abort, so nothing re-reads after unmount; this
        // guard is for the read already in flight when the reader navigated away.
        if (!mounted) return;
        if (!result.ok) {
          // The failure is the answer. Keeping the starting balance on screen here is what stated
          // `1,000 UNITS` to a reader with 2,000 for as long as the API stayed down — and it did
          // it silently, because `return` looks like "nothing to update" rather than "we just
          // found out we are guessing".
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
    // A reset, a guest sign-up, anything the API accepted: the shell's copy of the session is now
    // out of date, and the fix is to ask the one endpoint that knows rather than to trust the echo.
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
      // Not answering is a fine answer: the badge stays absent rather than inventing a number.
      if (!result.ok) return;
      cachedScenarioCount = result.data.scenarios.length;
      setScenarioCount(cachedScenarioCount);
    });
    return () => controller.abort();
  }, []);

  const ctaCurrent = isCurrentDestination(CTA_DESTINATION.href, pathname);

  return (
    <>
      {/* Zero-height anchor; the sentinel inside it is absolutely positioned, so neither element
          contributes to layout and neither can shift the page. */}
      <div className="prl-shell__sentinel-anchor">
        <div aria-hidden="true" className="prl-shell__sentinel" ref={sentinelRef} />
      </div>

      {/* Named, even though a `banner` is usually unique enough without one. Routes render their
          own `<header>` blocks for their page heads, and a screen-reader rotor listing two
          unnamed banners tells the reader nothing about which is the site's. */}
      {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: `<header>` maps to `banner` unless it
          descends from article/aside/main/nav/section (HTML-AAM). This one is a direct child of the
          shell, so it IS a banner, and `banner` supports `aria-label`. The rule assumes the
          `generic` mapping, which it cannot distinguish from markup alone; an explicit
          `role="banner"` trades this for a different false positive from `noInteractiveElementToNoninteractiveRole`. */}
      <header aria-label="Site" className="prl-shell__header" data-stuck={stuck ? 'true' : 'false'}>
        <div className="prl-shell__header-inner prl-pillbar prl-container">
          <Link className="prl-shell__brand prl-pillbar__brand" href="/">
            {/* The numbered motif applied to the product itself: the wordmark is the zeroth item in
                the system. As a mark rather than a prefix it is also what identifies the app below
                1280px, where the name itself gives up its room to controls that do something. */}
            <span aria-hidden="true" className="prl-shell__brand-index prl-index">
              00
            </span>
            {/* `display: none` on the visible name at 375 and 860–1279 removes it from the a11y
                tree. The visually-hidden copy stays in the name so the home control is never
                "00" with no words. */}
            <span className="prl-visually-hidden">Poker Risk Lab, home</span>
            <span className="prl-shell__brand-name" aria-hidden="true">
              Poker Risk<span className="prl-shell__brand-tail"> Lab</span>
            </span>
          </Link>

          {/* One landmark for every destination, including the one rendered as a button. */}
          {/* `.prl-nav` is what `globals.css` hides below 860px, and it is on the LANDMARK rather
              than on the pill so the accent button disappears with the links: below the breakpoint
              the sheet is the navigation, and half of one nav beside all of another is worse than
              either. */}
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
                      <span className="prl-nav__label">{destination.label}</span>
                      {/* Always rendered so the empty case is a CSS state rather than a second
                          branch; `:empty` collapses it to nothing at all. */}
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
              <span>{CTA_DESTINATION.label}</span>
              {/* Two borders on a rotated square, not an arrow character: it inherits the ink, it
                  needs no font to be installed, and it is not read out as "north east arrow". */}
              <span aria-hidden="true" className="prl-pillbar__cta-glyph" />
            </Link>
          </nav>

          <div className="prl-shell__header-tools">
            {units.state === 'unknown' ? (
              <UnitsUnknown />
            ) : (
              <UnitsBadge className="prl-shell__units" label="Practice units" units={units.units} />
            )}
            <MobileNav pathname={pathname} />
          </div>
        </div>
      </header>
    </>
  );
}

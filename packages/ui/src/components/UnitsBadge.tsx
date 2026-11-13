'use client';

/**
 * A play-units balance, with the explanation of what units are attached to it.
 *
 * ## What this component is for
 *
 * The product guardrails are unambiguous: units are free, resettable and valueless,
 * there is no purchase, no cash-out, no transfer. This badge is where that promise is
 * made in the interface. The word "units" is always rendered next to the number — never
 * a bare figure, never a currency symbol, never the word "chips" or "balance", which
 * are the words that make play money feel like money.
 *
 * ## Why a disclosure button and not a `title` tooltip
 *
 * A `title` attribute is unreachable by keyboard, invisible on touch, and unstyleable.
 * Essential information may not live there, so this uses the standard disclosure
 * pattern instead:
 *
 *  - The explanation is a real element with a stable id.
 *  - The toggle is a real `<button>`, so it is tab-reachable and Enter/Space operable
 *    for free, with `aria-expanded` and `aria-controls` describing its effect.
 *  - The button also carries `aria-describedby` pointing at the explanation, so a
 *    screen reader hears the full text on arrival *whether or not* it is expanded —
 *    referencing a hidden element from `aria-describedby` is supported and is exactly
 *    the case it exists for. Sighted users expand it; non-visual users already have it.
 *
 * The button is 28px square with a 24px floor from `--prl-target-min`, meeting WCAG 2.2
 * Target Size (Minimum).
 *
 * ## It closes the ways a reader expects it to
 *
 * It used to close only on a second press of the `i`. The audit at 6b3886e measured the open
 * panel at 16,66,358,91 after an outside tap, after Escape, after scrolling 400px and after a
 * client navigation from /learn to /learn/glossary — `aria-expanded` still `true` after Escape —
 * and at 390x844 a panel that will not go away is a permanent cover over the top of every page.
 * So it now also closes:
 *
 *  - on **Escape**, and when focus was inside it, focus goes back on the `i` (the APG disclosure
 *    rule: the keyboard user is returned to the control that opened it, not dropped on `<body>`);
 *  - on a **pointerdown outside** it — outside the whole badge, so pressing the `i` itself is
 *    still the toggle rather than a close followed by a reopen;
 *  - when **`route` changes**. This package has no router, so the shell passes its pathname; a
 *    panel left open on the next page is describing something the reader has moved away from.
 *
 * ## The reset it promises is a link
 *
 * The explanation says units can be reset "at any time", and gave no way to do it. With
 * `resetHref` the phrase is a link to the page that does it, and with `recordHref` the figure
 * itself is one: the number in the bar is the reader's own, and `/record` is where it lives
 * alongside everything else they have done. Both go through `linkAs`, because this package does
 * not depend on Next — the app hands in its `Link` so the navigation stays a client one, and the
 * default is a plain `<a>`, which is still a working link.
 *
 * ## Why this is a client component
 *
 * `useId` and `useState`. The id must be identical on the server and in the browser or
 * hydration warns, which is precisely what `useId` guarantees and what a module-level
 * counter would get wrong under concurrent rendering.
 */

import {
  type ComponentType,
  type ReactElement,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { cx } from '../cx.ts';
import { formatChips } from '../format.ts';

/** The words before the reset phrase. Split so the phrase can be a link without rewording it. */
const EXPLANATION_LEAD =
  'Units are free practice chips. They have no monetary value, they cannot be bought, sold, ' +
  'transferred or cashed out, and you can ';

/** The part of the promise a reader can act on — the link text when there is somewhere to go. */
const EXPLANATION_RESET = 'reset them to the starting amount';

const EXPLANATION_TAIL = ' at any time.';

/**
 * The wording of the promise. Exported so a page can restate it in its footer or its
 * terms without the two copies drifting apart. Built from the same three pieces the panel renders,
 * so the linked panel and this string cannot say different things.
 */
export const UNITS_EXPLANATION = `${EXPLANATION_LEAD}${EXPLANATION_RESET}${EXPLANATION_TAIL}`;

/** What `linkAs` must accept: the subset of an anchor's props this component passes. */
export interface UnitsLinkProps {
  readonly href: string;
  readonly className?: string;
  readonly children?: ReactNode;
}

export interface UnitsBadgeProps {
  readonly units: number;
  /** Prefix, e.g. "Your balance". Rendered as visually hidden context for the figure. */
  readonly label?: string;
  readonly className?: string;
  /** Where the figure leads: the reader's own record. Omitted, the figure is plain text. */
  readonly recordHref?: string;
  /** Where the explanation's "reset them" leads. Omitted, the explanation is plain text. */
  readonly resetHref?: string;
  /** The link component, e.g. Next's `Link`. Defaults to a plain anchor. */
  readonly linkAs?: ComponentType<UnitsLinkProps>;
  /**
   * Anything that changes when the reader navigates — the shell passes its pathname. The panel
   * closes when it changes; see the module comment.
   */
  readonly route?: string;
}

function PlainLink({ href, className, children }: UnitsLinkProps): ReactElement {
  return (
    <a className={className} href={href}>
      {children}
    </a>
  );
}

export function UnitsBadge(props: UnitsBadgeProps): ReactElement {
  const { units, label = 'Practice units', className, recordHref, resetHref, route } = props;
  const LinkAs = props.linkAs ?? PlainLink;
  const noteId = useId();
  const [expanded, setExpanded] = useState(false);
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);

  // Adjusted during render rather than in an effect: React's own pattern for "reset state when a
  // prop changes", and it closes the panel in the same render as the new page rather than one
  // painted frame after it.
  const [seenRoute, setSeenRoute] = useState(route);
  if (route !== seenRoute) {
    setSeenRoute(route);
    setExpanded(false);
  }

  useEffect(() => {
    if (!expanded) return;
    // Registered only while open, so a closed badge on every page costs nothing. `pointerdown`
    // rather than `click`, so the panel is already gone by the time a press on the page beneath
    // it lands, and the reader is not looking at a cover over the thing they just pressed.
    const onPointerDown = (event: PointerEvent): void => {
      const root = rootRef.current;
      if (root !== null && event.target instanceof Node && root.contains(event.target)) return;
      setExpanded(false);
    };
    // On the document, because the panel covers the page wherever focus is. Focus goes back to the
    // `i` only when it was inside the badge — the `i` itself or the reset link — so Escape from
    // somewhere else does not drag the caret up to the header.
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      const root = rootRef.current;
      const inside =
        root !== null && document.activeElement !== null && root.contains(document.activeElement);
      setExpanded(false);
      if (inside) toggleRef.current?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [expanded]);

  const readout = (
    <>
      <span className="prl-visually-hidden">{`${label}: `}</span>
      {/* Its own element so the stylesheet can give it tabular figures: this number changes
          hand by hand, and proportional digits would make the header twitch (§3.3). */}
      <span className="prl-units__figure">{formatChips(units)}</span>
      {/* Never abbreviated, never dropped: the word is the guardrail. */}
      <span className="prl-units__word prl-label">units</span>
    </>
  );

  return (
    <span className={cx('prl-units', className)} ref={rootRef}>
      {recordHref === undefined ? (
        <span className="prl-units__value">{readout}</span>
      ) : (
        // The whole pill is the target, not the digits: 44px tall in the bar, where the figure
        // alone is 20. The hidden words say where it goes, because "1,000 units" names the
        // figure and not the destination.
        <LinkAs className="prl-units__value prl-units__link" href={recordHref}>
          {readout}
          <span className="prl-visually-hidden">, your record</span>
        </LinkAs>
      )}
      <button
        type="button"
        className="prl-units__toggle"
        aria-expanded={expanded}
        aria-controls={noteId}
        aria-describedby={noteId}
        onClick={() => setExpanded((current) => !current)}
        ref={toggleRef}
      >
        <span aria-hidden="true">i</span>
        <span className="prl-visually-hidden">What “units” means</span>
      </button>
      <span className="prl-units__note" id={noteId} hidden={!expanded}>
        {resetHref === undefined ? (
          UNITS_EXPLANATION
        ) : (
          <>
            {EXPLANATION_LEAD}
            <LinkAs href={resetHref}>{EXPLANATION_RESET}</LinkAs>
            {EXPLANATION_TAIL}
          </>
        )}
      </span>
    </span>
  );
}

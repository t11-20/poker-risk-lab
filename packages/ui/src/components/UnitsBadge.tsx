'use client';

/**
 * A play-units balance with the explanation of what units are. The word "units" is always beside the
 * number, never a bare figure or a currency symbol. The explanation is a disclosure, not a `title`,
 * which keyboard and touch cannot reach, and `aria-describedby` reads it on arrival even when collapsed.
 * It closes on Escape (focus returns to the `i` if it was inside), on a pointerdown outside the badge,
 * and when `route` changes, because an open panel covers the top of every page at 390x844.
 * Links go through `linkAs`, because this package does not depend on Next.
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

/** Split so the reset phrase can be a link without rewording it. */
const EXPLANATION_LEAD =
  'Units are free practice chips. They have no monetary value, they cannot be bought, sold, ' +
  'transferred or cashed out, and you can ';

const EXPLANATION_RESET = 'reset them to the starting amount';

const EXPLANATION_TAIL = ' at any time.';

/** Exported so a page can restate the promise. Built from the same pieces the panel renders. */
export const UNITS_EXPLANATION = `${EXPLANATION_LEAD}${EXPLANATION_RESET}${EXPLANATION_TAIL}`;

export interface UnitsLinkProps {
  readonly href: string;
  readonly className?: string;
  readonly children?: ReactNode;
}

export interface UnitsBadgeProps {
  readonly units: number;
  /** Rendered as visually hidden context for the figure. */
  readonly label?: string;
  readonly className?: string;
  /** The reader's record. Omitted, the figure is plain text. */
  readonly recordHref?: string;
  /** Where "reset them" leads. Omitted, the explanation is plain text. */
  readonly resetHref?: string;
  readonly linkAs?: ComponentType<UnitsLinkProps>;
  /** Changes on navigation (the shell passes its pathname). The panel closes when it changes. */
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

  // Adjusted during render (React's reset-on-prop-change pattern), so the panel closes with the new page.
  const [seenRoute, setSeenRoute] = useState(route);
  if (route !== seenRoute) {
    setSeenRoute(route);
    setExpanded(false);
  }

  useEffect(() => {
    if (!expanded) return;
    // `pointerdown`, not `click`, so the panel is gone before the press lands on the page beneath it.
    const onPointerDown = (event: PointerEvent): void => {
      const root = rootRef.current;
      if (root !== null && event.target instanceof Node && root.contains(event.target)) return;
      setExpanded(false);
    };
    // Focus returns to the `i` only if it was inside the badge, so Escape elsewhere leaves the caret.
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
      {/* Its own element for tabular figures, so the header does not twitch (§3.3). */}
      <span className="prl-units__figure">{formatChips(units)}</span>
      {/* Never abbreviated or dropped. The word is the guardrail. */}
      <span className="prl-units__word prl-label">units</span>
    </>
  );

  return (
    <span className={cx('prl-units', className)} ref={rootRef}>
      {recordHref === undefined ? (
        <span className="prl-units__value">{readout}</span>
      ) : (
        // The whole pill is the 44px target. The hidden words name the destination, not the figure.
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

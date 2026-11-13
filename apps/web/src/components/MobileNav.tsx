'use client';

/**
 * The narrow-viewport navigation: a trigger button and the full-screen sheet it opens. The trigger
 * lives here so the open state, the focus-return target and the `aria-controls` id stay together.
 *
 * The focus trap does five things. Escape closes. Tab cycles over the tabbable set (a radio group is
 * one stop). A document `focusin` listener pulls back focus that arrow keys or script move outside.
 * Focus enters on the close button and returns to the trigger on close.
 *
 * Not a `<dialog>`, because its top layer and `::backdrop` fight the token surfaces. Everything
 * outside the sheet is made `inert` while open, because `aria-modal` alone left 29 of 34 background
 * elements in the accessibility tree at 390x844 (`J7.4` in `scripts/ax-assertions.mjs`).
 *
 * A route change and a resize past the breakpoint both close the sheet, so the scroll lock never
 * outlives it.
 */

import Link from 'next/link';
import {
  type ReactElement,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { SuitMark } from '@/components/SuitMark.tsx';
import { isCurrentDestination, NAV_DESTINATIONS, NAV_SHEET_QUERY, RECORD_DESTINATION } from '@/lib/nav.ts';
import { ThemeToggle } from './ThemeToggle.tsx';

/** Narrow on purpose. `[tabindex]:not([tabindex='-1'])` catches a focusable control a later edit adds. */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  "[tabindex]:not([tabindex='-1'])",
].join(',');

/**
 * The browser's tab sequence. A radio group is one stop, at the checked radio or the first. Cycling on
 * the raw focusable list let Tab escape to the Fold, Call and Raise controls behind the sheet
 * (390x844 on `/play`, WCAG 2.4.3 and 2.4.11).
 */
function tabbableWithin(root: HTMLElement): readonly HTMLElement[] {
  const focusable = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  const seenGroups = new Set<string>();
  return focusable.filter((element) => {
    if (!(element instanceof HTMLInputElement) || element.type !== 'radio') return true;
    if (element.name === '') return true;
    const group = focusable.filter(
      (other): other is HTMLInputElement =>
        other instanceof HTMLInputElement && other.type === 'radio' && other.name === element.name,
    );
    const stop = group.find((radio) => radio.checked) ?? group[0];
    if (stop !== element) return false;
    // Defensive. A `name` that somehow appears twice must not contribute two stops.
    if (seenGroups.has(element.name)) return false;
    seenGroups.add(element.name);
    return true;
  });
}

/** The attribute `globals.css` uses to lock scrolling while the sheet is open. */
const NAV_OPEN_ATTRIBUTE = 'data-nav-open';

/**
 * Never made `inert`. `script`, `style` and `link` are not content. The route announcer is the one
 * live region outside the sheet that speaks while it is open (Back with the sheet open), and an inert
 * region is silent. `scripts/ax-assertions.mjs` asserts it is the only exemption.
 */
const INERT_EXEMPT = ['script', 'style', 'link', '[data-prl-route-announcer]'].join(',');

/**
 * Every sibling on the path from the sheet up to `<body>`, the set `showModal()` gets from the top
 * layer. Ancestors are excluded because `inert` is inherited and would disable the sheet itself.
 */
function inertBackgroundOf(sheet: HTMLElement): readonly HTMLElement[] {
  const background: HTMLElement[] = [];
  for (let node: HTMLElement = sheet; node !== document.body; ) {
    const parent = node.parentElement;
    if (parent === null) break;
    for (const sibling of parent.children) {
      if (sibling === node) continue;
      if (!(sibling instanceof HTMLElement)) continue;
      if (sibling.matches(INERT_EXEMPT)) continue;
      background.push(sibling);
    }
    node = parent;
  }
  return background;
}

export interface MobileNavProps {
  /** The current route, from the header's `usePathname`, so both navs agree on what is current. */
  readonly pathname: string;
}

export function MobileNav(props: MobileNavProps): ReactElement {
  const { pathname } = props;
  const sheetId = useId();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  /** Set on open and cleared once focus is returned, so the close effect never steals focus. */
  const returnFocus = useRef(false);
  /** The route the sheet was last open for, so the effect reads `pathname` and skips the mount. */
  const openedAt = useRef(pathname);

  const close = (): void => {
    setOpen(false);
  };

  // A navigation closes the sheet, including the browser back button.
  useEffect(() => {
    if (openedAt.current === pathname) return;
    openedAt.current = pathname;
    setOpen(false);
  }, [pathname]);

  // Above the breakpoint the sheet is hidden, but its scroll lock would remain.
  useEffect(() => {
    if (!open) return;
    if (typeof window.matchMedia !== 'function') return;
    const wide = window.matchMedia(NAV_SHEET_QUERY);
    const onChange = (): void => {
      if (wide.matches) setOpen(false);
    };
    wide.addEventListener('change', onChange);
    return () => wide.removeEventListener('change', onChange);
  }, [open]);

  /** The scroll lock is an attribute on the root, so its value stays in the stylesheet. */
  useEffect(() => {
    const root = document.documentElement;
    if (open) {
      root.setAttribute(NAV_OPEN_ATTRIBUTE, 'true');
      returnFocus.current = true;
      // Focus first, `inert` second. Chrome blurs a focused element when it becomes inert, and the
      // trigger holds focus right now.
      closeRef.current?.focus();
      /** The `focusin` trap below still guards `INERT_EXEMPT` nodes and browsers without `inert`. */
      const background = sheetRef.current === null ? [] : inertBackgroundOf(sheetRef.current);
      for (const element of background) element.setAttribute('inert', '');
      /**
       * Arrow keys in a radio group move focus natively, past any `keydown` handler, so the trap
       * watches where focus lands. On the document, because focus landing outside never reaches the sheet.
       */
      const onFocusIn = (event: FocusEvent): void => {
        const sheet = sheetRef.current;
        if (sheet === null) return;
        const target = event.target;
        if (target instanceof Node && sheet.contains(target)) return;
        // Back to the way out, where focus entered.
        closeRef.current?.focus();
      };
      document.addEventListener('focusin', onFocusIn);
      return () => {
        root.removeAttribute(NAV_OPEN_ATTRIBUTE);
        document.removeEventListener('focusin', onFocusIn);
        // The list captured on open, so nothing stays `inert`. This cleanup runs before the close
        // branch below, so the trigger is focusable again when focus returns to it.
        for (const element of background) element.removeAttribute('inert');
      };
    }
    if (returnFocus.current) {
      returnFocus.current = false;
      triggerRef.current?.focus();
    }
    return undefined;
  }, [open]);

  /** On the container, not `document`, so an unrelated dialog's Escape cannot close this one. */
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const sheet = sheetRef.current;
    if (sheet === null) return;
    // Re-queried on every Tab, because arrowing through the theme radios moves the group's stop.
    const tabbable = tabbableWithin(sheet);
    // An empty sheet has nothing to cycle between.
    const first = tabbable[0];
    const last = tabbable[tabbable.length - 1];
    if (first === undefined || last === undefined) return;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !sheet.contains(active))) {
      event.preventDefault();
      last.focus();
      return;
    }
    if (!event.shiftKey && (active === last || !sheet.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <>
      <button
        aria-controls={sheetId}
        aria-expanded={open}
        className="prl-nav-trigger"
        onClick={() => setOpen((current) => !current)}
        ref={triggerRef}
        type="button"
      >
        {/* Bars drawn by CSS pseudo-elements, so there is no icon font. The word is what is read. */}
        <span aria-hidden="true" className="prl-nav-trigger__bars" />
        <span className="prl-nav-trigger__word prl-label">Menu</span>
      </button>

      {/* Always rendered, so `hidden` handles the tree and `aria-controls` always points at a node. */}
      <div
        aria-label="Menu"
        aria-modal="true"
        className="prl-sheet"
        hidden={!open}
        id={sheetId}
        onKeyDown={onKeyDown}
        ref={sheetRef}
        role="dialog"
      >
        <div className="prl-sheet__bar">
          <span className="prl-sheet__title prl-label">Navigate</span>
          <button className="prl-sheet__close" onClick={close} ref={closeRef} type="button">
            <span aria-hidden="true">×</span>
            <span className="prl-visually-hidden">Close menu</span>
          </button>
        </div>

        {/* Not "Primary" like the header nav, because duplicate landmark names fail `landmark-unique`. */}
        <nav aria-label="All sections" className="prl-sheet__nav">
          <ul className="prl-sheet__list">
            {NAV_DESTINATIONS.map((destination) => {
              const current = isCurrentDestination(destination.href, pathname);
              return (
                <li className="prl-sheet__item" key={destination.href}>
                  <Link
                    aria-current={current ? 'page' : undefined}
                    className="prl-sheet__link"
                    href={destination.href}
                    onClick={close}
                  >
                    <SuitMark area={destination.area ?? null} className="prl-sheet__index" />
                    <span className="prl-sheet__label">{destination.label}</span>
                    <span className="prl-sheet__summary">{destination.summary}</span>
                  </Link>
                </li>
              );
            })}
            {/* After the five and unmarked, see `RECORD_DESTINATION`. The blank mark keeps the column. */}
            <li className="prl-sheet__item">
              <Link
                aria-current={isCurrentDestination(RECORD_DESTINATION.href, pathname) ? 'page' : undefined}
                className="prl-sheet__link"
                href={RECORD_DESTINATION.href}
                onClick={close}
              >
                <SuitMark area={null} className="prl-sheet__index" />
                <span className="prl-sheet__label">{RECORD_DESTINATION.label}</span>
                <span className="prl-sheet__summary">{RECORD_DESTINATION.summary}</span>
              </Link>
            </li>
          </ul>
        </nav>

        {/* Labelled with the footer's wording for the same control. */}
        <div className="prl-sheet__foot">
          <p className="prl-sheet__title prl-label">Appearance</p>
          <ThemeToggle />
        </div>
      </div>
    </>
  );
}

'use client';

/**
 * The narrow-viewport navigation: a trigger button and the full-screen sheet it opens.
 *
 * ## Why the trigger lives here and not in the header
 *
 * The trigger and the sheet share three pieces of state that must not be split across a
 * component boundary: whether the sheet is open, which element focus returns to when it closes,
 * and the id that `aria-controls` points at. Handing the header a `<button>` and the sheet a
 * separate `open` prop is how "focus returns to the trigger" turns into "focus returns to the
 * body", which for a keyboard user means starting the page again from the top.
 *
 * ## The focus trap, and why it is written out rather than reached for
 *
 * A modal surface that does not trap focus is a keyboard trap in the other direction: Tab walks
 * out of the sheet into a page the reader cannot see, and there is no way back except Shift-Tab
 * blindly. The implementation is deliberately small and does exactly four things:
 *
 *  1. **Escape closes.** Handled on the sheet, so it works no matter which control inside has
 *     focus, and only while open.
 *  2. **Tab cycles**, over the browser's TABBABLE set rather than the focusable one — a radio group
 *     is a single tab stop and the three theme radios are not three (see `tabbableWithin`). The set
 *     is re-queried on each Tab rather than cached on open, because the sheet's content is links
 *     plus a theme control, and which radio is the group's stop changes as the reader arrows
 *     through it.
 *  5. **Focus that lands outside is pulled back**, from a `focusin` listener on the document while
 *     the sheet is open. Tab is not the only key that moves focus — the arrow keys move it inside a
 *     radio group, natively, with nothing for a `keydown` handler to cancel — so cycling Tab alone
 *     traps one route out of a surface that has several.
 *  3. **Focus enters** on open — to the close button, not the first link. The first link is a
 *     destination; the close button is the way back, and it is what a reader who opened the menu
 *     by accident needs first.
 *  4. **Focus returns** to the trigger on close, always, including when the sheet closes because
 *     a link was followed. The alternative — leaving focus on a node that is being unmounted —
 *     drops the caret to `<body>`.
 *
 * `aria-modal="true"` tells assistive tech that the rest of the page is out of scope. The
 * `<dialog>` element with `showModal()` would give the trap for free, but it also brings its own
 * top-layer stacking, its own backdrop and a `::backdrop` that cannot be styled from the token
 * system's surface ramp without fighting the UA — for a full-screen opaque sheet that is all
 * cost and no benefit.
 *
 * ## Two ways the sheet can be dismissed without being clicked
 *
 * **A route change**, because the browser's back button navigates without telling this component
 * anything. `pathname` is a dependency, so a navigation closes the sheet.
 *
 * **A viewport resize past the breakpoint**, which matters more than it sounds: the CSS hides
 * the sheet above 860px, so a reader who rotates a tablet while the menu is open would be left
 * with an invisible sheet and — this is the real bug — a body that is still scroll-locked.
 */

import { formatIndex } from '@prl/ui';
import Link from 'next/link';
import {
  type ReactElement,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { isCurrentDestination, NAV_DESTINATIONS, NAV_SHEET_QUERY } from '@/lib/nav.ts';
import { ThemeToggle } from './ThemeToggle.tsx';

/**
 * What counts as focusable for the trap.
 *
 * Deliberately narrow: the sheet contains links, buttons and radio inputs, and nothing else.
 * `[tabindex]:not([tabindex='-1'])` catches anything a future edit adds without updating this
 * string, which is the case worth covering — a new focusable control that the trap does not
 * know about is a control the reader can Tab out of the sheet to reach.
 */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  "[tabindex]:not([tabindex='-1'])",
].join(',');

/**
 * FOCUSABLE is not TABBABLE, and the difference is a whole radio group.
 *
 * A radio group is ONE tab stop, at the checked radio (or the first, when none is checked). Every
 * radio in the group is focusable — arrow keys move between them — but Tab enters the group once
 * and leaves it once. The trap below cycles on `focusable[length - 1]`, so with the raw list the
 * "last" element was the `dark` radio, which is only ever the tab stop for a reader who has already
 * chosen Dark. On the default ("Auto", the FIRST radio) Tab moved past the whole group, `active`
 * was neither the last element nor outside the sheet, the handler did nothing, and focus landed on
 * the bet-sizing controls behind the open sheet. Measured before this fix, 390x844 on `/play`:
 * eight Tabs from the close button reached `.prl-preset` with `sheet.contains(active) === false`.
 * That is WCAG 2.4.3 and 2.4.11, and on a poker table it is worse than a nuisance — the controls
 * the sheet covers are Fold, Call and Raise.
 *
 * So the trap computes the browser's own tab sequence: group radios by `name` within the sheet and
 * keep the checked one, or the first when the group has no checked member. Anything with no `name`
 * is its own group, which is the correct reading of a lone radio.
 */
function tabbableWithin(root: HTMLElement): readonly HTMLElement[] {
  const focusable = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  const seenGroups = new Set<string>();
  return focusable.filter((element) => {
    if (!(element instanceof HTMLInputElement) || element.type !== 'radio') return true;
    // A radio with no name shares a group with nothing, so it is always its own tab stop.
    if (element.name === '') return true;
    const group = focusable.filter(
      (other): other is HTMLInputElement =>
        other instanceof HTMLInputElement && other.type === 'radio' && other.name === element.name,
    );
    const stop = group.find((radio) => radio.checked) ?? group[0];
    if (stop !== element) return false;
    // Defensive: a `name` that somehow appears twice must not contribute two stops.
    if (seenGroups.has(element.name)) return false;
    seenGroups.add(element.name);
    return true;
  });
}

/** The attribute `globals.css` uses to lock scrolling while the sheet is open. */
const NAV_OPEN_ATTRIBUTE = 'data-nav-open';

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
  /**
   * Whether focus has to be handed back. Set when the sheet opens and cleared once it has been
   * returned, so the close effect cannot steal focus from a page the reader arrived at some
   * other way — a component that calls `.focus()` on mount is a component that hijacks the
   * caret every time React remounts it.
   */
  const returnFocus = useRef(false);
  /**
   * The route the sheet was last open for.
   *
   * Comparing against it rather than closing unconditionally does two things: the effect below
   * genuinely READS `pathname` (so it is a real dependency rather than a trigger a linter has to be
   * told to tolerate), and it does not fire a pointless state update on mount.
   */
  const openedAt = useRef(pathname);

  const close = (): void => {
    setOpen(false);
  };

  // A navigation closes the sheet. Also covers the browser back button, which changes the route
  // without any interaction this component can observe.
  useEffect(() => {
    if (openedAt.current === pathname) return;
    openedAt.current = pathname;
    setOpen(false);
  }, [pathname]);

  // Above the breakpoint the sheet is display:none, so an open sheet there is invisible state —
  // and its scroll lock is very much not invisible.
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

  /**
   * The scroll lock, and focus in and out.
   *
   * The lock is an attribute on the root element rather than an inline `overflow: hidden`, so the
   * value stays in the stylesheet where every other value in this app lives, and so a crash
   * between "lock" and "unlock" leaves a diffable attribute rather than a mystery style.
   */
  useEffect(() => {
    const root = document.documentElement;
    if (open) {
      root.setAttribute(NAV_OPEN_ATTRIBUTE, 'true');
      returnFocus.current = true;
      closeRef.current?.focus();
      /**
       * The backstop, and the half of the trap that is not about Tab.
       *
       * Tab is not the only key that moves focus. Inside the theme radio group the ARROW keys move
       * it, and they do so natively — no `keydown` handler on the sheet sees a decision it can
       * cancel, because the browser has already moved the caret by the time anything bubbles. The
       * same is true of a `.focus()` call from any other component, of Home/End inside a group, and
       * of a click on a control the sheet is covering. Cycling Tab correctly closes the reported
       * hole; only watching where focus actually LANDS closes the class.
       *
       * `focusin` on the document, not on the sheet: an event that fires inside the sheet is the
       * uninteresting case. What has to be caught is focus arriving anywhere else while a modal
       * surface is open, and that event never reaches the sheet at all.
       */
      const onFocusIn = (event: FocusEvent): void => {
        const sheet = sheetRef.current;
        if (sheet === null) return;
        const target = event.target;
        if (target instanceof Node && sheet.contains(target)) return;
        // `aria-modal="true"` says the rest of the page is out of scope; this makes it true for the
        // keyboard as well as for assistive tech. The close button is where focus entered, so it is
        // where focus returns — a reader who escaped by accident is put back at the way out.
        closeRef.current?.focus();
      };
      document.addEventListener('focusin', onFocusIn);
      return () => {
        root.removeAttribute(NAV_OPEN_ATTRIBUTE);
        document.removeEventListener('focusin', onFocusIn);
      };
    }
    if (returnFocus.current) {
      returnFocus.current = false;
      triggerRef.current?.focus();
    }
    return undefined;
  }, [open]);

  /**
   * Escape and Tab, on the sheet.
   *
   * `onKeyDown` on the container rather than a `document` listener: the handler must not fire for
   * a keystroke aimed at anything else, and a document-level Escape handler in a component that
   * renders on every page is how an unrelated dialog ends up closing this one.
   */
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const sheet = sheetRef.current;
    if (sheet === null) return;
    // The browser's own tab sequence, radio groups collapsed to one stop each. Re-queried on every
    // Tab rather than cached on open, because selecting a theme with the arrow keys MOVES that stop
    // from one radio to another — a list captured when the sheet opened would be wrong by the time
    // it mattered.
    const tabbable = tabbableWithin(sheet);
    // `noUncheckedIndexedAccess`: both ends are `HTMLElement | undefined`, and an empty sheet is
    // a real (if unlikely) state — nothing to cycle between, so let the browser do as it likes.
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
        {/* Three rules, not a hamburger glyph from an icon font: this is one element with two
            hairline pseudo-elements, it inherits the text colour, and there is no font to fetch.
            The word beside it is what a screen reader reads. */}
        <span aria-hidden="true" className="prl-nav-trigger__bars" />
        <span className="prl-nav-trigger__word prl-label">Menu</span>
      </button>

      {/* Always rendered, never conditionally mounted: `hidden` keeps it out of the accessibility
          tree and out of the tab order, and keeping the node means the sheet's opening animation
          has something to animate FROM. A conditional mount would also make `aria-controls` point
          at an element that does not exist for most of the page's life. */}
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

        {/* A different accessible name from the header's `<nav aria-label="Primary">` on purpose:
            two navigation landmarks with the same name is the `landmark-unique` failure, and a
            screen-reader rotor listing "Primary navigation" twice tells the reader nothing about
            which is which. */}
        <nav aria-label="All sections" className="prl-sheet__nav">
          <ul className="prl-sheet__list">
            {NAV_DESTINATIONS.map((destination, position) => {
              const current = isCurrentDestination(destination.href, pathname);
              return (
                <li className="prl-sheet__item" key={destination.href}>
                  <Link
                    aria-current={current ? 'page' : undefined}
                    className="prl-sheet__link"
                    href={destination.href}
                    onClick={close}
                  >
                    <span aria-hidden="true" className="prl-sheet__index prl-index">
                      {formatIndex(position + 1)}
                    </span>
                    <span className="prl-sheet__label">{destination.label}</span>
                    <span className="prl-sheet__summary">{destination.summary}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        {/* The theme control's narrow-viewport home. Labelled, because a bare three-word switch at
            the foot of a menu is a control whose subject the reader has to infer — and it is the
            same wording the footer uses for the same control, so the two read as one thing in two
            places rather than as two controls. */}
        <div className="prl-sheet__foot">
          <p className="prl-sheet__title prl-label">Appearance</p>
          <ThemeToggle />
        </div>
      </div>
    </>
  );
}

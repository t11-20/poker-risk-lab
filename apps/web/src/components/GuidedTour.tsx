'use client';

/**
 * The guided tour: five steps from picking a scenario to reviewing a hand, each with a "Show me" that
 * outlines its `[data-tour]` target, going to its page first if need be. A panel in the page's flow
 * under the header, not an overlay: it covers nothing, traps nothing, and a page under test on a fresh
 * profile stays usable with it open. Escape closes it and focus goes back to "How to use".
 *
 * It renders nothing until the effect has read storage, as `Onboarding` does, so the server render and
 * every return visit are the page alone. State lives in `tourStore` (`lib/tour.ts`) so the header's
 * button reaches it. "Show me" navigates with the router, so the panel survives the trip; a full page
 * load from an ordinary link starts it closed again.
 */

import { formatIndex } from '@prl/ui';
import { usePathname, useRouter } from 'next/navigation';
import {
  type ReactElement,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useRef,
  useSyncExternalStore,
} from 'react';
import {
  closeTour,
  INITIAL_TOUR_STATE,
  opensByItself,
  readTourDismissal,
  TOUR_STEPS,
  type TourStep,
  tourStep,
  tourStore,
} from '@/lib/tour.ts';

/** On the root, so the outline is a stylesheet rule and no server-rendered node is restyled. */
const SHOWING_ATTRIBUTE = 'data-tour-showing';

const storage = (): Storage => window.localStorage;

/** The visible "How to use" button: the header's above 860px, else the Menu trigger it lives behind. */
function focusReturnTarget(): HTMLElement | null {
  const openers = Array.from(document.querySelectorAll<HTMLElement>('[data-tour-opener]'));
  const visible = openers.find((element) => element.getClientRects().length > 0);
  return visible ?? document.querySelector<HTMLElement>('.prl-nav-trigger');
}

export function GuidedTour(): ReactElement | null {
  const state = useSyncExternalStore(tourStore.subscribe, tourStore.getSnapshot, () => INITIAL_TOUR_STATE);
  const pathname = usePathname();
  const router = useRouter();
  const panelRef = useRef<HTMLElement | null>(null);
  const seenPath = useRef<string | null>(null);

  useEffect(() => {
    if (seenPath.current !== null && seenPath.current !== pathname) {
      tourStore.dispatch({ type: 'navigated', pathname });
    }
    seenPath.current = pathname;
    const { settled } = tourStore.getSnapshot();
    if (opensByItself(pathname, readTourDismissal(storage), settled, window.location.hash !== '')) {
      tourStore.dispatch({ type: 'open-first-visit' });
    }
  }, [pathname]);

  useEffect(() => {
    if (state.focusRequest === 0 || !state.open) return;
    panelRef.current?.focus();
  }, [state.focusRequest, state.open]);

  const { open, step, awaiting, shown } = state;
  useEffect(() => {
    if (!open || step === null || awaiting !== null || shown === 0) return;
    const root = document.documentElement;
    const selector = `[data-tour="${step}"]`;
    const added: { node: HTMLElement | null } = { node: null };

    const reveal = (target: HTMLElement): void => {
      root.setAttribute(SHOWING_ATTRIBUTE, step);
      // Like a skip link, so the next Tab continues from the part being shown.
      if (!target.hasAttribute('tabindex')) {
        target.setAttribute('tabindex', '-1');
        added.node = target;
      }
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: 'start' });
      tourStore.dispatch({ type: 'found', step });
    };

    const present = document.querySelector<HTMLElement>(selector);
    // Watched, because a page can draw its part after the panel asked for it.
    const observer = new MutationObserver(() => {
      const late = document.querySelector<HTMLElement>(selector);
      if (late === null) return;
      observer.disconnect();
      reveal(late);
    });
    if (present === null) {
      tourStore.dispatch({ type: 'missing', step });
      observer.observe(document.body, { childList: true, subtree: true });
    } else {
      reveal(present);
    }
    return () => {
      observer.disconnect();
      root.removeAttribute(SHOWING_ATTRIBUTE);
      added.node?.removeAttribute('tabindex');
    };
  }, [open, step, awaiting, shown]);

  if (!state.open) return null;

  const close = (): void => {
    const hadFocus = panelRef.current?.contains(document.activeElement) ?? false;
    closeTour(tourStore, storage);
    // The button is in the sticky header, so a plain focus would scroll the page to "reveal" it.
    if (hadFocus) focusReturnTarget()?.focus({ preventScroll: true });
  };

  const showMe = (target: TourStep): void => {
    if (document.querySelector(`[data-tour="${target.id}"]`) !== null) {
      tourStore.dispatch({ type: 'show', step: target.id, awaiting: null });
      return;
    }
    if (target.href !== null && target.href !== pathname) {
      tourStore.dispatch({ type: 'show', step: target.id, awaiting: target.href });
      router.push(target.href);
      return;
    }
    tourStore.dispatch({ type: 'show', step: target.id, awaiting: null });
  };

  /** On the panel, not the document, so an Escape meant for a tip or the units note stays theirs. */
  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    close();
  };

  const current = state.step === null ? null : tourStep(state.step);
  const status =
    current === null || state.found === null
      ? ''
      : state.found === 'shown'
        ? `Showing: ${current.title}.`
        : current.missing;
  const skipping = state.opener === 'first-visit';

  return (
    // A named region rather than a heading, so no heading comes before the page's own `h1`.
    <section
      aria-label="How to use"
      className="prl-container prl-tour"
      onKeyDown={onKeyDown}
      ref={panelRef}
      tabIndex={-1}
    >
      <div className="prl-tour__head">
        <p className="prl-tour__title">How to use the Lab</p>
        <button className="prl-btn prl-btn--ghost prl-btn--sm prl-tour__close" onClick={close} type="button">
          {skipping ? 'Skip' : 'Close'}
          <span className="prl-visually-hidden"> the guide</span>
        </button>
      </div>
      <ol className="prl-tour__steps">
        {TOUR_STEPS.map((entry, index) => {
          const showing = state.step === entry.id;
          return (
            <li className="prl-tour__step" data-showing={showing ? 'true' : undefined} key={entry.id}>
              <span aria-hidden="true" className="prl-tour__index">
                {formatIndex(index + 1)}
              </span>
              <span className="prl-tour__step-title">{entry.title}</span>
              {/* The link runs on after the sentence, so a step is two lines on a phone, not three. */}
              <span className="prl-tour__step-text">
                {`${entry.text} `}
                <button className="prl-tour__show" onClick={() => showMe(entry)} type="button">
                  Show me
                  <span className="prl-visually-hidden">{`: ${entry.title}`}</span>
                </button>
              </span>
              {showing && state.found === 'missing' ? (
                <span className="prl-tour__missing">{entry.missing}</span>
              ) : null}
            </li>
          );
        })}
      </ol>
      <p className="prl-visually-hidden" role="status">
        {status}
      </p>
    </section>
  );
}

'use client';

/**
 * "This is loading", said on the page the reader pressed something on.
 *
 * `lib/navigation-pending.ts` has the measurements, the reason this is not a `loading.tsx`, and the
 * decisions themselves. What is here is the wiring, and three choices in it:
 *
 *  - **One listener for the whole app**, on `window`, rather than a component inside each slow link.
 *    The links into the slow routes are in five files, two of them plain anchors the router never
 *    sees, and the next slow route would need somebody to remember. `window` rather than `document`
 *    because a bubbling listener there runs after React's own on the document, so `defaultPrevented`
 *    already says whether `Link` took the press.
 *  - **Withdrawn when the URL the shell renders changes**, pathname or query, which is the router's
 *    navigation landing; on `pageshow`, because a document restored from the back-forward cache
 *    comes back with whatever it was showing when it was left; and after `PENDING_CEILING_MS`
 *    regardless. The query is in it because the age gate answers a router press with a redirect
 *    that can change only the query (`/age-check` to `/age-check?next=/play`), and a pathname-only
 *    key left the message up for the whole ceiling (Devin on PR #35). A redirect to the URL already
 *    shown changes nothing at all, so `shouldShowPending` does not start the message for one.
 *  - **A polite status region that is always in the tree and empty at rest.** A live region that
 *    arrives already holding its text is announced by nothing, and an empty one says nothing. It is
 *    not the route announcer and does not repeat it: this says a press was taken, the announcer says
 *    where it landed.
 *
 * The pill is fixed below the bar, so showing it moves nothing on the page; its fade is gated on
 * `prefers-reduced-motion: no-preference` in `nav.css`.
 */

import { useSearchParams } from 'next/navigation';
import { type ReactElement, useEffect, useRef, useState } from 'react';
import {
  formDestination,
  PENDING_CEILING_MS,
  PENDING_DELAY_MS,
  pendingMessage,
  shouldShowPending,
} from '@/lib/navigation-pending.ts';

export interface NavigationPendingProps {
  readonly pathname: string;
}

export function NavigationPending({ pathname }: NavigationPendingProps): ReactElement {
  const [message, setMessage] = useState<string | null>(null);
  const timers = useRef<{ show?: number; ceiling?: number }>({});

  // A changed URL is the router's navigation landing, which is when the message must go. The
  // comparison is what makes `landed` a real dependency rather than a trigger nothing reads.
  const search = useSearchParams();
  const landed = `${pathname}?${search.toString()}`;
  const seenLanding = useRef(landed);
  useEffect(() => {
    if (seenLanding.current === landed) return;
    seenLanding.current = landed;
    window.clearTimeout(timers.current.show);
    window.clearTimeout(timers.current.ceiling);
    setMessage(null);
  }, [landed]);

  useEffect(() => {
    const clear = (): void => {
      window.clearTimeout(timers.current.show);
      window.clearTimeout(timers.current.ceiling);
      setMessage(null);
    };
    const start = (destination: URL, documentLoad: boolean): void => {
      const current = new URL(window.location.href);
      if (!shouldShowPending({ destination, current, documentLoad })) return;
      clear();
      const sentence = pendingMessage(destination.pathname);
      timers.current.show = window.setTimeout(() => setMessage(sentence), PENDING_DELAY_MS);
      timers.current.ceiling = window.setTimeout(clear, PENDING_CEILING_MS);
    };

    const onClick = (event: MouseEvent): void => {
      // A press that opens a new tab or window, or saves the target, leaves this page where it is.
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if ((anchor.target !== '' && anchor.target !== '_self') || anchor.hasAttribute('download')) return;
      start(new URL(anchor.href), !event.defaultPrevented);
    };

    const onSubmit = (event: SubmitEvent): void => {
      // Only a GET form is a navigation. A POST form here is a mutation sent by script (deletion,
      // reset), and it says its own "working" in its own words.
      const form = event.target;
      if (!(form instanceof HTMLFormElement) || event.defaultPrevented) return;
      if (form.method.toLowerCase() !== 'get' || (form.target !== '' && form.target !== '_self')) return;
      // The attribute, not `form.action`: a control named "action" shadows the property.
      const action = form.getAttribute('action') ?? '';
      start(formDestination(action, window.location.href, new FormData(form).entries()), true);
    };

    const onPageShow = (event: PageTransitionEvent): void => {
      if (event.persisted) clear();
    };

    window.addEventListener('click', onClick);
    window.addEventListener('submit', onSubmit);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      window.removeEventListener('click', onClick);
      window.removeEventListener('submit', onSubmit);
      window.removeEventListener('pageshow', onPageShow);
      clear();
    };
  }, []);

  return (
    <div className="prl-pending" role="status">
      {message === null ? null : <p className="prl-pending__pill">{message}</p>}
    </div>
  );
}

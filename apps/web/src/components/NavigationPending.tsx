'use client';

/**
 * The "this is loading" pill on the page the reader pressed something on. The reasoning is in
 * `lib/navigation-pending.ts`. One listener on `window`, so it runs after React's document listener
 * and `defaultPrevented` says whether `Link` took the press. Withdrawn when pathname or query lands
 * (the age gate can redirect by query alone), on a bfcache `pageshow`, and at `PENDING_CEILING_MS`.
 * The status region is always present and empty at rest, so its text is announced.
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
      // Only a GET form navigates. Script-sent POST forms report their own progress.
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

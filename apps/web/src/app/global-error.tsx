'use client';

/**
 * The last boundary: what is on screen when the app shell itself failed to render.
 *
 * ## Why this file had to exist
 *
 * `app/error.tsx` catches a failure inside a route. It cannot catch a failure in the root layout,
 * because it is rendered *by* that layout — and its own comment has said so for as long as it has
 * existed: "a failure in the shell itself falls through to `global-error.tsx`, which renders its OWN
 * document ... That file is not part of this change." It was never written, so the fallback was
 * Next's built-in default: an unstyled white page reading "Application error: a client-side
 * exception has occurred", in a document with no `lang`, no viewport meta, no heading structure and
 * nothing to do next. On a dark-themed app that is also a full-screen white flash.
 *
 * ## Everything here is a `style` ATTRIBUTE, and that is a CSP constraint rather than a preference
 *
 * This component replaces the whole document, so it gets neither `@prl/ui/styles.css` nor
 * `globals.css` and none of the `prl-*` classes resolve. The obvious substitute — one `<style>`
 * element in the document — is **blocked by this app's own policy**: `src/lib/csp.ts` ships
 * `style-src 'self'` with no `'unsafe-inline'` and no nonce entry, deliberately, so an injected
 * `<style>` cannot run. A stylesheet written here would be refused by the browser and the page would
 * render unstyled anyway, which is the exact failure this file exists to remove. What the policy
 * does allow is `style-src-attr 'unsafe-inline'`, because the design system passes custom properties
 * through the `style` attribute. So every value below is an inline style object, and that is the
 * only spelling that actually paints.
 *
 * ## Theming without the token system: CSS system colours
 *
 * `color-scheme: light dark` plus `Canvas`, `CanvasText`, `ButtonFace`, `ButtonText`, `ButtonBorder`
 * and `GrayText` means this document follows the reader's operating system in both directions, and
 * is correct under Windows High Contrast without a `forced-colors` block, because those keywords ARE
 * the forced palette. It does not match the app's slate-and-accent ramp, and it cannot: the token
 * file is a stylesheet this document does not have.
 *
 * What is genuinely lost is the reader's explicit choice. `THEME_BOOT_SCRIPT` resolves
 * `localStorage` before first paint, and there is no script here to run it — an inline script would
 * need the per-response nonce, which is read through `next/headers` in a server component, and this
 * is a client component by definition. A reader whose system is dark and who chose light gets dark
 * on this one screen. That is the honest trade against a page that cannot be styled at all.
 *
 * ## Announcement, and why this differs from `error.tsx`
 *
 * `error.tsx` deliberately does not use `role="alert"`, on the grounds that a whole-page replacement
 * is announced by the navigation that caused it. That reasoning does not carry here. This boundary
 * replaces the ROOT, so it takes `RouteAnnouncer` and the whole shell with it, and it is reached by
 * a render failure rather than by a navigation — nothing announces anything. The heading and the one
 * explanatory sentence are therefore inside a `role="alert"`, which fires because the node is
 * inserted rather than because its text changed. The controls are outside it, so the alert is a
 * message and not a menu read aloud.
 *
 * Focus is still not moved, for the same reason `error.tsx` gives: the reader did not ask to come
 * here, and the alert has already said what happened.
 *
 * ## What is on screen, and what is not
 *
 * Not the exception, and not `error.message`. In production that string is a digest-shaped token with
 * no meaning to a reader; in development it is an internal detail. `error.digest` is shown when Next
 * supplies one and is not an exception detail at all — it is the correlation token Next generates
 * *instead of* the message, and it is the only way a reader can hand a bug report something a server
 * log line can be found by. The same reasoning, and the same wording, as `error.tsx`.
 *
 * `<a href="/">` rather than `next/link`: the router is part of what has just failed, so the way out
 * has to be a real document load. It is also why the second control is a link and not a button.
 *
 * Remove this file and every root-layout failure goes back to Next's unstyled default page, with no
 * `lang`, no viewport meta and nothing announced.
 */

import type { CSSProperties, ReactElement } from 'react';

/**
 * The palette, as CSS system colours.
 *
 * Named rather than repeated inline so the two surfaces cannot drift apart, and so the reason for
 * each keyword is written once. Every one of these is a CSS Color 4 system colour: they resolve
 * against `color-scheme` in a normal render and against the user's own palette under
 * `forced-colors: active`.
 */
const PAGE: CSSProperties = {
  colorScheme: 'light dark',
  backgroundColor: 'Canvas',
  color: 'CanvasText',
};

const BODY: CSSProperties = {
  ...PAGE,
  margin: 0,
  padding: '3rem 1.25rem',
  // A system stack, because there is no font to load and the CSP has no host to load one from.
  fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  fontSize: '1rem',
  // 1.5 rather than the browser default, which is the WCAG 1.4.12 floor for body text.
  lineHeight: 1.5,
};

/** One measure-limited column, so the prose does not run the width of a desktop display. */
const COLUMN: CSSProperties = {
  maxWidth: '38rem',
  margin: '0 auto',
  display: 'flex',
  flexDirection: 'column',
  gap: '1.25rem',
};

/** The alert's own stack. Not `COLUMN`: a second measure inside the first constrains nothing twice. */
const MESSAGE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '1.25rem',
};

const HEADING: CSSProperties = {
  margin: 0,
  fontSize: '1.75rem',
  lineHeight: 1.2,
  fontWeight: 600,
};

const ROW: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '0.75rem',
};

/**
 * Both controls are the same size and the same shape.
 *
 * `minHeight: 44px` is the app's own `--prl-target-min`, restated as a literal because the token is
 * in a stylesheet this document does not have. The border is what distinguishes a control from the
 * prose around it, so neither one depends on colour alone.
 */
const CONTROL: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  minHeight: '44px',
  padding: '0 1rem',
  border: '1px solid ButtonBorder',
  borderRadius: '4px',
  backgroundColor: 'ButtonFace',
  color: 'ButtonText',
  font: 'inherit',
  textDecoration: 'none',
  cursor: 'pointer',
};

const NOTE: CSSProperties = {
  margin: 0,
  color: 'GrayText',
  fontSize: '0.875rem',
};

const PROSE: CSSProperties = { margin: 0 };

export interface GlobalErrorProps {
  readonly error: Error & { readonly digest?: string };
  /** Re-fetches and re-renders, rather than re-rendering what already failed. See `app/error.tsx`. */
  readonly retry: () => void;
}

export default function GlobalError(props: GlobalErrorProps): ReactElement {
  const { error, retry } = props;

  return (
    <html lang="en" style={PAGE}>
      <body style={BODY}>
        {/*
          Both are rendered inside `<body>` and hoisted into `<head>` by React. They are here rather
          than in a `<head>` this component writes itself because the document is being replaced
          mid-flight and owning `<head>` would mean owning everything already in it.

          The viewport meta is not decoration: without it a mobile browser lays this page out at
          980px and scales it down, so the message arrives at about a third of the reader's chosen
          text size. It carries no `maximum-scale` and no `user-scalable`, for the reason stated in
          the root layout.
        */}
        <title>Something went wrong — Poker Risk Lab</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />

        <main style={COLUMN}>
          <div role="alert" style={MESSAGE}>
            <h1 style={HEADING}>The application could not be displayed</h1>
            <p style={PROSE}>
              Something failed in the part of this app that draws every page, so there is nothing left on
              screen to fall back to. Nothing you were doing has been lost: the units are free and resettable,
              and no hand state is changed by a failed render.
            </p>
          </div>

          <div style={ROW}>
            <button onClick={() => retry()} style={CONTROL} type="button">
              Try again
            </button>
            <a href="/" style={CONTROL}>
              Reload the home page
            </a>
          </div>

          {/* Only when Next supplied one. A "reference: undefined" line is worse than no reference,
              because a reader will quote it into a bug report. */}
          {error.digest === undefined ? null : (
            <p style={NOTE}>
              {'Reference for a bug report: '}
              <code>{error.digest}</code>
            </p>
          )}

          <p style={NOTE}>
            This is the fallback screen. It is deliberately plain — the stylesheet that themes the rest of the
            app is part of what failed to load.
          </p>
        </main>
      </body>
    </html>
  );
}

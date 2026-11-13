'use client';

/**
 * The boundary for a failure in the root layout, which replaces the whole document. Without it Next
 * shows an unstyled white page with no `lang` or viewport. Every style is an inline attribute because
 * the CSP allows `style-src-attr 'unsafe-inline'` but blocks a `<style>` element. CSS system colours
 * follow the OS theme and forced colours. The stored theme choice is lost, because an inline script
 * would need a nonce a client component cannot read. `role="alert"` because nothing else announces a
 * root failure. Focus is not moved. `<a href="/">`, not `next/link`, because the router may be broken.
 */

import type { CSSProperties, ReactElement } from 'react';

const PAGE: CSSProperties = {
  colorScheme: 'light dark',
  backgroundColor: 'Canvas',
  color: 'CanvasText',
};

const BODY: CSSProperties = {
  ...PAGE,
  margin: 0,
  padding: '3rem 1.25rem',
  fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  fontSize: '1rem',
  // The WCAG 1.4.12 floor for body text.
  lineHeight: 1.5,
};

const COLUMN: CSSProperties = {
  maxWidth: '38rem',
  margin: '0 auto',
  display: 'flex',
  flexDirection: 'column',
  gap: '1.25rem',
};

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

/** `44px` restates `--prl-target-min`, which is not loaded here. The border avoids colour alone. */
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
  /** Re-fetches and re-renders. See `app/error.tsx`. */
  readonly retry: () => void;
}

export default function GlobalError(props: GlobalErrorProps): ReactElement {
  const { error, retry } = props;

  return (
    <html lang="en" style={PAGE}>
      <body style={BODY}>
        {/*
          React hoists both into `<head>`. Without the viewport meta a phone lays this out at 980px
          and the text shrinks to a third.
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

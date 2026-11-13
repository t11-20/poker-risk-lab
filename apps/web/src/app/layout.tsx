/**
 * The root layout. `@prl/ui/styles.css` is imported first so tokens precede every route's CSS.
 * `THEME_BOOT_SCRIPT` is the only inline script. It is the first child of `<body>` so the stored theme
 * and boot flag land before first paint. CSP allows it by nonce and by hash. It edits `<html>` before
 * React hydrates, hence `suppressHydrationWarning`. `RouteAnnouncer` sits above every route so it
 * outlives navigations, and outside the skip link's target. `data-theme` is not written here, because
 * its absence means "follow the system".
 */

// Self-hosted and served from this origin (`font-src 'self'`).
import '@fontsource-variable/archivo/wdth.css';
import '@prl/ui/styles.css';
import './globals.css';
import '@/styles/nav.css';

import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import type { ReactElement, ReactNode } from 'react';
import { BootSequence } from '@/components/BootSequence.tsx';
import { RouteAnnouncer } from '@/components/RouteAnnouncer.tsx';
import { SiteFooter } from '@/components/SiteFooter.tsx';
import { SiteHeader } from '@/components/SiteHeader.tsx';
import { STARTING_UNITS } from '@/fixtures/session.ts';
import { THEME_BOOT_SCRIPT } from '@/lib/theme.ts';

export const MAIN_ID = 'prl-main';

export const metadata: Metadata = {
  title: {
    default: 'Poker Risk Lab',
    template: '%s — Poker Risk Lab',
  },
  description:
    'An educational play-money No-Limit Hold’em lab for probability, expected value, risk and ' +
    'variance. Chips are free, resettable units with no value. There is no real money in this app.',
  applicationName: 'Poker Risk Lab',
  robots: { index: false, follow: false },
};

/** No `maximum-scale` or `user-scalable`, because pinning either fails WCAG 1.4.4. */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default async function RootLayout({
  children,
}: {
  readonly children: ReactNode;
}): Promise<ReactElement> {
  // Set by `src/proxy.ts`. If absent, the script is still allowed by its hash in the policy.
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <script nonce={nonce}>{THEME_BOOT_SCRIPT}</script>
        <a className="prl-skip-link" href={`#${MAIN_ID}`}>
          Skip to main content
        </a>
        <BootSequence />
        <RouteAnnouncer />
        <div className="prl-app">
          <SiteHeader fallbackUnits={STARTING_UNITS} />
          {/*
            `tabIndex={-1}` makes the skip link move focus, not only the navigation starting point
            (found by `scripts/keyboard-audit.mjs`). `-1`, so it adds no tab stop.
          */}
          <main className="prl-app__main" id={MAIN_ID} tabIndex={-1}>
            {children}
          </main>
          <SiteFooter />
        </div>
      </body>
    </html>
  );
}

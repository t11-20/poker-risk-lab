/**
 * The root layout: the document, the stylesheet order, the shell, and the one inline script.
 *
 * ## Why the stylesheet is imported here, first
 *
 * `@prl/ui/styles.css` is one file that `@import`s tokens, reset, base and components in a fixed
 * order (see that file's comment — the order is load-bearing). Importing it from the root layout
 * puts it above every route's CSS in the cascade, so a route can never be styled before the tokens
 * exist. `globals.css` follows it and holds app-shell rules only.
 *
 * Both are JS imports rather than an `@import` inside `globals.css`. Both work; this is the one
 * that cannot go wrong, because it does not depend on how the CSS pipeline resolves a bare package
 * specifier through an `exports` map, and because the order is then visible on two adjacent lines
 * rather than inferred.
 *
 * ## The inline script, and why there is exactly one
 *
 * `THEME_BOOT_SCRIPT` is the only inline script in the app. It resolves two things that CSS cannot
 * see and React cannot see early enough:
 *
 *  - the reader's stored theme choice, from `localStorage`, applied to `<html data-theme>`;
 *  - whether the boot sequence has already played this session, from `sessionStorage`, applied as
 *    `<html data-boot="skip">`.
 *
 * Both have to be settled BEFORE first paint. Anything React-based — a provider, an effect, a
 * store — runs after hydration, which is after paint, so a reader whose system is dark and whose
 * choice is light would watch the page flash from one to the other. That is not polish: it is a
 * full-screen luminance change fired at somebody who explicitly asked for the other one.
 *
 * It is the FIRST child of `<body>`, where a synchronous script blocks parsing before any
 * renderable content exists — so there is nothing on screen to flash. It is written as `<script>`
 * with a string child rather than `dangerouslySetInnerHTML`: React does not escape script children,
 * so the two emit identical bytes, and only one of them trips the security lint rule that exists to
 * catch actual HTML injection.
 *
 * `suppressHydrationWarning` on `<html>` is required and is not a shortcut: the script mutates
 * that element's attributes before React arrives, so the server's markup and the live DOM
 * legitimately differ. The warning is suppressed on the one element where the difference is the
 * intended behaviour, and nowhere else.
 *
 * CSP: the script is allowed twice over, and both are now actually served rather than merely
 * documented. `src/proxy.ts` puts a per-response nonce in `script-src` and this layout reads
 * it back through `next/headers` onto the tag; `src/lib/csp.ts` also lists
 * `THEME_BOOT_SCRIPT_CSP_HASH`, so the exact bytes are permitted even if the nonce plumbing ever
 * breaks. `test/theme-csp-hash.test.ts` recomputes the hash over `THEME_BOOT_SCRIPT`, so it cannot
 * go stale without a test failing.
 *
 * Reading `headers()` makes this layout dynamic, which it already was — every page under it reads
 * the session cookie — so nothing that was static became dynamic to get a policy.
 *
 * ## The shell, the skip link, and the one `main`
 *
 * The skip link is the first focusable node in the document, invisible until focused
 * (`.prl-skip-link` in base.css), and it points at the `<main>` this layout owns. One `main` for the
 * whole app means `landmark-one-main` cannot be broken by a route, and routes own their single `h1`.
 *
 * `BootSequence` sits outside the shell because it is a fixed overlay above it, and it is rendered
 * on the server on purpose: an overlay that mounts on the client fades IN over a shell the reader
 * can already read, which is worse than no overlay at all.
 *
 * ## Why `data-theme` is not written here
 *
 * `tokens.css` has three theme states and the third is the default: an explicit `data-theme` wins,
 * and *absence* means "follow the system", which `@media (prefers-color-scheme)` resolves. Hard-
 * coding `data-theme="dark"` would make the light theme unreachable — including for the reviewer
 * who has to check all four dark/light × motion-on/off combinations. Dark is still the designed
 * default, because the tokens declare the dark palette on bare `:root`.
 *
 * No font link, no preconnect, no analytics: the CSP has no host for any of them and the design
 * system forbids remote assets outright.
 */

import '@prl/ui/styles.css';
import './globals.css';
// The floating pill bar. After `globals.css` because it reshapes the shell that file frames; every
// rule in it wins on specificity rather than on this order, so the order is a convenience.
import '@/styles/nav.css';

import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import type { ReactElement, ReactNode } from 'react';
import { BootSequence } from '@/components/BootSequence.tsx';
import { SiteFooter } from '@/components/SiteFooter.tsx';
import { SiteHeader } from '@/components/SiteHeader.tsx';
import { STARTING_UNITS } from '@/fixtures/session.ts';
import { THEME_BOOT_SCRIPT } from '@/lib/theme.ts';

/** The id the skip link targets. Exported so a route can never guess it wrong. */
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

/**
 * `maximum-scale` and `user-scalable` are left alone on purpose: pinning either of them is the
 * WCAG 1.4.4 failure that `meta-viewport` exists to catch.
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default async function RootLayout({
  children,
}: {
  readonly children: ReactNode;
}): Promise<ReactElement> {
  // Set by `src/proxy.ts` on the forwarded request, alongside the policy itself. Absent only
  // if this render somehow bypassed the middleware, in which case the tag carries no nonce and the
  // script is allowed by its hash instead — which is exactly why the hash is in the policy too.
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <script nonce={nonce}>{THEME_BOOT_SCRIPT}</script>
        <a className="prl-skip-link" href={`#${MAIN_ID}`}>
          Skip to main content
        </a>
        <BootSequence />
        <div className="prl-app">
          <SiteHeader fallbackUnits={STARTING_UNITS} />
          {/*
            `tabIndex={-1}` is what makes the skip link actually skip.

            Found by `scripts/keyboard-audit.mjs`, pressing Enter on the skip link in a real
            browser: without it, activating the link set `location.hash` and moved the *sequential
            focus navigation starting point*, but left `document.activeElement` on the link itself.
            Chrome and Firefox honour that starting point so the next Tab does continue from here —
            which is why it looked fine — but the focus ring stays behind at the top of the page,
            a screen reader is not moved, and browsers that do not implement the starting point (or
            a page that programmatically reads focus) get nothing at all.

            `-1` and not `0`: this makes `<main>` focusable by SCRIPT and by a fragment link, and
            deliberately does not put it in the tab order, where it would be a stop that does
            nothing on the way to every page's real first control.
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

/**
 * The Content-Security-Policy on every HTML response. This app has no third-party origin, so every
 * directive is `'self'` or `'none'` unless a comment says why not.
 * RSC streams its payload in inline scripts that differ per render, so `script-src` needs the
 * per-response nonce from `src/proxy.ts`. A hash-only policy leaves the page unhydrated. The theme
 * script's hash rides alongside, pinning that one script to its exact bytes.
 * Style attributes carry custom properties and cannot take a nonce, so `style-src-attr` allows inline.
 * `style-src` stays `'self'`, and with no remote host crafted CSS has nowhere to send data.
 * Development adds `'unsafe-eval'`, the HMR socket and inline dev-overlay styles, and
 * `test/csp-policy.test.ts` holds production free of them.
 */

import { THEME_BOOT_SCRIPT_CSP_HASH } from './theme.ts';

export interface CspOptions {
  /** The per-response nonce, unquoted and base64. `src/proxy.ts` generates it. */
  readonly nonce: string;
  /** True only under `next dev`. Adds the allowances `next dev` cannot run without. */
  readonly development?: boolean;
}

const FIXED_DIRECTIVES: readonly string[] = [
  // `'self'`, not `'none'`, so a directive the platform adds later fails closed at this origin.
  "default-src 'self'",
  // Nothing is embedded and nothing embeds this app.
  "frame-ancestors 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  // An injected `<base>` would re-target every relative URL, including the session-carrying API calls.
  "base-uri 'none'",
  "form-action 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "manifest-src 'self'",
  "media-src 'none'",
  "worker-src 'self'",
  // Next stamps the nonce on stylesheet links, so a nonce entry is deliberately absent.
  "style-src 'self'",
  "style-src-attr 'unsafe-inline'",
];

/** The one fixed directive development widens. Named so the replacement cannot silently miss. */
const DEV_STYLE_SRC_REPLACES = "style-src 'self'";

export function contentSecurityPolicy(options: CspOptions): string {
  const development = options.development ?? false;

  const script = [
    // The host allowance for CSP Level 2 clients. Level 3 ignores it under `'strict-dynamic'`.
    "script-src 'self'",
    `'nonce-${options.nonce}'`,
    `'${THEME_BOOT_SCRIPT_CSP_HASH}'`,
    // Safe because Next stamps the nonce on every tag it emits, which `scripts/smoke-test.mjs`
    // section 10 checks against a running server.
    "'strict-dynamic'",
    // React Refresh evaluates the modules it swaps in. Only ever under `next dev`.
    ...(development ? ["'unsafe-eval'"] : []),
  ].join(' ');

  // `src/lib/api.ts` uses relative paths and the table socket is same-host. `'self'` matches a
  // same-origin websocket under CSP Level 3.
  const connect = [
    "connect-src 'self'",
    // HMR on :3000 and the API on :3001, under both hostnames in `allowedDevOrigins`.
    ...(development
      ? ['ws://localhost:3000', 'ws://127.0.0.1:3000', 'http://localhost:3001', 'http://127.0.0.1:3001']
      : []),
  ].join(' ');

  return [
    // Next's dev overlay injects `<style>` elements without a nonce, and `'self'` alone logged 333 CSP
    // errors on a fresh `pnpm run dev`. Development only.
    ...FIXED_DIRECTIVES.map((directive) =>
      development && directive === DEV_STYLE_SRC_REPLACES ? "style-src 'self' 'unsafe-inline'" : directive,
    ),
    script,
    connect,
    // Production only. Over plain-http dev it would rewrite every request to https and break the app.
    ...(development ? [] : ['upgrade-insecure-requests']),
  ].join('; ');
}

/** The header name, so no call site spells it. */
export const CSP_HEADER = 'Content-Security-Policy';

/**
 * Headers the CSP cannot express. `Referrer-Policy` keeps room and hand ids out of Referer, and
 * `X-Frame-Options` duplicates `frame-ancestors` for clients older than CSP Level 2.
 */
export const SECURITY_HEADERS: readonly (readonly [string, string])[] = [
  ['X-Content-Type-Options', 'nosniff'],
  ['Referrer-Policy', 'same-origin'],
  ['X-Frame-Options', 'DENY'],
  ['Cross-Origin-Opener-Policy', 'same-origin'],
];

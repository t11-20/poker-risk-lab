/**
 * The Content-Security-Policy this app serves on every HTML response.
 *
 * ## Why this file exists
 *
 * `THEME_BOOT_SCRIPT_CSP_HASH` has been in `src/lib/theme.ts` for a long time, with a comment
 * telling an operator to put it in a `script-src`. Nothing ever did. `next.config.ts` had no
 * `headers()`, there was no middleware, and the reverse proxy in `docker-compose.yml` sets none
 * either — so the page origin shipped with NO policy at all. A carefully computed hash that is
 * never placed on a response is not a control; it is a comment that reads like one, which is
 * worse than nothing because it makes the gap invisible to anyone skimming for a CSP.
 *
 * A CSP is the one control that limits what an injected `<script>` can do on a page that serves a
 * live table and a session cookie. This app has no third-party origin of any kind — no CDN, no
 * analytics, no font host, no remote image (`next.config.ts` and the design system both say so) —
 * so the policy can be as tight as a policy gets, and every directive below is `'self'` or
 * `'none'` unless there is a stated reason it cannot be.
 *
 * ## Nonce, not hash-only, and why the hash is still here
 *
 * The obvious reading of the old comment is "put the hash in `script-src` and be done". That does
 * not work, and it is worth writing down why so nobody tries it again: React Server Components
 * stream their payload to the browser inside inline `<script>self.__next_f.push(...)</script>`
 * tags. Their contents differ per page and per render, so they cannot be hashed at build time. A
 * hash-only `script-src` blocks them, and a Next app whose flight payload is blocked renders the
 * server HTML and then never hydrates — every control on the page is dead, with nothing on screen
 * to say why.
 *
 * So the policy carries a per-response nonce, generated in `src/proxy.ts`. Next reads it off
 * the REQUEST's `content-security-policy` header and stamps it on the script tags it emits; the
 * root layout stamps the same nonce on the theme boot script.
 *
 * The hash is kept alongside the nonce, and that is deliberate belt-and-braces rather than
 * redundancy: it pins the theme script to its exact bytes. If the nonce plumbing ever breaks, the
 * theme script still runs and the page still resolves its theme before paint; if somebody edits
 * `THEME_BOOT_SCRIPT` without regenerating the hash, `test/theme-csp-hash.test.ts` fails. Two
 * independent reasons that one script is allowed, and no reason at all for any other.
 *
 * ## `style-src-attr 'unsafe-inline'`, stated rather than buried
 *
 * The design system passes CSS custom properties through the `style` attribute — `--prl-fill`,
 * `--prl-segment-share`, the seat ring positions. A style ATTRIBUTE cannot carry a nonce (there
 * is nowhere to put one) and cannot be hashed per render, so allowing them means
 * `style-src-attr 'unsafe-inline'`. That is a real widening and it is confined to exactly one
 * directive: `style-src` itself stays `'self'`, so no `<style>` element an injection creates will
 * run. The threat an inline style attribute presents is data exfiltration through crafted CSS,
 * which needs an outbound origin — and `default-src 'self'` with no remote host anywhere in this
 * policy is what closes that.
 *
 * ## Development is a separate policy, not a hole in this one
 *
 * `next dev` needs `'unsafe-eval'` (React Refresh compiles modules at runtime) and a websocket to
 * the dev server for HMR. Both are added ONLY when `development` is true, and
 * `test/csp-policy.test.ts` asserts that the production policy contains neither `unsafe-eval` nor
 * `unsafe-inline` in `script-src`, so a development convenience cannot quietly become the shipped
 * policy. The two are built by the same function so they cannot drift structurally.
 */

import { THEME_BOOT_SCRIPT_CSP_HASH } from './theme.ts';

export interface CspOptions {
  /** The per-response nonce, unquoted and base64. `src/proxy.ts` generates it. */
  readonly nonce: string;
  /** True only under `next dev`. Adds the two allowances HMR cannot run without. */
  readonly development?: boolean;
}

/**
 * Directives that never vary.
 *
 * `frame-ancestors 'none'` is the clickjacking control and is deliberately here rather than in an
 * `X-Frame-Options` header: the two say the same thing and only this one is honoured everywhere
 * that matters. `X-Frame-Options` is still emitted beside it in `src/proxy.ts` for the sake
 * of anything ancient enough to ignore CSP.
 */
const FIXED_DIRECTIVES: readonly string[] = [
  // Everything not named below. `'self'` rather than `'none'` so a directive added to the platform
  // tomorrow fails closed at the app's own origin rather than closed entirely.
  "default-src 'self'",
  // Nothing is embedded and nothing embeds this app.
  "frame-ancestors 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  // A `<base>` tag injected into the document would silently re-target every relative URL on it,
  // including the `/api/*` calls that carry the session cookie.
  "base-uri 'none'",
  // Forms post to this app or nowhere.
  "form-action 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "manifest-src 'self'",
  "media-src 'none'",
  "worker-src 'self'",
  // `<style>` elements: same-origin stylesheets only. Attributes are the next entry, and they are
  // a different directive on purpose — see the header.
  // `<link rel=stylesheet>` from this origin. Next also stamps the nonce on those links, so a
  // nonce entry is not needed and is deliberately absent: fewer ways to be allowed is the point.
  "style-src 'self'",
  "style-src-attr 'unsafe-inline'",
];

/**
 * The header value.
 *
 * Assembled from a list rather than a template literal so every directive is one reviewable line,
 * and joined with `; ` because a policy is read far more often than it is written.
 */
export function contentSecurityPolicy(options: CspOptions): string {
  const development = options.development ?? false;

  // `'self'` covers the bundled chunks; the nonce covers Next's inline flight payload and the
  // theme boot script; the hash covers the theme boot script a second time, by its exact bytes.
  const script = [
    // Ignored by any browser that understands `'strict-dynamic'`, and the whole policy for one that
    // does not. Both layers are wanted: CSP Level 2 clients get host-based allowance, Level 3
    // clients get the stricter rule below.
    "script-src 'self'",
    `'nonce-${options.nonce}'`,
    `'${THEME_BOOT_SCRIPT_CSP_HASH}'`,
    // Only a script this policy named may run, and only scripts THOSE load may run after it. It is
    // safe here because Next stamps the nonce on every tag it emits — verified, not assumed:
    // `scripts/smoke-test.mjs` section 10 fetches a rendered page from a running server and fails
    // if one script tag lacks the nonce. That citation used to name a `test/csp-runtime.test.ts`
    // which has never existed, which is the same defect this file's own header condemns: a check
    // that reads like a control and is not one. No pure test can do this — there is no server —
    // so the only honest citation is the harness that speaks HTTP to a real deployment.
    "'strict-dynamic'",
    // React Refresh evaluates the modules it swaps in. Only ever under `next dev`.
    ...(development ? ["'unsafe-eval'"] : []),
  ].join(' ');

  // The browser only ever talks to its own origin: `src/lib/api.ts` uses relative `/api/...` paths
  // and `tableSocketUrl` builds `ws(s)://<the page's own host>`. `'self'` matches a same-origin
  // websocket under CSP Level 3, so no `ws:` entry is needed in production.
  const connect = [
    "connect-src 'self'",
    // Turbopack's HMR socket. In the dev loop the web server is :3000 and the API is :3001, and
    // `next dev`'s own socket is on the former; both are named so a developer running either
    // hostname from `allowedDevOrigins` gets a working reload.
    ...(development
      ? ['ws://localhost:3000', 'ws://127.0.0.1:3000', 'http://localhost:3001', 'http://127.0.0.1:3001']
      : []),
  ].join(' ');

  return [
    ...FIXED_DIRECTIVES,
    script,
    connect,
    // Only in production. On a development machine served over http it would rewrite every
    // same-origin request to https and break the whole app, which is how this directive usually
    // gets deleted outright rather than gated.
    ...(development ? [] : ['upgrade-insecure-requests']),
  ].join('; ');
}

/** The header name, so no call site spells it. */
export const CSP_HEADER = 'Content-Security-Policy';

/**
 * The other response headers the HTML origin owes.
 *
 * Small, and each one is here because it cannot be expressed in the CSP above:
 *
 *   - `X-Content-Type-Options` stops a browser sniffing a response into a script.
 *   - `Referrer-Policy` keeps a room id or a hand id out of a Referer header. There is no external
 *     origin to leak to today, and this is what keeps that true if one is ever added.
 *   - `X-Frame-Options` duplicates `frame-ancestors` for anything that predates CSP Level 2.
 *   - `Cross-Origin-Opener-Policy` severs the opener relationship, so a page that opened this one
 *     cannot reach into it.
 */
export const SECURITY_HEADERS: readonly (readonly [string, string])[] = [
  ['X-Content-Type-Options', 'nosniff'],
  ['Referrer-Policy', 'same-origin'],
  ['X-Frame-Options', 'DENY'],
  ['Cross-Origin-Opener-Policy', 'same-origin'],
];

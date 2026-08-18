/**
 * Next.js configuration for the Poker Risk Lab web client.
 *
 * Five settings, each of which is load-bearing rather than preference:
 *
 * 1. `transpilePackages` — the workspace packages are consumed as SOURCE, not as a build.
 *    `@prl/ui` resolves its `.` export straight to `src/index.ts` (see its package.json), so
 *    without this Next would hand raw `.tsx` to the Node loader. Listing every workspace
 *    package the client can reach keeps that uniform, so nobody has to remember which of them
 *    happens to ship a `dist/` today. `@prl/poker-ai` is listed because a legends screen may
 *    later need its labelling constants; it is not a declared dependency of this app yet, and
 *    an unmatched entry here is inert.
 *
 * 2. `images.unoptimized` — the repo installs with lifecycle scripts disabled, so `sharp`
 *    cannot build its native binary. The optimiser would fail at request time rather than at
 *    build time, which is the worst place to find out. There are no remote images anyway: the
 *    CSP forbids them and the design system does the same.
 *
 * 3. `reactStrictMode` — double-invokes effects in development, which is how a reveal observer
 *    or a count-up that fails to clean itself up gets caught here instead of on a table.
 *
 * 4. `rewrites` — the `/api/*` proxy for the development loop. This one is new, it reverses a
 *    previous "deliberately absent" decision, and the reason is below.
 *
 * ## Why there is now a rewrite, when this file used to say there never would be
 *
 * The earlier version of this header said "Deliberately absent: any webpack or turbopack
 * customisation, any redirect, any CDN, any image domain. Every one of those would be a place
 * for a remote asset to creep in." That reasoning was about *assets* — a CDN host or an image
 * domain smuggling a third-party origin into a page — and it still holds: none of those are
 * here, and none should be.
 *
 * This rewrite is not an asset path. It is the opposite: it exists so the browser talks to
 * exactly ONE origin, its own. `src/lib/api.ts` used to read `NEXT_PUBLIC_API_ORIGIN`, and
 * `NEXT_PUBLIC_*` is inlined into the client bundle by `next build` — so a built image has the
 * API's address frozen in its JavaScript and no deployment can point that image at its own API.
 * The fix is for the browser to use same-origin relative paths (`/api/...`) and for something in
 * front of the app to route them, which also makes the session cookie design honest: the cookie
 * is `__Host-` prefixed with no `Domain` (see `plugins/security.ts` in the API), and a `__Host-`
 * cookie is only ever sent to the exact host that set it.
 *
 * ## What routes `/api/*` where — and the limit of this rewrite
 *
 * There are two topologies, and only one of them uses this rewrite:
 *
 *   - **`pnpm run dev`** (web on :3000, api on :3001, no proxy in front). Nothing else can route
 *     the browser's `/api/...` here, so this rewrite does it. `next dev` reads this file when it
 *     starts, so `PRL_API_ORIGIN` is a *runtime* setting for the dev loop.
 *
 *   - **The container stack** (docker-compose.yml). A reverse proxy is the single published
 *     origin and routes `/api/*` to the API and everything else to this app, so a request never
 *     reaches this rewrite at all. That is deliberate, because of the next paragraph.
 *
 * `next build` bakes the resolved rewrite destination into `.next/routes-manifest.json`, and
 * `next start` reads the manifest rather than re-running this function (`getRoutesManifest` in
 * next/dist/server/next-server.js). So in a BUILT IMAGE this destination is build-time state,
 * exactly like the `NEXT_PUBLIC_` variable it replaces. Do not deploy an image expecting to
 * retarget it at runtime — put the proxy in front instead, which is what docker-compose.yml does
 * and what docs/RUNBOOK.md §11 requires of a deployment. The baked default is a working
 * `docker run` on a laptop whose API is on localhost:3001, and nothing more; `--build-arg
 * PRL_API_REWRITE_ORIGIN=...` (Dockerfile.web) changes it for that case.
 *
 * ## Two names, because there are two lifetimes
 *
 *   `PRL_API_ORIGIN`          RUNTIME.     Where the SERVER fetches the API during a render.
 *                                          Read on every boot, never inlined, set by compose.
 *   `PRL_API_REWRITE_ORIGIN`  BUILD TIME.  Where the rewrite below points. Frozen by
 *                                          `next build` into routes-manifest.json.
 *
 * They were one name in the first draft of this fix and that was a mistake: an operator who set
 * it on a running container would have half a change — the server's own fetches would move and the
 * browser's would not — which is a subtler version of the exact bug this file exists to remove.
 * The dev loop still only needs `PRL_API_ORIGIN`, because the rewrite falls back to it.
 *
 * ## The guard
 *
 * A build-time variable set in a running container's environment is a silent no-op, and a silent
 * no-op is how this whole cluster happened: `NEXT_PUBLIC_API_ORIGIN` was set in
 * docker-compose.yml's world and changed nothing, for a year, without one line of output saying
 * so. So the production server refuses to start if either build-time variable is present in its
 * environment. It is not a warning — a warning in a container's log is a thing nobody reads until
 * after the incident — and the phase check means it fires only where it is true: `next build` and
 * `next dev` both legitimately read these, and neither is `PHASE_PRODUCTION_SERVER`.
 *
 * ## One caveat, for whoever wires the live table
 *
 * The WebSocket upgrade is at `/api/v1/ws` — `WS_PATH` is `/ws` but `ws/hub.ts` is registered
 * under `API_PREFIX` like every other route module — so it is inside `/api/:path*` and matched by
 * the rule below. A Next rewrite is an HTTP proxy and makes no promise about `Upgrade`, so do not
 * assume the dev loop will carry a socket through it: verify it, and if it does not, connect the
 * dev-loop client to the API origin directly. In the container stack the reverse proxy handles the
 * upgrade, which is one more reason the proxy and not this rewrite is the deployment mechanism.
 */

import type { NextConfig } from 'next';
import { PHASE_PRODUCTION_SERVER } from 'next/constants.js';

/**
 * Where `/api/*` is rewritten to.
 *
 * Neither name is `NEXT_PUBLIC_`: both are read by the Next server, never by the browser, and
 * giving one the public prefix is precisely how the API's address ended up inlined in a client
 * bundle in the first place. The fallback chain means the dev loop sets `PRL_API_ORIGIN` alone and
 * gets a consistent answer for both the server's fetches and the browser's.
 */
const rewriteOrigin =
  process.env['PRL_API_REWRITE_ORIGIN'] ?? process.env['PRL_API_ORIGIN'] ?? 'http://localhost:3001';

/**
 * Variables that do nothing once the app is built, listed with what to do instead.
 *
 * `NEXT_PUBLIC_API_ORIGIN` is here because it is the one an operator reaches for: it was the
 * documented knob, it is inlined at build time, and setting it on a container has never had any
 * effect. Failing on it is how somebody upgrading from that design finds out in one second rather
 * than through a page that silently renders fixtures.
 */
const BUILD_TIME_ONLY: readonly (readonly [string, string])[] = [
  [
    'PRL_API_REWRITE_ORIGIN',
    'the rewrite destination is frozen into .next/routes-manifest.json by `next build`. Route /api/* at the proxy in front of this container (docs/RUNBOOK.md §11), or rebuild with --build-arg PRL_API_REWRITE_ORIGIN=…',
  ],
  [
    'NEXT_PUBLIC_API_ORIGIN',
    'NEXT_PUBLIC_* is inlined into the client bundle at build time and this app no longer reads it at all. The browser now calls its own origin; set PRL_API_ORIGIN for the server-side origin and route /api/* at the proxy',
  ],
];

/** Throws if a build-time-only variable is set on a production server, where it cannot work. */
function assertNoBuildTimeOnlyVariables(): void {
  const offenders = BUILD_TIME_ONLY.filter(([name]) => process.env[name] !== undefined);
  if (offenders.length === 0) return;
  throw new Error(
    `Refusing to start: ${offenders.length} build-time-only variable(s) set in the environment of a built app. ` +
      'Each would be silently ignored, which is the failure this check exists to prevent.\n' +
      offenders.map(([name, advice]) => `  - ${name}: ${advice}`).join('\n'),
  );
}

/**
 * Hosts the DEV server will serve `/_next/*` to. Development only — `next start` ignores it.
 *
 * Next 16 blocks cross-origin requests to dev-only assets, and it decides "cross-origin" against
 * the hostname the dev server was initialised with, which is `localhost`. `127.0.0.1` is a
 * different hostname by that test, so a developer who opens `http://127.0.0.1:3000` gets the HTML
 * (200) and a 403 on every `/_next/*` chunk.
 *
 * That failure is nasty because of how it looks: the page renders — server-rendered HTML does not
 * need the chunks — and then never hydrates. No error banner, no blank screen, just a page where
 * nothing responds to a click. Nobody's first guess is an origin check on the asset route.
 *
 * Both are listed rather than one being declared correct, because this repository does not
 * currently agree with itself: `scripts/dev.mjs` prints `http://127.0.0.1:3000` when it starts,
 * `scripts/a11y-audit.mjs` crawls `http://127.0.0.1:3000`, `scripts/smoke-test.mjs` uses
 * `http://localhost:3000` for the web and `http://127.0.0.1:3001` for the API, and the runbook says
 * `localhost`. Listing both makes every one of those work instead of making four of them wrong.
 *
 * It does NOT make the two interchangeable everywhere, and docs/RUNBOOK.md §2 says so: they are
 * still different origins to the browser's cookie jar and to the API's exact-match
 * `PUBLIC_WEB_ORIGIN` allowlist. This entry removes one silent failure; it does not remove the
 * need to pick a host and stay on it.
 */
const DEV_ORIGINS: readonly string[] = ['localhost', '127.0.0.1'];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@prl/ui', '@prl/contracts', '@prl/poker-math', '@prl/poker-engine', '@prl/poker-ai'],
  images: { unoptimized: true },
  allowedDevOrigins: [...DEV_ORIGINS],
  rewrites: () =>
    Promise.resolve([
      {
        source: '/api/:path*',
        destination: `${rewriteOrigin}/api/:path*`,
      },
    ]),
};

/**
 * The function form, so the phase is available. `next build` and `next dev` get the config
 * unchanged; only `next start` — the one phase where the rewrite above is already frozen — is
 * gated.
 */
export default function config(phase: string): NextConfig {
  if (phase === PHASE_PRODUCTION_SERVER) assertNoBuildTimeOnlyVariables();
  return nextConfig;
}

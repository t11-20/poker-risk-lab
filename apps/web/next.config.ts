/**
 * `transpilePackages` because the workspace packages ship source, not a build.
 * `images.unoptimized` because install disables lifecycle scripts, so `sharp` has no native binary.
 * The CSP forbids remote images anyway. `reactStrictMode` double-invokes effects to catch missing cleanup.
 * The rewrite keeps the browser on its own origin, which the `__Host-` session cookie requires, and it
 * serves `pnpm run dev` only. `next build` freezes its destination into `.next/routes-manifest.json`, so a
 * built image is routed by the reverse proxy in front (RUNBOOK §11) and its baked API is localhost:3001.
 * A Next rewrite promises nothing about WebSocket `Upgrade`, so do not assume it carries `/api/v1/ws`.
 */

import type { NextConfig } from 'next';
import { PHASE_PRODUCTION_SERVER } from 'next/constants.js';

/**
 * `PRL_API_REWRITE_ORIGIN` is build time and `PRL_API_ORIGIN` is the server's runtime origin. Two names,
 * because one would let a running container move the server's fetches but not the browser's.
 * Neither is `NEXT_PUBLIC_`, which `next build` inlines into the client bundle.
 */
const rewriteOrigin =
  process.env['PRL_API_REWRITE_ORIGIN'] ?? process.env['PRL_API_ORIGIN'] ?? 'http://localhost:3001';

/** Silent no-ops on a built app, so `next start` refuses to boot while any is set. */
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
 * Dev only. Next 16 serves dev chunks only to the hostname it started with, so `127.0.0.1` got HTML
 * and a 403 on every chunk, a page that never hydrates. The scripts use both hostnames, which stay
 * different origins to the cookie jar and to `PUBLIC_WEB_ORIGIN` (RUNBOOK §2).
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

/** The function form, so only `next start`, where the rewrite is already frozen, is checked. */
export default function config(phase: string): NextConfig {
  if (phase === PHASE_PRODUCTION_SERVER) assertNoBuildTimeOnlyVariables();
  return nextConfig;
}

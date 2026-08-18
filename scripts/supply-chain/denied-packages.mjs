/**
 * The blocklist. Fail-closed: if any of these appear anywhere in the resolved
 * dependency graph — direct or transitive, prod or dev — the build fails.
 *
 * Provenance for every entry is recorded so that a future maintainer can tell
 * *why* something is blocked and what evidence would justify unblocking it.
 * See docs/security/shai-hulud-snapshot-2026-08-17.md.
 *
 * Adding an exception requires a human edit to this file plus an ADR. There is
 * deliberately no environment variable or CLI flag that bypasses it.
 */

/** Exact package names that are denied outright, at every version. */
export const DENIED_NAMES = new Map([
  // --- Project guardrail: the whole caching family, regardless of version. ---
  // CSA Singapore AD-2026-009 reported an ongoing Shai-Hulud wave through keyv
  // and related caching packages. The guardrail denies the family, not just the
  // known-bad versions, because the maintainer account compromise is the root
  // cause and re-compromise of the same family is the expected failure mode.
  ['keyv', 'guardrail: Shai-Hulud caching family (CSA AD-2026-009)'],
  ['cacheable', 'guardrail: Shai-Hulud caching family (CSA AD-2026-009)'],
  ['flat-cache', 'guardrail: Shai-Hulud caching family (CSA AD-2026-009)'],
  ['file-entry-cache', 'guardrail: Shai-Hulud caching family (CSA AD-2026-009)'],
  ['cacheable-request', 'guardrail: Shai-Hulud caching family (CSA AD-2026-009)'],
  ['cache-manager', 'guardrail: Shai-Hulud caching family (CSA AD-2026-009)'],

  // --- Campaign-implicated packages named in reporting. ---
  ['echarts-for-react', 'Mini Shai-Hulud: compromised 3.0.7/3.1.7/3.2.7 (Microsoft, StepSecurity)'],
  ['size-sensor', 'Mini Shai-Hulud: compromised (Microsoft)'],
  ['timeago.js', 'Mini Shai-Hulud: compromised 4.1.2/4.2.2 (StepSecurity)'],
  ['jest-canvas-mock', 'Mini Shai-Hulud: compromised 2.5.3/2.6.3/2.7.3 (StepSecurity)'],
]);

/** Scope prefixes that are denied outright. */
export const DENIED_SCOPES = new Map([
  ['@cacheable/', 'guardrail: Shai-Hulud caching family (CSA AD-2026-009)'],
  ['@antv/', 'Mini Shai-Hulud: 400+ compromised scoped packages (Microsoft, StepSecurity)'],
]);

/**
 * Hosts that must never appear as a dependency resolution target. The registry
 * is the only permitted acquisition channel; a git/tarball/CDN resolution is a
 * documented Mini Shai-Hulud delivery path (Pattern B) and also defeats the
 * release-age cooldown.
 */
export const ALLOWED_RESOLUTION_HOSTS = new Set(['registry.npmjs.org']);

/**
 * On-disk artefacts left by the campaign. `ioc-scan.mjs` sweeps the working tree
 * and the installed store for these. Paths are matched relative to a root.
 */
export const IOC_PATHS = ['.claude/setup.mjs', '.vscode/setup.mjs', 'cat.py', '.github/workflows/codeql.yml'];

/** Byte-level markers. Any hit is treated as a confirmed compromise, not a warning. */
export const IOC_STRINGS = [
  { marker: 'niagA oG eW ereH :duluH-iahS', why: 'reversed campaign fingerprint in repo descriptions' },
  { marker: 'Shai-Hulud: Here We Go Again', why: 'campaign fingerprint' },
  {
    marker: 'IfYouInvalidateThisTokenItWillNukeTheComputerOfTheOwner',
    why: 'campaign commit-message marker',
  },
  { marker: 't.m-kosche.com', why: 'campaign C2 domain' },
  { marker: 'api/public/otel/v1/traces', why: 'campaign C2 path (fake OpenTelemetry collector)' },
  { marker: '__DAEMONIZED=1', why: 'payload re-entry guard' },
  { marker: 'bun run .claude/', why: 'second-stage invocation' },
  { marker: 'bun.sh/install', why: 'remote runtime acquisition at install time' },
  { marker: '/proc/self/mem', why: 'credential harvesting from process memory' },
];

/** Known payload hashes (SHA-256). */
export const IOC_HASHES = new Map([
  ['a68dd1e6a6e35ec3771e1f94fe796f55dfe65a2b94560516ff4ac189390dfa1c', 'Mini Shai-Hulud payload'],
  ['fb5c97557230a27460fdab01fafcfabeaa49590bafd5b6ef30501aa9e0a51142', 'Mini Shai-Hulud Python backdoor'],
]);

/** @returns {string|null} reason if denied, else null */
export function denyReason(name) {
  const exact = DENIED_NAMES.get(name);
  if (exact) return exact;
  for (const [scope, reason] of DENIED_SCOPES) {
    if (name.startsWith(scope)) return reason;
  }
  return null;
}

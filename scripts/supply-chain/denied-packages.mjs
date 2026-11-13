/**
 * The blocklist. Any of these anywhere in the resolved graph fails the build. Sources are in
 * docs/security/shai-hulud-snapshot-2026-08-17.md. An exception needs an edit here plus an ADR;
 * there is no bypass flag or variable.
 */

export const DENIED_NAMES = new Map([
  // The whole caching family (CSA Singapore AD-2026-009, a wave through keyv). The root cause is a
  // maintainer account compromise, so the family is denied, not just the known-bad versions.
  ['keyv', 'guardrail: Shai-Hulud caching family (CSA AD-2026-009)'],
  ['cacheable', 'guardrail: Shai-Hulud caching family (CSA AD-2026-009)'],
  ['flat-cache', 'guardrail: Shai-Hulud caching family (CSA AD-2026-009)'],
  ['file-entry-cache', 'guardrail: Shai-Hulud caching family (CSA AD-2026-009)'],
  ['cacheable-request', 'guardrail: Shai-Hulud caching family (CSA AD-2026-009)'],
  ['cache-manager', 'guardrail: Shai-Hulud caching family (CSA AD-2026-009)'],

  ['echarts-for-react', 'Mini Shai-Hulud: compromised 3.0.7/3.1.7/3.2.7 (Microsoft, StepSecurity)'],
  ['size-sensor', 'Mini Shai-Hulud: compromised (Microsoft)'],
  ['timeago.js', 'Mini Shai-Hulud: compromised 4.1.2/4.2.2 (StepSecurity)'],
  ['jest-canvas-mock', 'Mini Shai-Hulud: compromised 2.5.3/2.6.3/2.7.3 (StepSecurity)'],
]);

/**
 * Scopes, not versions: the campaign mints new versions faster than a version list can follow. The
 * last three are named in the snapshot's §1 sources and are not in the graph today.
 */
export const DENIED_SCOPES = new Map([
  ['@cacheable/', 'guardrail: Shai-Hulud caching family (CSA AD-2026-009)'],
  ['@antv/', 'Mini Shai-Hulud: 400+ compromised scoped packages (Microsoft, StepSecurity)'],
  ['@tanstack/', 'Mini Shai-Hulud: TanStack packages compromised (Snyk, Expel, Arctic Wolf)'],
  ['@mistralai/', 'Mini Shai-Hulud: Mistral AI ecosystem compromised (Expel, Arctic Wolf)'],
  ['@opensearch-project/', 'Mini Shai-Hulud: OpenSearch ecosystem compromised (Expel, Arctic Wolf)'],
]);

/** Resolution hosts that are never allowed. Off-registry resolution is delivery Pattern B. */
export const ALLOWED_RESOLUTION_HOSTS = new Set(['registry.npmjs.org']);

/**
 * Campaign artefacts, relative to a root. `setup.mjs` is the payload; `tasks.json` and
 * `settings.json` make an editor or agent run it on open.
 */
export const IOC_PATHS = [
  '.claude/setup.mjs',
  '.claude/settings.json',
  '.vscode/setup.mjs',
  '.vscode/tasks.json',
  'cat.py',
  '.github/workflows/codeql.yml',
];

/**
 * The workflows this repository declares. The campaign injects `.github/workflows/codeql.yml` to
 * mint publish tokens, so `ci-pinning.mjs` fails on any undeclared file and adding one is a
 * reviewed two-file diff. `release-sign.yml` is the only workflow allowed `id-token: write`, which
 * `keyless-provenance.mjs` enforces against `deploy/signing/keyless-policy.json`.
 */
export const EXPECTED_WORKFLOWS = new Set(['ci.yml', 'release.yml', 'release-sign.yml']);

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

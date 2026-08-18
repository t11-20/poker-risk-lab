#!/usr/bin/env node
/**
 * Gate: no resolved package version may have a known vulnerability in OSV.dev.
 *
 * Uses the public OSV batch API directly rather than a scanner package, for the
 * same reason as the rest of this directory: the auditor should not inherit the
 * risk it is auditing. OSV's `querybatch` already filters by version, so a hit
 * means "this exact version is affected", not "this package has ever had a CVE".
 *
 * Failure policy:
 *   - a vulnerability affecting a production dependency fails the build
 *   - a vulnerability affecting only a dev dependency fails the build too, unless
 *     it is listed in `osv-allowlist.json` with a reason and an expiry date
 *   - withdrawn advisories are ignored
 *
 * The allowlist is the only escape hatch, it is a reviewed file, and every entry
 * expires. There is no flag that turns this gate off.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchJson, Gate, mapLimit, REPO_ROOT, resolvedGraph, runGate } from './lib.mjs';

const gate = new Gate('osv-vulnerability-scan');
const ALLOWLIST_PATH = join(REPO_ROOT, 'scripts', 'supply-chain', 'osv-allowlist.json');
const REPORT_PATH = join(REPO_ROOT, 'docs', 'sbom', 'osv-report.json');
const OSV_BATCH_LIMIT = 900; // API accepts 1000 queries per request; stay under it.

function loadAllowlist() {
  if (!existsSync(ALLOWLIST_PATH)) return [];
  const parsed = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'));
  return Array.isArray(parsed.allow) ? parsed.allow : [];
}

function severityOf(vuln) {
  const cvss = vuln.severity?.find((s) => s.type?.startsWith('CVSS'));
  const dbSeverity =
    vuln.database_specific?.severity ??
    vuln.affected?.find((a) => a.database_specific?.severity)?.database_specific?.severity;
  return dbSeverity ?? cvss?.score ?? 'UNKNOWN';
}

await runGate(gate, async () => {
  const { packages } = resolvedGraph();
  const targets = [...packages.values()];
  const queries = targets.map((p) => ({
    package: { name: p.name, ecosystem: 'npm' },
    version: p.version,
  }));

  gate.note(`querying OSV.dev for ${queries.length} package versions`);

  /** @type {Array<{ids: string[]}>} */
  const batchResults = [];
  for (let offset = 0; offset < queries.length; offset += OSV_BATCH_LIMIT) {
    const chunk = queries.slice(offset, offset + OSV_BATCH_LIMIT);
    const response = await fetchJson('https://api.osv.dev/v1/querybatch', {
      method: 'POST',
      body: { queries: chunk },
      timeoutMs: 45_000,
    });
    const results = response.results ?? [];
    if (results.length !== chunk.length) {
      gate.fail(
        `OSV returned ${results.length} results for ${chunk.length} queries`,
        'cannot map results back to packages reliably — failing closed',
      );
      return;
    }
    batchResults.push(...results.map((r) => ({ ids: (r.vulns ?? []).map((v) => v.id) })));
  }

  const hits = [];
  for (const [i, result] of batchResults.entries()) {
    const target = targets[i];
    if (!target || result.ids.length === 0) continue;
    hits.push({ target, ids: result.ids });
  }

  if (hits.length === 0) {
    gate.note('no advisories matched any resolved version');
  }

  // Fetch full advisory records only for the hits.
  const uniqueIds = [...new Set(hits.flatMap((h) => h.ids))];
  const details = new Map();
  await mapLimit(uniqueIds, 6, async (id) => {
    try {
      details.set(id, await fetchJson(`https://api.osv.dev/v1/vulns/${encodeURIComponent(id)}`));
    } catch (err) {
      details.set(id, { id, __error: err.message });
    }
  });

  const allowlist = loadAllowlist();
  const now = Date.now();
  const findings = [];

  for (const hit of hits) {
    for (const id of hit.ids) {
      const vuln = details.get(id) ?? { id };
      if (vuln.withdrawn) continue;
      const aliases = vuln.aliases ?? [];
      const severity = severityOf(vuln);
      const finding = {
        id,
        aliases,
        package: hit.target.name,
        version: hit.target.version,
        dev: hit.target.dev,
        severity,
        summary: vuln.summary ?? vuln.__error ?? '(no summary)',
        importers: [...hit.target.importers],
      };
      findings.push(finding);

      const entry = allowlist.find(
        (a) =>
          (a.id === id || aliases.includes(a.id)) &&
          (a.package === undefined || a.package === hit.target.name),
      );
      if (entry) {
        const expires = Date.parse(entry.expires ?? '');
        if (!Number.isFinite(expires)) {
          gate.fail(`allowlist entry for ${id} has no valid \`expires\` date`, 'every exception must expire');
        } else if (expires < now) {
          gate.fail(
            `allowlist entry for ${id} expired on ${entry.expires}`,
            `${hit.target.name}@${hit.target.version} — re-review the advisory or upgrade`,
          );
        } else {
          gate.warn(
            `allowlisted advisory ${id} in ${hit.target.name}@${hit.target.version} (expires ${entry.expires})`,
            `reason: ${entry.reason ?? '(none recorded)'}`,
          );
        }
        continue;
      }

      gate.fail(
        `${id} affects ${hit.target.name}@${hit.target.version} [${hit.target.dev ? 'dev' : 'prod'}] severity=${severity}`,
        `${finding.summary}\n      reached from: ${finding.importers.join(', ')}\n      https://osv.dev/vulnerability/${id}`,
      );
    }
  }

  writeFileSync(
    REPORT_PATH,
    `${JSON.stringify(
      {
        generatedAt: new Date(now).toISOString(),
        source: 'https://api.osv.dev/v1/querybatch',
        packagesQueried: queries.length,
        findings,
      },
      null,
      2,
    )}\n`,
  );
  gate.note(`osv report written to docs/sbom/osv-report.json (${findings.length} finding(s))`);
});

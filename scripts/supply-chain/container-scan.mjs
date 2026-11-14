#!/usr/bin/env node
/**
 * Gate: the shipped container images are scanned for known vulnerabilities with trivy. The npm gates
 * cannot see OS packages, and the first run against the Debian web image found 38 HIGH or CRITICAL.
 * The unfixable count it printed (60 across two images) moved both Dockerfiles to Alpine on
 * 2026-08-25, which cleared all 60.
 *
 * It fails when trivy is missing, its database is unreachable, it identified no OS, or there are no
 * images. A finding blocks at or above `--severity` (default HIGH) when a fix exists. Unfixable
 * findings are counted and printed but do not block unless `--include-unfixed`, because a gate red
 * for reasons this project cannot act on gets turned off. Exceptions live in
 * `container-allowlist.json` with a reason, approver and expiry, and are still printed.
 *
 * It runs `--scanners vuln` only and proves nothing beyond what the database knew when it ran.
 * Nothing re-runs it on a schedule, so scan again before a release.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { bold, dim, Gate, green, REPO_ROOT, red, runGate } from './lib.mjs';

const DEFAULTS = {
  manifest: 'deploy/staging/release-manifest.json',
  allowlist: 'scripts/supply-chain/container-allowlist.json',
  severity: 'HIGH',
};

/** `UNKNOWN` is lowest: trivy uses it for unrated advisories, and ranking them high voids the floor. */
const SEVERITIES = ['UNKNOWN', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

const HELP = `
${bold('pnpm run security:containers')} — scan the release images for known vulnerabilities

  Options:
    --manifest <path>    release manifest to read images from  (default ${DEFAULTS.manifest})
    --image <ref>        scan this reference instead; repeatable
    --severity <level>   floor: one of ${SEVERITIES.join(', ')}  (default ${DEFAULTS.severity})
    --include-unfixed    also block on findings with no available fix
    --allowlist <path>   exceptions file                       (default ${DEFAULTS.allowlist})
    --json               print the full report as JSON
    --out <file>         write the full report as JSON to a file
    -h, --help           this text

  Requires trivy on PATH and a reachable vulnerability database. It REFUSES —
  non-zero, never a warning — if either is missing, because a scanner that passes
  when it did not run is worse than no scanner.

  Exit codes: 0 clean, 1 blocking findings or a refusal to run.
`;

export function parseArgs(argv) {
  const options = {
    manifest: DEFAULTS.manifest,
    images: [],
    severity: DEFAULTS.severity,
    includeUnfixed: false,
    allowlist: DEFAULTS.allowlist,
    json: false,
    out: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    if (arg === '--') continue;
    switch (arg) {
      case '-h':
      case '--help':
        options.help = true;
        break;
      case '--manifest':
        options.manifest = next();
        break;
      case '--image':
        options.images.push(next());
        break;
      case '--severity':
        options.severity = next().toUpperCase();
        break;
      case '--include-unfixed':
        options.includeUnfixed = true;
        break;
      case '--allowlist':
        options.allowlist = next();
        break;
      case '--json':
        options.json = true;
        break;
      case '--out':
        options.out = next();
        break;
      default:
        throw new Error(`unknown option ${arg} (try --help)`);
    }
  }
  if (!SEVERITIES.includes(options.severity)) {
    throw new Error(`--severity must be one of ${SEVERITIES.join(', ')}, got "${options.severity}"`);
  }
  return options;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validates the allowlist and returns the usable entries. Pure, so the tests can feed every malformed
 * shape. Every problem fails the gate, because a half-understood allowlist stops suppressing silently.
 */
export function parseAllowlist(raw, now) {
  const problems = [];
  const entries = [];
  if (raw === null || typeof raw !== 'object') {
    return { entries, problems: ['the allowlist is not a JSON object'] };
  }
  const allow = raw.allow;
  if (!Array.isArray(allow)) {
    return { entries, problems: ['the allowlist has no `allow` array'] };
  }
  for (const [index, entry] of allow.entries()) {
    const where = `allow[${index}]`;
    if (entry === null || typeof entry !== 'object') {
      problems.push(`${where} is not an object`);
      continue;
    }
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    if (id === '') {
      problems.push(`${where} has no vulnerability id`);
      continue;
    }
    if (typeof entry.reason !== 'string' || entry.reason.trim().length < 12) {
      // "n/a" and "later" are not reasons.
      problems.push(`${where} (${id}) has no usable \`reason\` — say why this is being shipped anyway`);
    }
    if (typeof entry.approvedBy !== 'string' || entry.approvedBy.trim() === '') {
      problems.push(`${where} (${id}) has no \`approvedBy\` — an exception needs an owner`);
    }
    if (typeof entry.expires !== 'string' || !ISO_DATE.test(entry.expires)) {
      problems.push(
        `${where} (${id}) has no valid \`expires\` (YYYY-MM-DD) — an exception must be temporary`,
      );
      continue;
    }
    const expiry = Date.parse(`${entry.expires}T23:59:59Z`);
    if (Number.isNaN(expiry)) {
      problems.push(`${where} (${id}) has an unparseable \`expires\`: ${entry.expires}`);
      continue;
    }
    if (expiry < now.getTime()) {
      problems.push(
        `${where} (${id}) expired on ${entry.expires} — re-approve it with a new date or remove it`,
      );
      continue;
    }
    entries.push({
      id,
      package: typeof entry.package === 'string' ? entry.package : null,
      image: typeof entry.image === 'string' ? entry.image : null,
      reason: String(entry.reason ?? ''),
      expires: entry.expires,
      approvedBy: String(entry.approvedBy ?? ''),
    });
  }
  return { entries, problems };
}

function allowFor(entries, finding) {
  return (
    entries.find(
      (entry) =>
        entry.id === finding.id &&
        (entry.package === null || entry.package === finding.package) &&
        (entry.image === null || entry.image === finding.image),
    ) ?? null
  );
}

/** Turns one trivy JSON report into findings and a verdict. Pure, so the tests drive every branch. */
export function classifyReport({ image, report, allowlist, severityFloor, includeUnfixed }) {
  const floor = SEVERITIES.indexOf(severityFloor);
  const findings = [];
  const problems = [];

  const results = Array.isArray(report?.Results) ? report.Results : [];
  // No `Metadata.OS` means trivy recognised no package database, so "no OS findings" says nothing.
  const os = report?.Metadata?.OS;
  if (os === undefined || os === null || typeof os.Family !== 'string') {
    problems.push(
      `trivy did not identify an operating system in ${image}, so it did not read an OS package ` +
        'database. A report with no package source is not a clean result, it is an absent one.',
    );
  }
  if (results.length === 0) {
    problems.push(
      `trivy returned no scan targets for ${image} — it produced a report having examined nothing`,
    );
  }

  let packagesConsidered = 0;
  for (const result of results) {
    const vulnerabilities = Array.isArray(result?.Vulnerabilities) ? result.Vulnerabilities : [];
    packagesConsidered += vulnerabilities.length;
    for (const vulnerability of vulnerabilities) {
      const severity = typeof vulnerability?.Severity === 'string' ? vulnerability.Severity : 'UNKNOWN';
      if (SEVERITIES.indexOf(severity) < floor) continue;
      const fixedVersion =
        typeof vulnerability?.FixedVersion === 'string' && vulnerability.FixedVersion !== ''
          ? vulnerability.FixedVersion
          : null;
      const finding = {
        image,
        target: typeof result?.Target === 'string' ? result.Target : 'unknown',
        id: String(vulnerability?.VulnerabilityID ?? 'UNKNOWN'),
        package: String(vulnerability?.PkgName ?? 'unknown'),
        installed: String(vulnerability?.InstalledVersion ?? 'unknown'),
        fixedVersion,
        severity,
        status: String(vulnerability?.Status ?? 'unknown'),
      };
      const allowed = allowFor(allowlist, finding);
      finding.allowedBy = allowed;
      // Allowlist first, then fixability. Reversed, an entry for an unfixable finding would look
      // effective while doing nothing.
      finding.blocking = allowed === null && (fixedVersion !== null || includeUnfixed);
      findings.push(finding);
    }
  }

  return { image, findings, problems, packagesConsidered, os: os ?? null };
}

/**
 * trivy exits 1 for a database failure and an unreadable image alike, so its stderr text is the
 * only way to tell an offline operator the right thing. An unmatched failure is still a refusal.
 */
const DATABASE_FAILURE_MARKERS = [
  'failed to download vulnerability DB',
  'unable to initialize the DB',
  'database is in an invalid state',
  'failed to init db',
  'DB error',
];

function runTrivy(image, severityFloor) {
  const severities = SEVERITIES.slice(SEVERITIES.indexOf(severityFloor)).join(',');
  const result = spawnSync(
    'trivy',
    [
      'image',
      '--quiet',
      // Vulnerabilities only. Secret and misconfiguration scanning belong in a separate gate.
      '--scanners',
      'vuln',
      '--format',
      'json',
      '--severity',
      severities,
      // trivy's --exit-code stays 0. This script decides what blocks, so a non-zero trivy exit means
      // the scan did not happen.
      image,
    ],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  if (result.error !== undefined && result.error !== null) {
    return { report: null, problem: `could not run trivy: ${result.error.message}` };
  }
  const stderr = result.stderr ?? '';
  if (result.status !== 0) {
    const databaseFailure = DATABASE_FAILURE_MARKERS.some((marker) => stderr.includes(marker));
    return {
      report: null,
      problem: databaseFailure
        ? `trivy could not load its vulnerability database, so it scanned ${image} against nothing: ` +
          `${stderr.trim().split('\n').slice(-3).join(' ')}`
        : `trivy exited ${result.status} scanning ${image}: ${stderr.trim().split('\n').slice(-3).join(' ')}`,
    };
  }
  try {
    return { report: JSON.parse(result.stdout ?? ''), problem: null };
  } catch (err) {
    return { report: null, problem: `trivy produced output that is not JSON for ${image}: ${err.message}` };
  }
}

function trivyVersion() {
  const result = spawnSync('trivy', ['--version', '--quiet'], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  const line = (result.stdout ?? '').split('\n').find((l) => l.startsWith('Version:'));
  return line === undefined
    ? (result.stdout ?? '').trim().split('\n')[0]
    : line.replace('Version:', '').trim();
}

/**
 * Defaults to the release manifest's digests. Scanning `prl-api:latest` scans whatever carries the
 * tag.
 */
export function imagesToScan(options) {
  if (options.images.length > 0) {
    return { images: options.images.map((reference) => ({ service: 'explicit', reference })), problem: null };
  }
  const path = resolve(REPO_ROOT, options.manifest);
  if (!existsSync(path)) {
    return {
      images: [],
      problem:
        `no release manifest at ${options.manifest} and no --image given, so there is nothing to scan. ` +
        'Build the artefacts first (`pnpm run release:artifacts`) or name an image explicitly. ' +
        'This is a failure and not a skip: a scan of nothing proves nothing.',
    };
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return { images: [], problem: `${options.manifest} is not valid JSON: ${err.message}` };
  }
  const images = [];
  for (const [service, image] of Object.entries(manifest?.images ?? {})) {
    if (typeof image?.reference === 'string') images.push({ service, reference: image.reference });
  }
  if (images.length === 0) {
    return { images: [], problem: `${options.manifest} names no images` };
  }
  return { images, problem: null };
}

export function runContainerScanGate(options) {
  const gate = new Gate('container-image-cves');
  const report = {
    scannedAt: new Date().toISOString(),
    trivyVersion: null,
    severityFloor: options.severity,
    includeUnfixed: options.includeUnfixed,
    images: [],
  };

  return runGate(gate, () => {
    const version = trivyVersion();
    if (version === null) {
      gate.fail(
        'trivy is not installed, so no image was scanned',
        'This REFUSES rather than skipping: a scanner that exits 0 when it did not run turns "nobody ' +
          'checked" into a green tick in a release report. Install it — `brew install trivy`, or see ' +
          'https://trivy.dev/latest/getting-started/installation/ — and run this again.',
      );
      return;
    }
    report.trivyVersion = version;
    gate.note(`trivy ${version}, severity floor ${options.severity}`);

    const allowlistPath = resolve(REPO_ROOT, options.allowlist);
    let allowlistRaw = null;
    if (existsSync(allowlistPath)) {
      try {
        allowlistRaw = JSON.parse(readFileSync(allowlistPath, 'utf8'));
      } catch (err) {
        gate.fail(`${options.allowlist} is not valid JSON`, err.message);
        return;
      }
    } else {
      gate.fail(
        `${options.allowlist} does not exist`,
        'the allowlist is part of the policy; a missing one is a policy nobody can read, not an ' +
          'empty one. Create it with an empty `allow` array.',
      );
      return;
    }
    const { entries: allowlist, problems: allowlistProblems } = parseAllowlist(allowlistRaw, new Date());
    for (const problem of allowlistProblems) {
      gate.fail(`container allowlist: ${problem}`);
    }
    if (allowlistProblems.length > 0) return;
    gate.note(`${allowlist.length} allowlist entry/entries in effect`);

    const { images, problem: selectionProblem } = imagesToScan(options);
    if (selectionProblem !== null) {
      gate.fail('nothing to scan', selectionProblem);
      return;
    }

    let blocking = 0;
    let unfixable = 0;
    let allowed = 0;
    // Counted by severity because two reviews misread "60 unfixable" as 60 HIGH when 8 were CRITICAL.
    const unfixableBySeverity = new Map();
    const unfixableCriticalIds = new Set();
    const usedAllowlistIds = new Set();

    for (const image of images) {
      const { report: trivyReport, problem } = runTrivy(image.reference, options.severity);
      if (trivyReport === null) {
        gate.fail(`the scan of ${image.service} did not happen`, problem ?? 'unknown');
        continue;
      }
      const classified = classifyReport({
        image: image.reference,
        report: trivyReport,
        allowlist,
        severityFloor: options.severity,
        includeUnfixed: options.includeUnfixed,
      });
      for (const classificationProblem of classified.problems) {
        gate.fail(`the scan of ${image.service} cannot be trusted`, classificationProblem);
      }
      report.images.push({
        service: image.service,
        reference: image.reference,
        os: classified.os,
        findings: classified.findings,
      });

      for (const finding of classified.findings) {
        if (finding.allowedBy !== null) {
          allowed += 1;
          usedAllowlistIds.add(finding.allowedBy.id);
          gate.warn(
            `ALLOWED ${finding.severity} ${finding.id} in ${finding.package} (${image.service})`,
            `until ${finding.allowedBy.expires}, approved by ${finding.allowedBy.approvedBy} — ` +
              finding.allowedBy.reason,
          );
        } else if (finding.blocking) {
          blocking += 1;
          gate.fail(
            `${finding.severity} ${finding.id} in ${finding.package} ${finding.installed} (${image.service})`,
            `fixed in ${finding.fixedVersion ?? 'no released version'} — ${finding.target}`,
          );
        } else {
          unfixable += 1;
          unfixableBySeverity.set(finding.severity, (unfixableBySeverity.get(finding.severity) ?? 0) + 1);
          if (finding.severity === 'CRITICAL') unfixableCriticalIds.add(`${finding.id} (${finding.package})`);
        }
      }

      const unfixableHere = classified.findings.filter((f) => !f.blocking && f.allowedBy === null);
      gate.note(
        `${image.service} (${classified.os?.Family ?? '?'} ${classified.os?.Name ?? '?'}): ` +
          `${classified.findings.length} finding(s) at or above ${options.severity}, ` +
          `${unfixableHere.length} with no available fix`,
      );
    }

    for (const entry of allowlist) {
      if (usedAllowlistIds.has(entry.id)) continue;
      gate.warn(
        `stale allowlist entry: ${entry.id} matched no finding`,
        'the vulnerability is gone or the entry never matched. Remove it — an exception nobody needs ' +
          'is an exception nobody re-reads.',
      );
    }

    const bySeverity = SEVERITIES.filter((severity) => unfixableBySeverity.has(severity))
      .reverse()
      .map((severity) => `${unfixableBySeverity.get(severity)} ${severity}`)
      .join(', ');
    report.unfixableBySeverity = Object.fromEntries(unfixableBySeverity);

    if (unfixableCriticalIds.size > 0) {
      // Unfixable CRITICALs get their own line, above the total.
      gate.warn(
        `${unfixableBySeverity.get('CRITICAL')} CRITICAL finding(s) ship unfixed in these images`,
        [...unfixableCriticalIds].join(', '),
      );
    }
    if (unfixable > 0) {
      gate.warn(
        `${unfixable} finding(s) at or above ${options.severity} have NO available fix and did not block ` +
          `(${bySeverity})`,
        'These are real vulnerabilities in a shipped image. They do not block because the only ' +
          'remediation is a different base image, and a permanently red gate is a gate somebody turns ' +
          'off. Pass --include-unfixed to make them block; watch this number and change base image ' +
          'when it grows.',
      );
    }
    gate.note(
      `${images.length} image(s) scanned: ${blocking} blocking, ${unfixable} unfixable` +
        `${bySeverity === '' ? '' : ` (${bySeverity})`}, ${allowed} allowed`,
    );
  }).then((code) => {
    if (options.out !== null) {
      const outPath = resolve(REPO_ROOT, options.out);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
      console.log(dim(`  · full report written to ${options.out}`));
    }
    if (options.json) console.log(JSON.stringify(report, null, 2));
    console.log(
      dim(
        '\n  This reports what a vulnerability database knew at the moment it ran, about packages a\n' +
          '  scanner could identify, with --scanners vuln only: no secrets, no misconfiguration, no\n' +
          "  licences, and nothing at all about this project's own code. A clean run today is not a\n" +
          '  clean run tomorrow, and nothing re-runs it on a schedule: scan again before a release.\n',
      ),
    );
    return code;
  });
}

if (import.meta.main) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(red(`security:containers — ${err.message}`));
    process.exit(1);
  }
  if (options.help) {
    console.log(HELP);
    process.exit(0);
  }
  const code = await runContainerScanGate(options);
  console.log(code === 0 ? green(bold('PASS')) : red(bold('FAIL')));
  console.log(dim(`  scripts/supply-chain/container-scan.mjs exit ${code}\n`));
}

#!/usr/bin/env node
/**
 * Gate: the container images this project ships are scanned for known
 * vulnerabilities.
 *
 * Invoked by `pnpm run security:containers`, and by `scripts/supply-chain/audit.mjs`.
 *
 * ## The defect this exists for
 *
 * Nine supply-chain gates examined the npm dependency graph in forensic detail —
 * denied packages, install-time lifecycle hooks, integrity hashes, release age,
 * OSV advisories, an SBOM, IOC sweeps — and **nothing looked inside the artefact
 * that actually ships**. The images were Debian bookworm-slim with a Node runtime
 * and roughly a hundred OS packages in them, none of which appear in
 * pnpm-lock.yaml and none of which any of those gates could see. A CVE in zlib or
 * perl-base was, as far as this repository's release audit was concerned, not a
 * thing that could exist.
 *
 * The first run of this gate against the then-current web image found 38 HIGH or
 * CRITICAL findings. That is not a scandal — most were Debian packages Debian had
 * marked `fix_deferred` or `will_not_fix` — but "we did not know" and "we knew
 * and decided" are different states, and only one of them is a security posture.
 * It also found eight findings with fixes available, all of them inside npm's own
 * bundled dependency tree at `/usr/local/lib/node_modules/npm`, in an image that
 * has never run npm. Both Dockerfiles now delete it.
 *
 * ## What this gate then caused
 *
 * Worth recording, because it is the point of having the gate at all. The
 * unfixable count it kept printing — 60 HIGH/CRITICAL across the two images, 14
 * distinct CVEs, every one of them from the base and none from an application
 * layer — is what moved both Dockerfiles from `node:24.18.0-bookworm-slim` to
 * `node:24.18.0-alpine3.24` on 2026-08-25: 88 OS packages down to 18, and all 60
 * findings gone. The paragraph below says "the right response to a growing number
 * is a different base image, not a bigger allowlist". That is what happened.
 *
 * The gate is OS-family agnostic and needed no change for it: it requires trivy
 * to report SOME `Metadata.OS`, not a Debian one, and Alpine's apk database is
 * deliberately left in the runtime images so trivy can still identify them.
 *
 * ## Refusing is the whole point
 *
 * A scanner that exits 0 when it did not run is worse than no scanner, because it
 * converts "nobody checked" into a green tick in a release report. So:
 *
 *   * trivy missing            → FAIL, with how to install it. Never a skip.
 *   * trivy cannot reach its
 *     vulnerability database   → FAIL. A scan against no database finds nothing,
 *                                which is indistinguishable from a clean image.
 *   * trivy did not identify
 *     the image's OS           → FAIL. It looked at something, but not at an OS
 *                                package set, so "no OS findings" means nothing.
 *   * no images to scan        → FAIL. A scan of nothing proves nothing —
 *                                repo-hygiene.mjs states the same principle.
 *
 * ## What blocks, and what is reported without blocking
 *
 * A finding blocks when it is at or above the severity floor (`--severity`,
 * default HIGH, which means HIGH and CRITICAL) **and** an upstream fix exists.
 *
 * A finding with no available fix is reported in its own section, counted, and
 * does not block. That is a deliberate trade and it deserves its reasoning
 * written down rather than assumed: the only remediation for `zlib1g
 * CVE-2023-45853`, which Debian marked `will_not_fix`, was to stop using Debian —
 * which is eventually what this project did, but not on the timescale of a build.
 * Blocking on it makes this gate permanently red through no action of this
 * project, and a permanently red gate is a gate somebody turns off — which costs
 * the fixable findings too. `--include-unfixed` makes them block, for a
 * deployment that has somewhere else to go. The Alpine images now report zero in
 * both columns, so `--include-unfixed` is currently free; if that stops being
 * true, this paragraph is the reasoning to re-read rather than re-derive.
 *
 * The cost of that choice, stated plainly: an unfixable CRITICAL in a shipped
 * image is a real vulnerability that this gate lets through. The number is printed
 * in the summary and in the JSON so it cannot be lost, and the right response to a
 * growing number is a different base image, not a bigger allowlist.
 *
 * ## The allowlist
 *
 * `container-allowlist.json`, same shape and same rules as `osv-allowlist.json`:
 * every entry needs a reason, an approver and an expiry, and the gate fails on a
 * malformed or lapsed one. An allowed finding is still printed — an exception
 * nobody can see is an exception nobody reviews.
 *
 * ## What this does NOT prove
 *
 * That the images are safe. It reports what a vulnerability database knew at the
 * moment it ran, about packages a scanner could identify. It runs `--scanners
 * vuln` only: no secret scanning, no misconfiguration scanning, no licence
 * checking. It says nothing about this project's own code, which is what the
 * other nine gates and the test suite are for. And a clean run tomorrow is not a
 * clean run today — this is why the scheduled workflow re-runs it.
 *
 * Usage:
 *     node scripts/supply-chain/container-scan.mjs [--manifest <path>]
 *                [--image <ref>]... [--severity LOW|MEDIUM|HIGH|CRITICAL]
 *                [--include-unfixed] [--allowlist <path>] [--json] [--out <file>]
 *
 * Exit codes: 0 every image scanned and nothing blocking; 1 anything else,
 * including a refusal to run. 0 for --help.
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

/**
 * Ordered weakest to strongest. `UNKNOWN` is deliberately at the bottom rather
 * than the top: trivy uses it for advisories with no vendor rating, and treating
 * an unrated finding as maximal would make the floor meaningless.
 */
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

// ---------------------------------------------------------------------------
// The allowlist
// ---------------------------------------------------------------------------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validates the allowlist and returns the entries that may suppress a finding.
 *
 * Pure, and separate from reading the file, so `container-scan.test.mjs` can feed
 * it every malformed shape without a fixture directory. Every problem is a gate
 * failure rather than a skipped entry: an allowlist the gate half-understood is
 * an allowlist that silently stopped suppressing something, and the operator
 * would find out from a red build with no explanation.
 *
 * @param {unknown} raw parsed JSON
 * @param {Date} now
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
      // Twelve characters, because "n/a" and "later" are not reasons and the
      // entire point of this file is that somebody wrote down a decision.
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

/** The allowlist entry that covers this finding, or null. */
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

// ---------------------------------------------------------------------------
// Classifying a trivy report
// ---------------------------------------------------------------------------

/**
 * Turns one trivy JSON report into findings and a verdict.
 *
 * Pure, so the tests can drive every branch — including the one that matters most,
 * "trivy produced a report that proves it did not look at anything".
 *
 * @param {{image: string, report: unknown, allowlist: Array<object>, severityFloor: string,
 *          includeUnfixed: boolean}} options
 */
export function classifyReport({ image, report, allowlist, severityFloor, includeUnfixed }) {
  const floor = SEVERITIES.indexOf(severityFloor);
  const findings = [];
  const problems = [];

  const results = Array.isArray(report?.Results) ? report.Results : [];
  // trivy reports the OS it identified in Metadata. A report without one means it
  // did not recognise a package database, so "no OS findings" is a statement about
  // trivy rather than about the image — the exact silent pass this gate refuses.
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
      // The order here is the policy: an allowlist entry wins, then the
      // fixability rule. Reversed, an allowlist entry for an unfixable finding
      // would look effective while doing nothing.
      finding.blocking = allowed === null && (fixedVersion !== null || includeUnfixed);
      findings.push(finding);
    }
  }

  return { image, findings, problems, packagesConsidered, os: os ?? null };
}

// ---------------------------------------------------------------------------
// trivy
// ---------------------------------------------------------------------------

/**
 * Phrases in trivy's stderr that mean "the vulnerability database is not usable",
 * as opposed to any other failure.
 *
 * Matching on text is unpleasant and it is the only signal available: trivy exits
 * 1 for a database failure and for an unreadable image alike, and telling an
 * operator "the scan failed" when the real problem is that they are offline sends
 * them to the wrong place. Any unrecognised failure is still a refusal, so a
 * phrase that stops matching costs a worse message and never a false pass.
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
      // Vulnerabilities only. Secret and misconfiguration scanning are useful and
      // are a different gate with a different false-positive profile; mixing them
      // in here would make one noisy gate that gets ignored instead of two that do
      // not.
      '--scanners',
      'vuln',
      '--format',
      'json',
      '--severity',
      severities,
      // trivy's own --exit-code is deliberately left at 0: this script decides what
      // blocks, using the allowlist and the fixability rule, and a non-zero exit
      // from trivy must therefore mean "the scan did not happen".
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

/** trivy's own version line, or null when it is not installed. */
function trivyVersion() {
  const result = spawnSync('trivy', ['--version', '--quiet'], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  const line = (result.stdout ?? '').split('\n').find((l) => l.startsWith('Version:'));
  return line === undefined
    ? (result.stdout ?? '').trim().split('\n')[0]
    : line.replace('Version:', '').trim();
}

// ---------------------------------------------------------------------------
// Which images
// ---------------------------------------------------------------------------

/**
 * The images to scan: the release manifest's digests, or `--image` references.
 *
 * The manifest is the default because it is the artefact that ships. Scanning
 * `prl-api:latest` would scan whatever happens to carry that tag, which is the
 * category of mistake this whole release pipeline is built to remove.
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

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

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
    /**
     * Unfixable findings counted by severity, and the distinct CRITICAL ids.
     *
     * The total on its own has already been misread. Two independent release
     * reviews of this project recorded this gate's result as "60 unfixable HIGH",
     * and the number was right while the sentence was not: 52 were HIGH and 8 were
     * CRITICAL, including a `will_not_fix` in zlib1g. "Sixty HIGH" and "eight
     * CRITICAL among sixty" are different facts to somebody deciding whether to
     * ship, and a summary that only prints the total invites the first reading.
     */
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

    // Highest first, so the sentence a reader quotes starts with the worst of it.
    const bySeverity = SEVERITIES.filter((severity) => unfixableBySeverity.has(severity))
      .reverse()
      .map((severity) => `${unfixableBySeverity.get(severity)} ${severity}`)
      .join(', ');
    report.unfixableBySeverity = Object.fromEntries(unfixableBySeverity);

    if (unfixableCriticalIds.size > 0) {
      // A separate line from the total, and above it, because an unfixable
      // CRITICAL in a shipped image is the finding most likely to be summarised
      // away — and naming it costs one line.
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
          '  clean run tomorrow, which is why the scheduled workflow runs it again.\n',
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

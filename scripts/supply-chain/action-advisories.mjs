#!/usr/bin/env node
/**
 * Gate: no pinned GitHub Action may be a version with a published advisory. Pinning to a SHA stops a
 * repointed tag but not a pinned version that later got an advisory.
 *
 * A pin resolves to a version through `git ls-remote --tags`, peeled `^{}` line included, never
 * through the trailing `# v7.0.1` comment. A gate keyed on a comment is turned green by editing it,
 * so the comment is instead checked against GitHub and a mislabelled pin fails. A SHA no tag points
 * at has no version and fails.
 *
 * The whole OSV corpus is downloaded and indexed case-insensitively. Measured on 2026-08-27, OSV's
 * version-qualified query returns `{}` for this ecosystem even inside a published range, and its
 * name query is case-sensitive (`azure/setup-kubectl` finds nothing) while `uses:` is not.
 * `ADVISORY_CONTROLS` runs through the same matcher on every invocation, so a broken corpus, ZIP
 * reader or comparator fails the gate. There is no allowlist, because the fix (repin or drop the
 * action) is always in this repository. With no network it fails, and `security:audit --offline`
 * skips it with exit 2.
 *
 * Exit codes: 0 pass, 1 a finding or an unreachable source.
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, inflateRawSync } from 'node:zlib';
import { collectActionReferences } from './ci-pinning.mjs';
import { Gate, REPO_ROOT, runGate } from './lib.mjs';

const CORPUS_URL = 'https://osv-vulnerabilities.storage.googleapis.com/GitHub%20Actions/all.zip';
const REPORT_PATH = join(REPO_ROOT, 'docs', 'sbom', 'action-advisory-report.json');

/**
 * Refuses to scan fewer references than `ci-pinning.mjs` reports. Zero is caught anywhere; a partial
 * collapse from 60 to 4 is the likelier accident. Lowered from 63 when supply-chain.yml was removed.
 */
const MINIMUM_ACTION_REFERENCES = 60;

/** Measured at 55 on 2026-08-27. Fewer means the download or ZIP reader lost entries. */
const MINIMUM_ADVISORIES = 40;

/**
 * `expect: null` means the version must produce NO finding, which catches a matcher that fires on
 * everything. Lower-case `azure/setup-kubectl` is the case-folding control.
 */
export const ADVISORY_CONTROLS = [
  { name: 'actions/download-artifact', version: '4.1.0', expect: 'GHSA-cxww-7g56-2vh6' },
  { name: 'actions/download-artifact', version: '4.1.3', expect: null },
  { name: 'tj-actions/changed-files', version: '45.0.0', expect: 'GHSA-mrrh-fwg8-r2c3' },
  { name: 'tj-actions/changed-files', version: '46.0.1', expect: null },
  { name: 'azure/setup-kubectl', version: '2.0.0', expect: 'GHSA-p756-rfxh-x63h' },
  { name: 'actions/checkout', version: '4.1.0', expect: null },
];

/**
 * A minimal ZIP reader, dependency-free like the rest of this directory. It throws rather than
 * truncating on an entry-count mismatch, an unknown compression method, ZIP64 or a CRC32 mismatch.
 */
export function readZipEntries(buffer) {
  const EOCD_SIGNATURE = 0x0605_4b50;
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= 0; offset--) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) {
      eocd = offset;
      break;
    }
  }
  if (eocd === -1) throw new Error('not a ZIP archive: no end-of-central-directory record');

  const declaredEntries = buffer.readUInt16LE(eocd + 10);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  if (declaredEntries === 0xffff || directoryOffset === 0xffff_ffff) {
    throw new Error('ZIP64 archive: this reader refuses rather than mis-parsing it');
  }

  const entries = new Map();
  let cursor = directoryOffset;
  for (let index = 0; index < declaredEntries; index++) {
    if (buffer.readUInt32LE(cursor) !== 0x0201_4b50) {
      throw new Error(`central directory entry ${index} has no header signature`);
    }
    const method = buffer.readUInt16LE(cursor + 10);
    const expectedCrc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    cursor += 46 + nameLength + extraLength + commentLength;

    if (buffer.readUInt32LE(localOffset) !== 0x0403_4b50) {
      throw new Error(`${name}: local header signature missing`);
    }
    // The local header has its own name and extra lengths, which may differ from the directory's.
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = buffer.subarray(dataStart, dataStart + compressedSize);

    let content;
    if (method === 0) content = Buffer.from(data);
    else if (method === 8) content = inflateRawSync(data);
    else throw new Error(`${name}: compression method ${method} is not supported`);

    if (crc32(content) !== expectedCrc) throw new Error(`${name}: CRC32 mismatch after decompression`);
    entries.set(name, content);
  }
  if (entries.size !== declaredEntries) {
    throw new Error(`ZIP declares ${declaredEntries} entries and ${entries.size} were read`);
  }
  return entries;
}

/**
 * Reduces an OSV package name to the `owner/repo[/path]` a `uses:` writes. The corpus has
 * `Azure/setup-kubectl`, full `https://github.com/...` URLs, and `owner/repo/sub` forms.
 */
export function normaliseActionName(name) {
  if (typeof name !== 'string') return null;
  const stripped = name
    .trim()
    .replace(/^https?:\/\//iu, '')
    .replace(/^github\.com\//iu, '')
    .replace(/\.git$/iu, '')
    .replace(/\/+$/u, '');
  return stripped === '' ? null : stripped.toLowerCase();
}

/**
 * Indexes only `GitHub Actions` affected-entries. One advisory can cover several ecosystems with
 * unrelated version lines (GHSA-69fq-xp46-6x23 covers a Go module and an action).
 */
export function buildAdvisoryIndex(records) {
  const index = new Map();
  for (const record of records) {
    if (record?.withdrawn !== undefined) continue;
    for (const entry of record?.affected ?? []) {
      if (entry?.package?.ecosystem !== 'GitHub Actions') continue;
      const key = normaliseActionName(entry.package.name);
      if (key === null) continue;
      const bag = index.get(key) ?? [];
      bag.push({ record, entry });
      index.set(key, bag);
    }
  }
  return index;
}

/** `v7.0.1` and `7.0.1` and `46` all parse; `main` and `latest` do not. */
export function parseVersion(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/^v/iu, '').split('+')[0] ?? '';
  if (trimmed === '') return null;
  const dash = trimmed.indexOf('-');
  const core = dash === -1 ? trimmed : trimmed.slice(0, dash);
  const prerelease = dash === -1 ? '' : trimmed.slice(dash + 1);
  const numbers = [];
  for (const part of core.split('.')) {
    if (!/^\d+$/u.test(part)) return null;
    numbers.push(Number(part));
  }
  return { numbers, prerelease };
}

/** Semver prerelease ordering: numeric identifiers rank below alphanumeric ones. */
function comparePrerelease(left, right) {
  const a = left.split('.');
  const b = right.split('.');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNumeric = /^\d+$/u.test(x);
    const yNumeric = /^\d+$/u.test(y);
    if (xNumeric && yNumeric) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
      continue;
    }
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Returns -1, 0, 1, or null when either side is not a version. Callers turn null into a failure.
 * Shorter versions are zero-extended, which is what `fixed: "6"` means.
 */
export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (a === null || b === null) return null;
  for (let i = 0; i < Math.max(a.numbers.length, b.numbers.length); i++) {
    const x = a.numbers[i] ?? 0;
    const y = b.numbers[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === '') return 1;
  if (b.prerelease === '') return -1;
  return comparePrerelease(a.prerelease, b.prerelease);
}

/** Returns null when the range cannot be read, and the caller fails rather than clears it. */
export function versionInRange(version, range) {
  const events = [];
  for (const event of range?.events ?? []) {
    if (typeof event.introduced === 'string') events.push({ kind: 'introduced', value: event.introduced });
    else if (typeof event.fixed === 'string') events.push({ kind: 'fixed', value: event.fixed });
    else if (typeof event.last_affected === 'string') {
      events.push({ kind: 'last_affected', value: event.last_affected });
    } else return null;
  }
  if (events.length === 0) return null;

  // `introduced: "0"` is OSV's universal lower bound, not a version.
  const ordered = events.map((event) => ({
    ...event,
    zero: event.kind === 'introduced' && event.value === '0',
  }));
  let unreadable = false;
  ordered.sort((x, y) => {
    if (x.zero || y.zero) return x.zero === y.zero ? 0 : x.zero ? -1 : 1;
    const order = compareVersions(x.value, y.value);
    if (order === null) unreadable = true;
    return order ?? 0;
  });
  if (unreadable) return null;

  let affected = false;
  for (const event of ordered) {
    if (event.zero) {
      affected = true;
      continue;
    }
    const order = compareVersions(version, event.value);
    if (order === null) return null;
    if (event.kind === 'introduced') {
      if (order >= 0) affected = true;
    } else if (event.kind === 'fixed') {
      if (order >= 0) affected = false;
    } else if (order > 0) affected = false;
  }
  return affected;
}

/** Returns null when part of the entry cannot be read. */
export function versionAffected(version, entry) {
  const listed = Array.isArray(entry?.versions) ? entry.versions : [];
  let listUnreadable = false;
  for (const candidate of listed) {
    const order = compareVersions(version, candidate);
    if (order === null) listUnreadable = true;
    else if (order === 0) return true;
  }

  const ranges = entry?.ranges ?? [];
  const readable = ranges.filter((range) => range?.type === 'ECOSYSTEM' || range?.type === 'SEMVER');
  for (const range of readable) {
    const inside = versionInRange(version, range);
    if (inside === null) return null;
    if (inside) return true;
  }

  if (listUnreadable) return null;
  // An unevaluated range type such as `GIT` is coverage that was not read, not an absence of it.
  if (readable.length !== ranges.length) return null;
  if (readable.length === 0 && listed.length === 0) return null;
  return false;
}

/**
 * Also looks up `owner/repo` for a `owner/repo/sub/dir` action, since an advisory against the
 * repository covers the action at the same commit.
 */
export function advisoriesAffecting(index, name, versions) {
  const keys = new Set();
  const normalised = normaliseActionName(name);
  if (normalised !== null) {
    keys.add(normalised);
    const parts = normalised.split('/');
    if (parts.length > 2) keys.add(parts.slice(0, 2).join('/'));
  }

  const findings = [];
  const unreadable = [];
  const seen = new Set();
  for (const key of keys) {
    for (const { record, entry } of index.get(key) ?? []) {
      for (const version of versions) {
        const affected = versionAffected(version, entry);
        if (affected === null) {
          unreadable.push({ id: record.id, name, version });
          continue;
        }
        if (!affected) continue;
        const token = `${record.id}@${version}`;
        if (seen.has(token)) continue;
        seen.add(token);
        findings.push({
          id: record.id,
          aliases: record.aliases ?? [],
          summary: record.summary ?? '(no summary)',
          severity: severityOf(record),
          version,
        });
      }
    }
  }
  return { findings, unreadable };
}

function severityOf(record) {
  const cvss = record?.severity?.find((s) => s.type?.startsWith('CVSS'));
  return record?.database_specific?.severity ?? cvss?.score ?? 'UNKNOWN';
}

/** `owner/repo[/sub]@ref`, `./local`, `docker://image@sha256:…`. */
export function parseActionReference(reference) {
  if (typeof reference !== 'string' || reference === '') return { kind: 'unreadable' };
  if (reference.startsWith('./') || reference.startsWith('.\\')) return { kind: 'local' };
  if (reference.startsWith('docker://')) return { kind: 'docker' };
  const at = reference.lastIndexOf('@');
  if (at === -1) return { kind: 'unpinned', name: reference, ref: '' };
  const name = reference.slice(0, at);
  const ref = reference.slice(at + 1);
  if (!/^[0-9a-f]{40}$/u.test(ref)) return { kind: 'unpinned', name, ref };
  const parts = name.split('/');
  if (parts.length < 2 || parts[0] === '' || parts[1] === '') return { kind: 'unreadable' };
  return { kind: 'pinned', name, repository: `${parts[0]}/${parts[1]}`, sha: ref };
}

/**
 * Maps commit SHA to tag names. For an annotated tag the peeled `^{}` line names the commit `uses:`
 * resolves to, so it wins.
 */
export function tagsByCommit(lsRemoteOutput) {
  const direct = new Map();
  const peeled = new Map();
  for (const line of lsRemoteOutput.split('\n')) {
    const match = /^([0-9a-f]{40})\s+refs\/tags\/(.+?)(\^\{\})?$/u.exec(line.trim());
    if (match === null) continue;
    const [, sha, name, isPeeled] = match;
    if (isPeeled === undefined) direct.set(name, sha);
    else peeled.set(name, sha);
  }
  const byCommit = new Map();
  for (const name of new Set([...direct.keys(), ...peeled.keys()])) {
    const sha = peeled.get(name) ?? direct.get(name);
    if (sha === undefined) continue;
    const bag = byCommit.get(sha) ?? [];
    bag.push(name);
    byCommit.set(sha, bag);
  }
  for (const bag of byCommit.values()) bag.sort();
  return byCommit;
}

/**
 * Returns only the most specific tags at a commit. `v7` beside `v7.0.1` zero-extends to 7.0.0 and
 * would invent a finding for every advisory fixed inside the current major. A tie returns both.
 */
export function versionsForTags(tags) {
  const parsed = tags
    .map((tag) => ({ tag, version: tag.replace(/^v/iu, ''), parts: parseVersion(tag)?.numbers.length ?? 0 }))
    .filter((candidate) => candidate.parts > 0);
  if (parsed.length === 0) return [];
  const deepest = Math.max(...parsed.map((candidate) => candidate.parts));
  return [...new Set(parsed.filter((c) => c.parts === deepest).map((c) => c.version))];
}

/** The `# v7.0.1` beside a pin, as a tag name, or null if the comment is not one. */
export function versionFromComment(comment) {
  if (typeof comment !== 'string') return null;
  const match = /^v?\d+(\.\d+)*(-[0-9A-Za-z.-]+)?$/u.exec(comment.trim());
  return match === null ? null : comment.trim();
}

async function fetchBuffer(url, { timeoutMs = 45_000, retries = 2 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (err) {
      lastError = err;
      if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** attempt));
    }
  }
  throw lastError;
}

/**
 * Two retries so one dropped TLS handshake does not turn the gate red. A repository that is really
 * unreachable still fails.
 */
function lsRemoteTags(repository) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return execFileSync('git', ['ls-remote', '--tags', `https://github.com/${repository}`], {
        encoding: 'utf8',
        timeout: 60_000,
        maxBuffer: 32 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
        // A deleted or renamed repository would otherwise become a credential prompt or a CI hang.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true' },
      });
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

/** The every-invocation negative control. Returns problems; empty means every control behaved. */
export function runAdvisoryControls(index) {
  const problems = [];
  for (const control of ADVISORY_CONTROLS) {
    const { findings, unreadable } = advisoriesAffecting(index, control.name, [control.version]);
    const ids = findings.map((finding) => finding.id);
    if (unreadable.length > 0) {
      problems.push(
        `${control.name}@${control.version}: ${unreadable.length} advisory range(s) could not be evaluated`,
      );
      continue;
    }
    if (control.expect === null) {
      if (ids.length > 0) {
        problems.push(`${control.name}@${control.version} is not affected and the matcher reported ${ids}`);
      }
      continue;
    }
    if (!ids.includes(control.expect)) {
      problems.push(
        `${control.name}@${control.version} must match ${control.expect} and the matcher reported ` +
          `${ids.length === 0 ? 'nothing' : ids.join(', ')}`,
      );
    }
  }
  return problems;
}

function runActionAdvisoryGate() {
  const gate = new Gate('pinned-action-advisories');
  return runGate(gate, async () => {
    const references = collectActionReferences(REPO_ROOT);
    if (references.length < MINIMUM_ACTION_REFERENCES) {
      gate.fail(
        `found ${references.length} action reference(s); this gate refuses to run below ${MINIMUM_ACTION_REFERENCES}`,
        'ci-pinning.mjs reported 60 across 3 workflows when this floor was last set, and both gates read ' +
          'them with the same `uses:` regex through the same discovery. A smaller number means the parse ' +
          'stopped matching, not that the repository stopped using actions — and a sweep of nothing, or ' +
          'of four things out of sixty, reports the same green as a sweep that found everything. ' +
          'If the repository legitimately uses fewer actions now, lower the floor in the same diff.',
      );
      return;
    }

    /** @type {Map<string, {sha: string, repository: string, name: string, at: string[], comments: Set<string>}>} */
    const pinned = new Map();
    for (const reference of references) {
      const parsed = parseActionReference(reference.reference);
      if (parsed.kind === 'local' || parsed.kind === 'docker') continue;
      if (parsed.kind !== 'pinned') {
        // Unreachable in a passing build, since `ci-pinning.mjs` fails on it first.
        gate.fail(
          `cannot check advisories for an unpinned action at ${reference.at}: ${reference.reference}`,
          'a version can only be established for a reference pinned to a full commit SHA; see ci-pinning.mjs',
        );
        continue;
      }
      const key = `${parsed.name}@${parsed.sha}`;
      const existing = pinned.get(key) ?? {
        sha: parsed.sha,
        repository: parsed.repository,
        name: parsed.name,
        at: [],
        comments: new Set(),
      };
      existing.at.push(reference.at);
      if (reference.comment !== null) existing.comments.add(reference.comment);
      pinned.set(key, existing);
    }

    if (pinned.size === 0) {
      gate.fail(
        'no pinned third-party action references to check',
        'every `uses:` in this repository resolved to a local or container action, which has never been ' +
          'true here. A scan of nothing proves nothing.',
      );
      return;
    }

    let index;
    let advisoryCount = 0;
    try {
      const archive = await fetchBuffer(CORPUS_URL);
      const records = [];
      for (const [name, bytes] of readZipEntries(archive)) {
        if (!name.endsWith('.json')) continue;
        records.push(JSON.parse(bytes.toString('utf8')));
      }
      advisoryCount = records.length;
      index = buildAdvisoryIndex(records);
    } catch (err) {
      gate.fail(
        `the GitHub Actions advisory corpus could not be read: ${err?.message ?? err}`,
        `${CORPUS_URL}\n      This gate fails rather than skipping, and that direction is deliberate: an ` +
          'advisory database that cannot be reached means every pinned action is UNKNOWN, and unknown is ' +
          'not clean. If the network is genuinely unavailable, `security:audit --offline` skips this gate ' +
          'by name and exits 2 — an audit that did not run its gates has not passed.',
      );
      return;
    }

    if (advisoryCount < MINIMUM_ADVISORIES) {
      gate.fail(
        `the advisory corpus holds ${advisoryCount} record(s); this gate refuses to trust fewer than ${MINIMUM_ADVISORIES}`,
        'measured at 55 on 2026-08-27. A published ecosystem does not shrink by a third, so this is a ' +
          'truncated download or a ZIP reader that lost entries — and a corpus missing the one advisory ' +
          'that mattered looks exactly like a clean run.',
      );
      return;
    }
    gate.note(`${advisoryCount} GitHub Actions advisories from OSV; ${index.size} distinct action(s) named`);

    const controlProblems = runAdvisoryControls(index);
    if (controlProblems.length > 0) {
      for (const problem of controlProblems) {
        gate.fail(`advisory control failed: ${problem}`, undefined);
      }
      gate.fail(
        'the negative controls did not behave, so this run proves nothing about the real references',
        'ADVISORY_CONTROLS are real actions at real versions with real published advisories, matched by ' +
          'the same code the real references go through. A failure here is either a broken matcher — in ' +
          'which case a green tick over the real actions would have been meaningless — or an upstream ' +
          'change to the advisory itself, in which case re-read it on osv.dev and update the table in a ' +
          'reviewed diff. Do not delete a row to get a pass.',
      );
      return;
    }
    gate.note(`${ADVISORY_CONTROLS.length} advisory controls behaved (matcher and corpus both live)`);

    /** @type {Map<string, Map<string, string[]>>} */
    const tagsByRepository = new Map();
    for (const entry of pinned.values()) {
      if (tagsByRepository.has(entry.repository)) continue;
      try {
        tagsByRepository.set(entry.repository, tagsByCommit(lsRemoteTags(entry.repository)));
      } catch (err) {
        gate.fail(
          `could not read the tags of ${entry.repository}: ${err?.message ?? err}`,
          'the pinned SHA is resolved to a version by asking GitHub which tags point at it, never by ' +
            'reading the trailing comment. With the tag graph unavailable there is no version, so there ' +
            'is no advisory range to evaluate, so this refuses rather than clearing the reference.',
        );
        tagsByRepository.set(entry.repository, null);
      }
    }

    const report = [];
    for (const entry of [...pinned.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      const where = entry.at.join(', ');
      const byCommit = tagsByRepository.get(entry.repository);
      if (byCommit === null || byCommit === undefined) continue; // already failed above

      const tags = byCommit.get(entry.sha) ?? [];
      if (tags.length === 0) {
        gate.fail(
          `no tag of ${entry.repository} points at the pinned commit ${entry.sha.slice(0, 12)} (${where})`,
          'a commit that is not a tagged release has no version, and an advisory range cannot be ' +
            'evaluated against nothing. This is a refusal, not a finding: pin the SHA that ' +
            `refs/tags/<release> resolves to. \`git ls-remote --tags https://github.com/${entry.repository}\` ` +
            'lists them, and the `^{}` line is the commit an annotated tag dereferences to.',
        );
        continue;
      }

      // The trailing comment is a claim, checked against GitHub. It is never the key.
      for (const comment of entry.comments) {
        const claimed = versionFromComment(comment);
        if (claimed === null) continue;
        const matches = tags.some((tag) => tag.toLowerCase() === claimed.toLowerCase());
        if (matches) continue;
        gate.fail(
          `${entry.name} is labelled \`# ${comment}\` and GitHub says that commit is ${tags.join(', ')} (${where})`,
          'the pin and its label disagree. The version this gate checks comes from GitHub, so the ' +
            'advisory result is still sound — but every reviewer who reads that line afterwards is being ' +
            'told the wrong thing about what runs in CI, and a mislabelled pin is how an unreviewed bump ' +
            'passes review. Correct the comment, or the SHA.',
        );
      }

      const versions = versionsForTags(tags);
      if (versions.length === 0) {
        gate.fail(
          `the tags at ${entry.name}@${entry.sha.slice(0, 12)} name no version: ${tags.join(', ')} (${where})`,
          'every tag on that commit is a name this gate cannot read as a version, so no advisory range ' +
            'applies to it and none was evaluated. Pin a numbered release.',
        );
        continue;
      }

      const { findings, unreadable } = advisoriesAffecting(index, entry.name, versions);
      report.push({ action: entry.name, sha: entry.sha, tags, versions, at: entry.at, findings });

      for (const item of unreadable) {
        gate.fail(
          `${item.id} names ${entry.name} in a shape this gate cannot evaluate against ${item.version} (${where})`,
          'an advisory whose ranges could not be read is not an advisory that cleared this action. Read ' +
            `it at https://osv.dev/vulnerability/${item.id} and teach \`versionAffected\` its shape.`,
        );
      }
      for (const finding of findings) {
        gate.fail(
          `${finding.id} affects ${entry.name}@${finding.version} severity=${finding.severity} (${where})`,
          `${finding.summary}\n      pinned commit ${entry.sha}, tagged ${tags.join(', ')}\n` +
            `      https://osv.dev/vulnerability/${finding.id}\n` +
            '      There is no allowlist: repin to a fixed release, or stop using the action.',
        );
      }
    }

    gate.note(
      `${references.length} action reference(s) over ${pinned.size} distinct pin(s) in ` +
        `${tagsByRepository.size} repository(ies), each resolved to a version by git ls-remote`,
    );

    writeFileSync(
      REPORT_PATH,
      `${JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          source: CORPUS_URL,
          advisoriesLoaded: advisoryCount,
          referencesScanned: references.length,
          actions: report,
        },
        null,
        2,
      )}\n`,
    );
    gate.note('report written to docs/sbom/action-advisory-report.json');
  });
}

if (import.meta.main) await runActionAdvisoryGate();

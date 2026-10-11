#!/usr/bin/env node
/**
 * Gate: no pinned GitHub Action may be a version with a published advisory.
 *
 * ## Why this gate exists
 *
 * `ci-pinning.mjs` proves every `uses:` in this repository is a full 40-character
 * commit SHA, which stops the attack it was written for: a tag is a pointer its
 * owner — or whoever compromises them — can repoint at new code that then runs in
 * this repository's CI, and `docs/security/shai-hulud-snapshot-2026-08-17.md` §1
 * lists **GitHub Actions** among the supply chains that campaign compromised while
 * §2 says it hijacks workflows to mint publish tokens.
 *
 * But pinning is not safety. **A pinned SHA of a version that was later found
 * vulnerable stays pinned, and stays vulnerable, silently and for ever.** Nothing
 * in this repository re-checked that surface: `osv-scan.mjs` queries the `npm`
 * ecosystem only, and `container-scan.mjs` reads the Alpine package database in
 * the built images — which is how CVE-2026-14456 was caught, and is also why the
 * gap was easy to mistake for coverage. `docs/VERIFICATION.md` said in as many
 * words that an advisory against a pinned action "still reaches this repository
 * only through a person". This is the gate that changes that sentence.
 *
 * It runs inside `security:audit`, so on every push (ci.yml) and every release.
 * Until 2026-10-11 `.github/workflows/supply-chain.yml` also ran it daily against
 * the unchanged repository; the owner removed that workflow. An advisory published
 * against a pin nobody touches is now caught at the next push, or sooner by
 * Dependabot security updates, if enabled in the repository settings — not by this gate.
 *
 * ## Resolving a pinned SHA to a version, without trusting the comment
 *
 * OSV's `GitHub Actions` ecosystem is keyed on `owner/repo` plus a **version
 * range** — measured, from the published corpus: 55 advisories carrying 64
 * affected-entries in that ecosystem, 63 of them a `ranges[].type: ECOSYSTEM` over
 * version strings and the last a bare `versions: ["1"]` list. **Not one is keyed on
 * a commit** — there is no `GIT` range anywhere in it. So an advisory source that
 * exists is only usable here if a pinned SHA can be turned into a version.
 *
 * The obvious key is the trailing comment this repository already writes —
 * `uses: actions/checkout@3d3c42e5… # v7.0.1`. **It is not used as the key, and
 * that is the central decision in this file.** The comment is a human-maintained
 * label sitting beside the thing it labels; nothing verifies it; and a gate whose
 * answer comes from a comment can be turned green by editing the comment. Keying
 * a security check on the one part of the line an attacker (or a careless rebase)
 * can change without changing what runs would be decoration.
 *
 * What is authoritative is GitHub's own tag graph. `git ls-remote --tags <repo>`
 * returns every tag with the commit it resolves to — including the `^{}` peeled
 * line that dereferences an annotated tag to its commit, which is exactly what
 * `uses:` resolves. Measured against this repository's four pinned actions:
 *
 *     3d3c42e5aac5ba805825da76410c181273ba90b1  refs/tags/v7
 *     3d3c42e5aac5ba805825da76410c181273ba90b1  refs/tags/v7.0.1
 *
 * So the pinned commit *is* v7.0.1, established by asking GitHub rather than by
 * reading a comment. It needs no token, has no API rate limit, and took 0.75 s.
 *
 * The comment is then used for the one thing it is good for: it is a **claim to
 * be checked**. A trailing `# v7.0.1` beside a SHA that GitHub says is some other
 * version is a release-blocking failure here — the pin and its label disagree, and
 * every reviewer who reads that line afterwards is being told the wrong thing
 * about what runs in CI. A comment that merely says nothing is a note, because the
 * version never came from it.
 *
 * ## Where a version cannot be determined, this refuses
 *
 * A pinned SHA that no tag points at — a branch head, a commit between releases —
 * has no version, so no advisory range can be evaluated against it. That is a
 * FAILURE, not a pass, for the reason `ci-pinning.mjs` had to learn twice: "I
 * could not read it" and "I read it and it was fine" must not produce the same
 * exit code. The remedy is to pin the SHA of a tagged release.
 *
 * ## Why the corpus is downloaded whole, rather than queried per action
 *
 * OSV's query API serves this ecosystem in a shape that cannot be used, and the
 * shape is quiet about it. Measured against `api.osv.dev` on 2026-08-27, with
 * `canonical/get-workflow-version-action`, whose only advisory covers everything
 * below 1.0.1:
 *
 *   | `{"package":{…,"ecosystem":"GitHub Actions"},"version":"1.0.0"}` | `{}` |
 *   | the same query with no `version` key                             | the advisory |
 *   | `{"package":{"name":"lodash","ecosystem":"npm"},"version":"4.17.15"}` | 6 advisories |
 *   | `{"package":{…,"ecosystem":"NotARealEcosystem"},…}`              | `invalid ecosystem` |
 *
 * A version-qualified query returns an empty result for a version squarely inside
 * a published range. The ecosystem is real — a garbage one is rejected outright —
 * so a gate built on `querybatch`, the way `osv-scan.mjs` is, would have queried
 * successfully, matched nothing, ever, and printed a green tick over an empty
 * answer. That is the exact failure this directory keeps finding in itself, and it
 * was one API call away from being shipped again.
 *
 * The second measurement rules out the name-only query as a workaround:
 *
 *   | `{"package":{"name":"Azure/setup-kubectl",…}}` | GHSA-p756-rfxh-x63h |
 *   | `{"package":{"name":"azure/setup-kubectl",…}}` | `{}`                |
 *
 * The API is **case-sensitive on the action name while GitHub is not**, so
 * `uses: azure/setup-kubectl@…` — which runs perfectly well — would be checked
 * against nothing. Downloading the ecosystem's published corpus and indexing it
 * case-insensitively removes both problems, costs one HTTP request, and has the
 * property the per-name route cannot have: the gate can assert that its advisory
 * source is **non-empty**, so a source that goes quiet fails the build instead of
 * clearing every action in the repository.
 *
 * ## The negative control runs on every invocation
 *
 * `ADVISORY_CONTROLS` below is a table of real actions at real versions with real
 * published advisories, run through the same matcher the real references go
 * through, on every run. Each must produce its advisory, and the not-affected rows
 * must produce nothing. A corpus that arrives empty, a ZIP reader that drops
 * entries, a version comparator that stops comparing, an index that loses its
 * case-folding — every one of those turns the gate green over nothing, and every
 * one of them is caught here instead. It is the same posture as `test:layout`'s
 * injected stylesheets: a detector that stops working fails the gate rather than
 * going quiet.
 *
 * These rows are pinned to live upstream data on purpose. If an advisory is
 * withdrawn or its range revised, this gate goes red and a person re-reads the
 * advisory and updates the table in a reviewed diff. That is the correct direction
 * for a change in what the security database says.
 *
 * ## There is no allowlist
 *
 * `osv-scan.mjs` has one because a transitive npm dependency can be affected with
 * no fixed version available and nothing this repository can do about it. An
 * action reference is not that: it is one line in a workflow this repository owns,
 * and the remedy — repin to a fixed release, or stop using the action — is always
 * directly available. If that ever stops being true, add the allowlist then, with
 * expiry, the way the OSV one has it. Do not add a flag.
 *
 * ## Offline
 *
 * This is a network gate. `security:audit --offline` skips it and exits **2**,
 * which is the existing contract: an audit that did not run its gates has not
 * passed. Run standalone with no network, it FAILS — it does not skip, and it does
 * not pass. The safe direction here is red: an unreachable advisory database means
 * "unknown", and unknown is not clean.
 *
 * Usage:
 *     node scripts/supply-chain/action-advisories.mjs
 *
 * Exit codes: 0 pass, 1 a finding or an unreachable source.
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, inflateRawSync } from 'node:zlib';
import { collectActionReferences } from './ci-pinning.mjs';
import { Gate, REPO_ROOT, runGate } from './lib.mjs';

/** The published OSV corpus for the ecosystem, as one object. */
const CORPUS_URL = 'https://osv-vulnerabilities.storage.googleapis.com/GitHub%20Actions/all.zip';
const REPORT_PATH = join(REPO_ROOT, 'docs', 'sbom', 'action-advisory-report.json');

/**
 * The floor `ci-pinning.mjs` reports today, and the number this gate refuses to
 * scan below.
 *
 * A sweep of nothing is not a pass, and the way this one would go quiet is
 * specific: both gates find their references with the same `uses:` regex over the
 * same discovery, so a parse that stops matching — a YAML style change, a renamed
 * workflow directory, a `collectActionReferences` that returns `[]` — produces a
 * green tick over zero actions. Zero is caught by any non-empty assertion; a
 * partial collapse from 60 to 4 is not, and is the likelier accident.
 *
 * It was 63 until 2026-10-11, when removing supply-chain.yml took its three
 * references with it; lowered in that same diff, as the refusal below asks.
 */
const MINIMUM_ACTION_REFERENCES = 60;

/**
 * Measured at 55 on 2026-08-27. A published ecosystem does not shrink by a third;
 * a number below this means the download or the ZIP reader lost entries, and a
 * corpus that quietly lost the advisory covering an action in this repository is
 * indistinguishable from a clean run.
 */
const MINIMUM_ADVISORIES = 40;

/**
 * Real actions, real versions, real published advisories — run through the same
 * matcher as the real references on every invocation. See the header.
 *
 * `expect: null` means "this exact version must produce NO finding", which is the
 * half that catches a matcher that has started firing on everything. The
 * deliberately lower-cased `azure/setup-kubectl` is the case-folding control: the
 * advisory is published against `Azure/setup-kubectl`, GitHub resolves `uses:`
 * case-insensitively, and OSV's own query API does not.
 */
export const ADVISORY_CONTROLS = [
  { name: 'actions/download-artifact', version: '4.1.0', expect: 'GHSA-cxww-7g56-2vh6' },
  { name: 'actions/download-artifact', version: '4.1.3', expect: null },
  { name: 'tj-actions/changed-files', version: '45.0.0', expect: 'GHSA-mrrh-fwg8-r2c3' },
  { name: 'tj-actions/changed-files', version: '46.0.1', expect: null },
  { name: 'azure/setup-kubectl', version: '2.0.0', expect: 'GHSA-p756-rfxh-x63h' },
  { name: 'actions/checkout', version: '4.1.0', expect: null },
];

// ---------------------------------------------------------------------------
// Reading the corpus
// ---------------------------------------------------------------------------

/**
 * A minimal ZIP reader over the central directory.
 *
 * Hand-rolled for the reason the rest of this directory is dependency-free: an
 * auditor that installs a package to do its job is checking the thing it depends
 * on. The risk of a hand-rolled parser is that it silently drops entries, so it
 * refuses rather than truncates at every point it could: an entry count that does
 * not match the directory header, a compression method it does not implement, a
 * ZIP64 marker, or a CRC32 that does not match the inflated bytes all throw. The
 * advisory-count floor and the controls above are the other two nets under it.
 *
 * @param {Buffer} buffer
 * @returns {Map<string, Buffer>} entry name to uncompressed bytes
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
    // The local header carries its OWN name and extra lengths, which may differ
    // from the central directory's; reading the directory's would land the data
    // pointer in the middle of the payload.
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
 * An OSV package name reduced to the `owner/repo[/path]` form a `uses:` writes.
 *
 * The corpus contains all three spellings in the wild — `Azure/setup-kubectl`,
 * `https://github.com/pytorch/pytorch/.github/actions/filter-test-configs`, and
 * `super-linter/super-linter/slim` — so a lookup keyed on the literal string
 * would miss two of them.
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
 * Case-insensitive index from action name to the advisory entries about it.
 *
 * Only `GitHub Actions` affected-entries are indexed: a single advisory can carry
 * entries for several ecosystems — GHSA-69fq-xp46-6x23 covers `aquasecurity/trivy`
 * the Go module and `aquasecurity/trivy-action` the action, and their version
 * lines are unrelated.
 *
 * @param {Array<object>} records
 * @returns {Map<string, Array<{record: object, entry: object}>>}
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

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

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
 * `-1`, `0`, `1` — or **null** when either side cannot be read as a version.
 *
 * Null is not "equal" and not "less than". Every caller propagates it up to a
 * gate failure, because a comparison that did not happen must not read as a
 * comparison that came out clean. Shorter versions are zero-extended, which is
 * what the advisory database means by `fixed: "6"`.
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

/**
 * Is `version` inside one OSV range? `null` means the range could not be read,
 * which its caller turns into a failure rather than a "no".
 */
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

  // `introduced: "0"` is OSV's universal lower bound and is not a version, so it
  // is sorted first by construction rather than by comparison.
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

/**
 * Is `version` covered by one advisory's affected-entry? `null` means part of the
 * entry could not be read, and the caller must refuse rather than clear it.
 */
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
  // A range type this gate does not evaluate — `GIT`, or something new — is not
  // an absence of coverage, it is coverage that was not read.
  if (readable.length !== ranges.length) return null;
  if (readable.length === 0 && listed.length === 0) return null;
  return false;
}

/**
 * Every advisory in the index that covers any of `versions` of `name`.
 *
 * Looked up under the full `owner/repo/sub/dir` and under `owner/repo`, because
 * an advisory published against the repository covers the action in its
 * subdirectory too — it is the same commit.
 *
 * @returns {{findings: Array<object>, unreadable: Array<object>}}
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

// ---------------------------------------------------------------------------
// Resolving a pinned SHA to a version
// ---------------------------------------------------------------------------

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
 * `git ls-remote --tags` output as commit SHA to the tag names that resolve to it.
 *
 * An ANNOTATED tag has two lines: the tag object under `refs/tags/x` and the
 * commit it dereferences to under `refs/tags/x^{}`. `uses:` resolves to the
 * commit, so the peeled line wins wherever there is one. Reading only the first
 * line would leave every annotated release looking like an unknown SHA — and this
 * gate treats an unknown SHA as a failure, so the mistake would be loud rather
 * than silent, but it would be loud on every correctly pinned action.
 *
 * @returns {Map<string, string[]>}
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
 * Which of the tags at a commit name the version that commit IS.
 *
 * `actions/checkout@3d3c42e5…` carries both `v7` and `v7.0.1`, because the
 * major-version alias currently points at the same commit as the release. They
 * are not equally good answers and taking both would be actively wrong: an
 * advisory reading `introduced: 0, fixed: 7.0.1` does not affect this pin, but it
 * does "affect" the string `7` — which zero-extends to 7.0.0 — so checking the
 * alias as well would invent a finding for every advisory ever fixed inside the
 * current major. The most specific tag is the release; the shorter ones are other
 * names for it.
 *
 * A tie at maximum specificity (a commit carrying two full releases) is genuinely
 * ambiguous and both are returned, so the gate reports if either is affected.
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

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

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
 * Retried twice, and that is not a softening of the refusal below: a repository
 * that is genuinely unreachable is still unreachable on the third attempt and
 * still fails the gate. What it buys is that one dropped TLS handshake does not
 * turn the release gate red for a reason nobody can reproduce, which is how a
 * gate earns the reputation that gets it waived.
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
        // Without this a repository that has been deleted or renamed turns into a
        // credential prompt on a TTY and a hang in CI, rather than an error.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true' },
      });
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

/**
 * The every-invocation negative control. See the header.
 *
 * @returns {string[]} problems; empty means every control behaved
 */
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
    // --- the references, and the floor under them -------------------------
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
        // Unreachable in a passing build — `ci-pinning.mjs` fails on exactly this
        // — and stated anyway, because "could not read it" must never share an
        // exit code with "read it and it was clean".
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

    // --- the advisory corpus ----------------------------------------------
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

    // --- the control, before any verdict ----------------------------------
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

    // --- resolve every pin to a version, from GitHub -----------------------
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

      // The trailing comment is a claim, checked against GitHub — never the key.
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

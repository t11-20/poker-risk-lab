#!/usr/bin/env node
/**
 * Tests for the `pinned-action-advisories` gate.
 *
 * Run with:  node --test scripts/supply-chain/action-advisories.test.mjs
 *
 * Hermetic on purpose. The gate itself is a network gate, but this file runs
 * inside `pnpm run test` — and therefore inside `verify` and on every push — so
 * every case here feeds fixture advisories to the exported matcher rather than
 * asking OSV. The live half is covered by the gate's own `ADVISORY_CONTROLS`,
 * which run on every invocation of the gate against the real corpus.
 *
 * ## Would these fail if the behaviour broke, and how was that checked?
 *
 * The gate was run against the real repository with one deliberate defect at a
 * time, and the whole run recorded. All eight fired:
 *
 *   | one `uses: actions/download-artifact@018cc2cf… # v6.0.0` repinned to
 *     `f44cd7b4… # v4.1.0`, a real release with a real published advisory
 *                                        | ✗ GHSA-cxww-7g56-2vh6 … severity=HIGH, exit 1 |
 *   | the correct checkout SHA relabelled `# v9.9.9`
 *                                        | ✗ labelled `# v9.9.9` and GitHub says v7, v7.0.1, exit 1 |
 *   | checkout repinned to the head of `main`, a real commit no tag names
 *                                        | ✗ no tag … points at the pinned commit, exit 1 |
 *   | every HTTP request sent to a dead proxy
 *                                        | ✗ the advisory corpus could not be read, exit 1 |
 *   | `git` alone sent to a dead proxy    | ✗ could not read the tags of …, exit 1 |
 *   | the reference floor raised to 64    | ✗ found 63 … refuses to run below 64, exit 1 |
 *     (measured when there were 63; since 2026-10-11 there are 60 and the floor is 60)
 *   | the corpus floor raised to 999      | ✗ holds 55 record(s) … refuses fewer than 999, exit 1 |
 *   | `actions/upload-artifact` pinned to a real SHA belonging to `actions/checkout`
 *                                        | ✗ no tag of actions/upload-artifact points at it, exit 1 |
 *
 * The important one is the first: it is a real advisory (arbitrary file write via
 * artifact extraction, HIGH) against a real version of an action this repository
 * really uses, resolved from the pinned SHA by asking GitHub — not by reading the
 * trailing comment, which in that run said `v4.1.0` and was believed by nothing.
 *
 * ## The case this file exists to hold
 *
 * `versionsForTags` is where a plausible implementation invents findings. The
 * pinned checkout commit carries BOTH `v7` and `v7.0.1`, because the major alias
 * currently points at the release. Checking both would make every advisory ever
 * fixed inside the current major fire against a pin that is not affected, because
 * the string `7` zero-extends to 7.0.0. A gate that cries wolf gets waived.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import {
  ADVISORY_CONTROLS,
  advisoriesAffecting,
  buildAdvisoryIndex,
  compareVersions,
  normaliseActionName,
  parseActionReference,
  parseVersion,
  readZipEntries,
  runAdvisoryControls,
  tagsByCommit,
  versionAffected,
  versionFromComment,
  versionInRange,
  versionsForTags,
} from './action-advisories.mjs';
import {
  checkWorkflowPinning,
  collectActionReferences,
  discoverLocalActionFiles,
  listWorkflowFiles,
} from './ci-pinning.mjs';
import { Gate, REPO_ROOT } from './lib.mjs';

const temporary = [];
after(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'prl-action-advisories-'));
  temporary.push(dir);
  return dir;
}

const range = (...events) => ({ type: 'ECOSYSTEM', events });
const advisory = (id, name, ranges, extra = {}) => ({
  id,
  summary: `${id} summary`,
  affected: [{ package: { name, ecosystem: 'GitHub Actions' }, ranges }],
  ...extra,
});

describe('the reference set this gate scans', () => {
  it('reads exactly what ci-pinning.mjs judges, and it is not empty', () => {
    // Both gates have to see the same references or one of them is quietly
    // scanning less than it claims. This is the positive control: it compares the
    // collector against the gate's own counter over the real workflows, so a
    // collector that stopped matching cannot agree with it by also being empty.
    const collected = collectActionReferences(REPO_ROOT);
    assert.ok(collected.length >= 60, `only ${collected.length} action references collected`);

    let judged = 0;
    const gate = new Gate('counting');
    const workflowDir = join(REPO_ROOT, '.github', 'workflows');
    for (const name of listWorkflowFiles(workflowDir)) {
      judged += checkWorkflowPinning(gate, name, readFileSync(join(workflowDir, name), 'utf8'));
    }
    for (const rel of discoverLocalActionFiles(REPO_ROOT)) {
      judged += checkWorkflowPinning(gate, rel, readFileSync(join(REPO_ROOT, rel), 'utf8'));
    }
    assert.equal(collected.length, judged, 'the advisory gate and the pinning gate disagree on the set');
  });

  it('captures the trailing version comment beside each pin', () => {
    const withComment = collectActionReferences(REPO_ROOT).filter((r) => r.comment !== null);
    assert.ok(withComment.length > 0, 'no trailing comments were captured at all');
    assert.ok(
      withComment.every((r) => versionFromComment(r.comment) !== null),
      'a captured comment did not read as a version',
    );
  });

  it('finds a reference in a local action file, not only in workflows', () => {
    const root = scratch();
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
    mkdirSync(join(root, '.github', 'actions', 'thing'), { recursive: true });
    writeFileSync(
      join(root, '.github', 'workflows', 'ci.yml'),
      'jobs:\n  a:\n    steps:\n      - uses: ./x\n',
    );
    writeFileSync(
      join(root, '.github', 'actions', 'thing', 'action.yml'),
      'runs:\n  steps:\n    - uses: actions/checkout@abc # v1.2.3\n',
    );
    const found = collectActionReferences(root);
    assert.deepEqual(
      found.map((r) => [r.reference, r.comment]),
      [
        ['./x', null],
        ['actions/checkout@abc', 'v1.2.3'],
      ],
    );
  });
});

describe('reading a uses: reference', () => {
  it('separates the pinned, the local, the container and the unpinned', () => {
    assert.deepEqual(parseActionReference('./.github/actions/x'), { kind: 'local' });
    assert.deepEqual(parseActionReference('docker://alpine@sha256:00'), { kind: 'docker' });
    assert.equal(parseActionReference('actions/checkout@v7').kind, 'unpinned');
    assert.equal(parseActionReference('actions/checkout').kind, 'unpinned');
    assert.equal(parseActionReference('actions/checkout@abc123').kind, 'unpinned');
    const pinned = parseActionReference(`actions/checkout@${'a'.repeat(40)}`);
    assert.deepEqual(pinned, {
      kind: 'pinned',
      name: 'actions/checkout',
      repository: 'actions/checkout',
      sha: 'a'.repeat(40),
    });
  });

  it('keeps the subdirectory in the name and the repository without it', () => {
    const parsed = parseActionReference(`super-linter/super-linter/slim@${'b'.repeat(40)}`);
    assert.equal(parsed.name, 'super-linter/super-linter/slim');
    assert.equal(parsed.repository, 'super-linter/super-linter');
  });
});

describe('resolving a commit to the version it is', () => {
  const LS_REMOTE = [
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/tags/v7',
    'ffffffffffffffffffffffffffffffffffffffff\trefs/tags/v6.0.0',
    '1111111111111111111111111111111111111111\trefs/tags/v6.1.0',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/tags/v6.1.0^{}',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/tags/v7.0.1',
    'not a ref line at all',
  ].join('\n');

  it('prefers the peeled commit of an annotated tag over the tag object', () => {
    const byCommit = tagsByCommit(LS_REMOTE);
    // v6.1.0 is annotated: its tag OBJECT is 1111…, the commit it dereferences to
    // is aaaa…, and `uses:` resolves to the commit. Reading the unpeeled line
    // would leave every annotated release looking like an unknown SHA.
    assert.deepEqual(byCommit.get('a'.repeat(40)), ['v6.1.0', 'v7', 'v7.0.1']);
    assert.equal(byCommit.get('1'.repeat(40)), undefined);
    assert.deepEqual(byCommit.get('f'.repeat(40)), ['v6.0.0']);
  });

  it('takes the most specific tag and NOT the moving major alias (REGRESSION)', () => {
    // The pin is v7.0.1; `v7` is another name for the same commit today. Reading
    // `7` as a version too would zero-extend it to 7.0.0 and make any advisory
    // "fixed in 7.0.1" fire against a pin that is not affected.
    assert.deepEqual(versionsForTags(['v7', 'v7.0.1']), ['7.0.1']);
    assert.deepEqual(versionsForTags(['v6', 'v6.0', 'v6.0.0']), ['6.0.0']);
    // A genuine tie is ambiguous and both are checked.
    assert.deepEqual(versionsForTags(['v1.2.3', 'v1.2.4']).sort(), ['1.2.3', '1.2.4']);
    // Nothing readable is not "no advisories", and the gate refuses on an empty list.
    assert.deepEqual(versionsForTags(['latest', 'stable']), []);
  });

  it('reads a version comment only when it really is one', () => {
    assert.equal(versionFromComment('v7.0.1'), 'v7.0.1');
    assert.equal(versionFromComment(' 4.1.0 '), '4.1.0');
    assert.equal(versionFromComment('pinned by hand, see ADR 0007'), null);
    assert.equal(versionFromComment(null), null);
  });
});

describe('comparing versions', () => {
  it('zero-extends the short forms the advisory database actually publishes', () => {
    // `fixed: "6"`, `fixed: "41"` and `fixed: "17"` are all real entries.
    assert.equal(compareVersions('5.9.9', '6'), -1);
    assert.equal(compareVersions('6.0.0', '6'), 0);
    assert.equal(compareVersions('6.0.1', '6'), 1);
    assert.equal(compareVersions('v7.0.1', '7.0.1'), 0);
  });

  it('orders prereleases below their release', () => {
    assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), -1);
    assert.equal(compareVersions('1.0.0-rc.2', '1.0.0-rc.10'), -1);
    assert.equal(compareVersions('1.0.0-alpha', '1.0.0-beta'), -1);
  });

  it('returns null rather than a verdict for anything it cannot read', () => {
    // Null is the whole safety property: it is not "equal" and not "less than",
    // and every caller turns it into a gate failure.
    assert.equal(compareVersions('main', '1.0.0'), null);
    assert.equal(compareVersions('1.0.0', 'latest'), null);
    assert.equal(parseVersion(''), null);
    assert.equal(parseVersion('v'), null);
  });
});

describe('evaluating an advisory range', () => {
  it('handles introduced/fixed, the universal lower bound, and last_affected', () => {
    const introducedFixed = range({ introduced: '4.0.0' }, { fixed: '4.1.3' });
    assert.equal(versionInRange('3.9.9', introducedFixed), false);
    assert.equal(versionInRange('4.0.0', introducedFixed), true);
    assert.equal(versionInRange('4.1.2', introducedFixed), true);
    assert.equal(versionInRange('4.1.3', introducedFixed), false);

    const everythingBelow = range({ introduced: '0' }, { fixed: '2.16.0' });
    assert.equal(versionInRange('0.0.1', everythingBelow), true);
    assert.equal(versionInRange('2.16.0', everythingBelow), false);

    const lastAffected = range({ introduced: '0' }, { last_affected: '0.3.1' });
    assert.equal(versionInRange('0.3.1', lastAffected), true);
    assert.equal(versionInRange('0.3.2', lastAffected), false);
  });

  it('is not fooled by events listed out of order', () => {
    // Two affected intervals in one range, written back to front. Reading the
    // events in file order would call 2.285.0 affected — it sits in the gap
    // between the first fix and the second regression.
    const shuffled = range(
      { introduced: '2.290.0' },
      { fixed: '2.293.1' },
      { introduced: '0' },
      { fixed: '2.283.4' },
    );
    assert.equal(versionInRange('2.100.0', shuffled), true);
    assert.equal(versionInRange('2.283.4', shuffled), false);
    assert.equal(versionInRange('2.285.0', shuffled), false);
    assert.equal(versionInRange('2.290.0', shuffled), true);
    assert.equal(versionInRange('2.293.1', shuffled), false);
  });

  it('refuses an unbounded introduced with no fix, rather than clearing it', () => {
    // github/codeql-action v2 is exactly this: `introduced: 2.26.11` and nothing
    // else, meaning every later v2 is affected for ever.
    const unfixed = range({ introduced: '2.26.11' });
    assert.equal(versionInRange('2.26.10', unfixed), false);
    assert.equal(versionInRange('2.30.0', unfixed), true);
  });

  it('returns null for an event or a version string it cannot read', () => {
    assert.equal(versionInRange('1.0.0', range({ introduced: 'trunk' })), null);
    assert.equal(versionInRange('trunk', range({ introduced: '0' }, { fixed: '2' })), null);
    assert.equal(versionInRange('1.0.0', { type: 'ECOSYSTEM', events: [{ something_new: '1' }] }), null);
    assert.equal(versionInRange('1.0.0', range()), null);
  });
});

describe('evaluating one affected entry', () => {
  it('matches an explicit version list as well as a range', () => {
    const entry = { package: { name: 'x/y', ecosystem: 'GitHub Actions' }, versions: ['1'] };
    assert.equal(versionAffected('1', entry), true);
    assert.equal(versionAffected('1.0.0', entry), true);
    assert.equal(versionAffected('2', entry), false);
  });

  it('refuses an entry whose coverage it did not fully read', () => {
    // A range type this gate does not evaluate is coverage that was NOT read, and
    // must never share an answer with coverage that was read and came out clean.
    const gitRange = { ranges: [{ type: 'GIT', events: [{ introduced: '0' }] }] };
    assert.equal(versionAffected('1.0.0', gitRange), null);
    assert.equal(versionAffected('1.0.0', { ranges: [] }), null);
    assert.equal(versionAffected('1.0.0', { versions: ['not-a-version'] }), null);
    // …but a readable range that matches still wins over an unreadable sibling.
    const mixed = {
      ranges: [{ type: 'GIT', events: [{ introduced: '0' }] }, range({ introduced: '0' }, { fixed: '2' })],
    };
    assert.equal(versionAffected('1.0.0', mixed), true);
  });
});

describe('the advisory index', () => {
  const CORPUS = [
    advisory('GHSA-case', 'Azure/setup-kubectl', [range({ introduced: '0' }, { fixed: '3' })]),
    advisory('GHSA-sub', 'super-linter/super-linter', [range({ introduced: '6.0.0' }, { fixed: '8.3.1' })]),
    advisory('GHSA-gone', 'actions/checkout', [range({ introduced: '0' }, { fixed: '99' })], {
      withdrawn: '2026-01-01T00:00:00Z',
    }),
    advisory('GHSA-url', 'https://github.com/pytorch/pytorch/.github/actions/filter-test-configs', [
      range({ introduced: '0' }),
    ]),
    {
      id: 'GHSA-other-ecosystem',
      affected: [
        {
          package: { name: 'aquasecurity/trivy-action', ecosystem: 'Go' },
          ranges: [range({ introduced: '0' }, { fixed: '99' })],
        },
      ],
    },
  ];
  const index = buildAdvisoryIndex(CORPUS);

  it('folds case, because GitHub resolves uses: case-insensitively and OSV does not', () => {
    // Measured against api.osv.dev on 2026-08-27: a name-only query for
    // `Azure/setup-kubectl` returns GHSA-p756-rfxh-x63h and the same query for
    // `azure/setup-kubectl` returns `{}`. `uses: azure/setup-kubectl@…` runs fine.
    assert.deepEqual(
      advisoriesAffecting(index, 'azure/setup-kubectl', ['2.0.0']).findings.map((f) => f.id),
      ['GHSA-case'],
    );
  });

  it('strips the URL form the corpus also publishes', () => {
    assert.equal(
      normaliseActionName('https://github.com/pytorch/pytorch/.github/actions/x'),
      'pytorch/pytorch/.github/actions/x',
    );
    assert.deepEqual(
      advisoriesAffecting(index, 'pytorch/pytorch/.github/actions/filter-test-configs', ['1.0.0']).findings
        .length,
      1,
    );
  });

  it('applies a repository advisory to an action in its subdirectory', () => {
    // Same repository, same commit: an advisory against the repo covers the
    // action nested inside it.
    assert.deepEqual(
      advisoriesAffecting(index, 'super-linter/super-linter/slim', ['7.0.0']).findings.map((f) => f.id),
      ['GHSA-sub'],
    );
  });

  it('drops withdrawn advisories and other ecosystems', () => {
    assert.deepEqual(advisoriesAffecting(index, 'actions/checkout', ['4.1.0']).findings, []);
    assert.deepEqual(advisoriesAffecting(index, 'aquasecurity/trivy-action', ['0.1.0']).findings, []);
  });

  it('reports an unreadable entry separately from a clean one', () => {
    const unreadable = buildAdvisoryIndex([
      advisory('GHSA-unreadable', 'a/b', [{ type: 'GIT', events: [{ introduced: '0' }] }]),
    ]);
    const result = advisoriesAffecting(unreadable, 'a/b', ['1.0.0']);
    assert.deepEqual(result.findings, []);
    assert.equal(result.unreadable.length, 1);
  });
});

describe('the every-invocation controls', () => {
  /** Exactly the advisories the control table names, and nothing else. */
  const CONTROL_CORPUS = [
    advisory('GHSA-cxww-7g56-2vh6', 'actions/download-artifact', [
      range({ introduced: '4.0.0' }, { fixed: '4.1.3' }),
    ]),
    advisory('GHSA-mrrh-fwg8-r2c3', 'tj-actions/changed-files', [
      range({ introduced: '0' }, { fixed: '46.0.1' }),
    ]),
    advisory('GHSA-p756-rfxh-x63h', 'Azure/setup-kubectl', [range({ introduced: '0' }, { fixed: '3' })]),
  ];

  it('passes against a corpus that carries every advisory it names', () => {
    assert.deepEqual(runAdvisoryControls(buildAdvisoryIndex(CONTROL_CORPUS)), []);
    assert.ok(ADVISORY_CONTROLS.length >= 6, 'the control table shrank');
    assert.ok(
      ADVISORY_CONTROLS.some((c) => c.expect === null),
      'every control expects a finding, so none of them can catch a matcher that fires on everything',
    );
  });

  it('reports when the advisory source goes quiet (REGRESSION)', () => {
    // This is the control on the control. An empty or truncated corpus is the way
    // this gate would go green over nothing, and it is why the controls exist.
    const problems = runAdvisoryControls(buildAdvisoryIndex([]));
    assert.equal(problems.length, 3, problems.join('\n'));
    assert.match(problems[0], /must match GHSA-cxww-7g56-2vh6 and the matcher reported nothing/u);
  });

  it('reports a matcher that has started firing on everything', () => {
    const overreaching = buildAdvisoryIndex([
      ...CONTROL_CORPUS,
      advisory('GHSA-noise', 'actions/checkout', [range({ introduced: '0' })]),
    ]);
    const problems = runAdvisoryControls(overreaching);
    assert.equal(problems.length, 1, problems.join('\n'));
    assert.match(problems[0], /actions\/checkout@4\.1\.0 is not affected/u);
  });
});

describe('the ZIP reader', () => {
  /**
   * Builds a ZIP by hand rather than by round-tripping the reader, so a reader
   * that agrees with itself cannot pass. Deflate-compressed, one entry.
   */
  function buildZip(entries) {
    const locals = [];
    const central = [];
    let offset = 0;
    for (const [name, text] of entries) {
      const raw = Buffer.from(text, 'utf8');
      const compressed = deflateRawSync(raw);
      const nameBytes = Buffer.from(name, 'utf8');
      const crc = Number(BigInt.asUintN(32, BigInt(crc32of(raw))));

      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x0403_4b50, 0);
      local.writeUInt16LE(8, 8);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(compressed.length, 18);
      local.writeUInt32LE(raw.length, 22);
      local.writeUInt16LE(nameBytes.length, 26);
      locals.push(local, nameBytes, compressed);

      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x0201_4b50, 0);
      header.writeUInt16LE(8, 10);
      header.writeUInt32LE(crc, 16);
      header.writeUInt32LE(compressed.length, 20);
      header.writeUInt32LE(raw.length, 24);
      header.writeUInt16LE(nameBytes.length, 28);
      header.writeUInt32LE(offset, 42);
      central.push(header, nameBytes);
      offset += local.length + nameBytes.length + compressed.length;
    }
    const localBlock = Buffer.concat(locals);
    const centralBlock = Buffer.concat(central);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x0605_4b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(centralBlock.length, 12);
    eocd.writeUInt32LE(localBlock.length, 16);
    return Buffer.concat([localBlock, centralBlock, eocd]);
  }

  // node:zlib's crc32 is what the gate checks with; using it here would make the
  // test agree with the reader by construction, so the table-driven original is
  // written out instead.
  function crc32of(buffer) {
    let table = crc32of.table;
    if (table === undefined) {
      table = new Int32Array(256);
      for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb8_8320 ^ (c >>> 1) : c >>> 1;
        table[i] = c;
      }
      crc32of.table = table;
    }
    let crc = -1;
    for (const byte of buffer) crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff];
    return (crc ^ -1) >>> 0;
  }

  it('reads every entry back', () => {
    const zip = buildZip([
      ['GHSA-a.json', JSON.stringify({ id: 'GHSA-a' })],
      ['GHSA-b.json', JSON.stringify({ id: 'GHSA-b' })],
    ]);
    const entries = readZipEntries(zip);
    assert.deepEqual([...entries.keys()], ['GHSA-a.json', 'GHSA-b.json']);
    assert.equal(JSON.parse(entries.get('GHSA-b.json').toString('utf8')).id, 'GHSA-b');
  });

  it('throws rather than returning a short list', () => {
    // Every one of these is a way the corpus arrives incomplete, and an
    // incomplete corpus that parses is a clean-looking run over missing
    // advisories.
    const zip = buildZip([['GHSA-a.json', '{}']]);
    assert.throws(() => readZipEntries(zip.subarray(0, 8)), /no end-of-central-directory/u);

    const wrongCount = Buffer.from(zip);
    wrongCount.writeUInt16LE(9, wrongCount.length - 22 + 10);
    assert.throws(() => readZipEntries(wrongCount), /header signature|out of range/u);

    const zip64 = Buffer.from(zip);
    zip64.writeUInt16LE(0xffff, zip64.length - 22 + 10);
    assert.throws(() => readZipEntries(zip64), /ZIP64/u);

    const corrupt = Buffer.from(zip);
    corrupt[corrupt.length - 22 - Buffer.byteLength('GHSA-a.json') - 46 + 16] ^= 0xff;
    assert.throws(() => readZipEntries(corrupt), /CRC32 mismatch/u);
  });
});

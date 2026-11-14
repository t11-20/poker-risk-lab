#!/usr/bin/env node
/**
 * The readiness report and the release manifest are one record and must not drift.
 * A report can state digests that were never the candidate's while the manifest is right, and
 * the check that catches that is the reverse one: every digest the manifest built must appear in the
 * report. Superseded digests are exempted by exact value, never by heading or prose.
 *
 * Run with:  node --test scripts/readiness-report.test.mjs
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gatesInVerify } from './release-gate-coverage.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPORT_PATH = join(REPO_ROOT, 'docs', 'production', 'final-readiness-report.md');
const MANIFEST_PATH = join(REPO_ROOT, 'deploy', 'staging', 'release-manifest.json');

const REPORT = readFileSync(REPORT_PATH, 'utf8');

// The manifest is gitignored and exists only where a release was built, so the join is a loud
// skip on a fresh clone and CI rather than a failure. The skip names the command that enables it.
const MANIFEST_PRESENT = existsSync(MANIFEST_PATH);

const SKIP_REASON = MANIFEST_PRESENT
  ? false
  : 'deploy/staging/release-manifest.json is not on this machine, so the readiness report was NOT ' +
    'joined to the release it describes — the digests and candidate SHA in the report went ' +
    'unchecked. The manifest is gitignored (a per-machine build record), so a fresh checkout and ' +
    'CI never have one. Run `pnpm run release:artifacts` to build a release and make this run.';

if (SKIP_REASON !== false) {
  console.error(`SKIPPED: ${SKIP_REASON}`);
}

const MANIFEST = MANIFEST_PRESENT
  ? JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
  : { images: {}, commit: {} };

// Digests the report states on purpose as NOT the release. A test fails if a value leaves the
// document, so an entry cannot outlive the text it was reviewed against.
const SUPERSEDED = new Map([
  [
    'sha256:7d3f6c23454db65db856376e838d1c3a6917a207226877d1759f7a7a142cac17',
    'the api digest left in the registry by candidate 091d67ac39ce-dirty, kept as the record of the drift',
  ],
  [
    'sha256:aa894fcfab4157a8ce5bd864cf9d6aaafa447f4ed70c114cc6cc2ba23bd320a3',
    'the web digest from the same stale push',
  ],
  // The pair CVE-2026-14456 was found in, still served by staging. Every staging measurement in the
  // report was taken against it.
  [
    'sha256:5411626265ada1324ede2544034bfe2699e5106469319e106429c17c34bfb75d',
    'the api digest built at 375303fa9714, pushed and signed, affected by CVE-2026-14456 and still deployed',
  ],
  [
    'sha256:6b1043cc9edbdce67870d365f74809199be5cc0b5f905b77747138dce9fa1f5f',
    'the web digest from the same build, affected by the same advisory and still deployed',
  ],
  // The 0b01f90ce510 pair, deployed 2026-08-27 until 2026-11-12. The alerts, drills, load and backup
  // figures in the report still measure it.
  [
    'sha256:94872a9abc937547b0d98441e4496718a9a5f879b2ea4f6c17a33be48a9d4083',
    'the api digest built at 0b01f90ce510, deployed 2026-08-27, replaced by the 6b3886ed3246 pair',
  ],
  [
    'sha256:e1c04b0e4f5f1d940280c09cda74e23981120d9f9fdacb72b3995199b9864af3',
    'the web digest from the same build, replaced on the same day',
  ],
]);

function digestsIn(markdown) {
  return [...new Set([...markdown.matchAll(/sha256:[0-9a-f]{64}/gu)].map((match) => match[0]))];
}

function manifestDigests() {
  const images = MANIFEST.images ?? {};
  return new Map(Object.entries(images).map(([service, image]) => [service, image.digest]));
}

describe('the readiness report cannot drift from the release manifest', { skip: SKIP_REASON }, () => {
  it('states the same candidate SHA the manifest recorded (REGRESSION)', () => {
    const stated = /\*\*Candidate SHA:\*\*\s*`([0-9a-f]{7,40})`/u.exec(REPORT);
    assert.ok(stated !== null, 'the report no longer states a candidate SHA; the join is gone');
    const manifestSha = MANIFEST.commit?.sha;
    assert.ok(typeof manifestSha === 'string' && manifestSha.length === 40, 'the manifest has no commit SHA');
    assert.ok(
      manifestSha.startsWith(stated[1]),
      `the report is written about ${stated[1]} and the manifest was built from ${manifestSha}. ` +
        'One of them is describing a release that was never made.',
    );
  });

  it('states no image digest the manifest does not know about (REGRESSION)', () => {
    const known = new Set(manifestDigests().values());
    assert.ok(known.size >= 2, 'the manifest lists no image digests; the comparison would prove nothing');
    const stated = digestsIn(REPORT);
    assert.ok(stated.length >= 2, 'the report states no digests; the sweep read nothing');
    for (const digest of stated) {
      if (SUPERSEDED.has(digest)) continue;
      assert.ok(
        known.has(digest),
        `the report states ${digest}, which is not a digest ${'deploy/staging/release-manifest.json'} ` +
          'recorded. Either the report is describing an image this commit did not build, or a new ' +
          'superseded value needs reviewing into SUPERSEDED with the paragraph that frames it.',
      );
    }
  });

  it('states every digest the manifest recorded, so a service cannot go unreported', () => {
    // The reverse direction, which a whitelist alone would miss.
    const stated = new Set(digestsIn(REPORT));
    for (const [service, digest] of manifestDigests()) {
      assert.ok(
        stated.has(digest),
        `the manifest built ${service} as ${digest} and the report never says so`,
      );
    }
  });

  it('keeps the superseded digests visible rather than deleting the mistake', () => {
    for (const [digest, why] of SUPERSEDED) {
      assert.ok(REPORT.includes(digest), `${digest} is exempted as "${why}" but is no longer in the report`);
    }
  });

  it('frames the superseded digests as superseded, in the same paragraph (NEGATIVE CONTROL)', () => {
    // The 400 characters before the first one must disclaim it.
    const first = [...SUPERSEDED.keys()][0];
    const at = REPORT.indexOf(first);
    const preamble = REPORT.slice(Math.max(0, at - 400), at);
    assert.match(
      preamble,
      /NOT this candidate|was wrong/u,
      'the superseded digests are no longer introduced as wrong; they now read as the release',
    );
  });

  it('the digest sweep can actually see a wrong digest (NEGATIVE CONTROL)', () => {
    // A foreign digest must be found, or the regex matches nothing.
    const foreign = `sha256:${'0'.repeat(64)}`;
    const found = digestsIn(`| api | \`${foreign}\` |`);
    assert.deepEqual(found, [foreign], 'the parser cannot see a digest stated in a table row');
    const known = new Set(manifestDigests().values());
    assert.equal(known.has(foreign), false, 'the comparison would have accepted a foreign digest');
  });
});

// The counts, because updating only the three manifest-joined fields leaves the rest describing an
// older candidate. These join the counts to the files that produce them, need no built release, and so never skip. The current inventory must appear in the
// document. Stamped capture rows are exempted by exact text.

const RULES_PATH = join(REPO_ROOT, 'deploy', 'staging', 'observability', 'alert-rules.yml');
const AUDIT_PATH = join(REPO_ROOT, 'scripts', 'supply-chain', 'audit.mjs');
const CERTIFICATION_PATH = join(REPO_ROOT, 'docs', 'production', 'accessibility-certification.md');

// Prose writes numbers as words. A digits-only sweep would read "sixteen reliability drills" as no claim.
const NUMBER_WORDS = new Map(
  [
    'zero',
    'one',
    'two',
    'three',
    'four',
    'five',
    'six',
    'seven',
    'eight',
    'nine',
    'ten',
    'eleven',
    'twelve',
    'thirteen',
    'fourteen',
    'fifteen',
    'sixteen',
    'seventeen',
    'eighteen',
    'nineteen',
    'twenty',
    'twenty-one',
    'twenty-two',
    'twenty-three',
    'twenty-four',
    'twenty-five',
    'twenty-six',
    'twenty-seven',
    'twenty-eight',
    'twenty-nine',
    'thirty',
    'thirty-one',
    'thirty-two',
    'thirty-three',
    'thirty-four',
    'thirty-five',
    'thirty-six',
    'thirty-seven',
    'thirty-eight',
    'thirty-nine',
    'forty',
  ].map((word, value) => [word, value]),
);

const NUMBER_PATTERN = `(?:\\d[\\d,]*|${[...NUMBER_WORDS.keys()].join('|')})`;

function readNumber(raw) {
  const text = String(raw).trim().toLowerCase();
  if (/^\d[\d,]*$/u.test(text)) return Number.parseInt(text.replaceAll(',', ''), 10);
  return NUMBER_WORDS.has(text) ? NUMBER_WORDS.get(text) : null;
}

const flat = (markdown) => markdown.replaceAll(/\s+/gu, ' ');

// Attributes each "<N> gates" claim to `verify` or `security:audit` by the nearest preceding marker,
// because one verdict sentence states both counts. A claim with no marker in reach is reported,
// never guessed.
const GATE_MARKER =
  /`?pnpm run verify`?|`?pnpm run security:audit`?|`?security:audit`?|supply-chain audit|supply-chain gates/giu;
const MARKER_REACH = 400;

function attributeGateCounts(flatReport, counts) {
  const problems = [];
  const attributed = { verify: 0, supplyChain: 0 };
  for (const match of flatReport.matchAll(new RegExp(`(${NUMBER_PATTERN})\\s+gates`, 'giu'))) {
    const stated = readNumber(match[1]);
    if (stated === null) continue;
    const before = flatReport.slice(Math.max(0, match.index - MARKER_REACH), match.index);
    const nearest = [...before.matchAll(GATE_MARKER)].at(-1);
    if (nearest === undefined) {
      problems.push(
        `"${stated} gates" names neither \`verify\` nor \`security:audit\` within ${MARKER_REACH} ` +
          'characters, so no check can tell which list it is about. Two unrelated lists are counted ' +
          'in this document and their counts are not interchangeable — say which.',
      );
      continue;
    }
    const isVerify = /verify/iu.test(nearest[0]);
    const expected = isVerify ? counts.verify : counts.supplyChain;
    if (stated !== expected) {
      problems.push(
        `the report says "${stated} gates" of ${isVerify ? '`pnpm run verify`' : '`security:audit`'}, ` +
          `which runs ${expected}`,
      );
    }
    if (isVerify) attributed.verify += 1;
    else attributed.supplyChain += 1;
  }
  return { problems, attributed };
}

// Only totals beside a zero-failure verdict. Historic counts phrased as history are left alone.
function statedTestTotals(flatReport) {
  return [
    ...flatReport.matchAll(
      new RegExp(`(${NUMBER_PATTERN})\\s+tests,\\s*(?:\\*\\*)?\\s*(?:0|zero)\\s+failures`, 'giu'),
    ),
  ]
    .map((match) => readNumber(match[1]))
    .filter((value) => value !== null);
}

const FLAT_REPORT = flat(REPORT);

// A small parser, because `test:scripts` runs on a `--frozen-lockfile` install with no YAML dependency.
function liveRuleInventory() {
  const lines = readFileSync(RULES_PATH, 'utf8').split('\n');
  const rules = [];
  let current = null;
  for (const line of lines) {
    const alert = /^\s*-\s*alert:\s*(\S+)/u.exec(line);
    if (alert !== null) {
      current = { name: alert[1], severity: null };
      rules.push(current);
      continue;
    }
    const severity = /^\s*severity:\s*(\S+)/u.exec(line);
    if (severity !== null && current !== null && current.severity === null) {
      current.severity = severity[1];
    }
  }
  const count = (which) => rules.filter((rule) => rule.severity === which).length;
  return {
    total: rules.length,
    page: count('page'),
    ticket: count('ticket'),
    heartbeat: count('heartbeat'),
  };
}

// Stamped captures of an older run, each pinned by exact text. The reverse check below still applies.
const CAPTURED_RULE_CLAIMS = [
  '**29 rules — 14 page, 14 ticket, 1 heartbeat**',
  '29 rules over 3 severities all resolving to receivers',
  'They read 26 checks, 28 rules and 2 severities',
  'takes those to 29 rules over 3 severities and adds check 7',
];

// Only "N alert rules" or a total followed by its breakdown. A bare `\d+ rules` also matches
// "Two rules were added with it".
function ruleClaimsIn(flatMarkdown) {
  const found = [];
  const shapes = [
    new RegExp(`\\b(${NUMBER_PATTERN})\\s+alert rules?\\b`, 'giu'),
    new RegExp(`\\b(${NUMBER_PATTERN})\\s+rules?\\s*(?:—|,|\\bover\\b|\\band\\b|\\bload\\b)`, 'giu'),
  ];
  for (const pattern of shapes) {
    for (const match of flatMarkdown.matchAll(pattern)) {
      const value = readNumber(match[1]);
      if (value === null) continue;
      const from = Math.max(0, match.index - 90);
      found.push({ value, quote: flatMarkdown.slice(from, match.index + match[0].length + 90) });
    }
  }
  return found;
}

const isCaptured = (claim) => CAPTURED_RULE_CLAIMS.some((text) => claim.quote.includes(text));

describe('the readiness report cannot drift from the counts it reports', () => {
  it('states the alert-rule inventory the rules file actually holds (REGRESSION)', () => {
    // Failed against the document at 37d6ccc on "Twenty-six of the twenty-nine alert rules".
    const live = liveRuleInventory();
    assert.ok(
      live.total >= 20,
      `only ${live.total} rules parsed out of alert-rules.yml; the sweep read nothing`,
    );
    const claims = ruleClaimsIn(FLAT_REPORT);
    assert.ok(claims.length > 0, 'the report makes no claim about how many alert rules there are');
    const live_claims = claims.filter((claim) => !isCaptured(claim));
    assert.ok(
      live_claims.length > 0,
      'every rule-count claim in the report is on the stamped-capture exemption list, so this ' +
        'check would prove nothing. A capture cannot be the only place a number appears.',
    );
    for (const claim of live_claims) {
      assert.equal(
        claim.value,
        live.total,
        `the report says ${claim.value} rules and alert-rules.yml holds ${live.total}:\n  …${claim.quote}…`,
      );
    }
  });

  it('states the CURRENT inventory somewhere, so a capture cannot be the whole story', () => {
    // The reverse direction. A forward check passes over a document that never states the true number.
    const live = liveRuleInventory();
    const stated = ruleClaimsIn(FLAT_REPORT).some((claim) => claim.value === live.total);
    assert.ok(
      stated,
      `alert-rules.yml holds ${live.total} rules and the report never says so. Every count in it is ` +
        'about an older tree.',
    );
    assert.match(
      FLAT_REPORT,
      new RegExp(`${live.page} page, ${live.ticket} ticket, ${live.heartbeat} heartbeat`, 'u'),
      `the severity split is ${live.page} page / ${live.ticket} ticket / ${live.heartbeat} ` +
        'heartbeat and the report does not state it. The total alone cannot tell a reviewer ' +
        'whether a page-severity rule was added or a ticket one.',
    );
  });

  it('counts the reliability drills the drill registry actually holds', async () => {
    const [analysis, database, process_, protocol] = await Promise.all([
      import('./drills/analysis-drills.mjs'),
      import('./drills/database-drills.mjs'),
      import('./drills/process-drills.mjs'),
      import('./drills/protocol-drills.mjs'),
    ]);
    const drills = [
      ...process_.processDrills,
      ...protocol.protocolDrills,
      ...analysis.analysisDrills,
      ...database.databaseDrills,
    ];
    assert.ok(drills.length >= 8, `only ${drills.length} drills imported; the sweep read nothing`);
    const stated = new RegExp(`\\b(${NUMBER_PATTERN})\\s+reliability drills\\b`, 'iu').exec(FLAT_REPORT);
    assert.ok(stated !== null, 'the report no longer says how many reliability drills there are');
    assert.equal(
      readNumber(stated[1]),
      drills.length,
      `the report says ${stated[1]} reliability drills and the registry holds ${drills.length}`,
    );
  });

  it('gets the supply-chain gate count and the ordinal of every gate it numbers right (REGRESSION)', () => {
    // Failed against the document at 37d6ccc on "It is gate twelve of `security:audit`" —
    // image-provenance.mjs is the fourteenth and last entry, not the twelfth.
    const source = readFileSync(AUDIT_PATH, 'utf8');
    const block = /const GATES = \[([\s\S]*?)\n\];/u.exec(source);
    assert.ok(block !== null, 'the GATES array is no longer where this test looks for it');
    const files = [...block[1].matchAll(/file:\s*'([^']+)'/gu)].map((match) => match[1]);
    assert.ok(files.length >= 10, `only ${files.length} gates parsed out of audit.mjs`);

    // Each claim is checked against the list it is about. See `attributeGateCounts`.
    const { problems, attributed } = attributeGateCounts(FLAT_REPORT, {
      verify: gatesInVerify(JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))).length,
      supplyChain: files.length,
    });
    assert.deepEqual(problems, [], problems.join('\n'));
    // Both counts must be found at least once.
    assert.ok(attributed.verify > 0, 'the report no longer states how many gates `pnpm run verify` runs');
    assert.ok(
      attributed.supplyChain > 0,
      'the report no longer states how many supply-chain gates there are',
    );
    // Scoped to a paragraph, because `security:image-provenance` and its ordinal are two sentences apart.
    // A paragraph naming two of these scripts is skipped. `checked` is asserted so the sweep is not empty.
    const ORDINALS = new Map([
      ['security:keyless', 'keyless-provenance.mjs'],
      ['security:image-provenance', 'image-provenance.mjs'],
    ]);
    const paragraphs = REPORT.split(/\n\s*\n|\n\s*[*-]\s|\n\s*\d+\.\s/u).map(flat);
    let checked = 0;
    for (const paragraph of paragraphs) {
      const named = [...ORDINALS.keys()].filter((script) => paragraph.includes(script));
      if (named.length !== 1) continue;
      const file = ORDINALS.get(named[0]);
      for (const match of paragraph.matchAll(new RegExp(`\\bgate (${NUMBER_PATTERN})\\b`, 'giu'))) {
        const stated = readNumber(match[1]);
        if (stated === null) continue;
        checked += 1;
        assert.equal(
          stated,
          files.indexOf(file) + 1,
          `the report calls ${named[0]} gate ${stated}; ${file} is gate ${files.indexOf(file) + 1} ` +
            `in the GATES array. The paragraph: …${paragraph.slice(0, 220)}…`,
        );
      }
    }
    assert.equal(
      checked,
      ORDINALS.size,
      `${checked} gate ordinal(s) were found and ${ORDINALS.size} are tracked. A gate whose ordinal ` +
        'left the document is a claim that stopped being checked without anybody deciding to stop ' +
        'checking it.',
    );
  });

  it('states one test total, not two that disagree (REGRESSION)', () => {
    // Nothing short of running the suite says the total is right, so this checks the document agrees
    // with itself.
    const stated = statedTestTotals(FLAT_REPORT);
    assert.ok(
      stated.length >= 2,
      `the report states a passing test total ${stated.length} time(s); with fewer than two there ` +
        'is nothing to cross-check and this guard has stopped guarding anything',
    );
    assert.equal(
      new Set(stated).size,
      1,
      `the report states more than one passing test total: ${[...new Set(stated)].join(', ')}. One ` +
        'of them is from a different run.',
    );
  });

  it('NEGATIVE CONTROL — a half-updated test total is caught, and history is not', () => {
    const both =
      'verify passes 15 of 15 gates, 3,586 tests, 0 failures. … all 15 gates; **3,586 tests, 0 failures**.';
    assert.deepEqual(statedTestTotals(both), [3586, 3586]);

    const half = both.replace('3,586 tests, 0 failures.', '3,590 tests, 0 failures.');
    assert.deepEqual(statedTestTotals(half), [3590, 3586]);

    // A historic count phrased as history is not a result.
    const history = `${both} At the candidate it was 3,555 tests passing.`;
    assert.deepEqual(statedTestTotals(history), [3586, 3586]);
  });

  it('NEGATIVE CONTROL — a gate count attributed to the wrong list is caught', () => {
    const counts = { verify: 15, supplyChain: 14 };

    const correct =
      '`pnpm run verify` exits 0 at this candidate: all fifteen gates, 3,555 tests, zero failures, ' +
      'including a supply-chain audit of fourteen gates.';
    assert.deepEqual(attributeGateCounts(correct, counts).problems, []);
    assert.deepEqual(attributeGateCounts(correct, counts).attributed, { verify: 1, supplyChain: 1 });

    // Swapped counts. The old sweep against the supply-chain count passed the first half of this.
    const swapped = correct.replace('fifteen gates', 'fourteen gates');
    const problems = attributeGateCounts(swapped, counts).problems;
    assert.equal(problems.length, 1, `expected exactly one problem, got: ${problems.join(' | ')}`);
    assert.match(problems[0], /"14 gates" of `pnpm run verify`, which runs 15/u);

    // So the check is not merely "verify must be the larger number".
    const supplyWrong = correct.replace('audit of fourteen gates', 'audit of fifteen gates');
    assert.match(attributeGateCounts(supplyWrong, counts).problems[0], /of `security:audit`, which runs 14/u);
  });

  it('NEGATIVE CONTROL — an unattributable gate count is refused, not guessed', () => {
    const orphan = `A run of the pipeline reported ${'x'.repeat(500)} fourteen gates.`;
    const { problems, attributed } = attributeGateCounts(orphan, { verify: 15, supplyChain: 14 });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /names neither `verify` nor `security:audit`/u);
    assert.deepEqual(attributed, { verify: 0, supplyChain: 0 });
  });

  it('splits the accessibility assertions the way the certification and the registry do', async () => {
    // Three records of one fact. Any two can agree while the third drifts.
    const certification = readFileSync(CERTIFICATION_PATH, 'utf8');
    const rows = [...certification.matchAll(/^\|\s*(G\d+|\d+\.\d+)\s*\|\s*(auto|person)\s*\|/gmu)];
    assert.ok(rows.length >= 40, `only ${rows.length} assertion rows read from the certification`);
    const auto = rows.filter((row) => row[2] === 'auto');
    const person = rows.filter((row) => row[2] === 'person');

    const { ASSERTION_IDS } = await import('./ax-assertions.mjs');
    assert.equal(
      ASSERTION_IDS.length,
      auto.length,
      `${auto.length} assertions are marked auto and ${ASSERTION_IDS.length} checks exist. An ` +
        '`auto` row with no check is a claim nothing verifies.',
    );
    // The document's ids use J-section numbering (`3.2`); the registry's use `J3.2`.
    const registry = new Set(ASSERTION_IDS.map((id) => id.replace(/^J/u, '')));
    for (const row of auto) {
      assert.ok(registry.has(row[1]), `${row[1]} is marked auto in the certification and has no check`);
    }

    const total = /\| \*\*Total\*\* \| \*\*(\d+)\*\* \| \*\*(\d+)\*\* \| \*\*(\d+)\*\* \|/u.exec(REPORT);
    assert.ok(total !== null, 'the readiness report no longer carries the assertion summary table');
    assert.deepEqual(
      [Number(total[1]), Number(total[2]), Number(total[3])],
      [rows.length, auto.length, person.length],
      'the readiness report and the certification disagree about the assertion split',
    );
  });

  it('the count sweeps can actually see a wrong count (NEGATIVE CONTROL)', () => {
    // Negative controls with documents wrong in the historical way.
    const live = liveRuleInventory();

    const asItStood = flat('4. **Twenty-six of the twenty-nine alert rules are loaded, agreed.**');
    const claims = ruleClaimsIn(asItStood);
    assert.equal(claims.length, 1, 'the parser cannot see a rule count written as a word');
    assert.equal(claims[0].value, 29, 'the parser misread "twenty-nine"');
    assert.notEqual(claims[0].value, live.total, 'the comparison would have accepted the 29 that shipped');
    assert.equal(isCaptured(claims[0]), false, 'a bare residual sentence is being read as a stamped capture');

    // An exempt capture, so the exemption is not vacuous.
    const capture = flat('| grounding | **29 rules — 14 page, 14 ticket, 1 heartbeat** — all loaded |');
    assert.equal(isCaptured(ruleClaimsIn(capture)[0]), true, 'the stamped capture is no longer recognised');

    assert.equal(readNumber('2,065'), 2065, 'the parser cannot read a thousands separator');
    assert.equal(readNumber('sixteen'), 16, 'the parser cannot read a spelled-out number');
    assert.equal(readNumber('gate'), null, 'the parser reads a non-number as a number');
  });
});

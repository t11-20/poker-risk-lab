#!/usr/bin/env node
/**
 * The readiness report and the release manifest are one record, and must not drift.
 *
 * Run with:  node --test scripts/readiness-report.test.mjs
 *
 * ## The defect this is written against
 *
 * `docs/production/final-readiness-report.md` stated two image digests that were never this
 * candidate's. They were the digests a previous push had left in the local registry, from
 * `091d67ac39ce-dirty`. `deploy/staging/release-manifest.json` had recorded the correct pair
 * throughout, and the staging containers were running the correct pair — the only wrong thing in
 * the system was the sentence a release reviewer would actually read.
 *
 * It survived a green fourteen-gate `verify` because nothing consumed both records. Prose in a
 * report and JSON in a manifest were two independent statements of the same fact, and the gates all
 * read the JSON. It was eventually found by hand, by someone reading one against the other while
 * doing unrelated work — which is not a control, it is luck.
 *
 * That is the whole class: **a claim about a release, written where a reviewer reads it, that no
 * gate joins back to the artefact it describes.** This file is the join. It is deliberately about
 * the report rather than about digests, because the next instance of this will not be a digest.
 *
 * ## Would this fail if the behaviour broke?
 *
 * Yes — and it is the specific historical failure that is reproduced, not a generic one. The
 * superseded pair is pinned below by value: the test asserts they are still present in the document
 * (the record of the mistake must not be quietly deleted) AND that they are never presented as
 * current. Every other digest in the report must resolve to the manifest.
 *
 * ## What actually catches it, which is not the obvious check
 *
 * Replaying the document as it truly stood — the stale pair presented as the release, no corrected
 * table — fails two of the six checks below, and NEITHER is the forward one. "states no digest the
 * manifest does not know about" PASSES against the historical bug, because by then the two values
 * are on the exemption list and an exemption cannot tell where in the document it was used.
 *
 * What fails is the pair that does not depend on the list at all: the manifest's real digests are
 * absent from the report, and the paragraph introducing the stale ones does not disclaim them. That
 * is the property to preserve if this file is ever edited. A whitelist plus a forward check reads
 * like the whole control and is the half that would have shipped the defect; the reverse direction —
 * every digest the manifest built must appear — is the half that works, because a report cannot
 * substitute one digest for another without dropping the one it should have stated.
 *
 * ## Why the exemption is a list of values and not a path or a heading
 *
 * The document marks the wrong table with prose — a strikethrough and the words "NOT this
 * candidate's". Prose is the wrong thing to key an exemption on: it is one tidy-up away from
 * meaning nothing, and the tidy-up would silently re-arm the exemption over a table that had
 * meanwhile been edited to say something else. Pinning the exact digests means an exemption can
 * only ever cover the two strings it was reviewed for.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPORT_PATH = join(REPO_ROOT, 'docs', 'production', 'final-readiness-report.md');
const MANIFEST_PATH = join(REPO_ROOT, 'deploy', 'staging', 'release-manifest.json');

const REPORT = readFileSync(REPORT_PATH, 'utf8');

/**
 * The manifest is `deploy/staging/.gitignore`d — a per-machine build record, deliberately not
 * committed. So this join can only run on a machine that has built a release, and never on a
 * fresh checkout.
 *
 * An adversarial review found this throwing a bare `ENOENT` at module scope, which meant
 * `pnpm run test` — and therefore `pnpm run verify`, and therefore **`ci.yml:379` on every push**,
 * since CI never runs `release:artifacts` — failed with a stack trace and no sentence. That was a
 * defect this file introduced.
 *
 * ## Why this is a loud skip and not a refusal
 *
 * The reviewer left the semantics to a maintainer, and correctly: "a quiet skip is a pass" is the
 * house rule, and it argues for failing. The answer is that the rule is about *quiet*, not about
 * *skip* — `databaseSkip` in `apps/api/test/helpers/database.ts` is the established idiom for
 * exactly this shape, and it is trusted because it names what it did not check.
 *
 * A refusal here would be a false alarm on every fresh clone, for a reason that has nothing to do
 * with the code under test. Guards that cry wolf get deleted by the third person who hits one, and
 * a deleted guard checks nothing at all. The teeth are kept where they matter: the manifest exists
 * on exactly the machines that can ship — `release:artifacts` writes it, and the release path runs
 * `verify` after building — so the join runs at the only moment its answer can change a decision.
 *
 * The skip is loud, it names the join it did not perform, and it says the one command that makes
 * it run.
 */
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

/**
 * Digests the report states on purpose while saying they are NOT the release.
 *
 * Each entry is a claim that somebody read the surrounding paragraph and confirmed it presents the
 * value as superseded. Adding a line here is a review, not a silencing: the test below fails if the
 * value has left the document, so an entry cannot outlive the text it was written about.
 */
const SUPERSEDED = new Map([
  [
    'sha256:7d3f6c23454db65db856376e838d1c3a6917a207226877d1759f7a7a142cac17',
    'the api digest left in the registry by candidate 091d67ac39ce-dirty, kept as the record of the drift',
  ],
  [
    'sha256:aa894fcfab4157a8ce5bd864cf9d6aaafa447f4ed70c114cc6cc2ba23bd320a3',
    'the web digest from the same stale push',
  ],
]);

/** Every full-length digest the report states, in order, deduplicated. */
function digestsIn(markdown) {
  return [...new Set([...markdown.matchAll(/sha256:[0-9a-f]{64}/gu)].map((match) => match[0]))];
}

/** The digests the manifest actually recorded, by service. */
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
    // The other direction, and the one a whitelist alone would miss: a report that simply stopped
    // mentioning the web image would pass every check above while telling a reviewer nothing.
    const stated = new Set(digestsIn(REPORT));
    for (const [service, digest] of manifestDigests()) {
      assert.ok(
        stated.has(digest),
        `the manifest built ${service} as ${digest} and the report never says so`,
      );
    }
  });

  it('keeps the superseded digests visible rather than deleting the mistake', () => {
    // The record of a wrong claim is worth more than its absence, and an exemption for a value that
    // is no longer in the document is an exemption waiting to cover something else.
    for (const [digest, why] of SUPERSEDED) {
      assert.ok(REPORT.includes(digest), `${digest} is exempted as "${why}" but is no longer in the report`);
    }
  });

  it('frames the superseded digests as superseded, in the same paragraph (NEGATIVE CONTROL)', () => {
    // Presence is not enough: the pair could survive a rewrite that reinstated them as current.
    // This reads the 400 characters before the first one and requires the disclaimer to be there.
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
    // Everything above passes on a correct report AND on a regex that matches nothing. This feeds
    // the parser a document with a foreign digest and requires it to be found.
    const foreign = `sha256:${'0'.repeat(64)}`;
    const found = digestsIn(`| api | \`${foreign}\` |`);
    assert.deepEqual(found, [foreign], 'the parser cannot see a digest stated in a table row');
    const known = new Set(manifestDigests().values());
    assert.equal(known.has(foreign), false, 'the comparison would have accepted a foreign digest');
  });
});

// ---------------------------------------------------------------------------
// The counts, which nothing joined to anything until 2026-08-26.
// ---------------------------------------------------------------------------

/**
 * ## The defect this second half is written against
 *
 * `37d6ccc8ba54` edited `docs/production/final-readiness-report.md` and changed **three lines**: the
 * candidate SHA and the two image digests. Those are exactly, and only, the three fields the
 * describe block above joins to `deploy/staging/release-manifest.json`. Everything else in the
 * document — 2,065 tests, 29 alert rules, "gate twelve", "sixteen reliability drills" — was left
 * describing candidate `6677dfcc2ae7`, three commits and 13,004 inserted lines earlier. The same
 * commit's own message recorded `2174 tests`.
 *
 * That is not a coincidence and it is not carelessness. It is what a partial join *causes*: the
 * coupled fields are kept honest by a test, the uncoupled prose beside them rots, and the document
 * ends up looking freshly stamped precisely because the stamped parts are the ones under guard. The
 * fix for a join that covers three fields is not a bigger warning; it is more fields.
 *
 * So this block joins the counts a release reviewer decides on to the artefacts that produce them:
 * the alert-rule inventory to `alert-rules.yml`, the drill count to the drill registry, the
 * supply-chain gate count and the ordinals of two named gates to the `GATES` array, and the
 * accessibility split three ways — the report's summary table, the certification document's own
 * rows, and the checks that actually exist in `scripts/ax-assertions.mjs`.
 *
 * ## Why this does NOT skip when the manifest is absent
 *
 * The block above needs a built release. None of these do: every source they read is committed. A
 * fresh clone and CI must run them, because CI is where a docs-only commit lands.
 *
 * ## Would these fail if the claim drifted?
 *
 * Each was demonstrated failing against the document as it actually stood at `37d6ccc`, before the
 * corrections: the rule sweep on "Twenty-six of the twenty-nine", the gate ordinal on "gate twelve",
 * and each has a synthetic negative control below that feeds the parser a wrong document and
 * requires the refusal.
 *
 * ## Why the capture rows are exempted by exact string
 *
 * *Gates from this SHA* holds rows that are deliberately stamped and deliberately not updated —
 * the document says so in as many words, and editing a stamped row is how a capture stops being
 * evidence. Those are exempted the same way `SUPERSEDED` exempts the stale digests: by the exact
 * text, so an exemption can only ever cover the sentence it was reviewed for.
 *
 * A whitelist plus a forward check is the half that would ship the defect, for the reason the
 * header above gives. The half that works is the reverse: the CURRENT inventory must appear in the
 * document. A report cannot exempt its way out of that — it has to state the true number somewhere,
 * and the only way to satisfy it is to have looked.
 */

const RULES_PATH = join(REPO_ROOT, 'deploy', 'staging', 'observability', 'alert-rules.yml');
const AUDIT_PATH = join(REPO_ROOT, 'scripts', 'supply-chain', 'audit.mjs');
const CERTIFICATION_PATH = join(REPO_ROOT, 'docs', 'production', 'accessibility-certification.md');

/**
 * The report spells numbers out in prose and writes them as digits in tables, and the same claim
 * appears in both forms. A sweep that only understood digits would read "sixteen reliability
 * drills" as no claim at all — a sweep of nothing, which is the failure mode this repository names
 * explicitly.
 */
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

/** `"2,065"`, `"thirty-five"` and `"Thirty-five"` all become a number. `null` if it is not one. */
function readNumber(raw) {
  const text = String(raw).trim().toLowerCase();
  if (/^\d[\d,]*$/u.test(text)) return Number.parseInt(text.replaceAll(',', ''), 10);
  return NUMBER_WORDS.has(text) ? NUMBER_WORDS.get(text) : null;
}

/** Whitespace collapsed, so a claim that the formatter wrapped is still one sentence. */
const flat = (markdown) => markdown.replaceAll(/\s+/gu, ' ');

const FLAT_REPORT = flat(REPORT);

/**
 * Every `- alert:` in the rules file, with the severity label that follows it.
 *
 * Deliberately a small parser rather than a YAML dependency: this file is in `test:scripts`, which
 * runs inside `verify` on a `--frozen-lockfile` install, and a gate that needs a new dependency to
 * check a number is a gate somebody removes.
 */
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

/**
 * Rows that are a stamped capture of an older run, each reviewed and each pinned by its exact text.
 *
 * These are NOT permission to be wrong. They are the document's own convention — a capture is
 * evidence of what a run reported, and a capture edited to match a later tree is evidence of
 * nothing — and the reverse-direction check below is what stops the convention becoming a hiding
 * place.
 */
const CAPTURED_RULE_CLAIMS = [
  '**29 rules — 14 page, 14 ticket, 1 heartbeat**',
  '29 rules over 3 severities all resolving to receivers',
  'They read 26 checks, 28 rules and 2 severities',
  'takes those to 29 rules over 3 severities and adds check 7',
];

/**
 * Every claim about how many alert rules there are, with enough context to recognise a capture.
 *
 * Two shapes, and the narrowness is the point. `\d+ rules` on its own also matches "Two rules were
 * added with it", which is a true sentence about a change and not a claim about the inventory — a
 * sweep that fails on it teaches the next person to delete the sweep. What only ever introduces a
 * total in this document family is either the qualified noun ("35 alert rules") or a total followed
 * by its breakdown ("29 rules — 14 page…", "29 rules over 3 severities", "28 rules and 2
 * severities", "29 rules load").
 */
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
    // The reverse direction, and the half that works. A whitelist plus a forward check passes over
    // a document that simply never mentions the true number — which is exactly what the document
    // did between the sixth rule landing and this test.
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

    const totals = [...FLAT_REPORT.matchAll(new RegExp(`(${NUMBER_PATTERN})\\s+gates`, 'giu'))]
      .map((match) => readNumber(match[1]))
      .filter((value) => value !== null);
    assert.ok(totals.length > 0, 'the report no longer states how many supply-chain gates there are');
    for (const total of totals) {
      assert.equal(total, files.length, `the report says ${total} gates and audit.mjs runs ${files.length}`);
    }

    // Each gate the report numbers, by the npm script that runs it.
    //
    // Scoped to a paragraph rather than to a character window, and the first attempt at this got it
    // wrong in a way worth recording: `security:image-provenance` and its ordinal are two sentences
    // apart, so a window written as `[^.]{0,160}` — "same sentence" — silently matched neither and
    // the check passed over the exact claim it was written for. A sweep that finds nothing reports
    // the same green as a sweep that finds everything correct, which is why `checked` is counted and
    // asserted below.
    //
    // A paragraph naming two of these scripts is skipped rather than guessed at: there is no way to
    // tell which one an ordinal belongs to, and a guess here would fail on a correct document.
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

  it('splits the accessibility assertions the way the certification and the registry do', async () => {
    // Three records of one fact: the report's summary table, the certification document's rows, and
    // the checks that exist. Any two can agree while the third drifts, which is why all three are
    // joined here rather than the obvious pair.
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
    // Everything above passes on a correct report AND on a regex that matches nothing. These feed
    // the parsers documents that are wrong in the exact historical way and require them to notice.
    const live = liveRuleInventory();

    const asItStood = flat('4. **Twenty-six of the twenty-nine alert rules are loaded, agreed.**');
    const claims = ruleClaimsIn(asItStood);
    assert.equal(claims.length, 1, 'the parser cannot see a rule count written as a word');
    assert.equal(claims[0].value, 29, 'the parser misread "twenty-nine"');
    assert.notEqual(claims[0].value, live.total, 'the comparison would have accepted the 29 that shipped');
    assert.equal(isCaptured(claims[0]), false, 'a bare residual sentence is being read as a stamped capture');

    // A capture that IS exempt, so the exemption is not vacuous either.
    const capture = flat('| grounding | **29 rules — 14 page, 14 ticket, 1 heartbeat** — all loaded |');
    assert.equal(isCaptured(ruleClaimsIn(capture)[0]), true, 'the stamped capture is no longer recognised');

    assert.equal(readNumber('2,065'), 2065, 'the parser cannot read a thousands separator');
    assert.equal(readNumber('sixteen'), 16, 'the parser cannot read a spelled-out number');
    assert.equal(readNumber('gate'), null, 'the parser reads a non-number as a number');
  });
});

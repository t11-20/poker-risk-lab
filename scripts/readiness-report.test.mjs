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

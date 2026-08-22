/**
 * The claims this product makes about itself have to survive being checked.
 *
 * ## What went wrong
 *
 * The footer told every learner on every page: *"There is no stored odds table anywhere in this
 * product, so there is no table that can be quietly wrong."* The home page said "No odds table,
 * anywhere", the metrics band counted "Hard-coded odds: 0", and the curriculum index said "There is
 * no odds table in this repository to go stale."
 *
 * `apps/web/src/fixtures/*.ts` ships eighteen stored `ruleOfThumb` blocks and twenty-one stored
 * `heroEquity` values — stored odds tables by any reading — as the offline fallback every screen in
 * this app is built to survive on. A release audit found four of them disagreeing with the live
 * calculation. So the product's own honesty statement was falsified by the exact defect it
 * disclaimed, in four places, and nothing could have noticed: it is prose.
 *
 * ## What is asserted, and what deliberately is not
 *
 * This does not try to decide whether a sentence is true — no test can. It pins the specific
 * unqualified phrasings that were checked and found false, so that "simplifying" the wording back
 * to them fails rather than shipping. The honest claim is narrower and is still worth making: no
 * figure is PRODUCED by a lookup, and where a bundled copy is shown the page says so.
 *
 * The fixtures themselves are read here and never edited. They are the evidence for why the
 * unqualified claim is false, and if they are ever genuinely removed from the product this file
 * should be revisited rather than deleted — at that point the strong claim becomes true again.
 *
 * ## The second thing this file pins: the legal surface
 *
 * `/terms`, `/privacy`, `/responsible-use` and the age gate were added later, and they are the pages
 * on which an overstatement is most tempting and most damaging. The failure has exactly the shape of
 * the one above — a sentence that reads better than the truth — with a worse consequence: a deployer
 * who reads "we comply with data-protection law" on their own privacy page has been told something
 * by their own software that nobody checked.
 *
 * So the same treatment is applied. `FALSIFIED_LEGAL` lists the phrasings those pages must never
 * carry: a compliance claim, a licensing claim, a claim that the age gate verified anything, a
 * safety-of-gambling claim, a guarantee, and "your data is anonymous" (it is pseudonymous — the IP
 * and user-agent digests are keyed HMACs). In the other direction, the claims those pages DO make
 * are tied to the code that makes them true: the privacy page's "no third-party trackers" is
 * asserted against `lib/csp.ts` naming no remote host, because an absence claim is only worth making
 * where something enforces it.
 *
 * ## Would this fail if the behaviour broke?
 *
 * Yes. Every legal pattern is fed a page that makes exactly the claim it forbids, and asserted to
 * fire — otherwise a typo in a pattern would leave the whole group passing over prose it never
 * matched. The reverse is asserted too: the patterns must not fire on the pages as written, because
 * a rule that failed on honest prose would be deleted rather than fixed.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (...parts: readonly string[]): string => readFileSync(join(SRC, ...parts), 'utf8');

/**
 * Every file that states, in prose a reader sees, where the numbers come from.
 *
 * The four legal-surface files are here for the same reason as the original four: they are prose a
 * reader is shown, and the "no odds table" claim is exactly the kind of confident absence a legal
 * page attracts. `/terms` §6 already talks about where figures come from, so it is squarely in
 * scope rather than swept in.
 */
const CLAIM_FILES: readonly (readonly string[])[] = [
  ['components', 'SiteFooter.tsx'],
  ['components', 'MetricsBand.tsx'],
  ['app', 'page.tsx'],
  ['app', 'learn', 'page.tsx'],
  ['app', 'terms', 'page.tsx'],
  ['app', 'privacy', 'page.tsx'],
  ['app', 'responsible-use', 'page.tsx'],
  ['components', 'AgeGate.tsx'],
];

/** The legal surface, which has its own set of claims it must not make. */
const LEGAL_FILES: readonly (readonly string[])[] = [
  ['app', 'terms', 'page.tsx'],
  ['app', 'privacy', 'page.tsx'],
  ['app', 'responsible-use', 'page.tsx'],
  ['components', 'AgeGate.tsx'],
  ['app', 'age-check', 'page.tsx'],
];

/**
 * Phrasings the legal surface must never carry.
 *
 * Each one is a claim this project has no standing to make, and each is the sentence somebody
 * reaches for when they want a legal page to sound finished. They are checked over prose only —
 * a comment may quote one to explain why it is forbidden, which is what the `prose` filter below
 * exists for.
 */
const FALSIFIED_LEGAL: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  {
    pattern: /\b(?:we|this (?:site|service|deployment|application)) (?:are|is) (?:fully )?compliant\b/iu,
    why: 'nobody qualified has assessed this deployment against any regime; docs/production/legal-review-requirements.md is the list of what has not been decided',
  },
  {
    pattern: /\bGDPR[- ]compliant\b|\bcomplies with (?:the )?(?:GDPR|CCPA|UK GDPR)\b/iu,
    why: 'the same: a named-regime compliance claim is a legal conclusion, and this codebase draws none',
  },
  {
    pattern: /\b(?:licensed|regulated) by\b/iu,
    why: 'this product holds no licence and names no regulator, and implying one is the most consequential thing a gambling-adjacent page can get wrong',
  },
  {
    pattern: /\bage[- ]verifi(?:ed|cation)\b/iu,
    why: 'the gate is a self-declaration. Nothing is verified, no document is requested, and there is no column in the schema for a date of birth',
  },
  {
    pattern: /\bwe (?:verify|confirm) (?:your|the reader.s) age\b/iu,
    why: 'the same claim in the active voice',
  },
  {
    pattern: /\b(?:safe|responsible) (?:to )?gambl(?:e|ing)\b/iu,
    why: 'this product cannot make a claim about the safety of gambling, and PRODUCT-GUARDRAILS §1 forbids any framing that treats it as an activity this app prepares you for',
  },
  {
    pattern: /\bwe guarantee\b|\bis guaranteed to\b/iu,
    why: 'the service is free, may be reset or withdrawn at any time, and PRODUCT-GUARDRAILS §3 forbids claiming to be right about anything',
  },
  {
    pattern: /\byour data is (?:completely )?anonymous\b/iu,
    why: 'the IP and user-agent digests are KEYED HMACs — pseudonymisation, not anonymisation — and the pages say so in as many words',
  },
];

/** Non-comment lines only: a block comment may quote a forbidden phrasing to explain the ban. */
function proseOf(source: string): string {
  return source
    .split('\n')
    .filter((line) => !/^\s*(?:\*|\/\/|\/\*)/u.test(line))
    .join('\n');
}

/**
 * Phrasings that assert an ABSENCE the product cannot demonstrate.
 *
 * Each was on screen, and each is falsified by the bundled fallback. The narrower claim — nothing
 * is *looked up* — is fine and is what these were replaced with.
 */
const FALSIFIED: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  {
    pattern: /no stored odds table anywhere in this product/iu,
    why: 'src/fixtures/*.ts ships stored equity figures as the offline fallback',
  },
  {
    pattern: /no odds table,? anywhere/iu,
    why: 'the same fixtures are an odds table by any reading, and four entries were found wrong',
  },
  {
    pattern: /no odds table in (?:this|the) repository/iu,
    why: 'the fixtures are in this repository',
  },
  {
    pattern: /there is no odds table in this product/iu,
    why: 'there is one; it is the labelled offline fallback',
  },
];

describe('nothing on screen claims an absence the fixtures contradict', () => {
  for (const parts of CLAIM_FILES) {
    const name = parts.join('/');
    it(`${name} makes no unqualified "no odds table" claim`, () => {
      const text = read(...parts);
      for (const { pattern, why } of FALSIFIED) {
        // A block comment may quote the old wording to explain why it was changed; the assertion is
        // about what a reader is shown, so only non-comment lines are checked.
        const prose = proseOf(text);
        assert.doesNotMatch(
          prose,
          pattern,
          `${name} states "${pattern.source}" as fact, and it is false: ${why}. Say what is actually ` +
            'true instead — no figure is produced by a lookup, and the fallback is labelled on the ' +
            'page that shows it.',
        );
      }
    });
  }

  it('the footer still makes the honest version of the claim rather than saying nothing', () => {
    // Deleting the statement would be the other way to pass this file, and it would be a worse
    // product: the claim is the reason to trust the figures, and a narrower true one is still a
    // claim. This asserts the replacement exists.
    const footer = read('components', 'SiteFooter.tsx');
    assert.match(footer, /Nothing is looked up/u);
    assert.match(footer, /bundled copy/u);
    assert.match(footer, /says so at the top/u);
  });

  it('the fallback really is labelled on the page, which is what makes the footer true', () => {
    // The footer's second paragraph rests on this. If the on-page labelling is ever removed, the
    // paragraph becomes false and has to change with it.
    assert.match(read('app', 'learn', '[lessonId]', 'page.tsx'), /This lesson is the bundled copy/u);
    assert.match(read('app', 'play', 'page.tsx'), /Fixture — no server is connected/u);
  });
});

describe('the legal surface claims nothing it cannot stand behind', () => {
  for (const parts of LEGAL_FILES) {
    const name = parts.join('/');
    it(`${name} makes no compliance, licensing or verification claim`, () => {
      // Whitespace is collapsed as well as comments dropped: the formatter reflows JSX prose to 110
      // columns, so a forbidden phrase could straddle a line break and slip past a raw match.
      const prose = proseOf(read(...parts)).replace(/\s+/gu, ' ');
      for (const { pattern, why } of FALSIFIED_LEGAL) {
        assert.doesNotMatch(
          prose,
          pattern,
          `${name} states "${pattern.source}", which this project has no standing to claim: ${why}.`,
        );
      }
    });
  }

  it('the pages still make the honest versions of those claims rather than saying nothing', () => {
    // Deleting a sentence is the other way to pass the group above, and it would be a worse
    // product: the reason these pages are worth reading is that they say what is true. Each
    // assertion here is the replacement for one of the forbidden phrasings.
    const gate = read('components', 'AgeGate.tsx').replace(/\s+/gu, ' ');
    assert.match(gate, /self-declaration, not a check/u, 'in place of an age-verification claim');

    const privacy = read('app', 'privacy', 'page.tsx').replace(/\s+/gu, ' ');
    assert.match(
      privacy,
      /pseudonymisation, not anonymisation/u,
      'in place of "your data is anonymous" — the IP and user-agent digests are keyed HMACs',
    );
    assert.match(privacy, /keyed HMAC/u);

    const terms = read('app', 'terms', 'page.tsx').replace(/\s+/gu, ' ');
    assert.match(
      terms,
      /no promise that it will be available/u,
      'in place of a guarantee, on a service that is free and may be reset at any time',
    );
  });

  it('the "no third-party trackers" claim is backed by a policy with no remote host in it', () => {
    // `/privacy` §1 asserts an absence. An absence claim is only worth making where something
    // enforces it, so this ties the sentence to the directive list that makes it true. If a host is
    // ever added to the policy — an analytics endpoint, a font CDN — this fails, and the page has
    // to change before the host can ship.
    const csp = read('lib', 'csp.ts');
    const directives = csp
      .split('\n')
      .filter((line) =>
        /^\s*(?:"|')[a-z-]+-src|^\s*(?:"|')(?:default|form-action|frame-ancestors)/u.test(line),
      );
    assert.ok(directives.length > 6, `expected the directive list, found ${String(directives.length)} lines`);
    for (const directive of directives) {
      assert.doesNotMatch(
        directive,
        /https?:\/\/[a-z0-9]/iu,
        `the policy names a remote host in ${directive.trim()}, so /privacy can no longer say there ` +
          'are no third-party services',
      );
    }
    assert.match(read('app', 'privacy', 'page.tsx'), /no third-party trackers/u);
  });
});

// ---------------------------------------------------------------------------
// Negative controls for the group above.
//
// Every pattern is fed a page that makes exactly the claim it forbids, and asserted to fire. Without
// this, a typo in a pattern would leave the whole group passing over documents it never matched.
// ---------------------------------------------------------------------------

describe('the legal-claim detectors catch a real violation', () => {
  const VIOLATIONS: readonly string[] = [
    '<p>This service is fully compliant with all applicable law.</p>',
    '<p>Poker Risk Lab is GDPR-compliant.</p>',
    '<p>We are licensed by the Gambling Commission.</p>',
    '<p>Every reader completes age verification before playing.</p>',
    '<p>We verify your age when you sign up.</p>',
    '<p>A guide to safe gambling for beginners.</p>',
    '<p>We guarantee your progress will be kept for ever.</p>',
    '<p>Your data is completely anonymous.</p>',
  ];

  it('fires on every phrasing it forbids', () => {
    assert.equal(
      VIOLATIONS.length,
      FALSIFIED_LEGAL.length,
      'each forbidden pattern needs a sample that proves it matches something',
    );
    for (const [index, sample] of VIOLATIONS.entries()) {
      const rule = FALSIFIED_LEGAL[index];
      assert.ok(rule !== undefined);
      assert.match(
        sample,
        rule.pattern,
        `the pattern for "${rule.why}" matched nothing, so it was guarding nothing`,
      );
    }
  });

  it('does not fire on the pages as they are written', () => {
    // The other half: the patterns have to be narrow enough that honest prose passes. A rule that
    // failed on the real pages would be deleted rather than fixed, which is how a guard disappears.
    assert.ok(LEGAL_FILES.length > 3);
    for (const parts of LEGAL_FILES) {
      const prose = proseOf(read(...parts)).replace(/\s+/gu, ' ');
      for (const { pattern } of FALSIFIED_LEGAL) assert.doesNotMatch(prose, pattern);
    }
  });

  it('reads real files rather than an empty set', () => {
    for (const parts of [...CLAIM_FILES, ...LEGAL_FILES]) {
      assert.ok(read(...parts).length > 500, `${parts.join('/')} must be a real file`);
    }
    assert.ok(CLAIM_FILES.length + LEGAL_FILES.length > 12);
  });
});

describe('the fixtures the claim has to account for are still there', () => {
  it('still ships stored equity figures, so the narrow wording is still the correct one', () => {
    const fixtures = resolve(SRC, 'fixtures');
    const stored = readdirSync(fixtures)
      .filter((file) => file.endsWith('.ts'))
      .map((file) => readFileSync(join(fixtures, file), 'utf8'))
      .join('\n');
    assert.match(
      stored,
      /heroEquity|ruleOfThumb/u,
      'If the bundled fallback figures have genuinely gone, the strong claim is true again and the ' +
        'wording in CLAIM_FILES can be revisited — deliberately, with this file, rather than by ' +
        'somebody tightening a sentence they thought read better.',
    );
  });
});

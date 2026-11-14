/**
 * The claims this product makes about itself have to survive being checked.
 * `src/fixtures/*.ts` ships stored `ruleOfThumb` and `heroEquity` values as the offline fallback, so an
 * unqualified "no odds table" claim is false. This pins
 * the phrasings checked and found false, plus the legal-page overstatements (compliance, licensing,
 * age checks, guarantees, anonymity). Every pattern is fed a violation, and must stay quiet on the
 * pages as written. The fixtures are read here and never edited.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (...parts: readonly string[]): string => readFileSync(join(SRC, ...parts), 'utf8');

/** Every file that states, in prose a reader sees, where the numbers come from. */
const CLAIM_FILES: readonly (readonly string[])[] = [
  ['components', 'SiteFooter.tsx'],
  ['components', 'MetricsBand.tsx'],
  ['app', 'page.tsx'],
  ['app', 'checks', 'page.tsx'],
  ['lib', 'checks.ts'],
  ['components', 'HomeSpot.tsx'],
  ['app', 'learn', 'page.tsx'],
  ['app', 'terms', 'page.tsx'],
  ['app', 'privacy', 'page.tsx'],
  ['app', 'responsible-use', 'page.tsx'],
  ['components', 'AgeGate.tsx'],
];

const LEGAL_FILES: readonly (readonly string[])[] = [
  ['app', 'terms', 'page.tsx'],
  ['app', 'privacy', 'page.tsx'],
  ['app', 'responsible-use', 'page.tsx'],
  ['components', 'AgeGate.tsx'],
  ['app', 'age-check', 'page.tsx'],
];

/**
 * Phrasings the legal surface must never carry, checked over prose only, so a comment may quote one
 * to explain the ban.
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

/** Absence claims the bundled fallback falsifies. The narrower claim, that nothing is looked up, is fine. */
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
    // Deleting the claim would also pass this file. The full statement is on `/checks` and the
    // footer links to it, so both are held.
    const footer = read('components', 'SiteFooter.tsx');
    assert.match(footer, /never looked up/u);
    assert.match(footer, /href=\{CHECKS_PATH\}/u);
    const checks = read('app', 'checks', 'page.tsx');
    assert.match(checks, /Nothing is looked up/u);
    assert.match(checks, /bundled copy/u);
    assert.match(checks, /says so at the top/u);
  });

  it('the fallback really is labelled on the page, which is what makes the footer true', () => {
    // The footer's second paragraph is only true while the fallback is labelled on the page.
    assert.match(read('app', 'learn', '[lessonId]', 'page.tsx'), /This lesson is the bundled copy/u);
    assert.match(read('app', 'play', 'page.tsx'), /Fixture — no server is connected/u);
  });
});

describe('the legal surface claims nothing it cannot stand behind', () => {
  for (const parts of LEGAL_FILES) {
    const name = parts.join('/');
    it(`${name} makes no compliance, licensing or verification claim`, () => {
      // Whitespace collapsed, so a phrase cannot straddle a formatter line break.
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
    // Deleting a sentence would also pass the group above. Each assertion is one honest replacement.
    const gate = read('components', 'AgeGate.tsx').replace(/\s+/gu, ' ');
    assert.match(gate, /self-declaration, not a check/u, 'in place of an age-verification claim');

    const privacy = read('app', 'privacy', 'page.tsx').replace(/\s+/gu, ' ');
    assert.match(
      privacy,
      /pseudonymisation, not anonymisation/u,
      'in place of "your data is anonymous" — the IP and user-agent digests are keyed HMACs',
    );
    assert.match(privacy, /keyed HMAC/u);

    const terms = proseOf(read('app', 'terms', 'page.tsx')).replace(/\s+/gu, ' ');
    assert.match(
      terms,
      /no promise that it will be available/u,
      'in place of a guarantee, on a service that may be reset at any time',
    );
    // Since 0006 an enrolment is granted out of band and the software cannot tell whether a place was
    // paid for. The sentence saying the page does not settle what the operator owes reads like a hedge
    // and would be deleted first, so it gets its own assertion.
    assert.match(
      terms,
      /whether the operator may do any of it without owing you something/u,
      '/terms must still say that the technical disclaimer does not settle the commercial question. ' +
        'Deleting it leaves a page that reads as though it had been settled.',
    );
    assert.match(
      terms,
      /An enrolment record is not evidence that money changed hands/u,
      'and must still say that an enrolment implies nothing about money, which is what stops the ' +
        'clause above being read as a disclaimer aimed at people who paid',
    );
  });

  it('the "no third-party trackers" claim is backed by a policy with no remote host in it', () => {
    // An absence claim is only worth making where something enforces it. A remote host added to the
    // policy fails this, and the page has to change first.
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
    // A rule that failed on honest prose would be deleted rather than fixed.
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

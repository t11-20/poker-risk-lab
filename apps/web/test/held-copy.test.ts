/**
 * Legal and money sentences the owner has to approve before they change. Each pin is the prose a
 * reader sees in one place. A missing file or a missing region fails rather than passing over nothing.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** What a reader sees: JSX comments and `{' '}` dropped, tags stripped, whitespace collapsed. */
function readerProse(source: string): string {
  return source
    .replace(/\{\/\*[\s\S]*?\*\/\}/gu, '')
    .replace(/\{' '\}/gu, ' ')
    .replace(/<[^>]*>/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function readSource(file: string): string {
  const text = readFileSync(join(SRC, file), 'utf8');
  assert.ok(text.length > 0, `${file} was empty, so this pin read nothing`);
  return text;
}

function region(source: string, start: string, end: string, where: string): string {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `${where}: "${start}" is not in the file, so this pin read nothing`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `${where}: "${end}" does not follow, so this pin read nothing`);
  const prose = readerProse(source.slice(from, to));
  assert.ok(prose.length > 0, `${where}: the region has no reader-visible prose`);
  return prose;
}

interface HeldCopy {
  readonly where: string;
  readonly file: string;
  readonly start: string;
  readonly end: string;
  readonly sentences: readonly string[];
}

const HELD: readonly HeldCopy[] = [
  {
    where: 'footer “What this is”, first paragraph',
    file: 'components/SiteFooter.tsx',
    start: '<p className="prl-footer__heading prl-label">What this is</p>',
    end: '<p className="prl-footer__heading prl-label">Where the numbers come from</p>',
    sentences: [
      'An educational tool for studying probability, expected value, risk and variance in No-Limit ' +
        'Hold\u2019em. It is not a gambling product: there is no real money in it, nothing to buy, ' +
        'nothing to win and no way to cash anything out.',
    ],
  },
  {
    where: 'footer “What this is”, second paragraph',
    file: 'components/SiteFooter.tsx',
    start: '<p className="prl-footer__heading prl-label">What this is</p>',
    end: '<p className="prl-footer__heading prl-label">Where the numbers come from</p>',
    sentences: [
      'Chips are units \u2014 free practice counters with no monetary value, which you can reset to ' +
        'the starting amount whenever you like. Nothing here is a recommendation, and no figure is ' +
        'presented as the one correct play.',
    ],
  },
  {
    where: 'home page guardrail',
    file: 'app/page.tsx',
    start: '<p className="prl-home__guardrail">',
    end: '</p>',
    sentences: [
      'Not a gambling product. There is no real money in this app. Chips are units: free practice ' +
        'counters with no monetary value, which cannot be bought, sold, transferred or cashed out, ' +
        'and which you can reset to the starting amount at any time. Nothing here is a recommendation, ' +
        'and no figure is presented as the one correct play.',
    ],
  },
  {
    where: 'record page ResetPanel, first paragraph',
    file: 'app/record/page.tsx',
    start: 'function ResetPanel(',
    end: '<UnitsReset />',
    sentences: [
      'Units are free practice counters with no value of any kind: they cannot be bought, transferred, ' +
        'redeemed or cashed out. Resetting them puts your balance back to the starting amount and puts ' +
        'every seat you currently hold back to its table\u2019s starting stack. It costs nothing, it is ' +
        'not recorded as anything, and you may do it as often as you like.',
    ],
  },
  {
    where: 'record page ResetPanel, second paragraph',
    file: 'app/record/page.tsx',
    start: 'function ResetPanel(',
    end: '<UnitsReset />',
    sentences: [
      'It does not erase anything. The hands you have played stay in your history, and the net figure ' +
        'above is a sum over those hands rather than a balance \u2014 so it does not move either. A reset ' +
        'that quietly rewrote a finished table\u2019s numbers would be editing the record instead of ' +
        'clearing the board.',
    ],
  },
  {
    where: 'Onboarding step 1',
    file: 'components/Onboarding.tsx',
    start: 'const STEPS: readonly Step[] = [',
    end: '\n];',
    sentences: [
      'Nothing in this app can be bought and nothing can be won. There is no deposit, no cash-out, no ' +
        'prize and no leaderboard. The units exist so that a decision has a size, which is what makes ' +
        'the arithmetic mean anything.',
    ],
  },
  {
    where: 'Onboarding step 2',
    file: 'components/Onboarding.tsx',
    start: 'const STEPS: readonly Step[] = [',
    end: '\n];',
    sentences: [
      'The Coach shows its working, and can be wrong',
      'It does not tell you the right play. It tells you what the maths says under stated assumptions, ' +
        'and it labels its own confidence. Where a real opponent breaks an assumption, the Coach is the ' +
        'thing that is wrong.',
    ],
  },
];

describe('held legal and money sentences', () => {
  it('pins somewhere, so an emptied list cannot pass', () => {
    assert.ok(HELD.length >= 7, `only ${HELD.length} sentence(s) are pinned`);
    const files = new Set(HELD.map((held) => held.file));
    assert.ok(files.size >= 4, 'the pins do not cover the footer, home, record and onboarding');
  });

  for (const held of HELD) {
    it(`${held.where} is unchanged`, () => {
      assert.ok(held.sentences.length > 0, `${held.where}: no sentence is pinned`);
      const prose = region(readSource(held.file), held.start, held.end, held.where);
      for (const sentence of held.sentences) {
        assert.ok(prose.includes(sentence), `${held.where}: missing “${sentence}”`);
      }
    });
  }
});

/**
 * Shared chrome at tablet widths, held as the rules that fixed it. Each was measured in Chrome at 600
 * to 1180: a head-to-content gap of 0, 2, 20 or 48px by route, a footer one column to 899 and 3+2
 * from 900, tour steps split 4+1 and 3+2, a double rule in the menu sheet and a 3px strip under the
 * header above the replay transport.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { TOUR_STEPS } from '../src/lib/tour.ts';

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
const css = (path: string): string => read(path).replace(/\/\*[\s\S]*?\*\//gu, '');

const PAGE = css('../src/styles/page.css');
const LEGAL = css('../src/styles/legal.css');
const SHELL = css('../src/app/globals.css');
const NAV = css('../src/styles/nav.css');
const TOUR = css('../src/styles/tour.css');
const REVIEW = css('../src/styles/review.css');

/** The declarations of the first top-level-or-nested rule whose selector is exactly `selector`. */
function rule(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = new RegExp(`(?:^|\\n)\\s*${escaped} \\{([^}]*)\\}`, 'u').exec(source);
  assert.ok(match !== null, `no rule for ${selector}`);
  return match[1] ?? '';
}

/** The body of every `@media`/`@container` block whose prelude is exactly `prelude`. */
function blocks(source: string, prelude: string): string[] {
  const found: string[] = [];
  let at = source.indexOf(`${prelude} {`);
  while (at !== -1) {
    let depth = 0;
    let end = at + prelude.length + 1;
    for (; end < source.length; end++) {
      if (source[end] === '{') depth++;
      if (source[end] === '}' && --depth === 0) break;
    }
    found.push(source.slice(at + prelude.length + 2, end));
    at = source.indexOf(`${prelude} {`, end);
  }
  assert.ok(found.length > 0, `no ${prelude} block`);
  return found;
}

describe('the page head', () => {
  it('sets one gap under itself, whatever follows, and outranks a block’s own top margin', () => {
    const gap = rule(PAGE, '.prl-page-head + :not(.prl-gate)');
    assert.match(gap, /margin-block-start: var\(--prl-space-11\);/u);
  });

  it('is not doubled by the legal pages’ own top padding', () => {
    assert.match(rule(LEGAL, '.prl-legal'), /padding-block: var\(--prl-space-0\) /u);
  });
});

describe('the footer', () => {
  const footer = read('../src/components/SiteFooter.tsx');
  /** Boxes the footer always renders. `SessionDuration` adds a fifth until it is hidden. */
  const boxes = (footer.match(/className="prl-footer__(?:map|statement)"/gu) ?? []).length;

  it('pairs the four from 600px and gives the reminder its own row, so neither state leaves a hole', () => {
    assert.equal(boxes, 4);
    assert.match(footer, /<SessionDuration \/>\s*<\/div>\s*<\/footer>/u);
    assert.match(read('../src/components/SessionDuration.tsx'), /<div className="prl-footer__statement">/u);
    const tablet = blocks(SHELL, '@media (min-width: 600px)').join('\n');
    assert.match(
      rule(tablet, '.prl-footer__inner'),
      /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/u,
    );
    assert.match(
      rule(tablet, '.prl-footer__inner > .prl-footer__statement:last-child'),
      /grid-column: 1 \/ -1;/u,
    );
    assert.match(rule(tablet, '.prl-footer__inner .prl-select'), /max-inline-size: /u);
  });

  it('puts all four on one row from 1000px', () => {
    const wide = rule(blocks(SHELL, '@media (min-width: 1000px)').join('\n'), '.prl-footer__inner');
    const tracks = /grid-template-columns: max-content repeat\((\d+), minmax\(0, 1fr\)\) max-content;/u.exec(
      wide,
    );
    assert.ok(tracks !== null, 'the wide footer is not lists-at-the-edges, prose between');
    assert.equal(Number(tracks[1]) + 2, boxes);
  });

  it('keeps no three-track footer, which left a hole beside the fourth and fifth boxes', () => {
    assert.doesNotMatch(SHELL, /\.prl-footer__inner \{[^}]*repeat\(3,/u);
  });
});

describe('the guided tour', () => {
  it('lays out its steps in one column or all across, never auto-fit', () => {
    const steps = rule(TOUR, '.prl-tour__steps');
    assert.doesNotMatch(steps, /auto-fit|auto-fill/u);
    assert.match(steps, /grid-template-columns: minmax\(0, 1fr\);/u);
    const across = rule(blocks(TOUR, '@container prl-tour (width >= 64rem)').join('\n'), '.prl-tour__steps');
    const count = /repeat\((\d+), minmax\(0, 1fr\)\)/u.exec(across);
    assert.ok(count !== null, 'no all-across track list');
    assert.equal(Number(count[1]), TOUR_STEPS.length, 'one track per step, or the last row is short');
  });

  it('queries the panel it sits in', () => {
    assert.match(rule(TOUR, '.prl-tour'), /container: prl-tour \/ inline-size;/u);
  });
});

describe('the menu sheet', () => {
  it('draws no hairline above the first destination, under the bar’s accent rule', () => {
    assert.match(SHELL, /\.prl-sheet__bar::after \{[^}]*background-color: var\(--prl-accent-edge\);/u);
    assert.match(rule(SHELL, '.prl-sheet__item:first-child'), /border-block-start: 0;/u);
    // Forced colours drop the accent fill, so the hairline has to come back there.
    const forced = blocks(SHELL, '@media (forced-colors: active)').join('\n');
    assert.match(rule(forced, '.prl-sheet__item:first-child'), /border-block-start: var\(--prl-hairline\);/u);
  });
});

describe('the replay transport', () => {
  it('docks at the one-row bar’s own height, so no strip of the stage shows above it', () => {
    const header = rule(NAV, '.prl-shell__header');
    assert.match(header, /padding-block: var\(--prl-pillbar-pad-block\);/u);
    assert.match(header, /border-block-end: 1px solid/u);
    assert.match(
      rule(REVIEW, '.prl-replay__transport'),
      /inset-block-start: calc\(var\(--prl-pill-h\) \+ 2 \* var\(--prl-pillbar-pad-block\) \+ 1px\);/u,
    );
  });
});

describe('a scenario that could not load', () => {
  const page = read('../src/app/lab/[scenarioId]/page.tsx');

  it('lists its facts as label-over-value pairs, not labels run into their values', () => {
    assert.match(page, /<dl className="prl-unavailable-facts">/u);
    for (const label of ['The question it asks', 'Scenario', 'What happened']) {
      assert.match(page, new RegExp(`<dt className="prl-label">${label}</dt>\\s*<dd`, 'u'));
    }
    assert.doesNotMatch(page, /<span className="prl-label">(?:The question it asks|Scenario|What happened)/u);
  });

  it('spaces the pairs apart', () => {
    assert.match(rule(PAGE, '.prl-unavailable-facts'), /gap: var\(--prl-space-5\);/u);
  });

  it('is the same list on a hand replay that could not load', () => {
    const replay = read('../src/app/review/[handId]/page.tsx');
    assert.match(replay, /<dl className="prl-unavailable-facts">/u);
    for (const label of ['Hand', 'What happened']) {
      assert.match(replay, new RegExp(`<dt className="prl-label">${label}</dt>\\s*<dd`, 'u'));
    }
    assert.doesNotMatch(replay, /<span className="prl-label">(?:Hand|What happened)</u);
  });
});

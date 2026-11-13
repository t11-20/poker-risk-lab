#!/usr/bin/env node
/**
 * Tests for the pure checkers in `scripts/ax-tree-audit.mjs`. Each block feeds a real violation and
 * asserts the finding, and the well-formed tree must report nothing. Node shapes are what
 * `Accessibility.getFullAXTree` returns in Chrome 151.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { auditAxTree, axProperty, checkHiddenCards, checkLiveRegions } from './ax-tree-audit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const SCRIPT = join(HERE, 'ax-tree-audit.mjs');

let nextId = 0;
function node(role, name, extra = {}) {
  nextId += 1;
  return {
    nodeId: `n${nextId}`,
    ignored: extra.ignored ?? false,
    role: { type: 'role', value: role },
    name: { type: 'computedString', value: name },
    properties: Object.entries(extra.properties ?? {}).map(([key, value]) => ({
      name: key,
      value: { type: typeof value === 'boolean' ? 'boolean' : 'string', value },
    })),
    childIds: [],
  };
}

function withChildren(parent, children) {
  parent.childIds = children.map((child) => child.nodeId);
  return [parent, ...children];
}

// Fourteen named controls, so the scan count assertion below means something.
function wellFormedTree(overrides = {}) {
  const buttons = Array.from({ length: 8 }, (_, index) => node('button', `Control ${String(index + 1)}`));
  const links = Array.from({ length: 6 }, (_, index) => node('link', `Destination ${String(index + 1)}`));
  const banner = node('banner', 'Site');
  const primaryNav = node('navigation', overrides.primaryNavName ?? 'Primary');
  const sheetNav = node('navigation', overrides.sheetNavName ?? 'All sections');
  const contentinfo = node('contentinfo', 'About Poker Risk Lab');
  const h1 = node('heading', overrides.h1Name ?? 'Six-handed table', { properties: { level: 1 } });
  const h2 = node('heading', 'Coach analysis', { properties: { level: overrides.h2Level ?? 2 } });
  const announcer = node('status', '', { properties: { live: 'polite', atomic: true } });
  const main = node('main', '');
  const root = node('RootWebArea', 'Play — Poker Risk Lab');

  const extras = overrides.extraNodes ?? [];
  const mainChildren = [h1, h2, announcer, ...buttons, ...links, ...extras];
  return [
    ...withChildren(root, [banner, primaryNav, sheetNav, main, contentinfo]),
    ...withChildren(main, mainChildren),
    ...mainChildren.flatMap((child) => (child.childIds.length === 0 ? [] : [])),
  ];
}

describe('a well-formed tree', () => {
  it('produces no findings, and says how much it looked at', () => {
    const { findings, counts } = auditAxTree(wellFormedTree());
    assert.deepEqual(
      findings.map((finding) => finding.check),
      [],
      `a tree modelled on a real page must be clean: ${JSON.stringify(findings, null, 2)}`,
    );
    // Guards against a checker that returns early.
    assert.ok(
      counts.interactive > 12,
      `only ${counts.interactive} interactive node(s) were examined; a clean result over an empty ` +
        'scan is the failure this assertion exists to rule out',
    );
    assert.equal(counts.headings, 2);
    assert.equal(counts.landmarks, 5);
  });
});

describe('NEGATIVE CONTROL — a button with no computed accessible name', () => {
  it('fires, and names the role it could not name', () => {
    const nameless = node('button', '');
    const { findings, counts } = auditAxTree(wellFormedTree({ extraNodes: [nameless] }));
    const hit = findings.find((finding) => finding.check === 'accessible-name');
    assert.ok(
      hit !== undefined,
      `a nameless button must be reported: ${JSON.stringify(findings.map((f) => f.check))}`,
    );
    assert.match(hit.detail, /no computed accessible name/u);
    assert.equal(hit.role, 'button');
    assert.ok(counts.interactive > 12, 'the scan still examined a real set of nodes');
  });

  it('does not fire for a control that is not rendered', () => {
    // A `display:none` subtree is ignored/notRendered with no name, which is not a defect.
    const offscreen = node('button', '', { ignored: true });
    const { findings } = auditAxTree(wellFormedTree({ extraNodes: [offscreen] }));
    assert.deepEqual(findings, []);
  });

  it('does not fire for a control hidden from assistive technology', () => {
    const ariaHidden = node('button', '', { properties: { hidden: true } });
    const { findings } = auditAxTree(wellFormedTree({ extraNodes: [ariaHidden] }));
    assert.deepEqual(findings, []);
  });
});

describe('NEGATIVE CONTROL — a hidden card that names its rank and suit', () => {
  it('reports the leak from the computed accessible name', () => {
    const findings = checkHiddenCards([
      {
        name: 'queen of hearts',
        html: '<span class="prl-card prl-card--face-down" role="img" aria-label="queen of hearts"></span>',
      },
    ]);
    const leaks = findings.filter((finding) => finding.check === 'hidden-card-leak');
    assert.equal(
      leaks.length,
      2,
      'both halves must fire: the computed name AND the markup. Either one alone is a leak, and ' +
        `a checker that catches one is a checker that misses the other: ${JSON.stringify(findings)}`,
    );
    assert.match(leaks[0].detail, /queen/u);
    assert.match(
      leaks[0].detail,
      /discloses it to every screen-reader user/u,
      'the message has to say what the consequence is, or it reads as a naming nit',
    );
  });

  it('reports a card that is hidden but does not say so', () => {
    const findings = checkHiddenCards([{ name: 'card', html: '<span class="prl-card--face-down"></span>' }]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].check, 'hidden-card-unnamed');
  });

  it('reports a face-down card with no name at all', () => {
    const findings = checkHiddenCards([{ name: '', html: '<span class="prl-card--face-down"></span>' }]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].check, 'hidden-card-unnamed');
    assert.match(findings[0].detail, /visual cue only/u);
  });

  it('catches a value that is only in the markup', () => {
    // The value in a `data-` attribute is one ARIA change from being announced. `PlayingCard` skips
    // decoding a face-down card so this cannot happen.
    const findings = checkHiddenCards([
      {
        name: 'face-down card',
        html: '<span class="prl-card--face-down" data-suit="spade" aria-label="face-down card">ace</span>',
      },
    ]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].check, 'hidden-card-leak');
    assert.match(findings[0].detail, /own markup contains "(ace|spade)"/u);
  });

  it('passes a correctly hidden card, including one that is not rendered', () => {
    const findings = checkHiddenCards([
      {
        name: 'face-down card',
        html: '<span class="prl-card prl-card--sm prl-card--face-down" role="img" aria-label="face-down card"><span class="prl-card__back" aria-hidden="true"></span></span>',
      },
      { name: '', html: '<span class="prl-card--face-down"></span>', rendered: false },
    ]);
    assert.deepEqual(findings, [], JSON.stringify(findings));
  });
});

describe('NEGATIVE CONTROL — a broken heading outline', () => {
  it('fires when a level is skipped', () => {
    const { findings } = auditAxTree(wellFormedTree({ h2Level: 4 }));
    const hit = findings.find((finding) => finding.check === 'heading-order');
    assert.ok(hit !== undefined, `a 1 -> 4 jump must be reported: ${JSON.stringify(findings)}`);
    assert.match(hit.detail, /jumps from 1 to 4/u);
  });

  it('fires when there is more than one level-1 heading', () => {
    const second = node('heading', 'Another page title', { properties: { level: 1 } });
    const { findings } = auditAxTree(wellFormedTree({ extraNodes: [second] }));
    const hit = findings.find((finding) => finding.check === 'one-h1');
    assert.ok(hit !== undefined, `two h1s must be reported: ${JSON.stringify(findings)}`);
    assert.match(hit.detail, /2 level-1 heading/u);
  });
});

describe('NEGATIVE CONTROL — landmarks', () => {
  it('fires when two landmarks of one role share a computed name', () => {
    const { findings } = auditAxTree(wellFormedTree({ sheetNavName: 'Primary' }));
    const hit = findings.find((finding) => finding.check === 'landmark-unique');
    assert.ok(hit !== undefined, `two navs named "Primary" must be reported: ${JSON.stringify(findings)}`);
    assert.match(hit.detail, /share the computed name "primary"/u);
  });

  it('fires when a required landmark is absent', () => {
    const nodes = wellFormedTree().filter((entry) => entry.role.value !== 'main');
    const { findings } = auditAxTree(nodes);
    const hit = findings.find((finding) => finding.check === 'landmark-missing');
    assert.ok(hit !== undefined, `a missing main must be reported: ${JSON.stringify(findings)}`);
    assert.match(hit.detail, /no main landmark/u);
  });

  it('allows five uniquely named navigation landmarks — the /review list budget', () => {
    const extra = [
      node('navigation', 'Sort hand history'),
      node('navigation', 'Hand history pages'),
      node('navigation', 'Breadcrumb'),
    ];
    const { findings } = auditAxTree(wellFormedTree({ extraNodes: extra }));
    assert.equal(
      findings.filter((finding) => finding.check === 'landmark-count').length,
      0,
      `five uniquely named navs must be in budget: ${JSON.stringify(findings)}`,
    );
  });

  it('fires on a sixth navigation landmark', () => {
    const extra = [
      node('navigation', 'Sort hand history'),
      node('navigation', 'Hand history pages'),
      node('navigation', 'Breadcrumb'),
      node('navigation', 'Too many'),
    ];
    const { findings } = auditAxTree(wellFormedTree({ extraNodes: extra }));
    const hit = findings.find((finding) => finding.check === 'landmark-count');
    assert.ok(hit !== undefined, `six navs must be reported: ${JSON.stringify(findings)}`);
    assert.match(hit.detail, /6 navigation landmarks/u);
  });
});

describe('the verify gate actually starts an API', () => {
  it('pnpm run test:ax passes --with-api, or lab scenarios are audited as error pages', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    assert.match(
      pkg.scripts['test:ax'],
      /--with-api/,
      'without --with-api, --start only boots the web app; /lab/:id that is not in the six ' +
        'fixtures renders "This scenario could not be loaded" and the gate scores an error page',
    );
    assert.match(pkg.scripts['test:ax'], /--start/);
  });
});

describe('NEGATIVE CONTROL — live regions', () => {
  it('fires when the page has no polite region at all', () => {
    const nodes = wellFormedTree().filter((entry) => entry.role.value !== 'status');
    const { findings } = checkLiveRegions(nodes, [{ politeness: 'polite', atLeast: 1 }]);
    const hit = findings.find((finding) => finding.check === 'live-region-missing');
    assert.ok(
      hit !== undefined,
      `a page with no polite region must be reported: ${JSON.stringify(findings)}`,
    );
  });

  it('fires when a live region is inside an aria-hidden subtree', () => {
    const buried = node('status', '', { properties: { live: 'polite', hidden: true } });
    const { findings } = checkLiveRegions(wellFormedTree({ extraNodes: [buried] }), []);
    const hit = findings.find((finding) => finding.check === 'live-region-hidden');
    assert.ok(
      hit !== undefined,
      'an aria-hidden live region is in the DOM and announced by nothing — the single most common ' +
        `way a live region silently stops working: ${JSON.stringify(findings)}`,
    );
  });

  it('passes the app’s own arrangement, and reports what it found', () => {
    const { findings, regions } = checkLiveRegions(wellFormedTree(), [{ politeness: 'polite', atLeast: 1 }]);
    assert.deepEqual(findings, []);
    assert.equal(regions.length, 1);
    assert.equal(regions[0].live, 'polite');
    assert.equal(regions[0].role, 'status');
    assert.equal(regions[0].atomic, true);
  });
});

describe('axProperty', () => {
  it('reads a property out of the CDP shape, and answers undefined for an absent one', () => {
    const withLive = node('status', '', { properties: { live: 'assertive' } });
    assert.equal(axProperty(withLive, 'live'), 'assertive');
    assert.equal(axProperty(withLive, 'atomic'), undefined);
    assert.equal(axProperty(node('button', 'Fold'), 'live'), undefined);
  });
});

describe('the script itself', () => {
  it('exits 0 for --help and says what it is not', () => {
    const result = spawnSync(process.execPath, [SCRIPT, '--help'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
    });
    assert.equal(result.status, 0, `--help must exit 0:\n${result.stdout}${result.stderr}`);
    assert.match(
      result.stdout,
      /NOT a screen-reader test/u,
      'the help text must disclaim what this cannot do, in the place somebody reads before ' +
        'quoting a passing run as evidence',
    );
    assert.match(result.stdout, /accessibility-certification\.md/u);
  });

  it('refuses an unknown option with the reason, not "invalid"', () => {
    const result = spawnSync(process.execPath, [SCRIPT, '--not-a-flag'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unknown option --not-a-flag \(try --help\)/u);
  });

  it('refuses a journey name it does not have', () => {
    const result = spawnSync(process.execPath, [SCRIPT, '--journeys', 'nope'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /no journey named "nope"/u);
    assert.match(result.stderr, /learn, practice, table, lab, legends, review/u);
  });

  it('the Scenario Lab journey names a scenario that exists in the content bundle', () => {
    const source = readFileSync(SCRIPT, 'utf8');
    const match = /path: '\/lab\/([^']+)'/u.exec(source);
    assert.ok(match?.[1], 'the lab journey must name a /lab/<id> route');
    const id = match[1];
    const dataDir = join(REPO_ROOT, 'packages', 'content', 'data', 'scenarios');
    const ids = readdirSync(dataDir)
      .filter((name) => name.endsWith('.json'))
      .flatMap((name) => JSON.parse(readFileSync(join(dataDir, name), 'utf8')))
      .map((row) => row.id);
    assert.ok(ids.includes(id), `/lab/${id} is not a scenario in packages/content/data/scenarios`);
  });
});

#!/usr/bin/env node
/**
 * Tests for the pure half of `scripts/keyboard-audit.mjs`, the poker-action matcher, the age gate
 * predicate, and the gate wiring in `package.json`. An action button's `textContent` is
 * `Fold0 units`, and `/^fold\b/i` misses it, so the old matcher checked one button in three.
 * The names below are what Chrome reported for `/play?state=decision`. Reverting the matcher fails
 * 5 of 21 tests.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  AGE_GATE_COOKIE_NAMES,
  AGE_GATE_MINIMUM_CEILING,
  hasAgeDeclaration,
  readAgeGateConfig,
} from '../apps/web/src/lib/age-gate.ts';
import {
  actionControlName,
  ageDeclarationCookies,
  isPokerActionName,
  landedOnAgeGate,
  ROUTES,
} from './keyboard-audit.mjs';

// Not a DOM node, because the matcher also runs stringified in the page.
const button = (ariaLabel, textContent) => ({
  getAttribute: (name) => (name === 'aria-label' ? ariaLabel : null),
  textContent,
});

const DECISION_ROW = [
  button('fold, costs 0 units, gives up the hand and any claim on the pot', 'Fold0 units'),
  button('call 35 units', 'Call35 units'),
  button('raise to 70 units, 70 units out of your stack', 'Raise to 7070 units'),
];

const DECISION_ROW_UNLABELLED = DECISION_ROW.map((control) => button(null, control.textContent));

const NOT_ACTIONS = [
  'Folding costs nothing and gives up any claim on the pot.',
  'Deal me in',
  'Play with somebody you know',
  'Deal the next hand',
  'Take seat 3',
  'Stand up',
  'Show the analysis',
  'Start a private table to invite somebody',
  'Join that table',
  'Menu',
  'Close menu',
  'Callout',
  'Betting basics',
  'Checkbox',
  'Recalculate the equity',
  'Bettors are not tracked here',
];

const oldIsPokerActionName = (name) => /^(fold|check|call|bet|raise|all.?in)\b/i.test(name);
const oldActionControlName = (control) => (control.textContent ?? '').replace(/\s+/gu, ' ').trim();

describe('naming a control the way a reader meets it', () => {
  it('prefers the accessible name, which is the sentence the app wrote for it', () => {
    assert.equal(
      actionControlName(DECISION_ROW[0]),
      'fold, costs 0 units, gives up the hand and any claim on the pot',
    );
    assert.equal(actionControlName(DECISION_ROW[1]), 'call 35 units');
  });

  it('falls back to the text when there is no label, and collapses the two spans', () => {
    assert.equal(actionControlName(DECISION_ROW_UNLABELLED[0]), 'Fold0 units');
    assert.equal(actionControlName(button('   ', ' Raise to 70  70 units ')), 'Raise to 70 70 units');
  });

  it('is empty rather than throwing for a control with neither', () => {
    assert.equal(actionControlName(button(null, null)), '');
  });
});

describe('finding the decision row', () => {
  it('matches every control in it, by label', () => {
    const matched = DECISION_ROW.map(actionControlName).filter(isPokerActionName);
    assert.equal(
      matched.length,
      DECISION_ROW.length,
      `only ${matched.length} of ${DECISION_ROW.length} controls matched: ${matched.join(' | ')}`,
    );
  });

  it('matches every control in it from the two-span text alone', () => {
    // `Fold0 units` has no word boundary between the word and the cost.
    const matched = DECISION_ROW_UNLABELLED.map(actionControlName).filter(isPokerActionName);
    assert.deepEqual(matched, ['Fold0 units', 'Call35 units', 'Raise to 7070 units']);
  });

  it('does not fire on prose or on the other controls around it', () => {
    assert.ok(NOT_ACTIONS.length >= 12, `the negative set is too small to prove anything: ${NOT_ACTIONS}`);
    const fired = NOT_ACTIONS.filter(isPokerActionName);
    assert.deepEqual(fired, [], `the matcher fired on ${fired.join(' | ')}`);
  });

  it('still recognises the actions this app does not currently render', () => {
    // Not on the fixture route, so the browser run would not notice if these were lost.
    for (const name of ['check, costs 0 units, stays in the hand', 'Bet to 200', 'All in', 'all-in']) {
      assert.equal(isPokerActionName(name), true, `${name} must be recognised as a poker action`);
    }
  });
});

describe('the matcher the audit used to have', () => {
  it('missed two of the three controls, which is why the boundary changed', () => {
    // The negative control. The old matcher sees one button of three.
    const seen = DECISION_ROW_UNLABELLED.map(oldActionControlName).filter(oldIsPokerActionName);
    assert.deepEqual(
      seen,
      ['Raise to 7070 units'],
      'the old matcher is supposed to see only the control whose label happens to carry a space',
    );
  });

  it('would have been right if it had ever been given a label', () => {
    // `\b` is right about `fold, costs`. The fault was reading `textContent`.
    assert.equal(oldIsPokerActionName('fold, costs 0 units, gives up the hand'), true);
    assert.equal(oldIsPokerActionName('Fold0 units'), false);
    assert.equal(isPokerActionName('Fold0 units'), true);
  });
});

describe('the matcher survives being stringified into the page', () => {
  it('carries no reference to anything outside itself', () => {
    // `new Function` reproduces the page's scope, which has globals and no module bindings.
    const injected = new Function(
      `const prlActionName = ${String(actionControlName)};
       const prlIsAction = ${String(isPokerActionName)};
       return prlIsAction(prlActionName(arguments[0]));`,
    );
    assert.equal(injected(DECISION_ROW[0]), true);
    assert.equal(injected(button(null, 'Deal me in')), false);
  });
});

describe('every route says what it expects to find', () => {
  it('declares actionControls wherever the poker check runs', () => {
    const checked = ROUTES.filter((route) => route.extra?.name === 'checkPokerActions');
    assert.ok(checked.length > 0, 'no route runs the poker-action check at all, so it proves nothing');
    for (const route of checked) {
      assert.ok(
        route.actionControls === 'required' || route.actionControls === 'until-seated',
        `${route.path} runs the poker check without declaring actionControls; the check then has ` +
          'nothing to compare what it found against, which is the state it spent two releases in',
      );
    }
    assert.ok(
      checked.some((route) => route.actionControls === 'required'),
      'at least one route must REQUIRE a decision row, or nothing can ever fail for its absence',
    );
  });

  it('holds enough routes to be a journey audit', () => {
    assert.ok(ROUTES.length >= 12, `only ${ROUTES.length} route(s) are audited`);
    for (const route of ROUTES) {
      assert.equal(typeof route.title, 'string');
      assert.ok(route.path.startsWith('/'), `${route.path} is not a route on this origin`);
    }
  });
});

describe('noticing that the gate answered instead of the page', () => {
  it('fires when a route was replaced by the interstitial', () => {
    assert.equal(landedOnAgeGate('/play', '/age-check'), true);
    assert.equal(landedOnAgeGate('/', '/age-check'), true);
    assert.equal(landedOnAgeGate('/play', '/age-check/'), true);
  });

  it('does not fire when the gate is the page that was asked for', () => {
    // So the interstitial can be audited as itself.
    assert.equal(landedOnAgeGate('/age-check', '/age-check'), false);
  });

  it('does not fire on a path that merely starts with the same letters', () => {
    // Segments, never `includes`, as `age-gate.ts` states at `matchesPrefix`.
    assert.equal(landedOnAgeGate('/play', '/age-checkers'), false);
    assert.equal(landedOnAgeGate('/play', '/play'), false);
    assert.equal(landedOnAgeGate('/learn', '/learn/pot-odds'), false);
  });
});

describe('the declaration the harness seeds', () => {
  it('is accepted by the gate itself, for every threshold the gate can hold', () => {
    // The harness's cookie must be the one the proxy reads, so feed it to the gate's own predicate.
    const header = ageDeclarationCookies('https://lab.example')
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join('; ');
    for (const minimum of [13, 18, 21, AGE_GATE_MINIMUM_CEILING]) {
      assert.equal(hasAgeDeclaration(header, minimum), true, `a gate set to ${minimum} refused the seed`);
    }
    const config = readAgeGateConfig({ PRL_AGE_GATE: 'on', PRL_AGE_GATE_MINIMUM_AGE: '99' });
    assert.equal(hasAgeDeclaration(header, config.minimumAge), true);
  });

  it('sends the prefixed name only where a browser would accept it', () => {
    const overHttp = ageDeclarationCookies('http://127.0.0.1:3210');
    assert.deepEqual(
      overHttp.map((cookie) => cookie.name),
      ['prl_age_check'],
      'a `__Host-` cookie cannot be set over plain HTTP; Chrome refuses it and the seed is then ' +
        'silently absent',
    );
    assert.equal(overHttp[0].secure, false);

    const overHttps = ageDeclarationCookies('https://lab.example');
    assert.deepEqual(
      overHttps.map((cookie) => cookie.name),
      [...AGE_GATE_COOKIE_NAMES],
    );
    for (const cookie of overHttps) assert.equal(cookie.secure, true);
  });

  it('declares a value the gate can parse at all', () => {
    // `readDeclaredAge` refuses anything but one to three digits.
    for (const cookie of ageDeclarationCookies('https://lab.example')) {
      assert.match(cookie.value, /^\d{1,3}$/u);
      assert.equal(cookie.path, '/');
    }
  });
});

describe('the gate starts its own servers, on a port nothing else claims', () => {
  const PACKAGE_JSON = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

  it('runs the audit with a lifecycle rather than expecting one to be there', () => {
    const script = PACKAGE_JSON.scripts['test:keyboard'];
    assert.ok(typeof script === 'string' && script !== '', 'package.json has no `test:keyboard`');
    // The private-table journey needs an API.
    assert.match(script, /--start\b/u);
    assert.match(script, /--with-api\b/u);
    assert.match(script, /scripts\/keyboard-audit\.mjs/u);
  });

  it('claims a port no other gate in package.json claims', () => {
    // Two gates on one port collide under `verify`. Read off the scripts, not a comment. The API port
    // is left out, because `test:a11y`, `test:ax` and `test:keyboard` all need 3001 since
    // `apps/web/next.config.ts` freezes the `/api/*` rewrite, and they never run at once.
    const claimed = new Map();
    const collisions = [];
    for (const [name, body] of Object.entries(PACKAGE_JSON.scripts)) {
      const web = /PRL_WEB_ORIGIN=http:\/\/127\.0\.0\.1:(\d+)/u.exec(body);
      if (web === null) continue;
      const port = web[1];
      if (claimed.has(port)) collisions.push(`${claimed.get(port)} and ${name} both bind :${port}`);
      claimed.set(port, name);
    }
    assert.ok(
      claimed.size >= 3,
      `only ${claimed.size} gate(s) declared a web origin; the sweep read nothing`,
    );
    assert.deepEqual(collisions, []);
    assert.equal(claimed.get('3464'), 'test:keyboard');
  });

  it('is one of the gates `verify` actually runs', () => {
    // Nothing else proves `verify` lists the keyboard gate.
    const gates = /for\s+gate\s+in\s+([^;]+);\s*do/u.exec(PACKAGE_JSON.scripts.verify);
    assert.notEqual(gates, null, 'the `verify` script no longer has a `for gate in ...; do` clause');
    assert.ok(
      gates[1].trim().split(/\s+/u).includes('test:keyboard'),
      'keyboard operability is back to depending on somebody remembering to run it',
    );
  });
});

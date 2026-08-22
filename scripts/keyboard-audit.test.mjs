#!/usr/bin/env node
/**
 * Tests for the pure half of the keyboard audit: what counts as a poker action, and what counts as
 * having been intercepted by the age gate.
 *
 * Run with:  node --test scripts/keyboard-audit.test.mjs
 * Also run by: pnpm run test:scripts
 *
 * ## Why this file exists
 *
 * `scripts/keyboard-audit.mjs` drives Chrome and a test cannot. What it CAN test is the part that
 * decides whether the browser run means anything: the matcher that picks the table's controls out
 * of a page, and the predicate that notices the audit was handed an interstitial instead of the
 * page it asked for. Both had already failed silently in production use, and a silent failure in a
 * matcher is indistinguishable from a clean run.
 *
 * The defect, exactly: an action button in this app is two spans, so `button.textContent` is
 * `Fold0 units`, and `/^fold\b/i` does not match it — there is no word boundary between `d` and
 * `0`. The audit reported "no action controls are on screen in this state" as a warning, a release
 * report recorded that as a benign idle table, and the one route that renders the whole decision
 * row went unchecked for two releases. A second copy of the same regex, written inside a template
 * literal where `\b` is the BACKSPACE escape rather than the word boundary, matched nothing at all.
 *
 * ## Would this fail if the behaviour broke?
 *
 * Yes, and it was checked by breaking it rather than by reasoning about it.
 *
 *   - `the matcher the audit used to have` runs the OLD predicate over the same real strings and
 *     asserts it misses two of the three controls. That block is the negative control for the whole
 *     file: if somebody restores the old boundary, the block that says the new one works fails, and
 *     this one starts passing for the wrong reason — so both halves are asserted together.
 *   - The names fed in are not invented. They are what Chrome reported for
 *     `http://127.0.0.1:3210/play?state=decision` while this was being written: three `aria-label`
 *     values and three `textContent` values, copied out of the audit's own output.
 *   - The prose block feeds the matcher strings from the same page that must NOT match — the
 *     ActionBar's own note, the table's other buttons — because a matcher that fires on everything
 *     is as useless as one that fires on nothing.
 *   - Every scan asserts the size of the set it examined, because "nothing wrong was found" and
 *     "nothing was examined" read identically in a passing report.
 *
 * Three reverts were run against the real file, and the numbers are what came back:
 *
 *   - `actionControlName` back to `textContent` only and `isPokerActionName` back to
 *     `/^(fold|check|call|bet|raise|all.?in)\b/i`  →  5 of 18 tests failed.
 *   - `landedOnAgeGate` loosened to `landedPath.includes(AGE_GATE_PATH)`  →  2 of 18 failed.
 *   - `actionControls: 'required'` deleted from the fixture route in ROUTES  →  1 of 18 failed.
 *
 * Restoring each one returned the file to 18 passing.
 */

import assert from 'node:assert/strict';
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

// ---------------------------------------------------------------------------
// The real thing, as the browser reports it
// ---------------------------------------------------------------------------

/**
 * A stand-in for a DOM button: `getAttribute` and `textContent`, which is all the matcher touches.
 *
 * Deliberately not a DOM node. The matcher has to run in two places — here, and inside the page
 * after being stringified — and anything it can reach in one and not the other is a difference
 * waiting to be found in production instead of here.
 */
const button = (ariaLabel, textContent) => ({
  getAttribute: (name) => (name === 'aria-label' ? ariaLabel : null),
  textContent,
});

/** The decision row at `/play?state=decision`, copied out of Chrome. */
const DECISION_ROW = [
  button('fold, costs 0 units, gives up the hand and any claim on the pot', 'Fold0 units'),
  button('call 35 units', 'Call35 units'),
  button('raise to 70 units, 70 units out of your stack', 'Raise to 7070 units'),
];

/** The same three controls if their labels were ever removed: two spans and nothing else. */
const DECISION_ROW_UNLABELLED = DECISION_ROW.map((control) => button(null, control.textContent));

/** Buttons and prose on the same screens that must not be taken for a decision. */
const NOT_ACTIONS = [
  'Folding costs nothing and gives up any claim on the pot.',
  'Open the table',
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

/** The matcher as it was, for the negative control. */
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
    // This is the case the audit actually met, and the one it could not see: `Fold0 units` has no
    // word boundary between the word and the cost.
    const matched = DECISION_ROW_UNLABELLED.map(actionControlName).filter(isPokerActionName);
    assert.deepEqual(matched, ['Fold0 units', 'Call35 units', 'Raise to 7070 units']);
  });

  it('does not fire on prose or on the other controls around it', () => {
    assert.ok(NOT_ACTIONS.length >= 12, `the negative set is too small to prove anything: ${NOT_ACTIONS}`);
    const fired = NOT_ACTIONS.filter(isPokerActionName);
    assert.deepEqual(fired, [], `the matcher fired on ${fired.join(' | ')}`);
  });

  it('still recognises the actions this app does not currently render', () => {
    // Check, bet and all-in are legal actions the engine offers in other spots. They are not on the
    // fixture route, so nothing in the browser run would notice if the matcher lost them.
    for (const name of ['check, costs 0 units, stays in the hand', 'Bet to 200', 'All in', 'all-in']) {
      assert.equal(isPokerActionName(name), true, `${name} must be recognised as a poker action`);
    }
  });
});

describe('the matcher the audit used to have', () => {
  it('missed two of the three controls, which is why the boundary changed', () => {
    // The negative control for this whole file. If the old boundary comes back, the block above
    // fails and this one keeps passing — so the two are read together, and this one states the
    // exact damage: a check that examined one button out of three and reported a pass.
    const seen = DECISION_ROW_UNLABELLED.map(oldActionControlName).filter(oldIsPokerActionName);
    assert.deepEqual(
      seen,
      ['Raise to 7070 units'],
      'the old matcher is supposed to see only the control whose label happens to carry a space',
    );
  });

  it('would have been right if it had ever been given a label', () => {
    // Worth stating plainly, because "the regex was made looser" is the wrong lesson to take from
    // this fix. `\b` is perfectly correct about `fold, costs 0 units` — a comma IS a word boundary.
    // The fault was reading `textContent`, where the cost runs straight into the word; reading the
    // accessible name is the substantive change, and the boundary only matters for the fallback.
    assert.equal(oldIsPokerActionName('fold, costs 0 units, gives up the hand'), true);
    assert.equal(oldIsPokerActionName('Fold0 units'), false);
    assert.equal(isPokerActionName('Fold0 units'), true);
  });
});

describe('the matcher survives being stringified into the page', () => {
  it('carries no reference to anything outside itself', () => {
    // `MATCHER_SOURCE` injects these two functions into the browser with `String(fn)`, where there
    // is no module scope. A closure over a module-level constant would throw a ReferenceError in
    // Chrome and be reported as "page threw" on every route — or, worse, be caught somewhere and
    // read as "no controls found". `new Function` reproduces exactly that scope: globals only.
    const injected = new Function(
      `const prlActionName = ${String(actionControlName)};
       const prlIsAction = ${String(isPokerActionName)};
       return prlIsAction(prlActionName(arguments[0]));`,
    );
    assert.equal(injected(DECISION_ROW[0]), true);
    assert.equal(injected(button(null, 'Open the table')), false);
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

// ---------------------------------------------------------------------------
// The age gate
// ---------------------------------------------------------------------------

describe('noticing that the gate answered instead of the page', () => {
  it('fires when a route was replaced by the interstitial', () => {
    assert.equal(landedOnAgeGate('/play', '/age-check'), true);
    assert.equal(landedOnAgeGate('/', '/age-check'), true);
    assert.equal(landedOnAgeGate('/play', '/age-check/'), true);
  });

  it('does not fire when the gate is the page that was asked for', () => {
    // Otherwise the interstitial could never be audited as itself, which is the one honest way to
    // cover it.
    assert.equal(landedOnAgeGate('/age-check', '/age-check'), false);
  });

  it('does not fire on a path that merely starts with the same letters', () => {
    // The rule `age-gate.ts` states at its own `matchesPrefix`: segments, never `includes`.
    assert.equal(landedOnAgeGate('/play', '/age-checkers'), false);
    assert.equal(landedOnAgeGate('/play', '/play'), false);
    assert.equal(landedOnAgeGate('/learn', '/learn/pot-odds'), false);
  });
});

describe('the declaration the harness seeds', () => {
  it('is accepted by the gate itself, for every threshold the gate can hold', () => {
    // The point of the whole exercise: the cookie the harness sets and the cookie the proxy reads
    // have to be the same cookie. Asserted by feeding the harness's own header to the gate's own
    // predicate rather than by eyeballing two string literals in two files.
    const header = ageDeclarationCookies('https://lab.example')
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join('; ');
    for (const minimum of [13, 18, 21, AGE_GATE_MINIMUM_CEILING]) {
      assert.equal(hasAgeDeclaration(header, minimum), true, `a gate set to ${minimum} refused the seed`);
    }
    // And the configuration cannot ask for more than the ceiling, because it clamps.
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
    // `readDeclaredAge` refuses anything that is not one to three digits, and a refused cookie is
    // an audit of the interstitial. Cheap to assert, impossible to notice otherwise.
    for (const cookie of ageDeclarationCookies('https://lab.example')) {
      assert.match(cookie.value, /^\d{1,3}$/u);
      assert.equal(cookie.path, '/');
    }
  });
});

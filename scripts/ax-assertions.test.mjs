#!/usr/bin/env node
/**
 * Tests for the certification-assertion checks.
 *
 * Run with:  node --test scripts/ax-assertions.test.mjs
 * Also run by: pnpm run test:scripts
 *
 * ## What is being tested
 *
 * `scripts/ax-assertions.mjs` splits every check into a `gather` that drives Chrome and a `decide`
 * that is a pure function of what was gathered. The `gather` half needs a browser and a running app
 * and is exercised by `pnpm run test:ax`. The `decide` half is the half that says whether something
 * is wrong, and it is testable here.
 *
 * ## Would these fail if the behaviour broke?
 *
 * Yes, and it was checked by breaking things rather than by reasoning about them. There are two
 * layers:
 *
 *   1. **A blanket control over all 45.** Every `decide` is handed a page that produced nothing —
 *      no landmarks, no headings, no controls, no announcements — and must refuse it. A check that
 *      passed an empty page is a check that can never fail, and that failure mode is silent: it
 *      reports a green assertion for the rest of its life. This is the control that catches a
 *      `decide` written with an early `return pass(...)`, or one reading a field `gather` no longer
 *      produces.
 *   2. **Targeted controls on a representative sample**, each fed evidence containing one REAL
 *      defect of the kind the assertion exists to catch — an unnamed contentinfo, a card whose
 *      accessible name says "queen of hearts", an action button announcing "Fold0 units", a verdict
 *      in an assertive region, a Tab that escapes a modal — asserting the specific refusal comes
 *      back, and that the clean version of the same evidence passes. A detector that fires on
 *      everything is as useless as one that fires on nothing, and only having both halves rules
 *      both out.
 *
 * The real components are broken and restored against a live browser in the same spirit; that
 * evidence is in the change's report rather than in a test, because it cannot be automated without
 * shipping a deliberately broken build.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ASSERTION_IDS,
  ASSERTION_ROUTES,
  announcesActionAndCost,
  CARD_NAMED_IN_WORDS,
  CARD_VALUE_WORDS,
  isBareName,
  skippedHeadingLevel,
} from './ax-assertions.mjs';

const everyCheck = ASSERTION_ROUTES.flatMap((route) => route.checks);
const checkFor = (id) => {
  const found = everyCheck.find((check) => check.id === id);
  assert.ok(found !== undefined, `no check with id ${id}`);
  return found;
};

/** A `decide` refuses when it returns `{ok:false}` OR throws — the runner treats both as a failure. */
function refuses(check, evidence) {
  try {
    const verdict = check.decide(evidence);
    return verdict.ok === false;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------

describe('the registry itself', () => {
  it('is well formed, and every check names an assertion exactly once', () => {
    assert.ok(everyCheck.length >= 40, `only ${everyCheck.length} checks in the registry`);
    assert.equal(new Set(ASSERTION_IDS).size, ASSERTION_IDS.length, 'an assertion ID is checked twice');
    for (const check of everyCheck) {
      assert.match(check.id, /^(G\d+|J\d+\.\d+)$/u, `"${check.id}" is not an assertion ID from the document`);
      assert.ok(typeof check.what === 'string' && check.what.length > 20, `${check.id} has no useful label`);
      assert.equal(typeof check.decide, 'function', `${check.id} has no decide()`);
    }
    for (const route of ASSERTION_ROUTES) {
      assert.ok(route.path.startsWith('/'), `${route.key} has no route path`);
      assert.equal(typeof route.gather, 'function', `${route.key} has no gather()`);
      assert.ok(route.checks.length > 0, `${route.key} carries no checks`);
    }
  });
});

describe('NEGATIVE CONTROL — every check refuses a page that produced nothing', () => {
  /**
   * The control against a check that cannot fail.
   *
   * Each `decide` is given the shape it expects with every field emptied: no landmarks, no
   * headings, no controls, no live regions, nothing focused, no interaction having happened. A page
   * in that state is a page that did not render, and there is no assertion in the certification
   * document that such a page satisfies. Any `decide` that answers `ok` to it is either reading a
   * field its `gather` no longer produces, or returning a pass before it has looked at anything.
   */
  const nothing = {
    title: '',
    announcerOnLoad: [],
    announcerAfterNav: [],
    announcer: [],
    frameworkAnnouncers: 0,
    frameworkAnnouncersAfterNav: 0,
    landmarks: [],
    headings: [],
    controls: [],
    unnamedImages: 0,
    themeGroups: [],
    themeOptions: [],
    firstTabStop: { onDocument: true, role: '', name: '', inMain: false, connected: false },
    afterSkipLink: { onDocument: true, role: '', name: '', inMain: false, connected: false },
    navLinkFound: false,
    titleAfterNav: '',
    focusAfterNav: { onSource: false, where: 'body' },
    mainLinks: [],
    panelHeading: null,
    promptHeading: null,
    choiceAnswered: false,
    choiceVerdict: null,
    choiceVerdictCount: 0,
    advanced: false,
    afterNext: { onDocument: true, role: '', name: '' },
    numericFound: false,
    numericInvalid: { ariaInvalid: null, describedBy: [], described: [] },
    numericInvalidAx: null,
    numericChecked: false,
    numericVerdict: null,
    heroCards: [],
    faceDown: [],
    boardCaption: null,
    boardCaptionInTree: false,
    potFirst: null,
    potSecond: null,
    coachHeadings: [],
    coachSections: [],
    assumptions: null,
    slider: null,
    sizerNumber: null,
    actionButtons: [],
    foldTarget: null,
    afterFold: [],
    foldEchoRegions: [],
    afterFoldFocus: { onDocument: true, role: '', name: '' },
    handle: null,
    handleAfter: null,
    h1: '',
    acted: false,
    reveal: null,
    revealRegions: [],
    profileLinks: [],
    traits: [],
    traitImages: [],
    radar: null,
    radarTable: null,
    disclaimers: null,
    triggerFound: false,
    dialog: null,
    focusOnOpen: { onDocument: true, role: '', name: '' },
    forwardStops: [],
    backwardStops: [],
    afterEscape: {
      focus: { onDocument: true, role: '', name: '' },
      trigger: null,
      sheetHidden: false,
    },
    afterDestination: undefined,
    prose: [],
    wayOut: [],
  };

  for (const check of everyCheck) {
    it(`${check.id} refuses it`, () => {
      assert.ok(
        refuses(check, nothing),
        `${check.id} (${check.what}) reported a PASS for a page that rendered nothing. A check that ` +
          'cannot fail is worse than no check: it reads as evidence forever',
      );
    });
  }
});

// ---------------------------------------------------------------------------
// The pure helpers
// ---------------------------------------------------------------------------

describe('isBareName', () => {
  it('accepts a name a reader can act on', () => {
    for (const name of ['Fold', 'Lesson 3: All-Ins and Side Pots', 'Skip to main content', 'ace of hearts']) {
      assert.equal(isBareName(name), false, name);
    }
  });

  it('NEGATIVE CONTROL — refuses nothing, a bare index, a glyph and the role word', () => {
    // Every one of these is a real shape from this app's markup: the `01` index spans, the `›`
    // chevrons and the `×` close glyph are all `aria-hidden`, and each of them becomes a control's
    // whole accessible name the moment that attribute is dropped.
    for (const name of ['', '   ', '3', '01', '›', '×', 'link', 'Button', 'image']) {
      assert.equal(isBareName(name), true, JSON.stringify(name));
    }
  });
});

describe('announcesActionAndCost', () => {
  it('accepts the sentences ActionBar actually ships', () => {
    for (const name of [
      'fold, costs 0 units, gives up the hand and any claim on the pot',
      'check, costs 0 units, stays in the hand and passes the decision on',
      'call 35 units',
      'raise to 70 units, 70 units out of your stack',
      'bet to 120 units, which is all in: 120 units out of your stack',
    ]) {
      assert.equal(announcesActionAndCost(name), true, name);
    }
  });

  it('NEGATIVE CONTROL — refuses the run-together string the aria-label exists to prevent', () => {
    // "Fold0 units" is this button's real `textContent`: the word and the cost are two spans. It is
    // what a reader hears the moment the `aria-label` is removed, and 3.14 names it as a FAIL.
    assert.equal(announcesActionAndCost('Fold0 units'), false);
    assert.equal(announcesActionAndCost('Raise to 70'), false, 'no cost, so nothing about the price');
    assert.equal(announcesActionAndCost('Fold'), false, 'no cost at all');
    assert.equal(announcesActionAndCost(''), false);
    assert.equal(announcesActionAndCost('submit 35 units'), false, 'not one of the legal actions');
  });
});

describe('skippedHeadingLevel', () => {
  it('accepts an outline that never skips', () => {
    assert.equal(skippedHeadingLevel([1, 2, 3, 3, 2, 3, 2]), null);
    assert.equal(skippedHeadingLevel([]), null);
  });

  it('NEGATIVE CONTROL — reports the jump, and says which one', () => {
    assert.equal(skippedHeadingLevel([1, 2, 4]), '2 to 4');
    assert.equal(skippedHeadingLevel([1, 3]), '1 to 3');
    assert.equal(skippedHeadingLevel([1, 2, 3, 2, 5]), '2 to 5');
  });
});

describe('the card vocabulary', () => {
  it('matches every rank and suit this app can name', () => {
    assert.ok(CARD_VALUE_WORDS.test('queen of hearts'));
    assert.ok(CARD_VALUE_WORDS.test('<span data-suit="spade">ace</span>'));
    assert.equal(CARD_VALUE_WORDS.test('face-down card'), false, '"card" is not a rank');
    assert.equal(CARD_VALUE_WORDS.test('Balanced bot hole cards'), false, 'nor is "cards"');
  });

  it('CARD_NAMED_IN_WORDS accepts a spoken card and refuses a glyph pair', () => {
    assert.ok(CARD_NAMED_IN_WORDS.test('ace of spades'));
    assert.ok(CARD_NAMED_IN_WORDS.test('ace of hearts, part of the winning hand'));
    assert.equal(CARD_NAMED_IN_WORDS.test('A♠'), false);
    assert.equal(CARD_NAMED_IN_WORDS.test('As'), false);
    assert.equal(CARD_NAMED_IN_WORDS.test('face-down card'), false);
  });
});

// ---------------------------------------------------------------------------
// Targeted controls, on a representative sample
// ---------------------------------------------------------------------------

const HEALTHY_LANDMARKS = [
  { role: 'banner', name: 'Site' },
  { role: 'navigation', name: 'Primary' },
  { role: 'main', name: '' },
  { role: 'contentinfo', name: 'About Poker Risk Lab' },
  { role: 'navigation', name: 'Sections' },
  { role: 'navigation', name: 'Documents' },
];

describe('NEGATIVE CONTROL — G3, the landmark inventory', () => {
  const check = checkFor('G3');

  it('passes the shell this app actually renders', () => {
    assert.equal(check.decide({ landmarks: HEALTHY_LANDMARKS }).ok, true);
  });

  it('fires on the contentinfo losing its name — the defect writing this check found', () => {
    // For as long as the footer's visually-hidden `h2` merely sat inside the landmark, the computed
    // name was the empty string, and G3 quoted a name the app did not have. A heading INSIDE a
    // landmark does not name it.
    const landmarks = HEALTHY_LANDMARKS.map((landmark) =>
      landmark.role === 'contentinfo' ? { ...landmark, name: '' } : landmark,
    );
    const verdict = check.decide({ landmarks });
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, /contentinfo landmark has no computed name/u);
  });

  it('fires on two navigation landmarks sharing a name', () => {
    const landmarks = HEALTHY_LANDMARKS.map((landmark) =>
      landmark.name === 'Sections' ? { ...landmark, name: 'Primary' } : landmark,
    );
    const verdict = check.decide({ landmarks });
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, /share the computed name "primary"/u);
  });

  it('fires on a missing main', () => {
    const verdict = check.decide({ landmarks: HEALTHY_LANDMARKS.filter((l) => l.role !== 'main') });
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, /0 main landmark/u);
  });
});

describe('NEGATIVE CONTROL — G6, the theme control', () => {
  const check = checkFor('G6');
  const healthy = {
    themeGroups: [{ role: 'group', name: 'Colour theme' }],
    themeOptions: [
      { name: 'Auto Follow the system setting', checked: 'true' },
      { name: 'Light Light theme', checked: 'false' },
      { name: 'Dark Dark theme', checked: 'false' },
    ],
  };

  it('passes the real control', () => {
    assert.equal(check.decide(healthy).ok, true);
  });

  it('fires when nothing reports as selected', () => {
    const options = healthy.themeOptions.map((option) => ({ ...option, checked: 'false' }));
    const verdict = check.decide({ ...healthy, themeOptions: options });
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, /0 of the three theme options report checked/u);
  });

  it('fires when two report as selected at once', () => {
    const options = healthy.themeOptions.map((option) => ({ ...option, checked: 'true' }));
    assert.equal(check.decide({ ...healthy, themeOptions: options }).ok, false);
  });

  it('fires when an option loses its name', () => {
    const options = [healthy.themeOptions[0], { name: '', checked: 'false' }, healthy.themeOptions[2]];
    const verdict = check.decide({ ...healthy, themeOptions: options });
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, /no radio announces as light/u);
  });
});

describe('NEGATIVE CONTROL — G8, the title announced twice', () => {
  const check = checkFor('G8');
  const healthy = {
    navLinkFound: true,
    announcerAfterNav: [{ text: 'Learn — Poker Risk Lab', at: 320 }],
    announcer: [{ role: 'status', name: '', live: 'polite' }],
    frameworkAnnouncersAfterNav: 0,
  };

  it('passes one write from one announcer', () => {
    assert.equal(check.decide(healthy).ok, true);
  });

  it('fires when the framework announcer survives the stand-down', () => {
    // Next 16's own announcer is assertive and lives in a shadow root, so a reader hears the title
    // twice and the second one interrupts. Invisible to every static check.
    const verdict = check.decide({ ...healthy, frameworkAnnouncersAfterNav: 1 });
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, /announced twice/u);
  });

  it('fires when the app writes the title more than once for one navigation', () => {
    const verdict = check.decide({
      ...healthy,
      announcerAfterNav: [
        { text: 'Learn', at: 120 },
        { text: 'Learn — Poker Risk Lab', at: 420 },
      ],
    });
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, /2 distinct texts/u);
  });
});

describe('NEGATIVE CONTROL — 3.8, a hidden card that names itself', () => {
  const check = checkFor('J3.8');

  it('passes correctly hidden cards', () => {
    const faceDown = [
      {
        name: 'face-down card',
        html: '<span class="prl-card--face-down" role="img" aria-label="face-down card"></span>',
        rendered: true,
      },
    ];
    assert.equal(check.decide({ faceDown }).ok, true);
  });

  it('fires on a leak in the computed name, and says it is a hidden-information failure', () => {
    const verdict = check.decide({
      faceDown: [
        { name: 'queen of hearts', html: '<span aria-label="queen of hearts"></span>', rendered: true },
      ],
    });
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, /hidden-information leak/u);
  });

  it('fires on a value that is only in the markup', () => {
    // The case that matters most: the name is correct today and the value is sitting in a `data-`
    // attribute, one ARIA change away from being read out.
    const verdict = check.decide({
      faceDown: [
        {
          name: 'face-down card',
          html: '<span class="prl-card--face-down" data-suit="spade" aria-label="face-down card">ace</span>',
          rendered: true,
        },
      ],
    });
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, /discloses "(ace|spade)"/u);
  });

  it('fires on a face-down card that does not say it is hidden', () => {
    const verdict = check.decide({ faceDown: [{ name: 'card', html: '<span></span>', rendered: true }] });
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, /does not say that it is hidden/u);
  });
});

describe('NEGATIVE CONTROL — 3.14, an action button named from its own content', () => {
  const check = checkFor('J3.14');
  const healthy = {
    actionButtons: [
      { ariaLabel: 'fold, costs 0 units, gives up the hand and any claim on the pot', text: 'Fold0 units' },
      { ariaLabel: 'call 35 units', text: 'Call35 units' },
      { ariaLabel: 'raise to 70 units, 70 units out of your stack', text: 'Raise to 7070 units' },
    ],
  };

  it('passes the sentences ActionBar authors', () => {
    assert.equal(check.decide(healthy).ok, true);
  });

  it('fires when the aria-label is removed, even though the computed name still reads well', () => {
    // The regression this check was rewritten for. With the label gone Chrome names the button from
    // its two spans and produces "Fold 0 units" — a joined name that satisfies any pattern written
    // against the name alone, while the reader has lost the sentence saying what folding does. The
    // first version of this check passed a build with every action label deleted.
    const stripped = healthy.actionButtons.map((button) => ({ ...button, ariaLabel: '' }));
    const verdict = check.decide({ actionButtons: stripped });
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, /carry no aria-label/u);
    assert.match(verdict.detail, /"Fold0 units"/u);
  });

  it('fires on a label that names an action with no cost', () => {
    const verdict = check.decide({ actionButtons: [{ ariaLabel: 'fold', text: 'Fold0 units' }] });
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, /do not announce an action and a cost/u);
  });
});

describe('NEGATIVE CONTROL — 3.10, a pot that counts up out loud', () => {
  const check = checkFor('J3.10');

  it('passes a settled figure', () => {
    assert.equal(check.decide({ potFirst: 'Pot: 100 units', potSecond: 'Pot: 100 units' }).ok, true);
  });

  it('fires when the announced figure moves on its own', () => {
    const verdict = check.decide({ potFirst: 'Pot: 62 units', potSecond: 'Pot: 100 units' });
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, /intermediate numbers counting up/u);
  });

  it('fires when the pot is a bare number with no label', () => {
    assert.equal(check.decide({ potFirst: null, potSecond: null }).ok, false);
  });
});

describe('NEGATIVE CONTROL — 3.15, the decision echo', () => {
  const check = checkFor('J3.15');
  const echo = { role: 'status', live: 'polite', text: 'You chose to fold. A new hand was dealt.' };

  it('passes one polite echo', () => {
    assert.equal(
      check.decide({ foldTarget: 'fold, costs 0 units', afterFold: [echo], foldEchoRegions: [echo] }).ok,
      true,
    );
  });

  it('fires when the echo interrupts', () => {
    const verdict = check.decide({
      foldTarget: 'fold, costs 0 units',
      afterFold: [{ ...echo, role: 'alert', live: 'assertive' }],
      foldEchoRegions: [{ ...echo, role: 'alert', live: 'assertive' }],
    });
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, /cuts off/u);
  });

  it('fires when acting announces nothing at all', () => {
    const verdict = check.decide({ foldTarget: 'fold, costs 0 units', afterFold: [], foldEchoRegions: [] });
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, /told nothing about their own action/u);
  });
});

describe('NEGATIVE CONTROL — 3.16, focus dropped on the floor', () => {
  const check = checkFor('J3.16');

  it('passes a caret on a named status node', () => {
    const verdict = check.decide({
      foldTarget: 'fold',
      afterFoldFocus: { onDocument: false, role: 'status', name: 'Your decision is with the server' },
    });
    assert.equal(verdict.ok, true);
  });

  it('fires when the control that disabled itself took the caret with it', () => {
    const verdict = check.decide({
      foldTarget: 'fold',
      afterFoldFocus: { onDocument: true, role: '', name: '' },
    });
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, /returned to the top of the page/u);
  });

  it('fires when the caret lands somewhere with no name', () => {
    const verdict = check.decide({
      foldTarget: 'fold',
      afterFoldFocus: { onDocument: false, role: 'generic', name: '' },
    });
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, /bare role/u);
  });
});

describe('NEGATIVE CONTROL — 7.2, a modal that leaks', () => {
  const check = checkFor('J7.2');
  const inside = Array.from({ length: 8 }, () => ({ inside: true, where: 'Close menu' }));

  it('passes a sheet nothing escapes', () => {
    assert.equal(check.decide({ forwardStops: inside }).ok, true);
  });

  it('fires the moment one Tab reaches the page behind', () => {
    const stops = [...inside.slice(0, 5), { inside: false, where: 'Learn' }, ...inside.slice(6)];
    const verdict = check.decide({ forwardStops: stops });
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, /left the sheet/u);
    assert.match(verdict.detail, /"Learn"/u);
  });

  it('fires when nothing was pressed at all, rather than reporting a clean trap', () => {
    assert.equal(check.decide({ forwardStops: [] }).ok, false);
  });
});

describe('NEGATIVE CONTROL — 5.4, a chart that is only a picture', () => {
  const check = checkFor('J5.4');
  const healthy = {
    radar: { role: 'image', name: 'Adaptive Exploitative Pro, sixteen trait axes. …' },
    radarTable: {
      inDetails: false,
      rows: [
        ['01', 'Hands played', '0.28'],
        ['02', 'Raises rather than calls', '0.82'],
        ['03', 'Aggression', '0.68'],
      ],
    },
  };

  it('passes a named chart with a table beside it', () => {
    assert.equal(check.decide(healthy).ok, true);
  });

  it('fires when the chart has no name', () => {
    const verdict = check.decide({ ...healthy, radar: { role: 'image', name: '' } });
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, /nothing but an\s+image/u);
  });

  it('fires when the text alternative is gone', () => {
    const verdict = check.decide({ ...healthy, radarTable: null });
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, /only as a picture/u);
  });

  it('fires when the text alternative is hidden behind a disclosure', () => {
    const verdict = check.decide({ ...healthy, radarTable: { ...healthy.radarTable, inDetails: true } });
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, /not reachable by reading/u);
  });
});

describe('NEGATIVE CONTROL — 2.6, the correction announced after the rule', () => {
  const check = checkFor('J2.6');
  const healthy = {
    numericFound: true,
    numericInvalidAx: { invalid: 'true' },
    numericInvalid: {
      ariaInvalid: 'true',
      describedBy: ['q2-invalid', 'q2-hint'],
      described: [
        { id: 'q2-invalid', text: 'That is not a number this question can be checked against. Type digits.' },
        { id: 'q2-hint', text: 'Anything within 1.5 % of the computed figure is accepted.' },
      ],
    },
  };

  it('passes the correction described first', () => {
    assert.equal(check.decide(healthy).ok, true);
  });

  it('fires when the two are described the other way round', () => {
    // Not a nicety: the reader hears the tolerance rule for an answer that was never a number, and
    // the sentence explaining why arrives after it.
    const described = [...healthy.numericInvalid.described].reverse();
    const verdict = check.decide({
      ...healthy,
      numericInvalid: { ...healthy.numericInvalid, described },
    });
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, /before the reason the answer was refused/u);
  });

  it('fires when the field never says it is invalid', () => {
    const verdict = check.decide({
      ...healthy,
      numericInvalid: { ...healthy.numericInvalid, ariaInvalid: null },
    });
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, /aria-invalid="null"/u);
  });
});

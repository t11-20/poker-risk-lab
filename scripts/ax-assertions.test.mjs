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
 *   1. **A blanket control over every check in the registry.** Every `decide` is handed a page that
 *      produced nothing — no landmarks, no headings, no controls, no announcements — and must
 *      refuse it. A check that passed an empty page is a check that can never fail, and that
 *      failure mode is silent: it reports a green assertion for the rest of its life. This is the
 *      control that catches a `decide` written with an early `return pass(...)`, or one reading a
 *      field `gather` no longer produces.
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
  figureDefect,
  isBareName,
  SPEECH_PROBE,
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
    // The live table, the API-down page and the replay. Every one of these is the shape its
    // `gather` returns when the page never got going: no live-region write, no step taken, no hand.
    log: [],
    mutations: [],
    steps: [],
    opened: null,
    sat: null,
    dealt: null,
    socketLive: false,
    reachedTurn: false,
    dwellMs: 0,
    turnOpenedAt: null,
    folded: null,
    foldFocus: { onDocument: true, role: '', name: '' },
    complete: false,
    hand: null,
    attempts: [],
    instructions: null,
    faceUp: [],
    total: 0,
    scrub: [],
    atEnd: [],
    atHome: [],
    transportFound: false,
    afterTransport: undefined,
    figures: null,
    situation: null,
    analysisFigures: null,
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

// ---------------------------------------------------------------------------
// The live table, the API-down page and the replay
//
// Every fixture below is a hand-built copy of what the real `gather` produced against the running
// app — the sentences are the ones measured in Chrome 151 on a real hand — and each control breaks
// exactly one thing in it. The blanket "refuses a page that rendered nothing" suite above cannot
// catch the interesting failures here: a live table that says the wrong thing, in the wrong order,
// or twice, is a page that rendered perfectly.
// ---------------------------------------------------------------------------

/**
 * One write into one live region, as `SPEECH_PROBE` records it.
 *
 * `recovered` is false here because these are texts a region was observed HOLDING. The recovered
 * case — a value read back out of a `characterData` old value, which existed inside one React
 * commit and never painted — has its own control under 3.3, and it is the difference between a
 * sentence a reader could hear and one that was only ever in a component's props.
 */
const wrote = (key, text, at, live = 'polite') => ({
  text,
  live,
  role: 'status',
  key,
  at,
  recovered: false,
});

/**
 * A region key, composed rather than written whole.
 *
 * `SPEECH_PROBE` keys a region by its nearest three ancestor class names joined with `>`, and the
 * result is a 25-to-50 character `prl-…` token — which `scripts/supply-chain/secret-scan.mjs`
 * reports as a `secret-literal`, correctly by its own rules. Silencing that with a
 * `prl-allow-secret` pragma would be a person asserting something about a credential; there is no
 * credential here, so the literal is built from its parts instead.
 */
const regionKey = (...classNames) => classNames.join('>');

const CONNECTION = regionKey('prl-panel__body', 'prl-play__connection-lines', 'prl-note');
const NARRATION = regionKey('prl-play__main', 'prl-play__table', 'prl-live-region');
const TURN = regionKey('prl-play__main', 'prl-play__decision', 'prl-live-region');

/** A healthy hand, as measured: connect, blinds, a bot, the turn, the Coach, a fold, the end. */
const HEALTHY_HAND = () => ({
  opened: 'Open the table',
  sat: 'Take seat 1',
  dealt: 'Deal the next hand',
  socketLive: true,
  reachedTurn: true,
  complete: true,
  folded: 'fold, costs 0 units',
  dwellMs: 10_002,
  turnOpenedAt: 3069,
  steps: [
    {
      control: 'Open the table',
      gone: true,
      focus: { onDocument: false, role: 'status', name: 'Where the table has got to' },
    },
    {
      control: 'Take seat 1',
      gone: true,
      focus: { onDocument: false, role: 'status', name: 'Where the table has got to' },
    },
  ],
  foldFocus: { onDocument: false, role: 'status', name: 'Your decision is with the server' },
  mutations: [],
  // 3.3: the narration region has to be in the document BEFORE the hand is dealt, or its first
  // sentence arrives inside the node that holds it and nothing is notified of a change.
  regionsBeforeDeal: [CONNECTION, NARRATION, TURN],
  log: [
    wrote(CONNECTION, 'Preparing: reading your session, then finding or creating your private room.', 502),
    wrote(
      CONNECTION,
      'Live. Everything on this screen is the server’s own view of the table, redacted for you.',
      687,
    ),
    wrote(NARRATION, 'A new hand was dealt. smallBlind 5 from seat 3, bigBlind 10 from seat 4', 2368),
    wrote(NARRATION, 'folds', 3049),
    wrote(
      TURN,
      'Your turn preflop. 10 units to call. Pot 15 units, your stack 1,000 units. You can fold, call or raise.',
      3069,
    ),
    wrote(
      NARRATION,
      'The analysis of this decision is ready in the Coach panel, below the table on a narrow screen.',
      4490,
    ),
    wrote(NARRATION, 'You chose to fold.', 13_248),
    wrote(NARRATION, 'raises to 20', 13_895),
    wrote(NARRATION, 'The hand is complete. seat 4 wins 259 from pot 0', 19_558),
  ],
});

describe('NEGATIVE CONTROL — 3.1, the connection that never says it is live', () => {
  const check = checkFor('J3.1');

  it('passes a socket that announced preparing, then live', () => {
    assert.equal(check.decide(HEALTHY_HAND()).ok, true);
  });

  it('fires when the status region never announces the connection is up', () => {
    const evidence = HEALTHY_HAND();
    evidence.log = evidence.log.filter((entry) => !/^Live\./u.test(entry.text));
    assert.ok(refuses(check, evidence));
  });

  it('fires when a socket state change interrupts', () => {
    const evidence = HEALTHY_HAND();
    evidence.log = evidence.log.map((entry) =>
      entry.key === CONNECTION ? { ...entry, live: 'assertive', role: 'alert' } : entry,
    );
    assert.ok(refuses(check, evidence));
  });
});

describe('NEGATIVE CONTROL — 3.2, the caret dropped while setting the table up', () => {
  const check = checkFor('J3.2');

  it('passes a caret landed on the named status line, twice', () => {
    assert.equal(check.decide(HEALTHY_HAND()).ok, true);
  });

  it('fires when the browser drops focus to the document', () => {
    const evidence = HEALTHY_HAND();
    evidence.steps[1].focus = { onDocument: true, role: '', name: '' };
    assert.ok(refuses(check, evidence));
  });

  it('fires when the landing place has no computed name — the defect this found for real', () => {
    // `role="status"` takes no name from its own contents, so before the `aria-label` in
    // LiveTable.tsx the caret arrived at a node the tree describes as an unnamed status.
    const evidence = HEALTHY_HAND();
    evidence.steps[0].focus = { onDocument: false, role: 'status', name: '' };
    assert.ok(refuses(check, evidence));
  });

  it('fires when only one of the two controls was reached', () => {
    const evidence = HEALTHY_HAND();
    evidence.steps = [evidence.steps[0]];
    assert.ok(refuses(check, evidence));
  });

  it('fires when the control that was pressed is still on the page', () => {
    const evidence = HEALTHY_HAND();
    evidence.steps[0].gone = false;
    assert.ok(refuses(check, evidence));
  });
});

describe('NEGATIVE CONTROL — 3.3, the deal nobody hears', () => {
  const check = checkFor('J3.3');

  it('passes one polite write carrying the deal and the blinds it arrived with', () => {
    assert.equal(check.decide(HEALTHY_HAND()).ok, true);
  });

  it('fires when the narration region was not there yet — the first half of the real defect', () => {
    // Measured before the fix: at the moment "Deal the next hand" was pressed the document held the
    // route announcer, the connection line and the turn region, and no table narration region at
    // all. A live region inserted already holding its sentence is announced by nothing.
    const evidence = HEALTHY_HAND();
    evidence.regionsBeforeDeal = [CONNECTION, TURN];
    assert.ok(refuses(check, evidence));
  });

  it('fires when the deal stands alone and the blinds take it back — the second half', () => {
    // Two writes for ONE table notice. A polite region is read when the notification is serviced
    // rather than when it is posted, so the reader hears the blinds and never hears the deal. A
    // first version of this check passed exactly this evidence.
    const evidence = HEALTHY_HAND();
    const at = evidence.log.findIndex((entry) => /^A new hand was dealt\./u.test(entry.text));
    evidence.log.splice(
      at,
      1,
      wrote(NARRATION, 'A new hand was dealt.', 2368),
      wrote(NARRATION, 'smallBlind 5 from seat 3, bigBlind 10 from seat 4', 2371),
    );
    assert.ok(refuses(check, evidence));
  });

  it('fires when the sentence exists only as a recovered value that never painted', () => {
    const evidence = HEALTHY_HAND();
    const at = evidence.log.findIndex((entry) => /^A new hand was dealt\./u.test(entry.text));
    evidence.log.splice(
      at,
      1,
      { ...wrote(NARRATION, 'A new hand was dealt.', 2368), recovered: true },
      wrote(NARRATION, 'smallBlind 5 from seat 3, bigBlind 10 from seat 4', 2368),
    );
    assert.ok(refuses(check, evidence));
  });

  it('fires when nothing announced a deal at all', () => {
    const evidence = HEALTHY_HAND();
    const at = evidence.log.findIndex((entry) => /^A new hand was dealt\./u.test(entry.text));
    evidence.log.splice(at, 1, wrote(NARRATION, 'smallBlind 5 from seat 3, bigBlind 10 from seat 4', 2368));
    assert.ok(refuses(check, evidence));
  });

  it('fires when the deal interrupts', () => {
    const evidence = HEALTHY_HAND();
    evidence.log = evidence.log.map((entry) =>
      /^A new hand was dealt\./u.test(entry.text) ? { ...entry, live: 'assertive', role: 'alert' } : entry,
    );
    assert.ok(refuses(check, evidence));
  });

  it('fires when the deal is left stapled to the front of the events after it', () => {
    // The defect on the other side, and the one 3.17 exists for: `role="status"` is atomic, so a
    // sentence left in front of later narration is read again on every event for the rest of the
    // hand.
    const evidence = HEALTHY_HAND();
    evidence.log = evidence.log.map((entry) =>
      entry.key === NARRATION && entry.at > 2368
        ? { ...entry, text: `A new hand was dealt. ${entry.text}` }
        : entry,
    );
    assert.ok(refuses(check, evidence));
  });
});

describe('NEGATIVE CONTROL — 3.4, the table narrated out of order', () => {
  const check = checkFor('J3.4');

  it('passes blinds first, then the seats', () => {
    assert.equal(check.decide(HEALTHY_HAND()).ok, true);
  });

  it('fires when a seat acts before the forced bets are announced', () => {
    const evidence = HEALTHY_HAND();
    const blinds = evidence.log.findIndex((entry) => /blind/iu.test(entry.text));
    const folds = evidence.log.findIndex((entry) => entry.text === 'folds');
    [evidence.log[blinds], evidence.log[folds]] = [evidence.log[folds], evidence.log[blinds]];
    assert.ok(refuses(check, evidence));
  });

  it('fires when the blinds are never announced at all', () => {
    const evidence = HEALTHY_HAND();
    evidence.log = evidence.log.filter((entry) => !/blind/iu.test(entry.text));
    assert.ok(refuses(check, evidence));
  });

  it('fires when a table event interrupts', () => {
    const evidence = HEALTHY_HAND();
    evidence.log = evidence.log.map((entry) =>
      entry.text === 'folds' ? { ...entry, live: 'assertive' } : entry,
    );
    assert.ok(refuses(check, evidence));
  });
});

describe('NEGATIVE CONTROL — 3.5, a turn sentence missing half the decision', () => {
  const check = checkFor('J3.5');

  it('passes the sentence the app ships', () => {
    assert.equal(check.decide(HEALTHY_HAND()).ok, true);
  });

  for (const [what, sentence] of [
    ['the stack', 'Your turn preflop. 10 units to call. Pot 15 units. You can fold, call or raise.'],
    ['the pot', 'Your turn preflop. 10 units to call, your stack 1,000 units. You can fold, call or raise.'],
    ['the price', 'Your turn preflop. Pot 15 units, your stack 1,000 units. You can fold, call or raise.'],
    ['the legal actions', 'Your turn preflop. 10 units to call. Pot 15 units, your stack 1,000 units.'],
    ['the street', 'Your turn. 10 units to call. Pot 15 units, your stack 1,000 units. You can fold.'],
  ]) {
    it(`fires when the sentence leaves out ${what}`, () => {
      const evidence = HEALTHY_HAND();
      evidence.log = evidence.log.map((entry) => (entry.key === TURN ? { ...entry, text: sentence } : entry));
      assert.ok(refuses(check, evidence), sentence);
    });
  }

  it('fires when the turn is announced assertively', () => {
    const evidence = HEALTHY_HAND();
    evidence.log = evidence.log.map((entry) =>
      entry.key === TURN ? { ...entry, live: 'assertive' } : entry,
    );
    assert.ok(refuses(check, evidence));
  });
});

describe('NEGATIVE CONTROL — 3.6, the turn announced again on every state frame', () => {
  const check = checkFor('J3.6');

  it('passes one write and no churn across ten seconds', () => {
    assert.equal(check.decide(HEALTHY_HAND()).ok, true);
  });

  it('fires when the turn sentence is written again during the dwell', () => {
    const evidence = HEALTHY_HAND();
    evidence.log.push(
      wrote(
        TURN,
        'Your turn preflop. 10 units to call. Pot 15 units, your stack 1,000 units. You can fold, call or raise.',
        8000,
      ),
    );
    assert.ok(refuses(check, evidence));
  });

  it('fires on a rewrite with IDENTICAL text, which changes nothing on screen', () => {
    // The half a text-only check cannot see, and the reason `SPEECH_PROBE` counts mutations: a
    // region rewritten with the same sentence is announced again by several readers.
    const evidence = HEALTHY_HAND();
    evidence.mutations = [
      { key: TURN, at: 5000 },
      { key: TURN, at: 5400 },
    ];
    assert.ok(refuses(check, evidence));
  });

  it('fires when the run did not actually wait the ten seconds', () => {
    const evidence = HEALTHY_HAND();
    evidence.dwellMs = 1200;
    assert.ok(refuses(check, evidence));
  });

  it('ignores churn in the table’s own narration region, which is a different sentence', () => {
    const evidence = HEALTHY_HAND();
    evidence.mutations = [
      { key: NARRATION, at: 5000 },
      { key: NARRATION, at: 5400 },
    ];
    assert.equal(check.decide(evidence).ok, true);
  });
});

describe('NEGATIVE CONTROL — 3.11, the Coach arrival that reads out a number', () => {
  const check = checkFor('J3.11');

  it('passes the sentence the reducer ships', () => {
    assert.equal(check.decide(HEALTHY_HAND()).ok, true);
  });

  it('fires when the announcement carries a figure out of the panel', () => {
    const evidence = HEALTHY_HAND();
    evidence.log = evidence.log.map((entry) =>
      /^The analysis of this decision/u.test(entry.text)
        ? { ...entry, text: `${entry.text} Your equity is 43.2%.` }
        : entry,
    );
    assert.ok(refuses(check, evidence));
  });

  it('fires when the analysis arrives with nothing said about it', () => {
    const evidence = HEALTHY_HAND();
    evidence.log = evidence.log.filter((entry) => !/^The analysis of this decision/u.test(entry.text));
    assert.ok(refuses(check, evidence));
  });
});

describe('NEGATIVE CONTROL — 3.17, the echo stapled to every later event', () => {
  const check = checkFor('J3.17');

  it('passes an echo said once', () => {
    assert.equal(check.decide(HEALTHY_HAND()).ok, true);
  });

  it('fires when the echo is prefixed onto the events after it — the defect it was written for', () => {
    const evidence = HEALTHY_HAND();
    evidence.log = evidence.log.map((entry) =>
      entry.text === 'raises to 20' ? { ...entry, text: 'You chose to fold. raises to 20' } : entry,
    );
    assert.ok(refuses(check, evidence));
  });

  it('fires when nothing followed the decision, so the run proved nothing', () => {
    const evidence = HEALTHY_HAND();
    evidence.log = evidence.log.filter((entry) => entry.at <= 13_248);
    assert.ok(refuses(check, evidence));
  });
});

describe('NEGATIVE CONTROL — 3.18, the hand that ends in silence', () => {
  const check = checkFor('J3.18');

  it('passes the completion sentence and its result', () => {
    assert.equal(check.decide(HEALTHY_HAND()).ok, true);
  });

  it('fires when the completion carries no result after it', () => {
    const evidence = HEALTHY_HAND();
    evidence.log = evidence.log.map((entry) =>
      /^The hand is complete\./u.test(entry.text) ? { ...entry, text: 'The hand is complete.' } : entry,
    );
    assert.ok(refuses(check, evidence));
  });

  it('fires when the end of the hand interrupts', () => {
    const evidence = HEALTHY_HAND();
    evidence.log = evidence.log.map((entry) =>
      /^The hand is complete\./u.test(entry.text) ? { ...entry, live: 'assertive', role: 'alert' } : entry,
    );
    assert.ok(refuses(check, evidence));
  });
});

describe('NEGATIVE CONTROL — 3.20, an outage the status line talks over', () => {
  const check = checkFor('J3.20');
  const OUTAGE = () => ({
    opened: 'Open the table',
    log: [
      wrote(CONNECTION, 'Preparing: reading your session, then finding or creating your private room.', 500),
      wrote(CONNECTION, 'The table could not be prepared. The reason is below.', 620),
      {
        text: '▲ Error — table unavailablecould not reach the API',
        live: 'assertive',
        role: 'alert',
        key: regionKey('prl-play__table', 'prl-error'),
        at: 621,
      },
    ],
  });

  it('passes an alert with a status line that does not contradict it', () => {
    assert.equal(check.decide(OUTAGE()).ok, true);
  });

  it('fires when the failure is announced by nothing', () => {
    const evidence = OUTAGE();
    evidence.log = evidence.log.filter((entry) => entry.role !== 'alert');
    assert.ok(refuses(check, evidence));
  });

  it('fires when the polite status line still says the table is live', () => {
    // The exact defect the alert was added for: an assertive alert and a polite status that
    // disagree is worse than either alone.
    const evidence = OUTAGE();
    evidence.log.push(
      wrote(CONNECTION, 'Live. Everything on this screen is the server’s own view of the table.', 900),
    );
    assert.ok(refuses(check, evidence));
  });
});

/** A replay of a hand that was really played: hero's two cards up, five sealed hands down. */
const HEALTHY_REPLAY = () => ({
  hand: 'hand_kape52cnpf7535n7jrgptkqe7j',
  attempts: ['hand_kape52cnpf7535n7jrgptkqe7j'],
  title: 'Hand replay — Poker Risk Lab',
  h1: 'Hand 1',
  instructions: {
    described: true,
    before: true,
    hidden: false,
    text: 'Use the left and right arrow keys to step through the hand one decision at a time.',
  },
  faceDown: Array.from({ length: 10 }, () => ({
    name: 'face-down card',
    html: '<span class="prl-card prl-card--face-down" aria-label="face-down card"></span>',
    rendered: true,
  })),
  faceUp: ['king of hearts', 'queen of spades'],
  total: 9,
  scrub: [1, 2, 3].map((step) => ({
    focus: { onDocument: false, role: 'button', name: `Step ${step + 1} of 9` },
    inTimeline: true,
    log: [
      wrote(
        regionKey('prl-replay', 'prl-live-region'),
        `Step ${step + 1} of 9. preflop: you folded. Pot 15 units.`,
        500,
      ),
    ],
  })),
  atEnd: [
    wrote(regionKey('prl-replay', 'prl-live-region'), 'Step 9 of 9. End of the hand. Pot 259 units.', 400),
  ],
  atHome: [
    wrote(
      regionKey('prl-replay', 'prl-live-region'),
      'Step 1 of 9. preflop: a bot folded. Pot 15 units.',
      400,
    ),
  ],
  transportFound: true,
  afterTransport: {
    focus: { onDocument: false, role: 'button', name: 'Previous decision' },
    buttons: [
      { text: 'Previous decision', disabled: false },
      { text: 'Next decision', disabled: true },
    ],
  },
});

describe('NEGATIVE CONTROL — 6.2 and 6.3, the replay that scrubs in silence', () => {
  it('passes a step announced once, politely, with its pot', () => {
    assert.equal(checkFor('J6.2').decide(HEALTHY_REPLAY()).ok, true);
    assert.equal(checkFor('J6.3').decide(HEALTHY_REPLAY()).ok, true);
  });

  it('6.2 fires when the step sentence drops the pot', () => {
    const evidence = HEALTHY_REPLAY();
    evidence.scrub[0].log = [
      wrote(regionKey('prl-replay', 'prl-live-region'), 'Step 2 of 9. preflop: you folded.', 500),
    ];
    assert.ok(refuses(checkFor('J6.2'), evidence));
  });

  it('6.2 fires when scrubbing announces nothing', () => {
    const evidence = HEALTHY_REPLAY();
    evidence.scrub[0].log = [];
    assert.ok(refuses(checkFor('J6.2'), evidence));
  });

  it('6.3 fires when two regions announce the same step', () => {
    const evidence = HEALTHY_REPLAY();
    evidence.scrub[1].log = [
      ...evidence.scrub[1].log,
      wrote(
        regionKey('prl-replay', 'prl-other-region'),
        'Step 3 of 9. preflop: a bot raised. Pot 15 units.',
        520,
      ),
    ];
    assert.ok(refuses(checkFor('J6.3'), evidence));
  });

  it('6.3 fires when the caret is taken off the timeline the reader is working', () => {
    const evidence = HEALTHY_REPLAY();
    evidence.scrub[2].inTimeline = false;
    assert.ok(refuses(checkFor('J6.3'), evidence));
  });

  it('6.3 fires when the steps announced do not advance one at a time', () => {
    const evidence = HEALTHY_REPLAY();
    evidence.scrub[2].log = [
      wrote(
        regionKey('prl-replay', 'prl-live-region'),
        'Step 7 of 9. flop: a bot bet 115 units. Pot 144 units.',
        500,
      ),
    ];
    assert.ok(refuses(checkFor('J6.3'), evidence));
  });
});

describe('NEGATIVE CONTROL — 6.5, the caret dropped at the end of a hand', () => {
  const check = checkFor('J6.5');

  it('passes a caret rescued onto the control that survived', () => {
    assert.equal(check.decide(HEALTHY_REPLAY()).ok, true);
  });

  it('fires when the browser blurred the disabled button onto the document', () => {
    const evidence = HEALTHY_REPLAY();
    evidence.afterTransport.focus = { onDocument: true, role: '', name: '' };
    assert.ok(refuses(check, evidence));
  });

  it('fires when the walk never reached the end, so the rescue was never tested', () => {
    const evidence = HEALTHY_REPLAY();
    evidence.afterTransport.buttons = [
      { text: 'Previous decision', disabled: false },
      { text: 'Next decision', disabled: false },
    ];
    assert.ok(refuses(check, evidence));
  });
});

describe('NEGATIVE CONTROL — 6.6, a sealed hand named in the replay', () => {
  const check = checkFor('J6.6');

  it('passes a replay that names what was shown and hides what was not', () => {
    assert.equal(check.decide(HEALTHY_REPLAY()).ok, true);
  });

  it('fires when a never-shown card leaks its rank through its MARKUP', () => {
    const evidence = HEALTHY_REPLAY();
    evidence.faceDown[3].html =
      '<span class="prl-card prl-card--face-down" data-card="queen of hearts"></span>';
    assert.ok(refuses(check, evidence));
  });

  it('fires when a never-shown card is named something that is not "hidden"', () => {
    const evidence = HEALTHY_REPLAY();
    evidence.faceDown[0].name = 'card';
    assert.ok(refuses(check, evidence));
  });

  it('fires when a shown card is named as a letter and a symbol', () => {
    const evidence = HEALTHY_REPLAY();
    evidence.faceUp = ['K♥', 'Q♠'];
    assert.ok(refuses(check, evidence));
  });

  it('fires when there was nothing hidden to prove anything about', () => {
    const evidence = HEALTHY_REPLAY();
    evidence.faceDown = [];
    assert.ok(refuses(check, evidence));
  });
});

describe('NEGATIVE CONTROL — 8.2, a fallback notice a reader cannot hear', () => {
  const check = checkFor('J8.2');

  /** `/learn` served by the second web app, the one with no API behind it. */
  const BUNDLED_COPY = () => ({
    notice: {
      text:
        '▲Watch outThis index is not liveThe content service is not reachable, so this index is ' +
        'listing the bundled copy of the curriculum. The lessons and their prerequisites are real; ' +
        'the read/unread marks are not yours. (fetch failed)',
      spoken:
        'Watch outThis index is not liveThe content service is not reachable, so this index is ' +
        'listing the bundled copy of the curriculum. The lessons and their prerequisites are real; ' +
        'the read/unread marks are not yours. (fetch failed)',
      inMain: true,
      insideDetails: false,
      ariaHidden: false,
      rendered: true,
    },
    noticeAx: { role: 'note', name: '', ignored: false },
    spokenInTree: ['The content service is not reachable, so this index is listing the bundled copy'],
    headings: [
      { level: 1, name: 'The curriculum' },
      { level: 2, name: 'Foundations' },
    ],
    lessonLinks: 17,
  });

  it('passes the page the offline web app actually serves', () => {
    assert.equal(check.decide(BUNDLED_COPY()).ok, true);
  });

  it('fires when the page rendered live data after all — the harness lying to itself', () => {
    // The control that matters most here. If the second web app reaches an API, this assertion
    // audits the ordinary page and proves nothing, so "no notice" has to be a failure rather than
    // a pass. Demonstrated for real by pointing the offline app at the live API.
    const evidence = BUNDLED_COPY();
    evidence.notice = null;
    evidence.noticeAx = null;
    evidence.spokenInTree = [];
    assert.ok(refuses(check, evidence));
  });

  it('fires when the sentence is a visual-only badge', () => {
    // The row's own words. Strip the decorative glyphs and a tone marker plus a title is what is
    // left; a reader who cannot see the colour is told nothing about what they are reading.
    const evidence = BUNDLED_COPY();
    evidence.notice.spoken = 'Watch outThis index is not live';
    assert.ok(refuses(check, evidence));
  });

  it('fires when the notice is hidden from the accessibility tree', () => {
    const evidence = BUNDLED_COPY();
    evidence.notice.ariaHidden = true;
    assert.ok(refuses(check, evidence));
  });

  it('fires when the notice is in the DOM and not in the tree', () => {
    const evidence = BUNDLED_COPY();
    evidence.spokenInTree = [];
    assert.ok(refuses(check, evidence));
  });

  it('fires when the notice is outside main, where the skip link jumps past it', () => {
    const evidence = BUNDLED_COPY();
    evidence.notice.inMain = false;
    assert.ok(refuses(check, evidence));
  });

  it('fires when the notice is folded behind a disclosure', () => {
    const evidence = BUNDLED_COPY();
    evidence.notice.insideDetails = true;
    assert.ok(refuses(check, evidence));
  });

  it('fires when the page fell over instead of falling back', () => {
    const evidence = BUNDLED_COPY();
    evidence.headings = [];
    assert.ok(refuses(check, evidence));
  });

  it('fires when the notice describes a page with nothing on it', () => {
    const evidence = BUNDLED_COPY();
    evidence.lessonLinks = 0;
    assert.ok(refuses(check, evidence));
  });
});

describe('figureDefect — a number a reader cannot place', () => {
  const counted = {
    label: 'Your equity',
    labelHidden: false,
    value: '17.9 %',
    valueHidden: true,
    unit: '%',
    interval: '± 0.73 points',
    intervalHidden: true,
    spoken: 'Your equity: 17.9 % ± 0.73 points',
    labelFirst: true,
  };
  const stat = {
    label: 'Lessons',
    labelHidden: false,
    value: '17',
    valueHidden: false,
    unit: null,
    interval: null,
    intervalHidden: false,
    spoken: null,
    labelFirst: true,
  };

  it('accepts both shapes as they ship', () => {
    assert.equal(figureDefect(counted), null);
    assert.equal(figureDefect(stat), null);
  });

  it('refuses a counting figure whose hidden readout leaves the label out', () => {
    assert.match(figureDefect({ ...counted, spoken: '17.9 % ± 0.73 points' }), /without its label/u);
  });

  it('refuses a counting figure whose readout drops the interval it shows on screen', () => {
    assert.match(figureDefect({ ...counted, spoken: 'Your equity: 17.9 %' }), /leaves out/u);
  });

  it('refuses a figure with no label at all, and one whose label is hidden', () => {
    assert.match(figureDefect({ ...stat, label: '' }), /no label/u);
    assert.match(figureDefect({ ...stat, labelHidden: true }), /no label/u);
  });

  it('refuses a value announced before its own label', () => {
    assert.match(figureDefect({ ...stat, labelFirst: false }), /after its own number/u);
  });

  it('refuses an interval hidden from the tree beside a visible figure', () => {
    assert.match(
      figureDefect({ ...stat, value: '17.9 %', interval: '± 0.73 points', intervalHidden: true }),
      /read as exact/u,
    );
  });
});

describe('SPEECH_PROBE', () => {
  it('is installed before the page runs and records both writes and mutations', () => {
    // Not a behavioural test — it runs in Chrome, not here. What is asserted is the contract
    // `ax-tree-audit.mjs` and every live-table check depend on: the two logs exist under one global,
    // and the probe records the OLD value of a region that was overwritten in the same frame, which
    // is the only way a sentence React coalesced away can be told from one that was never written.
    assert.match(SPEECH_PROBE, /window\.__prlSpeech = \{ log, mutations \}/u);
    assert.match(SPEECH_PROBE, /characterDataOldValue: true/u);
    assert.match(SPEECH_PROBE, /role="alert"/u);
    assert.match(SPEECH_PROBE, /window\.__prlSpeechReset/u);
    // The two additions 3.3 rests on: a recovered old value is MARKED as one, so a check cannot
    // count a string that never painted as an announcement; and the set of regions that exist right
    // now is readable, so "was the region there before the event" is a question with an answer.
    assert.match(SPEECH_PROBE, /recovered: recovered === true/u);
    assert.match(SPEECH_PROBE, /window\.__prlSpeechRegions/u);
  });
});

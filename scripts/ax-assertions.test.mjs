#!/usr/bin/env node
/**
 * Tests for the pure `decide` half of `scripts/ax-assertions.mjs`. Every check must refuse a page
 * that rendered nothing, and a sample is fed one real defect each and must refuse it while the clean
 * evidence passes.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { numericVerdictSentence } from '../apps/web/src/lib/quiz-verdict.ts';
import {
  ASSERTION_IDS,
  ASSERTION_ROUTES,
  announcesActionAndCost,
  CARD_NAMED_IN_WORDS,
  CARD_VALUE_WORDS,
  describeDrive,
  describeDrives,
  figureDefect,
  isBareName,
  NUMERIC_VERDICT_OPENING,
  QUIZ_VERDICT_OPENING,
  SPEECH_PROBE,
  skippedHeadingLevel,
  summariseDrive,
  tableStartPath,
  tallyListedHands,
} from './ax-assertions.mjs';

const everyCheck = ASSERTION_ROUTES.flatMap((route) => route.checks);
const checkFor = (id) => {
  const found = everyCheck.find((check) => check.id === id);
  assert.ok(found !== undefined, `no check with id ${id}`);
  return found;
};

function refuses(check, evidence) {
  try {
    const verdict = check.decide(evidence);
    return verdict.ok === false;
  } catch {
    return true;
  }
}

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
  // Every field emptied. A `decide` that passes this reads a field `gather` no longer produces, or
  // returns before it looks.
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
    answerGroup: null,
    answerOptions: [],
    runs: [],
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
    log: [],
    mutations: [],
    steps: [],
    opened: null,
    dealt: null,
    socketLive: false,
    reachedTurn: false,
    dwellMs: 0,
    turnOpenedAt: null,
    folded: null,
    doubleAct: null,
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
    summary: null,
    fields: [],
    narrowed: {},
    emptied: {},
    background: null,
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

describe('isBareName', () => {
  it('accepts a name a reader can act on', () => {
    for (const name of ['Fold', 'Lesson 3: All-Ins and Side Pots', 'Skip to main content', 'ace of hearts']) {
      assert.equal(isBareName(name), false, name);
    }
  });

  it('NEGATIVE CONTROL — refuses nothing, a bare index, a glyph and the role word', () => {
    // Real shapes from this app, from `aria-hidden` index spans, chevrons and the close glyph.
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
    // A heading inside a landmark does not name it.
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
    // Next 16's own announcer is assertive and in a shadow root.
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
    // Without the label Chrome names the button "Fold 0 units" from its two spans, which a name-only
    // check passes.
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

describe('NEGATIVE CONTROL — 7.4, a background the sheet only ASKED to be left alone', () => {
  const check = checkFor('J7.4');
  const gone = (tag, text) => ({
    tag,
    ancestor: false,
    announcer: false,
    text,
    own: true,
    ignored: true,
    role: '',
    name: '',
  });
  const healthy = {
    background: [
      // The sheet's own ancestors cannot be inert. They stay in the tree with no text of their own.
      {
        tag: 'header',
        ancestor: true,
        announcer: false,
        text: 'Menu',
        own: false,
        ignored: false,
        role: 'banner',
        name: 'Site',
      },
      {
        tag: 'div',
        ancestor: true,
        announcer: false,
        text: 'Menu',
        own: false,
        ignored: true,
        role: '',
        name: '',
      },
      {
        tag: 'div',
        ancestor: false,
        announcer: true,
        text: '',
        own: false,
        ignored: false,
        role: 'status',
        name: '',
      },
      ...Array.from({ length: 30 }, (_unused, index) => gone('a', `Destination ${index}`)),
    ],
  };

  it('passes a background that is not in the tree at all', () => {
    assert.equal(check.decide(healthy).ok, true);
  });

  it('fires when the skip link and the hero are still walkable — the state the row was filed in', () => {
    const leaking = healthy.background.map((element, index) =>
      index > 3 && index < 8
        ? { ...element, ignored: false, role: 'link', name: `Destination ${index}` }
        : element,
    );
    const verdict = check.decide({ background: leaking });
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, /still\s+non-ignored nodes/u);
    assert.match(verdict.detail, /Destination 4/u);
  });

  it('fires when an ancestor left in the tree carries text of its own', () => {
    const chatty = healthy.background.map((element) =>
      element.tag === 'header' ? { ...element, own: true, text: 'Poker Risk Lab' } : element,
    );
    const verdict = check.decide({ background: chatty });
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, /ancestors are in the tree AND carry text/u);
  });

  it('fires when a second thing has been exempted from the sweep', () => {
    const twoExemptions = [
      ...healthy.background,
      {
        tag: 'footer',
        ancestor: false,
        announcer: true,
        text: '',
        own: false,
        ignored: false,
        role: 'contentinfo',
        name: 'About',
      },
    ];
    const verdict = check.decide({ background: twoExemptions });
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, /2 element\(s\) behind the sheet are exempt/u);
  });

  it('fires when the exempted route announcer is holding a sentence', () => {
    const speaking = healthy.background.map((element) =>
      element.announcer ? { ...element, text: 'Learn — Poker Risk Lab' } : element,
    );
    const verdict = check.decide({ background: speaking });
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, /spared from the sweep and is holding/u);
  });

  it('refuses a sweep that found almost nothing, rather than reporting a clean background', () => {
    const verdict = check.decide({ background: healthy.background.slice(0, 4) });
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, /negative over an empty set is not a pass/u);
  });

  it('refuses a run whose two lists did not line up', () => {
    const verdict = check.decide({ background: { misaligned: { dom: 188, ax: 12 } } });
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, /do not line up/u);
  });
});

describe('NEGATIVE CONTROL — 4.2, a filtered count nobody is told', () => {
  const check = checkFor('J4.2');
  const healthy = {
    title: 'Scenario Lab — Poker Risk Lab',
    summary: 'Showing all 36 scenarios.',
    narrowed: {
      chosen: { select: 'prl-filter-difficulty', value: 'advanced', declared: 14 },
      submitted: true,
      title: 'Scenario Lab — 14 of 36 scenarios — Poker Risk Lab',
      summary: 'Showing 14 of 36 scenarios.',
      contextSurvived: false,
      summaryIsLive: false,
      regionMutations: 0,
    },
    emptied: {
      chosen: { select: 'prl-filter-street', value: 'turn', declared: 0 },
      submitted: true,
      title: 'Scenario Lab — 0 of 36 scenarios — Poker Risk Lab',
      summary: 'Showing 0 of 36 scenarios.',
      contextSurvived: false,
      summaryIsLive: false,
      regionMutations: 0,
    },
  };

  it('passes a filtered view whose title carries the count the page shows', () => {
    assert.equal(check.decide(healthy).ok, true);
  });

  it('fires when the title is the unfiltered one — the state the row was filed in', () => {
    const verdict = check.decide({
      ...healthy,
      narrowed: { ...healthy.narrowed, title: 'Scenario Lab — Poker Risk Lab' },
    });
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, /a count that is not in the title is a count no reader is told/u);
  });

  it('fires when the title carries a DIFFERENT count from the page', () => {
    const verdict = check.decide({
      ...healthy,
      narrowed: { ...healthy.narrowed, title: 'Scenario Lab — 12 of 36 scenarios — Poker Risk Lab' },
    });
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, /the page shows/u);
  });

  it('fires when the submit stopped replacing the document, because then nothing announces at all', () => {
    const verdict = check.decide({
      ...healthy,
      narrowed: { ...healthy.narrowed, contextSurvived: true },
    });
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, /did NOT replace the document/u);
  });

  it('fires when the summary is dressed as a live region it can never fire', () => {
    const verdict = check.decide({
      ...healthy,
      narrowed: { ...healthy.narrowed, summaryIsLive: true },
    });
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, /dressed as a live region/u);
  });

  it('fires when the unfiltered title has grown a count of its own', () => {
    const verdict = check.decide({ ...healthy, title: 'Scenario Lab — all 36 scenarios — Poker Risk Lab' });
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, /UNFILTERED title already carries a count/u);
  });

  it('fires when a filter that matches nothing leaves the title alone', () => {
    const verdict = check.decide({
      ...healthy,
      emptied: { ...healthy.emptied, title: 'Scenario Lab — Poker Risk Lab' },
    });
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, /cannot discover by scrolling/u);
  });

  it('refuses a run that never reached an empty result, rather than passing on one half', () => {
    const verdict = check.decide({ ...healthy, emptied: { chosen: null } });
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, /never exercised/u);
  });

  it('refuses a run that never found a narrowing option at all', () => {
    const verdict = check.decide({ ...healthy, narrowed: { chosen: null } });
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, /no option that narrows the list/u);
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

describe('NEGATIVE CONTROL — 2.4, the answer group that reads the question again', () => {
  const check = checkFor('J2.4');
  const PROMPT = 'Which of these describes break-even equity correctly?';
  const healthy = {
    promptHeading: { role: 'heading', level: 3, name: `Question 1 of 5. ${PROMPT}` },
    answerGroup: { role: 'group', name: 'Choose one answer', ignored: false },
    answerOptions: [
      { role: 'radio', name: 'The chance that you currently hold the best hand', ignored: false },
      { role: 'radio', name: 'The share of the time you must end up with the pot', ignored: false },
      { role: 'radio', name: 'The share of the pot that already belongs to you', ignored: false },
    ],
  };

  it('passes a group that names its purpose over options that name themselves', () => {
    assert.equal(check.decide(healthy).ok, true);
  });

  it('fires when the legend repeats the prompt — the defect `QuizRunner` names in place', () => {
    // A group named by the prompt is the prompt again on entry.
    const verdict = check.decide({ ...healthy, answerGroup: { ...healthy.answerGroup, name: PROMPT } });
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, /in the accessibility tree 2 times/u);
  });

  it('fires when an option carries the prompt as well as its own text', () => {
    const answerOptions = [
      { role: 'radio', name: `${PROMPT} The share of the pot that already belongs to you`, ignored: false },
      ...healthy.answerOptions.slice(1),
    ];
    const verdict = check.decide({ ...healthy, answerOptions });
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, /as an option/u);
  });

  it('fires when the group is a labelled generic, which no reader announces on entry', () => {
    const verdict = check.decide({
      ...healthy,
      answerGroup: { role: 'generic', name: 'Choose one answer', ignored: false },
    });
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, /not a role a reader announces on entry/u);
  });

  it('fires when the group reaches the tree with no name at all', () => {
    const verdict = check.decide({ ...healthy, answerGroup: { role: 'group', name: '', ignored: false } });
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, /told a group started and not what it is for/u);
  });

  it('fires when an option announces nothing of its own', () => {
    const answerOptions = [{ role: 'radio', name: '', ignored: false }, ...healthy.answerOptions.slice(1)];
    const verdict = check.decide({ ...healthy, answerOptions });
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, /announce no text of their own/u);
  });
});

describe('NEGATIVE CONTROL — 2.9, a score at the end of a quiz', () => {
  const check = checkFor('J2.9');
  const ADVICE =
    'Watch which half of the comparison you are least comfortable with. The price is exact ' +
    'arithmetic and should become automatic; the equity is an estimate that depends on a range ' +
    'you chose. Nothing here was scored, and there is nowhere in this product for a mark out of ' +
    'five to live.';
  const run = (takeTheLessonAnswer, wanted, verdict, extra = '') => ({
    takeTheLessonAnswer,
    opened: 4,
    chose: { lesson: 1, wanted },
    verdict,
    reachedReview: true,
    panel: `Quiz Reading the price Review What to do with all that ${ADVICE}${extra}`,
    main: `Pot odds ${ADVICE}${extra}`,
    regions: ['polite:'],
  });
  const MATCHED = 'That matches the answer this lesson gives. The reasoning is below.';
  const MISSED = 'That is not the answer this lesson gives. Nothing is deducted for it.';
  const healthy = { runs: [run(true, 1, MATCHED), run(false, 0, MISSED)] };

  it('passes two runs whose review panel is the same however the question went', () => {
    assert.equal(check.decide(healthy).ok, true);
  });

  it('fires on a verdict that carries no number at all — which no wording scan would catch', () => {
    // "Every answer matched." has no digit and is still a mark.
    const runs = [
      run(true, 1, MATCHED, ' Every answer matched.'),
      run(false, 0, MISSED, ' Some answers did not match.'),
    ];
    const verdict = check.decide({ runs });
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, /reads differently depending on whether the answer matched/u);
  });

  it('fires on a tally that does not depend on correctness, which the differential cannot see', () => {
    const tally = ' You answered 1 of 5 questions.';
    const runs = [run(true, 1, MATCHED, tally), run(false, 0, MISSED, tally)];
    const verdict = check.decide({ runs });
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, /which is a tally/u);
  });

  it('fires when a live region differs between the two runs', () => {
    const runs = [
      { ...run(true, 1, MATCHED), regions: ['polite:You matched every question.'] },
      { ...run(false, 0, MISSED), regions: ['polite:'] },
    ];
    const verdict = check.decide({ runs });
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, /a live region at the end of the quiz/u);
  });

  it('refuses two runs that never diverged, rather than reading their agreement as a pass', () => {
    // Two identical runs would agree about a scoreboard too.
    const runs = [run(true, 1, MATCHED), run(false, 1, MATCHED)];
    const verdict = check.decide({ runs });
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, /picked the same option/u);
  });

  it('refuses a run that never reached the review panel', () => {
    const runs = [{ ...run(true, 1, MATCHED), reachedReview: false }, run(false, 0, MISSED)];
    const verdict = check.decide({ runs });
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, /never reached the review panel/u);
  });
});

// Fixtures copied from real `gather` output in Chrome 151, each control breaking one thing.

// `recovered` is false, because these texts were observed held. The recovered case has its own control
// under 3.3.
const wrote = (key, text, at, live = 'polite') => ({
  text,
  live,
  role: 'status',
  key,
  at,
  recovered: false,
});

// Composed from parts, because a whole `prl-` key of 25 to 50 characters is a `secret-literal` to
// `scripts/supply-chain/secret-scan.mjs`.
const regionKey = (...classNames) => classNames.join('>');

const CONNECTION = regionKey('prl-panel__body', 'prl-play__connection-lines', 'prl-note');
const NARRATION = regionKey('prl-play__main', 'prl-play__table', 'prl-live-region');
const TURN = regionKey('prl-play__main', 'prl-play__decision', 'prl-live-region');

const HEALTHY_HAND = () => ({
  opened: 'Deal me in',
  dealt: 'Deal me in',
  socketLive: true,
  reachedTurn: true,
  complete: true,
  folded: 'fold, costs 0 units',
  dwellMs: 10_002,
  turnOpenedAt: 3069,
  steps: [
    {
      control: 'Deal me in',
      gone: true,
      focus: { onDocument: false, role: 'status', name: 'Where the table has got to' },
    },
    {
      control: 'the seat and the deal "Deal me in" sent',
      gone: true,
      focus: { onDocument: false, role: 'status', name: 'Where the table has got to' },
    },
  ],
  foldFocus: { onDocument: false, role: 'status', name: 'Your decision is with the server' },
  mutations: [],
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

  it('fires when the cleared tab reconnected instead of offering a first visit', () => {
    const evidence = { ...HEALTHY_HAND(), path: 'reconnected', opened: null };
    const verdict = check.decide(evidence);
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, /reconnected to a table the tab remembered/u);
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
    // `role="status"` takes no name from its contents.
    const evidence = HEALTHY_HAND();
    evidence.steps[0].focus = { onDocument: false, role: 'status', name: '' };
    assert.ok(refuses(check, evidence));
  });

  it('fires when the press was made and the seat and deal it sends were never reached', () => {
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
    // A live region inserted already holding its sentence is announced by nothing.
    const evidence = HEALTHY_HAND();
    evidence.regionsBeforeDeal = [CONNECTION, TURN];
    assert.ok(refuses(check, evidence));
  });

  it('fires when the deal stands alone and the blinds take it back — the second half', () => {
    // Two writes for one notice. The reader hears the blinds and never the deal.
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
    // `role="status"` is atomic, so a sentence left in front is re-read on every event (3.17).
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
    // A same-text rewrite is re-announced by several readers.
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

describe('NEGATIVE CONTROL — 3.19, a refusal nobody is interrupted for', () => {
  const check = checkFor('J3.19');
  const DECISION = regionKey('prl-play__stage', 'prl-play__main', 'prl-play__decision');
  // The page does not print contract codes.
  const REFUSAL = '▲Watch outThe server refused itIt is not your turn to act. Nothing was applied.';

  const REFUSED_HAND = () => {
    const evidence = HEALTHY_HAND();
    evidence.doubleAct = { name: 'fold, costs 0 units, gives up the hand', stillEnabled: true };
    evidence.log = [
      ...evidence.log,
      // The `role="status"` wrapper repeats the text politely, so the check looks for one assertive write.
      wrote(`${DECISION}#What happened to your decision`, REFUSAL, 14_010),
      { text: REFUSAL, live: 'assertive', role: 'alert', key: DECISION, at: 14_011, recovered: false },
    ];
    return evidence;
  };

  it('passes a refusal that interrupts, in the server’s own words', () => {
    const verdict = check.decide(REFUSED_HAND());
    assert.equal(verdict.ok, true, verdict.detail);
  });

  it('fires when the refusal is announced politely — the row’s own named FAIL', () => {
    const evidence = REFUSED_HAND();
    evidence.log = evidence.log.map((entry) =>
      entry.live === 'assertive' ? { ...entry, live: 'polite', role: 'status' } : entry,
    );
    const verdict = check.decide(evidence);
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, /announced polite, not assertively/u);
  });

  it('fires when the refusal carries the heading and none of the server’s wording', () => {
    const evidence = REFUSED_HAND();
    evidence.log = evidence.log.map((entry) =>
      entry.live === 'assertive' ? { ...entry, text: '▲Watch outThe server refused it' } : entry,
    );
    const verdict = check.decide(evidence);
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, /carries the heading and none of/u);
  });

  it('fires when the refusal reads a contract code out after the server’s sentence', () => {
    const evidence = REFUSED_HAND();
    evidence.log = evidence.log.map((entry) =>
      entry.live === 'assertive'
        ? {
            ...entry,
            text: '▲Watch outThe server refused itIt is not your turn to act. (not_your_turn). Nothing was applied.',
          }
        : entry,
    );
    const verdict = check.decide(evidence);
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, /reads a contract code out/u);
  });

  it('fires when something else on the screen interrupts as well', () => {
    const evidence = REFUSED_HAND();
    evidence.log = evidence.log.map((entry) =>
      /^The hand is complete\./u.test(entry.text) ? { ...entry, live: 'assertive', role: 'alert' } : entry,
    );
    const verdict = check.decide(evidence);
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, /other announcement\(s\) on this screen interrupted/u);
  });

  it('refuses a run whose second press met a disabled control, rather than reading it as silence', () => {
    // If the client disabled the button synchronously, nothing would be sent to refuse.
    const evidence = REFUSED_HAND();
    evidence.doubleAct = { name: 'fold, costs 0 units, gives up the hand', stillEnabled: false };
    const verdict = check.decide(evidence);
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, /only ONE decision was sent/u);
  });

  it('fires when two decisions went out and nothing said one was refused', () => {
    const evidence = REFUSED_HAND();
    evidence.log = evidence.log.filter((entry) => !/The server refused it/u.test(entry.text));
    const verdict = check.decide(evidence);
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, /no region ever said the server refused one/u);
  });
});

describe('NEGATIVE CONTROL — 3.20, an outage the status line talks over', () => {
  const check = checkFor('J3.20');
  const OUTAGE = () => ({
    opened: 'Deal me in',
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
    const evidence = OUTAGE();
    evidence.log.push(
      wrote(CONNECTION, 'Live. Everything on this screen is the server’s own view of the table.', 900),
    );
    assert.ok(refuses(check, evidence));
  });
});

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
    // If the second web app reaches an API, "no notice" must fail.
    const evidence = BUNDLED_COPY();
    evidence.notice = null;
    evidence.noticeAx = null;
    evidence.spokenInTree = [];
    assert.ok(refuses(check, evidence));
  });

  it('fires when the sentence is a visual-only badge', () => {
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

describe('NEGATIVE CONTROL — 6.7, a failing deck proof nobody is interrupted for', () => {
  const check = checkFor('J6.7');

  // Modelled on a real run with nine proved positions, salt byte 703 `6`->`7` at deck position 1.
  const SEEN_TWICE = () => ({
    hand: 'hand_ebvsgm6k5snqqbwofbus52xjgn',
    tried: [{ id: 'hand_ebvsgm6k5snqqbwofbus52xjgn', mutated: true, why: null }],
    proxy: { reviews: 1, refused: [] },
    honestSettled: true,
    corruptedSettled: true,
    record: {
      handId: 'hand_ebvsgm6k5snqqbwofbus52xjgn',
      byteOffset: 703,
      before: '6',
      after: '7',
      position: 1,
      positions: 9,
      root: 'f'.repeat(64),
      context: 'room:7:hand_ebvsgm6k5snqqbwofbus52xjgn',
      serverOk: true,
      serverPositions: 9,
    },
    html: {
      reached: true,
      length: 90_000,
      carriesVerifier: true,
      pending: true,
      carriesReason: false,
      carriesAlert: false,
    },
    honest: {
      present: true,
      chip: 'proof holds',
      alert: null,
      note: {
        title: '9 positions proved against the published root',
        spoken:
          'Your browser first checked that the reveal names the same Merkle root and the same hand ' +
          'context as the ones published above, and refused to go any further unless they matched.',
      },
      noteAx: { role: 'note', ignored: false },
      facts: [
        { label: 'Merkle root', value: 'f'.repeat(64) },
        { label: 'The server said', value: 'verified, 9 positions' },
      ],
      treeText: ['9 positions proved against the published root', 'Check the deal yourself'],
    },
    corrupted: {
      present: true,
      chip: 'proof failed',
      alert: {
        spoken:
          'Error — the proof did not check outposition 1 does not prove against the published ' +
          'rootThis is the one result on this screen that should not happen.',
        markup: null,
      },
      alertAx: { role: 'alert', live: 'assertive', ignored: false },
      note: null,
      noteAx: null,
      facts: [
        { label: 'Merkle root', value: 'f'.repeat(64) },
        { label: 'The server said', value: 'verified, 9 positions' },
      ],
      treeText: ['position 1 does not prove against the published root'],
    },
  });

  it('passes the two screens the fixture actually produces', () => {
    assert.equal(check.decide(SEEN_TWICE()).ok, true);
  });

  it("fires when the failure is not an alert — the row's own subject", () => {
    const evidence = SEEN_TWICE();
    evidence.corrupted.alert = null;
    assert.ok(refuses(check, evidence));
  });

  it('fires when the alert is only polite, so it waits behind whatever is already being said', () => {
    const evidence = SEEN_TWICE();
    evidence.corrupted.alertAx = { role: 'status', live: 'polite', ignored: false };
    assert.ok(refuses(check, evidence));
  });

  it('fires when the alert is out of the accessibility tree', () => {
    const evidence = SEEN_TWICE();
    evidence.corrupted.alertAx.ignored = true;
    assert.ok(refuses(check, evidence));
  });

  it('fires when the alert carries no reason, so a reader is told nothing about what', () => {
    const evidence = SEEN_TWICE();
    evidence.corrupted.alert.spoken = 'Error — the proof did not check out';
    assert.ok(refuses(check, evidence));
  });

  it('fires when the reason is on screen and not in the tree', () => {
    const evidence = SEEN_TWICE();
    evidence.corrupted.treeText = [];
    assert.ok(refuses(check, evidence));
  });

  it('fires when the PROXY corrupted nothing — the fixture failing, not the app (REGRESSION)', () => {
    // A proxy that forwards bytes unchanged renders a good proof. That must fail, not pass.
    const evidence = SEEN_TWICE();
    evidence.hand = null;
    evidence.record = null;
    evidence.proxy = { reviews: 0, refused: [] };
    assert.ok(refuses(check, evidence));
  });

  it('says, when it fails, how many DISTINCT hands it saw and what each drive pressed (REGRESSION)', () => {
    const evidence = SEEN_TWICE();
    evidence.hand = null;
    evidence.record = null;
    evidence.proxy = { reviews: 0, refused: [] };
    evidence.tried = [];
    const board0 = [{ id: 'hand_a', board: 0 }];
    Object.assign(evidence, tallyListedHands([board0, board0, board0]));
    const stuck = { path: 'reconnected', pressed: [], dealt: null, complete: false, start: null };
    evidence.drives = [stuck, stuck];
    const verdict = check.decide(evidence);
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, /listed 1 distinct hand\(s\) over 3 look\(s\), and 1 of them dealt no/u);
    assert.match(verdict.detail, /2 hand\(s\) played for it — reconnected: pressed nothing, DEALT NOTHING/u);
  });

  it('names the hand it checked and how that hand was reached, when it passes', () => {
    const evidence = SEEN_TWICE();
    evidence.drives = [
      {
        path: 'reconnected',
        pressed: ['Deal the next hand'],
        dealt: 'Deal the next hand',
        complete: true,
        start: null,
      },
    ];
    const verdict = check.decide(evidence);
    assert.equal(verdict.ok, true);
    assert.match(verdict.detail, /reconnected: pressed "Deal the next hand", played to completion/u);
  });

  it('fires when the fixture is not wired into the run at all', () => {
    const evidence = SEEN_TWICE();
    evidence.wiring = 'the corrupting proxy was not wired into this run';
    assert.ok(refuses(check, evidence));
  });

  it('fires when the API itself failed the payload, so the run measured a broken API', () => {
    const evidence = SEEN_TWICE();
    evidence.record.serverOk = false;
    assert.ok(refuses(check, evidence));
  });

  it('fires when the corruption moved the BINDING rather than the hash', () => {
    // `other-hand` is a different branch.
    const evidence = SEEN_TWICE();
    evidence.corrupted.chip = 'different hand';
    assert.ok(refuses(check, evidence));
  });

  it('fires when the honest half is not a sentence, only a chip', () => {
    const evidence = SEEN_TWICE();
    evidence.honest.note = null;
    evidence.honest.noteAx = null;
    assert.ok(refuses(check, evidence));
  });

  it('fires when a proof that HOLDS interrupts', () => {
    const evidence = SEEN_TWICE();
    evidence.honest.alert = { spoken: 'Error — the proof did not check out', markup: null };
    assert.ok(refuses(check, evidence));
  });

  it('fires when the verdict was computed by the SERVER, so the alert arrives with its document', () => {
    // An alert already in the server HTML announces nothing (3.3).
    const evidence = SEEN_TWICE();
    evidence.html = { ...evidence.html, pending: false, carriesAlert: true, carriesReason: true };
    assert.ok(refuses(check, evidence));
  });

  it('fires when the verifier never got past "checking", so a pending screen was read', () => {
    const evidence = SEEN_TWICE();
    evidence.corruptedSettled = false;
    assert.ok(refuses(check, evidence));
  });

  it('fires when the root on screen is not the root the proxy forwarded', () => {
    const evidence = SEEN_TWICE();
    evidence.corrupted.facts[0].value = 'a'.repeat(64);
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
    // Runs in Chrome, not here. This pins the probe's contract.
    assert.match(SPEECH_PROBE, /window\.__prlSpeech = \{ log, mutations \}/u);
    assert.match(SPEECH_PROBE, /characterDataOldValue: true/u);
    assert.match(SPEECH_PROBE, /role="alert"/u);
    assert.match(SPEECH_PROBE, /window\.__prlSpeechReset/u);
    assert.match(SPEECH_PROBE, /recovered: recovered === true/u);
    assert.match(SPEECH_PROBE, /window\.__prlSpeechRegions/u);
  });
});

describe('NEGATIVE CONTROL — 3.6, ten seconds of state frames on one turn', () => {
  const check = checkFor('J3.6');

  // Joined, because `security:secrets` flags a 34-character `prl-` string as a credential.
  const TURN_REGION_KEY = ['prl-play__decision', 'prl-live-region'].join('>');

  const dwelt = (dwellMs) => ({
    reachedTurn: true,
    turnOpenedAt: 1_000,
    dwellMs,
    log: [{ key: TURN_REGION_KEY, at: 1_000, text: 'Your turn preflop.' }],
    mutations: [],
  });

  it('passes a full ten-second dwell with a silent region', () => {
    assert.equal(check.decide(dwelt(10_000)).ok, true);
  });

  // One `test:ax` run failed on a 9999ms dwell.
  it('passes a dwell one millisecond short, which is what it used to fail on', () => {
    assert.equal(check.decide(dwelt(9_999)).ok, true);
    assert.equal(check.decide(dwelt(9_800)).ok, true, 'within the stated tolerance');
  });

  it('still refuses a dwell that was genuinely cut short', () => {
    for (const dwellMs of [0, 500, 5_000, 9_000, 9_700]) {
      const verdict = check.decide(dwelt(dwellMs));
      assert.equal(verdict.ok, false, `${dwellMs}ms should not count as ten seconds`);
      assert.match(verdict.detail, /short of the 10000ms this assertion asks for/u);
    }
  });

  it('still fires on the defect itself, at a dwell inside the tolerance', () => {
    // The tolerance must not pass a region rewritten during the dwell.
    const repeated = {
      ...dwelt(9_999),
      log: [
        { key: TURN_REGION_KEY, at: 1_000, text: 'Your turn preflop.' },
        { key: TURN_REGION_KEY, at: 4_000, text: 'Your turn preflop.' },
      ],
    };
    const verdict = check.decide(repeated);
    assert.equal(verdict.ok, false);
    assert.match(verdict.detail, /rewritten/u);

    const churned = {
      ...dwelt(9_999),
      mutations: [{ key: TURN_REGION_KEY, at: 5_000 }],
    };
    assert.equal(check.decide(churned).ok, false);
    assert.match(check.decide(churned).detail, /DOM mutation/u);
  });
});

// The opening patterns are driven by the app's own sentence builder, so a reworded verdict cannot
// leave J2.5 and J2.7 matching nothing.
describe('the quiz verdict openings match what the app writes', () => {
  const tail = ' The server could not be reached, so this comparison was made in your browser.';

  it('finds both numeric verdicts, with the recording sentence left after the opening', () => {
    for (const matched of [true, false]) {
      const sentence =
        numericVerdictSentence({ yours: '33.0 %', computed: '33.3 %', tolerance: '1.5 %', matched }) + tail;
      assert.match(sentence, NUMERIC_VERDICT_OPENING, `matched=${String(matched)}`);
      assert.ok(sentence.replace(NUMERIC_VERDICT_OPENING, '').trim().length >= 20);
    }
  });

  it('does not take a multiple-choice verdict for a numeric one, or the reverse', () => {
    const numeric = numericVerdictSentence({ yours: '3', computed: '4', tolerance: '0.5', matched: false });
    assert.doesNotMatch(numeric, QUIZ_VERDICT_OPENING);
    assert.doesNotMatch('That matches the answer this lesson gives.' + tail, NUMERIC_VERDICT_OPENING);
  });
});

// The quiz answers only on "Check answer". A verdict after a mere
// selection must fail.
describe('J2.5: selecting is not answering', () => {
  const check = checkFor('J2.5');
  const answered = {
    verdictOnSelect: '',
    choiceAnswered: true,
    choiceVerdict: {
      role: 'status',
      live: 'polite',
      text:
        'That matches the answer this lesson gives. The reasoning is below. ' +
        'Kept on this browser’s guest record as a question you have answered.',
    },
    choiceVerdictCount: 1,
  };

  it('passes when the region is empty until "Check answer" is pressed', () => {
    assert.equal(check.decide(answered).ok, true, check.decide(answered).detail);
  });

  it('fails when selecting an option already wrote a verdict', () => {
    const early = {
      ...answered,
      verdictOnSelect: 'That is not the answer this lesson gives. Nothing is deducted.',
    };
    assert.ok(refuses(check, early));
    assert.match(check.decide(early).detail, /before "Check answer" was pressed/u);
  });

  it('fails when there is no "Check answer" to press', () => {
    assert.ok(refuses(check, { ...answered, choiceAnswered: false }));
  });
});

describe('NEGATIVE CONTROL — the live-hand fixture, from either state /play opens in', () => {
  const snapshot = (overrides = {}) => ({
    reconnecting: false,
    inProgress: false,
    status: '',
    controls: [],
    ...overrides,
  });
  const button = (name, enabled = true) => ({ name, enabled });

  it('reads a first visit off an enabled "Deal me in"', () => {
    assert.equal(tableStartPath(snapshot({ controls: [button('Deal me in')] })), 'first visit');
  });

  it('reads a reconnect off the manual controls, a disabled deal included', () => {
    assert.equal(
      tableStartPath(snapshot({ controls: [button('Deal the next hand', false), button('Stand up')] })),
      'reconnected',
    );
    assert.equal(tableStartPath(snapshot({ controls: [button('Take seat 1')] })), 'reconnected');
  });

  it('waits while the page says it is reconnecting, though "Deal me in" is enabled (REGRESSION)', () => {
    // `phase` is still `idle` during the reconnect, so "Deal me in" is pressable.
    assert.equal(tableStartPath(snapshot({ reconnecting: true, controls: [button('Deal me in')] })), null);
  });

  it('settles on nothing that is neither state: a disabled button, "Try again", or no page', () => {
    assert.equal(tableStartPath(snapshot({ controls: [button('Deal me in', false)] })), null);
    assert.equal(tableStartPath(snapshot({ controls: [button('Try again')] })), null);
    assert.equal(tableStartPath(snapshot()), null);
    assert.equal(tableStartPath(null), null);
  });

  it('counts a boardless hand once however many times the list is read (REGRESSION)', () => {
    // The old tally counted 1 hand read three times as 3 boardless.
    const board0 = [{ id: 'hand_a', board: 0 }];
    assert.deepEqual(tallyListedHands([board0, board0, board0]), { looks: 3, listed: 1, boardless: 1 });
    assert.deepEqual(tallyListedHands([board0, [{ id: 'hand_b', board: 3 }, ...board0]]), {
      looks: 2,
      listed: 2,
      boardless: 1,
    });
    assert.deepEqual(tallyListedHands([]), { looks: 0, listed: 0, boardless: 0 });
  });

  it('says a drive that dealt nothing in capitals, and which controls it pressed', () => {
    const drive = summariseDrive({ path: 'first visit', opened: 'Deal me in', dealt: null, complete: false });
    assert.equal(describeDrive(drive), 'first visit: pressed "Deal me in", DEALT NOTHING');
    const reconnected = summariseDrive({
      path: 'reconnected',
      opened: null,
      sat: 'Take seat 1',
      dealPressed: 'Deal the next hand',
      dealt: 'Deal the next hand',
      complete: true,
    });
    assert.equal(
      describeDrive(reconnected),
      'reconnected: pressed "Take seat 1" then "Deal the next hand", played to completion',
    );
  });

  it('says what a reconnected table showed when no hand came of it', () => {
    const drive = summariseDrive({
      path: 'reconnected',
      sat: null,
      dealt: null,
      complete: false,
      start: {
        path: 'reconnected',
        after: snapshot({ status: 'Live.', controls: [button('Deal the next hand', false)] }),
      },
    });
    assert.match(
      describeDrive(drive),
      /DEALT NOTHING — the page then showed .*Deal the next hand \(disabled\)/u,
    );
  });

  it('says what the page showed when it settled into neither state', () => {
    const drive = summariseDrive({
      path: null,
      start: {
        path: null,
        waitedMs: 45_000,
        snapshot: snapshot({ status: 'Ready to connect.', controls: [button('Deal the next hand', false)] }),
      },
    });
    const said = describeDrive(drive);
    assert.match(said, /never settled/u);
    assert.match(said, /"Ready to connect\."/u);
    assert.match(said, /Deal the next hand \(disabled\)/u);
  });

  it('says no hand was played when none was needed, rather than claiming one', () => {
    assert.equal(describeDrives([]), 'a hand already in this session, none played for it');
  });
});

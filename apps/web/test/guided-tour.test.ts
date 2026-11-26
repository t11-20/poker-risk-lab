/**
 * The guided tour: when it opens by itself, what skipping and reopening do, a storage that throws, and
 * the copy. `lib/tour.ts` holds all of it apart from React, so it runs here without a DOM (ADR 0008);
 * the panel's wiring is read from its source, the way `units-badge.test.ts` reads its badge.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { tipSentenceProblems } from '@prl/ui/tips';
import {
  closeTour,
  createTourStore,
  INITIAL_TOUR_STATE,
  opensByItself,
  readTourDismissal,
  rememberTourDismissal,
  TOUR_DISMISSED_KEY,
  TOUR_FIRST_VISIT_PATH,
  TOUR_INSET_PROPERTY,
  TOUR_STEPS,
  type TourAction,
  type TourState,
  type TourStorage,
  tourReducer,
} from '../src/lib/tour.ts';

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');

function memoryStorage(
  initial: Record<string, string> = {},
): TourStorage & { readonly data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  const store = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
  return Object.assign(() => store, { data });
}

const blocked: TourStorage = () => {
  throw new DOMException('The operation is insecure.', 'SecurityError');
};

const refusing: TourStorage = () => ({
  getItem: () => {
    throw new DOMException('denied', 'SecurityError');
  },
  setItem: () => {
    throw new DOMException('quota', 'QuotaExceededError');
  },
});

const run = (actions: readonly TourAction[], from: TourState = INITIAL_TOUR_STATE): TourState =>
  actions.reduce(tourReducer, from);

describe('it opens by itself on the Lab, at most once a page load', () => {
  it('opens on /lab when nothing has been stored', () => {
    assert.equal(opensByItself('/lab', readTourDismissal(memoryStorage()), false), true);
  });

  it('opens on /lab only, not on a scenario, the review page or the home page', () => {
    for (const path of ['/lab/fl-same-cards-under-the-gun', '/review', '/', '/play']) {
      assert.equal(opensByItself(path, 'not-dismissed', false), false, path);
    }
    assert.equal(TOUR_FIRST_VISIT_PATH, '/lab');
  });

  it('stays shut once skipped', () => {
    const storage = memoryStorage();
    assert.equal(rememberTourDismissal(storage), true);
    assert.equal(storage.data.get(TOUR_DISMISSED_KEY), '1');
    assert.equal(opensByItself('/lab', readTourDismissal(storage), false), false);
  });

  it('Skip and Close are remembered; Escape puts it away for now, so a later load opens it again', () => {
    for (const how of ['button', 'escape'] as const) {
      const storage = memoryStorage();
      const store = createTourStore();
      store.dispatch({ type: 'open-first-visit', narrow: false });
      closeTour(store, storage, how);
      assert.equal(store.getSnapshot().open, false, `${how} closes it`);
      assert.equal(storage.data.has(TOUR_DISMISSED_KEY), how === 'button', `${how} and the key`);
      // The next load of /lab is a fresh page: nothing has settled it yet.
      assert.equal(opensByItself('/lab', readTourDismissal(storage), false), how === 'escape', how);
    }
  });

  it('opens at most once in a page load, even when the skip could not be stored', () => {
    const skipped = run([{ type: 'open-first-visit', narrow: false }, { type: 'close' }]);
    assert.equal(skipped.open, false);
    assert.equal(opensByItself('/lab', 'not-dismissed', skipped.settled), false);
    assert.equal(run([{ type: 'open-first-visit', narrow: false }], skipped).open, false);
  });

  it('does not open by itself over a link to a fragment, which it would push off a phone screen', () => {
    assert.equal(opensByItself('/lab', 'not-dismissed', false, true), false);
  });

  it('closes, unanswered, when the reader leaves the Lab without using it', () => {
    const left = run([
      { type: 'open-first-visit', narrow: false },
      { type: 'navigated', pathname: '/play' },
    ]);
    assert.equal(left.open, false);
    assert.equal(left.settled, true);
    const used = run([
      { type: 'open-first-visit', narrow: false },
      { type: 'show', step: 'pick-scenario', awaiting: null },
      { type: 'navigated', pathname: '/play' },
    ]);
    assert.equal(used.open, true);
    const asked = run([{ type: 'open-from-button' }, { type: 'navigated', pathname: '/play' }]);
    assert.equal(asked.open, true);
  });

  it('a narrow first visit opens compact with the steps hidden, and showing them reveals them', () => {
    const opened = run([{ type: 'open-first-visit', narrow: true }]);
    assert.equal(opened.open, true);
    assert.equal(opened.compact, true);
    assert.equal(opened.stepsExpanded, false);
    const revealed = tourReducer(opened, { type: 'set-steps-expanded', expanded: true });
    assert.equal(revealed.compact, true);
    assert.equal(revealed.stepsExpanded, true);
    const hidden = tourReducer(revealed, { type: 'set-steps-expanded', expanded: false });
    assert.equal(hidden.compact, true);
    assert.equal(hidden.stepsExpanded, false);
  });

  it('a wide first visit, and one opened from "How to use", are not compact', () => {
    assert.equal(run([{ type: 'open-first-visit', narrow: false }]).compact, false);
    assert.equal(run([{ type: 'open-from-button' }]).compact, false);
    const reopened = run([
      { type: 'open-first-visit', narrow: true },
      { type: 'close' },
      { type: 'open-from-button' },
    ]);
    assert.equal(reopened.compact, false);
    assert.equal(reopened.stepsExpanded, false);
  });

  it('close resets compactness and whether the steps were expanded', () => {
    const closed = run([
      { type: 'open-first-visit', narrow: true },
      { type: 'set-steps-expanded', expanded: true },
      { type: 'close' },
    ]);
    assert.equal(closed.open, false);
    assert.equal(closed.compact, false);
    assert.equal(closed.stepsExpanded, false);
  });

  it('no action changes compactness while the guide stays open', () => {
    const opened = run([
      { type: 'open-first-visit', narrow: true },
      { type: 'show', step: 'pick-scenario', awaiting: null },
    ]);
    assert.equal(opened.compact, true);
    const step = 'pick-scenario' as const;
    // One of every action. `close` is the reset, covered above, so it is not a change while open.
    const samples = {
      'open-first-visit': { type: 'open-first-visit', narrow: false },
      'open-from-button': { type: 'open-from-button' },
      close: { type: 'close' },
      'set-steps-expanded': { type: 'set-steps-expanded', expanded: true },
      show: { type: 'show', step, awaiting: '/review' },
      found: { type: 'found', step },
      missing: { type: 'missing', step },
      navigated: { type: 'navigated', pathname: '/play' },
    } as const satisfies Record<TourAction['type'], TourAction>;
    const staying = Object.values(samples).filter((action) => action.type !== 'close');
    assert.equal(staying.length, Object.keys(samples).length - 1, 'an action was dropped from the check');
    for (const action of staying) {
      const next = tourReducer(opened, action);
      assert.equal(next.open, true, action.type);
      assert.equal(next.compact, opened.compact, action.type);
    }
  });

  it('does not take focus when it opens by itself', () => {
    const opened = run([{ type: 'open-first-visit', narrow: false }]);
    assert.equal(opened.open, true);
    assert.equal(opened.focusRequest, 0);
    assert.equal(opened.opener, 'first-visit');
  });
});

describe('a storage that throws', () => {
  it('reads as unreadable, whether the getter or the read throws, and never throws itself', () => {
    assert.equal(readTourDismissal(blocked), 'unreadable');
    assert.equal(readTourDismissal(refusing), 'unreadable');
  });

  it('keeps the tour shut rather than open it on every load', () => {
    assert.equal(opensByItself('/lab', 'unreadable', false), false);
  });

  it('refuses the write quietly, so closing still closes', () => {
    assert.equal(rememberTourDismissal(blocked), false);
    assert.equal(rememberTourDismissal(refusing), false);
    assert.equal(run([{ type: 'open-from-button' }, { type: 'close' }]).open, false);
  });

  it('NEGATIVE CONTROL: a reader without the try lets the exception out', () => {
    const naive = (storage: TourStorage): string | null => storage().getItem(TOUR_DISMISSED_KEY);
    assert.throws(() => naive(blocked));
  });
});

describe('skip, reopen and show', () => {
  it('reopens from "How to use" after a skip, takes focus, and offers Close rather than Skip', () => {
    const reopened = run([
      { type: 'open-first-visit', narrow: false },
      { type: 'close' },
      { type: 'open-from-button' },
    ]);
    assert.equal(reopened.open, true);
    assert.equal(reopened.opener, 'button');
    assert.equal(reopened.focusRequest, 1);
  });

  it('takes focus again when "How to use" is pressed while it is already open', () => {
    const twice = run([{ type: 'open-from-button' }, { type: 'open-from-button' }]);
    assert.equal(twice.open, true);
    assert.equal(twice.focusRequest, 2);
  });

  it('keeps the step through the navigation "Show me" started, and drops it for any other', () => {
    const going = run([{ type: 'open-from-button' }, { type: 'show', step: 'review', awaiting: '/review' }]);
    assert.equal(run([{ type: 'navigated', pathname: '/review' }], going).step, 'review');
    assert.equal(run([{ type: 'navigated', pathname: '/review' }], going).awaiting, null);
    assert.equal(run([{ type: 'navigated', pathname: '/learn' }], going).step, null);
  });

  it('says a step is missing, and ignores a report about a step no longer shown', () => {
    const shown = run([{ type: 'show', step: 'run', awaiting: null }]);
    assert.equal(run([{ type: 'missing', step: 'run' }], shown).found, 'missing');
    assert.equal(run([{ type: 'found', step: 'review' }], shown).found, null);
  });

  it('counts each "Show me", so showing the same step again reveals it again', () => {
    const once = run([{ type: 'show', step: 'pick-scenario', awaiting: null }]);
    const again = run([{ type: 'show', step: 'pick-scenario', awaiting: null }], once);
    assert.notEqual(once.shown, again.shown);
  });

  it('tells subscribers about a change and only about a change', () => {
    const store = createTourStore();
    let calls = 0;
    const unsubscribe = store.subscribe(() => {
      calls += 1;
    });
    store.dispatch({ type: 'open-first-visit', narrow: false });
    store.dispatch({ type: 'open-first-visit', narrow: false });
    unsubscribe();
    store.dispatch({ type: 'close' });
    assert.equal(calls, 1);
  });
});

describe('the steps', () => {
  it('are three to five, in the order the owner named', () => {
    assert.ok(TOUR_STEPS.length >= 3 && TOUR_STEPS.length <= 5);
    assert.deepEqual(
      TOUR_STEPS.map((step) => step.id),
      ['pick-scenario', 'hand-board', 'run', 'result', 'review'],
    );
  });

  for (const step of TOUR_STEPS) {
    it(`"${step.title}" says one plain sentence, and one when its part is missing`, () => {
      assert.deepEqual(tipSentenceProblems({ term: step.title, text: step.text }), []);
      assert.deepEqual(tipSentenceProblems({ term: step.title, text: step.missing }), []);
    });
  }

  it('each has an outline rule, so a shown part is marked', () => {
    const css = read('../src/styles/tour.css');
    for (const step of TOUR_STEPS) {
      assert.ok(
        css.includes(`:root[data-tour-showing="${step.id}"] [data-tour="${step.id}"]`),
        `no outline for ${step.id}`,
      );
    }
  });

  it('marks the two targets this app owns', () => {
    assert.match(read('../src/app/lab/page.tsx'), /data-tour="pick-scenario"/u);
    assert.match(read('../src/app/review/page.tsx'), /data-tour="review"/u);
  });
});

const PANEL = read('../src/components/GuidedTour.tsx')
  .split('\n')
  .filter((line) => !/^\s*(?:\*|\/\/|\/\*|\{\/\*)/u.test(line))
  .join('\n');
const CSS = read('../src/styles/tour.css').replace(/\/\*[\s\S]*?\*\//gu, '');

/** The declarations of `.prl-tour` itself, the panel. */
const panelRule = (css: string): string => /(?:^|\n)\.prl-tour\s*\{([^}]*)\}/u.exec(css)?.[1] ?? '';

/** The declarations of one rule, by its exact selector. */
const ruleOf = (css: string, selector: string): string => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, 'u').exec(css)?.[1] ?? '';
};

describe('the panel moves nothing and traps nothing (read from the source)', () => {
  it('is fixed to the bottom of the window, out of the flow, so opening it shifts nothing', () => {
    const rule = panelRule(CSS);
    assert.ok(rule.length > 0, 'no .prl-tour rule was read');
    assert.match(rule, /position: fixed;/u);
    assert.match(rule, /inset-block-end: /u);
    assert.doesNotMatch(rule, /margin-block/u, 'a margin would mean it still sat in the flow');
  });

  it('is at most half the window, and past that its steps scroll while the title and Skip stay', () => {
    assert.match(panelRule(CSS), /max-block-size: min\(\s*50dvh,/u);
    assert.match(panelRule(CSS), /calc\(100dvh - var\(--prl-pillbar-h\) - var\(--prl-target-min\) - /u);
    const body = ruleOf(CSS, '.prl-tour__body');
    assert.match(body, /overflow-y: auto;/u);
    assert.match(body, /min-block-size: 0;/u);
    assert.match(PANEL, /<div className="prl-tour__body">\{stepList\}<\/div>/u);
  });

  it('keeps its height as room below every scroll target and the page, and gives it back on close', () => {
    assert.equal(TOUR_INSET_PROPERTY, '--prl-tour-inset');
    assert.match(
      ruleOf(CSS, ':root:has(.prl-tour):not(:has(.prl-play))'),
      /scroll-padding-block-end: calc\(var\(--prl-tour-inset, 0px\) \+ /u,
    );
    assert.match(
      ruleOf(CSS, 'body:has(.prl-tour):not(:has(.prl-play))'),
      /padding-block-end: var\(--prl-tour-inset, 0px\);/u,
    );
    assert.match(PANEL, /root\.style\.setProperty\(TOUR_INSET_PROPERTY, /u);
    assert.match(PANEL, /new ResizeObserver\(measure\)/u);
    assert.match(PANEL, /root\.style\.removeProperty\(TOUR_INSET_PROPERTY\);\n {4}\};\n {2}\}, \[open\]\);/u);
  });

  it('in a window short of text lines scrolls as a whole, and in a very short one goes back in flow', () => {
    const media = (query: string): string => {
      const start = CSS.indexOf(`@media (${query}) {`);
      assert.ok(start >= 0, `no @media (${query})`);
      return CSS.slice(start, CSS.indexOf('\n}\n', start));
    };
    assert.match(ruleOf(media('height < 30em'), '  .prl-tour'), /overflow-y: auto;/u);
    assert.match(ruleOf(media('height < 30em'), '  .prl-tour__body'), /flex-shrink: 0;/u);
    assert.match(ruleOf(media('height < 18em'), '  .prl-tour'), /position: static;/u);
  });

  it('stays in the flow on /play, whose own controls are pinned to the bottom of the window', () => {
    assert.match(ruleOf(CSS, ':root:has(.prl-play) .prl-tour'), /position: static;/u);
    assert.match(PANEL, /getComputedStyle\(panel\)\.position !== 'fixed'/u);
    // Open across a navigation at the same size, so the route change itself re-measures.
    assert.match(PANEL, /type: 'navigated', pathname \}\);\n {6}measureInset\.current\?\.\(\);/u);
    assert.match(PANEL, /measureInset\.current = measure;/u);
  });

  it('handles Escape on the panel, not the document, and has no focus trap', () => {
    assert.match(PANEL, /onKeyDown=\{onKeyDown\}/u);
    assert.match(PANEL, /event\.key !== 'Escape'/u);
    assert.match(PANEL, /close\('escape'\)/u, 'Escape closes without recording an answer');
    assert.match(PANEL, /onClick=\{\(\) => close\('button'\)\}/u, 'Skip and Close record it');
    assert.doesNotMatch(PANEL, /document\.addEventListener\('keydown'/u);
    assert.doesNotMatch(PANEL, /aria-modal|inert/u);
  });

  it('sends focus back to "How to use" on close, without scrolling the sticky header', () => {
    assert.match(PANEL, /focusReturnTarget\(\)\?\.focus\(\{ preventScroll: true \}\)/u);
    assert.match(read('../src/components/TourButton.tsx'), /data-tour-opener=""/u);
  });

  it('renders nothing while closed, so the server render is the page alone', () => {
    assert.match(PANEL, /if \(!state\.open\) return null;/u);
  });

  it('is reachable from the header and from the phone menu', () => {
    assert.match(read('../src/components/SiteHeader.tsx'), /<TourButton \/>/u);
    assert.match(read('../src/components/MobileNav.tsx'), /<TourButton beforeOpen=\{close\} \/>/u);
  });
});

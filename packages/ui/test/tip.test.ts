/**
 * `Tip`, the toggletip. Its inputs are a reducer and its placement is arithmetic, so both are driven
 * here without a DOM (ADR 0008). The markup is rendered for the name and the description, and the
 * listeners that need a document are read from the source, as `units-badge.test.ts` does.
 * Every predicate is also run against a broken version, which it must reject.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  countsAsHover,
  nextTipState,
  placeTip,
  type TipBox,
  type TipEvent,
  type TipPlacement,
  type TipPlacementInput,
  type TipState,
} from '../src/tip-state.ts';
import { TIP_MAX_LENGTH, type TipCopy, tipSentenceProblems, UI_TIPS } from '../src/tips.ts';
import { loadComponent } from './support/render-component.ts';

type Reducer = (state: TipState, event: TipEvent) => TipState;

const run = (reducer: Reducer, events: readonly TipEvent[]): TipState =>
  events.reduce<TipState>((state, event) => reducer(state, event), 'closed');

const PRESS: TipEvent = { type: 'press' };
const HOVER: TipEvent = { type: 'hover-start' };
const UNHOVER: TipEvent = { type: 'hover-end' };

/** Click, tap, Enter and Space all arrive as one `press` (a native button's `click`). */
const opensWithoutHover = (reducer: Reducer): boolean => run(reducer, [PRESS]) === 'pinned';
const secondPressCloses = (reducer: Reducer): boolean => run(reducer, [PRESS, PRESS]) === 'closed';
const dismissedBy = (reducer: Reducer, type: TipEvent['type']): boolean =>
  run(reducer, [PRESS, { type } as TipEvent]) === 'closed' &&
  run(reducer, [HOVER, { type } as TipEvent]) === 'closed';
const pinnedSurvivesUnhover = (reducer: Reducer): boolean =>
  run(reducer, [HOVER, PRESS, UNHOVER]) === 'pinned';

/** A tooltip of the kind the owner ruled out: only a hovering pointer can open it. */
const hoverOnly: Reducer = (state, event) =>
  event.type === 'hover-start' ? 'peek' : event.type === 'hover-end' ? 'closed' : state;

/** A press that only ever opens, which is the "second press does nothing" bug. */
const openOnly: Reducer = (state, event) => (event.type === 'press' ? 'pinned' : nextTipState(state, event));

describe('every input opens and closes a tip', () => {
  it('opens on a press, so it works with a keyboard and a finger, not only a mouse', () => {
    assert.ok(opensWithoutHover(nextTipState));
    assert.ok(!opensWithoutHover(hoverOnly), 'NEGATIVE CONTROL: a hover-only tooltip must fail this');
  });

  it('closes on a second press', () => {
    assert.ok(secondPressCloses(nextTipState));
    assert.ok(!secondPressCloses(openOnly), 'NEGATIVE CONTROL: a press that only opens must fail this');
  });

  for (const type of ['escape', 'outside', 'focus-left', 'viewport-moved'] as const) {
    it(`closes on ${type}, whether pinned or peeking`, () => {
      assert.ok(dismissedBy(nextTipState, type));
      assert.ok(!dismissedBy(hoverOnly, type), `NEGATIVE CONTROL: a reducer ignoring ${type} must fail`);
    });
  }

  it('lets a hovering mouse peek, and a press pins what it is peeking at', () => {
    assert.equal(run(nextTipState, [HOVER]), 'peek');
    assert.equal(run(nextTipState, [HOVER, UNHOVER]), 'closed');
    assert.ok(pinnedSurvivesUnhover(nextTipState));
    assert.ok(!pinnedSurvivesUnhover(hoverOnly), 'NEGATIVE CONTROL: hover-only loses the tip on leave');
  });

  it('does not let hover close a tip somebody pressed open', () => {
    assert.equal(run(nextTipState, [PRESS, HOVER, UNHOVER]), 'pinned');
  });

  it('counts only a mouse on a hovering device as hover, never a finger or a pen', () => {
    assert.equal(countsAsHover('mouse', true), true);
    assert.equal(countsAsHover('mouse', false), false);
    assert.equal(countsAsHover('touch', true), false);
    assert.equal(countsAsHover('pen', true), false);
  });
});

const POT_ODDS: TipCopy = UI_TIPS.potOdds;

async function render(tip: TipCopy = POT_ODDS): Promise<string> {
  const Tip = await loadComponent<{ readonly tip: TipCopy }>('components/Tip', 'Tip');
  return renderToStaticMarkup(createElement(Tip, { tip }));
}

interface ReadTip {
  readonly name: string;
  readonly description: string;
  readonly button: string;
}

/** The button's name (its text minus `aria-hidden` spans) and the text its `aria-describedby` names. */
function readTip(markup: string): ReadTip {
  const button = /<button([^>]*)>([\s\S]*?)<\/button>/u.exec(markup);
  assert.ok(button !== null, `no button in:\n${markup}`);
  const attributes = button[1] ?? '';
  const name = (button[2] ?? '')
    .replace(/<span aria-hidden="true">[\s\S]*?<\/span>/gu, '')
    .replace(/<[^>]+>/gu, '')
    .trim();
  const describedBy = /aria-describedby="([^"]+)"/u.exec(attributes)?.[1];
  if (describedBy === undefined) return { name, description: '', button: attributes };
  const target = new RegExp(`<[a-z]+[^>]*\\bid="${describedBy}"[^>]*>([^<]*)<`, 'u').exec(markup);
  return { name, description: target?.[1] ?? '', button: attributes };
}

describe('the tip is named and described for a screen reader', () => {
  it('names the button after its term, and describes it with the sentence', async () => {
    const tip = readTip(await render());
    assert.equal(tip.name, 'About pot odds');
    assert.equal(tip.description, POT_ODDS.text);
  });

  it('NEGATIVE CONTROL: the reader finds no description when the reference points elsewhere', () => {
    const broken =
      '<span><button aria-describedby="x" type="button"><span aria-hidden="true">?</span>About pot odds</button>' +
      `<span id="y">${POT_ODDS.text}</span></span>`;
    assert.equal(readTip(broken).description, '');
  });

  it('is a native button, so Enter and Space press it with no key handler of its own', async () => {
    const tip = readTip(await render());
    assert.match(tip.button, /type="button"/u);
    assert.match(tip.button, /aria-expanded="false"/u);
  });

  it('starts closed, as a manual popover the page controls', async () => {
    const markup = await render();
    assert.match(markup, /class="prl-tip__bubble" data-open="false" id="[^"]+" popover="manual"/u);
  });

  it('gives two tips on one screen two descriptions', async () => {
    const Tip = await loadComponent<{ readonly tip: TipCopy }>('components/Tip', 'Tip');
    const markup = renderToStaticMarkup(
      createElement(
        'div',
        null,
        createElement(Tip, { tip: POT_ODDS }),
        createElement(Tip, { tip: UI_TIPS.equity }),
      ),
    );
    const ids = [...markup.matchAll(/aria-describedby="([^"]+)"/gu)].map((match) => match[1]);
    assert.equal(ids.length, 2);
    assert.notEqual(ids[0], ids[1]);
  });
});

const SOURCE = readFileSync(new URL('../src/components/Tip.tsx', import.meta.url), 'utf8');
/** Comment lines removed, so a sentence about a listener cannot satisfy a match for one. */
const CODE = SOURCE.split('\n')
  .filter((line) => !/^\s*(?:\*|\/\/|\/\*)/u.test(line))
  .join('\n');

describe('the wiring a document needs (read from the source)', () => {
  it('closes on Escape and stops it, so one Escape does not also close the sheet around the tip', () => {
    assert.match(CODE, /addEventListener\('keydown', onKeyDown, true\)/u);
    assert.match(CODE, /event\.key !== 'Escape'/u);
    assert.match(CODE, /event\.stopPropagation\(\)/u);
  });

  it('closes on a press outside the tip, measured from the whole tip so the button still toggles', () => {
    assert.match(CODE, /addEventListener\('pointerdown', onPointerDown, true\)/u);
    assert.match(CODE, /root\.contains\(event\.target\)/u);
  });

  it('handles no keys on the button, because a key handler beside click toggles twice on Enter', () => {
    assert.doesNotMatch(CODE, /onKeyDown=/u);
    assert.doesNotMatch(CODE, /onKeyUp=/u);
  });

  it('listens only while open', () => {
    assert.match(CODE, /useEffect\(\(\) => \{\s*if \(!open\) return;[^}]*?const onPointerDown/u);
  });

  it('never moves focus, so there is nothing to trap', () => {
    assert.doesNotMatch(CODE, /\.focus\(/u);
  });
});

const VIEWPORT_360 = { width: 360, height: 640 };
const GUTTER = 16;
const GAP = 4;
const BUBBLE = { width: 328, height: 60 };

function box(left: number, top: number, width: number, height: number): TipBox {
  return { left, top, right: left + width, bottom: top + height };
}

type Placer = (input: TipPlacementInput) => TipPlacement;

/** The first thing anyone writes: open at the button, below it. */
const naive: Placer = ({ anchor, gap }) => ({ x: anchor.left, y: anchor.bottom + gap, side: 'below' });

function placements(placer: Placer): readonly { input: TipPlacementInput; out: TipPlacement }[] {
  const all: { input: TipPlacementInput; out: TipPlacement }[] = [];
  for (let left = 16; left <= 320; left += 8) {
    for (const top of [80, 300, 560]) {
      for (const subjectHeight of [24, 96]) {
        const anchor = box(left, top, 24, 24);
        const subject = box(16, top, 328, subjectHeight);
        const input = { anchor, subject, size: BUBBLE, viewport: VIEWPORT_360, gutter: GUTTER, gap: GAP };
        all.push({ input, out: placer(input) });
      }
    }
  }
  return all;
}

const onScreen = ({ input, out }: { input: TipPlacementInput; out: TipPlacement }): boolean =>
  out.x >= input.gutter &&
  out.x + input.size.width <= input.viewport.width - input.gutter &&
  out.y >= 0 &&
  out.y + input.size.height <= input.viewport.height;

const clearOfSubject = ({ input, out }: { input: TipPlacementInput; out: TipPlacement }): boolean =>
  out.y >= input.subject.bottom || out.y + input.size.height <= input.subject.top;

describe('the bubble stays on a 360px screen and off what it explains', () => {
  it('sweeps a real set of positions', () => {
    assert.ok(placements(placeTip).length > 100);
  });

  it('never leaves the screen, wherever the button is', () => {
    for (const case_ of placements(placeTip)) assert.ok(onScreen(case_), JSON.stringify(case_));
    assert.ok(!placements(naive).every(onScreen), 'NEGATIVE CONTROL: opening at the button runs off');
  });

  it('never covers the control it explains', () => {
    for (const case_ of placements(placeTip)) assert.ok(clearOfSubject(case_), JSON.stringify(case_));
    assert.ok(!placements(naive).every(clearOfSubject), 'NEGATIVE CONTROL: below the button covers it');
  });

  it('opens leftwards from a button at the right edge', () => {
    const out = placeTip({
      anchor: box(330, 300, 24, 24),
      subject: box(16, 300, 338, 24),
      size: BUBBLE,
      viewport: VIEWPORT_360,
      gutter: GUTTER,
      gap: GAP,
    });
    assert.equal(out.x, 16);
  });

  it('goes above a tall subject whose button is at its top, and below when there is no room above', () => {
    const tall = box(16, 300, 328, 120);
    const atTop = box(200, 300, 24, 24);
    const input = {
      anchor: atTop,
      subject: tall,
      size: BUBBLE,
      viewport: VIEWPORT_360,
      gutter: GUTTER,
      gap: GAP,
    };
    assert.equal(placeTip(input).side, 'above');
    const nearTop = { ...input, anchor: box(200, 40, 24, 24), subject: box(16, 40, 328, 120) };
    assert.equal(placeTip(nearTop).side, 'below');
  });
});

describe('every tip is one plain sentence', () => {
  const entries = Object.entries(UI_TIPS) as readonly (readonly [string, TipCopy])[];

  it('reads a real catalogue', () => {
    assert.ok(entries.length >= 8, `only ${entries.length} tips`);
  });

  for (const [key, copy] of entries) {
    it(`${key}: "${copy.text}"`, () => {
      assert.deepEqual(tipSentenceProblems(copy), []);
    });
  }

  it('NEGATIVE CONTROLS: the check rejects each way a tip goes wrong', () => {
    const term = 'pot odds';
    const bad: readonly string[] = [
      'The price of a call. It is shown as a ratio.',
      'Is this a question? Yes it is.',
      'The price of a call; shown as a ratio.',
      'the price of a call.',
      'The price of a call',
      'The price of a call..',
      `The ${'very '.repeat(Math.ceil(TIP_MAX_LENGTH / 5))}long price.`,
      'Your equity against the price.',
      '',
    ];
    for (const text of bad) {
      assert.notDeepEqual(tipSentenceProblems({ term, text }), [], `accepted: "${text}"`);
    }
    assert.notDeepEqual(tipSentenceProblems({ term: ' ', text: 'A fine sentence.' }), []);
  });

  it('lets a tip use jargon only to explain that jargon', () => {
    assert.deepEqual(tipSentenceProblems({ term: 'equity', text: 'Equity is how often you win.' }), []);
  });
});

describe('every tip in this package comes from the catalogue, and every entry is used', () => {
  const dir = new URL('../src/components/', import.meta.url);
  const files = readdirSync(dir).filter((file) => file.endsWith('.tsx'));
  const sources = files.map((file) => [file, readFileSync(new URL(file, dir), 'utf8')] as const);
  const uses = sources.flatMap(([file, text]) =>
    [...text.matchAll(/\btip=\{([^}]+)\}/gu)].map((match) => [file, (match[1] ?? '').trim()] as const),
  );

  it('found tips to check', () => {
    assert.ok(files.length > 10);
    assert.ok(uses.length >= 10, `only ${uses.length} tip props`);
  });

  it('passes a catalogue entry, or forwards its own prop', () => {
    for (const [file, value] of uses) {
      assert.ok(/^UI_TIPS\.[A-Za-z]+$/u.test(value) || value === 'tip', `${file}: tip={${value}}`);
    }
  });

  it('uses every entry somewhere', () => {
    const used = new Set(uses.map(([, value]) => value.replace(/^UI_TIPS\./u, '')));
    for (const key of Object.keys(UI_TIPS)) assert.ok(used.has(key), `UI_TIPS.${key} is never shown`);
  });
});

/**
 * `box-shadow` is one property, so an elevated control that does not put the focus halo in the same
 * list loses it while focused, and keyboard-audit.mjs cannot tell: the outline alone still changes.
 * Each component below is elevated and focusable, and its elevation must travel with the ring.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');

const SHEETS = {
  base: read('../src/styles/base.css'),
  components: read('../src/styles/components.css'),
  nav: read('../../../apps/web/src/styles/nav.css'),
  play: read('../../../apps/web/src/styles/play.css'),
  review: read('../../../apps/web/src/styles/review.css'),
} as const;

type Sheet = keyof typeof SHEETS;

interface Rule {
  readonly selectors: readonly string[];
  readonly body: string;
}

/** Splits on commas outside parentheses, so `:where(a, b)` and `var(--x, 0 0 #0000)` stay whole. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === ',' && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts;
}

/** Innermost blocks, so a rule inside `@media` is read with its own selector. Not a CSS parser. */
function rules(css: string): readonly Rule[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selectors: splitTopLevel((match[1] ?? '').trim()),
    body: (match[2] ?? '').trim(),
  }));
}

const boxShadow = (body: string): string | undefined => /(?:^|;)\s*box-shadow\s*:\s*([^;]+)/.exec(body)?.[1];
const elevation = (shadow: string): string | undefined => /var\(--prl-elevation-([1-4])\)/.exec(shadow)?.[1];
const carriesRing = (shadow: string): boolean => /var\(--prl-focus-ring\)|var\(--_ring\b/.test(shadow);

/**
 * `elevated` is the rule that gives the component its elevation. `focus` is every rule that has
 * covered it while focused, and `within` the container that is ringed when something inside it is.
 */
const COMPONENTS: readonly {
  sheet: Sheet;
  elevated: string;
  focus: readonly string[];
  within?: string;
}[] = [
  {
    sheet: 'components',
    elevated: '.prl-material--floating',
    focus: ['.prl-material--floating:focus-visible', '.prl-material--floating:has(:focus-visible)'],
    within: '.prl-material--floating:has(:focus-visible)',
  },
  {
    sheet: 'components',
    elevated: '.prl-material--overlay',
    focus: ['.prl-material--overlay:focus-visible', '.prl-material--overlay:has(:focus-visible)'],
    within: '.prl-material--overlay:has(:focus-visible)',
  },
  { sheet: 'components', elevated: '.prl-btn--primary', focus: ['.prl-btn--primary:focus-visible'] },
  { sheet: 'components', elevated: '.prl-btn--secondary', focus: ['.prl-btn--secondary:focus-visible'] },
  { sheet: 'components', elevated: '.prl-btn--danger', focus: ['.prl-btn--danger:focus-visible'] },
  // A resting marker has no elevation; focus raises it to the hover level.
  { sheet: 'review', elevated: '.prl-timeline__marker:focus-visible', focus: [] },
  {
    sheet: 'review',
    elevated: '.prl-timeline__marker[aria-current="step"]',
    focus: ['.prl-timeline__marker[aria-current="step"]:focus-visible'],
  },
  { sheet: 'nav', elevated: '.prl-pill-group', focus: ['.prl-pillbar__cta:focus-visible'] },
  {
    sheet: 'nav',
    elevated: '.prl-pillbar .prl-units__value',
    focus: ['.prl-pillbar .prl-units__link:focus-visible'],
  },
  {
    sheet: 'nav',
    elevated: '.prl-pillbar .prl-units__toggle',
    focus: ['.prl-pillbar .prl-units__toggle:focus-visible'],
  },
  { sheet: 'nav', elevated: '.prl-nav-trigger', focus: ['.prl-nav-trigger:focus-visible'] },
  {
    sheet: 'play',
    elevated: '.prl-play .prl-action-btn',
    focus: ['.prl-play .prl-action-btn:focus-visible'],
  },
  {
    sheet: 'play',
    elevated: '.prl-play .prl-action-btn--primary',
    focus: ['.prl-play .prl-action-btn--primary:focus-visible'],
  },
];

describe('an elevated, focusable component keeps the focus halo beside its elevation', () => {
  for (const component of COMPONENTS) {
    it(`${component.elevated} (${component.sheet})`, () => {
      const all = rules(SHEETS[component.sheet]);
      const elevatedShadows = all
        .filter((rule) => rule.selectors.includes(component.elevated))
        .map((rule) => boxShadow(rule.body))
        .filter((shadow): shadow is string => shadow !== undefined && elevation(shadow) !== undefined);
      assert.ok(
        elevatedShadows.length > 0,
        `no rule for ${component.elevated} sets an elevation in ${component.sheet}, so this checks nothing`,
      );

      const focusShadows = all
        .filter((rule) => rule.selectors.some((selector) => component.focus.includes(selector)))
        .map((rule) => boxShadow(rule.body))
        .filter((shadow): shadow is string => shadow !== undefined);

      for (const shadow of elevatedShadows) {
        const level = elevation(shadow);
        assert.ok(
          carriesRing(shadow) || focusShadows.some((f) => carriesRing(f) && elevation(f) === level),
          `${component.elevated} sets \`box-shadow: ${shadow}\` and nothing puts the focus ring in that ` +
            'list, so the halo is deleted while it is focused.',
        );
      }

      if (component.within !== undefined) {
        const container = all.filter((rule) => rule.selectors.includes(component.within as string));
        assert.ok(
          container.some((rule) => {
            const shadow = boxShadow(rule.body);
            return /(?:^|;)\s*--_ring\s*:/.test(rule.body) || (shadow !== undefined && carriesRing(shadow));
          }),
          `${component.within} must ring the container, or a focused child leaves it unmarked`,
        );
      }
    });
  }

  it('reads the ring variable only under the name base.css sets on :focus-visible, uninherited', () => {
    const readers = Object.entries(SHEETS).flatMap(([name, css]) =>
      [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/var\((--_[\w-]+)/g)].map((m) => `${name}: ${m[1]}`),
    );
    if (readers.length === 0) return;
    const base = rules(SHEETS.base);
    const set = base
      .filter((rule) => rule.selectors.includes(':focus-visible'))
      .map((rule) => /(?:^|;)\s*(--_[\w-]+)\s*:\s*var\(--prl-focus-ring\)/.exec(rule.body)?.[1])
      .find((name) => name !== undefined);
    assert.ok(
      set !== undefined,
      'base.css :focus-visible must set the ring variable to var(--prl-focus-ring)',
    );
    for (const reader of readers) assert.ok(reader.endsWith(` ${set}`), `${reader} is not ${set}`);
    assert.match(
      SHEETS.base,
      new RegExp(`@property\\s+${set}\\s*\\{[^}]*inherits\\s*:\\s*false`),
      `${set} must be registered with inherits: false, or a focused container rings every elevated child`,
    );
  });
});

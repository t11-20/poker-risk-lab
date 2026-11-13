/**
 * Stylesheet invariants a browser would otherwise be the only witness to, asserted on the CSS text.
 * R7: a sticky `.prl-play__decision` from 900px up covered the pot, the board and all six seats.
 * P2-1: the boot overlay's 900ms cap lived only in an effect, so a failed bundle left it up for good,
 * and the reveal's hidden state had no exit for a failed bundle either.
 * It reads `apps/web`'s stylesheets too, because the occlusion came from both packages together.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const componentsCss = readFileSync(new URL('../src/styles/components.css', import.meta.url), 'utf8');
const playCss = readFileSync(new URL('../../../apps/web/src/styles/play.css', import.meta.url), 'utf8');

/**
 * The declarations of every block whose selector list contains `selector`, including inside media
 * and container queries. Not a CSS parser. Comments go first so prose cannot match.
 */
function declarationsFor(css: string, selector: string): readonly string[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const blocks: string[] = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  let match = pattern.exec(withoutComments);
  while (match !== null) {
    const selectors = (match[1] ?? '').split(',').map((part) => part.trim());
    if (selectors.some((part) => part === selector || part.endsWith(` ${selector}`))) {
      blocks.push((match[2] ?? '').trim());
    }
    match = pattern.exec(withoutComments);
  }
  return blocks;
}

describe('the play screen never pins a surface over the table', () => {
  it('has the decision band in flow at every width', () => {
    const blocks = declarationsFor(playCss, '.prl-play__decision');
    assert.ok(blocks.length > 0, 'expected .prl-play__decision to be styled in play.css');
    for (const block of blocks) {
      assert.doesNotMatch(
        block,
        /position\s*:\s*(sticky|fixed|absolute)/,
        'A pinned decision band occupies the bottom strip of the viewport for the whole of its ' +
          'pinned range, and the block above it in flow — the table — therefore ends inside that ' +
          'strip by definition. See design system section 10.1; the fix is height, not layers.',
      );
    }
  });

  it('leaves the Coach rail sticky, which is the one thing that may be', () => {
    const blocks = declarationsFor(playCss, '.prl-play__coach');
    assert.ok(
      blocks.some((block) => /position\s*:\s*sticky/.test(block)),
      'the rail carries the equity figure and must not scroll away',
    );
  });

  it('reflows the band on a container query, at the same threshold the table uses', () => {
    assert.match(
      playCss,
      /@container\s+prl-play-column\s*\(min-width:\s*46rem\)/,
      'the band goes side by side on a CONTAINER query, because the column is not the viewport',
    );
    for (const block of declarationsFor(playCss, '.prl-play__decision')) {
      assert.doesNotMatch(
        block,
        /display\s*:\s*none/,
        'the decision band is the controls; it is never removed to make something else fit',
      );
    }
  });

  it('does not set `display` on the plate readout inside that container query', () => {
    // Matched by its condition, because the earlier `width < 46rem` query has no HUD rule.
    const query = /@container\s+prl-play-column\s*\(min-width:\s*46rem\)[^{]*\{([\s\S]*?)\n\}/.exec(
      playCss,
    )?.[1];
    assert.ok(query !== undefined, 'expected the prl-play-column (min-width: 46rem) container query block');
    const hud = /\.prl-play__hud\s*\{([^}]*)\}/.exec(query)?.[1];
    assert.ok(hud !== undefined, 'expected a .prl-play__hud rule inside that query');
    assert.doesNotMatch(
      hud,
      /display\s*:/,
      'The HUD is display:none under 900px because the stacked table already pins the viewer’s ' +
        'own plate above the band. A column between 860 and 899px matches this query, so setting ' +
        'display here would resurrect the duplicate plate at exactly those widths.',
    );
  });
});

describe('the sticky action row is bounded by a bar that stays in flow', () => {
  // The action row is sticky below 46rem of column, which is safe only because its containing block,
  // the ActionBar, sits below the table. Pinning or dissolving the bar brings back R7.
  it('never pins or dissolves the ActionBar or the band around it', () => {
    const blocks = [
      ...declarationsFor(componentsCss, '.prl-action-bar'),
      ...declarationsFor(playCss, '.prl-action-bar'),
      ...declarationsFor(playCss, '.prl-play__decision'),
    ];
    assert.ok(
      blocks.length >= 3,
      `expected the bar and the band to be styled, found ${blocks.length} rule(s)`,
    );
    for (const block of blocks) {
      assert.doesNotMatch(block, /position\s*:\s*(sticky|fixed|absolute)/);
      assert.doesNotMatch(block, /display\s*:\s*contents/);
    }
  });

  it('gives the sizer controls a scroll margin wherever the row sticks', () => {
    const sticky = declarationsFor(playCss, '.prl-action-bar__actions').some((block) =>
      /position\s*:\s*sticky/.test(block),
    );
    assert.ok(sticky, 'expected section 3.1 to make the action row sticky');
    for (const control of ['.prl-sizer button', '.prl-sizer input']) {
      assert.ok(
        declarationsFor(playCss, control).some((block) => /scroll-margin-block-end\s*:/.test(block)),
        `a ${control} the caret moves to would be delivered behind the stuck row (WCAG 2.4.11)`,
      );
    }
  });
});

describe('nothing can hide content until JavaScript arrives', () => {
  it('gives the boot overlay a CSS deadline on the budget it enforces', () => {
    const blocks = declarationsFor(componentsCss, '.prl-boot');
    const animation = blocks.map((block) => /animation\s*:\s*([^;]+)/.exec(block)?.[1]).find(Boolean);
    assert.ok(animation !== undefined, '.prl-boot needs a deadline animation, not only a transition');
    assert.match(animation, /var\(--prl-dur-count\)/, 'the delay is the 900ms cap section 8 states');
    assert.match(animation, /forwards/, 'the deadline must hold once it has passed');
  });

  it('ends that deadline on visibility, never on opacity', () => {
    const keyframes = /@keyframes\s+prl-boot-deadline\s*\{([\s\S]*?)\n\}/.exec(componentsCss)?.[1];
    assert.ok(keyframes !== undefined, 'expected a prl-boot-deadline keyframes block');
    assert.match(keyframes, /visibility\s*:\s*hidden/);
    assert.match(keyframes, /pointer-events\s*:\s*none/);
    assert.doesNotMatch(
      keyframes,
      /opacity/,
      'a filling opacity animation out-ranks the data-state="done" declaration, so the fade would ' +
        'never start, transitionend would never fire, and BootSequence would never unmount itself',
    );
  });

  it('releases every hidden reveal on an UNCONDITIONAL deadline', () => {
    // A deadline scoped to boot stops matching once boot ends, leaving a reveal whose observer never
    // fires hidden for good. The deadline belongs to the hidden state itself.
    const hidden = declarationsFor(componentsCss, '.prl-reveal[data-revealed="false"]')[0];
    assert.ok(hidden !== undefined, 'expected a .prl-reveal[data-revealed="false"] block');
    const animation = /animation\s*:\s*([^;]+)/.exec(hidden)?.[1];
    assert.ok(animation !== undefined, 'the hidden state must carry its own expiry');
    assert.match(animation, /prl-reveal-deadline/);
    assert.match(animation, /var\(--prl-dur-count\)/, 'the delay is the 900ms cap section 8 states');
    assert.match(animation, /forwards/, 'the deadline must hold once it has passed');
    assert.doesNotMatch(
      animation,
      /backwards|\bboth\b/,
      'a backwards fill would make the animation own opacity from time zero, which is how a ' +
        'deadline stops a transition from ever running',
    );

    const keyframes = /@keyframes\s+prl-reveal-deadline\s*\{([\s\S]*?)\n\}/.exec(componentsCss)?.[1];
    assert.ok(keyframes !== undefined, 'expected a prl-reveal-deadline keyframes block');
    assert.match(keyframes, /opacity\s*:\s*1/);
    assert.match(keyframes, /transform\s*:\s*none/);
  });

  it('binds that deadline to the hidden selector, so revealing removes it', () => {
    // A filling opacity animation out-ranks a later opacity declaration, so the deadline must vanish
    // with the hidden attribute. In Chrome, `data-revealed="true"` leaves only the two CSSTransitions.
    for (const block of declarationsFor(componentsCss, '.prl-reveal')) {
      assert.doesNotMatch(
        block,
        /animation\s*:/,
        'the deadline must never sit on the bare class, only on the hidden attribute selector',
      );
    }
  });

  it('keeps the reveal hidden state keyed on the attribute, never on the bare class', () => {
    const bare = declarationsFor(componentsCss, '.prl-reveal');
    for (const block of bare) {
      assert.doesNotMatch(
        block,
        /opacity\s*:\s*0/,
        'styling .prl-reveal bare hides content whenever the observer never runs',
      );
    }
  });
});

/** Every declaration block, as `{ selector, body }`, comments stripped, for checks over any rule. */
function allBlocks(css: string): readonly { selector: string; body: string }[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: { selector: string; body: string }[] = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  let match = pattern.exec(withoutComments);
  while (match !== null) {
    out.push({ selector: (match[1] ?? '').trim(), body: (match[2] ?? '').trim() });
    match = pattern.exec(withoutComments);
  }
  return out;
}

/** Every stylesheet a glass fill can reach. The ghosting bug shipped in an `apps/web` route stylesheet. */
const ROUTE_STYLE_DIR = new URL('../../../apps/web/src/styles/', import.meta.url);
const GLASS_SCANNED: readonly (readonly [string, string])[] = [
  ['packages/ui components.css', componentsCss],
  [
    'apps/web globals.css',
    readFileSync(new URL('../../../apps/web/src/app/globals.css', import.meta.url), 'utf8'),
  ],
  ...readdirSync(ROUTE_STYLE_DIR)
    .filter((file) => file.endsWith('.css'))
    .sort()
    .map((file) => [`apps/web ${file}`, readFileSync(new URL(file, ROUTE_STYLE_DIR), 'utf8')] as const),
];

describe('the design system rules that are stated in prose and checked nowhere', () => {
  /**
   * A shadow is never a literal. Every `box-shadow` part is `--prl-elevation-*`, `--prl-focus-ring`,
   * or `none` to cancel an inherited elevation.
   */
  const SHADOW_VALUE = /box-shadow\s*:\s*([^;]+)/g;
  const ALLOWED_SHADOW_PART = /^(none|var\(--prl-elevation-[0-4]\)|var\(--prl-focus-ring\))$/;

  it('spends a shadow only through an elevation or focus-ring token, never as a literal', () => {
    for (const [name, css] of GLASS_SCANNED) {
      const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
      for (const match of withoutComments.matchAll(SHADOW_VALUE)) {
        const value = (match[1] ?? '').trim();
        for (const part of value.split(',').map((piece) => piece.trim())) {
          assert.match(
            part,
            ALLOWED_SHADOW_PART,
            `${name}: \`box-shadow: ${value}\` spends a literal. Elevation is a level on the ` +
              'material ladder (design system section 2.7); add a token before you add a shadow.',
          );
        }
      }
    }
  });

  /**
   * The ghosting guard (`apps/web/src/styles/nav.css`). A translucent fill with no blur leaves the
   * text behind legible. Wherever a glass fill token goes, `backdrop-filter` goes in the same block,
   * a `:hover` block included. Scoped to the fill tokens, not `--prl-glass-filter`.
   */
  const GLASS_FILL = /var\(--prl-glass-(?:floating|overlay)(?:-hover|-active)?\)/;

  it('never uses a glass fill without the blur that makes it legible', () => {
    let seen = 0;
    for (const [name, css] of GLASS_SCANNED) {
      for (const block of allBlocks(css)) {
        if (!GLASS_FILL.test(block.body)) continue;
        seen += 1;
        assert.match(
          block.body,
          /backdrop-filter\s*:/,
          `${name}: \`${block.selector}\` sets a translucent glass fill with no backdrop-filter. ` +
            'That is the ghosting bug in the header comment of apps/web/src/styles/nav.css: the ' +
            'content behind stays perfectly legible, in the wrong place, as a second layer of text.',
        );
      }
    }
    // A sweep of nothing is not a pass.
    assert.ok(seen > 0, 'expected at least one glass fill to exist to be checked');
  });

  it('spends no raw duration or easing curve outside the token layer', () => {
    for (const [name, css] of [
      ['components.css', componentsCss],
      ['play.css', playCss],
    ] as const) {
      const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
      assert.doesNotMatch(withoutComments, /:\s*[\d.]+m?s\b/, `${name}: durations come from tokens`);
      assert.doesNotMatch(withoutComments, /cubic-bezier\(/, `${name}: easing comes from tokens`);
    }
  });
});

/**
 * A numeric column that declares `text-align: end` must win the cascade. `.prl-x__table td` is
 * (0,1,1) and silently beats a bare `.prl-x__cost` at (0,1,0). This shipped more than once.
 * End-aligning selectors must be element-qualified (`td.`/`th.`) and placed below, since a tie
 * goes to source order.
 */
describe('numeric columns are actually end-aligned', () => {
  /** `.prl-candidates__table th, .prl-candidates__table td { … text-align: start … }` */
  const TABLE_WIDE_START = /([^{}]*\bth\b[^{}]*,[^{}]*\btd\b[^{}]*)\{[^{}]*text-align:\s*start[^{}]*\}/gu;
  const CELL_END = /([^{}]+)\{[^{}]*text-align:\s*end[^{}]*\}/gu;
  /** `prl-candidates__table` -> `prl-candidates`. The BEM block is what ties a cell to its table. */
  const blockOf = (selector: string): string | null => /\.([a-z0-9-]+)__/u.exec(selector)?.[1] ?? null;
  const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//gu, '');

  it('never end-aligns a cell through a selector that loses to its own table (REGRESSION)', () => {
    const offenders: string[] = [];
    let tablesFound = 0;
    for (const [name, raw] of GLASS_SCANNED) {
      // Comments stripped first, or prose explaining the defect is reported as the defect.
      const css = strip(raw);

      // Only a table that start-aligns its own cells can defeat anything. Without one, a bare class is fine.
      const guarded = new Set<string>();
      for (const wide of css.matchAll(TABLE_WIDE_START)) {
        const block = blockOf(wide[1] ?? '');
        if (block !== null) {
          guarded.add(block);
          tablesFound += 1;
        }
      }
      if (guarded.size === 0) continue;

      for (const match of css.matchAll(CELL_END)) {
        for (const selector of (match[1] ?? '').split(',').map((part) => part.trim())) {
          const block = blockOf(selector);
          if (block === null || !guarded.has(block)) continue;
          // (0,1,1) or better beats the table-wide rule; a bare class at (0,1,0) does not.
          const beatsIt = /\b(?:td|th)\./u.test(selector) || /(?:^|\s)(?:td|th)\b/u.test(selector);
          if (!beatsIt) offenders.push(`${name}: ${selector}`);
        }
      }
    }
    assert.ok(tablesFound > 0, 'no table-wide start-align rule was found; the sweep proved nothing');
    assert.deepEqual(
      offenders,
      [],
      'a bare class cannot out-specify `<table> td`, so these declarations apply to nothing',
    );
  });

  it('places the candidate table override BELOW the rule it has to beat', () => {
    const wide = componentsCss.indexOf('.prl-candidates__table th,');
    const override = componentsCss.indexOf('td.prl-candidates__cost');
    assert.ok(wide > 0 && override > 0, 'both rules must exist for the ordering to matter');
    assert.ok(override > wide, 'the end-align override must come after the table-wide start-align');
  });

  /**
   * The scans above check selectors, not values. Changing the override to `start` passed every test
   * in both packages. So the cascade is resolved here, by (specificity, source position), over every
   * rule that can match `td.prl-candidates__cost`.
   */
  it("resolves the candidate table's numeric cells to `end`, not merely to a declaration", () => {
    const css = strip(componentsCss);
    const matching: { selector: string; at: number; specificity: number; value: string | null }[] = [];
    for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
      const body = match[2] ?? '';
      const align = /(?:^|;)\s*text-align:\s*([a-z-]+)/u.exec(body);
      if (align === null) continue;
      for (const selector of (match[1] ?? '').split(',').map((part) => part.trim())) {
        // Only selectors that can match `<td class="prl-candidates__cost">` in `.prl-candidates__table`.
        const classes = [...selector.matchAll(/\.([a-z0-9_-]+)/gu)].map((entry) => entry[1]);
        const known = new Set(['prl-candidates__table', 'prl-candidates__cost']);
        if (!classes.every((name) => known.has(String(name)))) continue;
        const elements = [...selector.matchAll(/(?:^|[\s>+~])([a-z]+)\b/gu)].map((entry) => entry[1]);
        if (!elements.every((name) => name === 'td')) continue;
        matching.push({
          selector,
          at: match.index ?? 0,
          // (0, classes, elements) as one comparable number. No ids anywhere in this stylesheet.
          specificity: classes.length * 100 + elements.length,
          value: align[1] ?? null,
        });
      }
    }
    // A sweep of nothing is not a pass. The table-wide rule and the override must both be found.
    assert.ok(
      matching.length >= 2,
      `only ${matching.length} rule(s) could match the candidate cost cell; the resolver found nothing to arbitrate`,
    );
    matching.sort((a, b) => a.specificity - b.specificity || a.at - b.at);
    const winner = matching.at(-1);
    assert.equal(
      winner?.value,
      'end',
      `the candidate table's cost cell resolves to ${winner?.value} via \`${winner?.selector}\`; ` +
        'a column of money that reads left-aligned is the defect this whole block exists for',
    );
    assert.ok(
      matching.some((rule) => rule.value === 'start' && rule !== winner),
      'no table-wide start-align rule was in the comparison, so nothing was actually beaten',
    );
  });

  it('catches the historical defect when it is replayed (NEGATIVE CONTROL)', () => {
    const replayed = `
      .prl-x__table th, .prl-x__table td { text-align: start; }
      .prl-x__figure { text-align: end; }
    `;
    const guarded = new Set<string>();
    for (const wide of replayed.matchAll(TABLE_WIDE_START)) {
      const block = blockOf(wide[1] ?? '');
      if (block !== null) guarded.add(block);
    }
    assert.ok(guarded.has('prl-x'), 'the table-wide rule must be recognised');
    const caught: string[] = [];
    for (const match of replayed.matchAll(CELL_END)) {
      const selector = (match[1] ?? '').trim();
      const block = blockOf(selector);
      if (block !== null && guarded.has(block) && !/\b(?:td|th)\./u.test(selector)) {
        caught.push(selector);
      }
    }
    assert.deepEqual(caught, ['.prl-x__figure']);
  });
});

/**
 * The same trap outside tables. `.prl-legal-flag p` (0,1,1) beat `.prl-legal-flag__mark` (0,1,0), so
 * the caution colour never painted on any of the fifteen legal-page marks.
 * A part class competing with its block's element rule must be type-qualified (`p.prl-legal-flag__mark`)
 * and declared below it. Scoped to `color` and `text-align`, the two properties this has hit. Layout
 * properties would flag pairs on different elements.
 */
describe('a block never lets its element rules out-rank its own parts', () => {
  const CONTESTED = ['color', 'text-align'] as const;
  /** `.prl-legal-flag p`, a block then a bare element type. (0,1,1). */
  const BLOCK_TYPE = /^\.(prl-[a-z0-9_-]+)\s+([a-z][a-z0-9]*)$/u;
  /** `.prl-legal-flag__mark`, optionally type-qualified as `p.prl-legal-flag__mark`. */
  const PART = /^([a-z][a-z0-9]*)?\.(prl-[a-z0-9_-]+)$/u;

  /** Is `cls` a part of `scope`? BEM's `__` and this repo's hyphenated variants both count. */
  const partOf = (cls: string, scope: string): boolean =>
    cls !== scope && (cls.startsWith(`${scope}__`) || cls.startsWith(`${scope}-`));

  interface Guard {
    readonly file: string;
    readonly scope: string;
    readonly type: string;
    readonly property: string;
    readonly at: number;
  }

  function scan(): { guards: Guard[]; unqualified: string[]; misordered: string[] } {
    const guards: Guard[] = [];
    const unqualified: string[] = [];
    const misordered: string[] = [];

    for (const [name, raw] of GLASS_SCANNED) {
      const css = raw.replace(/\/\*[\s\S]*?\*\//gu, '');
      const blocks = allBlocks(css).map((block) => ({ ...block, at: css.indexOf(block.selector) }));

      for (const block of blocks) {
        for (const selector of block.selector.split(',').map((part) => part.trim())) {
          const match = BLOCK_TYPE.exec(selector);
          if (match === null) continue;
          for (const property of CONTESTED) {
            if (!new RegExp(`(^|;)\\s*${property}\\s*:`, 'u').test(block.body)) continue;
            guards.push({
              file: name,
              scope: match[1] ?? '',
              type: match[2] ?? '',
              property,
              at: block.at,
            });
          }
        }
      }

      for (const block of blocks) {
        for (const selector of block.selector.split(',').map((part) => part.trim())) {
          const match = PART.exec(selector);
          if (match === null) continue;
          const [, type, cls = ''] = match;
          for (const property of CONTESTED) {
            if (!new RegExp(`(^|;)\\s*${property}\\s*:`, 'u').test(block.body)) continue;
            for (const guard of guards) {
              if (guard.file !== name || guard.property !== property) continue;
              if (!partOf(cls, guard.scope)) continue;
              if (type === undefined) {
                unqualified.push(
                  `${name}: \`${selector} { ${property} }\` loses to \`.${guard.scope} ${guard.type}\``,
                );
              } else if (type === guard.type && block.at < guard.at) {
                misordered.push(
                  `${name}: \`${selector}\` ties with \`.${guard.scope} ${guard.type}\` and is declared above it`,
                );
              }
            }
          }
        }
      }
    }
    return { guards, unqualified, misordered };
  }

  it('type-qualifies every part that competes with one of its block’s element rules', () => {
    const { guards, unqualified } = scan();
    // A sweep of nothing is not a pass.
    assert.ok(guards.length > 0, 'no `.block <type>` rule setting a contested property was found');
    assert.deepEqual(
      unqualified,
      [],
      'a bare class is (0,1,0) and an element selector inside the block is (0,1,1), so these ' +
        'declarations apply to nothing. Qualify with the element type the part is rendered as.',
    );
  });

  it('declares a tying part BELOW the element rule it has to beat', () => {
    const { misordered } = scan();
    assert.deepEqual(misordered, [], '(0,1,1) ties with (0,1,1); source order is what decides it');
  });

  it('catches the historical defect when it is replayed (NEGATIVE CONTROL)', () => {
    // The shape that shipped in legal.css.
    const replayed = `
      .prl-x-flag p { color: var(--prl-text-secondary); }
      .prl-x-flag__mark { color: var(--prl-caution); }
    `;
    const caught: string[] = [];
    const guards: { scope: string; type: string }[] = [];
    for (const block of allBlocks(replayed)) {
      for (const selector of block.selector.split(',').map((part) => part.trim())) {
        const guard = BLOCK_TYPE.exec(selector);
        if (guard !== null && /color\s*:/u.test(block.body)) {
          guards.push({ scope: guard[1] ?? '', type: guard[2] ?? '' });
          continue;
        }
        const part = PART.exec(selector);
        if (part === null || !/color\s*:/u.test(block.body)) continue;
        const [, type, cls = ''] = part;
        if (type === undefined && guards.some((entry) => partOf(cls, entry.scope))) caught.push(selector);
      }
    }
    assert.deepEqual(caught, ['.prl-x-flag__mark']);
  });
});

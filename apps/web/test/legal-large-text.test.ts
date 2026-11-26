/**
 * /terms, /privacy, /responsible-use and /age-check at 320px and at 360px with 200% text, held as the rules
 * that fixed them. Each was measured with `test:layout`; none moves a pixel at 360px or wider at 16px text.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const legal = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'styles', 'legal.css'),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//gu, '');

const PHONE_AT_200 = '@media (width < 20em)';

interface Rule {
  readonly selectors: readonly string[];
  readonly body: string;
  readonly at: number;
  /** Inside an at-rule block, so it applies only some of the time. */
  readonly conditional: boolean;
}

/** Every style rule in source order, each marked by whether an at-rule block holds it. */
function rules(css: string): Rule[] {
  const found: Rule[] = [];
  const atRuleDepths: number[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < css.length; i += 1) {
    if (css[i] === '{') {
      const prelude = css.slice(start, i).trim();
      depth += 1;
      if (prelude.startsWith('@')) atRuleDepths.push(depth);
      else {
        const close = css.indexOf('}', i);
        found.push({
          selectors: prelude.split(',').map((one) => one.trim()),
          body: css.slice(i + 1, close),
          at: start,
          conditional: atRuleDepths.length > 0,
        });
        i = close;
        depth -= 1;
      }
      start = i + 1;
    } else if (css[i] === '}') {
      if (atRuleDepths.at(-1) === depth) atRuleDepths.pop();
      depth -= 1;
      start = i + 1;
    }
  }
  assert.ok(found.length > 0, 'read no rules from legal.css');
  return found;
}

const ALL = rules(legal);

function value(body: string, property: string): string | undefined {
  return [...body.matchAll(new RegExp(`(?:^|[;{\\s])${property}:\\s*([^;]+);`, 'gu'))].at(-1)?.[1]?.trim();
}

/** The value the cascade gives `property` on `selector` from unconditional rules: the last one wins. */
function unconditionalValue(selector: string, property: string): string | undefined {
  const named = ALL.filter((rule) => !rule.conditional && rule.selectors.includes(selector));
  assert.ok(named.length > 0, `no unconditional rule names ${selector}`);
  return named
    .map((rule) => value(rule.body, property))
    .filter((one) => one !== undefined)
    .at(-1);
}

const narrow = ALL.filter(
  (rule) =>
    rule.conditional && legal.lastIndexOf('@media', rule.at) === legal.lastIndexOf(PHONE_AT_200, rule.at),
);

function narrowValue(selector: string, property: string): string | undefined {
  return narrow
    .filter((rule) => rule.selectors.includes(selector))
    .map((rule) => value(rule.body, property))
    .filter((one) => one !== undefined)
    .at(-1);
}

describe('the legal pages at 320px, and at 360px with 200% text', () => {
  it('reach the phone query only with large text', () => {
    const em = Number(/^@media \(width < ([\d.]+)em\)$/u.exec(PHONE_AT_200)?.[1]);
    assert.ok(320 / 16 >= em, `a 320px window at 16px text would take the narrow padding at ${em}em`);
    assert.ok(360 / 32 < em, `a 360px window at 32px text would keep the wide padding at ${em}em`);
  });

  // An `auto` track floors at its widest token: "(PRL_LEGEND_NAMING=attributed)," made /terms 329px at 320,
  // a contact address with no hyphen made /privacy 399px at 360 and 200%, an env name widened the gate.
  it('gives every grid one track that can shrink by default', () => {
    const grids = ALL.filter((rule) => !rule.conditional && value(rule.body, 'display') === 'grid');
    assert.ok(grids.length >= 8, `found only ${String(grids.length)} grids in legal.css`);
    for (const selector of grids.flatMap((rule) => rule.selectors)) {
      assert.equal(unconditionalValue(selector, 'grid-template-columns'), 'minmax(0, 1fr)', selector);
    }
  });

  // `anywhere` breaks a prose word mid-letter, so it is kept to elements that hold one token each.
  it('lets only tokens break anywhere: a table name and a code path', () => {
    const anywhere = ALL.filter((rule) => value(rule.body, 'overflow-wrap') === 'anywhere');
    assert.deepEqual(
      anywhere.flatMap((rule) => rule.selectors),
      ['.prl-legal__inventory dt', '.prl-gate code'],
    );
  });

  // Inside 48px sides the shrunken banner tore "unenforceable" one letter short of its end.
  it('narrows the banner and the clause flag only with large text on a phone', () => {
    for (const selector of ['.prl-legal__banner', '.prl-legal-flag']) {
      assert.equal(narrowValue(selector, 'padding'), 'var(--prl-space-6)', selector);
      assert.notEqual(unconditionalValue(selector, 'padding'), 'var(--prl-space-6)', selector);
    }
  });

  // Chrome does not hyphenate a capitalised word, and CI's Chrome may have no dictionary.
  it('does not depend on hyphenation', () => {
    assert.doesNotMatch(legal, /\bhyphens:/u);
  });
});

describe('the age gate’s panel at 360px with 200% text', () => {
  // 80px sides left 134px for "deployment" (225px), and a caveat's 40px sides too little for "jurisdiction".
  it('narrows the gate and its caveats only with large text on a phone', () => {
    assert.equal(narrowValue('.prl-gate', 'padding'), 'var(--prl-space-5)');
    assert.equal(narrowValue('.prl-gate__caveat', 'padding-inline'), 'var(--prl-space-4)');
  });
});

// A narrow rule has the same specificity as the rule it overrides, so it wins only by coming later.
it('puts every narrow rule after each unconditional rule for the same selector', () => {
  const selectors = narrow.flatMap((rule) => rule.selectors);
  assert.ok(selectors.length >= 4, `found only ${String(selectors.length)} narrow selectors`);
  for (const rule of narrow) {
    for (const selector of rule.selectors) {
      const base = ALL.filter((one) => !one.conditional && one.selectors.includes(selector));
      assert.ok(base.length > 0, `no unconditional rule for ${selector}`);
      for (const one of base) assert.ok(one.at < rule.at, `${selector}: the narrow rule comes first`);
    }
  }
});

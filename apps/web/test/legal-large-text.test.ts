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

/** The body of each block opened by `opener`, braces balanced. */
function blocks(css: string, opener: string): string[] {
  const bodies: string[] = [];
  for (let at = css.indexOf(`${opener} {`); at >= 0; at = css.indexOf(`${opener} {`, at + 1)) {
    const open = css.indexOf('{', at);
    let depth = 0;
    for (let i = open; i < css.length; i += 1) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}' && --depth === 0) {
        bodies.push(css.slice(open + 1, i));
        break;
      }
    }
  }
  assert.ok(bodies.length > 0, `no "${opener}" block`);
  return bodies;
}

/** The stylesheet with every at-rule block removed, so only unconditional rules remain. */
function unconditional(css: string): string {
  let out = css;
  for (let at = out.indexOf('@'); at >= 0; at = out.indexOf('@')) {
    const open = out.indexOf('{', at);
    let depth = 0;
    let end = open;
    for (; end < out.length; end += 1) {
      if (out[end] === '{') depth += 1;
      else if (out[end] === '}' && --depth === 0) break;
    }
    out = out.slice(0, at) + out.slice(end + 1);
  }
  return out;
}

/** Every declaration list whose selector list names `selector` exactly. */
function rulesFor(css: string, selector: string): string[] {
  const found = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
    .filter((m) => (m[1] ?? '').split(',').some((one) => one.trim() === selector))
    .map((m) => m[2] ?? '');
  assert.ok(found.length > 0, `no rule names ${selector}`);
  return found;
}

function declares(css: string, selector: string, property: string, value: string): boolean {
  return rulesFor(css, selector).some((body) =>
    new RegExp(`(?:^|[;\\s])${property}: ${value.replace(/[()]/gu, '\\$&')};`, 'u').test(body),
  );
}

const phone = (): string => blocks(legal, PHONE_AT_200).join('\n');

describe('the legal pages at 320px, and at 360px with 200% text', () => {
  it('reach the phone query only with large text', () => {
    const em = Number(/^@media \(width < ([\d.]+)em\)$/u.exec(PHONE_AT_200)?.[1]);
    assert.ok(320 / 16 >= em, `a 320px window at 16px text would take the narrow padding at ${em}em`);
    assert.ok(360 / 32 < em, `a 360px window at 32px text would keep the wide padding at ${em}em`);
  });

  // An `auto` track floors at its widest token: "(PRL_LEGEND_NAMING=attributed)," made /terms 329px at 320.
  it('gives every grid that holds prose or a token one track that can shrink', () => {
    const grids = [
      '.prl-legal',
      '.prl-legal__section',
      '.prl-legal__banner',
      '.prl-legal-flag',
      '.prl-legal__inventory',
    ];
    for (const selector of grids) {
      assert.ok(declares(unconditional(legal), selector, 'display', 'grid'), `${selector} is not a grid`);
      assert.ok(
        declares(unconditional(legal), selector, 'grid-template-columns', 'minmax(0, 1fr)'),
        selector,
      );
    }
  });

  // A table name such as "prl.oidc_login_attempts" was 388px at 200%; unlike `dd`, a `dt` has no wrap.
  it('lets an inventory term, a table name, break anywhere', () => {
    assert.ok(declares(unconditional(legal), '.prl-legal__inventory dt', 'overflow-wrap', 'anywhere'));
  });

  // Inside 48px sides the shrunken banner tore "unenforceable" one letter short of its end.
  it('narrows the banner and the clause flag only with large text on a phone', () => {
    for (const selector of ['.prl-legal__banner', '.prl-legal-flag']) {
      assert.ok(declares(phone(), selector, 'padding', 'var(--prl-space-6)'), selector);
    }
  });

  // Chrome does not hyphenate a capitalised word, and CI's Chrome may have no dictionary.
  it('does not depend on hyphenation', () => {
    assert.doesNotMatch(legal, /\bhyphens:/u);
  });
});

describe('/age-check at 360px with 200% text', () => {
  // "docs/production/legal-review-requirements.md" ran 190px past the panel and made the page 518px.
  it('lets a code path in the gate break anywhere', () => {
    assert.ok(declares(unconditional(legal), '.prl-gate code', 'overflow-wrap', 'anywhere'));
  });
});

describe('the age gate’s panel at 360px with 200% text', () => {
  // 80px sides left 134px for "deployment" (225px) and 'jurisdiction' (205px inside a caveat's 40px sides).
  it('narrows the gate and its caveats only with large text on a phone', () => {
    assert.ok(declares(phone(), '.prl-gate', 'padding', 'var(--prl-space-5)'));
    assert.ok(declares(phone(), '.prl-gate__caveat', 'padding-inline', 'var(--prl-space-4)'));
  });

  // Same specificity, so the narrow caveat padding wins only by coming later.
  it('declares the narrow caveat padding after the caveat’s own', () => {
    const own = legal.search(/\.prl-gate__caveat \{[^}]*padding: /u);
    const openers = [...legal.matchAll(/@media \(width < 20em\) \{/gu)].map((m) => m.index ?? -1);
    const narrow = openers.find((at) =>
      (blocks(legal.slice(at), PHONE_AT_200)[0] ?? '').includes('.prl-gate__caveat {'),
    );
    assert.ok(own >= 0 && narrow !== undefined, 'both rules are present');
    assert.ok(own < narrow, 'the narrow rule comes later');
  });
});

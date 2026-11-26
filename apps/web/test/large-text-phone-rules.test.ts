/**
 * Learn, home and /checks at 360px with 200% text, held as the rules that fixed them. Each was measured
 * with `test:layout --text-scale 2`; none may move a pixel at the default text size.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const STYLES = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'styles');
const style = (file: string): string =>
  readFileSync(join(STYLES, file), 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '');

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

describe('the phone query', () => {
  const em = Number(/^@media \(width < ([\d.]+)em\)$/u.exec(PHONE_AT_200)?.[1]);

  it('is false at 360px with default text and true at 360px with 200% text', () => {
    assert.ok(360 / 16 >= em, `a 360px phone at 16px text would take the stacked layout at ${em}em`);
    assert.ok(360 / 32 < em, `a 360px phone at 32px text would keep the side-by-side layout at ${em}em`);
  });

  it('is the query both stylesheets stack under', () => {
    for (const file of ['learn.css', 'home.css']) assert.ok(blocks(style(file), PHONE_AT_200).length > 0);
  });
});

describe('Learn at 360px with 200% text', () => {
  const learn = style('learn.css');
  const phone = (): string => blocks(learn, PHONE_AT_200).join('\n');

  // A display-3 heading floored the sheet's implicit track, so the sheet ran past the page.
  it('gives the lesson sheet one track that can shrink', () => {
    assert.ok(
      declares(unconditional(learn), '.prl-learn-lesson__blocks', 'grid-template-columns', 'minmax(0, 1fr)'),
    );
  });

  // The number's column left a card's text 141-172px.
  it('stacks a lesson card’s number above its text', () => {
    assert.ok(declares(phone(), '.prl-learn-entry', 'grid-template-columns', 'minmax(0, 1fr)'));
  });

  // "Combos (combinatorics)" was wider than the column beside the "See also" label.
  it('stacks a glossary entry’s See also label above its links', () => {
    assert.ok(declares(phone(), '.prl-learn-glossary__related', 'grid-template-columns', 'minmax(0, 1fr)'));
  });

  // Beside the radio an answer had 110px, so "immediately" was wider than its column.
  it('puts a quiz answer’s radio above its text', () => {
    assert.ok(declares(phone(), '.prl-learn-quiz__option .prl-choice', 'flex-direction', 'column'));
  });

  // Indented past a radio no longer beside it, the note had about 100px under a 164px answer.
  it('starts a quiz answer’s note where the answer starts', () => {
    assert.ok(
      declares(phone(), '.prl-learn-quiz__option-feedback', 'padding-inline-start', 'var(--prl-space-6)'),
    );
  });

  // Since the display ramp steps down, every lesson heading and glossary term fits unhyphenated.
  it('hyphenates nothing', () => {
    assert.doesNotMatch(learn, /\bhyphens:\s*auto/u);
  });
});

describe('the home hand example at 360px with 200% text', () => {
  const home = style('home.css');

  // `.prl-spot` clips, and five cards were 544px.
  it('lets the cards wrap', () => {
    assert.ok(declares(unconditional(home), '.prl-spot__cards', 'flex-wrap', 'wrap'));
  });

  // Side by side, "25.0%" broke one digit a line.
  it('stacks the two figures', () => {
    const phone = blocks(home, PHONE_AT_200).join('\n');
    assert.ok(declares(phone, '.prl-spot__figures', 'grid-template-columns', 'minmax(0, 1fr)'));
  });
});

describe('/checks at 360px with 200% text', () => {
  const checks = style('checks.css');

  // A command's `width: max-content` floored the implicit track at its whole line: 605px.
  it('gives each row one track that can shrink', () => {
    assert.ok(declares(unconditional(checks), '.prl-checks__row', 'grid-template-columns', 'minmax(0, 1fr)'));
  });

  // Same specificity, so the wide layout's subgrid wins only by coming later.
  it('declares the one track before the wide layout’s subgrid', () => {
    const one = checks.search(/\.prl-checks__row \{[^}]*grid-template-columns: minmax\(0, 1fr\);/u);
    const wide = checks.indexOf('@media (min-width: 56.25em)');
    assert.ok(one >= 0 && wide >= 0, 'both rules are present');
    assert.ok(one < wide, 'the one-track rule comes first');
    const body = blocks(checks, '@media (min-width: 56.25em)').join('\n');
    assert.ok(declares(body, '.prl-checks__row', 'grid-template-columns', 'subgrid'));
  });
});

describe('/play’s equity readout at 360px with 200% text', () => {
  const play = style('play.css');
  const phone = (): string => blocks(play, PHONE_AT_200).join('\n');

  // Its own three tracks outrank the shared readout's narrow rule, so the name had 114px of a 246px row.
  it('stacks the value and detail under the name, as the shared readout does', () => {
    assert.ok(
      declares(phone(), '.prl-play .prl-equity-bar__row', 'grid-template-columns', 'auto minmax(0, 1fr)'),
    );
    for (const selector of ['.prl-play .prl-equity-bar__value', '.prl-play .prl-equity-bar__detail']) {
      assert.ok(declares(phone(), selector, 'grid-column', '2'), selector);
      assert.ok(declares(phone(), selector, 'text-align', 'start'), selector);
    }
  });

  // Centred on a two-line name, the swatch sat between its lines.
  it('puts the swatch back on the name’s first line', () => {
    assert.ok(declares(unconditional(play), '.prl-play .prl-equity-bar__swatch', 'align-self', 'center'));
    assert.ok(declares(phone(), '.prl-play .prl-equity-bar__swatch', 'align-self', 'auto'));
  });

  // Same specificity, so the narrow rule wins only by coming later.
  it('comes after the three tracks it replaces', () => {
    const own = play.search(/\.prl-play \.prl-equity-bar__row \{[^}]*grid-template-columns: auto minmax/u);
    const narrow = play.indexOf(`${PHONE_AT_200} {\n  .prl-play .prl-equity-bar__row`);
    assert.ok(own >= 0 && narrow >= 0, 'both rules are present');
    assert.ok(own < narrow, 'the narrow rule comes later');
  });

  it('keeps three tracks at every other size', () => {
    assert.ok(
      declares(
        unconditional(play),
        '.prl-play .prl-equity-bar__row',
        'grid-template-columns',
        'auto minmax(0, 1fr) auto',
      ),
    );
  });
});

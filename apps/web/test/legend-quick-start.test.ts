/**
 * "Start a match" on `/legends`: the form under the head that put a Play button on the first screen.
 *
 * Measured on the production build at 375x812 with the API up: the first "Play this style" was at
 * y=2,869, three and a half screens down, and at y=1,968 at 1440x900 — below a desktop fold too.
 * The form's Play is at y=741 and y=488. See `LegendQuickStart.tsx`.
 *
 * The form is TSX and `node --test` cannot render it, so what is asserted is what makes it start the
 * RIGHT match, read off the source and the link builder:
 *
 *  - the URL the browser builds from the form's fields is the URL a card's Play link carries, and
 *    `/play` reads the same two names. A field renamed on its own still submits, and `/play` then
 *    deals the six-handed bot table instead — no error, the wrong game;
 *  - the form carries the one-line framing pointer, sits after the head and before the framing
 *    block, and the framing still comes before the picker and the first card;
 *  - no server component calls a plain function exported from a `'use client'` module. That is how
 *    the first version of this change took `/legends` down on the production build.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  DIFFICULTIES,
  legendMatchHref,
  MATCH_DIFFICULTY_PARAM,
  MATCH_PROFILE_PARAM,
  PLAY_PATH,
} from '../src/lib/legend-links.ts';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (...parts: readonly string[]): string => readFileSync(join(SRC, ...parts), 'utf8');

/** Source with comments removed, so a sentence ABOUT a call cannot satisfy or trip a check. */
function code(source: string): string {
  return source
    .replace(/\{\/\*[\s\S]*?\*\/\}/gu, '')
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/^\s*\/\/.*$/gmu, '');
}

describe('"Start a match" starts the match a card would', () => {
  const form = code(read('components', 'LegendQuickStart.tsx'));

  it('submits by GET to the play path', () => {
    assert.match(form, /<form action=\{PLAY_PATH\}[^>]*method="get"/u);
  });

  it('names its fields with the parameters the link builder writes', () => {
    assert.match(form, /<select[^>]*name=\{MATCH_PROFILE_PARAM\}/u);
    assert.match(form, /<ScopedDifficultyInput[^>]*name=\{MATCH_DIFFICULTY_PARAM\}/u);
  });

  it('a submission of those two fields is the URL a card’s Play link carries', () => {
    for (const difficulty of DIFFICULTIES) {
      for (const profileId of ['calling-station', 'high variance/odd&id']) {
        const fields = new URLSearchParams([
          [MATCH_PROFILE_PARAM, profileId],
          [MATCH_DIFFICULTY_PARAM, difficulty],
        ]);
        const submitted = new URL(`${PLAY_PATH}?${fields.toString()}`, 'http://x');
        const linked = new URL(legendMatchHref(profileId, difficulty), 'http://x');
        assert.equal(submitted.pathname, linked.pathname);
        assert.deepEqual([...submitted.searchParams], [...linked.searchParams]);
      }
    }
  });

  it('`/play` reads the match from those same two names', () => {
    const play = code(read('app', 'play', 'page.tsx'));
    assert.match(play, /params\[MATCH_PROFILE_PARAM\]/u);
    assert.match(play, /params\[MATCH_DIFFICULTY_PARAM\]/u);
  });

  it('lists archetype names only, never the attributed name', () => {
    const page = code(read('app', 'legends', 'page.tsx'));
    assert.match(page, /archetypeName: profile\.disclosure\.archetypeName/u);
    assert.doesNotMatch(form, /displayName|attributed/u);
  });

  it('the button is described by the sentence naming the setting it starts', () => {
    assert.match(form, /<button aria-describedby=\{SETTING_ID\}[^>]*type="submit"/u);
    assert.match(form, /<span id=\{SETTING_ID\}>[\s\S]*?<ScopedSettingName\b/u);
  });
});

describe('"Start a match" and the framing', () => {
  const page = code(read('app', 'legends', 'page.tsx'));
  const form = code(read('components', 'LegendQuickStart.tsx'));

  it('carries the one-line pointer and a link to the framing block, as every card does', () => {
    assert.match(form, /\{`\$\{POINTER_TEXT\} `\}\s*<a href=\{framingHref\}>/u);
    assert.match(page, /framingHref=\{`#\$\{FRAMING_ID\}`\}/u);
  });

  it('sits after the head and before the framing; the framing still precedes the picker and every card', () => {
    const at = (needle: string): number => {
      const index = page.indexOf(needle);
      assert.ok(index >= 0, `${needle} is not on /legends`);
      return index;
    };
    const head = at('className="prl-legend-head"');
    const quick = at('<LegendQuickStart');
    const framing = at('id={FRAMING_ID}');
    const picker = at('<DifficultyPicker');
    const card = at('<LegendCard');
    assert.ok(head < quick, 'the form is above the page head');
    assert.ok(quick < framing, 'the form is below the framing block, a screen and a half down');
    assert.ok(framing < picker && framing < card, 'a profile or the picker now comes before the framing');
  });

  it('is inside the difficulty scope, so its hidden field can follow the tick', () => {
    const open = page.indexOf('<LegendDifficultyScope>');
    const close = page.indexOf('</LegendDifficultyScope>');
    const quick = page.indexOf('<LegendQuickStart');
    assert.ok(open >= 0 && open < quick && quick < close, 'the form is outside the scope');
  });
});

describe('the closed select is wide enough for every archetype name', () => {
  const css = read('styles', 'legends.css').replace(/\/\*[\s\S]*?\*\//gu, '');

  /*
    Measured in Chrome with `field-sizing: content`: "High-Variance Tournament Aggressor" needs 322px
    in a closed select. A 15rem basis cut eight names at 430; a padded panel cut two at 375 and four
    at 360. A native select cuts its value at the arrow, and `test:layout` never measures an option.
  */
  it('the field’s basis is the card floor, not the column floor', () => {
    assert.match(css, /\.prl-legend-quick__field \{\s*flex: 1 1 var\(--prl-legend-card-min\);/u);
  });

  it('on a phone the form gives up its panel padding, so the select is the page’s width', () => {
    assert.match(
      css,
      /@media \(width < 600px\) \{\s*\.prl-legend-quick \{\s*padding: var\(--prl-space-0\);\s*border: 0;/u,
    );
  });
});

describe('"Apply setting" keeps the opponent picked in "Start a match"', () => {
  /*
    Devin Review on PR #41: pick Passive Calling Station, follow "Change the setting", tick Expert,
    Apply — the page reloaded with no opponent in the URL, the select came back on the first
    profile, and Play started that one instead.
  */
  const page = code(read('app', 'legends', 'page.tsx'));
  const picker = code(read('components', 'DifficultyPicker.tsx'));
  const scope = code(read('components', 'LegendDifficultyScope.tsx'));
  const form = code(read('components', 'LegendQuickStart.tsx'));

  it('the picker on /legends carries the opponent through its submit', () => {
    assert.match(page, /<DifficultyPicker[^>]*carryOpponent=\{\{ initial: opponent \}\}/u);
    assert.match(picker, /<ScopedOpponentInput initial=\{carryOpponent\.initial\} \/>/u);
    assert.match(scope, /<input name=\{MATCH_PROFILE_PARAM\} type="hidden" value=\{opponent\} \/>/u);
  });

  it('the scope hears the select by the same name the form submits', () => {
    assert.match(scope, /target instanceof HTMLSelectElement && target\.name === MATCH_PROFILE_PARAM/u);
    assert.match(form, /<select[^>]*name=\{MATCH_PROFILE_PARAM\}/u);
  });

  it('the page reads it back into the select, and only when it is a listed profile', () => {
    assert.match(page, /const asked = params\[MATCH_PROFILE_PARAM\];/u);
    assert.match(page, /profiles\.data\.profiles\.find\(/u);
    const quick = page.slice(
      page.indexOf('<LegendQuickStart'),
      page.indexOf('/>', page.indexOf('<LegendQuickStart')),
    );
    assert.match(quick, /\sselected=\{opponent\}/u);
    assert.match(form, /profiles\.find\(\(profile\) => profile\.id === selected\) \?\? profiles\[0\]/u);
  });
});

describe('the match screen prints the chosen profile’s own disclaimers', () => {
  /*
    Devin Review on PR #41: "Start a match" lists every profile by name, so a reader could pick the
    course-derived one and be dealt in without either screen printing its course notice. The cards
    print it above their Play link; the form does not, so the match screen now prints every
    disclaimer but the universal one, which its framing line already restates.
  */
  const play = code(read('app', 'play', 'page.tsx'));

  it('computes every disclaimer but the universal one for the chosen profile', () => {
    assert.match(
      play,
      /specific = disclaimerFraming\(profile\.disclosure\.disclaimers, profiles\.data\.universalDisclaimer\)\.inFull/u,
    );
  });

  it('renders each of them in full in the head, above the table', () => {
    const head = play.indexOf('legend?.specific.map(');
    const table = play.indexOf('<LiveTable');
    assert.ok(head >= 0, 'the specific disclaimers are computed and never rendered');
    assert.ok(head < table, 'the disclaimers come after the table');
  });
});

describe('no server component calls a plain function from a client module', () => {
  /*
    `coachWords` was first exported from `LegendDifficultyScope.tsx` ('use client') and called from
    `DifficultyPicker.tsx`, a server component. The build passed and typecheck passed; the page
    rendered "This screen did not load", because across that boundary a function arrives as a client
    REFERENCE, not as something callable. A component (capitalised, rendered as JSX) is the only
    kind of value that crosses it usefully.
  */
  const COMPONENTS = join(SRC, 'components');
  const files = readdirSync(COMPONENTS).filter((name) => name.endsWith('.tsx'));
  const isClient = (source: string): boolean => /^\s*['"]use client['"];/u.test(source);
  const clientModules = new Set(
    files.filter((name) => isClient(readFileSync(join(COMPONENTS, name), 'utf8'))),
  );

  it('found modules on both sides of the boundary to check', () => {
    assert.ok(files.length > 10, `only ${files.length} component files read`);
    assert.ok(clientModules.has('LegendDifficultyScope.tsx'), 'the scope is no longer a client module');
    assert.ok(clientModules.size < files.length, 'no server components found');
  });

  /** Every `.tsx` under `src/app` and `src/components`, relative to `src`. */
  const importers = ['app', 'components'].flatMap((dir) =>
    readdirSync(join(SRC, dir), { recursive: true, encoding: 'utf8' })
      .filter((name) => name.endsWith('.tsx'))
      .map((name) => join(dir, name)),
  );

  it('every value a server component imports from a client module is a component', () => {
    assert.ok(importers.length > files.length, `only ${importers.length} importing files read`);
    const offenders: string[] = [];
    for (const name of importers) {
      const source = readFileSync(join(SRC, name), 'utf8');
      if (isClient(source)) continue;
      const IMPORT = /import\s+(?!type\b)\{([^}]*)\}\s+from\s+'(?:\.\/|@\/components\/)([^']+\.tsx)'/gu;
      for (const [, names, from] of source.matchAll(IMPORT)) {
        if (from === undefined || !clientModules.has(from)) continue;
        for (const raw of (names ?? '').split(',')) {
          const imported = raw.trim();
          if (imported === '' || imported.startsWith('type ')) continue;
          if (!/^[A-Z]/u.test(imported)) offenders.push(`${name} imports ${imported} from ${from}`);
        }
      }
    }
    assert.deepEqual(offenders, []);
  });
});

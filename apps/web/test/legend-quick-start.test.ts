/**
 * "Start a match" on `/legends` puts a Play button on the first screen (the first card's Play was at
 * y=2,869 at 375x812). `node --test` cannot render the form, so the source is held to start the RIGHT
 * match, because a renamed field still submits and `/play` deals the bot table instead. No server component
 * may call a plain function from a `'use client'` module, which once took `/legends` down.
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

  /* The longest archetype name needs 322px in a closed select; `test:layout` never measures an option. */
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
  /* The form lists every profile, so the match screen prints each disclaimer but the universal one. */
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
  /* Across the client boundary a plain function arrives as a REFERENCE; only components cross usefully. */
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

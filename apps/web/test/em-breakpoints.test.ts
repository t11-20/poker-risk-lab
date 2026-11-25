/**
 * Viewport breakpoints are in em, because a media query's em is the reader's text size: at 200% text a
 * 1440px window takes the 720px layout instead of painting doubled text into the wide one. A px
 * breakpoint, in a stylesheet or in a `matchMedia` string that mirrors one, never moves.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { NAV_SHEET_QUERY } from '../src/lib/nav.ts';
import { TOUR_COMPACT_QUERY } from '../src/lib/tour.ts';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const ROOTS = ['apps/web/src', 'packages/ui/src'];

function filesUnder(dir: string, keep: (name: string) => boolean): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(path, keep);
    return keep(entry.name) ? [path] : [];
  });
}

const PX = /\d(?:\.\d+)?px\b/u;
const WIDTH_FEATURE = /\(([^()]*\bwidth\b[^()]*)\)/gu;

describe('viewport media queries follow the reader’s text size', () => {
  it('writes no @media width condition in px in the app’s or the UI package’s stylesheets', () => {
    const conditions: { file: string; condition: string }[] = [];
    for (const root of ROOTS) {
      const sheets = filesUnder(join(repo, root), (name) => name.endsWith('.css'));
      assert.ok(sheets.length > 0, `read no stylesheet under ${root}`);
      const before = conditions.length;
      for (const sheet of sheets) {
        const css = readFileSync(sheet, 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '');
        for (const prelude of css.matchAll(/@media\b([^{;]*)\{/gu)) {
          for (const feature of (prelude[1] ?? '').matchAll(WIDTH_FEATURE))
            conditions.push({ file: relative(repo, sheet), condition: feature[1] ?? '' });
        }
      }
      assert.ok(conditions.length > before, `read no @media width condition under ${root}`);
    }
    const px = conditions.filter((one) => PX.test(one.condition));
    assert.deepEqual(
      px.map((one) => `${one.file}: (${one.condition})`),
      [],
      `${px.length} of ${conditions.length} @media width conditions are in px; write them in em (px / 16)`,
    );
  });

  it('writes no matchMedia width query in px, so the scripts agree with the stylesheets', () => {
    const queries: { file: string; query: string }[] = [];
    for (const root of ROOTS) {
      const sources = filesUnder(join(repo, root), (name) => /\.tsx?$/u.test(name));
      assert.ok(sources.length > 0, `read no source under ${root}`);
      // The whole file, not only string literals, so `screen and (…)` or a `${n}px` template is still read.
      for (const source of sources) {
        const code = readFileSync(source, 'utf8');
        for (const feature of code.matchAll(WIDTH_FEATURE)) {
          const text = feature[1] ?? '';
          if (/(?:min-|max-)?width\s*(?::|<|>)|[<>]=?\s*width\b/u.test(text))
            queries.push({ file: relative(repo, source), query: `(${text})` });
        }
      }
    }
    const found = queries.map((one) => one.query);
    for (const exported of [NAV_SHEET_QUERY, TOUR_COMPACT_QUERY])
      assert.ok(found.includes(exported), `the scan did not find ${exported}, so it cannot judge it`);
    const px = queries.filter((one) => /px\b/u.test(one.query));
    assert.deepEqual(
      px.map((one) => `${one.file}: ${one.query}`),
      [],
      `${px.length} of ${queries.length} media query strings are in px; write them in em (px / 16)`,
    );
  });
});

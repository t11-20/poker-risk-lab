/**
 * The layout preloads the Archivo file that renders U+0000-00FF. Preloading any other file, or one
 * fetched without CORS, downloads a font the page does not use, which is worse than no preload.
 * The latin file is read from the installed `wdth.css`, so a Fontsource update that renames or
 * re-splits its subsets fails here.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LAYOUT = readFileSync(resolve(HERE, '..', 'src', 'app', 'layout.tsx'), 'utf8');
const require = createRequire(join(HERE, '..', 'package.json'));
const ARCHIVO = dirname(require.resolve('@fontsource-variable/archivo/package.json'));
const STYLESHEET = readFileSync(join(ARCHIVO, 'wdth.css'), 'utf8');

/** The file of the face whose unicode-range starts at U+0000, which is every first paint's text. */
function latinFile(css: string): string {
  const faces = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1] ?? '');
  const latin = faces.filter((face) => /unicode-range:\s*U\+0000-00FF\b/.test(face));
  assert.equal(latin.length, 1, `expected one face covering U+0000-00FF, found ${latin.length}`);
  const url = /url\(\.\/files\/([^)]+\.woff2)\)/.exec(latin[0] ?? '')?.[1];
  assert.ok(url, 'the latin face names no woff2');
  return url;
}

function preloadProblems(layout: string, expected: string): readonly string[] {
  const problems: string[] = [];
  const imported =
    /import (\w+) from '@fontsource-variable\/archivo\/files\/([^']+)' with \{\s*turbopackModuleType: 'asset',?\s*\}/.exec(
      layout,
    );
  if (!imported) return ['no asset import of an Archivo file'];
  if (imported[2] !== expected) problems.push(`preloads ${imported[2]}, but ${expected} renders latin`);
  const link = new RegExp(`<link[^>]*href=\\{${imported[1]}\\}[^>]*/>`).exec(layout)?.[0];
  if (!link) return [...problems, 'the imported URL is not a <link> href'];
  for (const attribute of ['rel="preload"', 'as="font"', 'type="font/woff2"', 'crossOrigin="anonymous"']) {
    if (!link.includes(attribute)) problems.push(`the preload lacks ${attribute}`);
  }
  return problems;
}

describe('the Archivo preload', () => {
  const expected = latinFile(STYLESHEET);

  it('is the latin file the stylesheet uses, fetched as a CORS font', () => {
    assert.deepEqual(preloadProblems(LAYOUT, expected), []);
  });

  it('refuses another subset and a preload without crossOrigin', () => {
    const otherSubset = LAYOUT.replace(expected, expected.replace('latin-', 'latin-ext-'));
    assert.match(preloadProblems(otherSubset, expected).join(), /renders latin/);
    const noCors = LAYOUT.replace(' crossOrigin="anonymous"', '');
    assert.match(preloadProblems(noCors, expected).join(), /crossOrigin/);
  });
});

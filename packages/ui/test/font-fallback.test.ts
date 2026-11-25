/**
 * The metric-matched fallback only prevents the swap reflow if every stack names it right after
 * Archivo and every face carries the numbers. A face that lost its overrides, or a stack that put
 * a system font second, would ship green and reflow every page again when Archivo arrives.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const STYLES = new URL('../src/styles/', import.meta.url);
const read = (name: string): string => readFileSync(new URL(name, STYLES), 'utf8');

/** Archivo's ascent, descent and line gap per 1000 units, from the woff2's hhea and OS/2 tables. */
const ARCHIVO = { ascent: 87.8, descent: 21, lineGap: 0 } as const;

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : cssFiles(path);
    return entry.name.endsWith('.css') ? [path] : [];
  });
}

function faces(css: string): Map<string, string>[] {
  return [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((block) => {
    const descriptors = new Map<string, string>();
    for (const [, name, value] of (block[1] ?? '').matchAll(/([a-z-]+)\s*:\s*([^;]+);/g)) {
      descriptors.set(name ?? '', (value ?? '').replace(/\s+/g, ' ').trim());
    }
    return descriptors;
  });
}

const percent = (value: string | undefined): number => {
  assert.match(value ?? '', /^\d+(\.\d+)?%$/, `expected a percentage, got ${value}`);
  return Number.parseFloat(value ?? '');
};

describe('the Archivo fallback face', () => {
  const fallback = faces(read('font-fallback.css')).filter(
    (face) => face.get('font-family') === '"Archivo Fallback"',
  );

  it('is imported by the one stylesheet the app loads', () => {
    assert.match(read('index.css'), /@import "\.\/font-fallback\.css";/);
  });

  it('declares faces, each with size-adjust and overrides derived from Archivo', () => {
    assert.ok(fallback.length > 0, 'no "Archivo Fallback" faces found');
    for (const face of fallback) {
      const size = percent(face.get('size-adjust')) / 100;
      // The overrides are scaled by size-adjust, so each must be Archivo's metric divided by it.
      for (const [descriptor, metric] of [
        ['ascent-override', ARCHIVO.ascent],
        ['descent-override', ARCHIVO.descent],
        ['line-gap-override', ARCHIVO.lineGap],
      ] as const) {
        const value = percent(face.get(descriptor));
        assert.ok(Math.abs(value - metric / size) < 0.01, `${descriptor} ${value}% at size-adjust ${size}`);
      }
      assert.match(
        face.get('src') ?? '',
        /^local\("[^"]+"\)(, local\("[^"]+"\))*$/,
        'src must be local() only',
      );
      assert.ok(face.get('unicode-range'), 'a face without unicode-range would catch glyphs Archivo lacks');
    }
  });

  it('comes right after Archivo wherever a stylesheet names Archivo', () => {
    const files = [...cssFiles(join(REPO, 'packages/ui/src')), ...cssFiles(join(REPO, 'apps/web/src'))];
    let stacks = 0;
    for (const file of files) {
      const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const match of css.matchAll(/"Archivo Variable"\s*,\s*("[^"]*"|[^,;]+)/g)) {
        stacks += 1;
        assert.equal(match[1], '"Archivo Fallback"', `${relative(REPO, file)} puts ${match[1]} second`);
      }
    }
    assert.ok(stacks > 0, 'no stack names "Archivo Variable"');
  });

  it('is what both family tokens resolve to', () => {
    const tokens = read('tokens.css');
    assert.match(tokens, /--prl-font-sans:\s*"Archivo Variable", "Archivo Fallback",/);
    assert.match(tokens, /--prl-font-display: var\(--prl-font-sans\);/);
  });
});

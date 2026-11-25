/**
 * The metric-matched fallback only prevents the swap reflow if every stack names it right after
 * Archivo and every face carries the numbers. A face that lost its overrides, or a stack that put
 * a system font second, would ship green and reflow every page again when Archivo arrives.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
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

/** `100 449` or `62% 99%`, both ends inclusive. */
function span(value: string | undefined, unit: '' | '%'): readonly [number, number] {
  const match = new RegExp(`^(\\d+)${unit} (\\d+)${unit}$`).exec(value ?? '');
  assert.ok(match, `expected a range like "1${unit} 2${unit}", got ${value}`);
  return [Number(match[1]), Number(match[2])];
}

function codePoints(range: string | undefined): Set<number> {
  const points = new Set<number>();
  for (const part of (range ?? '').split(',')) {
    const match = /^U\+([0-9A-F]+)(?:-([0-9A-F]+))?$/i.exec(part.trim());
    assert.ok(match, `not a unicode-range part: "${part}"`);
    const from = Number.parseInt(match[1] ?? '', 16);
    const to = match[2] === undefined ? from : Number.parseInt(match[2], 16);
    for (let point = from; point <= to; point += 1) points.add(point);
  }
  return points;
}

const DIGITS = 'U+0030-0039';
const WEIGHTS = [100, 900] as const;
const STRETCH_BANDS = ['62-99', '100-125'];

/** The latin subset the app loads, so the fallback answers for exactly the glyphs Archivo will. */
function archivoLatinRange(): Set<number> {
  const require = createRequire(join(REPO, 'apps/web/package.json'));
  const css = readFileSync(require.resolve('@fontsource-variable/archivo/wdth.css'), 'utf8');
  const block = /\/\* archivo-latin-wdth-normal \*\/\s*@font-face\s*\{([^}]*)\}/.exec(css);
  assert.ok(block, 'no archivo-latin-wdth-normal face in wdth.css');
  const range = /unicode-range:\s*([^;]+);/.exec(block[1] ?? '');
  assert.ok(range, 'the latin face has no unicode-range');
  return codePoints(range[1]);
}

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
      const [low, high] = span(face.get('font-weight'), '');
      assert.ok(low >= WEIGHTS[0] && high <= WEIGHTS[1] && low <= high, `font-weight ${low} ${high}`);
      assert.ok(STRETCH_BANDS.includes(span(face.get('font-stretch'), '%').join('-')), 'font-stretch');
    }
  });

  it('tiles 100 to 900 in each width band with no gap or overlap, one text and one digit face per bucket', () => {
    for (const digits of [false, true]) {
      const kind = digits ? 'digit' : 'text';
      const bands = new Map<string, (readonly [number, number])[]>();
      for (const face of fallback.filter((f) => (f.get('unicode-range') === DIGITS) === digits)) {
        const band = span(face.get('font-stretch'), '%').join('-');
        bands.set(band, [...(bands.get(band) ?? []), span(face.get('font-weight'), '')]);
      }
      assert.deepEqual([...bands.keys()].sort(), [...STRETCH_BANDS].sort(), `${kind} width bands`);
      for (const [band, weights] of bands) {
        const sorted = [...weights].sort((a, b) => a[0] - b[0]);
        assert.equal(sorted[0]?.[0], WEIGHTS[0], `${kind} ${band}% starts at ${sorted[0]?.[0]}`);
        assert.equal(sorted.at(-1)?.[1], WEIGHTS[1], `${kind} ${band}% ends at ${sorted.at(-1)?.[1]}`);
        sorted.slice(1).forEach(([low], at) => {
          const before = sorted[at]?.[1];
          assert.equal(low, (before ?? 0) + 1, `${kind} ${band}%: ${before} is followed by ${low}`);
        });
      }
    }
    const buckets = (digits: boolean) =>
      fallback
        .filter((f) => (f.get('unicode-range') === DIGITS) === digits)
        .map((f) => `${f.get('font-weight')} / ${f.get('font-stretch')}`)
        .sort();
    assert.deepEqual(buckets(true), buckets(false), 'every text bucket has its digit face');
  });

  it("splits Archivo's latin range between the text and digit faces, nothing more and nothing less", () => {
    const latin = archivoLatinRange();
    assert.ok(latin.size > 256, `read ${latin.size} code points from wdth.css`);
    const digits = codePoints(DIGITS);
    for (const face of fallback) {
      const points = codePoints(face.get('unicode-range'));
      if (face.get('unicode-range') === DIGITS) continue;
      const shared = [...points].filter((point) => digits.has(point));
      assert.deepEqual(shared, [], 'a text face also claims a digit');
      const union = new Set([...points, ...digits]);
      const missing = [...latin].filter((point) => !union.has(point)).map((p) => p.toString(16));
      const extra = [...union].filter((point) => !latin.has(point)).map((p) => p.toString(16));
      assert.deepEqual({ missing, extra }, { missing: [], extra: [] }, face.get('font-weight'));
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

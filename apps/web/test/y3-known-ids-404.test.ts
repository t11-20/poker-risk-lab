/**
 * Unknown lesson / scenario / profile ids must 404 at the router, not via `notFound()`.
 *
 * Next 16's in-page `notFound()` returns empty HTML (`__next_error__`, no lang/main/h1).
 * `generateStaticParams` + `dynamicParams = false` sends unknown ids through `app/not-found.tsx`.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'app');
const read = (...parts: readonly string[]): string => readFileSync(join(APP, ...parts), 'utf8');

describe('known-id routes refuse unknown params at the router', () => {
  it('lessons enumerate ids and set dynamicParams false', () => {
    const page = read('learn', '[lessonId]', 'page.tsx');
    assert.match(page, /export function generateStaticParams/);
    assert.match(page, /dynamicParams = false/);
  });

  it('scenarios enumerate ids and set dynamicParams false', () => {
    const page = read('lab', '[scenarioId]', 'page.tsx');
    assert.match(page, /export function generateStaticParams/);
    assert.match(page, /dynamicParams = false/);
  });

  it('legend profiles enumerate ids and set dynamicParams false', () => {
    const page = read('legends', '[profileId]', 'page.tsx');
    assert.match(page, /export function generateStaticParams/);
    assert.match(page, /dynamicParams = false/);
  });

  it('hand review, lessons, scenarios and profiles render the 404 body instead of calling notFound()', () => {
    for (const parts of [
      ['review', '[handId]', 'page.tsx'],
      ['learn', '[lessonId]', 'page.tsx'],
      ['lab', '[scenarioId]', 'page.tsx'],
      ['legends', '[profileId]', 'page.tsx'],
    ] as const) {
      const page = read(...parts);
      assert.match(page, /NotFoundBody/, parts.join('/'));
      assert.doesNotMatch(page, /from 'next\/navigation'/, parts.join('/'));
    }
  });
});

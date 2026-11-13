/**
 * No route may sit under a Suspense boundary it did not choose. A `loading.tsx` is a boundary, and
 * Next sends the headers when its fallback renders, so `notFound()` answered 200 and every route was
 * a permanent skeleton without JavaScript (the swap is React's inline `$RC` script). A `<Suspense>`
 * inside a page, below its existence check, is still allowed. Only route-level convention files are
 * refused, and every route here can 404.
 */

import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'app');

function walk(directory: string): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...walk(full));
    else found.push(relative(APP_DIR, full));
  }
  return found;
}

describe('the app shell does not stream before it has decided the status', () => {
  it('has no route-level loading file anywhere', () => {
    const offenders = walk(APP_DIR).filter((file) => /(^|\/)loading\.(tsx|ts|jsx|js)$/.test(file));
    assert.deepEqual(
      offenders,
      [],
      'a loading.tsx flushes the response headers before the page runs, which makes notFound() ' +
        'answer 200 and leaves the route blank without JavaScript. Put a <Suspense> inside the page, ' +
        'below its existence check, instead. See src/app/not-found.tsx.',
    );
  });

  it('has no template file, which is a boundary by another name', () => {
    const offenders = walk(APP_DIR).filter((file) => /(^|\/)template\.(tsx|ts|jsx|js)$/.test(file));
    assert.deepEqual(offenders, [], 'a template.tsx remounts on navigation and streams the same way');
  });

  it('still has the not-found page the boundary falls back to', () => {
    assert.ok(walk(APP_DIR).includes('not-found.tsx'));
  });
});

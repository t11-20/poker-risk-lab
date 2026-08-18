/**
 * No route may sit under a Suspense boundary it did not choose, because two defects follow from it.
 *
 * ## What a `loading.tsx` costs here
 *
 * A `loading.tsx` is a Suspense boundary, and Next sends the response headers the moment a
 * boundary's fallback renders. Two consequences, both of which shipped:
 *
 *  1. **`notFound()` could not set a status.** A missing lesson, scenario, profile or hand answered
 *     HTTP 200 with "Page not found" in the body — wrong for a crawler and wrong for anything that
 *     reads a status code. The status was already on the wire before the page had decided anything,
 *     and no amount of care in a page could change that.
 *
 *  2. **Every route was blank without JavaScript.** A Suspense fallback is swapped for the real
 *     content by React's inline `$RC` script. With scripting unavailable that swap never runs, so
 *     the app's lessons, glossary and scenario write-ups — ordinary prose with no reason to need
 *     scripting at all — showed a skeleton permanently, indistinguishable from a hung page.
 *
 * Both were fixed by deleting `src/app/loading.tsx` and `src/app/review/[handId]/loading.tsx`. That
 * is a deletion, which is the kind of fix that comes back: the files are pleasant, the skeletons
 * were carefully made, and nothing in the tree explains why they are absent. Hence this test.
 *
 * ## What is still allowed
 *
 * A `<Suspense>` written INSIDE a page, below its existence check, around the part that is actually
 * slow. That streams the slow part without putting the 404 decision behind the headers, and it is
 * the arrangement the Next documentation recommends. Only the route-level convention files are
 * refused here, and only at or above a route that can 404 — which, in this app, is all of them.
 */

import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'app');

/** Every file under `src/app`, as paths relative to it. */
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

/**
 * Every endpoint this client is allowed to address must actually be addressed by something.
 *
 * ## The gate this replaces, and why the existing one could not fail
 *
 * `apps/api/test/web-api-paths.test.ts` drives every entry of `API_PATHS` against a real
 * `buildApp()` and asserts each one resolves to a registered route. That is a real guarantee and it
 * is the wrong direction to catch what actually shipped: it proves the SERVER has a route for every
 * path the contract publishes, and says nothing about whether any screen ever calls it.
 *
 * The release audit found that `quizAttempt` — the endpoint that grades a quiz answer and writes
 * the row `GET /me/progress` counts — had **zero call sites anywhere in `apps/web/src`**. It passed
 * the server-side test on every run, because the route existed. A learner could work through every
 * quiz in the product and nothing would be recorded, and no gate anywhere could have said so.
 *
 * So this asserts the other direction: a published path with no caller is a feature with no client.
 * That is not automatically a defect — a path could legitimately be server-to-server — but it is
 * always a decision, and the way to record the decision is to add the exception here with its
 * reason rather than to let the silence stand.
 *
 * ## And the paths that are NOT published
 *
 * Three routes this client needs are absent from `API_PATHS` and are built in
 * `src/lib/unpublished-api-paths.ts` instead, because `packages/contracts` could not be edited at
 * the time. That file is a temporary arrangement, so the second half of this test pins its exact
 * contents: a fourth entry appearing there is a thing somebody has to justify in a diff rather than
 * a quiet return to building paths at call sites, which is the habit that once made every path in
 * this client omit `/api/v1`.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { API_PATHS, API_PREFIX } from '@prl/contracts';
import { UNPUBLISHED_API_PATHS } from '../src/lib/unpublished-api-paths.ts';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** Every TypeScript source under `src`, as `{ path, text }`. */
function sources(directory: string): readonly { readonly path: string; readonly text: string }[] {
  const found: { path: string; text: string }[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...sources(full));
    else if (extname(entry.name) === '.ts' || extname(entry.name) === '.tsx') {
      found.push({ path: relative(SRC, full), text: readFileSync(full, 'utf8') });
    }
  }
  return found;
}

const FILES = sources(SRC);

/** Files that mention `TABLE.name(` — the call, not the declaration. */
function callersOf(table: string, name: string): readonly string[] {
  const needle = `${table}.${name}(`;
  return FILES.filter((file) => file.text.includes(needle)).map((file) => file.path);
}

describe('every path the contract publishes is reached from a screen', () => {
  for (const name of Object.keys(API_PATHS)) {
    it(`API_PATHS.${name} has at least one call site in apps/web/src`, () => {
      const callers = callersOf('API_PATHS', name);
      assert.ok(
        callers.length > 0,
        `API_PATHS.${name} is published by @prl/contracts and called by nothing in apps/web/src, so ` +
          'whatever it serves is unreachable. That is exactly how quiz attempts were never submitted ' +
          'for the whole of the build-out while every server-side test passed. Either give it a call ' +
          'site, or record here why this deployment deliberately has no client for it.',
      );
    });
  }
});

describe('the paths @prl/contracts has not published yet', () => {
  it('is exactly the three routes named in the module header', () => {
    assert.deepEqual(
      Object.keys(UNPUBLISHED_API_PATHS).sort(),
      ['progress', 'roomJoin', 'unitsReset'],
      'src/lib/unpublished-api-paths.ts is a holding pen for routes the contract package does not ' +
        'publish, and it exists only because packages/contracts could not be edited when these three ' +
        'features were built. Adding a fourth entry means building a second contract surface — read ' +
        'that file’s header, which carries the three-step recipe for moving these into API_PATHS and ' +
        'deleting the module.',
    );
  });

  for (const name of Object.keys(UNPUBLISHED_API_PATHS)) {
    it(`${name} is under the API prefix and has a call site`, () => {
      const build = UNPUBLISHED_API_PATHS[name as keyof typeof UNPUBLISHED_API_PATHS];
      assert.ok(
        build().startsWith(`${API_PREFIX}/`),
        `${name} must be built from API_PREFIX; a path written without it is how every request in ` +
          'this client once missed the version segment and fell back to a fixture in silence.',
      );
      assert.ok(
        callersOf('UNPUBLISHED_API_PATHS', name).length > 0,
        `${name} is declared and called by nothing, which is the state this whole file exists to fix.`,
      );
    });
  }

  it('never interpolates an identifier, so no invite code can reach a URL', () => {
    for (const [name, build] of Object.entries(UNPUBLISHED_API_PATHS)) {
      assert.equal(
        build.length,
        0,
        `${name} takes an argument. An invite code is the only thing protecting a private table and ` +
          'it must travel in a request body: a URL is written to the access log of every proxy it ' +
          'passes and is sent onwards in Referer.',
      );
    }
  });
});

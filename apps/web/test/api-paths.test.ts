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
 * ## The three paths that were once built outside the contract
 *
 * `roomJoin`, `progress` and `unitsReset` were briefly built in a local holding pen, because the
 * contract package could not be edited while those features were written. They are published now,
 * and the holding pen is gone. What survives from it is the property that mattered: **none of the
 * three may take an argument**, because the only one that would ever carry an identifier is the
 * invite code, and an invite code is the sole thing protecting a private table. A URL is written to
 * the access log of every proxy it passes and is sent onwards in `Referer`; the code has to travel
 * in a request body. That is asserted below against the published builders.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { API_PATHS, API_PREFIX } from '@prl/contracts';

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

describe('the three paths that carry an invite code, a progress read and a reset', () => {
  const BODY_ONLY: readonly (keyof typeof API_PATHS)[] = ['roomJoin', 'progress', 'unitsReset'];

  for (const name of BODY_ONLY) {
    it(`${name} is under the API prefix`, () => {
      const build = API_PATHS[name] as () => string;
      assert.ok(
        build().startsWith(`${API_PREFIX}/`),
        `${name} must be built from API_PREFIX; a path written without it is how every request in ` +
          'this client once missed the version segment and fell back to a fixture in silence.',
      );
    });
  }

  it('never interpolates an identifier, so no invite code can reach a URL', () => {
    for (const name of BODY_ONLY) {
      assert.equal(
        (API_PATHS[name] as (...args: unknown[]) => string).length,
        0,
        `${name} takes an argument. An invite code is the only thing protecting a private table and ` +
          'it must travel in a request body: a URL is written to the access log of every proxy it ' +
          'passes and is sent onwards in Referer.',
      );
    }
  });
});

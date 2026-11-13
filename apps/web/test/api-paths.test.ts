/**
 * Every endpoint this client may address must be addressed by something. The API-side test proves a
 * route exists for every published path, not that a screen calls it, and `quizAttempt` once shipped
 * with zero call sites. A path with no caller needs a recorded exception here.
 * `roomJoin`, `progress` and `unitsReset` take no argument, because an invite code must travel in a
 * body. A URL lands in proxy access logs and in `Referer`.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { API_PATHS, API_PREFIX } from '@prl/contracts';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');

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

/** Files that mention `TABLE.name(`, the call rather than the declaration. */
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

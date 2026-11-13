/**
 * `/checks` names a test or a document behind every claim, and each one has to exist.
 *
 * The list moved here from the home page in the 4.0 re-identity. Its whole argument is "a claim
 * nobody can check is an assertion", so a command that was renamed or a document that was moved
 * would turn the page into exactly that, silently: it is prose, and nothing else reads it.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PROOF } from '../src/lib/checks.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const scriptsOf = (dir: string): Record<string, string> =>
  (JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8')) as { scripts?: Record<string, string> })
    .scripts ?? {};

/** `pnpm run x` against the root; `pnpm --filter @prl/y test` against that package. */
function missing(check: string): string | null {
  const run = /^pnpm run (\S+)$/u.exec(check);
  if (run?.[1] !== undefined) return run[1] in scriptsOf('.') ? null : `no root script "${run[1]}"`;
  const filter = /^pnpm --filter @prl\/(\S+) (\S+)$/u.exec(check);
  if (filter?.[1] !== undefined && filter[2] !== undefined) {
    const dir = ['packages', 'apps']
      .map((base) => join(base, filter[1] as string))
      .find((d) => existsSync(join(ROOT, d)));
    if (dir === undefined) return `no package @prl/${filter[1]}`;
    return filter[2] in scriptsOf(dir) ? null : `@prl/${filter[1]} has no "${filter[2]}" script`;
  }
  if (/^[\w./-]+\.md$/u.test(check)) return existsSync(join(ROOT, check)) ? null : `no file ${check}`;
  return `"${check}" is neither a command this test can resolve nor a document path`;
}

describe('/checks', () => {
  it('lists claims at all — a sweep of nothing is not a pass', () => {
    assert.ok(PROOF.length >= 4, `expected the four claims, found ${PROOF.length}`);
  });

  it('names only commands and documents that exist', () => {
    const broken = PROOF.flatMap((entry) => {
      const why = missing(entry.check);
      return why === null ? [] : [`${entry.claim}: ${why}`];
    });
    assert.deepEqual(broken, []);
  });
});

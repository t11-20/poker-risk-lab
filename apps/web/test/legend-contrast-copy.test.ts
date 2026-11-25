/**
 * A profile page lists a contrast against every other profile, each with its biggest trait gaps. The
 * sentence above the list said "the three most different profiles", while the API sent all eleven.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path: string): string => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
const WORDS: Readonly<Record<string, string>> = { '2': 'two', '3': 'three', '4': 'four', '5': 'five' };

test('the contrast sentence counts what the API sends', () => {
  const count = /export function biggestTraitDifferences\([^)]*count = (\d+)/u.exec(
    read('packages/poker-ai/src/traits.ts'),
  )?.[1];
  assert.ok(count !== undefined && WORDS[count] !== undefined, 'no default count on biggestTraitDifferences');
  const route = read('apps/api/src/routes/rooms.ts');
  assert.match(
    route,
    /contrasts: PROFILES\.filter\(\(other\) => other\.naming\.id !== profile\.naming\.id\)\.map\(/u,
  );
  const page = read('apps/web/src/app/legends/[profileId]/page.tsx').replace(/\s+/gu, ' ');
  assert.match(
    page,
    new RegExp(`The ${WORDS[count]} axes with the largest gap against each of the other profiles\\.`, 'u'),
  );
});

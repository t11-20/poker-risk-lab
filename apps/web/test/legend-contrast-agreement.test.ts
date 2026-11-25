/**
 * A profile page says it contrasts "the three most different profiles". The API sent all eleven while
 * the bundled copy sent three with four axes each, so the page meant different things online and off.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { contrastsFor, LEGEND_PROFILE_FIXTURES } from '../src/fixtures/legends.ts';

const read = (path: string): string => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');

test('the bundled copy contrasts as many profiles, on as many axes, as the API sends', () => {
  const profiles = Number(
    /export const CONTRAST_PROFILES = (\d+);/u.exec(read('apps/api/src/routes/rooms.ts'))?.[1],
  );
  const axes = Number(
    /export function biggestTraitDifferences\([^)]*count = (\d+)/u.exec(
      read('packages/poker-ai/src/traits.ts'),
    )?.[1],
  );
  assert.ok(profiles > 0 && axes > 0, 'could not read the API counts');
  assert.ok(LEGEND_PROFILE_FIXTURES.length > profiles, 'too few bundled profiles to choose from');
  for (const profile of LEGEND_PROFILE_FIXTURES) {
    const contrasts = contrastsFor(profile.id);
    assert.equal(contrasts.length, profiles, profile.id);
    for (const contrast of contrasts) assert.equal(contrast.differences.length, axes, profile.id);
  }
  const page = read('apps/web/src/app/legends/[profileId]/page.tsx').replace(/\s+/gu, ' ');
  assert.match(page, /against each of the three most different profiles/u);
  assert.equal(profiles, 3, 'the page says three');
});

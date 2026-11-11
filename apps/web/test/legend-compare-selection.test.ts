/**
 * `/legends/compare` turns whatever the URL names into a request the API will accept.
 *
 * ## The defect
 *
 * The compare form offers twelve checkboxes and said only "Pick at least two". The API's
 * `PROFILE_IDS_SCHEMA` allows five. Measured against the running build with curl: two to five
 * profiles answered 200; six and seven answered **500** — the schema refused the request,
 * `loadProfileComparison` rethrew the `invalid_request`, and a reader who ticked every box got
 * "This screen did not load", with a "Try again" that failed the same way. Reproduced through the
 * real form at 360px by ticking all twelve.
 *
 * Measured at the same time: `?profiles=nope,calling-station` answered 200 with the bundled
 * four-column sample under "The comparison service is not reachable" — an unknown id refused by a
 * server that was up, reported as an outage, for a comparison the reader never asked for.
 *
 * `parseProfileIds` passed every id through, so both failures were decided before the page could
 * do anything about them. `parseCompareSelection` is the function the page now reads, and every id
 * it keeps out of the request comes back beside the ones it lets in so the page can name it.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  MAX_COMPARE_PROFILES,
  MIN_COMPARE_PROFILES,
  parseCompareSelection,
  parseProfileIds,
} from '../src/lib/legend-links.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');

/** The twelve ids the form offers, in the order the API lists them. */
const KNOWN = [
  'vocal-aggressor',
  'reading-pressure-specialist',
  'patient-technician',
  'disciplined-specialist',
  'calling-station',
  'fundamentals-coach',
  'adaptive-exploiter',
  'old-school-pressure',
  'mixed-game-generalist',
  'volume-grinder',
  'foundational-reader',
  'range-narrator',
] as const;

describe('parseCompareSelection', () => {
  it('sends at most five styles, keeping the first five in the order the reader named them', () => {
    const all = parseCompareSelection(KNOWN.join(','), KNOWN);
    assert.equal(all.ids.length, MAX_COMPARE_PROFILES);
    assert.deepEqual(all.ids, KNOWN.slice(0, 5));
    assert.deepEqual(all.dropped, KNOWN.slice(5));
    assert.deepEqual(all.unknown, []);
    assert.equal(all.tooFew, false);

    // Six, as the form submits them: one `profiles` value per ticked box.
    const six = parseCompareSelection([...KNOWN.slice(0, 6)], KNOWN);
    assert.deepEqual(six.ids, KNOWN.slice(0, 5));
    assert.deepEqual(six.dropped, [KNOWN[5]]);
  });

  it('two to five pass through unchanged and with nothing to report', () => {
    for (let count = MIN_COMPARE_PROFILES; count <= MAX_COMPARE_PROFILES; count += 1) {
      const picked = KNOWN.slice(0, count);
      const selection = parseCompareSelection(picked.join(','), KNOWN);
      assert.deepEqual(selection.ids, picked, `${String(count)} styles`);
      assert.deepEqual(selection.dropped, []);
      assert.deepEqual(selection.unknown, []);
      assert.equal(selection.tooFew, false);
    }
  });

  it('flags a single style as too few rather than refusing it', () => {
    const one = parseCompareSelection('calling-station', KNOWN);
    assert.deepEqual(one.ids, ['calling-station']);
    assert.equal(one.tooFew, true);
  });

  it('keeps unknown ids out of the request and names them, before counting to five', () => {
    const selection = parseCompareSelection(['nope', ...KNOWN.slice(0, 5), 'also-nope'], KNOWN);
    assert.deepEqual(selection.unknown, ['nope', 'also-nope']);
    // The unknown ones did not use up any of the five places.
    assert.deepEqual(selection.ids, KNOWN.slice(0, 5));
    assert.deepEqual(selection.dropped, []);

    const onlyUnknown = parseCompareSelection('nope', KNOWN);
    assert.deepEqual(onlyUnknown.ids, [], 'empty ids is the page default, not a request for nothing');
    assert.deepEqual(onlyUnknown.unknown, ['nope']);
    assert.equal(onlyUnknown.tooFew, false);
  });

  it('an absent parameter is the default comparison, with nothing to report', () => {
    const none = parseCompareSelection(undefined, KNOWN);
    assert.deepEqual(none, { ids: [], unknown: [], dropped: [], tooFew: false });
  });

  it('every id that reaches the request is one the API listed, and there are never more than five', () => {
    // A sweep of nothing is not a pass: the cases below must be non-empty for this to mean anything.
    const cases: (string | string[])[] = [
      KNOWN.join(','),
      [...KNOWN].reverse(),
      'a,b,c',
      `${KNOWN[0]},${KNOWN[0]}`,
    ];
    assert.ok(cases.length > 0);
    for (const raw of cases) {
      const selection = parseCompareSelection(raw, KNOWN);
      assert.ok(selection.ids.length <= MAX_COMPARE_PROFILES);
      for (const id of selection.ids) assert.ok((KNOWN as readonly string[]).includes(id), id);
    }
  });

  it('parseProfileIds still de-duplicates and splits, as the compare form and hidden fields rely on', () => {
    assert.deepEqual(parseProfileIds(['a,b', 'b', ' c ']), ['a', 'b', 'c']);
  });
});

describe('the cap is the API’s own number', () => {
  it('MAX_COMPARE_PROFILES equals PROFILE_IDS_SCHEMA.maxItems in the API', () => {
    const routes = readFileSync(join(REPO, 'apps', 'api', 'src', 'routes', 'rooms.ts'), 'utf8');
    const schema = /const PROFILE_IDS_SCHEMA = \{([\s\S]*?)\} as const;/u.exec(routes);
    assert.ok(schema !== null, 'PROFILE_IDS_SCHEMA was not found in apps/api/src/routes/rooms.ts');
    const max = /maxItems:\s*(\d+)/u.exec(schema[1] ?? '');
    const min = /minItems:\s*(\d+)/u.exec(schema[1] ?? '');
    assert.ok(max !== null && min !== null, 'PROFILE_IDS_SCHEMA no longer states minItems and maxItems');
    assert.equal(Number(max[1]), MAX_COMPARE_PROFILES);
    assert.ok(Number(min[1]) <= MIN_COMPARE_PROFILES);
  });

  it('the compare page reads the selection, not the raw ids, and the form says two to five', () => {
    const page = readFileSync(join(HERE, '..', 'src', 'app', 'legends', 'compare', 'page.tsx'), 'utf8');
    assert.match(page, /parseCompareSelection\(/u);
    assert.doesNotMatch(page, /parseProfileIds\(/u);
    assert.match(page, /Pick two to five/u);
    assert.doesNotMatch(page, /Pick at least two/u);
  });
});

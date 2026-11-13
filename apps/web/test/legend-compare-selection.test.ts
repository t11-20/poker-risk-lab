/**
 * `/legends/compare` turns whatever the URL names into a request the API accepts: at most five
 * (`PROFILE_IDS_SCHEMA`), no unknown ids, and every id left out is returned so the page can name it.
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
  selectionNotices,
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

/**
 * Over the bundled sample the page still names what it threw away, because those are facts about the
 * request. Sentences about which columns are shown are true only when live.
 */
describe('selectionNotices', () => {
  const nameOf = (id: string): string => `Name of ${id}`;
  const seven = parseCompareSelection(['nope', ...KNOWN.slice(0, 7), 'also-nope'], KNOWN);
  const onlyUnknown = parseCompareSelection('nope', KNOWN);
  const one = parseCompareSelection('calling-station', KNOWN);
  const DESCRIBES_COLUMNS = /showing|column is below|default three/u;

  it('in fallback, still names every unknown id and every style past the fifth', () => {
    const notices = selectionNotices(seven, seven.ids, nameOf, false).join(' ');
    assert.ok(notices.length > 0, 'the discarded choices vanished');
    for (const id of ['nope', 'also-nope']) assert.match(notices, new RegExp(`"${id}"`, 'u'));
    for (const id of KNOWN.slice(5, 7)) assert.ok(notices.includes(nameOf(id)), id);
    assert.ok(notices.includes('7 were picked'), notices);
  });

  it('in fallback, says nothing about which columns are on the page', () => {
    const cases = [seven, onlyUnknown, one];
    for (const selection of cases) {
      for (const notice of selectionNotices(selection, selection.ids, nameOf, false)) {
        assert.doesNotMatch(notice, DESCRIBES_COLUMNS);
      }
    }
    assert.deepEqual(selectionNotices(one, one.ids, nameOf, false), []);
    assert.equal(selectionNotices(onlyUnknown, [], nameOf, false).length, 1);
  });

  it('over live columns, says what is shown as before', () => {
    const live = selectionNotices(seven, seven.ids, nameOf, true).join(' ');
    assert.match(live, /It is showing the first 5 in the order they were named/u);
    assert.match(
      selectionNotices(onlyUnknown, [], nameOf, true).join(' '),
      /showing its default three styles instead/u,
    );
    assert.match(selectionNotices(one, one.ids, nameOf, true).join(' '), /Its column is below/u);
  });

  it('a selection with nothing left out has nothing to say in either mode', () => {
    const fine = parseCompareSelection(KNOWN.slice(0, 3).join(','), KNOWN);
    assert.deepEqual(selectionNotices(fine, fine.ids, nameOf, true), []);
    assert.deepEqual(selectionNotices(fine, fine.ids, nameOf, false), []);
  });

  it('the page asks for the notices in both modes and says which one it is in', () => {
    const page = readFileSync(join(HERE, '..', 'src', 'app', 'legends', 'compare', 'page.tsx'), 'utf8');
    assert.match(page, /selectionNotices\(selection, profileIds, nameOf, comparison\.source === 'api'\)/u);
    assert.doesNotMatch(page, /\? selectionNotices\([^)]*\) : \[\]/u);
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

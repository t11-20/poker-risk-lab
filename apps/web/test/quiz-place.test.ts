/**
 * A quiz keeps the learner's place in `?question=N`, so a reload reopens it. The parse is strict,
 * because a lenient one (`Number`, `parseInt`) opens a question nobody named. The second half reads
 * `QuizRunner.tsx` (ADR 0008: no renderer): the place is restored without the focus hook firing.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { formatQuizPlace, parseQuizPlace, searchWithQuizPlace } from '../src/lib/quiz-place.ts';

const TOTAL = 4;

describe('a quiz place read from the query', () => {
  it('opens the question it names, 1-based, and the review', () => {
    assert.equal(parseQuizPlace('?question=1', TOTAL), 0);
    assert.equal(parseQuizPlace('?question=2', TOTAL), 1);
    assert.equal(parseQuizPlace('?question=4', TOTAL), 3);
    assert.equal(parseQuizPlace('?question=review', TOTAL), TOTAL);
    assert.equal(parseQuizPlace('question=3', TOTAL), 2, 'with or without the leading ?');
    assert.equal(parseQuizPlace('?from=x&question=3&b', TOTAL), 2);
    assert.equal(parseQuizPlace('?qu%65stion=3', TOTAL), 2, 'the key is decoded as a browser would');
  });

  it('opens the first question for anything else', () => {
    const invalid = [
      '',
      '?',
      '?question',
      '?question=',
      '?question=0',
      '?question=5',
      '?question=99999999999999999999',
      '?question=-1',
      '?question=+2',
      '?question=02',
      '?question=2.0',
      '?question=1e0',
      '?question=%202',
      '?question=2%20',
      '?question=2abc',
      '?question=two',
      '?question=Review',
      '?question=%E0%A4%A',
      '?Question=2',
      '?questions=2',
    ];
    for (const search of invalid) assert.equal(parseQuizPlace(search, TOTAL), 0, search);
  });

  it('reads only the first of a repeated key', () => {
    assert.equal(parseQuizPlace('?question=3&question=2', TOTAL), 2);
    assert.equal(parseQuizPlace('?question=x&question=2', TOTAL), 0);
  });

  it('has nothing to open in a quiz with no questions but its review', () => {
    assert.equal(parseQuizPlace('?question=1', 0), 0);
    assert.equal(parseQuizPlace('?question=review', 0), 0);
  });
});

describe('a quiz place written to the query', () => {
  it('gives the first question no parameter, the rest their drawn number, the end `review`', () => {
    assert.equal(formatQuizPlace(0, TOTAL), null);
    assert.equal(formatQuizPlace(1, TOTAL), '2');
    assert.equal(formatQuizPlace(3, TOTAL), '4');
    assert.equal(formatQuizPlace(TOTAL, TOTAL), 'review');
    assert.equal(formatQuizPlace(0, 0), null);
  });

  it('round-trips every step', () => {
    for (let step = 0; step <= TOTAL; step += 1) {
      assert.equal(parseQuizPlace(searchWithQuizPlace('', step, TOTAL), TOTAL), step, String(step));
    }
  });

  it('sets, replaces and clears the parameter', () => {
    assert.equal(searchWithQuizPlace('', 1, TOTAL), '?question=2');
    assert.equal(searchWithQuizPlace('?question=2', 2, TOTAL), '?question=3');
    assert.equal(searchWithQuizPlace('?question=3', 0, TOTAL), '');
    assert.equal(searchWithQuizPlace('?question=3', TOTAL, TOTAL), '?question=review');
  });

  it('removes an invalid value once it has been read as the first question', () => {
    for (const search of ['?question=0', '?question=02', '?question=two', '?question=9']) {
      assert.equal(searchWithQuizPlace(search, parseQuizPlace(search, TOTAL), TOTAL), '', search);
    }
  });

  it('keeps every other entry byte for byte and in place, and drops a repeat', () => {
    assert.equal(searchWithQuizPlace('?a=b%20c&flag', 1, TOTAL), '?a=b%20c&flag&question=2');
    assert.equal(searchWithQuizPlace('?a=1&question=2&z=+', 2, TOTAL), '?a=1&question=3&z=+');
    assert.equal(searchWithQuizPlace('?question=2&a=1&question=3', 3, TOTAL), '?question=4&a=1');
    assert.equal(searchWithQuizPlace('?a=1&question=2&question=3', 0, TOTAL), '?a=1');
  });
});

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** Source with comments removed, so a sentence ABOUT a call cannot satisfy or trip a check. */
const runner = readFileSync(join(SRC, 'components', 'QuizRunner.tsx'), 'utf8')
  .replace(/\{\/\*[\s\S]*?\*\/\}/gu, '')
  .replace(/\/\*[\s\S]*?\*\//gu, '')
  .replace(/^\s*\/\/.*$/gmu, '');

/** The body of the mount effect that reads the place, up to its dependency list. */
const restore = (() => {
  const start = runner.search(/useEffect\(\(\) => \{\s*const search = window\.location\.search;/u);
  const end = runner.indexOf('}, [total]);', start);
  return start >= 0 && end > start ? runner.slice(start, end) : '';
})();

describe('the quiz restores its place from the URL without moving focus', () => {
  it('finds the restore effect, so this cannot pass by failing to look', () => {
    assert.notEqual(restore, '', 'no mount effect reading window.location.search in QuizRunner.tsx');
    assert.match(restore, /parseQuizPlace\(search, total\)/u);
  });

  it('opens the restored step without counting it as a move, which is what focus follows', () => {
    assert.match(restore, /setStep\(restored\);/u);
    assert.doesNotMatch(restore, /setMoves|\.focus\(/u, 'restoring the place on load must not move focus');
    assert.match(runner, /useFocusOnChange\(headingRef, moves\);/u);
    assert.doesNotMatch(runner, /useFocusOnChange\(headingRef, step\)/u);
  });

  it('routes every press through one function that steps, counts a move and writes the URL', () => {
    assert.match(
      runner,
      /const go = \(to: number\): void => \{\s*setStep\(to\);\s*setMoves\(\(count\) => count \+ 1\);\s*writeSearch\(searchWithQuizPlace\(window\.location\.search, to, total\)\);\s*\};/u,
    );
    assert.equal(runner.match(/setStep\(/gu)?.length, 2, 'setStep only in `go` and the restore effect');
    assert.equal(runner.match(/setMoves\(/gu)?.length, 1, 'only `go` counts a move');
    for (const press of ['go(0)', 'go(step - 1)', 'go(step + 1)']) {
      assert.ok(runner.includes(`onClick={() => ${press}}`), press);
    }
  });

  it("tidies the URL on load only after Next has patched replaceState, so the router's state survives", () => {
    assert.match(
      restore,
      /const tidy = window\.setTimeout\(\(\) => \{\s*writeSearch\(searchWithQuizPlace\(window\.location\.search, restored, total\)\);\s*\}, 0\);\s*return \(\) => window\.clearTimeout\(tidy\);/u,
    );
    assert.equal(restore.match(/writeSearch\(/gu)?.length, 1, 'no synchronous write in the mount effect');
  });

  it('replaces the history entry with null state, and reads no search params on render', () => {
    assert.match(runner, /window\.history\.replaceState\(null, '', url\);/u);
    assert.doesNotMatch(runner, /pushState|useSearchParams|localStorage|sessionStorage|indexedDB|cookie/u);
  });
});

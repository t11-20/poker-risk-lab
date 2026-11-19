/**
 * The "On this page" entry marked `aria-current`. Scrolling up used to leave the previous section
 * current for about a screen, because the observer watched the viewport and fired only on entering
 * or leaving it, and the callback judged the other headings on positions cached when they last did.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { aboveLineRootMargin, activeHeading } from '../src/lib/lesson-contents.ts';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const CONTENTS = readFileSync(join(SRC, 'components', 'LessonContents.tsx'), 'utf8');

const IDS = ['one', 'two', 'three'];

describe('the current heading', () => {
  it('is the last whose top has reached the line', () => {
    assert.equal(activeHeading(IDS, [-900, -40, 300], 65), 'two');
    assert.equal(activeHeading(IDS, [-900, 65, 300], 65), 'two', 'on the line counts as passed');
  });

  it('is the first before any heading has reached it, and skips one that is missing', () => {
    assert.equal(activeHeading(IDS, [120, 400, 900], 65), 'one');
    assert.equal(activeHeading(IDS, [-900, null, 300], 65), 'one');
    assert.equal(activeHeading([], [], 65), null);
  });
});

describe('the observer fires on every crossing of the line (REGRESSION)', () => {
  it('has a root of everything above the line, so a crossing in either direction flips it', () => {
    // 900px viewport, 5,000px page, line at 65px: the root's bottom edge is pulled up to the line.
    assert.equal(aboveLineRootMargin(900, 5000, 65), '5000px 0px -835px 0px');
    // Never a positive bottom margin, which would move the line below the viewport.
    assert.equal(aboveLineRootMargin(40, 40, 65), '40px 0px 0px 0px');
  });

  it('is built with that root, rebuilt on resize, and re-reads every heading when it fires', () => {
    assert.match(
      CONTENTS,
      /rootMargin: aboveLineRootMargin\(root\.clientHeight, root\.scrollHeight, line\)/u,
    );
    assert.match(CONTENTS, /window\.addEventListener\('resize', observe\)/u);
    assert.match(CONTENTS, /getBoundingClientRect\(\)\.top/u);
    // NEGATIVE CONTROL: the stale cache this replaced, and the scroll handler §5.4 rules out.
    assert.doesNotMatch(CONTENTS, /entry\.boundingClientRect/u);
    assert.doesNotMatch(CONTENTS, /addEventListener\('scroll'/u);
  });
});

/**
 * The sentence under a quiz verdict may not claim a recording that did not happen. The attempt route
 * answers 200 to a caller with no session and stores nothing, and signed-out is the default state.
 * The claims are pinned, not the exact wording, so this is not a change-detector.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { QuizAttemptResponse } from '@prl/contracts';
import { lessonReadNote } from '../src/lib/lesson-reads.ts';
import {
  gradedAnswer,
  resolvedVerdict,
  VERDICT_SOURCE_NOTE,
  type VerdictSource,
  verdictFor,
} from '../src/lib/quiz-attempts.ts';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** Drives `verdictFor`, the real mapping `submitQuizAttempt` uses, without the fetches around it. */
const GRADED: Omit<QuizAttemptResponse, 'recorded'> = {
  correct: true,
  explanation: 'Because the pot lays 3 to 1.',
  expected: { value: 25, unit: 'percent', tolerance: 2 },
};

describe('a reply that stored nothing becomes a verdict that says so', () => {
  it('is anonymous when the server did not record it, and live when it did', () => {
    assert.equal(verdictFor({ ...GRADED, recorded: false }).state, 'anonymous');
    assert.equal(verdictFor({ ...GRADED, recorded: true }).state, 'live');
  });

  it('keeps the server’s own comparison in both, because both were graded by the server', () => {
    // The natural over-correction falls back to the browser's comparison. The server graded it either way.
    const anonymous = verdictFor({ ...GRADED, correct: false, recorded: false });
    assert.deepEqual(resolvedVerdict(anonymous, true), { matched: false, source: 'anonymous' });

    const recorded = verdictFor({ ...GRADED, correct: false, recorded: true });
    assert.deepEqual(resolvedVerdict(recorded, true), { matched: false, source: 'server' });
  });

  it('exposes the graded figure for an anonymous answer, not only for a recorded one', () => {
    // A `state === 'live'` test in `QuizRunner` would show a signed-out learner the browser's figure.
    for (const recorded of [true, false]) {
      const graded = gradedAnswer(verdictFor({ ...GRADED, recorded }));
      assert.ok(graded !== null, `a graded reply must be readable when recorded=${recorded}`);
      assert.equal(graded.expected?.value, 25);
    }
    assert.equal(gradedAnswer({ state: 'idle' }), null);
    assert.equal(gradedAnswer({ state: 'pending' }), null);
    assert.equal(gradedAnswer({ state: 'unavailable' }), null);
  });
});

describe('the sentence beside the verdict', () => {
  const SOURCES: readonly VerdictSource[] = ['server', 'anonymous', 'local', 'pending'];

  it('exists for every source a verdict can resolve to', () => {
    for (const source of SOURCES) {
      const note = VERDICT_SOURCE_NOTE[source];
      assert.equal(typeof note, 'string');
      assert.ok(note.trim().length > 0, `${source} has no sentence`);
    }
  });

  it('only claims a recording in the one state where a row exists', () => {
    assert.match(VERDICT_SOURCE_NOTE.server, /Recorded on your record as a question you have answered/u);

    for (const source of ['anonymous', 'local'] as const) {
      assert.match(
        VERDICT_SOURCE_NOTE[source],
        /nothing was recorded|was not recorded/iu,
        `${source} must state that nothing was stored`,
      );
      assert.doesNotMatch(
        VERDICT_SOURCE_NOTE[source],
        /Recorded on your record/u,
        `${source} must not make the claim reserved for an answer that was stored`,
      );
    }
    assert.doesNotMatch(VERDICT_SOURCE_NOTE.pending, /recorded/u);
  });

  it('tells an anonymous learner what a session would change, without demanding one', () => {
    const note = VERDICT_SOURCE_NOTE.anonymous;
    assert.match(note, /no guest session to keep it on/u);
    assert.match(note, /opening a table starts a guest session straight away/u);
    assert.match(note, /no email and no password/u);
    // The product is guest-first on purpose, so this is not a demand.
    assert.doesNotMatch(note, /sign in|log in|create an account|you must|you need to/iu);
  });

  it('says the same thing the lesson-read note says, because it is the same fact', () => {
    const lesson = lessonReadNote({ state: 'anonymous' });
    assert.match(lesson, /no guest session to keep it on/u);
    assert.match(VERDICT_SOURCE_NOTE.anonymous, /no guest session to keep it on/u);
  });
});

describe('the panel is wired to the state rather than to "the call succeeded"', () => {
  it('never reads the graded reply through a bare state === live test', () => {
    // `=== 'live'` now means "graded AND recorded", so each such test would drop a signed-out learner
    // onto the browser's own figures.
    const runner = readFileSync(join(SRC, 'components', 'QuizRunner.tsx'), 'utf8');
    const prose = runner
      .split('\n')
      .filter((line) => !/^\s*(?:\*|\/\/|\/\*)/u.test(line))
      .join('\n');
    assert.doesNotMatch(
      prose,
      /state\s*===\s*'live'/u,
      'read the grading with `gradedAnswer`: `state === "live"` is now "recorded", not "graded"',
    );
    assert.match(prose, /gradedAnswer\(/u, 'the component reads the grading through the helper');
  });
});

/**
 * Recording a finished lesson: that it is sent at all, that a learner sends it, and that the screen
 * never claims more than the server stored.
 *
 * ## The defect
 *
 * The release audit's PROD-028. `upsertLessonProgress` existed in `apps/api`, was tested, and had
 * no caller anywhere — no HTTP route, and therefore no client — so `lessonsCompleted` in
 * `GET /me/progress` could not be anything but zero and `/record` showed the learner a column of
 * noughts that nothing in the product could move. This is the same shape as the quiz-attempt defect
 * the file next door covers, and it shipped the same way: every server-side test passed, because
 * the repository function worked perfectly and nobody called it.
 *
 * ## The gate that catches the class, and the ones here that catch the specifics
 *
 * `api-paths.test.ts` is the class-wide gate — a published path with no call site in
 * `apps/web/src` fails it — and `API_PATHS.lessonRead` was the single entry failing it before this
 * change. That gate cannot see *how* a path is called, though, and for this endpoint the how is the
 * whole point: a call issued from a page load would satisfy it while recording completions for
 * prefetches, crawlers and back-buttons. So the assertions below pin the two things the path table
 * cannot:
 *
 *  - the request originates from a press, not from a render;
 *  - `completedAt: null` in the reply — the guest case, where the route answers 200 and stores
 *    nothing — is rendered as "nothing was recorded" and never as a completion.
 *
 * The source-text assertions read files rather than rendering them, which is what every structural
 * test in this directory does: there is no DOM in this test runner, and the properties being
 * checked are about which code exists and where, not about what a browser paints.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { LessonReadResponse } from '@prl/contracts';
import {
  LESSON_READ_BODY,
  type LessonReadOutcome,
  type LessonReadState,
  lessonReadNote,
  outcomeFor,
} from '../src/lib/lesson-reads.ts';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (...parts: readonly string[]): string => readFileSync(join(SRC, ...parts), 'utf8');

/** Every TypeScript source under `src`, as `{ path, text }`. */
function sources(directory: string): readonly { readonly path: string; readonly text: string }[] {
  const found: { path: string; text: string }[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...sources(full));
    else if (extname(entry.name) === '.ts' || extname(entry.name) === '.tsx') {
      found.push({ path: relative(SRC, full).split('\\').join('/'), text: readFileSync(full, 'utf8') });
    }
  }
  return found;
}

const FILES = sources(SRC);

/** Files containing a given call, by their path relative to `src`. */
const callersOf = (needle: string): readonly string[] =>
  FILES.filter((file) => file.text.includes(needle)).map((file) => file.path);

/** A reply from `POST /content/lessons/:id/read`, built here so each case is explicit. */
const reply = (completedAt: string | null): LessonReadResponse => ({
  lessonId: 'pot-odds',
  completedAt,
  lastViewedAt: '2026-08-19T11:00:00.000Z',
});

describe('the reply is read as what the server stored, not as what was asked for', () => {
  it('treats a stored completion as recorded and keeps the server’s own timestamp', () => {
    // The stamp is the server's, not this browser's clock: `LessonReadResponse` echoes the stored
    // row back precisely so a client renders what the server holds.
    assert.deepEqual(outcomeFor(reply('2026-08-19T10:59:00.000Z')), {
      state: 'recorded',
      completedAt: '2026-08-19T10:59:00.000Z',
    });
  });

  it('treats a null completion as nothing stored, because this client only ever posts true', () => {
    // The route answers 200 to a reader with no session and writes no row — guest-first, exactly
    // like the quiz-attempt route. Since the only body this client sends is `completed: true`, a
    // null completion in the reply cannot mean "not finished yet"; it can only mean there was no
    // user to write a row for. Reporting it as `recorded` would put a tick on the screen for every
    // signed-out reader while `/record` kept showing zero.
    assert.deepEqual(outcomeFor(reply(null)), { state: 'anonymous' });
  });

  it('sends completion and nothing else, and never sends completed:false', () => {
    // `completed: false` is legal on the wire — it records a lesson opened without claiming it was
    // finished — and posting it on page load is precisely the inference PROD-028 forbids. There is
    // no code path here that can produce it.
    assert.deepEqual({ ...LESSON_READ_BODY }, { completed: true });
    assert.ok(Object.isFrozen(LESSON_READ_BODY), 'the shared body must not be mutable by a caller');
  });
});

describe('the sentence on screen never claims a recording that did not happen', () => {
  const ALL: readonly LessonReadOutcome[] = [
    { state: 'idle' },
    { state: 'pending' },
    { state: 'recorded', completedAt: '2026-08-19T10:59:00.000Z' },
    { state: 'anonymous' },
    { state: 'unavailable' },
  ];

  it('has a sentence for every state the outcome can take', () => {
    const covered = new Set<LessonReadState>(ALL.map((outcome) => outcome.state));
    assert.equal(covered.size, ALL.length, 'a state is listed twice above');
    for (const outcome of ALL) {
      // Only `idle` is silent: the live region is in the DOM from the first render and there is
      // nothing to announce until the learner has done something.
      const note = lessonReadNote(outcome);
      if (outcome.state === 'idle') assert.equal(note, '');
      else assert.ok(note.length > 0, `${outcome.state} has no sentence, so the press looks inert`);
    }
  });

  it('says nothing was recorded when nothing was', () => {
    // These two are the assertions that have to be exactly right. Both are cases where the learner
    // pressed the button and their record did not change, and a sentence implying otherwise is a
    // lie about the one thing this whole feature exists to make true.
    assert.match(lessonReadNote({ state: 'anonymous' }), /Nothing was recorded/u);
    assert.match(lessonReadNote({ state: 'unavailable' }), /nothing was recorded/u);
  });

  it('claims a recording only once there is one', () => {
    assert.match(
      lessonReadNote({ state: 'recorded', completedAt: '2026-08-19T10:59:00.000Z' }),
      /^Recorded\./u,
    );
    // "Recording…" is a report on a request in flight, not on a row. It must not read as done.
    assert.doesNotMatch(lessonReadNote({ state: 'pending' }), /\bRecorded\b/u);
  });
});

describe('the completion is claimed by the learner, not inferred from a page load', () => {
  it('is posted from exactly one module, which is the only caller of the path', () => {
    // A second call site is how this becomes "record it on mount as well, just in case".
    assert.deepEqual(callersOf('API_PATHS.lessonRead('), ['lib/lesson-reads.ts']);
  });

  it('is sent from a press, and the only component that sends it is a control', () => {
    const senders = callersOf('submitLessonRead(').filter((path) => path !== 'lib/lesson-reads.ts');
    assert.deepEqual(senders, ['components/LessonRead.tsx']);

    const component = read('components', 'LessonRead.tsx');
    // The gesture: a button whose press mints the value the send effect is guarded on. Without
    // this, the effect below would be an on-mount recording — which a prefetch, a crawler and a
    // back-button are indistinguishable from, and which is the defect itself.
    assert.match(component, /onClick=\{\(\) => setPress\(\{ lessonId \}\)\}/u);
    assert.match(component, /if \(press === null\) return;/u);
  });

  it('guards the send on the press’s identity, so a re-render posts nothing', () => {
    // The same guard `QuizRunner` uses for an answer: identity, not a boolean. A boolean could
    // never express "the learner pressed again after it failed", and a value guard would post again
    // on every render that produced an equal object.
    const component = read('components', 'LessonRead.tsx');
    assert.match(component, /posted\.current\.get\(press\.lessonId\) === press/u);
    assert.match(component, /posted\.current\.set\(press\.lessonId, press\)/u);
  });

  it('aborts on unmount only, so navigating away cannot cancel the record', () => {
    // A per-press controller would be cleaned up by React the moment anything above re-rendered,
    // losing the record for exactly the learner who presses and immediately moves on. Unmount is
    // the only moment at which nobody is waiting for the answer any more.
    assert.match(
      read('components', 'LessonRead.tsx'),
      /useEffect\(\(\) => \(\) => submissions\.current\?\.abort\(\), \[\]\);/u,
    );
  });
});

describe('the lesson page carries the control, and no longer guesses at the reader', () => {
  const PAGE = ['app', 'learn', '[lessonId]', 'page.tsx'] as const;

  it('renders the control on the lesson screen', () => {
    // The path table's gate is satisfied by a call site anywhere in `src`, including a module no
    // screen imports. This is the assertion that the learner can actually reach it.
    assert.match(read(...PAGE), /<LessonRead lessonId=\{lesson\.id\}/u);
  });

  it('places it after everything the lesson has to say', () => {
    // "Reached the end" is defined by where the control is: past the prose, the takeaways, the
    // vocabulary and the quiz. If it moves above the quiz, pressing it stops meaning what the
    // sentence beside it says it means.
    const page = read(...PAGE);
    const quiz = page.indexOf('<QuizRunner');
    const control = page.indexOf('<LessonRead');
    assert.ok(quiz > 0 && control > quiz, 'the read control must come after the quiz, not before it');
  });

  it('no longer derives a read mark from the bundled fixture', () => {
    // The header used to show `✓ read` from `lessonSummaryFixture(...).completed`: sample data in
    // this repository, two entries hard-coded `true`, rendered to every visitor whether or not the
    // lesson body came from the live API and with no notice qualifying it. A claim about the reader
    // has to come from the reader's own record.
    const prose = read(...PAGE)
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
      .join('\n');
    assert.doesNotMatch(
      prose,
      /summary\??\.completed/u,
      'the lesson header is claiming a read from bundled sample data rather than from the record',
    );
  });
});

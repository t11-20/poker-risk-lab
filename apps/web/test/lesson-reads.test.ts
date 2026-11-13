/**
 * Recording a finished lesson (PROD-028, where `upsertLessonProgress` had no caller). `api-paths.test.ts`
 * proves a call site exists, and this pins how it is called. The request comes from a press, never a
 * render, and a `completedAt: null` reply (the guest case) is never shown as a completion.
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

const callersOf = (needle: string): readonly string[] =>
  FILES.filter((file) => file.text.includes(needle)).map((file) => file.path);

const reply = (completedAt: string | null): LessonReadResponse => ({
  lessonId: 'pot-odds',
  completedAt,
  lastViewedAt: '2026-08-19T11:00:00.000Z',
});

describe('the reply is read as what the server stored, not as what was asked for', () => {
  it('treats a stored completion as recorded and keeps the server’s own timestamp', () => {
    // The stamp is the server's, because `LessonReadResponse` echoes the stored row back.
    assert.deepEqual(outcomeFor(reply('2026-08-19T10:59:00.000Z')), {
      state: 'recorded',
      completedAt: '2026-08-19T10:59:00.000Z',
    });
  });

  it('treats a null completion as nothing stored, because this client only ever posts true', () => {
    // The route answers 200 to a reader with no session and writes no row. This client only sends
    // `completed: true`, so a null completion means there was no user, never "not finished".
    assert.deepEqual(outcomeFor(reply(null)), { state: 'anonymous' });
  });

  it('sends completion and nothing else, and never sends completed:false', () => {
    // `completed: false` is legal on the wire, and posting it on page load is what PROD-028 forbids.
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
      // Only `idle` is silent, because the live region is mounted from the first render.
      const note = lessonReadNote(outcome);
      if (outcome.state === 'idle') assert.equal(note, '');
      else assert.ok(note.length > 0, `${outcome.state} has no sentence, so the press looks inert`);
    }
  });

  it('says nothing was recorded when nothing was', () => {
    // Both are cases where the learner pressed and their record did not change.
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
    // A second call site is how this becomes "record it on mount as well".
    assert.deepEqual(callersOf('API_PATHS.lessonRead('), ['lib/lesson-reads.ts']);
  });

  it('is sent from a press, and the only component that sends it is a control', () => {
    const senders = callersOf('submitLessonRead(').filter((path) => path !== 'lib/lesson-reads.ts');
    assert.deepEqual(senders, ['components/LessonRead.tsx']);

    const component = read('components', 'LessonRead.tsx');
    // The press mints the value the send effect is guarded on. Otherwise the effect is an on-mount
    // recording, which a prefetch, a crawler and a back-button all trigger.
    assert.match(component, /onClick=\{\(\) => setPress\(\{ lessonId \}\)\}/u);
    assert.match(component, /if \(press === null\) return;/u);
  });

  it('guards the send on the press’s identity, so a re-render posts nothing', () => {
    // Identity, not a boolean, as in `QuizRunner`. A boolean cannot express a retry after a failure,
    // and a value guard would post again on every equal render.
    const component = read('components', 'LessonRead.tsx');
    assert.match(component, /posted\.current\.get\(press\.lessonId\) === press/u);
    assert.match(component, /posted\.current\.set\(press\.lessonId, press\)/u);
  });

  it('aborts on unmount only, so navigating away cannot cancel the record', () => {
    // A per-press controller is cleaned up on any re-render above, losing the record for a learner
    // who presses and moves on. Only unmount means nobody is waiting.
    assert.match(
      read('components', 'LessonRead.tsx'),
      /useEffect\(\(\) => \(\) => submissions\.current\?\.abort\(\), \[\]\);/u,
    );
  });
});

describe('the lesson page carries the control, and no longer guesses at the reader', () => {
  const PAGE = ['app', 'learn', '[lessonId]', 'page.tsx'] as const;

  it('renders the control on the lesson screen', () => {
    // The path gate accepts a call site no screen imports. This asserts the learner can reach it.
    assert.match(read(...PAGE), /<LessonRead lessonId=\{lesson\.id\}/u);
  });

  it('places it after everything the lesson has to say', () => {
    // Past the prose, the takeaways, the vocabulary and the quiz, so pressing it means "reached the end".
    const page = read(...PAGE);
    const quiz = page.indexOf('<QuizRunner');
    const control = page.indexOf('<LessonRead');
    assert.ok(quiz > 0 && control > quiz, 'the read control must come after the quiz, not before it');
  });

  it('no longer derives a read mark from the bundled fixture', () => {
    // The header once showed `✓ read` from sample fixture data to every visitor. A claim about the
    // reader has to come from the reader's own record.
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

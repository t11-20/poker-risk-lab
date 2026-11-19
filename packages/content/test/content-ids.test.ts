/**
 * Content ids: unique where something looks them up, and storable in the database that records them.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RawContent } from '../src/index.ts';
import { collectContentProblems, readRawContent } from '../src/index.ts';

interface RawLesson {
  id: string;
  prerequisites: string[];
}

interface RawQuiz {
  lessonId?: string;
  readonly id: string;
  readonly questions: Record<string, unknown>[];
}

function withQuizzes(edit: (quizzes: RawQuiz[]) => void): RawContent {
  const raw = structuredClone(readRawContent());
  edit(raw.quizzes as unknown as RawQuiz[]);
  return raw;
}

/** Renames the first lesson and repoints everything that refers to it, so only the id can be at fault. */
function lessonRenamed(id: string): readonly string[] {
  const raw = structuredClone(readRawContent());
  const lessons = raw.lessons as unknown as RawLesson[];
  const lesson = lessons[0];
  assert.ok(lesson !== undefined, 'the bundle has a lesson');
  const old = lesson.id;
  lesson.id = id;
  for (const entry of lessons) {
    entry.prerequisites = entry.prerequisites.map((prerequisite) =>
      prerequisite === old ? id : prerequisite,
    );
  }
  for (const quiz of raw.quizzes as unknown as RawQuiz[]) if (quiz.lessonId === old) quiz.lessonId = id;
  return collectContentProblems(raw);
}

function questionsOf(quizzes: readonly RawQuiz[], index: number): Record<string, unknown>[] {
  const quiz = quizzes[index];
  assert.ok(quiz !== undefined && quiz.questions.length >= 2, `quiz ${index} has two questions`);
  return quiz.questions;
}

describe('a quiz question id', () => {
  it('is unique in the shipped bundle', () => {
    assert.deepEqual(collectContentProblems(readRawContent()), []);
  });

  it('is refused when two questions in one quiz share it', () => {
    const raw = withQuizzes((quizzes) => {
      const [first, second] = questionsOf(quizzes, 0);
      assert.ok(first !== undefined && second !== undefined);
      second['id'] = first['id'];
    });
    const problems = collectContentProblems(raw);
    assert.ok(
      problems.some((problem) => /^quiz questions: duplicate id "/.test(problem)),
      problems.join('\n'),
    );
  });

  it('is refused when a question in another quiz reuses it', () => {
    const raw = withQuizzes((quizzes) => {
      const [reused] = questionsOf(quizzes, 2);
      const [copy] = questionsOf(quizzes, 1);
      assert.ok(reused !== undefined && copy !== undefined);
      copy['id'] = reused['id'];
    });
    const problems = collectContentProblems(raw);
    assert.ok(
      problems.some((problem) => /^quiz questions: duplicate id "/.test(problem)),
      problems.join('\n'),
    );
  });
});

describe('a content id', () => {
  it('is accepted up to the 63 characters the database stores', () => {
    for (const id of ['a'.repeat(63), 'pot-odds-2', 'x']) assert.deepEqual(lessonRenamed(id), [], id);
  });

  it('is refused past 63 characters, or with a hyphen at either end', () => {
    for (const id of ['a'.repeat(64), 'pot-odds-', '-pot-odds']) {
      const problems = lessonRenamed(id);
      assert.ok(
        problems.some((problem) => problem.startsWith('lessons[0].id: ')),
        `${id} was not refused: ${problems.join('; ')}`,
      );
    }
  });
});

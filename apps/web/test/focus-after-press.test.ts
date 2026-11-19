/**
 * A control that unmounts or disables itself when pressed drops the caret to `<body>` in Chrome, and
 * the reader starts again from the top of the page. Held over source text, because `apps/web` tests
 * run with no DOM; the real-key behaviour is measured by `scripts/keyboard-audit.mjs`.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (...parts: readonly string[]): string => readFileSync(join(ROOT, ...parts), 'utf8');

/** Source with comments removed, so a sentence ABOUT a call cannot satisfy or trip a check. */
function code(source: string): string {
  return source
    .replace(/\{\/\*[\s\S]*?\*\/\}/gu, '')
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/^\s*\/\/.*$/gmu, '');
}

/** The opening tag of the `<Button>` whose label contains `label`. */
function buttonBefore(source: string, label: string): string {
  const at = source.indexOf(label);
  assert.ok(at >= 0, `no "${label}" in the source; this check needs updating`);
  const open = source.lastIndexOf('<Button', at);
  assert.ok(open >= 0, `"${label}" is not inside a <Button>`);
  return source.slice(open, at);
}

describe('"Show the reasoning" moves focus to the reasoning it revealed (REGRESSION)', () => {
  const quiz = code(read('apps', 'web', 'src', 'components', 'QuizRunner.tsx'));

  it('makes the "Why" block a focus target with no tab stop', () => {
    assert.match(
      quiz,
      /<div className="prl-learn-quiz__explanation" ref=\{explanationRef\} tabIndex=\{-1\}>/u,
    );
  });

  it('focuses it only after a reveal pressed here, never on paging back to a revealed question', () => {
    assert.match(quiz, /if \(given\.kind === 'revealed'\) revealing\.current = true;/u);
    assert.match(
      quiz,
      /if \(!revealing\.current \|\| currentAnswer\?\.kind !== 'revealed'\) return;\s*revealing\.current = false;\s*explanationRef\.current\?\.focus\(\);/u,
    );
    // NEGATIVE CONTROL: a checked answer keeps its button, so nothing else may set the flag.
    assert.equal(quiz.match(/revealing\.current = true/gu)?.length, 1);
  });
});

describe('a button that is busy or done keeps the caret (REGRESSION)', () => {
  const cases = [
    {
      name: 'LessonRead',
      source: code(read('apps', 'web', 'src', 'components', 'LessonRead.tsx')),
      label: "{working ? 'Recording…'",
      guard: /if \(!working && !done\) setPress\(\{ lessonId \}\);/u,
    },
    {
      name: 'UnitsReset',
      source: code(read('apps', 'web', 'src', 'app', 'record', 'UnitsReset.tsx')),
      label: "{reset.state === 'working' ? 'Resetting…'",
      guard: /const run = \(\): void => \{\s*if \(reset\.state === 'working'\) return;/u,
    },
  ];

  for (const { name, source, label, guard } of cases) {
    it(`${name} marks the button aria-disabled rather than disabling it`, () => {
      const tag = buttonBefore(source, label);
      assert.doesNotMatch(tag, /\sdisabled=/u, `${name}: a natively disabled button blurs to <body>`);
      assert.match(tag, /aria-disabled=\{/u);
    });

    it(`${name} ignores a press while it is unavailable, since aria-disabled stops nothing`, () => {
      assert.match(source, guard);
    });
  }

  it('an aria-disabled button does not light up on hover or press', () => {
    const css = read('packages', 'ui', 'src', 'styles', 'components.css');
    const rules = [...css.matchAll(/^\.prl-btn--\w+:(?:hover|active)(:not\([^)]*\))?/gmu)];
    // A sweep of nothing is not a pass.
    assert.ok(rules.length >= 8, `found ${rules.length} button hover/active rules`);
    for (const [rule, not] of rules) {
      assert.match(not ?? '', /\[aria-disabled="true"\]/u, `${rule} re-lights an aria-disabled button`);
    }
  });
});

describe('"Remind me again" leaves the caret on the reminder control (REGRESSION)', () => {
  const session = code(read('apps', 'web', 'src', 'components', 'SessionDuration.tsx'));

  it('focuses the select before the press unmounts the button', () => {
    assert.match(session, /id="prl-session-reminder"\s+ref=\{reminderRef\}/u);
    assert.match(session, /reminderRef\.current\?\.focus\(\);\s*acknowledge\(\);/u);
  });

  it('keeps only the storage keys `/privacy` names', () => {
    const sitting = read('apps', 'web', 'src', 'lib', 'session-sitting.ts');
    assert.doesNotMatch(session, /_KEY = '/u, 'the keys live in one file');
    assert.deepEqual(
      [...sitting.matchAll(/const \w+_KEY = '([^']+)'/gu)].map((match) => match[1]),
      [
        'prl.session.startedAt',
        'prl.session.reminderMinutes',
        'prl.session.hidden',
        'prl.session.acknowledgedAt',
      ],
    );
  });
});

/**
 * What this app says out loud, and what it must never say instead.
 *
 * ## The defect these exist for
 *
 * The release audit's hardest finding on this client was on the live table's error path. The block
 * that replaces the table when it cannot be reached was an unlabelled `<div class="prl-error">`
 * with **no `role="alert"` and no live-region ancestor**, while the page's only `role="status"`
 * simultaneously announced **"Ready to connect."** A screen-reader user was told the opposite of
 * what the screen said, on the most consequential error path in the product. WCAG 2.2 SC 4.1.3
 * (AA), on a page that had been reviewed repeatedly.
 *
 * The second was quieter and the same shape: the Coach's analysis arrives in a panel that is a
 * collapsed off-screen sheet below 600px, and nothing announced its arrival — while
 * `ScenarioStage.tsx` had been announcing the identical event correctly for the whole time.
 *
 * ## Why these are source assertions and not rendered ones
 *
 * `apps/web`'s tests run under `node --test` with no DOM and no JSX transform, so a component
 * cannot be rendered here; `scripts/a11y-audit.mjs` is what drives the real accessibility engine
 * over the delivered HTML. What this file adds is a check on the two things the audit tool cannot
 * see: an error state that is only reachable against a broken server, and a reducer transition.
 * `tableReducer` is a pure function and is driven for real below.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { CoachReport, WsServerMessage } from '@prl/contracts';
import {
  COACH_FAILED_ANNOUNCEMENT,
  COACH_READY_ANNOUNCEMENT,
  EMPTY_TABLE_STATE,
  tableReducer,
} from '../src/lib/use-live-table.ts';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (...parts: readonly string[]): string => readFileSync(join(SRC, ...parts), 'utf8');

describe('the live table announces its own failure', () => {
  it('marks the block that replaces the table as an alert', () => {
    const stage = read('components', 'TableStage.tsx');
    assert.match(
      stage,
      /<div className="prl-error" role="alert">/u,
      'The error block in TableStage replaces the whole table and is the only thing on screen ' +
        'saying the table is unreachable. Without role="alert" it is announced by nothing, and the ' +
        'page’s only live region says "Ready to connect." at the same moment. WCAG 2.2 SC 4.1.3.',
    );
  });

  it('never lets the status region claim readiness while the setup has failed', () => {
    const live = read('app', 'play', 'LiveTable.tsx');
    const start = live.indexOf('function statusSentence');
    const end = live.indexOf('function hintSentence');
    assert.ok(start >= 0 && end > start, 'statusSentence has moved; this assertion needs updating');
    const body = live.slice(start, end);
    assert.match(
      body,
      /phase === 'failed'/u,
      'statusSentence must handle the failed phase. A failed setup never opens a socket, so ' +
        '`status` stays null and the fall-through reads that as "Ready to connect." — which is how ' +
        'the page came to announce the opposite of the error beside it.',
    );
    // The order matters: the `failed` branch has to come BEFORE the null-status fall-through, or it
    // never runs.
    assert.ok(
      body.indexOf("phase === 'failed'") < body.indexOf('status === null'),
      'the failed branch must be reached before the "Ready to connect." fall-through',
    );
  });

  it('announces a quiz question that cannot be marked', () => {
    // Same shape, one screen away: the block REPLACES the question, so a reader who cannot see it
    // is left waiting at a field that has silently gone away.
    assert.match(read('components', 'QuizRunner.tsx'), /<div className="prl-error" role="alert">/u);
  });
});

/** A coach frame, as the socket delivers one. The report's contents are irrelevant here. */
function coachFrame(requestId: string): WsServerMessage {
  const report = { street: 'flop' } as unknown as CoachReport;
  return { type: 'coach', requestId, report } as WsServerMessage;
}

describe('the Coach’s arrival is announced', () => {
  it('puts a sentence in the table’s live region when the analysis lands', () => {
    const asked = tableReducer(EMPTY_TABLE_STATE, {
      kind: 'coachRequested',
      requestId: 'coach-1',
      key: '',
    });
    assert.equal(asked.announcement, '', 'asking for the analysis is not news; arriving is');

    const arrived = tableReducer(asked, { kind: 'frame', frame: coachFrame('coach-1') });
    assert.equal(
      arrived.announcement,
      COACH_READY_ANNOUNCEMENT,
      'The Coach panel is a collapsed off-screen sheet below 600px. A reader who asked for the ' +
        'analysis and is told nothing has no way to know it is there. ScenarioStage.tsx has ' +
        'announced the identical event correctly all along.',
    );
    assert.doesNotMatch(
      arrived.announcement,
      /\d/u,
      'the announcement must carry no figure: a number read out of the panel it came from has lost ' +
        'the assumptions it rests on',
    );
  });

  it('says so when the analysis could not be shown', () => {
    const failed = tableReducer(EMPTY_TABLE_STATE, {
      kind: 'coachFailed',
      reason: 'the frame did not parse',
    });
    assert.ok(failed.announcement.startsWith(COACH_FAILED_ANNOUNCEMENT));
    assert.match(failed.announcement, /the frame did not parse/u);
    assert.equal(failed.coachProblem, 'the frame did not parse');
  });

  it('turns live Coach off when the server refuses it for this difficulty', () => {
    const asked = tableReducer(EMPTY_TABLE_STATE, {
      kind: 'coachRequested',
      requestId: 'coach-1',
      key: '',
    });
    const refused = tableReducer(asked, {
      kind: 'frame',
      frame: {
        type: 'error',
        requestId: 'coach-1',
        error: {
          code: 'coach_not_available',
          message:
            'The Coach is available in review after the hand, not while it is being played at this difficulty.',
          requestId: 'coach-1',
        },
      },
    });
    assert.equal(refused.coachDuringHand, false);
    assert.equal(refused.coach, null);
    assert.equal(refused.coachRequestId, null);
    assert.match(refused.announcement, /review afterwards/u);
  });

  it('says nothing for an answer to a request nobody made', () => {
    // A `coach` frame whose id does not match the outstanding one is dropped entirely; announcing
    // it would describe a panel that did not change.
    const stale = tableReducer(EMPTY_TABLE_STATE, { kind: 'frame', frame: coachFrame('other') });
    assert.equal(stale.announcement, '');
    assert.equal(stale.coach, null);
  });
});

describe('a field that cannot be used says so on the field', () => {
  it('marks the quiz numeric input invalid and points a description at the reason', () => {
    const quiz = read('components', 'QuizRunner.tsx');
    assert.match(
      quiz,
      /aria-invalid=\{malformed \? true : undefined\}/u,
      '`aria-invalid` appeared nowhere in this client. The numeric field disables its own button ' +
        'for text a browser could not parse and said nothing about why.',
    );
    assert.match(
      quiz,
      /const describedBy = malformed \? `\$\{invalidId\} \$\{hintId\}` : hintId;/u,
      'the correction must be associated with the field, and must come first: a reader who has just ' +
        'been told the field is invalid needs the reason before the tolerance rule',
    );
    // "Invalid" must mean the INPUT and never the answer: marking a wrong-but-well-formed answer
    // invalid would be both false and the closest thing to a mark this product allows itself.
    assert.match(
      quiz,
      /const malformed = badInput \|\| \(draft\.trim\(\) !== '' && !Number\.isFinite\(parsed\)\);/u,
    );
    // `badInput` is load-bearing and cannot be dropped as redundant. An `<input type="number">`
    // reports `value === ''` for text it could not parse, so a check written against the draft
    // alone can NEVER fire — the first version of this fix had exactly that bug and looked correct.
    assert.match(
      quiz,
      /setBadInput\(event\.target\.validity\.badInput\)/u,
      'the invalid state must be read from validity.badInput; the draft cannot tell you that text ' +
        'was typed, because the browser has already discarded it',
    );
  });

  it('marks the invite-code field invalid when the server refused the code', () => {
    assert.match(read('app', 'play', 'LiveTable.tsx'), /aria-invalid=\{refused \? true : undefined\}/u);
  });
});

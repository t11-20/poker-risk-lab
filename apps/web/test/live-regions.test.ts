/**
 * What this app says out loud, and what it must never say instead.
 *
 * ## The defect these exist for
 *
 * The release audit's hardest finding on this client was on the live table's error path. The block
 * that replaces the table when it cannot be reached was an unlabelled `<div class="prl-error">`
 * with **no `role="alert"` and no live-region ancestor**, while the connection status region
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
 *
 * ## The third defect: the table never said whose decision it was
 *
 * Whose turn it is, is the single most important fact at a poker table, and `Seat.tsx` marks it
 * three separate ways for a sighted reader — an accent edge, a "TO ACT" chip, and the draining timer
 * ring. None of the three is a live region, and no live region carried it, so a screen-reader user
 * heard the seat before them act and then silence. They were never told the decision had arrived,
 * what it cost, what was in the pot, or which actions were legal.
 *
 * The fix has to survive ADR 0009, which sends state WHOLE: every frame carries the entire table, so
 * a region fed from a frame announces on every frame. The reducer therefore diffs, and the tests
 * below drive that diff with the app's own typed fixture — including the case that matters most,
 * which is that a second identical frame announces NOTHING.
 *
 * ## Would these fail if the behaviour broke?
 *
 * The reducer half, yes, and by construction: `turnAnnouncementFor` is driven over a real
 * `PlayerView` and the assertions name the figures that must be in the sentence, so deleting the
 * announcement, dropping the pot from it, or announcing on the level instead of the edge each fail a
 * different assertion here. The source-assertion half is weaker on purpose and says so: it pins
 * exact markup that a previous audit found missing, so a revert fails rather than shipping.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { CoachReport, WsServerMessage } from '@prl/contracts';
import type { PlayerView, SeatView } from '@prl/ui';
import {
  COACH_FAILED_ANNOUNCEMENT,
  COACH_READY_ANNOUNCEMENT,
  EMPTY_TABLE_STATE,
  isViewersTurn,
  type PendingDecision,
  tableReducer,
  turnAnnouncementFor,
} from '../src/lib/use-live-table.ts';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (...parts: readonly string[]): string => readFileSync(join(SRC, ...parts), 'utf8');

/**
 * Source with its comments removed.
 *
 * A rule stated in prose must not be read as a breach of itself. `TableStage.tsx` explains that
 * `role="alert"` implies `aria-live="assertive"` — and the first version of the assertion below
 * matched that sentence and reported the file as breaking a rule the sentence exists to keep.
 */
const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '');

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

/**
 * A view, built here rather than imported from `src/fixtures/table.ts`.
 *
 * Not a preference. That fixture imports `parseCardText` from `@prl/ui` as a runtime value, and
 * `@prl/ui` is consumed as source: its entry point re-exports `.tsx` components, which Node's type
 * stripping cannot load, so importing the fixture would fail this whole file with
 * `ERR_UNKNOWN_FILE_EXTENSION`. The same constraint is why `turnAnnouncementFor` formats its own
 * figures; see the comment on `units` in `use-live-table.ts`.
 *
 * It is typed as `PlayerView` and NOT cast, which is the point of writing it out: if the wire
 * contract grows a field, this stops compiling under `pnpm --filter @prl/web test` rather than
 * quietly testing a shape the server no longer sends.
 */
const HERO_SEAT: SeatView = {
  seat: 0,
  playerId: 'test-hero',
  stack: 970,
  committedThisStreet: 0,
  committedTotal: 30,
  status: 'active',
  position: 'BB',
  holeCards: [51, 47],
  isSelf: true,
  isButton: false,
  isToAct: true,
};

const OPPONENT_SEAT: SeatView = {
  seat: 2,
  playerId: 'test-bot',
  stack: 965,
  committedThisStreet: 35,
  committedTotal: 45,
  status: 'active',
  position: 'CO',
  holeCards: null,
  isSelf: false,
  isButton: true,
  isToAct: false,
};

const DECISION_VIEW: PlayerView = {
  handId: 'hand-1',
  roomId: 'room-1',
  handNumber: 12,
  config: { smallBlind: 5, bigBlind: 10, ante: 0, maxSeats: 6, actionTimeoutSeconds: 30 },
  street: 'flop',
  board: [20, 8, 3],
  buttonSeat: 2,
  seats: [HERO_SEAT, OPPONENT_SEAT],
  toAct: 0,
  betLevel: 35,
  minimumRaiseTo: 70,
  potTotal: 100,
  pots: [{ amount: 100, eligibleSeats: [0, 2], capPerSeat: 45, index: 0 }],
  forcedBets: [
    { kind: 'smallBlind', seat: 2, amount: 5, wasShort: false },
    { kind: 'bigBlind', seat: 0, amount: 10, wasShort: false },
  ],
  actions: [],
  actionSequence: 7,
  legalActions: [
    { type: 'fold' },
    { type: 'call', minTo: 35, costAtMin: 35 },
    { type: 'raise', minTo: 70, maxTo: 970, costAtMin: 70, allInAtMax: true },
  ],
  amountToCall: 35,
  commitmentRoot: 'a'.repeat(64),
  commitmentContext: 'prl/test',
  result: null,
  viewerSeat: 0,
  randomSourceKind: 'fixed-deck-scenario',
};

/** The same hand, settled: nobody is to act and there are no legal actions left. */
const SETTLED_VIEW: PlayerView = {
  ...DECISION_VIEW,
  street: 'complete',
  seats: [
    { ...HERO_SEAT, isToAct: false },
    { ...OPPONENT_SEAT, status: 'folded' },
  ],
  toAct: null,
  legalActions: [],
  amountToCall: 0,
  actionSequence: 11,
};

/**
 * A `state` frame, as the socket delivers one.
 *
 * The room is cast rather than built: nothing under test reads a field of it except `members`, which
 * `seatFrom` searches, and constructing a full `RoomSummary` here would be forty lines of values
 * that no assertion depends on. Same idiom as `coachFrame` above.
 */
function stateFrame(view: PlayerView | null, revision: number): WsServerMessage {
  return {
    type: 'state',
    view,
    room: { id: 'room-1', name: 'Fixture room', members: [] },
    deadlineMs: null,
    serverTimeMs: 0,
    revision,
  } as unknown as WsServerMessage;
}

function eventFrame(description: string): WsServerMessage {
  return {
    type: 'event',
    event: { kind: 'action', seat: 2, description, wasAutomatic: false },
    serverTimeMs: 0,
  } as unknown as WsServerMessage;
}

const FOLD: PendingDecision = {
  action: { type: 'fold' },
  actionId: 'act-1',
  expectedSequence: 7,
  requestId: 'req-1',
};

describe('the table announces whose decision it is', () => {
  it('says so on the frame where the decision becomes the reader’s, with the figures', () => {
    const dealt = tableReducer(EMPTY_TABLE_STATE, { kind: 'frame', frame: stateFrame(DECISION_VIEW, 1) });

    // Every figure a decision is made from. The layout guarantees a sighted reader sees the pot, the
    // price and their own stack at the same time (TableStage's module comment); this is the same
    // guarantee for a reader who cannot see the layout at all.
    assert.match(dealt.turnAnnouncement, /^Your turn on the flop\./u);
    assert.match(dealt.turnAnnouncement, /35 units to call/u, 'the price must be in the sentence');
    assert.match(dealt.turnAnnouncement, /Pot 100 units/u, 'the pot must be in the sentence');
    assert.match(dealt.turnAnnouncement, /your stack 970 units/u, 'the stack must be in the sentence');
    assert.match(
      dealt.turnAnnouncement,
      /You can fold, call or raise\./u,
      'the legal actions are the server’s own list, and they are what the reader is being asked to ' +
        'choose between',
    );
  });

  it('says NOTHING on a second identical whole-state frame', () => {
    // The assertion this whole design exists for. ADR 0009 pushes the entire table on every change,
    // so a region wired straight to a frame re-announces the turn several times a second. The
    // reducer diffs on the edge, so the string is carried unchanged — and an unchanged live region
    // is a silent one.
    const first = tableReducer(EMPTY_TABLE_STATE, { kind: 'frame', frame: stateFrame(DECISION_VIEW, 1) });
    const second = tableReducer(first, { kind: 'frame', frame: stateFrame(DECISION_VIEW, 2) });
    assert.equal(
      second.turnAnnouncement,
      first.turnAnnouncement,
      'a repeated frame must not change the region’s text, or the reader is told it is their turn ' +
        'once per frame for as long as they think about it',
    );
  });

  it('clears the sentence when the decision is no longer the reader’s', () => {
    const mine = tableReducer(EMPTY_TABLE_STATE, { kind: 'frame', frame: stateFrame(DECISION_VIEW, 1) });
    const over = tableReducer(mine, { kind: 'frame', frame: stateFrame(SETTLED_VIEW, 2) });
    assert.equal(over.turnAnnouncement, '');
    // Cleared rather than left standing, so the NEXT turn is a change and is announced again.
    const again = tableReducer(over, { kind: 'frame', frame: stateFrame(DECISION_VIEW, 3) });
    assert.match(again.turnAnnouncement, /^Your turn on the flop\./u);
  });

  it('agrees with the predicate the buttons are drawn from', () => {
    // One definition, used by the reducer and by the hook. If these ever disagree the table can
    // enable Fold while telling the reader it is somebody else's decision.
    assert.equal(isViewersTurn(DECISION_VIEW, false), true);
    assert.equal(isViewersTurn(SETTLED_VIEW, false), false);
    assert.equal(isViewersTurn(DECISION_VIEW, true), false, 'between hands nothing is anybody’s turn');
    assert.equal(isViewersTurn(null, false), false);
  });

  it('carries no equity figure and no hole card', () => {
    const sentence = turnAnnouncementFor(DECISION_VIEW);
    assert.doesNotMatch(
      sentence,
      /\bof (hearts|diamonds|clubs|spades)\b/u,
      'the reader’s cards are already named in the tree twice over; repeating them every turn makes ' +
        'the sentence long enough to talk over',
    );
    assert.doesNotMatch(
      sentence,
      /%/u,
      'a figure read out of the Coach panel has left the assumptions it rests on behind — the same ' +
        'rule COACH_READY_ANNOUNCEMENT follows',
    );
  });
});

describe('the reader’s own decision is echoed once, not prefixed forever', () => {
  it('announces the decision as a state change', () => {
    const sent = tableReducer(EMPTY_TABLE_STATE, { kind: 'submit', pending: FOLD });
    assert.equal(sent.announcement, 'You chose to fold.');
    assert.equal(sent.submission?.status, 'pending');
  });

  it('is replaced by the next thing the table says', () => {
    // The defect: `TableStage` used to CONCATENATE this phrase onto every announcement, and
    // `role="status"` is atomic — so every subsequent event was read out as "You chose to fold.
    // Seat 3 called 50 units." for the rest of the street.
    const sent = tableReducer(EMPTY_TABLE_STATE, { kind: 'submit', pending: FOLD });
    const next = tableReducer(sent, { kind: 'frame', frame: eventFrame('Seat 3 called 50 units') });
    assert.equal(next.announcement, 'Seat 3 called 50 units');
    assert.doesNotMatch(next.announcement, /You chose/u);
  });

  it('leaves the turn sentence alone, so a refused decision can still be re-announced', () => {
    const mine = tableReducer(EMPTY_TABLE_STATE, { kind: 'frame', frame: stateFrame(DECISION_VIEW, 1) });
    const sent = tableReducer(mine, { kind: 'submit', pending: FOLD });
    assert.equal(
      sent.turnAnnouncement,
      mine.turnAnnouncement,
      'clearing it here would look tidy and would leave a reader whose decision the server refuses ' +
        'with nothing to re-announce the unchanged spot with',
    );
  });

  it('does not concatenate the echo onto the caller’s announcement on the live path', () => {
    const stage = read('components', 'TableStage.tsx');
    assert.doesNotMatch(
      stage,
      /announcement=\{`\$\{spoken/u,
      'the template-literal concatenation is the defect; the echo belongs in the reducer',
    );
    // Whitespace-tolerant: biome reflows this expression across two lines and an assertion that
    // pinned the formatting would fail on a run of the formatter rather than on a real change.
    assert.match(
      withoutComments(stage).replace(/\s+/gu, ' '),
      /const spoken = pressed === null \? \(announcement \?\? ''\) :/u,
      'the fixture path has no reducer, so it is the one place the echo is composed here — and it ' +
        'is reached only when `pressed` is set, which the live path never does',
    );
  });
});

describe('a refusal interrupts, and everything else is polite', () => {
  it('wraps a rejected decision in an alert that is mounted only when it applies', () => {
    const stage = read('components', 'TableStage.tsx');
    assert.match(
      stage,
      /\{rejected \? \(\s*<div role="alert">/u,
      'the server refusing a decision — stale sequence, not your turn, illegal action — was a ' +
        'Callout with no live-region ancestor: the reader pressed a button, nothing happened, and ' +
        'nothing said so. An alert fires on INSERTION, which is why the node is conditional',
    );
  });

  it('wraps the server’s other refusals in an alert too', () => {
    const live = read('app', 'play', 'LiveTable.tsx');
    assert.match(
      live,
      /\{table\.notice === null \? null : \(\s*<div role="alert">/u,
      '`notice` is the server refusing something that was not a decision — a seat that had gone, a ' +
        'hand somebody else started, a rate limit — and it was silent',
    );
  });

  it('puts the caret on the acknowledgement when acting disables the control it was on', () => {
    // Found by `scripts/ax-tree-audit.mjs`: pressing Fold sets the submission to `pending`, which
    // disables every control in the ActionBar, and a browser blurs a control that becomes disabled.
    // The computed accessibility tree then reported a `RootWebArea` holding focus, named after the
    // page title — which is what the reader hears: they press a button, and the next thing announced
    // is the name of the page they were already on.
    const stage = withoutComments(read('components', 'TableStage.tsx'));
    assert.match(stage, /const acknowledgementRef = useRef<HTMLDivElement \| null>\(null\);/u);
    assert.match(
      stage,
      /acknowledgementRef\.current\?\.focus\(\);/u,
      'nothing moves the caret after a decision, so it is left on the document',
    );
    // Both guards, and both are load-bearing. Without the first, a table that updates while the
    // reader is in the Coach panel yanks them back to the controls; without the second, this steals
    // focus from whatever legitimately holds it.
    assert.match(stage, /if \(submission === null \|\| !hadFocus\.current\) return;/u);
    assert.match(
      stage,
      /if \(active !== null && active !== document\.body && active !== document\.documentElement\) return;/u,
      'the rescue must also recognise Chrome’s <html> activeElement as abandoned focus',
    );
  });

  it('gives the caret somewhere with a name to land on', () => {
    // A bare focusable `<div>` computes an EMPTY accessible name (measured in Chrome 151), so a
    // reader whose caret has just been moved is told nothing about where it went. `role="status"`
    // is exposed as the focused node in the tested browser and can carry the label.
    const stage = withoutComments(read('components', 'TableStage.tsx'));
    assert.match(
      stage,
      /aria-label="What happened to your decision" ref=\{acknowledgementRef\} role="status" tabIndex=\{-1\}/u,
    );
  });

  it('keeps the turn region polite, because a turn is not an emergency', () => {
    const stage = read('components', 'TableStage.tsx');
    assert.match(stage, /aria-atomic="true" aria-live="polite" className="prl-live-region" role="status"/u);
    // Exactly one assertive channel per screen. `role="alert"` implies assertive, and nothing else
    // on the play screen may. Asserted over the CODE, because the comment above the error block
    // explains that implication in prose and a naive scan reads its own documentation as a
    // violation — which is what the first version of this assertion did.
    assert.doesNotMatch(
      withoutComments(stage),
      /aria-live="assertive"/u,
      'an assertive region interrupts whatever the reader was in the middle of; the error block and ' +
        'the refusal use role="alert", and nothing else on this screen may interrupt at all',
    );
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

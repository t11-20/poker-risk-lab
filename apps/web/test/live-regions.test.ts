/**
 * What this app says out loud, and what it must never say instead (WCAG 2.2 SC 4.1.3).
 * `tableReducer` is pure and is driven for real. Markup is asserted over source text, because
 * `apps/web` tests run under `node --test` with no DOM, and `scripts/a11y-audit.mjs` cannot reach an
 * error state that needs a broken server.
 * ADR 0009 sends the whole table on every frame, so the turn announcement is a diff, and a second
 * identical frame must announce nothing.
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
  DEAL_ANNOUNCEMENT,
  EMPTY_TABLE_STATE,
  isViewersTurn,
  type PendingDecision,
  tableReducer,
  turnAnnouncementFor,
} from '../src/lib/use-live-table.ts';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (...parts: readonly string[]): string => readFileSync(join(SRC, ...parts), 'utf8');
const UI_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages', 'ui', 'src');
const readUi = (...parts: readonly string[]): string => readFileSync(join(UI_SRC, ...parts), 'utf8');

/** Comments removed, because `TableStage.tsx` explains `role="alert"` in prose and a scan read that. */
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
    // The failed branch has to come before the null-status fall-through, or it never runs.
    assert.ok(
      body.indexOf("phase === 'failed'") < body.indexOf('status === null'),
      'the failed branch must be reached before the "Ready to connect." fall-through',
    );
  });

  it('announces a quiz question that cannot be marked', () => {
    // The block replaces the question, so without an alert the field silently goes away.
    assert.match(read('components', 'QuizRunner.tsx'), /<div className="prl-error" role="alert">/u);
  });
});

/** A coach frame. The report's contents are irrelevant here. */
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
    assert.equal(refused.coachRequest, null);
    assert.match(refused.announcement, /review afterwards/u);
    // The server's wording is the only thing this client learns about why the Coach is off.
    assert.equal(
      refused.coachRefusal,
      'The Coach is available in review after the hand, not while it is being played at this difficulty.',
    );
  });

  it('says nothing for an answer to a request nobody made', () => {
    // A stale id is dropped, and announcing it would describe a panel that did not change.
    const stale = tableReducer(EMPTY_TABLE_STATE, { kind: 'frame', frame: coachFrame('other') });
    assert.equal(stale.announcement, '');
    assert.equal(stale.coach, null);
  });
});

/**
 * Built here, because `src/fixtures/table.ts` imports `@prl/ui` at runtime, which re-exports `.tsx`
 * that Node type stripping cannot load (`ERR_UNKNOWN_FILE_EXTENSION`). Typed as `PlayerView` and not
 * cast, so a new wire field stops this compiling.
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

/** The room is cast, because nothing under test reads it except `members`. */
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

function handStartedFrame(): WsServerMessage {
  return {
    type: 'event',
    event: { kind: 'handStarted', handId: 'hand-1', commitmentRoot: 'root' },
    serverTimeMs: 0,
  } as unknown as WsServerMessage;
}

function forcedBetsFrame(detail: string): WsServerMessage {
  return {
    type: 'event',
    event: { kind: 'forcedBets', detail },
    serverTimeMs: 0,
  } as unknown as WsServerMessage;
}

describe('the deal is announced with the blinds, in one write', () => {
  const BLINDS = 'smallBlind 5 from seat 3, bigBlind 10 from seat 4';

  it('writes nothing of its own when the hand starts', () => {
    // `forcedBets` follows `handStarted` in the same notice, and two writes into one atomic region are
    // heard as the second (measured in Chrome 151 by scripts/ax-assertions.mjs).
    const dealt = tableReducer(EMPTY_TABLE_STATE, { kind: 'frame', frame: handStartedFrame() });
    assert.equal(
      dealt.announcement,
      '',
      'the deal must not take the region on its own; whatever it writes there is taken back by ' +
        'the forced bets before any reader could hear it',
    );
    assert.equal(dealt.carried, DEAL_ANNOUNCEMENT, 'the sentence has to be kept for the next write');
  });

  it('carries the deal onto the front of the forced bets', () => {
    const dealt = tableReducer(EMPTY_TABLE_STATE, { kind: 'frame', frame: handStartedFrame() });
    const posted = tableReducer(dealt, { kind: 'frame', frame: forcedBetsFrame(BLINDS) });
    assert.equal(posted.announcement, `${DEAL_ANNOUNCEMENT} ${BLINDS}`);
    assert.equal(posted.carried, '', 'a carried sentence is consumed once');
  });

  it('does not say it twice — the defect on the other side', () => {
    // `role="status"` is atomic, so a sentence left in front is read again on every event (check 3.17).
    const dealt = tableReducer(EMPTY_TABLE_STATE, { kind: 'frame', frame: handStartedFrame() });
    const posted = tableReducer(dealt, { kind: 'frame', frame: forcedBetsFrame(BLINDS) });
    const next = tableReducer(posted, { kind: 'frame', frame: eventFrame('Seat 3 called 50 units') });
    assert.equal(next.announcement, 'Seat 3 called 50 units');
    assert.doesNotMatch(next.announcement, /A new hand was dealt/u);
  });

  it('mounts the narration region outside the component that draws the table', () => {
    // `PokerTable` mounts with the first view, and a live region that arrives holding its text is
    // announced by nothing.
    const stage = withoutComments(read('components', 'TableStage.tsx'));
    const table = stage.indexOf('<PokerTable');
    const region = stage.indexOf('className="prl-live-region"');
    assert.ok(region >= 0 && table >= 0, 'TableStage no longer owns the narration region');
    assert.ok(
      region < table,
      'the narration region must be mounted unconditionally, before the conditional that renders ' +
        'the table — otherwise the first hand of every session announces nothing',
    );
    assert.doesNotMatch(
      readFileSync(
        join(SRC, '..', '..', '..', 'packages', 'ui', 'src', 'components', 'PokerTable.tsx'),
        'utf8',
      ),
      /className="prl-live-region"/u,
      'putting the region back inside PokerTable puts it back inside a conditional',
    );
  });
});

const FOLD: PendingDecision = {
  action: { type: 'fold' },
  actionId: 'act-1',
  expectedSequence: 7,
  requestId: 'req-1',
};

describe('the table announces whose decision it is', () => {
  it('says so on the frame where the decision becomes the reader’s, with the figures', () => {
    const dealt = tableReducer(EMPTY_TABLE_STATE, { kind: 'frame', frame: stateFrame(DECISION_VIEW, 1) });

    // The pot, the price and the stack, the figures a sighted reader sees together.
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
    // ADR 0009 pushes the whole table on every change, and an unchanged live region is silent.
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
    // Cleared, so the next turn is a change and is announced again.
    const again = tableReducer(over, { kind: 'frame', frame: stateFrame(DECISION_VIEW, 3) });
    assert.match(again.turnAnnouncement, /^Your turn on the flop\./u);
  });

  it('says the NEW decision when one of the reader’s decisions follows straight on from another', () => {
    // The audit at 308fadf heard "Your turn preflop. 74 units to call" with Check and Bet on the flop.
    const preflop: PlayerView = { ...DECISION_VIEW, street: 'preflop', board: [] };
    const flop: PlayerView = {
      ...DECISION_VIEW,
      betLevel: 0,
      potTotal: 170,
      actionSequence: 9,
      legalActions: [
        { type: 'fold' },
        { type: 'check' },
        { type: 'bet', minTo: 10, maxTo: 935, costAtMin: 10 },
      ],
      amountToCall: 0,
    };
    const first = tableReducer(EMPTY_TABLE_STATE, { kind: 'frame', frame: stateFrame(preflop, 1) });
    const next = tableReducer(first, { kind: 'frame', frame: stateFrame(flop, 2) });
    assert.match(first.turnAnnouncement, /^Your turn preflop\./u, 'the fixture must start on preflop');
    assert.equal(
      next.turnAnnouncement,
      turnAnnouncementFor(flop),
      'a new decision is new news: carrying the last one reads a street and a price that are gone, ' +
        'and leaves the decision actually in front of the reader unannounced',
    );
    assert.match(next.turnAnnouncement, /Nothing to call/u);
  });

  it('agrees with the predicate the buttons are drawn from', () => {
    // If these disagree, the table can enable Fold while saying it is somebody else's decision.
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
    const sent = tableReducer(EMPTY_TABLE_STATE, { kind: 'submit', pending: FOLD, delivery: 'sent' });
    assert.equal(sent.announcement, 'You chose to fold.');
    assert.equal(sent.submission?.status, 'pending');
  });

  it('is replaced by the next thing the table says', () => {
    // `role="status"` is atomic, so a prefixed echo was read before every event for the street.
    const sent = tableReducer(EMPTY_TABLE_STATE, { kind: 'submit', pending: FOLD, delivery: 'sent' });
    const next = tableReducer(sent, { kind: 'frame', frame: eventFrame('Seat 3 called 50 units') });
    assert.equal(next.announcement, 'Seat 3 called 50 units');
    assert.doesNotMatch(next.announcement, /You chose/u);
  });

  it('leaves the turn sentence alone, so a refused decision can still be re-announced', () => {
    const mine = tableReducer(EMPTY_TABLE_STATE, { kind: 'frame', frame: stateFrame(DECISION_VIEW, 1) });
    const sent = tableReducer(mine, { kind: 'submit', pending: FOLD, delivery: 'sent' });
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
    // Whitespace-tolerant, because biome reflows this expression across two lines.
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

  it('wraps the server’s other refusals in an alert too, in EVERY branch', () => {
    // Both branches are checked and counted, so a third one added without an alert fails here.
    const live = withoutComments(read('app', 'play', 'LiveTable.tsx'));
    const branches = live.match(/\{table\.notice\s*(?:!==|===)\s*null/gu) ?? [];
    assert.equal(
      branches.length,
      2,
      `expected exactly two conditional renders of table.notice, found ${branches.length}. Every ` +
        'one of them has to be inside a role="alert", and this count is what stops a new branch ' +
        'from being added silently.',
    );
    assert.match(
      live,
      /\{table\.notice !== null && table\.noticeCode === 'enrolment_required' \? \(\s*<div role="alert">/u,
      'the enrolment refusal is permanent until an operator acts, so it is the one the reader most ' +
        'needs announced rather than merely drawn',
    );
    assert.match(
      live,
      /\{table\.notice !== null && table\.noticeCode !== 'enrolment_required' \? \(\s*<div role="alert">/u,
      'every other refusal keeps the generic alert it has always had',
    );
  });

  it('puts the caret on the acknowledgement when acting disables the control it was on', () => {
    // A control that becomes disabled is blurred, and the AX tree then reported `RootWebArea` holding
    // focus, so the reader heard the page title (scripts/ax-tree-audit.mjs).
    const stage = withoutComments(read('components', 'TableStage.tsx'));
    assert.match(stage, /const acknowledgementRef = useRef<HTMLDivElement \| null>\(null\);/u);
    assert.match(
      stage,
      /acknowledgementRef\.current\?\.focus\(\{ preventScroll: true \}\);/u,
      'nothing moves the caret after a decision, so it is left on the document',
    );
    // The first guard keeps a reader in the Coach panel. The second never steals legitimate focus.
    assert.match(stage, /if \(submission === null \|\| !hadFocus\.current\) return;/u);
    // `browserAbandonedFocus` is shared from `@prl/ui`, so its states are asserted where it lives.
    assert.match(
      stage,
      /if \(!browserAbandonedFocus\(\)\) return;/u,
      'the rescue must still stand down when something legitimately holds focus',
    );
    const predicate = readUi('components', 'ActionBar.tsx');
    assert.match(
      predicate,
      /export function browserAbandonedFocus\(\): boolean \{[\s\S]*?active === null[\s\S]*?\}/u,
      'browserAbandonedFocus no longer treats a null activeElement as abandoned',
    );
    for (const state of ['document\\.body', 'document\\.documentElement']) {
      assert.match(
        predicate,
        new RegExp(
          `export function browserAbandonedFocus\\(\\): boolean \\{[\\s\\S]*?${state}[\\s\\S]*?\\}`,
          'u',
        ),
        `browserAbandonedFocus must recognise ${state} as abandoned focus — Chrome uses both`,
      );
    }
  });

  it('gives the caret somewhere with a name to land on', () => {
    // A bare focusable `<div>` computes an empty accessible name (measured in Chrome 151).
    const stage = withoutComments(read('components', 'TableStage.tsx'));
    assert.match(
      stage,
      /aria-label="What happened to your decision"\s+className="prl-play__ack"\s+ref=\{acknowledgementRef\}\s+role="status"\s+tabIndex=\{-1\}/u,
    );
  });

  it('keeps the turn region polite, because a turn is not an emergency', () => {
    const stage = read('components', 'TableStage.tsx');
    assert.match(stage, /aria-atomic="true" aria-live="polite" className="prl-live-region" role="status"/u);
    // One assertive channel per screen. Asserted over code, because a comment explains it in prose.
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
    // "Invalid" means the input, never a wrong but well-formed answer.
    assert.match(
      quiz,
      /const malformed = badInput \|\| \(draft\.trim\(\) !== '' && !Number\.isFinite\(parsed\)\);/u,
    );
    // A number input reports `value === ''` for text it could not parse, so a draft-only check never fires.
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

/**
 * Live Coach goes off in two unrelated ways. The page knows the difficulty only when it opened an
 * Expert Legends match itself. A `coach_not_available` refusal carries no difficulty, so it must not
 * print the Expert sentence (measured in Chrome 151, where plain `/play` printed it).
 */
describe('the Coach panel says the reason that applies, not the one that reads best', () => {
  const REFUSAL =
    'The Coach is available in review after the hand, not while it is being played at this difficulty.';

  const refusedState = (): ReturnType<typeof tableReducer> => {
    const asked = tableReducer(EMPTY_TABLE_STATE, {
      kind: 'coachRequested',
      requestId: 'coach-1',
      key: '',
    });
    return tableReducer(asked, {
      kind: 'frame',
      frame: {
        type: 'error',
        requestId: 'coach-1',
        error: { code: 'coach_not_available', message: REFUSAL, requestId: 'coach-1' },
      },
    });
  };

  it('keeps the server’s own wording for a refusal, rather than throwing it away', () => {
    assert.equal(EMPTY_TABLE_STATE.coachRefusal, null, 'nothing has been refused yet');
    assert.equal(refusedState().coachRefusal, REFUSAL);
  });

  it('does not treat any other refusal as a statement about the difficulty', () => {
    const asked = tableReducer(EMPTY_TABLE_STATE, {
      kind: 'coachRequested',
      requestId: 'coach-2',
      key: '',
    });
    const rateLimited = tableReducer(asked, {
      kind: 'frame',
      frame: {
        type: 'error',
        requestId: 'coach-2',
        error: {
          code: 'rate_limited',
          message: 'You are doing that too quickly. Give it a moment.',
          requestId: 'coach-2',
        },
      },
    });
    assert.equal(rateLimited.coachRefusal, null);
    assert.equal(rateLimited.coachDuringHand, true, 'a rate limit does not turn live Coach off');
  });

  it('resets with the table, so a fresh table does not inherit another table’s refusal', () => {
    const reset = tableReducer(refusedState(), { kind: 'reset' });
    assert.equal(reset.coachRefusal, null);
    assert.equal(reset.coachDuringHand, true);
  });

  it('routes the two causes to two sentences, and only one of them names Expert', () => {
    const hook = read('lib', 'use-live-table.ts');
    const panel = read('app', 'play', 'LiveTable.tsx');

    // Expert first, because this page opened that match and the difficulty is its own parameter.
    assert.match(hook, /options\.legendMatch\?\.difficulty === 'expert'\s*\?\s*\{ kind: 'expertLegends' \}/u);
    assert.match(hook, /kind: 'refusedByServer', serverReason: table\.coachRefusal/u);

    assert.match(
      withoutComments(panel),
      /off\.kind === 'expertLegends' \? EXPERT_COACH_REASON : refusedCoachReason\(off\.serverReason\)/u,
    );
    // A refusal must not mention a difficulty this page never saw.
    assert.doesNotMatch(
      withoutComments(panel).replace(/const EXPERT_COACH_REASON =[\s\S]*?';/u, ''),
      /Expert keeps the analysis off the table/u,
      'the Expert wording appears somewhere other than the one constant it belongs to',
    );

    // NEGATIVE CONTROL: the old mapping, fed to the same detector.
    const old = 'if (!live.coachDuringHand) return { coachUnavailableReason: EXPERT_COACH_REASON };';
    assert.doesNotMatch(
      withoutComments(panel),
      /if \(!live\.coachDuringHand\) return \{ coachUnavailableReason: EXPERT_COACH_REASON \};/u,
    );
    assert.match(
      old,
      /if \(!live\.coachDuringHand\) return \{ coachUnavailableReason: EXPERT_COACH_REASON \};/u,
      'the detector does not fire on the line it exists to refuse',
    );
  });
});

'use client';

/**
 * The play screen's stage: the table, the decision controls, and the Coach — arranged so that the
 * four things a decision needs are on screen at the same time.
 *
 * ## The functional requirement this layout exists to satisfy
 *
 * Design system section 10: at 1280px and above, a player must be able to see **the pot, their own
 * cards, the price, and the Coach's equity figure at the same time.** That is not an aesthetic
 * preference — a layout that forces a scroll to compare the price with the equity has broken the
 * product, because comparing those two numbers *is* the decision.
 *
 * Four structural guarantees, rather than a height calculation that a taller seat plate would
 * quietly break:
 *
 *   1. **The price** is in the ActionBar, and the ActionBar is the last block in the table column,
 *      directly under the field. It is NOT pinned, and that is deliberate: a bottom-pinned band
 *      occupies `viewport-bottom − H … viewport-bottom` for the whole of its pinned range, so the
 *      block immediately above it in flow ends inside that strip by definition, for any height. The
 *      band used to be `position: sticky` and it covered the pot, the board, the dealer button and
 *      all six seats at every common desktop size. `styles/play.css` now sizes it down by container
 *      query and intrinsic reflow instead — nothing is hidden at any width — and
 *      `packages/ui/test/layout-guarantees.test.ts` asserts `.prl-play__decision` carries no
 *      `position: sticky/fixed/absolute`. **Do not re-pin this band.** If the price seems to scroll
 *      away, the answer is a shorter band, not a pinned one.
 *   2. **The pot** is in that same band, in the ActionBar's price strip ("In the pot"), as well as in
 *      the middle of the table.
 *   3. **Your cards** are in the band's own readout at 900px and above. They also appear on the seat
 *      plate at the bottom of the oval — the duplication is deliberate and it is what buys the
 *      guarantee, because a plate positioned inside a 32rem field can be below the fold on a short
 *      viewport. Below 900px the readout is hidden, because the stacked table already pins the
 *      viewer's plate directly above this band and showing the cards twice a centimetre apart is
 *      noise.
 *   4. **The Coach's equity figure** is the first thing in the Coach panel, and the rail is
 *      `position: sticky` from 900px up with its own scroll region. The top of the panel is always
 *      the top of the rail.
 *
 * Nothing here measures the viewport, and no height is asserted in JavaScript. One sticky element —
 * the Coach rail — a short decision band and a source order do the whole job.
 *
 * ## Under 600px: the Coach is a bottom sheet
 *
 * A rail does not fit on a phone and a panel below the table would put the equity figure a screen
 * away from the buttons, so the Coach becomes a sheet pinned to the bottom edge with a grab handle.
 * Three things make that safe rather than a way of hiding the caveats:
 *
 *   - The handle is a real `<button>` with `aria-expanded`, so it works from the keyboard. The swipe
 *     is an enhancement on top of it, never the only way in.
 *   - A caveat line sits *beside the handle*, visible in both states: the figures rest on stated
 *     assumptions, and the panel is where they are. The panel's own rule — the assumptions are never
 *     collapsible — is about the panel's internals; this is a viewport container, and the honest way
 *     to run one is to keep the warning on screen even when the detail is not.
 *   - Focus moving into the collapsed sheet expands it, so a keyboard user can never land on a
 *     control that is off-screen (WCAG 2.4.11). That is focus *causing* a reveal, which is fine;
 *     nothing here ever moves focus itself, which would not be.
 *
 * ## Acting
 *
 * `onAct` is optional. Without it the stage is running from a fixture, and submitting a decision
 * disables the controls and says plainly that nothing was sent — it does not simulate the
 * consequences. Simulating them would mean re-implementing the betting rules in the browser, and the
 * server is the only authority on a hand. A client that guessed at the result of its own action is
 * how a UI ends up disagreeing with the table it is drawing.
 *
 * With `onAct` there is a server, and then `submission` decides what the band says. The caller owns
 * it, because only the caller knows whether the frame has been acknowledged: `pending` while the
 * `action` frame is unanswered, `accepted` when the `ack` arrives (including the `deduplicated`
 * case, where a retry landed on a decision already applied), `rejected` when the server refused —
 * `stale_action_sequence`, `not_your_turn`, `illegal_action`. The message is passed through rather
 * than written here, so what the reader is told is what the server actually said.
 *
 * The other two statuses are about frames the server never saw, and they exist because reporting
 * those as `pending` was a defect: `held` when there is no connection and the caller will replay the
 * decision on reconnect, `not-sent` when the caller itself refused to send it. See `TableSubmission`.
 *
 * ## The three things this screen says out loud, and why they are three
 *
 * Every one of them is fed from a diff computed in `lib/use-live-table.ts`, never from a frame: see
 * that file's header for why a whole-state protocol makes that mandatory.
 *
 *  1. **The table's narration** — `announcement`, polite, in the single region `TableRegion` mounts
 *     unconditionally. Dealt, bet, called, street, showdown, hand complete, and the echo of the
 *     reader's own decision. It is mounted whether or not there is a table to draw, because the
 *     frames that start a hand bring the first sentence and the first view in one commit and a
 *     region that arrives with its text is announced by nothing — see the comment on the region.
 *  2. **Whose decision it is** — `turnAnnouncement`, polite, in its own region beside the controls.
 *     Separate from (1) because the two race: the `state` frame that makes it the reader's turn and
 *     the `event` frame describing the action that got there arrive back to back, and one region
 *     would let either overwrite the other. It carries the pot, the price, the stack and the legal
 *     actions, because that is the whole of the decision.
 *  3. **A refusal** — `role="alert"`, mounted only when a decision was refused and the reader has to
 *     act again: the server rejected it, or this page never sent it. Assertive because the reader
 *     has acted and the table did NOT move: they are waiting for something that is not coming, and
 *     every other channel on this screen is polite. The accepted, pending and held states are
 *     deliberately silent here — (1) already echoes the decision, "the server applied it at sequence
 *     41" is a sentence nobody needs read to them, and a held decision is one the reader can do
 *     nothing about and does not need to.
 *
 * The error state's own `role="alert"` (see `TableRegion`) is the fourth, and it replaces the table
 * rather than describing it.
 */

import type { CoachReport } from '@prl/contracts';
import {
  ActionBar,
  browserAbandonedFocus,
  Callout,
  CardRow,
  CoachPanel,
  formatChips,
  type PlayerView,
  PokerTable,
  type StyleWithVars,
  type TableAction,
  type TurnClock,
} from '@prl/ui';
import { type FocusEvent, type PointerEvent, type ReactElement, useEffect, useRef, useState } from 'react';
// A value import from the module that holds this file's `TableSubmission` type. It is not a cycle:
// that import is `import type`, which is erased before anything runs, and the sentence a decision
// is announced with has to have exactly one definition or the live path and the fixture path drift.
import { spokenDecision } from '@/lib/use-live-table.ts';

/**
 * Two input-gesture constants.
 *
 * These are not design values and they are not on the token ramp: they describe a *pointing device*,
 * in the same category as a double-click interval. `SWIPE_SLOP_PX` is how far a finger may wander
 * before a tap counts as a drag; `SWIPE_COMMIT_PX` is how far it must travel to change the sheet's
 * state. Neither one is ever painted.
 *
 * How far the sheet visibly moves during the drag is a different question, and that one *is* a
 * design value — so it is clamped in CSS from tokens (`--prl-play-sheet-travel` in
 * `styles/play.css`) and this component only publishes the raw pointer delta as
 * `--prl-play-sheet-drag`.
 */
const SWIPE_SLOP_PX = 6;
const SWIPE_COMMIT_PX = 28;

export type TableStageStatus = 'loading' | 'ready' | 'error' | 'complete';

/**
 * A decision the caller has sent to a server, and what became of it.
 *
 * Only meaningful alongside `onAct`. `pending` and `held` are the statuses that disable the
 * controls: once the server has answered, the next `state` frame decides whether it is this seat's
 * turn again, and that answer is `view.legalActions`, not a flag held here.
 *
 * ## Why "sent" and "not sent" are five statuses rather than three
 *
 * `pending` used to cover every decision the caller had dispatched, whether or not the frame
 * actually left the browser, and the caller announced a rate limit separately when it had not. A
 * reader who pressed Fold during a reconnect therefore got "Decision sent" and "The decision was
 * not sent" at once, in two different live regions, with the wrong cause attached to the second.
 * See `SUBMISSION_FOR` in `lib/use-live-table.ts`.
 *
 * The two new members are the two honest answers that were missing:
 *
 *  - `held` — nothing was sent, and nothing is lost. The connection is down and the decision is
 *    replayed, unchanged, when it returns. The controls stay disabled, because it IS going to be
 *    applied.
 *  - `not-sent` — nothing was sent and nothing is holding it: this page refused it (its own rate
 *    limiter, or a frame it could not put on the wire). The reader decides again, so the controls
 *    come back and the message is an alert rather than a status.
 */
export interface TableSubmission {
  readonly action: TableAction;
  readonly status: 'pending' | 'held' | 'accepted' | 'rejected' | 'not-sent';
  /** What the reader is told. The server's own wording where the server had any. */
  readonly message: string;
}

export interface TableStageProps {
  readonly status: TableStageStatus;
  /** The server's redacted view. Null while loading or after a failure. */
  readonly view: PlayerView | null;
  /** The analysis of the decision in `view`. Null while loading or after a failure. */
  readonly report: CoachReport | null;
  /** The server's turn deadline, when there is one. */
  readonly turn?: TurnClock | null;
  readonly seatNames?: Readonly<Record<number, string>>;
  /** One sentence for the table's single polite live region. */
  readonly announcement?: string;
  /**
   * One sentence for the region that says the decision is the reader's, with the figures it needs.
   *
   * Empty whenever it is not. The caller diffs frames to produce it — see `turnAnnouncementFor` in
   * `lib/use-live-table.ts` — because this component sees one frame at a time and cannot tell a
   * turn that has just begun from a turn that is still running.
   */
  readonly turnAnnouncement?: string;
  /** Cards to ring, e.g. the five that made a hand. */
  readonly highlightedCards?: readonly number[];
  /** What the ring means, announced with each marked card. */
  readonly highlightLabel?: string;
  /** Plain sentences about how a completed hand ended. */
  readonly summary?: readonly string[];
  readonly errorMessage?: string;
  /**
   * Sends a decision. Omit it and the stage runs from a fixture: acting disables the controls and
   * says so rather than pretending to apply the action.
   */
  readonly onAct?: (action: TableAction) => void;
  /**
   * The fate of the last decision, when a caller is tracking it.
   *
   * Supplying it hands the in-flight state to the caller entirely — the stage stops keeping its own,
   * because the stage cannot know when a frame was acknowledged. Omit it (the fixture path) and the
   * stage falls back to "you pressed a button and nothing was sent", which is the truth there.
   */
  readonly submission?: TableSubmission | null;
  /**
   * Why the Coach panel has nothing in it, when the caller knows a better answer than the default.
   *
   * A refused analysis and an analysis that was never asked for look identical to this component,
   * and they are not the same thing to a reader waiting for one.
   */
  readonly coachUnavailableReason?: string;
}

/** Skeletons at the real content's dimensions, so nothing reflows when the data lands. */
function StageSkeleton(): ReactElement {
  return (
    <div className="prl-play__skeletons">
      <span className="prl-skeleton prl-play__skeleton--header" />
      <span className="prl-skeleton prl-play__skeleton--field" />
      <p className="prl-play__skeleton-note">Loading the table.</p>
    </div>
  );
}

function CoachSkeleton(): ReactElement {
  return (
    <div className="prl-play__skeletons">
      <span className="prl-skeleton prl-play__skeleton--metric" />
      <span className="prl-skeleton prl-play__skeleton--panel" />
      <p className="prl-play__skeleton-note">Loading the analysis.</p>
    </div>
  );
}

/**
 * What stands in for the panel when there is no report and none is coming.
 *
 * Not a skeleton. A skeleton is a promise that content is arriving, and leaving one on screen after a
 * failure is a lie that never resolves — the reader waits for a panel that will never appear. The
 * empty state says what happened and, crucially, does not offer a number: an analysis is only worth
 * anything with the state it was computed from, and that state is what went missing.
 */
function CoachUnavailable({ reason }: { readonly reason: string | undefined }): ReactElement {
  return (
    <div className="prl-empty">
      <p className="prl-label">No analysis</p>
      <p>
        {reason ??
          'The Coach prices the decision in front of you, so with no table state there is nothing to price.'}
      </p>
      <p>
        Nothing is estimated from a partial view — a figure without the spot it came from cannot be checked,
        and an unverifiable figure is worse than none.
      </p>
    </div>
  );
}

interface HeroReadoutProps {
  readonly view: PlayerView;
}

/**
 * Your cards, your stack, and what you have in front of you — beside the buttons that change them.
 *
 * Guarantee 3 in the module comment. It is not a second copy of the seat plate: it is the three
 * figures a decision is made from, in the band that holds the controls — so they are beside the
 * buttons rather than somewhere inside a 32rem field that may have scrolled past.
 */
function HeroReadout({ view }: HeroReadoutProps): ReactElement | null {
  const hero = view.seats.find((seat) => seat.isSelf);
  if (hero === undefined || hero.holeCards === null) return null;

  return (
    <div className="prl-play__hud">
      <CardRow cards={hero.holeCards} label="Your cards" size="md" tight />
      <dl className="prl-play__hud-stats">
        <dt className="prl-label">Your stack</dt>
        <dd className="prl-play__hud-value">{formatChips(hero.stack)}</dd>
        <dt className="prl-label">
          {'In front'}
          <span className="prl-visually-hidden">{' this street'}</span>
        </dt>
        <dd className="prl-play__hud-value">{formatChips(hero.committedThisStreet)}</dd>
      </dl>
    </div>
  );
}

interface TableRegionProps {
  readonly status: TableStageStatus;
  readonly view: PlayerView | null;
  readonly turn: TurnClock | null;
  readonly seatNames: Readonly<Record<number, string>> | undefined;
  readonly highlightedCards: readonly number[] | undefined;
  readonly highlightLabel: string | undefined;
  readonly announcement: string;
  readonly summary: readonly string[] | undefined;
  readonly errorMessage: string | undefined;
}

/** The table, or the skeleton or the error that stands in for it. Exactly one of the three. */
function TableRegion(props: TableRegionProps): ReactElement {
  const { status, view, turn, seatNames, highlightedCards, highlightLabel } = props;
  const { announcement, summary, errorMessage } = props;
  const hasSummary = status === 'complete' && summary !== undefined && summary.length > 0;

  return (
    <div className="prl-play__table">
      {/*
        The table's narration, and it is HERE rather than inside `PokerTable` because of when it has
        to exist.

        A live region is announced when the platform is told a region it already knows about has
        changed. One that is inserted already holding its first sentence is silent. `PokerTable` is
        rendered only once a `view` has arrived — and the frames that start a hand carry the events
        and the first view in a single React commit, so the region used to be created already
        carrying "smallBlind 5 from seat 3, bigBlind 10 from seat 4" and a reader heard nothing at
        all on the first hand of every session. Measured by `scripts/ax-assertions.mjs` at the moment
        "Deal the next hand" was pressed: the document's live regions were the route announcer, the
        connection line, the invite and join notes, the decision band's turn region and the footer
        statement — and no table narration region at all.

        Mounted unconditionally and empty, it is the same rule `RouteAnnouncer`, the quiz and the
        invite-code copy button already follow. It stays before the table in the DOM so the
        narration is queued ahead of anything the table itself changes in the same commit.

        The two rules that governed it in `PokerTable` are unchanged: polite, because a new street
        is not an emergency; and focus is never moved, because yanking the caret on every remote
        update makes a table unusable from the keyboard.
      */}
      <div aria-atomic="true" aria-live="polite" className="prl-live-region" role="status">
        {announcement}
      </div>

      {status === 'loading' ? <StageSkeleton /> : null}

      {/*
        `role="alert"` is load-bearing, not decoration.

        This block replaces the table on the app's most consequential failure path, and it used to
        be an unlabelled `<div>` with no live-region ancestor. A screen-reader user therefore heard
        nothing when it appeared — while the connection panel's `role="status"`, the only live
        region on the page, was still politely reading "Ready to connect." They were told the
        opposite of what the screen said. That is a WCAG 2.2 SC 4.1.3 (AA) failure, and it was
        found in a release audit rather than by a test.

        Two properties make this work, and both must be kept:

          1. **The node is mounted only in the error state.** A `role="alert"` that is always in
             the DOM and merely changes its text is announced far less reliably; an alert fires on
             insertion. `status === 'error'` is the only thing that puts it here, so the insertion
             and the error are the same event.
          2. **The status region cannot contradict it.** `statusSentence` in
             `src/app/play/LiveTable.tsx` now names a failed setup instead of falling through to
             "Ready to connect." — see the comment there. An assertive alert and a polite status
             that disagree is worse than either alone.

        `role="alert"` implies `aria-live="assertive"` and `aria-atomic="true"`, so the whole block
        is read as one message. Nothing else on this screen is assertive, which is what keeps that
        interruption meaningful.
      */}
      {status === 'error' ? (
        <div className="prl-error" role="alert">
          <p className="prl-error__title">
            <span aria-hidden="true">{'▲ '}</span>
            Error — table unavailable
          </p>
          <p>{errorMessage ?? 'The table could not be reached.'}</p>
        </div>
      ) : null}

      {view === null || status === 'loading' ? null : (
        <PokerTable
          view={view}
          {...(seatNames === undefined ? {} : { seatNames })}
          {...(highlightedCards === undefined ? {} : { highlightedCards })}
          {...(highlightLabel === undefined ? {} : { highlightLabel })}
          turn={turn}
        />
      )}

      {hasSummary ? (
        <Callout tone="insight" title="How the hand ended">
          <ul className="prl-play__summary">
            {summary.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p className="prl-play__summary-note">
            The result of one hand says almost nothing about the decision that produced it. The analysis
            beside this table is where the useful feedback is.
          </p>
        </Callout>
      ) : null}
    </div>
  );
}

interface DecisionBandProps {
  readonly status: TableStageStatus;
  readonly view: PlayerView | null;
  readonly submission: TableSubmission | null;
  readonly turnAnnouncement: string;
  readonly isLive: boolean;
  readonly onAct: (action: TableAction) => void;
}

/**
 * The heading for each fate a decision can meet.
 *
 * Each names WHO decided. "Decision sent" and "The server refused it" are about the server; "Held —
 * no connection to the table" and "This page did not send it" are about this browser, and saying so
 * is the difference between a reader waiting for a reconnect and a reader deciding again. A title
 * that blamed the server for a frame the server never saw was the defect here.
 */
const SUBMISSION_TITLE: Readonly<Record<TableSubmission['status'], string>> = {
  pending: 'Decision sent',
  held: 'Held — no connection to the table',
  accepted: 'Decision applied',
  rejected: 'The server refused it',
  'not-sent': 'This page did not send it',
};

/**
 * The fates that need interrupting for, and the ones that do not.
 *
 * A refusal the reader has to act on is an alert; "sent", "held" and "applied" are a polite status,
 * because the reader has nothing to do about any of them and interrupting to confirm that a fold
 * worked is how an alert stops meaning anything. `not-sent` is here with `rejected` for one reason:
 * the controls are live again and nothing else on screen says the decision has gone.
 */
const SUBMISSION_ALERTS: ReadonlySet<TableSubmission['status']> = new Set<TableSubmission['status']>([
  'rejected',
  'not-sent',
]);

/** The statuses that keep the controls disabled: something is still going to happen to the decision. */
const SUBMISSION_IN_FLIGHT: ReadonlySet<TableSubmission['status']> = new Set<TableSubmission['status']>([
  'pending',
  'held',
]);

/**
 * Your own figures, the controls, and the price — the last block in the table column.
 *
 * Guarantees 1 to 3 in the module comment live here. Nothing about its position is set in
 * JavaScript, and nothing about it is pinned: see guarantee 1 for why a pinned band is the defect
 * rather than the feature, and for the test that now holds that line.
 */
function DecisionBand(props: DecisionBandProps): ReactElement {
  const { status, view, submission, turnAnnouncement, isLive, onAct } = props;
  const pending = submission !== null && SUBMISSION_IN_FLIGHT.has(submission.status);
  const rejected = submission !== null && SUBMISSION_ALERTS.has(submission.status);

  /**
   * Where the caret goes the instant a decision is submitted.
   *
   * ## The defect, found by `scripts/ax-tree-audit.mjs`
   *
   * Pressing Fold sets `submission.status = 'pending'`, which disables every control in the
   * `ActionBar` — correctly, the server has not answered yet. A browser blurs a focused control the
   * moment it becomes disabled, and there is nothing else in the band for it to land on, so
   * `document.activeElement` becomes the document. Read out of the computed accessibility tree that
   * is a `RootWebArea` holding focus, named after the page title, which is what a reader actually
   * gets: they press a button, and the next thing announced is the name of the page they were
   * already on. Every remaining control is then a whole tab sequence away.
   *
   * `ActionBar` has its own rescue and it does not cover this: it fires when `legalActions` goes
   * EMPTY, which happens when the server's next frame arrives. The gap is the whole round trip —
   * and on the fixture path, where there is no server, it is permanent.
   *
   * ## Why the acknowledgement is the right destination
   *
   * It is the block that says what became of the decision — "Sent. The server is the only authority
   * on a hand, so the controls stay disabled until it answers." — so a reader who is moved there is
   * moved to the answer to the question they just asked. `tabIndex={-1}` makes it a target for
   * script and deliberately not a tab stop: nobody tabbing through a table should have to pass a
   * status line on the way to the buttons.
   *
   * Both guards are load-bearing, and they are the two `ActionBar` uses for the same reason. Focus
   * moves only if it was inside this band, so a table that updates while the reader is in the Coach
   * panel never yanks them back; and only if the browser has actually given up, so anything that
   * legitimately took focus keeps it.
   */
  const acknowledgementRef = useRef<HTMLDivElement | null>(null);
  const hadFocus = useRef(false);
  const onFocusCapture = (): void => {
    hadFocus.current = true;
  };
  const onBlurCapture = (event: FocusEvent<HTMLDivElement>): void => {
    const next = event.relatedTarget;
    // Null means the focused node was removed or disabled, not that the reader went elsewhere.
    if (next !== null && !event.currentTarget.contains(next)) hadFocus.current = false;
  };

  useEffect(() => {
    if (submission === null || !hadFocus.current) return;
    // Chrome after disabling a focused button: `activeElement` can be `<html>`, not
    // `document.body`. Both mean the caret is on the document. A real control or panel must win.
    // Shared with `ActionBar` and `LiveTable` rather than copied — this was right and the copy in
    // `LiveTable` was a version behind, which is the argument for having one of these.
    if (!browserAbandonedFocus()) return;
    acknowledgementRef.current?.focus();
    hadFocus.current = false;
  }, [submission]);

  return (
    <div className="prl-play__decision" onBlurCapture={onBlurCapture} onFocusCapture={onFocusCapture}>
      {/*
        Announcement 2 of 3 (see the module comment). In the DOM from the first render and empty,
        never conditionally mounted, because a polite region that arrives with its text is missed by
        several screen readers. It sits beside the controls rather than at the top of the stage so
        that a reader browsing the page meets the sentence where the decision is made.
      */}
      <div aria-atomic="true" aria-live="polite" className="prl-live-region" role="status">
        {turnAnnouncement}
      </div>

      {view === null ? null : <HeroReadout view={view} />}

      {view === null ? (
        <p className="prl-play__decision-idle">
          {status === 'error' ? 'No controls while the table is unreachable.' : 'Waiting for the table.'}
        </p>
      ) : (
        <ActionBar
          legalActions={view.legalActions}
          onAct={(action) => {
            hadFocus.current = true;
            onAct(action);
          }}
          pot={view.potTotal}
          toCall={view.amountToCall}
          committedThisStreet={view.seats.find((seat) => seat.isSelf)?.committedThisStreet ?? 0}
          disabled={pending}
          idleText={
            status === 'complete'
              ? 'This hand is complete. Nothing is owed and there is nothing to decide.'
              : 'Waiting for another player to act.'
          }
        />
      )}

      {/*
        Announcement 3 of 3. The refusal is the one thing on this screen that has to interrupt.

        The reader has pressed a button, the controls came back, and NOTHING happened — a stale
        sequence, a spot that was not theirs, an amount the engine would not take. Before this, that
        block was a `Callout` with no live-region ancestor at all: the whole message existed only as
        pixels, and the polite regions beside it were busy narrating a table that had not moved.

        Mounted ONLY in the states that need acting on — `SUBMISSION_ALERTS` — which is what makes it
        fire: an alert is announced on insertion, and an always-present node whose text merely
        changes is announced far less reliably. `not-sent` is in that set beside `rejected` because
        it has the same shape from the reader's side: the controls are live again and nothing was
        applied. The accepted, pending and held states keep the plain `Callout` below, deliberately:
        the table's own region already echoes the decision, and interrupting a reader to tell them
        their fold worked — or that it is queued behind a reconnect they can do nothing about — is
        how an alert stops meaning anything.
      */}
      {/*
        One wrapper for both fates, so the focus rescue above has a single destination whatever the
        server said. `tabIndex={-1}` keeps it out of the tab order and lets script land on it.

        `role="status"` with a label, rather than a bare focusable `<div>` or a `role="group"`.
        A bare one has no role that can carry a name. A focused `group` computes a name but is
        NOT reported as the focused accessibility-tree node in Chrome 151 — the tree keeps
        `RootWebArea` focused, so a screen reader is told the page title. `status` is exposed as
        focused and can carry the label.

        Rendered only when there is something to say. An always-present labelled status would sit in
        every reader's rotor announcing an empty container on a table where nothing has been decided.
      */}
      {submission === null ? null : (
        <div aria-label="What happened to your decision" ref={acknowledgementRef} role="status" tabIndex={-1}>
          {rejected ? (
            <div role="alert">
              {/*
                The title is read off the status, not fixed to `rejected`. Two different refusals
                arrive here — the server's, and this page's own — and a heading that says "The
                server refused it" about a frame the server never received tells the reader to go
                and look at the wrong thing.
              */}
              <Callout
                tone="warning"
                title={isLive ? SUBMISSION_TITLE[submission.status] : 'Nothing was sent'}
              >
                {submission.message}
              </Callout>
            </div>
          ) : (
            <Callout
              // `held` is a caveat rather than an insight: nothing is lost, but the table is not
              // reachable and the reader is entitled to see that at a glance.
              tone={isLive && submission.status !== 'held' ? 'insight' : 'warning'}
              title={isLive ? SUBMISSION_TITLE[submission.status] : 'Nothing was sent'}
            >
              {submission.message}
            </Callout>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The Coach: a rail from 900px, a panel from 600px, a bottom sheet below that.
 *
 * All three are the same markup. Which one it is, is decided entirely in `styles/play.css` — this
 * component owns only the sheet's open state and the swipe, and both are inert above 600px because
 * the CSS drops the transform and hides the handle there.
 */
interface CoachSheetProps {
  readonly report: CoachReport | null;
  readonly status: TableStageStatus;
  /** Why there is no report, when the caller knows something better than "there is none". */
  readonly coachUnavailableReason: string | undefined;
}

function CoachSheet({ report, status, coachUnavailableReason }: CoachSheetProps): ReactElement {
  const [open, setOpen] = useState(false);
  const [dragPx, setDragPx] = useState<number | null>(null);
  const dragStart = useRef<number | null>(null);
  const dragMoved = useRef(false);
  const handleRef = useRef<HTMLButtonElement | null>(null);

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>): void => {
    if (!event.isPrimary) return;
    dragStart.current = event.clientY;
    dragMoved.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: PointerEvent<HTMLButtonElement>): void => {
    const start = dragStart.current;
    if (start === null) return;
    const delta = event.clientY - start;
    if (Math.abs(delta) > SWIPE_SLOP_PX) dragMoved.current = true;
    // Direction only: an open sheet can be pushed down, a closed one pulled up. How far it actually
    // moves is clamped in CSS, from tokens.
    setDragPx(open ? Math.max(delta, 0) : Math.min(delta, 0));
  };

  const endDrag = (event: PointerEvent<HTMLButtonElement>): void => {
    const start = dragStart.current;
    dragStart.current = null;
    setDragPx(null);
    if (start === null) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const delta = event.clientY - start;
    if (delta <= -SWIPE_COMMIT_PX) setOpen(true);
    else if (delta >= SWIPE_COMMIT_PX) setOpen(false);
  };

  const onHandleClick = (): void => {
    // A swipe ends with a click on most touch stacks, and committing twice would undo the gesture.
    if (dragMoved.current) {
      dragMoved.current = false;
      return;
    }
    setOpen((current) => !current);
  };

  /** Focus arriving inside a collapsed sheet reveals it, so no control is ever focused off-screen. */
  const onFocusWithin = (event: FocusEvent<HTMLDivElement>): void => {
    if (open) return;
    const target = event.target;
    if (target instanceof Node && handleRef.current?.contains(target) === true) return;
    setOpen(true);
  };

  const style: StyleWithVars | undefined =
    dragPx === null ? undefined : { '--prl-play-sheet-drag': `${dragPx}px` };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: onFocus is a reveal for keyboard users, not a control; the control is the <button> inside
    <div
      className="prl-play__coach"
      data-open={open ? 'true' : 'false'}
      style={style}
      onFocus={onFocusWithin}
    >
      <div className="prl-play__handle-row">
        <button
          ref={handleRef}
          type="button"
          className="prl-play__handle"
          aria-expanded={open}
          onClick={onHandleClick}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <span className="prl-play__handle-grip" aria-hidden="true" />
          <span className="prl-play__handle-word">{open ? 'Hide the analysis' : 'Show the analysis'}</span>
        </button>
        <p className="prl-play__handle-note">
          Every figure in the panel rests on stated assumptions. They are at the bottom of it, and they are
          never hidden.
        </p>
      </div>

      <div className="prl-play__coach-body">
        {report !== null ? (
          <CoachPanel report={report} />
        ) : status === 'loading' ? (
          <CoachSkeleton />
        ) : (
          <CoachUnavailable reason={coachUnavailableReason} />
        )}
      </div>
    </div>
  );
}

export function TableStage(props: TableStageProps): ReactElement {
  const {
    status,
    view,
    report,
    turn = null,
    seatNames,
    announcement,
    turnAnnouncement = '',
    highlightedCards,
    summary,
    errorMessage,
    onAct,
  } = props;
  const highlightLabel = props.highlightLabel;
  const isLive = onAct !== undefined;

  /**
   * The fixture path's own record of a press, used only when nobody is tracking a real one.
   *
   * A caller with a server passes `submission` and this stays null forever; a caller without one has
   * nothing to track, so the stage records the press itself in order to say plainly that it went
   * nowhere.
   */
  const [pressed, setPressed] = useState<TableSubmission | null>(null);
  const submission = props.submission !== undefined ? props.submission : isLive ? null : pressed;

  const act = (action: TableAction): void => {
    if (props.submission === undefined && !isLive) {
      setPressed({
        action,
        status: 'pending',
        message:
          'This table is a typed fixture with no server behind it, so the decision was not applied. ' +
          'The controls are disabled to show the state a real table would be in while it waited for ' +
          'confirmation.',
      });
    }
    if (onAct !== undefined) onAct(action);
  };

  /**
   * What the table's polite region says.
   *
   * On the live path this is exactly what the caller sent, because the caller's reducer has already
   * folded the reader's own decision into it as a state change. This used to CONCATENATE the
   * decision echo onto the front of every announcement instead — and `role="status"` is atomic, so
   * the region was re-read whole on every table event with "You chose to fold." stapled to the front
   * of it until the submission cleared. One press, then a sentence repeated on every frame of the
   * rest of the street.
   *
   * `pressed` is only ever non-null on the fixture path (see `submission` above), where there is no
   * reducer to have done it, so the concatenation survives for exactly that case — and there the
   * fixture's own announcement is a constant that has already been read.
   */
  const spoken =
    pressed === null ? (announcement ?? '') : `${spokenDecision(pressed.action)} ${announcement ?? ''}`;

  return (
    <div className="prl-play__stage" data-state={status}>
      <div className="prl-play__main">
        <TableRegion
          status={status}
          view={view}
          turn={turn}
          seatNames={seatNames}
          highlightedCards={highlightedCards}
          highlightLabel={highlightLabel}
          announcement={spoken}
          summary={summary}
          errorMessage={errorMessage}
        />
        <DecisionBand
          status={status}
          view={view}
          submission={submission}
          turnAnnouncement={turnAnnouncement}
          isLive={isLive}
          onAct={act}
        />
      </div>

      <CoachSheet report={report} status={status} coachUnavailableReason={props.coachUnavailableReason} />
    </div>
  );
}

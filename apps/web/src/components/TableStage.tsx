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
 */

import type { CoachReport } from '@prl/contracts';
import {
  ActionBar,
  Callout,
  CardRow,
  CoachPanel,
  formatChips,
  formatUnits,
  type PlayerView,
  PokerTable,
  type StyleWithVars,
  type TableAction,
  type TurnClock,
} from '@prl/ui';
import { type FocusEvent, type PointerEvent, type ReactElement, useRef, useState } from 'react';

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
 * Only meaningful alongside `onAct`. `pending` is the only status that disables the controls: once
 * the server has answered, the next `state` frame decides whether it is this seat's turn again, and
 * that answer is `view.legalActions`, not a flag held here.
 */
export interface TableSubmission {
  readonly action: TableAction;
  readonly status: 'pending' | 'accepted' | 'rejected';
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
      {status === 'loading' ? <StageSkeleton /> : null}

      {status === 'error' ? (
        <div className="prl-error">
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
          announcement={announcement}
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
  readonly isLive: boolean;
  readonly onAct: (action: TableAction) => void;
}

/** The heading and tone for each fate a decision can meet. */
const SUBMISSION_TITLE: Readonly<Record<TableSubmission['status'], string>> = {
  pending: 'Decision sent',
  accepted: 'Decision applied',
  rejected: 'The server refused it',
};

/**
 * Your own figures, the controls, and the price — the last block in the table column.
 *
 * Guarantees 1 to 3 in the module comment live here. Nothing about its position is set in
 * JavaScript, and nothing about it is pinned: see guarantee 1 for why a pinned band is the defect
 * rather than the feature, and for the test that now holds that line.
 */
function DecisionBand(props: DecisionBandProps): ReactElement {
  const { status, view, submission, isLive, onAct } = props;
  const pending = submission?.status === 'pending';

  return (
    <div className="prl-play__decision">
      {view === null ? null : <HeroReadout view={view} />}

      {view === null ? (
        <p className="prl-play__decision-idle">
          {status === 'error' ? 'No controls while the table is unreachable.' : 'Waiting for the table.'}
        </p>
      ) : (
        <ActionBar
          legalActions={view.legalActions}
          onAct={onAct}
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

      {submission === null ? null : (
        <Callout
          tone={submission.status === 'rejected' || !isLive ? 'warning' : 'insight'}
          title={isLive ? SUBMISSION_TITLE[submission.status] : 'Nothing was sent'}
        >
          {submission.message}
        </Callout>
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

/** What a submitted decision adds to the table's one live region. */
function spokenSubmission(action: TableAction | null): string {
  if (action === null) return '';
  if (action.type === 'bet' || action.type === 'raise') {
    return `You chose to ${action.type} to ${formatUnits(action.to)}. `;
  }
  return `You chose to ${action.type}. `;
}

export function TableStage(props: TableStageProps): ReactElement {
  const {
    status,
    view,
    report,
    turn = null,
    seatNames,
    announcement,
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
          announcement={`${spokenSubmission(submission?.action ?? null)}${announcement ?? ''}`}
          summary={summary}
          errorMessage={errorMessage}
        />
        <DecisionBand status={status} view={view} submission={submission} isLive={isLive} onAct={act} />
      </div>

      <CoachSheet report={report} status={status} coachUnavailableReason={props.coachUnavailableReason} />
    </div>
  );
}

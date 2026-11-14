'use client';

/**
 * The play screen's stage: the table, the decision controls and the Coach.
 *
 * Design system section 10 says that at 1280px and up the pot, the player's cards, the price and
 * the Coach's equity figure must be visible at once. The ActionBar is the last block in the table column and is
 * never pinned, because a pinned band covers the block above it (`layout-guarantees.test.ts` asserts
 * no sticky, fixed or absolute on `.prl-play__decision`). Below 600px the Coach is a bottom sheet whose
 * handle is a real `<button>`, and focus entering it expands it (WCAG 2.4.11).
 *
 * Without `onAct` the stage runs from a fixture and says nothing was sent. It never simulates the
 * betting rules, because the server is the only authority on a hand.
 *
 * Three channels speak. The table's narration and whose turn it is are polite, in separate regions
 * because their frames arrive back to back. A refusal is a `role="alert"`, the only assertive one.
 */

import type { CoachReport } from '@prl/contracts';
import {
  ActionBar,
  Button,
  browserAbandonedFocus,
  Callout,
  CardRow,
  CoachPanel,
  formatChips,
  HandGlance,
  latestAction,
  type PlayerView,
  PokerTable,
  type StyleWithVars,
  streetSummary,
  type TableAction,
  type TurnClock,
} from '@prl/ui';
import Link from 'next/link';
import {
  type FocusEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from 'react';
import { coachBodyFor } from '@/lib/coach-body.ts';
// A value import, not a cycle: `use-live-table.ts` imports this file's types with `import type`.
import { spokenDecision } from '@/lib/use-live-table.ts';

/**
 * Pointer-gesture thresholds, not design tokens. How far the sheet visibly moves is clamped in CSS
 * (`--prl-play-sheet-travel` in `styles/play.css`) from the raw delta, `--prl-play-sheet-drag`.
 */
const SWIPE_SLOP_PX = 6;
const SWIPE_COMMIT_PX = 28;

/** `idle` means nothing has been asked for. It must never render as `loading` (see `IdleTable`). */
export type TableStageStatus = 'idle' | 'loading' | 'ready' | 'error' | 'complete';

/**
 * A decision the caller sent, and what became of it. Only meaningful alongside `onAct`.
 *
 * `pending` and `held` disable the controls. `held` means there is no connection and the caller
 * replays the decision on reconnect. `not-sent` means this page refused it (its own rate limiter, or
 * a frame it could not send), so the controls come back and the message is an alert.
 */
export interface TableSubmission {
  readonly action: TableAction;
  readonly status: 'pending' | 'held' | 'accepted' | 'rejected' | 'not-sent';
  /** What the reader is told. The server's own wording where the server had any. */
  readonly message: string;
}

export interface TableStageProps {
  readonly status: TableStageStatus;
  readonly view: PlayerView | null;
  readonly report: CoachReport | null;
  readonly turn?: TurnClock | null;
  readonly seatNames?: Readonly<Record<number, string>>;
  readonly announcement?: string;
  /** Empty unless the decision is the reader's. The caller diffs frames (`turnAnnouncementFor`). */
  readonly turnAnnouncement?: string;
  readonly highlightedCards?: readonly number[];
  readonly highlightLabel?: string;
  readonly summary?: readonly string[];
  readonly errorMessage?: string;
  /** What the reader's first press will do, shown in the `idle` status. */
  readonly idleMessage?: string;
  /** Omit for the fixture path. Acting then disables the controls and says nothing was sent. */
  readonly onAct?: (action: TableAction) => void;
  /** Supplying it hands in-flight state to the caller, which alone knows when a frame was acknowledged. */
  readonly submission?: TableSubmission | null;
  readonly coachUnavailableReason?: string;
  readonly reviewHref?: string | undefined;
  /** Set when the server acted because the clock ran out. See `autoActed` in `lib/use-live-table.ts`. */
  readonly autoActed?: string | null;
  /** For a caller that keeps the band in view. The stage itself never scrolls. */
  readonly decisionRef?: RefObject<HTMLDivElement | null>;
  /** A standing notice for the band, such as out of units. Not announced. */
  readonly decisionNotice?: ReactNode;
  /**
   * The connection card's "Deal the next hand", repeated in the band once a hand is complete, because
   * the card is a screen or more above by then (y -1,174 at 390x844). Omit where there is no such control.
   */
  readonly dealNext?: { readonly onDeal: () => void; readonly disabled: boolean } | undefined;
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

/** The table before anybody asked for one. An empty state, not a skeleton, since nothing is loading. */
function IdleTable({ message }: { readonly message: string | undefined }): ReactElement {
  return (
    <div className="prl-play__idle">
      <div aria-hidden="true" className="prl-play__idle-table">
        {IDLE_SEATS.map((seat) => (
          <span className="prl-play__idle-seat" data-seat={seat} key={seat}>
            {seat === 'you' ? 'You' : null}
          </span>
        ))}
      </div>
      <div className="prl-play__idle-text">
        <p className="prl-play__idle-title">No table yet</p>
        <p>
          {message ??
            'Nothing has been dealt and nothing is loading. The table is drawn here once there is one.'}
        </p>
      </div>
    </div>
  );
}

const IDLE_SEATS = ['top-left', 'top', 'top-right', 'bottom-right', 'you', 'bottom-left'] as const;

function CoachSkeleton(): ReactElement {
  return (
    <div className="prl-play__skeletons">
      <span className="prl-skeleton prl-play__skeleton--metric" />
      <span className="prl-skeleton prl-play__skeleton--panel" />
      <p className="prl-play__skeleton-note">Loading the analysis.</p>
    </div>
  );
}

/** Not a skeleton, because nothing is arriving. Offers no number without the state it came from. */
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

/** What the panel says once the hand is over, in place of any analysis. See `lib/coach-body.ts`. */
function CoachHandOver({ reviewHref }: { readonly reviewHref: string | undefined }): ReactElement {
  return (
    <div className="prl-empty">
      <p className="prl-label">Hand over</p>
      <p>There is no decision left to price, so there is no analysis beside a finished hand.</p>
      {reviewHref === undefined ? null : (
        <p>
          <Link href={reviewHref}>Review this hand</Link>
          {': every decision you made in it, priced against the cards that were dealt.'}
        </p>
      )}
    </div>
  );
}

interface HeroReadoutProps {
  readonly view: PlayerView;
}

/** The figures a decision is made from, beside the buttons, since the seat plate can scroll away. */
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

/** This street's actions in one line. Not a live region, because the narration already said each. */
function StreetLine({
  view,
  seatNames,
}: {
  readonly view: PlayerView | null;
  readonly seatNames: Readonly<Record<number, string>> | undefined;
}): ReactElement | null {
  const line = view === null ? null : streetSummary(view, seatNames);
  if (line === null) return null;
  return (
    <p className="prl-play__street">
      <span className="prl-label">{line.label}</span>
      {line.earlier > 0 ? (
        <span className="prl-play__street-earlier">
          <span aria-hidden="true">{' …'}</span>
          <span className="prl-visually-hidden">{`, after ${String(line.earlier)} earlier,`}</span>
        </span>
      ) : null}
      {line.actions.map((phrase, index) => (
        // A street's actions are only appended to, so index plus phrase names one action for good.
        <span key={`${String(line.earlier + index)}:${phrase}`}>
          {index === 0 ? ' ' : <span aria-hidden="true">{' · '}</span>}
          {index === 0 ? null : <span className="prl-visually-hidden">{'; '}</span>}
          {phrase}
        </span>
      ))}
    </p>
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
  readonly idleMessage: string | undefined;
  readonly reviewHref: string | undefined;
}

/** The table, or the empty state, the skeleton or the error that stands in for it. Exactly one. */
function TableRegion(props: TableRegionProps): ReactElement {
  const { status, view, turn, seatNames, highlightedCards, highlightLabel } = props;
  const { announcement, summary, errorMessage, idleMessage, reviewHref } = props;
  const hasSummary = status === 'complete' && summary !== undefined && summary.length > 0;

  return (
    <div className="prl-play__table">
      {/*
        Mounted unconditionally and empty, here rather than in `PokerTable`. A region inserted with its
        first sentence is silent, and a hand's first events and first view land in one commit.
      */}
      <div aria-atomic="true" aria-live="polite" className="prl-live-region" role="status">
        {announcement}
      </div>

      {status === 'idle' ? <IdleTable message={idleMessage} /> : null}
      {status === 'loading' ? <StageSkeleton /> : null}

      {/*
        `role="alert"` fires on insertion, so the node is mounted only in the error state (WCAG 2.2 SC
        4.1.3). `statusSentence` in `LiveTable.tsx` must not contradict it with "Ready to connect."
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

      {view === null || status === 'loading' || status === 'idle' ? null : (
        <PokerTable
          view={view}
          {...(seatNames === undefined ? {} : { seatNames })}
          {...(highlightedCards === undefined ? {} : { highlightedCards })}
          {...(highlightLabel === undefined ? {} : { highlightLabel })}
          turn={turn}
          showLastActions
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
            The result of one hand says almost nothing about the decision that produced it. The hand’s review,
            which prices each decision in it, is where the useful feedback is.
          </p>
          {/* Here as well as in the Coach, which is a collapsed sheet on a phone. */}
          {reviewHref === undefined ? null : (
            <p className="prl-play__summary-note">
              <Link href={reviewHref}>Review this hand</Link>
            </p>
          )}
        </Callout>
      ) : null}
    </div>
  );
}

const NO_VIEW_LINE: Readonly<Record<'error' | 'idle' | 'waiting', string>> = {
  error: 'No controls while the table is unreachable.',
  idle: 'Nothing to decide until you are dealt in.',
  waiting: 'Waiting for the table.',
};

interface DecisionBandProps {
  readonly status: TableStageStatus;
  readonly view: PlayerView | null;
  readonly turn: TurnClock | null;
  readonly seatNames: Readonly<Record<number, string>> | undefined;
  readonly submission: TableSubmission | null;
  readonly turnAnnouncement: string;
  readonly isLive: boolean;
  readonly onAct: (action: TableAction) => void;
  readonly autoActed: string | null;
  readonly decisionRef: RefObject<HTMLDivElement | null> | undefined;
  readonly notice: ReactNode;
  readonly dealNext: TableStageProps['dealNext'];
}

/** Each title names who decided, the server or this browser, so the reader knows to wait or act. */
const SUBMISSION_TITLE: Readonly<Record<TableSubmission['status'], string>> = {
  pending: 'Decision sent',
  held: 'Held — no connection to the table',
  accepted: 'Decision applied',
  rejected: 'The server refused it',
  'not-sent': 'This page did not send it',
};

/** Fates the reader must act on. Only these interrupt, so an alert keeps meaning something. */
const SUBMISSION_ALERTS: ReadonlySet<TableSubmission['status']> = new Set<TableSubmission['status']>([
  'rejected',
  'not-sent',
]);

/** The statuses that keep the controls disabled, because the decision is still in flight. */
const SUBMISSION_IN_FLIGHT: ReadonlySet<TableSubmission['status']> = new Set<TableSubmission['status']>([
  'pending',
  'held',
]);

/**
 * The cards, board, clock and latest action for the bar, only while a bet or raise is legal. That is
 * when `useFollowTheTable` scrolls a phone to the sizer, and the plate and street line leave the top.
 */
function handGlanceFor(
  view: PlayerView,
  turn: TurnClock | null,
  seatNames: Readonly<Record<number, string>> | undefined,
): ReactElement | null {
  const hero = view.seats.find((seat) => seat.isSelf);
  const hole = hero?.holeCards ?? null;
  if (hole === null) return null;
  if (!view.legalActions.some((action) => action.type === 'bet' || action.type === 'raise')) return null;
  return (
    <HandGlance
      hole={hole}
      board={view.board}
      clock={hero?.isToAct === true ? turn : null}
      latest={latestAction(streetSummary(view, seatNames))}
    />
  );
}

/** The last block in the table column. Never pinned, see the module comment. */
function DecisionBand(props: DecisionBandProps): ReactElement {
  const { status, view, turn, seatNames, submission, turnAnnouncement, isLive, onAct, autoActed } = props;
  const { decisionRef, dealNext } = props;
  const pending = submission !== null && SUBMISSION_IN_FLIGHT.has(submission.status);
  const rejected = submission !== null && SUBMISSION_ALERTS.has(submission.status);

  /**
   * Where the caret goes when a decision is submitted. Disabling the focused button blurs it to the
   * document, and `ActionBar`'s own rescue waits for the next frame, which never comes on the fixture
   * path. The acknowledgement says what became of the decision. Focus moves only if it was in this
   * band and the browser has given up on it.
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
    if (!browserAbandonedFocus()) return;
    // Without `preventScroll` the page jumped to the ack below the controls (1440x900, to the footer).
    acknowledgementRef.current?.focus({ preventScroll: true });
    hadFocus.current = false;
  }, [submission]);

  /**
   * The band's Deal unmounts when the next hand's first frame lands. The bar's idle line survives that
   * frame; when the reader acts first there is none, and the sizer is the first thing they choose.
   */
  const band = useRef<HTMLDivElement | null>(null);
  const offeringDeal = status === 'complete' && dealNext !== undefined;
  const wasOfferingDeal = useRef(offeringDeal);
  useEffect(() => {
    const dealt = wasOfferingDeal.current && !offeringDeal;
    wasOfferingDeal.current = offeringDeal;
    if (!dealt || !hadFocus.current || !browserAbandonedFocus()) return;
    const target =
      band.current?.querySelector<HTMLElement>('.prl-action-bar__idle') ??
      band.current?.querySelector<HTMLElement>('.prl-sizer button');
    target?.focus({ preventScroll: true });
    hadFocus.current = false;
  }, [offeringDeal]);

  const setBand = (node: HTMLDivElement | null): void => {
    band.current = node;
    if (decisionRef !== undefined) decisionRef.current = node;
  };

  return (
    <div
      className="prl-play__decision"
      onBlurCapture={onBlurCapture}
      onFocusCapture={onFocusCapture}
      ref={setBand}
    >
      {/* Mounted empty on first render, because a region that arrives with its text is missed. */}
      <div aria-atomic="true" aria-live="polite" className="prl-live-region" role="status">
        {turnAnnouncement}
      </div>

      {/* Before the plate, so from 46rem it spans the grid and the controls stay on row two. */}
      <StreetLine view={view} seatNames={seatNames} />

      {view === null ? null : <HeroReadout view={view} />}

      {view === null ? (
        <p className="prl-play__decision-idle">
          {NO_VIEW_LINE[status === 'error' || status === 'idle' ? status : 'waiting']}
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
          context={handGlanceFor(view, turn, seatNames)}
          idleText={
            status === 'complete'
              ? 'This hand is complete. Nothing is owed and there is nothing to decide.'
              : 'Waiting for another player to act.'
          }
        />
      )}

      {offeringDeal ? (
        <p className="prl-btn-row prl-play__deal-next">
          <Button variant="primary" onClick={dealNext.onDeal} disabled={dealNext.disabled}>
            Deal the next hand
          </Button>
        </p>
      ) : null}

      {props.notice}

      {/* Not a live region, since the narration said it. It stays until the next deal. */}
      {autoActed === null ? null : (
        <Callout tone="warning" title="The clock ran out">
          {autoActed}
        </Callout>
      )}

      {/*
        One wrapper gives the focus rescue a single target. `role="status"` with a label, because
        Chrome 151 does not report a focused `group` as the focused node. Rendered only when there is
        something to say. A refusal is wrapped in an alert, which fires on insertion.
      */}
      {submission === null ? null : (
        <div
          aria-label="What happened to your decision"
          className="prl-play__ack"
          ref={acknowledgementRef}
          role="status"
          tabIndex={-1}
        >
          {rejected ? (
            <div role="alert">
              {/* Titled from the status, because this page's own refusal is not the server's. */}
              <Callout
                tone="warning"
                title={isLive ? SUBMISSION_TITLE[submission.status] : 'Nothing was sent'}
              >
                {submission.message}
              </Callout>
            </div>
          ) : (
            <Callout
              // `held` is a warning, not an insight, because the table is unreachable.
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

/** The Coach: a rail from 900px, a panel from 600px, a bottom sheet below. `styles/play.css` decides. */
interface CoachSheetProps {
  readonly report: CoachReport | null;
  readonly status: TableStageStatus;
  readonly coachUnavailableReason: string | undefined;
  readonly reviewHref: string | undefined;
}

function CoachSheet({ report, status, coachUnavailableReason, reviewHref }: CoachSheetProps): ReactElement {
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
    // Direction only. CSS clamps the distance from tokens.
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

  const body = coachBodyFor(status, report !== null);
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
        {body === 'hand-over' ? (
          <CoachHandOver reviewHref={reviewHref} />
        ) : body === 'report' && report !== null ? (
          <CoachPanel report={report} />
        ) : body === 'skeleton' ? (
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
    idleMessage,
    onAct,
  } = props;
  const highlightLabel = props.highlightLabel;
  const isLive = onAct !== undefined;

  /** The fixture path's own record of a press. Stays null when the caller passes `submission`. */
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
   * On the live path the caller's reducer already folded the decision echo into `announcement`.
   * Prepending it here re-read the echo on every frame, because the region is atomic. Only the
   * fixture path, which sets `pressed`, composes it here.
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
          idleMessage={idleMessage}
          reviewHref={props.reviewHref}
        />
        <DecisionBand
          status={status}
          view={view}
          turn={turn}
          submission={submission}
          turnAnnouncement={turnAnnouncement}
          isLive={isLive}
          onAct={act}
          autoActed={props.autoActed ?? null}
          decisionRef={props.decisionRef}
          seatNames={seatNames}
          notice={props.decisionNotice}
          dealNext={props.dealNext}
        />
      </div>

      <CoachSheet
        report={report}
        status={status}
        coachUnavailableReason={props.coachUnavailableReason}
        reviewHref={props.reviewHref}
      />
    </div>
  );
}

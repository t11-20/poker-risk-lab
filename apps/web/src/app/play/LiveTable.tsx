'use client';

/**
 * The client boundary for `/play`. Everything below the connection panel is drawn from the server's
 * `state` frames. Seats, legal actions and sizer bounds are the server's. This component only asks.
 * Each socket close code gets its own sentence and control (`describeClose` in `lib/table-socket.ts`),
 * because codes like `4401` and `4403` are not "try again".
 */

import type { LegendDifficulty } from '@prl/contracts';
import {
  Button,
  Callout,
  cx,
  formatUnits,
  Panel,
  type TableAction,
  useChangeWatch,
  useFocusRescue,
  usePrefersReducedMotion,
} from '@prl/ui';
import Link from 'next/link';
import { type FormEvent, type ReactElement, type RefObject, useEffect, useId, useRef, useState } from 'react';
import { TableStage, type TableStageStatus } from '@/components/TableStage.tsx';
import { noAnalysisReason, readerHasDecisions, reviewHrefFor } from '@/lib/coach-body.ts';
import { dealNextState } from '@/lib/deal-next.ts';
import { sizerFollowDelta, type WatchGeometry, watchDelta } from '@/lib/follow-the-table.ts';
import { LEGENDS_PATH, legendMatchHref, PLAY_PATH } from '@/lib/legend-links.ts';
import { describeTable } from '@/lib/table-description.ts';
import { INVITE_CODE_EXAMPLE, MAX_INVITE_CODE_INPUT } from '@/lib/table-rooms.ts';
import type { TableSocketStatus } from '@/lib/table-socket.ts';
import { keepLabel } from '@/lib/table-switch.ts';
import { type LiveTable as LiveTableModel, type SwitchWarning, useLiveTable } from '@/lib/use-live-table.ts';

/**
 * Used only when this page opened an Expert match itself. A `coach_not_available` refusal carries no
 * difficulty, and plain `/play` can reuse an Expert room, so it gets the server's words instead.
 * `useLiveTable` decides which (see `CoachOff`).
 */
const EXPERT_COACH_REASON =
  'The Coach is available afterwards in review, not during this hand. Expert keeps the analysis off the table so the style is the thing you are reading.';

/** The server's words plus a sentence true whatever produced the refusal. It names no difficulty. */
function refusedCoachReason(serverReason: string): string {
  return (
    `${serverReason} That is a setting of the table you are at rather than anything about this ` +
    'hand, and the full analysis is on the hand’s review page afterwards.'
  );
}

function coachOffReason(off: NonNullable<LiveTableModel['coachOff']>): string {
  return off.kind === 'expertLegends' ? EXPERT_COACH_REASON : refusedCoachReason(off.serverReason);
}

/**
 * The panel's default sentence denies there is any table state, so it must not show during a
 * request. `CoachUnavailable` gets only a report or null and cannot tell the two apart. The round
 * trip measured 1.35s locally and the server allows three seconds.
 */
const COACH_IN_FLIGHT_REASON =
  'The analysis of this decision has been asked for and has not come back yet. It is computed ' +
  'server-side from your own redacted view, which takes a moment; nothing is estimated here while ' +
  'you wait.';

function coachUnavailableProps(
  live: LiveTableModel,
): { readonly coachUnavailableReason: string } | Record<string, never> {
  if (live.coachOff !== null) return { coachUnavailableReason: coachOffReason(live.coachOff) };
  if (live.coachProblem !== null) {
    return {
      coachUnavailableReason:
        `The server sent an analysis this page could not read: ${live.coachProblem}. ` +
        'It was refused rather than shown in part. The table itself is unaffected — it is drawn ' +
        'from separate frames.',
    };
  }
  if (live.table.coachRequest !== null) return { coachUnavailableReason: COACH_IN_FLIGHT_REASON };
  if (live.table.view !== null) return { coachUnavailableReason: noAnalysisReason(live.table.view) };
  return {};
}

/** One line, because the connection card above already says what "Deal me in" does. */
const IDLE_TABLE_MESSAGE = 'Your table appears here once you are dealt in.';

const STATUS_LEDE: Readonly<Record<TableSocketStatus, string>> = {
  connecting: 'Connecting to the table…',
  handshaking: 'Connected. Loading the table…',
  live: 'Live. Everything on this screen is the server’s own view of the table, redacted for you.',
  reconnecting: 'Connection lost. Reconnecting…',
  closed: 'Not connected.',
};

/**
 * `idle` is not `loading`. Before the first press nothing is on its way, so a skeleton would never
 * resolve. `complete` also covers the gap between hands, where the server sends `view: null` and the
 * finished hand stays on screen.
 */
function stageStatusOf(live: LiveTableModel): TableStageStatus {
  if (live.closed !== null && !live.closed.retryable) return 'error';
  if (live.phase === 'failed') return 'error';
  if (live.phase === 'idle') return 'idle';
  if (live.table.view === null) return live.status === 'live' ? 'ready' : 'loading';
  if (live.table.betweenHands || live.table.view.street === 'complete') return 'complete';
  return 'ready';
}

interface ConnectionPanelProps {
  readonly live: LiveTableModel;
  /** True on `/play?profile=…`: a match against one AI Legends style rather than the bot table. */
  readonly inLegendMatch?: boolean;
}

/**
 * This is the page's only `role="status"` region. A failed setup never opens a socket, so the failed
 * branch must come before the null-status line or a screen reader hears "Ready to connect". It stays
 * short because `TableStage`'s `role="alert"` and the callout below already carry the reason.
 */
function statusSentence(live: LiveTableModel, inLegendMatch: boolean): string {
  if (live.switchWarning !== null) {
    return 'Nothing has been opened or closed. Choose below which table to keep.';
  }
  if (live.phase === 'idle' && live.resuming) return 'Reconnecting you to the table you were at.';
  if (live.phase === 'idle' && inLegendMatch) {
    return (
      'Press “Deal me in” to play this style: the match still running, or a new one with 1,000 units. ' +
      'No sign-up needed. ' +
      'Each table keeps its own units, and if this would close another table, you are asked first.'
    );
  }
  if (live.phase === 'idle') {
    // `chooseRoom` may reuse a held table or create one, and the page cannot know which yet.
    return (
      'Press “Deal me in” to sit at your bot table: the one you already have, or a new one with 1,000 units. ' +
      'No sign-up needed. ' +
      'Each table keeps its own units, and if this would close a Legends match, you are asked first.'
    );
  }
  if (live.phase === 'preparing') {
    return 'Preparing: reading your session, then finding or creating your private room.';
  }
  if (live.phase === 'failed') return 'Could not prepare the table. See below.';
  return live.status === null ? 'Ready to connect.' : STATUS_LEDE[live.status];
}

function hintSentence(live: LiveTableModel): string {
  if (live.phase !== 'ready' || live.status !== 'live') return 'The table opens once connected.';
  if (live.dealingIn) {
    return live.table.seat === null && live.readerSeat !== null
      ? `Taking seat ${String(live.readerSeat + 1)} and dealing your first hand.`
      : 'Dealing your first hand.';
  }
  if (live.outOfUnits) {
    return 'Out of units at this seat — dealt out until you reset.';
  }
  if (live.table.seat === null) {
    // Not a constant seat. At a room reached by invite code seat 1 is the owner's.
    return live.readerSeat === null
      ? 'Every seat is taken.'
      : `Seat ${String(live.readerSeat + 1)} is open — take it to join.`;
  }
  if (live.table.betweenHands) {
    return 'Between hands. Deal when ready.';
  }
  return live.isMyTurn
    ? 'A hand is in progress — your turn.'
    : 'A hand is in progress — waiting for another seat.';
}

function ConnectionNotices({ live }: ConnectionPanelProps): ReactElement {
  const { closed, table, setupError } = live;
  return (
    <>
      {/*
        This page refusing a frame that carried hole cards it should not have
        (`lib/hole-card-entitlement.ts`). It sits above `closed` because the disconnection follows from it.
      */}
      {table.dataRefusal === null ? null : (
        <div role="alert">
          <Callout tone="warning" title="This table stopped: the server sent cards it should not have">
            {table.dataRefusal}
          </Callout>
        </div>
      )}
      {setupError === null ? null : (
        <Callout tone="warning" title="The table could not be prepared">
          {setupError}
        </Callout>
      )}
      {closed === null ? null : (
        <Callout tone={closed.retryable ? 'insight' : 'warning'} title={closed.title}>
          {closed.detail}
        </Callout>
      )}
      {/*
        Refusals use `role="alert"` and mount only with a notice, because an alert fires on insertion.
        `enrolment_required` gets its own panel because it lasts until an operator acts. It has no
        "get access" control on purpose. Nobody can enrol themselves from this page.
      */}
      {table.notice !== null && table.noticeCode === 'enrolment_required' ? (
        <div role="alert">
          <Callout tone="warning" title="A seat at a table is part of a course">
            <p>{table.notice}</p>
            <p>
              Nothing else on this site is affected. The lessons, the Scenario Lab, the glossary and the
              Legends pages are open to everybody, and none of them needs a seat at a table.
            </p>
          </Callout>
        </div>
      ) : null}
      {/*
        Not an alert, because nothing was refused. `outOfUnits` is read off each frame's roster. The
        last paragraph is the fallback for a server whose reset leaves a taken seat at 0.
      */}
      {live.outOfUnits ? (
        <Callout tone="warning" title="You are out of units">
          <p>
            The server deals you out of every hand while your seat has nothing in front of it, so pressing
            deal now would only deal the bots. Units are free practice counters: reset them to the starting
            amount to play on.
          </p>
          <p>
            <Link href="/record">Reset your units on your record page</Link>
          </p>
          <p>
            This notice goes once the table shows units at your seat. If it is still here after a reset, stand
            up, reset once more, then take your seat again: you sit down with the reset units.
          </p>
        </Callout>
      ) : null}
      {table.notice !== null && table.noticeCode !== 'enrolment_required' ? (
        <div role="alert">
          <Callout tone="warning" title="The server refused something">
            {table.notice}
          </Callout>
        </div>
      ) : null}
    </>
  );
}

/**
 * The set of controls on screen, as a string, so the focus rescue fires when a control is replaced
 * inside one `ready`/`live` pair ("Take seat 2" becoming "Deal the next hand").
 */
function controlsSignature(live: ConnectionPanelProps['live']): string {
  return [
    live.phase,
    live.status ?? 'none',
    live.closed?.action ?? 'none',
    live.table.seat !== null ? 'seated' : 'standing',
    live.readerSeat === null ? 'full' : 'free',
    live.table.betweenHands ? 'between' : 'in-hand',
    live.coachOff === null ? 'coach' : 'no-coach',
    live.dealingIn ? 'dealing-in' : 'manual',
    readerHasDecisions(live.table.view) ? 'in-the-hand' : 'out-of-the-hand',
    live.join.state,
    live.switchWarning === null ? 'no-switch' : 'switch',
  ].join('/');
}

function dealNextOf(live: LiveTableModel): ReturnType<typeof dealNextState> {
  return dealNextState({
    live: live.status === 'live',
    dealingIn: live.dealingIn,
    seated: live.table.seat !== null,
    betweenHands: live.table.betweenHands,
    outOfUnits: live.outOfUnits,
  });
}

/**
 * Every control here is conditional, so pressing one usually unmounts it. Focus then goes to the panel's
 * status line. The private-table flows sit inside the same rescue, because "Start a private table…"
 * unmounts too.
 */
function ConnectionControls({
  live,
  inLegendMatch = false,
  fallbackRef,
}: ConnectionPanelProps & { readonly fallbackRef: RefObject<HTMLParagraphElement | null> }): ReactElement {
  const { phase, closed, table } = live;
  const isLive = live.status === 'live';
  const seated = table.seat !== null;
  const manual = isLive && !live.dealingIn;
  const deal = dealNextOf(live);

  const signature = controlsSignature(live);
  const controlsChanged = useChangeWatch(signature);
  const focus = useFocusRescue();
  useEffect(() => {
    if (controlsChanged(signature)) focus.rescue(fallbackRef.current);
  }, [controlsChanged, signature, focus, fallbackRef]);

  return (
    <div
      className="prl-play__controls"
      onBlurCapture={focus.onBlurCapture}
      onFocusCapture={focus.onFocusCapture}
    >
      {live.switchWarning === null ? null : <SwitchTablesNotice live={live} warning={live.switchWarning} />}
      <p className="prl-btn-row">
        {(phase === 'idle' || phase === 'failed') && live.switchWarning === null ? (
          <Button variant="primary" onClick={live.start}>
            {phase === 'failed' ? 'Try again' : 'Deal me in'}
          </Button>
        ) : null}

        {closed?.action === 'signIn' ? (
          <Button variant="primary" onClick={live.startFreshTable}>
            Start a guest session
          </Button>
        ) : null}

        {closed?.action === 'reload' ? (
          <Button variant="primary" onClick={() => window.location.reload()}>
            Reload this page
          </Button>
        ) : null}

        {/* Hidden while "Deal me in" runs, so they cannot send a second `sit` or deal. */}
        {manual && !seated && live.readerSeat !== null ? (
          <Button variant="primary" onClick={live.sit}>
            {`Take seat ${String(live.readerSeat + 1)}`}
          </Button>
        ) : null}

        {deal === null ? null : (
          <Button variant="primary" onClick={live.deal} disabled={deal.disabled}>
            Deal the next hand
          </Button>
        )}

        {isLive && seated ? (
          <Button variant="secondary" onClick={live.stand}>
            Stand up
          </Button>
        ) : null}

        {isLive && !seated && inLegendMatch ? (
          <Link className="prl-btn prl-btn--secondary prl-btn--md" href={LEGENDS_PATH}>
            Choose another opponent
          </Link>
        ) : null}

        {/* After a fold there is nothing for the Coach to price. */}
        {isLive &&
        seated &&
        !table.betweenHands &&
        live.coachOff === null &&
        readerHasDecisions(table.view) ? (
          <Button variant="ghost" onClick={live.askCoach}>
            Refresh the analysis
          </Button>
        ) : null}
      </p>

      <OtherTables live={live} inLegendMatch={inLegendMatch} />
    </div>
  );
}

const OPEN_TABLE: Readonly<Record<SwitchWarning['other']['kind'], readonly [string, string]>> = {
  botTable: ['the bot table', 'another bot table'],
  legendMatch: ['a Legends match', 'another Legends match'],
};

function switchSentence(warning: SwitchWarning): string {
  const { other, starting, startsWith } = warning;
  const name = OPEN_TABLE[other.kind][other.kind === starting ? 1 : 0];
  const open = other.stack === null ? 'open' : `open with ${formatUnits(other.stack)}`;
  const action = starting === 'botTable' ? 'Starting the bot table' : 'Starting this match';
  return (
    `You have ${name} ${open}. ${action} closes it, and the new table starts with ` +
    `${formatUnits(startsWith)}. Units do not carry over between tables.`
  );
}

/**
 * Only the text is the alert. An alert holding controls is an alertdialog, which would take focus,
 * and the rescue in `ConnectionControls` already puts it on the status line. A match still running is
 * gone back to on its own page, which reconnects to it. A finished one has nothing to go back to.
 */
function SwitchTablesNotice({
  live,
  warning,
}: ConnectionPanelProps & { readonly warning: SwitchWarning }): ReactElement {
  const keep = keepLabel(warning.other, warning.starting);
  const match = warning.other.kind === 'legendMatch' ? warning.other.match : null;
  return (
    <Callout tone="warning" title="Switching tables resets your units">
      <div role="alert">
        <p>{switchSentence(warning)}</p>
      </div>
      <p className="prl-btn-row">
        <Button variant="secondary" onClick={live.confirmSwitch}>
          {`Close it and start with ${formatUnits(warning.startsWith)}`}
        </Button>
        {warning.other.kind === 'botTable' ? (
          <Link
            className="prl-btn prl-btn--secondary prl-btn--md"
            href={PLAY_PATH}
            onClick={live.stayAtOtherTable}
          >
            {keep}
          </Link>
        ) : match === null ? (
          <Button variant="secondary" onClick={live.keepOtherTable}>
            {keep}
          </Button>
        ) : (
          <Link
            className="prl-btn prl-btn--secondary prl-btn--md"
            href={legendMatchHref(match.profileId, match.difficulty)}
            onClick={live.stayAtOtherTable}
          >
            {keep}
          </Link>
        )}
      </p>
    </Callout>
  );
}

/**
 * In a legend match, a link instead of the private-table flows. They switch the room without changing
 * the URL, and the heading and Coach rule are rendered from the URL.
 */
function OtherTables({ live, inLegendMatch = false }: ConnectionPanelProps): ReactElement {
  return inLegendMatch ? (
    <p className="prl-note">
      To play with somebody you know, <Link href="/play">open the bot table</Link> and start or join a private
      table from there.
    </p>
  ) : (
    <PlayWithSomebody live={live} />
  );
}

function PlayWithSomebody({ live }: ConnectionPanelProps): ReactElement {
  const { phase } = live;
  return (
    <details className="prl-disclose">
      <summary className="prl-disclose__summary">Play with somebody you know</summary>
      <div className="prl-disclose__body">
        <p className="prl-note">
          A private table has seats left free for people rather than bots, and an invite code to share.
          Nothing is dealt for you there: who sits where, and when a hand starts, is up to the people at the
          table.
        </p>
        {/* A separate room, because the bot table fills five of six seats. See `FRIENDS_TABLE_REQUEST`. */}
        {phase === 'idle' || phase === 'ready' || phase === 'failed' ? (
          <p className="prl-btn-row">
            <Button variant="secondary" onClick={live.startPrivateTable}>
              Start a private table to invite somebody to
            </Button>
          </p>
        ) : null}
        {/* Keyed by the code, so a new code scrolls into view and drops a stale "Copied". */}
        {live.inviteCode === null ? null : <InviteCode code={live.inviteCode} key={live.inviteCode} />}
        <JoinByInviteCode live={live} />
      </div>
    </details>
  );
}

/**
 * The server stores only `sha256(code)`, so `POST /rooms` is the one time the code exists. It lives in
 * React state only, never in storage or the URL, so a reload loses it on purpose. On arrival it is
 * scrolled in by its nearest edge (it measured under the phone's 780px Coach peek). Focus is left to
 * the rescue in `ConnectionControls`.
 */
function InviteCode({ code }: { readonly code: string }): ReactElement {
  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle');
  const block = useRef<HTMLDivElement | null>(null);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    const element = block.current;
    if (element === null || inView(element)) return;
    element.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
  }, [reduced]);

  const copy = (): void => {
    // The Clipboard API is missing over plain HTTP off localhost and in some webviews.
    if (typeof navigator === 'undefined' || navigator.clipboard === undefined) {
      setCopied('failed');
      return;
    }
    void navigator.clipboard.writeText(code).then(
      () => setCopied('done'),
      () => setCopied('failed'),
    );
  };

  return (
    <div className="prl-play__invite" ref={block}>
      <p className="prl-label">Invite code — shown once</p>
      <p className="prl-play__invite-code">
        <code className="prl-mono">{code}</code>
      </p>
      <p className="prl-btn-row">
        <Button variant="secondary" size="sm" onClick={copy}>
          Copy the code
        </Button>
        {/* Present and empty from the start. Screen readers miss a region that mounts with its text. */}
        <span className="prl-note" role="status">
          {copied === 'done'
            ? 'Copied to the clipboard.'
            : copied === 'failed'
              ? 'This browser would not let the page use the clipboard. Select the code above and copy it.'
              : ''}
        </span>
      </p>
      <p className="prl-note">
        Anybody with this code can join this table. Only a hash of it is kept, so it cannot be shown again and
        it is not written down anywhere in this browser — if you lose it, start a fresh table and share the
        new one. Nothing is at stake either way: the units are free and worth nothing.
      </p>
    </div>
  );
}

/**
 * A real `<form>` so Enter submits. The button is not disabled for a short code, because
 * `normaliseInviteCode` returns a sentence saying what is wrong, announced with the field.
 */
function JoinByInviteCode({ live }: ConnectionPanelProps): ReactElement {
  const [code, setCode] = useState('');
  const fieldId = useId();
  const hintId = `${fieldId}-hint`;
  const errorId = `${fieldId}-error`;
  const refused = live.join.state === 'refused';

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    live.joinByInviteCode(code);
  };

  return (
    <form className="prl-play__join" onSubmit={onSubmit}>
      <div className="prl-field">
        <label className="prl-field__label" htmlFor={fieldId}>
          Join a private table with an invite code
        </label>
        <input
          className="prl-input prl-mono"
          id={fieldId}
          name="inviteCode"
          type="text"
          autoComplete="off"
          spellCheck={false}
          maxLength={MAX_INVITE_CODE_INPUT}
          placeholder={INVITE_CODE_EXAMPLE}
          aria-describedby={refused ? `${errorId} ${hintId}` : hintId}
          aria-invalid={refused ? true : undefined}
          value={code}
          onChange={(event) => setCode(event.target.value)}
        />
        {refused ? (
          <p className="prl-field__error" id={errorId}>
            <span aria-hidden="true">{'▲ '}</span>
            {live.join.state === 'refused' ? live.join.message : ''}
          </p>
        ) : null}
        <p className="prl-field__hint" id={hintId}>
          The code the table’s owner shared with you. Spaces and lower case are tidied up for you; keep the
          hyphens, because they are part of the code.
        </p>
      </div>
      <p className="prl-btn-row">
        <Button variant="secondary" type="submit" disabled={live.join.state === 'joining'}>
          {live.join.state === 'joining' ? 'Joining…' : 'Join that table'}
        </Button>
      </p>
      <p className="prl-note" role="status">
        {live.join.state === 'joined' ? `Joined ${live.join.roomName}. Take a seat to be dealt in.` : ''}
      </p>
    </form>
  );
}

function ConnectionPanel({ live, inLegendMatch = false }: ConnectionPanelProps): ReactElement {
  const room = live.table.room;
  const isLive = live.status === 'live';
  /** Focus target for the rescue. `tabIndex={-1}` adds no tab stop. */
  const statusRef = useRef<HTMLParagraphElement | null>(null);

  return (
    <Panel
      className={cx('prl-play__connection', isLive && 'prl-play__connection--live')}
      title="This table"
      tone="inset"
      actions={
        live.phase === 'ready' ? (
          <Button variant="ghost" size="sm" onClick={live.startFreshTable}>
            Start a fresh table
          </Button>
        ) : null
      }
    >
      {/*
        A polite region for the transport, separate from the table's region for the hand. `play.css`
        puts the two lines side by side above 900px.
      */}
      <div className="prl-play__connection-lines">
        {/*
          Labelled because focus lands here, and `role="status"` takes no name from its contents
          (ax-assertions 3.2). The label names the place, the sentence the transport.
        */}
        <p
          aria-label="Where the table has got to"
          role="status"
          className="prl-note"
          ref={statusRef}
          tabIndex={-1}
        >
          {statusSentence(live, inLegendMatch)}
        </p>

        {/*
          Not a live region on purpose. The hint flips on every action, and `TableStage`'s turn region
          already announces the turn with the figures in it.
        */}
        <p className="prl-note">{hintSentence(live)}</p>
      </div>

      <ConnectionNotices live={live} />
      <ConnectionControls live={live} inLegendMatch={inLegendMatch} fallbackRef={statusRef} />

      {room === null ? null : (
        // A `div` per pair, so a wrapping row never strands a label from its value.
        <dl className="prl-stat__pair prl-play__facts">
          <div className="prl-play__fact">
            <dt className="prl-label">Room</dt>
            <dd>{describeTable(room, live.table.userId)}</dd>
          </div>
          <div className="prl-play__fact">
            <dt className="prl-label">Blinds</dt>
            <dd>{`${String(room.smallBlind)} / ${String(room.bigBlind)} units`}</dd>
          </div>
          <div className="prl-play__fact">
            <dt className="prl-label">Your seat</dt>
            <dd>
              {live.table.seat === null
                ? 'watching'
                : `seat ${String(live.table.seat + 1)}${live.outOfUnits ? ' — out of units' : ''}`}
            </dd>
          </div>
        </dl>
      )}
    </Panel>
  );
}

/**
 * A short copy of the out-of-units notice in the decision band. At a bust the connection card is
 * off screen above (y -1,203 at 390x844). Not a live region, like the card's.
 */
function OutOfUnitsAtTheTable(): ReactElement {
  return (
    <Callout tone="warning" title="You are out of units">
      <p>
        Your seat has nothing in front of it, so the server deals every hand without you. Units are free
        practice counters: reset them to the starting amount to play on.
      </p>
      <p>
        <Link href="/record">Reset your units on your record page</Link>
      </p>
    </Callout>
  );
}

/**
 * The connection card pushes the first decision two screens down (Fold at docY 1746 at 1440x900), so
 * the page follows the table. It scrolls only on the edges the reader waits for, only when the target
 * is out of view, and never while they type elsewhere. A decision brings in a row that does not stick by
 * its nearest edge, never the band by its bottom. Below 900px the band (~715px) is taller than the view
 * (~620px), and aligning its bottom hides the reader's plate under the header. Other edges are watched
 * (`watchDelta`). Viewport only, because focus belongs to the rescues, which all pass `preventScroll`.
 */
function inView(element: HTMLElement): boolean {
  const box = element.getBoundingClientRect();
  const root = window.getComputedStyle(document.documentElement);
  const top = Number.parseFloat(root.scrollPaddingBlockStart) || 0;
  const bottom = Number.parseFloat(root.scrollPaddingBlockEnd) || 0;
  return box.top >= top && box.bottom <= window.innerHeight - bottom;
}

function typingElsewhere(band: HTMLElement): boolean {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || band.contains(active)) return false;
  return (
    active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active.isContentEditable
  );
}

/**
 * Null unless the row is sticky, so it could cover what the reader decides with: the sizer (at 390x844
 * a tap on ½ pot sent a min-raise), or at a call or fold the price and the glance. Reads the row's
 * `position`, not the viewport width, because a container query decides it. See `lib/follow-the-table.ts`.
 */
function stuckRowScroll(band: HTMLElement): number | null {
  const bar = band.querySelector<HTMLElement>('.prl-action-bar');
  const row = bar?.querySelector<HTMLElement>('.prl-action-bar__actions');
  if (bar == null || row == null) return null;
  if (window.getComputedStyle(row).position !== 'sticky') return null;
  const root = window.getComputedStyle(document.documentElement);
  const street = band.querySelector<HTMLElement>('.prl-play__street');
  const after = bar.querySelector<HTMLElement>('.prl-action-bar__note');
  const sizer = bar.querySelector<HTMLElement>('.prl-sizer');
  const price = bar.querySelector<HTMLElement>('.prl-action-bar__price');
  // The glance repeats the street line's latest action, and keeping the line at a call or fold in a held
  // band moved the page 71px down and the next sized decision moved it back (360x780).
  const first = (sizer === null ? price : street) ?? bar;
  const rowBox = row.getBoundingClientRect();
  // `display: none` at the widths where the HUD holds the cards: a zero box is "not drawn", not "at 0".
  const glance = bar.querySelector<HTMLElement>('.prl-hand-glance');
  const hand = glance?.getBoundingClientRect();
  const drawn = hand !== undefined && hand.height > 0;
  // Without a sizer, the last of the price and the glance is what the stuck row must clear.
  const under = (sizer ?? (drawn ? glance : null) ?? price ?? bar).getBoundingClientRect();
  return sizerFollowDelta({
    regionTop: first.getBoundingClientRect().top,
    priceTop: price === null ? null : price.getBoundingClientRect().top,
    handTop: drawn ? hand.top : null,
    streetBottom: street === null ? null : street.getBoundingClientRect().bottom,
    coverBottom: document.querySelector('.prl-shell__header')?.getBoundingClientRect().bottom ?? 0,
    sizerTop: under.top,
    sizerBottom: under.bottom,
    controlsBottom:
      sizer?.querySelector('.prl-sizer__controls')?.getBoundingClientRect().bottom ?? under.bottom,
    rowFlowBottom: (after ?? bar).getBoundingClientRect()[after == null ? 'bottom' : 'top'],
    rowTop: rowBox.top,
    rowStuckTop:
      window.innerHeight - (Number.parseFloat(window.getComputedStyle(row).bottom) || 0) - rowBox.height,
    viewTop: Number.parseFloat(root.scrollPaddingBlockStart) || 0,
    viewBottom: window.innerHeight - (Number.parseFloat(root.scrollPaddingBlockEnd) || 0),
  });
}

function watchScroll(band: HTMLElement, edge: WatchGeometry['edge']): number {
  const table =
    document.querySelector<HTMLElement>('.prl-table__hero') ?? document.querySelector('.prl-table__field');
  if (table === null) return 0;
  const root = window.getComputedStyle(document.documentElement);
  const box = band.getBoundingClientRect();
  return watchDelta({
    bandTop: box.top,
    bandBottom: box.bottom,
    tableBottom: table.getBoundingClientRect().bottom,
    viewTop: Number.parseFloat(root.scrollPaddingBlockStart) || 0,
    viewBottom: window.innerHeight - (Number.parseFloat(root.scrollPaddingBlockEnd) || 0),
    edge,
  });
}

function useFollowTheTable(live: LiveTableModel, band: RefObject<HTMLDivElement | null>): void {
  const reduced = usePrefersReducedMotion();
  const view = live.table.view;
  // Set on the edge, so it changes once per turn, not per frame.
  const turnEdge = live.table.turnAnnouncement;
  const handEdge =
    view !== null && view.viewerSeat !== null ? `${view.handId}:${String(view.street === 'complete')}` : null;
  const watchEdge = turnEdge === '' ? handEdge : null;
  /** The hand edge at the reader's last sized decision, while the band keeps that decision's height. */
  const held = useRef<string | null>(null);

  // Standing up clears the hand edge, and the watch below runs only on one, so the hold ends here.
  useEffect(() => {
    if (handEdge !== null || held.current === null) return;
    held.current = null;
    if (band.current !== null) band.current.style.minBlockSize = '';
  }, [handEdge, band]);

  useEffect(() => {
    if (turnEdge === '') return;
    const element = band.current;
    if (element === null || typingElsewhere(element)) return;
    const sized = stuckRowScroll(element);
    if (sized !== null) {
      // The sizer and the row leave when the decision ends, and the page shrank 718px at 390x844.
      if (element.querySelector('.prl-sizer') !== null) {
        held.current = handEdge;
        element.style.minBlockSize = `${element.getBoundingClientRect().height}px`;
      }
      if (sized !== 0) window.scrollBy({ top: sized, behavior: reduced ? 'auto' : 'smooth' });
      return;
    }
    const target = element.querySelector<HTMLElement>('.prl-action-bar__actions') ?? element;
    if (inView(target)) return;
    target.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
  }, [turnEdge, handEdge, band, reduced]);

  const watchedHand = useRef<string | null>(null);
  useEffect(() => {
    if (watchEdge === null) return;
    const hand = watchEdge.slice(0, watchEdge.lastIndexOf(':'));
    const dealt = hand !== watchedHand.current;
    watchedHand.current = hand;
    const element = band.current;
    if (element === null) return;
    // Released before measuring, so the end of the hand brings Deal in from an unheld band.
    const holding = held.current === watchEdge;
    if (!holding) {
      held.current = null;
      element.style.minBlockSize = '';
    }
    if (typingElsewhere(element)) return;
    const by = watchScroll(
      element,
      holding ? 'held' : dealt ? 'dealt' : watchEdge.endsWith(':true') ? 'complete' : 'decided',
    );
    if (by !== 0) window.scrollBy({ top: by, behavior: reduced ? 'auto' : 'smooth' });
  }, [watchEdge, band, reduced]);
}

export function LiveTable({
  legendMatch,
}: {
  readonly legendMatch?: {
    readonly profileId: string;
    readonly difficulty: LegendDifficulty;
  };
} = {}): ReactElement {
  const live = useLiveTable(legendMatch === undefined ? {} : { legendMatch });
  const { table } = live;
  const status = stageStatusOf(live);
  const highlighted = live.highlightedCards;

  const act = (action: TableAction): void => live.act(action);
  const deal = dealNextOf(live);
  const decisionRef = useRef<HTMLDivElement | null>(null);
  useFollowTheTable(live, decisionRef);

  return (
    <>
      <ConnectionPanel live={live} inLegendMatch={legendMatch !== undefined} />

      <TableStage
        status={status}
        view={table.view}
        report={live.report}
        seatNames={live.seatNames}
        turn={live.turn}
        announcement={table.announcement}
        turnAnnouncement={table.turnAnnouncement}
        submission={table.submission}
        onAct={act}
        autoActed={table.autoActed}
        decisionRef={decisionRef}
        {...(live.outOfUnits ? { decisionNotice: <OutOfUnitsAtTheTable /> } : {})}
        {...(deal === null ? {} : { dealNext: { onDeal: live.deal, disabled: deal.disabled } })}
        idleMessage={IDLE_TABLE_MESSAGE}
        {...coachUnavailableProps(live)}
        {...(status === 'complete' ? { reviewHref: reviewHrefFor(table.view) } : {})}
        {...(highlighted.length === 0
          ? {}
          : { highlightedCards: highlighted, highlightLabel: 'part of the winning hand' })}
        {...(table.summary.length === 0 ? {} : { summary: table.summary })}
        {...(status === 'error'
          ? {
              errorMessage:
                live.closed?.detail ??
                live.setupError ??
                'The table is unreachable. Nothing was staked and nothing was sent.',
            }
          : {})}
      />
    </>
  );
}

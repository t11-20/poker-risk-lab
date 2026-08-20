'use client';

/**
 * The live table: the client boundary for `/play`.
 *
 * Everything below the connection panel is drawn from `state` frames. There is no fixture on this
 * path and no local model of a hand — `useLiveTable` holds the last frame the server sent and this
 * component renders it. When the socket is not live there is nothing to draw, and the panel says
 * which of the several different reasons that is.
 *
 * ## Why the connection is a panel and not a spinner
 *
 * The socket can fail in ways that are not "try again": signed out (`4401`), not a member of the
 * room (`4403`), an origin the API does not allow (`4406`), a protocol this build does not speak
 * (`4400`). A spinner tells a reader none of that and leaves them waiting for something that is
 * never going to arrive. Each close code gets its own sentence and, where there is one, its own
 * control — sign in, or reload — from `describeClose` in `lib/table-socket.ts`.
 *
 * ## Private tables are reachable from here, in both directions
 *
 * Every room this page creates is `invite_only` and always has been — the server has supported
 * private multiplayer since it was built, and an audit ran a whole hand across two independent
 * sessions to prove it. What was missing was any way for a person to get at it: the invite code
 * came back from `POST /rooms` and was thrown away unread, and nothing in this client had ever
 * called `POST /rooms/join`.
 *
 * Both halves are here now. `InviteCode` shows the code for a room this page just created, framed
 * as what it is — a value that exists exactly once, because only its hash is stored.
 * `JoinByInviteCode` is the way in for the second person. Neither one keeps the code anywhere; see
 * the comment on `LiveTable.inviteCode` in `lib/use-live-table.ts`.
 *
 * ## Nothing here decides a poker question
 *
 * The seat number is the server's. The buttons are the server's `legalActions`. The bet sizer's
 * bounds are the server's `minTo`/`maxTo`. Sitting, standing, dealing and acting are all intents:
 * this component asks, and draws whatever comes back. The Coach's numbers are computed server-side
 * from the reader's own redacted view and arrive as a whole `CoachReport`.
 */

import { Button, Callout, Panel, type TableAction } from '@prl/ui';
import { type FormEvent, type ReactElement, useId, useState } from 'react';
import { TableStage, type TableStageStatus } from '@/components/TableStage.tsx';
import { INVITE_CODE_EXAMPLE, MAX_INVITE_CODE_INPUT } from '@/lib/table-rooms.ts';
import type { TableSocketStatus } from '@/lib/table-socket.ts';
import { type LiveTable as LiveTableModel, useLiveTable } from '@/lib/use-live-table.ts';

const EXPERT_COACH_REASON =
  'The Coach is available afterwards in review, not during this hand. Expert keeps the analysis off the table so the style is the thing you are reading.';

function coachUnavailableProps(
  live: LiveTableModel,
): { readonly coachUnavailableReason: string } | Record<string, never> {
  if (!live.coachDuringHand) return { coachUnavailableReason: EXPERT_COACH_REASON };
  if (live.coachProblem === null) return {};
  return {
    coachUnavailableReason:
      `The server sent an analysis this page could not read: ${live.coachProblem}. ` +
      'It was refused rather than shown in part. The table itself is unaffected — it is drawn ' +
      'from separate frames.',
  };
}

/** One sentence per transport state, in the reader's terms rather than the protocol's. */
const STATUS_LEDE: Readonly<Record<TableSocketStatus, string>> = {
  connecting: 'Opening a connection to the table.',
  handshaking: 'Connected. Introducing this page to the table and waiting for its first state.',
  live: 'Live. Everything on this screen is the server’s own view of the table, redacted for you.',
  reconnecting: 'The connection dropped. Reconnecting with a widening delay — the table is held server-side.',
  closed: 'Not connected.',
};

/**
 * What the stage should be showing.
 *
 * `complete` covers both the moment a hand finishes and the gap before the next one, because the
 * server sends `view: null` between hands and the hand that just ended is the honest thing to leave
 * on screen — labelled as finished, with its controls idle.
 */
function stageStatusOf(live: LiveTableModel): TableStageStatus {
  if (live.closed !== null && !live.closed.retryable) return 'error';
  if (live.phase === 'failed') return 'error';
  if (live.table.view === null) return live.status === 'live' ? 'ready' : 'loading';
  if (live.table.betweenHands || live.table.view.street === 'complete') return 'complete';
  return 'ready';
}

interface ConnectionPanelProps {
  readonly live: LiveTableModel;
}

/**
 * Where the setup has got to, as one sentence.
 *
 * ## The `failed` branch is a fix, not a nicety
 *
 * A setup that fails never opens a socket, so `live.status` stays `null` — and the final line
 * below used to read that as "Ready to connect." This paragraph is the page's ONLY `role="status"`
 * region, so a reader using a screen reader was told the table was ready to connect at the exact
 * moment the screen said it could not be prepared. The error itself was in an unlabelled `<div>`
 * with no live-region ancestor, so the false sentence was the *only* thing announced.
 *
 * The error is now announced by a `role="alert"` in `TableStage` (see the comment there), and this
 * region names the failure rather than denying it. Deliberately short: the reason itself is in the
 * alert and in the warning callout below, and repeating a paragraph in two live regions is how a
 * screen reader ends up reading the same failure three times.
 */
function statusSentence(live: LiveTableModel): string {
  if (live.phase === 'idle') {
    return (
      'Not connected yet. Opening the table creates a guest session — no email, no password — and a ' +
      'private six-handed room with five bots already seated.'
    );
  }
  if (live.phase === 'preparing') {
    return 'Preparing: reading your session, then finding or creating your private room.';
  }
  if (live.phase === 'failed') return 'The table could not be prepared. The reason is below.';
  return live.status === null ? 'Ready to connect.' : STATUS_LEDE[live.status];
}

/** What the reader should do or expect next, given where the machine is. */
function hintSentence(live: LiveTableModel): string {
  if (live.phase !== 'ready' || live.status !== 'live') return 'The table opens once the connection is live.';
  if (live.table.seat === null) {
    // The seat is whichever one is actually free, not a constant. At a room reached by invite code
    // seat 1 is the owner's, so naming it here would send the joiner at a seat they cannot have.
    return live.readerSeat === null
      ? 'Every seat is taken, so there is nowhere to sit at this table right now.'
      : `Seat ${String(live.readerSeat + 1)} is free — take it to be dealt in.`;
  }
  if (live.table.betweenHands) {
    return 'No hand is in progress. Dealing is the owner’s to ask for, so nothing starts until you do.';
  }
  return live.isMyTurn
    ? 'A hand is in progress and it is your decision.'
    : 'A hand is in progress. Waiting for another seat to act.';
}

/** Every reason the table is not doing what the reader asked, each with the server's own wording. */
function ConnectionNotices({ live }: ConnectionPanelProps): ReactElement {
  const { closed, table, setupError } = live;
  return (
    <>
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
      {table.notice === null ? null : (
        <Callout tone="warning" title="The server refused something">
          {table.notice}
        </Callout>
      )}
    </>
  );
}

/** The controls, each shown only where it is the thing to do. */
function ConnectionControls({ live }: ConnectionPanelProps): ReactElement {
  const { phase, closed, table } = live;
  const isLive = live.status === 'live';
  const seated = table.seat !== null;

  return (
    <p className="prl-btn-row">
      {phase === 'idle' || phase === 'failed' ? (
        <Button variant="primary" onClick={live.start}>
          {phase === 'failed' ? 'Try again' : 'Open the table'}
        </Button>
      ) : null}

      {/*
        A second creation, not a variant of the first. The bot table fills five of its six seats, so
        its invite code is a code to a table the server refuses everybody at — the private path needs
        a room with seats left in it. See `FRIENDS_TABLE_REQUEST`.
      */}
      {phase === 'idle' || phase === 'ready' || phase === 'failed' ? (
        <Button variant="secondary" onClick={live.startPrivateTable}>
          Start a private table to invite somebody to
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

      {isLive && !seated && live.readerSeat !== null ? (
        <Button variant="primary" onClick={live.sit}>
          {`Take seat ${String(live.readerSeat + 1)}`}
        </Button>
      ) : null}

      {isLive && seated ? (
        <Button variant="primary" onClick={live.deal} disabled={!table.betweenHands}>
          Deal the next hand
        </Button>
      ) : null}

      {isLive && seated ? (
        <Button variant="secondary" onClick={live.stand}>
          Stand up
        </Button>
      ) : null}

      {isLive && seated && !table.betweenHands && live.coachDuringHand ? (
        <Button variant="ghost" onClick={live.askCoach}>
          Refresh the analysis
        </Button>
      ) : null}
    </p>
  );
}

/**
 * The invite code for a room this page just created — the only moment it exists.
 *
 * ## Why this is a whole block and not a line in the facts list
 *
 * The server stores `sha256(code)` and has no column for the code itself, so it cannot be looked up
 * again by anybody, us included. `POST /rooms` is the one response that carries it. It used to be
 * discarded on arrival — no screen in this client had ever rendered the word `inviteCode` — which
 * is why "private, invite-only tables with people you already know" was a sentence about the server
 * and not something a reader could do.
 *
 * A value that exists once and is then gone forever has to be presented as one, so this says so
 * before the code rather than after it, and offers a copy that does not depend on selecting
 * nineteen characters by hand.
 *
 * ## The code is not stored anywhere by this client either
 *
 * Not in `sessionStorage` (which is where the room ID goes), not in `localStorage`, and not in the
 * URL. It lives in React state for as long as this component is mounted. A reload loses it, and
 * that is correct: writing it down would give this browser a durable key to a private room that the
 * server itself deliberately cannot reproduce.
 */
function InviteCode({ code }: { readonly code: string }): ReactElement {
  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle');

  const copy = (): void => {
    // Feature-detected rather than assumed: the Clipboard API is unavailable over plain HTTP on a
    // non-localhost origin and in some embedded webviews, and an unhandled rejection there would
    // leave the reader pressing a button that silently does nothing. The code is on screen and
    // selectable either way, so a failure costs the convenience and not the feature.
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
    <div className="prl-play__invite">
      <p className="prl-label">Invite code — shown once</p>
      <p className="prl-play__invite-code">
        <code className="prl-mono">{code}</code>
      </p>
      <p className="prl-btn-row">
        <Button variant="secondary" size="sm" onClick={copy}>
          Copy the code
        </Button>
        {/*
          Empty in the DOM from the first render rather than appearing with its text: a live region
          that arrives at the same moment as its content is missed by several screen readers.
        */}
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
 * The other half of a private table: arriving at one somebody else made.
 *
 * A real `<form>`, so Enter submits it from the field — a "join" that only works if you find the
 * button is a join that a person with a code in their clipboard gives up on. The button is not
 * disabled while the field is short: a disabled control with no stated reason is the pattern the
 * audit called out elsewhere in this app, and `normaliseInviteCode` produces a sentence saying what
 * is wrong instead.
 *
 * `aria-invalid` and `aria-describedby` are wired to the refusal, so the reason is announced with
 * the field rather than sitting somewhere below it — the field is where the reader is when they
 * find out.
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
          The code the table’s owner shared with you. Spaces and lower case are tidied up; the hyphens are
          part of the code and are not.
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

/** The setup half: session, room, socket — and every reason one of them is not there. */
function ConnectionPanel({ live }: ConnectionPanelProps): ReactElement {
  const room = live.table.room;

  return (
    <Panel
      className="prl-play__connection"
      title="This table"
      eyebrow="Connection"
      index={1}
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
        A polite live region, separate from the table's own. They describe different things — this
        one is the transport, that one is the hand — and merging them would announce "seat 3 raised
        to 300" and "reconnecting" as if they were the same kind of news.
      */}
      {/*
        The transport sentence and the "what to do next" sentence are one block, so `play.css` can put
        them side by side above 900px instead of stacking two short lines with a full gap between them.
        Nothing is hidden or shortened by that — see section 1.1 there.
      */}
      <div className="prl-play__connection-lines">
        <p role="status" className="prl-note">
          {statusSentence(live)}
        </p>

        <p className="prl-note">{hintSentence(live)}</p>
      </div>

      <ConnectionNotices live={live} />
      <ConnectionControls live={live} />

      {live.inviteCode === null ? null : <InviteCode code={live.inviteCode} />}

      <JoinByInviteCode live={live} />

      {room === null ? null : (
        <dl className="prl-stat__pair prl-play__facts">
          <dt className="prl-label">Room</dt>
          <dd>
            {`${room.name} — ${room.visibility.replace('_', '-')}, ${String(room.members.length)} at the table`}
          </dd>
          <dt className="prl-label">Blinds</dt>
          <dd>{`${String(room.smallBlind)} / ${String(room.bigBlind)} units`}</dd>
          <dt className="prl-label">Your seat</dt>
          <dd>{live.table.seat === null ? 'watching' : `seat ${String(live.table.seat + 1)}`}</dd>
        </dl>
      )}
    </Panel>
  );
}

export function LiveTable({
  legendMatch,
}: {
  readonly legendMatch?: {
    readonly profileId: string;
    readonly difficulty: 'educational' | 'realistic' | 'expert';
  };
} = {}): ReactElement {
  const live = useLiveTable(legendMatch === undefined ? {} : { legendMatch });
  const { table } = live;
  const status = stageStatusOf(live);
  const highlighted = live.highlightedCards;

  const act = (action: TableAction): void => live.act(action);

  return (
    <>
      <ConnectionPanel live={live} />

      <TableStage
        status={status}
        view={table.view}
        report={live.report}
        seatNames={live.seatNames}
        turn={live.turn}
        announcement={table.announcement}
        submission={table.submission}
        onAct={act}
        {...coachUnavailableProps(live)}
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

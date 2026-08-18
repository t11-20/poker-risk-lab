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
 * ## Nothing here decides a poker question
 *
 * The seat number is the server's. The buttons are the server's `legalActions`. The bet sizer's
 * bounds are the server's `minTo`/`maxTo`. Sitting, standing, dealing and acting are all intents:
 * this component asks, and draws whatever comes back. The Coach's numbers are computed server-side
 * from the reader's own redacted view and arrive as a whole `CoachReport`.
 */

import { Button, Callout, Panel, type TableAction } from '@prl/ui';
import type { ReactElement } from 'react';
import { TableStage, type TableStageStatus } from '@/components/TableStage.tsx';
import { READER_SEAT } from '@/lib/table-rooms.ts';
import type { TableSocketStatus } from '@/lib/table-socket.ts';
import { type LiveTable as LiveTableModel, useLiveTable } from '@/lib/use-live-table.ts';

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

/** Where the setup has got to, as one sentence. */
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
  return live.status === null ? 'Ready to connect.' : STATUS_LEDE[live.status];
}

/** What the reader should do or expect next, given where the machine is. */
function hintSentence(live: LiveTableModel): string {
  if (live.phase !== 'ready' || live.status !== 'live') return 'The table opens once the connection is live.';
  if (live.table.seat === null) {
    return `Seat ${String(READER_SEAT + 1)} is the free one — the five bots hold the rest.`;
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

      {isLive && !seated ? (
        <Button variant="primary" onClick={live.sit}>
          {`Take seat ${String(READER_SEAT + 1)}`}
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

      {isLive && seated && !table.betweenHands ? (
        <Button variant="ghost" onClick={live.askCoach}>
          Refresh the analysis
        </Button>
      ) : null}
    </p>
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

export function LiveTable(): ReactElement {
  const live = useLiveTable();
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
        {...(live.coachProblem === null
          ? {}
          : {
              coachUnavailableReason:
                `The server sent an analysis this page could not read: ${live.coachProblem}. ` +
                'It was refused rather than shown in part. The table itself is unaffected — it is drawn ' +
                'from separate frames.',
            })}
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

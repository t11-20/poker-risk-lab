/**
 * The table (phase spine, pot, board and every seat), drawn only from the server's redacted `PlayerView`.
 * The surface is graph paper, not a casino. No felt, no green.
 * Layout switches on a container query at 46rem (the arithmetic is in `@container prl-table`).
 * DOM order is pot and board, opponents, then the viewer, which reads well aloud. The stacked layout
 * reorders visually with `order`, which is safe only because nothing in the table field is focusable.
 * If a seat ever gets a focusable control, the `order` declarations must go.
 * The opponents grid wraps rather than scrolls, because a scroller with no focusable content fails
 * WCAG 2.1.1. The narration region lives in `TableStage`, outside the conditional that renders this,
 * so the first hand of a session is announced.
 */

import { unmatchedPartOf } from '@prl/contracts';
import type { ReactElement } from 'react';
import { listCardNames } from '../cards.ts';
import { cx } from '../cx.ts';
import { formatChips, formatIndex, formatUnits } from '../format.ts';
import { lastActionsThisStreet } from '../seat-actions.ts';
import type { PlayerView, PotLayer, SeatView, Street } from '../view-types.ts';
import { CardRow } from './CardRow.tsx';
import { PotDisplay } from './PotDisplay.tsx';
import { Seat } from './Seat.tsx';
import type { TurnClock } from './TurnTimer.tsx';

export interface PokerTableProps {
  readonly view: PlayerView;
  readonly title?: string;
  /** `playerId` is opaque and never shown. */
  readonly seatNames?: Readonly<Record<number, string>>;
  readonly highlightedCards?: readonly number[];
  /** Appended to each marked card's accessible name, because the ring is a visual cue only. */
  readonly highlightLabel?: string;
  /** Absent or `null` renders the active seat's other two cues without a ring. */
  readonly turn?: TurnClock | null;
  /** Off by default. Review and the Lab already narrate a hand step by step. */
  readonly showLastActions?: boolean;
  readonly className?: string;
}

/** Five steps, not the engine's six streets. `showdown` and `complete` are one phase to a reader. */
const PHASES = ['preflop', 'flop', 'turn', 'river', 'showdown'] as const;
type Phase = (typeof PHASES)[number];

const PHASE_OF_STREET: Readonly<Record<Street, Phase>> = {
  preflop: 'preflop',
  flop: 'flop',
  turn: 'turn',
  river: 'river',
  showdown: 'showdown',
  complete: 'showdown',
};

type PhaseState = 'done' | 'current' | 'pending';

/** The viewer first. Done in the DOM, not CSS `order`, because the reading order has to match. */
function rotateToViewer(seats: readonly SeatView[], viewerSeat: number | null): readonly SeatView[] {
  if (viewerSeat === null) return seats;
  const at = seats.findIndex((seat) => seat.seat === viewerSeat);
  if (at <= 0) return seats;
  return [...seats.slice(at), ...seats.slice(0, at)];
}

function seatLabel(seat: SeatView, seatNames: Readonly<Record<number, string>> | undefined): string {
  return seatNames?.[seat.seat] ?? `Seat ${seat.seat + 1}`;
}

/** The board's accessible name, so it is announced as one group. */
function boardName(board: readonly number[]): string {
  if (board.length === 0) return 'community cards: none dealt yet';
  return `community cards: ${listCardNames(board)}`;
}

interface PhaseSpineProps {
  readonly view: Pick<PlayerView, 'street' | 'board' | 'result'>;
}

const PHASE_OF_BOARD: readonly Phase[] = ['preflop', 'preflop', 'preflop', 'flop', 'turn', 'river'];

/**
 * The spine step a hand is on, or for a finished hand the step it ended on. A hand won uncontested
 * (`result.showdowns` empty) ends on the street its board length implies, not on showdown.
 */
function phaseOf(view: PhaseSpineProps['view']): Phase {
  if (view.street === 'complete' && view.result !== null && view.result.showdowns.length === 0) {
    return PHASE_OF_BOARD[view.board.length] ?? 'river';
  }
  return PHASE_OF_STREET[view.street];
}

function PhaseSpine({ view }: PhaseSpineProps): ReactElement {
  const current = phaseOf(view);
  const currentAt = PHASES.indexOf(current);
  const over = view.street === 'complete';

  return (
    <ol className="prl-table__spine">
      {PHASES.map((phase, position) => {
        let state: PhaseState = 'pending';
        if (position < currentAt) state = 'done';
        else if (position === currentAt) state = 'current';
        return (
          <li
            className="prl-table__step"
            key={`phase-${phase}`}
            data-state={state}
            /** With an accent underline, heavier weight and hidden text, so not hue alone. */
            {...(state === 'current' ? { 'aria-current': 'step' as const } : {})}
          >
            <span className="prl-table__step-index prl-index" aria-hidden="true">
              {formatIndex(position + 1)}
            </span>
            <span className="prl-table__step-name">{phase}</span>
            {state === 'current' ? (
              <span className="prl-visually-hidden">
                {over ? ' (where the hand ended)' : ' (current phase)'}
              </span>
            ) : null}
            {state === 'done' ? <span className="prl-visually-hidden">{' (done)'}</span> : null}
          </li>
        );
      })}
    </ol>
  );
}

/** Once paid, chips that went back unmatched were never contested, so they are not shown as a pot. */
function potsShown(view: PlayerView): { readonly total: number; readonly pots: readonly PotLayer[] } {
  const result = view.result;
  if (result === null) return { total: view.potTotal, pots: view.pots };
  const back = result.pots.reduce((sum, pot) => sum + unmatchedPartOf(pot, result.pots), 0);
  const pots = view.pots
    .map((pot) => ({ ...pot, amount: pot.amount - unmatchedPartOf(pot, view.pots) }))
    .filter((pot) => pot.amount > 0);
  return { total: view.potTotal - back, pots };
}

export function PokerTable(props: PokerTableProps): ReactElement {
  const { view, title, seatNames, highlightedCards, highlightLabel } = props;
  const { turn = null, className, showLastActions = false } = props;
  const lastActions = showLastActions ? lastActionsThisStreet(view) : {};

  const seats = rotateToViewer(view.seats, view.viewerSeat);
  const heading = title ?? `Hand ${formatChips(view.handNumber)}`;
  const headingId = `prl-table-heading-${view.handId}`;
  const board = [...view.board];
  const shown = potsShown(view);

  // The viewer's plate sits outside the opponents list so the stacked layout can pin it.
  // Found rather than indexed, because `!` is banned repo-wide.
  const heroIndex = seats.findIndex((seat) => seat.isSelf);
  const hero = seats.find((seat) => seat.isSelf) ?? null;

  const highlightProps = {
    ...(highlightedCards === undefined ? {} : { highlightedCards }),
    ...(highlightLabel === undefined ? {} : { highlightLabel }),
  };

  return (
    <section className={cx('prl-table', className)} aria-labelledby={headingId}>
      <div className="prl-table__header">
        <h2 className="prl-table__heading" id={headingId}>
          {heading}
        </h2>
        <ul className="prl-table__meta">
          <li className="prl-badge">
            {`blinds ${formatChips(view.config.smallBlind)} / ${formatChips(view.config.bigBlind)}`}
          </li>
          <li className="prl-badge">
            {view.toAct === null ? 'no one to act' : `seat ${view.toAct + 1} to act`}
          </li>
          {view.amountToCall > 0 ? (
            <li className="prl-badge prl-badge--caution">{`${formatUnits(view.amountToCall)} to call`}</li>
          ) : null}
        </ul>
        <PhaseSpine view={view} />
      </div>

      <div className="prl-table__field">
        <div className="prl-table__oval" aria-hidden="true" />

        <div className="prl-table__centre">
          <PotDisplay
            total={shown.total}
            pots={shown.pots}
            {...(seatNames === undefined ? {} : { seatNames })}
          />
          <div className="prl-table__board">
            <span className="prl-table__board-label prl-label" aria-hidden="true">
              Board
            </span>
            <CardRow
              cards={board}
              label={boardName(board)}
              showLabel={false}
              size="md"
              {...highlightProps}
              emptyText="no community cards yet"
              className="prl-card-row--dealing"
            />
          </div>
        </div>

        <ul className="prl-table__opponents">
          {seats.map((seat, index) =>
            seat.isSelf ? null : (
              <Seat
                key={`seat-${seat.seat}`}
                seat={seat}
                street={view.street}
                name={seatLabel(seat, seatNames)}
                ringIndex={index}
                ringCount={seats.length}
                turn={seat.isToAct ? turn : null}
                lastAction={lastActions[seat.seat] ?? null}
                {...highlightProps}
                as="li"
              />
            ),
          )}
        </ul>

        {hero === null ? null : (
          <div className="prl-table__hero">
            <Seat
              seat={hero}
              street={view.street}
              name={seatLabel(hero, seatNames)}
              ringIndex={heroIndex}
              ringCount={seats.length}
              turn={hero.isToAct ? turn : null}
              lastAction={lastActions[hero.seat] ?? null}
              {...highlightProps}
              as="div"
            />
          </div>
        )}
      </div>
    </section>
  );
}

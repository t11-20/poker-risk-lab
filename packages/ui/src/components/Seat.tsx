/**
 * One seat at the table.
 * 1. `faceDown` comes from `holeCards` being `null`, the server's silence. The placeholder is `-1`,
 *    not `0`, because 0 is the two of clubs.
 * 2. The seat to act has three cues (accent edge, `TO ACT` chip, turn ring), so each survives forced
 *    colors or reduced motion removing another.
 * 3. On `complete` the status is past tense and the live "all in" chip is dropped, because the engine
 *    still sends last statuses after the pot is awarded. `showdown` is not settled.
 * 4. Folded seats swap the surface, never the opacity, which would take a 4.5:1 label under the floor.
 * `as` is a prop, not a wrapper, because the element carries the oval placement.
 */

import type { ReactElement } from 'react';
import { cx, type StyleWithVars } from '../cx.ts';
import { formatChips } from '../format.ts';
import type { SeatStatus, SeatView, Street } from '../view-types.ts';
import { CardRow } from './CardRow.tsx';
import { Chip } from './Chip.tsx';
import { type TurnClock, TurnTimer } from './TurnTimer.tsx';

export interface SeatProps {
  readonly seat: SeatView;
  /** Required, because `SeatStatus` alone cannot say whether "all in" still stands (rule 3). */
  readonly street: Street;
  /** `playerId` is opaque and never shown. */
  readonly name: string;
  /** 0-based, with 0 at the bottom where the viewer sits. Ignored by the stacked layout. */
  readonly ringIndex: number;
  readonly ringCount: number;
  /** `null` renders the other two active cues without a ring. */
  readonly turn?: TurnClock | null;
  readonly highlightedCards?: readonly number[];
  /** Joins each ringed card's accessible name, because the ring is a visual cue only. */
  readonly highlightLabel?: string;
  /** Replaces "in the hand" on the status line (`../seat-actions.ts`). Ignored once settled. */
  readonly lastAction?: string | null;
  readonly as?: 'li' | 'div';
  readonly className?: string;
}

const STATUS_TEXT: Readonly<Record<SeatStatus, string>> = {
  active: 'in the hand',
  folded: 'folded',
  allIn: 'all in',
  sittingOut: 'sitting out',
};

/** Past tense for the two statuses that described a hand in progress. */
const SETTLED_STATUS_TEXT: Readonly<Record<SeatStatus, string>> = {
  active: 'still in at the end',
  folded: 'folded',
  allIn: 'went all in',
  sittingOut: 'sitting out',
};

/** The pot has been awarded. `showdown` is not this. */
function isSettled(street: Street): boolean {
  return street === 'complete';
}

const STATUS_CLASS: Readonly<Record<SeatStatus, string>> = {
  active: '',
  folded: 'prl-seat--folded',
  allIn: 'prl-seat--all-in',
  sittingOut: 'prl-seat--sitting-out',
};

const FACE_DOWN_PAIR: readonly number[] = [-1, -1];

/**
 * Screen coordinates, so `PI / 2` puts ring index 0 at the bottom. The radii leave half a plate of
 * margin, because seats are positioned by their centre. They pair with the `min-height` in the
 * `@container prl-table` block of components.css. Change both together.
 */
const RING_RADIUS_X = 38;
const RING_RADIUS_Y = 36;

export function seatRingPosition(index: number, count: number): StyleWithVars {
  const safeCount = Math.max(count, 1);
  const angle = Math.PI / 2 + (index * 2 * Math.PI) / safeCount;
  const x = 50 + RING_RADIUS_X * Math.cos(angle);
  const y = 50 + RING_RADIUS_Y * Math.sin(angle);
  return { '--prl-seat-x': `${x.toFixed(2)}%`, '--prl-seat-y': `${y.toFixed(2)}%` };
}

function statusLine(status: SeatStatus, settled: boolean, lastAction: string | null): string {
  if (settled) return SETTLED_STATUS_TEXT[status];
  return lastAction !== null && status !== 'sittingOut' ? lastAction : STATUS_TEXT[status];
}

/** Skipped after a name that already says it. Fixtures name the reader "You", which read "You (you)". */
function needsSelfMarker(isSelf: boolean, name: string): boolean {
  return isSelf && name !== 'You';
}

export function Seat(props: SeatProps): ReactElement {
  const { seat, street, name, ringIndex, ringCount, turn = null, highlightedCards, highlightLabel } = props;
  const { as = 'li', className, lastAction = null } = props;

  const Tag = as;
  const settled = isSettled(street);
  const holeCards = seat.holeCards;
  const faceDown = holeCards === null;
  const isHoldingCards = seat.status === 'active' || seat.status === 'allIn';
  let cards: readonly number[] = [];
  if (holeCards !== null) cards = holeCards;
  else if (isHoldingCards) cards = FACE_DOWN_PAIR;

  /**
   * The plate-level mark for a seat holding ringed cards (`styles/play.css` section 12.3). Not called
   * `--won`, because review marks cards for reasons other than winning.
   */
  const marked =
    highlightedCards !== undefined &&
    highlightedCards.length > 0 &&
    holeCards?.some((card) => highlightedCards.includes(card)) === true;

  return (
    <Tag
      className={cx(
        'prl-seat',
        STATUS_CLASS[seat.status],
        seat.isSelf && 'prl-seat--self',
        seat.isToAct && 'prl-seat--to-act',
        marked && 'prl-seat--marked',
        className,
      )}
      style={seatRingPosition(ringIndex, ringCount)}
      data-status={seat.status}
      data-to-act={seat.isToAct ? 'true' : 'false'}
    >
      <div className="prl-seat__top">
        {seat.position === null ? (
          <span className="prl-seat__position prl-label">no position</span>
        ) : (
          <span className="prl-seat__position prl-label">{seat.position}</span>
        )}
        <span className="prl-seat__badges">
          {seat.isButton ? (
            <span className="prl-badge prl-badge--dealer">
              <span aria-hidden="true">D</span>
              <span className="prl-visually-hidden">dealer button</span>
            </span>
          ) : null}
          {seat.isToAct ? (
            <Chip tone="accent" pill>
              to act
            </Chip>
          ) : null}
          {/* A live badge, gone once the hand is settled. On the winner it read as a stake still out. */}
          {seat.status === 'allIn' && !settled ? (
            <Chip tone="caution" pill>
              all in
            </Chip>
          ) : null}
          {seat.isToAct && turn !== null ? (
            /* "Ada's turn timer" reads correctly, "You turn timer" does not. */
            <TurnTimer clock={turn} label={seat.isSelf ? 'Your turn timer' : `${name} turn timer`} />
          ) : null}
        </span>
      </div>

      <p className="prl-seat__name">
        {name}
        {needsSelfMarker(seat.isSelf, name) ? <span className="prl-seat__you">{' (you)'}</span> : null}
      </p>

      {/* One `div` per pair, so a wrapping row breaks between pairs, never inside one. */}
      <dl className="prl-seat__stats">
        <div className="prl-seat__stat">
          <dt className="prl-seat__stat-label">Stack</dt>
          <dd className="prl-seat__stat-value">{formatChips(seat.stack)}</dd>
        </div>
        <div className="prl-seat__stat">
          <dt className="prl-seat__stat-label">
            {'In front'}
            <span className="prl-visually-hidden">{' this street'}</span>
          </dt>
          <dd className="prl-seat__stat-value">{formatChips(seat.committedThisStreet)}</dd>
        </div>
      </dl>

      {/* The last action rides on the status line, because six 13rem plates have no height to spare. */}
      <p className="prl-seat__status">{statusLine(seat.status, settled, lastAction)}</p>

      {seat.status === 'sittingOut' ? null : (
        <CardRow
          cards={cards}
          label={`${name} hole cards`}
          showLabel={false}
          faceDown={faceDown}
          size="sm"
          tight
          {...(highlightedCards === undefined ? {} : { highlightedCards })}
          {...(highlightLabel === undefined ? {} : { highlightLabel })}
          emptyText="no cards"
          className="prl-seat__cards"
        />
      )}
    </Tag>
  );
}

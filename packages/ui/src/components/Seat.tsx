/**
 * One seat at the table.
 * 1. `faceDown` comes from `holeCards` being `null`, the server's silence. The placeholder is `-1`,
 *    not `0`, because 0 is the two of clubs.
 * 2. The seat to act has three cues (a second outline, the words "to act", the turn ring), so each
 *    survives forced colors or reduced motion removing another.
 * 3. On `complete` the status is past tense, because the engine still sends last statuses after the pot
 *    is awarded. `showdown` is not settled. "All in" is said on the status line, never as a badge.
 * 4. Folded seats swap the outline and the ink, never the opacity, which would take a 4.5:1 label under
 *    the floor.
 * The plate (`__plate`) is the box with the words in it, under a round disc that shows the seat
 * number. An opponent's cards sit beside that disc. The viewer's large cards sit beside the disc
 * and the plate. The dealer disc sits on the felt edge of the avatar, and the turn ring wraps the
 * avatar. `as` is a prop, not a wrapper, because the element carries its place (`data-slot`).
 */

import type { ReactElement } from 'react';
import { cx } from '../cx.ts';
import { formatChips } from '../format.ts';
import type { SeatStatus, SeatView, Street } from '../view-types.ts';
import { CardRow } from './CardRow.tsx';
import { type TurnClock, TurnTimer } from './TurnTimer.tsx';

export interface SeatProps {
  readonly seat: SeatView;
  /** Required, because `SeatStatus` alone cannot say whether "all in" still stands (rule 3). */
  readonly street: Street;
  /** `playerId` is opaque and never shown. */
  readonly name: string;
  /** 0-based, clockwise from the bottom, where the viewer sits. */
  readonly ringIndex: number;
  readonly ringCount: number;
  /** `null` renders the other two active cues without a ring. */
  readonly turn?: TurnClock | null;
  readonly highlightedCards?: readonly number[];
  /** Joins each ringed card's accessible name, because the ring is a visual cue only. */
  readonly highlightLabel?: string;
  /** The status line while the seat is live (`../seat-actions.ts`). Ignored once settled. */
  readonly lastAction?: string | null;
  readonly as?: 'li' | 'div';
  readonly className?: string;
}

/** A live seat with no action yet says nothing: its cards already show it is in. */
const STATUS_TEXT: Readonly<Record<SeatStatus, string>> = {
  active: '',
  folded: 'folded',
  allIn: 'all in',
  sittingOut: 'sitting out',
};

/** Past tense for the two statuses that described a hand in progress. */
const SETTLED_STATUS_TEXT: Readonly<Record<SeatStatus, string>> = {
  active: 'stayed in',
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

/** Where a seat sits round the table. The grid in the PokerTable block of components.css places each. */
export type SeatSlot = 'hero' | 'left-low' | 'left-high' | 'top' | 'right-high' | 'right-low';

/** Clockwise from the viewer at the bottom, by how many are dealt in. Rooms seat two to six. */
const SLOTS_BY_COUNT: Readonly<Record<number, readonly SeatSlot[]>> = {
  1: ['hero'],
  2: ['hero', 'top'],
  3: ['hero', 'left-high', 'right-high'],
  4: ['hero', 'left-low', 'top', 'right-low'],
  5: ['hero', 'left-low', 'left-high', 'right-high', 'right-low'],
  6: ['hero', 'left-low', 'left-high', 'top', 'right-high', 'right-low'],
};

export function seatSlot(index: number, count: number): SeatSlot {
  return SLOTS_BY_COUNT[count]?.[index] ?? SLOTS_BY_COUNT[6]?.[index] ?? 'top';
}

function statusLine(status: SeatStatus, settled: boolean, lastAction: string | null): string {
  if (settled) return SETTLED_STATUS_TEXT[status];
  return lastAction !== null && status !== 'sittingOut' ? lastAction : STATUS_TEXT[status];
}

/**
 * One line for what the seat did and what it has in this street: "called 35", "10 in", "folded, 5 in".
 * The chips are added unless the action already names them, so no live seat's commitment is dropped.
 * One shared line, because a seat box has no height for a separate row.
 */
function seatLine(seat: SeatView, settled: boolean, lastAction: string | null): string {
  const status = statusLine(seat.status, settled, lastAction);
  // Settled chips are in the winners' stacks, and a figure beside "went all in" read as a stake still out.
  if (settled || seat.committedThisStreet <= 0) return status;
  const amount = formatChips(seat.committedThisStreet);
  // A thousands comma is part of a figure, so only a comma not followed by a digit ends one.
  if (new RegExp(`(^|\\s)${amount}(?=$|\\s|,(?!\\d))`, 'u').test(status)) return status;
  return status === '' ? `${amount} in` : `${status}, ${amount} in`;
}

/** Skipped after a name that already says it. Fixtures name the reader "You", which read "You (you)". */
function needsSelfMarker(isSelf: boolean, name: string): boolean {
  return isSelf && name !== 'You';
}

/** Kept when blank, so a plate does not shrink while its seat has yet to act. */
function StatusLine({ text }: { readonly text: string }): ReactElement {
  return text === '' ? (
    <p className="prl-seat__status" aria-hidden="true">
      {'\u00a0'}
    </p>
  ) : (
    <p className="prl-seat__status">{text}</p>
  );
}

/** Revealed cards, two backs, or an empty row. Sitting out has no row at all. */
function holeHand(seat: SeatView): { readonly cards: readonly number[]; readonly faceDown: boolean } | null {
  if (seat.status === 'sittingOut') return null;
  const holeCards = seat.holeCards;
  const faceDown = holeCards === null;
  if (holeCards !== null) return { cards: holeCards, faceDown };
  const holding = seat.status === 'active' || seat.status === 'allIn';
  return { cards: holding ? FACE_DOWN_PAIR : [], faceDown };
}

function HoleCards(props: {
  readonly seat: SeatView;
  readonly name: string;
  readonly highlightedCards?: readonly number[];
  readonly highlightLabel?: string;
}): ReactElement | null {
  const hand = holeHand(props.seat);
  if (hand === null) return null;
  const { highlightedCards, highlightLabel } = props;
  return (
    <CardRow
      cards={hand.cards}
      label={`${props.name} hole cards`}
      showLabel={false}
      faceDown={hand.faceDown}
      size={props.seat.isSelf ? 'lg' : 'sm'}
      tight
      {...(highlightedCards === undefined ? {} : { highlightedCards })}
      {...(highlightLabel === undefined ? {} : { highlightLabel })}
      emptyText="no cards"
      emptyTextHidden
      className={cx('prl-seat__cards', hand.cards.length === 0 && 'prl-seat__cards--empty')}
    />
  );
}

function seatClassName(seat: SeatView, marked: boolean, className: string | undefined): string {
  return cx(
    'prl-seat',
    STATUS_CLASS[seat.status],
    seat.isSelf && 'prl-seat--self',
    seat.isToAct && 'prl-seat--to-act',
    marked && 'prl-seat--marked',
    className,
  );
}

export function Seat(props: SeatProps): ReactElement {
  const { seat, street, name, ringIndex, ringCount, turn = null, highlightedCards, highlightLabel } = props;
  const { as = 'li', className, lastAction = null } = props;

  const Tag = as;
  const settled = isSettled(street);
  const status = seatLine(seat, settled, lastAction);
  const holeCards = seat.holeCards;

  /** The seat-level mark for a seat holding ringed cards. Not `--won`: review marks cards for other reasons. */
  const marked =
    highlightedCards !== undefined &&
    highlightedCards.length > 0 &&
    holeCards?.some((card) => highlightedCards.includes(card)) === true;

  const hole = (
    <HoleCards
      seat={seat}
      name={name}
      {...(highlightedCards === undefined ? {} : { highlightedCards })}
      {...(highlightLabel === undefined ? {} : { highlightLabel })}
    />
  );

  return (
    <Tag
      className={seatClassName(seat, marked, className)}
      data-slot={seatSlot(ringIndex, ringCount)}
      data-status={seat.status}
      data-to-act={seat.isToAct ? 'true' : 'false'}
    >
      <div className="prl-seat__cluster">
        {seat.isSelf ? null : hole}
        <div className="prl-seat__disc">
          {seat.isToAct && turn !== null ? (
            /* "Ada's turn timer" reads correctly, "You turn timer" does not. */
            <TurnTimer clock={turn} label={seat.isSelf ? 'Your turn timer' : `${name} turn timer`} />
          ) : null}
          {/* The name already says which seat. The numeral is the disc, as on the rail. */}
          <span className="prl-seat__avatar" aria-hidden="true">
            {String(seat.seat + 1)}
          </span>
          {seat.isButton ? (
            <span className="prl-badge prl-badge--dealer">
              <span aria-hidden="true">D</span>
              <span className="prl-visually-hidden">dealer button</span>
            </span>
          ) : null}
        </div>
      </div>

      <div className="prl-seat__plate">
        {seat.position === null ? (
          <span className="prl-seat__position prl-label prl-visually-hidden">no position</span>
        ) : (
          <span className="prl-seat__position prl-label prl-visually-hidden">{seat.position}</span>
        )}
        {seat.isToAct ? <span className="prl-seat__turn">to act</span> : null}

        <p className="prl-seat__name">
          {name}
          {needsSelfMarker(seat.isSelf, name) ? <span className="prl-seat__you">{' (you)'}</span> : null}
        </p>

        {/* The figure alone is drawn, as on a real table. The label is still spoken. */}
        <dl className="prl-seat__stats">
          <div className="prl-seat__stat">
            <dt className="prl-seat__stat-label prl-visually-hidden">Stack</dt>
            <dd className="prl-seat__stat-value">{formatChips(seat.stack)}</dd>
          </div>
        </dl>

        <StatusLine text={status} />
      </div>

      {seat.isSelf ? hole : null}
    </Tag>
  );
}

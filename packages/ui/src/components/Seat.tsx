/**
 * One seat at the table: who is there, what they have behind, what they have in front, and
 * whether the decision is theirs.
 *
 * Extracted out of `PokerTable` because a seat is the densest object on the screen and it has
 * four separate correctness rules of its own — hidden cards, the three-cue active state, what a
 * status means once the hand is over, and forced colors — none of which is easy to see when it is
 * a nested function in a 300-line table.
 *
 * ## 1. A face-down card is face-down because the SERVER said nothing
 *
 * `faceDown` is derived from `seat.holeCards === null`, never from a flag this component owns.
 * `null` means "you are not entitled to see these", which is exactly the condition for drawing a
 * back — so "should I show these cards?" is not a question this component can get wrong. The
 * placeholder value is `-1`, not `0`: `PlayingCard` short-circuits on `faceDown` before it decodes
 * anything, but `0` is a real card (the two of clubs), and leaving real card integers in the props
 * of a hidden card is how an accidental leak starts. `-1` is not a card, so there is nothing here
 * to leak.
 *
 * ## 2. Whose turn it is, marked THREE ways at once
 *
 * Whose turn it is is the single most important fact on the screen, so it never depends on
 * noticing a colour:
 *
 *   1. an accent edge on the seat plate (`.prl-seat--to-act`),
 *   2. a `TO ACT` chip whose content is the literal words,
 *   3. the draining turn-timer ring, when the caller has a deadline to render.
 *
 * Under `forced-colors: active` the plate's hairline is drawn with `background-color` and is
 * therefore repainted out of existence, so components.css gives the active seat a real border plus
 * an outline in `Highlight`. Under `prefers-reduced-motion` the ring stops draining and reads as a
 * full accent ring — a state rather than a clock — and the seconds remain as text inside it. Each
 * of the three cues survives at least one of those conditions killing the others.
 *
 * ## 3. A settled hand is described in the past tense, and wears no live badges
 *
 * `SeatStatus` describes a seat's participation *in the current hand*, and the engine keeps sending
 * it after the hand is over — `street: 'complete'` with everybody's last status still on them. Read
 * as present tense that is wrong on every unfolded seat.
 *
 * Measured on the built app at `/play?state=complete` — the settled fixture, and the same component
 * the live table draws when the last frame of a hand arrives. Two seats read **"in the hand"** and
 * the viewer's own seat, which had just won the main pot with an ace-high flush, read **"all in"**
 * and wore an **"all in" chip**. Nothing was in any hand: the pot had been awarded.
 *
 * So `complete` gets its own wording, and the chip — which is a badge about the seat's live state,
 * "this seat has no decisions left in this hand" — is not drawn at all, because that is true of
 * every seat once the hand is over and on the winner it reads as money still in the middle.
 *
 * `showdown` is deliberately NOT included: the cards are down but the pot has not been awarded, so
 * a seat that has not folded genuinely is still in the hand.
 *
 * ## 4. Folded and sitting-out swap the SURFACE, never the opacity
 *
 * That rule lives in the stylesheet, but it is worth knowing here: `opacity: 0.6` on a whole plate
 * dims the text with it and silently takes a 4.5:1 label under the floor. A folded seat is still
 * information — how many players are left, and who — so it stays legible.
 *
 * ## `as`
 *
 * The table places its opponents in a `<ul>` and the viewer's own seat outside it (so the two can
 * be re-flowed independently below 900px), so this renders either an `<li>` or a `<div>`. The
 * element carries the absolute placement in the oval layout, which is why the choice is a prop
 * rather than a wrapper: a wrapper would take the positioning and the plate would sit inside it.
 *
 * Server-render safe: no state, no effects, no `window`. The turn ring's countdown is a client
 * component and marks its own boundary.
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
  /**
   * The phase the hand is in, from `PlayerView.street`.
   *
   * Required rather than defaulted: `SeatStatus` alone cannot say whether "all in" is a commitment
   * still standing or something that happened, and a component that guessed "still playing" would
   * be wrong in exactly the state a reader is most likely to be looking at — the settled frame at
   * the end of a hand. See rule 3 in the module comment.
   */
  readonly street: Street;
  /** Display name. `playerId` is an opaque id and is never shown. */
  readonly name: string;
  /**
   * Place on the oval, 0-based, with 0 at the bottom (where the viewer sits). Ignored by the
   * stacked layout, which flows seats in DOM order.
   */
  readonly ringIndex: number;
  /** How many seats share the oval. */
  readonly ringCount: number;
  /**
   * The server's turn deadline, when this seat is the one to act and the caller has one. `null`
   * renders the other two active cues without a ring, which is the correct rendering for a
   * spectator view or a table with no clock.
   */
  readonly turn?: TurnClock | null;
  /** Cards to ring, e.g. the five that made a hand in review. */
  readonly highlightedCards?: readonly number[];
  /**
   * What the ring MEANS, e.g. "part of the winning hand". Announced, not drawn: the accent border and
   * the corner notch are cues only a sighted reader gets, so the phrase joins the card's accessible
   * name. Why a card is marked is the caller's knowledge, which is why it is a prop and not a default.
   */
  readonly highlightLabel?: string;
  /** `li` inside the opponents list, `div` for the viewer's own plate. */
  readonly as?: 'li' | 'div';
  readonly className?: string;
}

/** What a seat's status means while the hand is still being played. */
const STATUS_TEXT: Readonly<Record<SeatStatus, string>> = {
  active: 'in the hand',
  folded: 'folded',
  allIn: 'all in',
  sittingOut: 'sitting out',
};

/**
 * And what it means once the pot has been awarded. See rule 3 in the module comment.
 *
 * Past tense for the two that were about a hand in progress, unchanged for the two that were not:
 * "folded" already describes something that happened, and a seat sitting out is still sitting out.
 */
const SETTLED_STATUS_TEXT: Readonly<Record<SeatStatus, string>> = {
  active: 'still in at the end',
  folded: 'folded',
  allIn: 'went all in',
  sittingOut: 'sitting out',
};

/** The pot has been awarded and nobody is in anything. `showdown` is not this; see rule 3. */
function isSettled(street: Street): boolean {
  return street === 'complete';
}

const STATUS_CLASS: Readonly<Record<SeatStatus, string>> = {
  active: '',
  folded: 'prl-seat--folded',
  allIn: 'prl-seat--all-in',
  sittingOut: 'prl-seat--sitting-out',
};

/** See rule 1 in the module comment: not a card, so there is no value to leak. */
const FACE_DOWN_PAIR: readonly number[] = [-1, -1];

/**
 * A seat's place on the oval, as percentages of the field.
 *
 * Screen coordinates, so y grows downward and `PI / 2` is the bottom of the ellipse — which is
 * where ring index 0 lands, and that is where a player expects to be sitting.
 *
 * The radii are 38% / 36% rather than 50% because a seat is positioned by its *centre*
 * (`translate: -50% -50%` in the CSS), so the ring has to leave half a plate of margin inside the
 * field or the outermost seats hang over the edge. These two numbers are paired with the derived
 * `min-height` in the `@container prl-table` block of components.css, which works through the
 * arithmetic. Change one and the six-handed layout starts to overlap; change both together.
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

export function Seat(props: SeatProps): ReactElement {
  const { seat, street, name, ringIndex, ringCount, turn = null, highlightedCards, highlightLabel } = props;
  const { as = 'li', className } = props;

  const Tag = as;
  const settled = isSettled(street);
  const holeCards = seat.holeCards;
  const faceDown = holeCards === null;
  const isHoldingCards = seat.status === 'active' || seat.status === 'allIn';
  let cards: readonly number[] = [];
  if (holeCards !== null) cards = holeCards;
  else if (isHoldingCards) cards = FACE_DOWN_PAIR;

  return (
    <Tag
      className={cx(
        'prl-seat',
        STATUS_CLASS[seat.status],
        seat.isSelf && 'prl-seat--self',
        seat.isToAct && 'prl-seat--to-act',
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
          {/* Cue 2 of 3. The words are the information; the accent is the third cue on top. */}
          {seat.isToAct ? (
            <Chip tone="accent" pill>
              to act
            </Chip>
          ) : null}
          {/*
            A live badge, so it is gone once the hand is. "All in" on this plate means the seat has
            put its stack in and has no decisions left in this hand — true of every seat after the
            pot is awarded, and on the seat that just WON the pot it reads as a commitment still
            outstanding. The status line below keeps the fact in the past tense.
          */}
          {seat.status === 'allIn' && !settled ? (
            <Chip tone="caution" pill>
              all in
            </Chip>
          ) : null}
          {/* Cue 3 of 3, and only when there is a real server deadline to draw. */}
          {seat.isToAct && turn !== null ? (
            /* Phrased two ways because the seat's own name is the subject: "Ada's turn timer" reads
               correctly, "You turn timer" does not. */
            <TurnTimer clock={turn} label={seat.isSelf ? 'Your turn timer' : `${name} turn timer`} />
          ) : null}
        </span>
      </div>

      <p className="prl-seat__name">
        {name}
        {seat.isSelf ? <span className="prl-seat__you">{' (you)'}</span> : null}
      </p>

      <dl className="prl-seat__stats">
        <dt className="prl-seat__stat-label">Stack</dt>
        <dd className="prl-seat__stat-value">{formatChips(seat.stack)}</dd>
        <dt className="prl-seat__stat-label">
          {'In front'}
          {/* Compact on screen, unambiguous read aloud: "in front" is the table term for exactly
              this street's commitment, and a learner should not have to already know that. */}
          <span className="prl-visually-hidden">{' this street'}</span>
        </dt>
        <dd className="prl-seat__stat-value">{formatChips(seat.committedThisStreet)}</dd>
      </dl>

      <p className="prl-seat__status">{(settled ? SETTLED_STATUS_TEXT : STATUS_TEXT)[seat.status]}</p>

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

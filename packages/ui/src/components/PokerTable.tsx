/**
 * The table: the phase of the hand, the pot and its layers, the board, and every seat.
 *
 * Everything drawn here comes from `PlayerView` — the server's redacted view. This component
 * reads it and nothing else: it does not fetch, does not compute legality, does not decide what is
 * visible. A seat's `holeCards` are `null` unless the server chose to reveal them, so "should I
 * show these cards?" is not a question this component can get wrong.
 *
 * ## Not a casino: the surface is graph paper
 *
 * `--prl-surface-table` is a deep slate carrying a 32px hairline grid. No felt, no baize, no wood,
 * no rail highlight, no green. The decorative ellipse is a 1px hairline, not a table edge. This is
 * a worksheet that happens to have a hand of poker on it, which is the honest description of what
 * the product does.
 *
 * ## Two layouts, and why the DOM order is what it is
 *
 * The visual layout switches on a **container** query rather than a viewport query, so the table
 * lays itself out correctly inside a 22rem rail as well as on a wide page:
 *
 *   - under 46rem of container: a vertical stack — opponents, then the board and pot, then the
 *     viewer's own plate pinned at the bottom;
 *   - at 46rem and above: the seats are absolutely positioned around an ellipse with the pot and
 *     board in the middle. 46rem is where a 13rem plate stops overlapping its neighbours; the
 *     arithmetic is in the `@container prl-table` block of components.css.
 *
 * The DOM order is **pot and board, then opponents, then the viewer's own seat**, which is the
 * order that makes sense read aloud: "pot 420 units, community cards queen of hearts, seven of
 * hearts, two of clubs, seat 2..., your seat...". The stacked layout re-orders the three regions
 * visually with `order`, because a player's spatial model wants their own cards at the bottom of
 * the screen and the opponents above the board.
 *
 * Divergence between visual and DOM order is normally a bug, and it is safe here for one specific
 * reason: **nothing inside the table field is focusable.** Cards are `role="img"` spans, seats are
 * plain elements, and every control on the play screen lives in the ActionBar outside this
 * component. There is therefore no tab sequence to desynchronise. If a focusable control is ever
 * added to a seat, the `order` declarations have to go.
 *
 * The ellipse positions are a pure function of (ring index, seat count) computed in `Seat`, so the
 * server and the client render identical markup — no hydration mismatch, no `window`, no
 * measurement.
 *
 * ## Information is re-flowed, never removed
 *
 * The narrow layout shows the same position labels, names, stacks, street commitments, statuses,
 * badges and cards as the wide one. It compacts the plate; it does not drop a field. Two places
 * that could have been "simplified" and are not: the opponents grid **wraps** rather than
 * scrolling sideways (a scroll container with no focusable content cannot be scrolled from the
 * keyboard at all — WCAG 2.1.1 — and making it focusable would add an unnamed tab stop), and the
 * side pots keep their eligibility lists.
 *
 * ## Announcements
 *
 * Table updates are announced through the ONE polite `aria-live` region at the end of this
 * component, and two rules govern it:
 *
 *   - **Polite, not assertive.** A new street is not an emergency, and `assertive` interrupts
 *     whatever the reader was in the middle of.
 *   - **Focus is never moved.** Focus stays wherever the player put it. Yanking focus to a changed
 *     region on every remote update would make the table unusable with a keyboard, and is the
 *     classic mistake in live-updating UIs.
 *
 * The sentence itself comes from the caller, derived from the `WsEvent` stream, because this
 * component cannot know which changes the reader has already seen. The pot's own figure is the one
 * exception: `Metric`'s count-up owns a small atomic region of its own so that a settled figure is
 * announced once and a *mid-count* figure never is — the alternative is a screen reader reading
 * eleven wrong numbers on the way to the right one.
 *
 * Server-render safe: no state, no effects, no `window`.
 */

import type { ReactElement } from 'react';
import { listCardNames } from '../cards.ts';
import { cx } from '../cx.ts';
import { formatChips, formatIndex, formatUnits } from '../format.ts';
import type { PlayerView, SeatView, Street } from '../view-types.ts';
import { CardRow } from './CardRow.tsx';
import { PotDisplay } from './PotDisplay.tsx';
import { Seat } from './Seat.tsx';
import type { TurnClock } from './TurnTimer.tsx';

export interface PokerTableProps {
  readonly view: PlayerView;
  /** Heading text. Defaults to the hand number. */
  readonly title?: string;
  /**
   * One sentence announced politely when the table changes, e.g. "Seat 3 raised to 300". The
   * caller derives it from the event stream; passing the same string twice announces once, which
   * is the behaviour of a live region and is usually what is wanted.
   */
  readonly announcement?: string;
  /** Display names by seat index. `playerId` is an opaque id and is never shown. */
  readonly seatNames?: Readonly<Record<number, string>>;
  /** Cards to ring, e.g. the five that made a hand in review. */
  readonly highlightedCards?: readonly number[];
  /**
   * What the ring means, e.g. "part of the winning hand". Appended to each marked card's accessible
   * name, because a border and a corner notch are cues only a sighted reader gets.
   */
  readonly highlightLabel?: string;
  /**
   * The server's deadline for the seat to act, plus the server clock from the same frame. Absent
   * or `null` renders the active seat's other two cues without a ring.
   */
  readonly turn?: TurnClock | null;
  readonly className?: string;
}

/**
 * The phases of a hand, as the numbered spine the design system uses elsewhere for lesson steps
 * and the process outline. Five steps rather than the engine's six `Street` values: `showdown` and
 * `complete` are the same *phase* to a reader — the cards are down and the pot is being awarded —
 * and a spine that grows a step at the very end reads as a layout bug.
 */
const PHASES = ['preflop', 'flop', 'turn', 'river', 'showdown'] as const;
type Phase = (typeof PHASES)[number];

/** Which spine step a street belongs to. `complete` folds into `showdown`. */
const PHASE_OF_STREET: Readonly<Record<Street, Phase>> = {
  preflop: 'preflop',
  flop: 'flop',
  turn: 'turn',
  river: 'river',
  showdown: 'showdown',
  complete: 'showdown',
};

type PhaseState = 'done' | 'current' | 'pending';

/**
 * Rotates the seat list so the viewer comes first.
 *
 * Order, not position: `Seat` then places ring index 0 at the bottom of the ellipse. Done here
 * rather than in CSS because the *reading* order has to match, and CSS `order` changes only the
 * visual one.
 */
function rotateToViewer(seats: readonly SeatView[], viewerSeat: number | null): readonly SeatView[] {
  if (viewerSeat === null) return seats;
  const at = seats.findIndex((seat) => seat.seat === viewerSeat);
  if (at <= 0) return seats;
  return [...seats.slice(at), ...seats.slice(0, at)];
}

function seatLabel(seat: SeatView, seatNames: Readonly<Record<number, string>> | undefined): string {
  return seatNames?.[seat.seat] ?? `Seat ${seat.seat + 1}`;
}

/**
 * The board's accessible name, as one sentence.
 *
 * "community cards: queen of hearts, seven of hearts and two of clubs" is announced when the
 * reader reaches the figure, so the board arrives as a *group* rather than as three unrelated
 * cards. The individual cards keep their own names underneath, which is the normal
 * figure-and-contents behaviour and gives a reader both granularities.
 */
function boardName(board: readonly number[]): string {
  if (board.length === 0) return 'community cards: none dealt yet';
  return `community cards: ${listCardNames(board)}`;
}

interface PhaseSpineProps {
  readonly street: Street;
}

function PhaseSpine({ street }: PhaseSpineProps): ReactElement {
  const current = PHASE_OF_STREET[street];
  const currentAt = PHASES.indexOf(current);

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
            /**
             * `aria-current="step"` is the machine-readable half. The visible half is an accent
             * underline plus heavier weight, so the current phase is not signalled by hue alone,
             * and a visually-hidden word says which is which for a reader who gets neither.
             */
            {...(state === 'current' ? { 'aria-current': 'step' as const } : {})}
          >
            <span className="prl-table__step-index prl-index" aria-hidden="true">
              {formatIndex(position + 1)}
            </span>
            <span className="prl-table__step-name">{phase}</span>
            {state === 'current' ? <span className="prl-visually-hidden">{' (current phase)'}</span> : null}
            {state === 'done' ? <span className="prl-visually-hidden">{' (done)'}</span> : null}
          </li>
        );
      })}
    </ol>
  );
}

export function PokerTable(props: PokerTableProps): ReactElement {
  const { view, title, announcement, seatNames, highlightedCards, highlightLabel } = props;
  const { turn = null, className } = props;

  const seats = rotateToViewer(view.seats, view.viewerSeat);
  const heading = title ?? `Hand ${formatChips(view.handNumber)}`;
  const headingId = `prl-table-heading-${view.handId}`;
  const board = [...view.board];

  // The viewer's own plate is rendered outside the opponents list so the stacked layout can pin it
  // to the bottom without reordering anything inside a list. Ring indices still come from the
  // rotated order, so the oval geometry is unchanged.
  // `noUncheckedIndexedAccess` types `seats[heroIndex]` as possibly undefined even after the
  // `findIndex`, and `!` is banned repo-wide, so the seat is found rather than indexed.
  const heroIndex = seats.findIndex((seat) => seat.isSelf);
  const hero = seats.find((seat) => seat.isSelf) ?? null;

  // `exactOptionalPropertyTypes`: an absent key and an explicit `undefined` are different types, so
  // the two marking props are built conditionally and spread as one object.
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
        <PhaseSpine street={view.street} />
      </div>

      <div className="prl-table__field">
        {/* An anchor for the eye in the wide layout; absent entirely in the stacked one. */}
        <div className="prl-table__oval" aria-hidden="true" />

        <div className="prl-table__centre">
          <PotDisplay
            total={view.potTotal}
            pots={view.pots}
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
              /* Deals in with `--prl-dur-deal-stagger`; see the note on this class in
                 components.css for why the stagger is a stateless `nth-child`. */
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
                name={seatLabel(seat, seatNames)}
                ringIndex={index}
                ringCount={seats.length}
                turn={seat.isToAct ? turn : null}
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
              name={seatLabel(hero, seatNames)}
              ringIndex={heroIndex}
              ringCount={seats.length}
              turn={hero.isToAct ? turn : null}
              {...highlightProps}
              as="div"
            />
          </div>
        )}
      </div>

      {/* Always present, never focused. See the module comment. */}
      <div className="prl-live-region" role="status" aria-live="polite">
        {announcement ?? ''}
      </div>
    </section>
  );
}

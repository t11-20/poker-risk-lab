/**
 * The pot, and every layer it is made of.
 *
 * One oversized tabular figure for the total, with each side pot beneath it as an indexed row —
 * `01`, `02` — carrying its amount and the seats that can win it.
 *
 * ## Why the side pots are listed rather than summarised
 *
 * "Pot: 1,340" is a lie of omission the moment someone is all in for less than the bet. A player
 * facing a decision needs to know how much of that total they are actually contesting, and a
 * learner needs to see that a side pot is a *layer with an eligibility list* rather than a bonus.
 * Both facts are in `PlayerView.pots`, which the engine publishes as public information precisely
 * because everyone at a real table can watch the side pots form. Collapsing them into one number
 * would throw away the only place the concept is visible.
 *
 * The main pot's own amount is printed as a note whenever there is more than one layer, so the
 * arithmetic is checkable on screen: main plus each side equals the total.
 *
 * ## The index is typography; the name is text
 *
 * `01` is `--prl-type-index`, the same numbered-system motif the lesson steps and the process
 * spine use. It is `aria-hidden`, because "zero one" is not how anyone says it, and a
 * visually-hidden "side pot 1" carries the real name. So the row reads aloud as "side pot 1,
 * 300 units, Ada and Ravi eligible" while it draws as `01  300 units  Ada, Ravi`.
 *
 * ## The total counts up
 *
 * A growing pot is the clearest answer to "what changed?", which is one of the four questions the
 * design system allows an animation to answer. `Metric`'s count-up contract does the rest: the
 * final figure is in the DOM from the first render, the interpolating copy is `aria-hidden`, and
 * the count is skipped under `prefers-reduced-motion` and for changes under one percent.
 *
 * Server-render safe: no state, no effects, no `window`.
 */

import type { ReactElement } from 'react';
import { cx } from '../cx.ts';
import { formatIndex, formatUnits } from '../format.ts';
import type { PotLayer } from '../view-types.ts';
import { Metric } from './Metric.tsx';

export interface PotDisplayProps {
  /** `PlayerView.potTotal` — every layer, every street, everything in the middle. */
  readonly total: number;
  /** `PlayerView.pots`. Index 0 is the main pot; 1 and up are side pots in cap order. */
  readonly pots: readonly PotLayer[];
  /** Display names by seat index. `playerId` is an opaque id and is never shown. */
  readonly seatNames?: Readonly<Record<number, string>>;
  readonly label?: string;
  readonly className?: string;
}

function seatName(seat: number, seatNames: Readonly<Record<number, string>> | undefined): string {
  return seatNames?.[seat] ?? `seat ${seat + 1}`;
}

/**
 * "Ada, Ravi" — or a sentence when the list is empty.
 *
 * An empty eligibility list should not happen (a pot with no claimant is a bug in pot building),
 * so it is stated rather than rendered as blank space: a silent gap hides the defect.
 */
function eligibleText(
  seats: readonly number[],
  seatNames: Readonly<Record<number, string>> | undefined,
): string {
  if (seats.length === 0) return 'no seats eligible';
  return seats.map((seat) => seatName(seat, seatNames)).join(', ');
}

export function PotDisplay(props: PotDisplayProps): ReactElement {
  const { total, pots, seatNames, label = 'Pot', className } = props;

  const main = pots.find((pot) => pot.index === 0);
  const sides = pots.filter((pot) => pot.index > 0);
  // `exactOptionalPropertyTypes`: an absent note and `note: undefined` are different types, so
  // the property is added only when there is something to say.
  const noteProps =
    sides.length === 0 || main === undefined
      ? {}
      : { note: `Main pot ${formatUnits(main.amount)}, plus the side pots below.` };

  return (
    <div className={cx('prl-pot', className)}>
      <Metric label={label} value={total} format="units" size="lg" countUp {...noteProps} />

      {sides.length === 0 ? null : (
        <ul className="prl-pot__sides">
          {sides.map((pot) => (
            <li className="prl-pot__side" key={`side-pot-${pot.index}`}>
              <span className="prl-pot__side-index prl-index" aria-hidden="true">
                {formatIndex(pot.index)}
              </span>
              <span className="prl-visually-hidden">{`side pot ${pot.index}, `}</span>
              <span className="prl-pot__side-amount">{formatUnits(pot.amount)}</span>
              <span className="prl-pot__side-seats">{eligibleText(pot.eligibleSeats, seatNames)}</span>
              <span className="prl-visually-hidden">{' eligible'}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

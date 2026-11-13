/**
 * The pot total, with each side pot listed as an indexed row with its amount and eligible seats.
 * Side pots are listed, not summed, because a single total hides how much an all-in player contests.
 * The `01` index is `aria-hidden` and a visually hidden "side pot 1" carries the spoken name.
 */

import type { ReactElement } from 'react';
import { cx } from '../cx.ts';
import { formatIndex, formatUnits } from '../format.ts';
import type { PotLayer } from '../view-types.ts';
import { Metric } from './Metric.tsx';

export interface PotDisplayProps {
  readonly total: number;
  /** `PlayerView.pots`. Index 0 is the main pot, then side pots in cap order. */
  readonly pots: readonly PotLayer[];
  /** Display names by seat index. `playerId` is opaque and never shown. */
  readonly seatNames?: Readonly<Record<number, string>>;
  readonly label?: string;
  readonly className?: string;
}

function seatName(seat: number, seatNames: Readonly<Record<number, string>> | undefined): string {
  return seatNames?.[seat] ?? `seat ${seat + 1}`;
}

/** An empty eligibility list is a pot-building bug, so it is stated rather than left blank. */
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

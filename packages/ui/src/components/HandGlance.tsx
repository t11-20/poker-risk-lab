/**
 * The reader's own cards and the board, small, passed to `ActionBar` as its `context`. On a phone the
 * follow scroll takes the plate and board off screen while sizing (390x844, plate at -174..46).
 * Inside the bar, not above it, because at 360x640 the price strip would push the number field under the
 * sticky row. One `role="img"` name with the cards `aria-hidden`, so a reader passes one image, not seven.
 * The clock and the latest action ride above the cards for the same reason: the same scroll put the
 * plate's clock at -227..-143 and the street line under the header at 390x844.
 */

import type { ReactElement } from 'react';
import { handAndBoardName } from '../cards.ts';
import { cx } from '../cx.ts';
import { withKeys } from '../keys.ts';
import { PlayingCard } from './PlayingCard.tsx';
import { type TurnClock, TurnTimer } from './TurnTimer.tsx';

export interface HandGlanceProps {
  readonly hole: readonly number[];
  readonly board: readonly number[];
  /** The reader's own clock. Null or absent draws no ring. */
  readonly clock?: TurnClock | null;
  /** One phrase for the latest action, such as "On the river: Calling Station bet 215". */
  readonly latest?: string | null;
  readonly className?: string;
}

export function HandGlance({
  hole,
  board,
  clock = null,
  latest = null,
  className,
}: HandGlanceProps): ReactElement {
  return (
    <span className={cx('prl-hand-glance', className)}>
      {clock === null && latest === null ? null : (
        // Hidden from the tree because both are already in it: the plate's timer and the street line.
        <span className="prl-hand-glance__now" aria-hidden="true">
          {clock === null ? null : <TurnTimer clock={clock} />}
          {latest === null ? null : <span className="prl-hand-glance__latest">{latest}</span>}
        </span>
      )}
      <span className="prl-hand-glance__hand" role="img" aria-label={handAndBoardName(hole, board)}>
        <span className="prl-hand-glance__cards" aria-hidden="true">
          {withKeys(hole, 'hole').map((entry) => (
            <PlayingCard key={entry.key} card={entry.value} size="sm" />
          ))}
        </span>
        {board.length === 0 ? null : (
          <span className="prl-hand-glance__cards prl-hand-glance__board" aria-hidden="true">
            {withKeys(board, 'board').map((entry) => (
              <PlayingCard key={entry.key} card={entry.value} size="sm" />
            ))}
          </span>
        )}
      </span>
    </span>
  );
}

/**
 * The reader's own cards and the board, small, passed to `ActionBar` as its `context`. On a phone the
 * follow scroll takes the plate and board off screen while sizing (390x844, plate at -174..46).
 * Inside the bar, not above it, because at 360x640 the price strip would push the number field under the
 * sticky row. One `role="img"` name with the cards `aria-hidden`, so a reader passes one image, not seven.
 */

import type { ReactElement } from 'react';
import { handAndBoardName } from '../cards.ts';
import { cx } from '../cx.ts';
import { withKeys } from '../keys.ts';
import { PlayingCard } from './PlayingCard.tsx';

export interface HandGlanceProps {
  readonly hole: readonly number[];
  readonly board: readonly number[];
  readonly className?: string;
}

export function HandGlance({ hole, board, className }: HandGlanceProps): ReactElement {
  return (
    <span className={cx('prl-hand-glance', className)} role="img" aria-label={handAndBoardName(hole, board)}>
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
  );
}

/**
 * The reader's own two cards and the board, small, beside the controls that bet on them.
 *
 * ## The defect this exists for
 *
 * On a phone, a decision with a bet or a raise legal scrolls the page so the sizer and the buttons
 * are both usable (`apps/web/src/lib/follow-the-table.ts`), and that takes the reader's own plate
 * and the board off the top of the screen. Measured at 390x844 on the live table: plate at -174..46
 * and board at -303..-203 under a 77px header, with the street line, the price, the sizer and the
 * buttons on screen. A learner was sizing a bet without being able to see what they held or what it
 * had to beat, and scrolling up to look made the sizer the thing that was off screen.
 *
 * So the play screen passes this to `ActionBar` as its `context`, which draws it between the price
 * and the sizer. Inside the bar rather than above it, for a reason that is arithmetic: on a 360x640
 * phone the sizer and the row do not fit together, so the follow puts the top of this glance at the
 * top edge and the row sticks over the bottom of the sizer. Above the bar, the price strip would sit
 * between the glance and the sizer and push the sizer down by the glance plus 79px, which put the
 * number field under the stuck row; inside it, the sizer moves by the glance and one gap.
 *
 * ## One name, not seven
 *
 * `role="img"` with one sentence from `handAndBoardName`, and the cards inside it `aria-hidden`. Two
 * `CardRow`s would have been two figures, two captions and seven images for a reader to step through
 * on the way to the sizer — and the narration has already said every card as it was dealt. Not a
 * live region, for the same reason: this is the same facts for the eye, put where the eye is.
 *
 * The faces are `PlayingCard` at `sm`, the size the seat plates already use, so a card here looks
 * like the card on the plate: the same suit letter, the same four-colour pips, in both themes.
 *
 * Server-render safe: no state, no effects.
 */

import type { ReactElement } from 'react';
import { handAndBoardName } from '../cards.ts';
import { cx } from '../cx.ts';
import { withKeys } from '../keys.ts';
import { PlayingCard } from './PlayingCard.tsx';

export interface HandGlanceProps {
  /** The reader's own hole cards, as the engine deals them. */
  readonly hole: readonly number[];
  /** The community cards, possibly none. */
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
      {/* Preflop there is nothing to draw, and the street line already says "Preflop". */}
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

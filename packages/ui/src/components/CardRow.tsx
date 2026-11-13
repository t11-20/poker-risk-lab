/**
 * A labelled row of cards. A `<figure>` named by its `<figcaption>`, because `role="group"` fails lint
 * (`useSemanticElements`). A hidden label stays the accessible name. The strip scrolls on its own so the
 * page never scrolls sideways. Entries may be integers or notation (`"Kh"`), and unparseable notation
 * renders as a text chip, because a board silently missing two cards reads as a three-card board.
 */

import type { ReactElement } from 'react';
import { parseCardText } from '../cards.ts';
import { cx } from '../cx.ts';
import { withKeys } from '../keys.ts';
import { Chip } from './Chip.tsx';
import { type CardSize, PlayingCard } from './PlayingCard.tsx';

export type CardEntry = number | string;

/** A stand-in for unparseable face-down notation. `PlayingCard` returns the back before reading it. */
const NOT_READ = 0;

export interface CardRowProps {
  readonly cards: readonly CardEntry[];
  /** Required, because an unlabelled card row is not usable non-visually. */
  readonly label: string;
  /** When false the label is still the figure's accessible name. */
  readonly showLabel?: boolean;
  readonly faceDown?: boolean;
  readonly size?: CardSize;
  /** Compared by value, so a card appearing twice is marked twice. */
  readonly highlightedCards?: readonly number[];
  /** Forwarded to each marked card's accessible name, because the border is a visual cue only. */
  readonly highlightLabel?: string;
  readonly emptyText?: string;
  readonly tight?: boolean;
  readonly className?: string;
}

export function CardRow(props: CardRowProps): ReactElement {
  const {
    cards,
    label,
    showLabel = true,
    faceDown = false,
    size = 'md',
    highlightedCards,
    highlightLabel,
    emptyText = 'no cards yet',
    tight = false,
    className,
  } = props;

  const highlighted = new Set(highlightedCards ?? []);
  // Content-derived keys, so a board that grows keeps the flop's DOM nodes.
  const keyed = withKeys(cards, `card-row-${label}`);

  return (
    <figure className={cx('prl-card-row', tight && 'prl-card-row--tight', className)}>
      <figcaption className={cx('prl-card-row__label', 'prl-label', !showLabel && 'prl-visually-hidden')}>
        {label}
      </figcaption>
      {keyed.length === 0 ? (
        <span className="prl-card-row__empty">{emptyText}</span>
      ) : (
        <span className="prl-card-row__cards">
          {keyed.map((entry) => {
            const card = typeof entry.value === 'number' ? entry.value : parseCardText(entry.value);

            // Face-down entries always get a back, never the text chip, which would print the hidden card.
            if (faceDown) {
              return <PlayingCard key={entry.key} card={card ?? NOT_READ} faceDown size={size} />;
            }

            if (card === null) {
              return (
                <Chip key={entry.key} mono>
                  {entry.value}
                </Chip>
              );
            }
            return (
              <PlayingCard
                key={entry.key}
                card={card}
                faceDown={faceDown}
                highlighted={highlighted.has(card)}
                {...(highlightLabel === undefined ? {} : { highlightLabel })}
                size={size}
              />
            );
          })}
        </span>
      )}
    </figure>
  );
}

/**
 * A labelled row of cards: the board, a seat's hole cards, a set of outs.
 *
 * ## Why `<figure>` + `<figcaption>` and not `role="group"`
 *
 * The row needs an accessible group label so a screen reader says "board" before
 * reading three cards. `<div role="group" aria-label>` is the obvious spelling and is
 * rejected by this repo's lint (`useSemanticElements`, which points at `<fieldset>` —
 * wrong here, a fieldset is for form controls).
 *
 * `<figure>` is the better answer anyway. It takes its accessible name from its
 * `<figcaption>`, which means the label is *real visible text* rather than an
 * attribute that only assistive tech can see, and it needs no ARIA at all. When the
 * caller does not want the label drawn, the caption is visually hidden and still names
 * the figure — the name never disappears, only its pixels.
 *
 * ## Horizontal overflow
 *
 * Seven cards at `lg` on a 320px screen is wider than the screen. The card strip is
 * its own `overflow-x: auto` container so the *page* never scrolls sideways; that is a
 * rule the whole package follows.
 *
 * Server-render safe: no state, no effects.
 */

import type { ReactElement } from 'react';
import { cx } from '../cx.ts';
import { withKeys } from '../keys.ts';
import { type CardSize, PlayingCard } from './PlayingCard.tsx';

export interface CardRowProps {
  /** Engine card integers. May be empty. */
  readonly cards: readonly number[];
  /** Names the group. Required — an unlabelled card row is not usable non-visually. */
  readonly label: string;
  /** Draw the label. When false it is still the figure's accessible name. */
  readonly showLabel?: boolean;
  readonly faceDown?: boolean;
  readonly size?: CardSize;
  /** Cards to mark. Compared by value, so a card appearing twice is marked twice. */
  readonly highlightedCards?: readonly number[];
  /**
   * What the mark means, e.g. "part of the winning hand". Forwarded to every marked card's
   * accessible name, because a border and a corner marker are cues only a sighted reader gets.
   */
  readonly highlightLabel?: string;
  /** Shown in place of the cards when `cards` is empty. */
  readonly emptyText?: string;
  /** Tightens the gap, for dense contexts such as a seat inside the table. */
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
  // Content-derived keys, never the array index — a board grows by appending, and an
  // index key would make React reuse the flop's DOM node for the turn card.
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
          {keyed.map((entry) => (
            <PlayingCard
              key={entry.key}
              card={entry.value}
              faceDown={faceDown}
              highlighted={highlighted.has(entry.value)}
              {...(highlightLabel === undefined ? {} : { highlightLabel })}
              size={size}
            />
          ))}
        </span>
      )}
    </figure>
  );
}

/**
 * One playing card from the engine's integer encoding, as text rather than an image.
 * Suits differ by symbol, letter and colour. The letter separates clubs from spades under deuteranopia.
 * `role="img"` with an `aria-label`, because `aria-label` on a generic span announces nothing.
 * The face stays light in both themes (§2.5). `highlighted` adds a border, a corner notch and a phrase
 * in the accessible name (WCAG 1.4.1). The notch is a `::after` in `components.css`, not a glyph,
 * because a glyph in the face grid was clipped and crowded the suit letter.
 */

import type { ReactElement } from 'react';
import { describeCard } from '../cards.ts';
import { cx } from '../cx.ts';

export type CardSize = 'sm' | 'md' | 'lg';

export interface PlayingCardProps {
  /** The engine's card integer, 0..51. */
  readonly card: number;
  /** The value is still not in the DOM. */
  readonly faceDown?: boolean;
  readonly highlighted?: boolean;
  /** Announced, not drawn. */
  readonly highlightLabel?: string;
  readonly size?: CardSize;
  /** Layout only. Never used to restyle the card. */
  readonly className?: string;
}

const SIZE_CLASS: Readonly<Record<CardSize, string>> = {
  sm: 'prl-card--sm',
  md: 'prl-card--md',
  lg: 'prl-card--lg',
};

export function PlayingCard(props: PlayingCardProps): ReactElement {
  const {
    card,
    faceDown = false,
    highlighted = false,
    highlightLabel = 'marked',
    size = 'md',
    className,
  } = props;
  const described = describeCard(card);

  const classes = cx(
    'prl-card',
    SIZE_CLASS[size],
    faceDown && 'prl-card--face-down',
    highlighted && 'prl-card--highlighted',
    className,
  );

  /**
   * A face-down card returns before the decoded value is used, so the integer never reaches the DOM.
   * The server already redacts hidden cards (`redactFor`); this is the second guard.
   */
  if (faceDown) {
    return (
      <span className={classes} role="img" aria-label="face-down card">
        <span className="prl-card__back" aria-hidden="true" />
      </span>
    );
  }

  // A value outside 0..51 renders a placeholder rather than throwing and blanking the table.
  if (described === null) {
    return (
      <span className={classes} role="img" aria-label="unknown card">
        <span className="prl-card__face" aria-hidden="true">
          <span className="prl-card__rank">?</span>
          <span className="prl-card__pip">?</span>
          <span className="prl-card__suit-letter">?</span>
        </span>
      </span>
    );
  }

  const accessibleName = highlighted
    ? `${described.accessibleName}, ${highlightLabel}`
    : described.accessibleName;

  return (
    <span className={classes} data-suit={described.suitKey} role="img" aria-label={accessibleName}>
      <span className="prl-card__face" aria-hidden="true">
        <span className="prl-card__rank">{described.face}</span>
        <span className="prl-card__pip">{described.suitSymbol}</span>
        <span className="prl-card__suit-letter">{described.suitLetter}</span>
      </span>
    </span>
  );
}

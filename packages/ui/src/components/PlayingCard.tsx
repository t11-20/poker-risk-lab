/**
 * One playing card from the engine's integer encoding, drawn by its generated SVG file
 * (`apps/web/public/cards`, written by `scripts/cards/generate.mjs`).
 * The name is on the wrapper (`role="img"` plus `aria-label`), so the `<img>` inside is `alt=""` and
 * `aria-hidden` and a reader hears one name. `highlighted` adds a corner notch, a lift and a phrase in
 * the accessible name, so the mark is never colour alone (WCAG 1.4.1).
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

/** Served by the web app from `public/`. */
export const CARD_DIR = '/cards/';
export const CARD_BACK_FILE = 'back.svg';

function CardImage({ file }: { readonly file: string }): ReactElement {
  return (
    <img
      className="prl-card__image"
      src={`${CARD_DIR}${file}`}
      alt=""
      aria-hidden="true"
      width={250}
      height={350}
      draggable={false}
      decoding="async"
    />
  );
}

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
        <CardImage file={CARD_BACK_FILE} />
      </span>
    );
  }

  // A value outside 0..51 renders a placeholder rather than throwing and blanking the table.
  if (described === null) {
    return (
      <span className={cx(classes, 'prl-card--unknown')} role="img" aria-label="unknown card">
        <span aria-hidden="true">?</span>
      </span>
    );
  }

  const accessibleName = highlighted
    ? `${described.accessibleName}, ${highlightLabel}`
    : described.accessibleName;

  return (
    <span className={classes} role="img" aria-label={accessibleName}>
      <CardImage file={described.file} />
    </span>
  );
}

/**
 * One playing card, rendered from the engine's integer encoding.
 *
 * ## Why text and not an image
 *
 * A card here is a `<span>` containing three text nodes. No SVG, no sprite sheet, no
 * font file. That means it scales with the reader's font size, survives high-contrast
 * modes, needs no asset pipeline, and cannot fail to load. The only thing an image
 * would buy is a prettier pip layout, which is not worth an asset per card times 52.
 *
 * ## The accessibility decision that matters: suits are not colour-coded alone
 *
 * Four suits are shown with (a) a distinct symbol, (b) a distinct **letter**
 * (`c d h s`), and (c) a distinct colour from the four-colour suit tokens. Any one of the
 * three is sufficient to tell them apart, which is the point. Colour on its own would fail
 * for roughly one in twelve men: the club/spade pair is similar in silhouette *and* similar
 * in hue under deuteranopia, so the letter is what actually separates them.
 *
 * The whole card carries `role="img"` plus an `aria-label` of the spoken name ("ace of
 * hearts"). Children of `role="img"` are presentational, so the rank, pip and letter
 * are not announced separately — a screen reader hears one card, not "A, heart
 * symbol, h". They are additionally `aria-hidden` so the intent is explicit rather
 * than relying on the role's implicit content-hiding.
 *
 * `role="img"` on a span (rather than visually hidden text) is deliberate:
 * `aria-label` is ignored on an element with a generic role, so a bare
 * `<span aria-label>` would silently announce nothing at all.
 *
 * ## The card face stays light in both themes
 *
 * `--prl-card-face` is a warm off-white under a dark theme as well as a light one. A dark
 * playing card is unreadable at the sizes a six-max table needs, and inverting one is a
 * novelty that costs legibility (§2.5). The face is the one surface in the app that does not
 * follow the theme, and that is a decision rather than an oversight.
 *
 * ## `highlighted` is three cues, not a colour
 *
 * Hand review marks the five cards that made a hand. A tint alone would fail WCAG 1.4.1 and
 * would vanish entirely in forced-colors mode, so a highlighted card gets an accent **border**, a
 * small corner **notch**, and — the part that is easy to forget — a phrase appended to its
 * **accessible name**. Why the card is highlighted is the caller's knowledge, so they supply
 * the phrase: "part of the winning hand" is information; "highlighted" is not.
 *
 * The notch is `.prl-card--highlighted::after` in `components.css`: two borders on a pseudo-element,
 * outside the face's grid, so it costs the face nothing. It is deliberately NOT a text glyph in the
 * markup, and that is worth stating because it was one. A `▮` span inside `.prl-card__face` becomes a
 * fourth item in a `grid-template-rows: auto 1fr auto` box that is `overflow: hidden` — measured, it
 * made the face's content 72px tall inside a 65px box, so the glyph itself was clipped away
 * (invisible, therefore not a cue at all) while its 16px still squeezed the rank, the pip and the
 * **suit letter** above it. The suit letter is the non-colour cue that separates a club from a spade,
 * so the one thing the marker cost was the one thing that must not be crowded. A plain card's face
 * fits its box exactly; a highlighted card's now does too.
 *
 * Server-render safe: no state, no effects, no `window`.
 */

import type { ReactElement } from 'react';
import { describeCard } from '../cards.ts';
import { cx } from '../cx.ts';

export type CardSize = 'sm' | 'md' | 'lg';

export interface PlayingCardProps {
  /** The engine's card integer, 0..51. */
  readonly card: number;
  /** Render the back instead of the face. The value is still not in the DOM. */
  readonly faceDown?: boolean;
  /** Marks the card: accent border, corner marker, and a phrase in its accessible name. */
  readonly highlighted?: boolean;
  /** What the highlight means, e.g. "part of the winning hand". Announced, not drawn. */
  readonly highlightLabel?: string;
  readonly size?: CardSize;
  /** Layout-only class from the caller. Never used to restyle the card itself. */
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
   * A face-down card must not leak its value. `faceDown` therefore short-circuits
   * before `described` is used at all: the integer never reaches the DOM, not as text,
   * not as a `data-` attribute, not as a class. The server already redacts hidden
   * cards (`redactFor`), so this is belt and braces — but a component that renders
   * `data-card="42"` on a face-down card would quietly undo all of that.
   *
   * The back is its own element so the stylesheet can draw `--prl-card-back-pattern` on it
   * without the empty rank/pip/letter nodes the face needs.
   */
  if (faceDown) {
    return (
      <span className={classes} role="img" aria-label="face-down card">
        <span className="prl-card__back" aria-hidden="true" />
      </span>
    );
  }

  // A value outside 0..51 is a caller bug. It renders as a visible placeholder rather
  // than throwing, so one bad integer cannot blank an entire table.
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

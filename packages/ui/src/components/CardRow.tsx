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
 * ## Why `cards` takes notation as well as engine integers
 *
 * The engine deals integers; hand *history* is stored and served as notation (`"Kh"`), and
 * so are a Coach report's outs. Before this row accepted both, every surface holding
 * notation had to lay out loose `PlayingCard`s itself — parse the string, fall back to a
 * chip when it does not parse, and wrap the lot in something. The `/review` board is
 * exactly that, and the audit found the predictable consequence: those cards are the one
 * set on the site with **no group label**, because a hand-rolled `<span>` has no
 * `<figcaption>`. A component that covers half the callers leaves the other half to
 * reinvent it worse.
 *
 * So an entry may be an integer or a notation string, and an unparseable string renders as
 * a text chip rather than vanishing. Silence would be the wrong failure: a board that
 * quietly shows three cards instead of five reads as a three-card board.
 *
 * Server-render safe: no state, no effects.
 */

import type { ReactElement } from 'react';
import { parseCardText } from '../cards.ts';
import { cx } from '../cx.ts';
import { withKeys } from '../keys.ts';
import { Chip } from './Chip.tsx';
import { type CardSize, PlayingCard } from './PlayingCard.tsx';

/** An engine card integer, or the notation a stored hand carries — `"Kh"`, `"Td"`. */
export type CardEntry = number | string;

/**
 * Stands in for the value of a face-down card that could not be parsed.
 *
 * `PlayingCard` returns its back before it consults the integer at all, so this never reaches
 * the DOM in any form — not as text, not as an attribute, not as a class. It exists because the
 * prop is a `number` and there is no honest number here; the honest answer is that on a
 * face-down card there is nothing to say.
 */
const NOT_READ = 0;

export interface CardRowProps {
  /** Engine card integers, card notation, or a mix. May be empty. */
  readonly cards: readonly CardEntry[];
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
          {keyed.map((entry) => {
            // Notation resolves to the same integer the engine would have dealt, so a
            // highlight set stays a set of integers and a caller never has to know which of
            // the two forms this particular row happens to be holding.
            const card = typeof entry.value === 'number' ? entry.value : parseCardText(entry.value);

            // A face-down row has no identities to show, so an entry that failed to parse gets
            // a back like every other one — it does NOT fall through to the text chip below.
            // That chip prints the entry verbatim, which on a face-down card would print the
            // one thing the card exists to hide. `PlayingCard` returns its back before it looks
            // at the value, which is what makes `NOT_READ` safe: it is never read.
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

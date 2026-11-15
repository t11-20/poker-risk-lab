/**
 * Prose that names cards in shared notation, drawn the way the table draws them: "Ah Kh" is painted
 * "A♥ K♥" in the suit colours and heard "ace of hearts, king of hearts". Hidden text rather than
 * `role="img"`, so a screen reader reads the names as part of the sentence and never says "image".
 * U+FE0E requests text presentation, because without it iOS draws the heart and diamond as emoji.
 */

import type { ReactElement } from 'react';
import { type CardValue, cardTextSegments, describeCard } from '../cards.ts';
import { withKeys } from '../keys.ts';

/** Cards already known by value, such as an outs label, drawn the same way with no notation to parse. */
export function CardRun({ cards }: { readonly cards: readonly CardValue[] }): ReactElement {
  const names = cards.map((card) => describeCard(card)?.accessibleName ?? 'unknown card');
  return (
    <span className="prl-card-text">
      <span className="prl-visually-hidden">{names.join(', ')}</span>
      <span aria-hidden="true">
        {withKeys(cards, 'card-run').map((entry, index) => {
          const card = describeCard(entry.value);
          return card === null ? null : (
            <span className="prl-card-text__card" data-suit={card.suitKey} key={entry.key}>
              {`${index === 0 ? '' : ' '}${card.face}${card.suitSymbol}\uFE0E`}
            </span>
          );
        })}
      </span>
    </span>
  );
}

export function CardText({ text }: { readonly text: string }): ReactElement {
  const segments = withKeys(cardTextSegments(text), 'card-text');
  return (
    <>
      {segments.map(({ key, value }) =>
        typeof value === 'string' ? value : <CardRun cards={value} key={key} />,
      )}
    </>
  );
}

'use client';

/**
 * Named slots filled from a 52-card deck. A card in use stays focusable with `aria-disabled` rather
 * than `disabled`: a disabled button drops focus the moment it is picked, and its name, which says
 * where the card is, would never be heard. The deck is one tab stop with arrow keys inside it.
 */

import { type KeyboardEvent, type ReactElement, useId, useRef, useState } from 'react';
import {
  cardOwners,
  type DeckFlow,
  deckCardName,
  moveInDeck,
  PICKER_DECK,
  type PickerSlot,
} from '../card-picker.ts';
import { describeCard } from '../cards.ts';
import { cx } from '../cx.ts';

export interface CardPickerGroup {
  readonly label: string;
  readonly slots: readonly PickerSlot[];
}

export interface CardPickerProps {
  /** In fill order. Every slot id is unique across groups. */
  readonly groups: readonly CardPickerGroup[];
  readonly active: string | null;
  readonly onSelectSlot: (id: string) => void;
  readonly onPick: (card: number) => void;
  readonly onRemove: (id: string) => void;
  /** Announced politely, e.g. "Ace of hearts added to Flop 1." */
  readonly status?: string;
  /** The id of an error sentence about the cards, when there is one. */
  readonly errorId?: string;
  readonly className?: string;
}

function CardFace({
  card,
  dimmed,
}: {
  readonly card: number;
  readonly dimmed: boolean;
}): ReactElement | null {
  const described = describeCard(card);
  if (described === null) return null;
  return (
    <span
      className={cx('prl-card', 'prl-card--sm', dimmed && 'prl-card--dimmed')}
      data-suit={described.suitKey}
      aria-hidden="true"
    >
      <span className="prl-card__face">
        <span className="prl-card__rank">{described.face}</span>
        <span className="prl-card__pip">{described.suitSymbol}</span>
      </span>
    </span>
  );
}

/** Read off the stylesheet, so the arrow keys follow the layout the reader is looking at. */
function flowOf(deck: HTMLElement | null): DeckFlow {
  if (deck === null || typeof window === 'undefined') return 'rows';
  return window.getComputedStyle(deck).gridAutoFlow.includes('column') ? 'columns' : 'rows';
}

export function CardPicker(props: CardPickerProps): ReactElement {
  const { groups, active, onSelectSlot, onPick, onRemove, status = '', errorId, className } = props;
  const slots = groups.flatMap((group) => group.slots);
  const owners = cardOwners(slots);
  const activeSlot = slots.find((slot) => slot.id === active) ?? null;
  const [focusIndex, setFocusIndex] = useState(0);
  const deckRef = useRef<HTMLDivElement>(null);
  const hintId = useId();

  const onDeckKey = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const next = moveInDeck(index, event.key, flowOf(deckRef.current));
    if (next === null) return;
    event.preventDefault();
    setFocusIndex(next);
    deckRef.current?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus();
  };

  const removable =
    activeSlot !== null && activeSlot.card !== null
      ? { slot: activeSlot, name: describeCard(activeSlot.card)?.accessibleName ?? 'the card' }
      : null;

  return (
    <div className={cx('prl-picker', className)}>
      <div className="prl-picker__slots">
        {groups.map((group) => (
          <fieldset className="prl-picker__group" key={group.label}>
            <legend className="prl-picker__group-label">{group.label}</legend>
            <div className="prl-picker__group-slots">
              {group.slots.map((slot) => {
                const name =
                  slot.card === null ? 'empty' : (describeCard(slot.card)?.accessibleName ?? 'unknown card');
                return (
                  <button
                    key={slot.id}
                    type="button"
                    className="prl-picker__slot"
                    data-active={slot.id === active ? 'true' : undefined}
                    aria-pressed={slot.id === active}
                    aria-label={`${slot.label}: ${name}`}
                    {...(errorId === undefined ? {} : { 'aria-describedby': errorId })}
                    onClick={() => onSelectSlot(slot.id)}
                    onKeyDown={(event) => {
                      if ((event.key === 'Delete' || event.key === 'Backspace') && slot.card !== null) {
                        event.preventDefault();
                        onRemove(slot.id);
                      }
                    }}
                  >
                    <span className="prl-picker__slot-label" aria-hidden="true">
                      {slot.short ?? slot.label}
                    </span>
                    {slot.card === null ? (
                      <span className="prl-picker__empty" aria-hidden="true" />
                    ) : (
                      <CardFace card={slot.card} dimmed={false} />
                    )}
                  </button>
                );
              })}
            </div>
          </fieldset>
        ))}
      </div>

      <div className="prl-picker__tools">
        <p className="prl-picker__target">
          {activeSlot === null
            ? 'Every slot is full. Choose a slot to change it.'
            : `Next card goes to ${activeSlot.label}.`}
        </p>
        <button
          type="button"
          className="prl-btn prl-btn--secondary prl-btn--sm"
          aria-disabled={removable === null}
          onClick={() => {
            if (removable !== null) onRemove(removable.slot.id);
          }}
        >
          {removable === null ? 'Remove card' : `Remove ${removable.name} from ${removable.slot.label}`}
        </button>
      </div>

      <p className="prl-picker__hint" id={hintId}>
        Arrow keys move through the deck. Enter or Space picks a card. Greyed cards are already in use.
      </p>
      <fieldset className="prl-picker__deck-set" aria-describedby={hintId}>
        <legend className="prl-visually-hidden">Deck</legend>
        <div className="prl-picker__deck" ref={deckRef}>
          {PICKER_DECK.map((card, index) => {
            const owner = owners.get(card);
            return (
              <button
                key={card}
                type="button"
                className="prl-picker__card"
                data-used={owner === undefined ? undefined : 'true'}
                aria-label={deckCardName(card, owner)}
                aria-disabled={owner !== undefined}
                tabIndex={index === focusIndex ? 0 : -1}
                onFocus={() => setFocusIndex(index)}
                onKeyDown={(event) => onDeckKey(event, index)}
                onClick={() => {
                  if (owner === undefined) onPick(card);
                }}
              >
                <CardFace card={card} dimmed={owner !== undefined} />
                <span className="prl-picker__used" aria-hidden="true">
                  {owner === undefined ? '' : (owner.short ?? owner.label)}
                </span>
              </button>
            );
          })}
        </div>
      </fieldset>
      <p className="prl-live-region" role="status" aria-live="polite">
        {status}
      </p>
    </div>
  );
}

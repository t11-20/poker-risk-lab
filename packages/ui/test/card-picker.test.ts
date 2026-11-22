/**
 * The card picker: a used card cannot be picked and says why, a pick fills the next open slot,
 * removing a card frees it, and the arrow keys follow the layout on screen. The model is tested
 * directly and the component through its rendered markup; focus moves need a browser, so
 * `scripts/keyboard-audit.mjs` covers those on `/lab/spots/edit`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  cardOwners,
  deckCardName,
  moveInDeck,
  nextOpenSlot,
  PICKER_DECK,
  type PickerSlot,
  pickCard,
  removeCard,
} from '../src/card-picker.ts';
import { parseCardText } from '../src/cards.ts';
import type { CardPickerProps } from '../src/components/CardPicker.tsx';
import { loadComponent } from './support/render-component.ts';

function card(text: string): number {
  const value = parseCardText(text);
  assert.ok(value !== null, text);
  return value;
}

const EMPTY: readonly PickerSlot[] = [
  { id: 'hole1', label: 'Hole 1', card: null },
  { id: 'hole2', label: 'Hole 2', card: null },
  { id: 'flop1', label: 'Flop 1', card: null },
  { id: 'flop2', label: 'Flop 2', card: null },
  { id: 'flop3', label: 'Flop 3', card: null },
  { id: 'turn', label: 'Turn', card: null },
  { id: 'river', label: 'River', card: null },
];

describe('the deck', () => {
  it('holds all 52 cards once', () => {
    assert.equal(PICKER_DECK.length, 52);
    assert.equal(new Set(PICKER_DECK).size, 52);
    assert.ok(PICKER_DECK.every((value) => Number.isInteger(value) && value >= 0 && value < 52));
  });
});

describe('picking', () => {
  it('fills the next open slot in order and moves on to the one after', () => {
    let state = { slots: EMPTY, active: nextOpenSlot(EMPTY, null) };
    assert.equal(state.active, 'hole1');
    for (const [text, expected] of [
      ['Ah', 'hole1'],
      ['Kh', 'hole2'],
      ['Qh', 'flop1'],
    ] as const) {
      const result = pickCard(state.slots, state.active, card(text));
      assert.equal(result.placed?.id, expected, text);
      state = { slots: result.slots, active: result.active };
    }
    assert.equal(state.active, 'flop2');
  });

  it('with no slot chosen, fills the first open one', () => {
    const slots = EMPTY.map((slot) => (slot.id === 'hole1' ? { ...slot, card: card('2c') } : slot));
    assert.equal(pickCard(slots, null, card('3c')).placed?.id, 'hole2');
  });

  it('refuses a card already in a slot, and leaves every slot as it was', () => {
    const slots = EMPTY.map((slot) => (slot.id === 'hole1' ? { ...slot, card: card('Ah') } : slot));
    const result = pickCard(slots, 'flop1', card('Ah'));
    assert.equal(result.placed, null);
    assert.equal(result.slots, slots);
    assert.equal(cardOwners(slots).get(card('Ah'))?.label, 'Hole 1');
  });

  it('replaces the card in a chosen slot that is already filled', () => {
    const slots = EMPTY.map((slot) => (slot.id === 'turn' ? { ...slot, card: card('9d') } : slot));
    const result = pickCard(slots, 'turn', card('9c'));
    assert.equal(result.slots.find((slot) => slot.id === 'turn')?.card, card('9c'));
    assert.equal(cardOwners(result.slots).has(card('9d')), false);
  });

  it('removing a card frees it for another slot and makes its slot the next target', () => {
    const slots = EMPTY.map((slot) => (slot.id === 'flop2' ? { ...slot, card: card('7h') } : slot));
    const removed = removeCard(slots, 'flop2');
    assert.equal(removed.active, 'flop2');
    assert.equal(cardOwners(removed.slots).has(card('7h')), false);
    assert.equal(pickCard(removed.slots, 'hole1', card('7h')).placed?.id, 'hole1');
  });

  it('a used card is named with the slot that holds it', () => {
    const owner = { id: 'hole1', label: 'Hole 1', card: card('Ah') };
    assert.equal(deckCardName(card('Ah'), owner), 'ace of hearts, in use as Hole 1');
    assert.equal(deckCardName(card('Ah'), undefined), 'ace of hearts');
  });
});

describe('keyboard movement', () => {
  it('in rows, right moves along a suit and down moves to the next suit', () => {
    assert.equal(moveInDeck(0, 'ArrowRight', 'rows'), 1);
    assert.equal(moveInDeck(0, 'ArrowDown', 'rows'), 13);
    assert.equal(moveInDeck(14, 'ArrowUp', 'rows'), 1);
    assert.equal(moveInDeck(14, 'ArrowLeft', 'rows'), 13);
    assert.equal(moveInDeck(20, 'Home', 'rows'), 13);
    assert.equal(moveInDeck(20, 'End', 'rows'), 25);
  });

  it('in columns, down moves along a suit and right moves to the next suit', () => {
    assert.equal(moveInDeck(0, 'ArrowDown', 'columns'), 1);
    assert.equal(moveInDeck(0, 'ArrowRight', 'columns'), 13);
    assert.equal(moveInDeck(13, 'ArrowLeft', 'columns'), 0);
  });

  it('stops at the edges rather than wrapping, and ignores other keys', () => {
    assert.equal(moveInDeck(12, 'ArrowRight', 'rows'), 12);
    assert.equal(moveInDeck(0, 'ArrowUp', 'rows'), 0);
    assert.equal(moveInDeck(51, 'ArrowDown', 'rows'), 51);
    assert.equal(moveInDeck(5, 'a', 'rows'), null);
  });
});

async function render(props: Partial<CardPickerProps> = {}): Promise<string> {
  const CardPicker = await loadComponent<CardPickerProps>('components/CardPicker', 'CardPicker');
  const slots = EMPTY.map((slot) => (slot.id === 'hole1' ? { ...slot, card: card('Ah') } : slot));
  return renderToStaticMarkup(
    createElement(CardPicker, {
      groups: [
        { label: 'Your hand', slots: slots.slice(0, 2) },
        { label: 'Board', slots: slots.slice(2) },
      ],
      active: 'hole2',
      onSelectSlot: () => undefined,
      onPick: () => undefined,
      onRemove: () => undefined,
      ...props,
    }),
  );
}

function deckButtons(markup: string): readonly string[] {
  return [...markup.matchAll(/<button[^>]*class="prl-picker__card"[^>]*>/gu)].map((match) => match[0]);
}

describe('the rendered picker', () => {
  it('draws 52 deck buttons, one of them in the tab order', async () => {
    const buttons = deckButtons(await render());
    assert.equal(buttons.length, 52);
    assert.equal(buttons.filter((tag) => tag.includes('tabindex="0"')).length, 1);
  });

  it('disables a used card and says where it is; leaves the rest enabled', async () => {
    const buttons = deckButtons(await render());
    const used = buttons.filter((tag) => tag.includes('aria-disabled="true"'));
    assert.equal(used.length, 1);
    assert.match(used[0] ?? '', /aria-label="ace of hearts, in use as Hole 1"/u);
    assert.ok(
      buttons.some(
        (tag) => tag.includes('aria-label="king of hearts"') && tag.includes('aria-disabled="false"'),
      ),
    );
  });

  it('marks the target slot pressed and names each slot with its card', async () => {
    const markup = await render();
    assert.match(markup, /aria-pressed="true"[^>]*aria-label="Hole 2: empty"/u);
    assert.match(markup, /aria-label="Hole 1: ace of hearts"/u);
  });

  it('draws suits as symbols and never as letters', async () => {
    const markup = await render();
    const ranks = [...markup.matchAll(/<span class="prl-card__pip">([^<]*)<\/span>/gu)].map(
      (match) => match[1],
    );
    assert.ok(ranks.length >= 52);
    assert.ok(
      ranks.every((pip) => ['♠', '♥', '♦', '♣'].includes(pip ?? '')),
      ranks.join(''),
    );
  });

  it('offers removal only for the chosen slot when it holds a card', async () => {
    assert.match(await render(), /aria-disabled="true"[^>]*>Remove card</u);
    assert.match(
      await render({ active: 'hole1' }),
      /aria-disabled="false"[^>]*>Remove ace of hearts from Hole 1</u,
    );
  });
});

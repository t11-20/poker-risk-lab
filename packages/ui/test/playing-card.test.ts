/**
 * `PlayingCard` draws each card from its generated file (`scripts/cards/generate.mjs`), and a seat
 * draws backs only while it still holds cards. Expected file names are hand-derived from the engine's
 * encoding (rank * 4 + suit, suits `c d h s`), not from `describeCard`.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SeatStatus, SeatView } from '../src/view-types.ts';
import { loadComponent } from './support/render-component.ts';

interface PlayingCardProps {
  readonly card: number;
  readonly faceDown?: boolean;
  readonly highlighted?: boolean;
  readonly highlightLabel?: string;
}

interface SeatProps {
  readonly seat: SeatView;
  readonly street: 'flop' | 'complete';
  readonly name: string;
  readonly ringIndex: number;
  readonly ringCount: number;
}

const PUBLIC = new URL('../../../apps/web/public', import.meta.url);

async function card(props: PlayingCardProps): Promise<string> {
  const PlayingCard = await loadComponent<PlayingCardProps>('components/PlayingCard', 'PlayingCard');
  return renderToStaticMarkup(createElement(PlayingCard, props));
}

const sources = (markup: string): readonly string[] =>
  [...markup.matchAll(/<img[^>]* src="([^"]*)"/gu)].map((match) => match[1] ?? '');

const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const SUITS = ['C', 'D', 'H', 'S'];

describe('a face-up card', () => {
  it('draws the file named for its rank and suit, for every card in the deck', async () => {
    const seen = new Set<string>();
    for (let rank = 0; rank < 13; rank++) {
      for (let suit = 0; suit < 4; suit++) {
        const src = sources(await card({ card: rank * 4 + suit }));
        assert.deepEqual(src, [`/cards/${RANKS[rank]}${SUITS[suit]}.svg`], `card ${rank * 4 + suit}`);
        assert.ok(
          existsSync(new URL(`.${src[0]}`, `${PUBLIC.href}/`)),
          `${src[0]} is not in apps/web/public`,
        );
        seen.add(src[0] ?? '');
      }
    }
    assert.equal(seen.size, 52);
  });

  it('names the card once, on the wrapper, and hides the decorative image from readers', async () => {
    const markup = await card({ card: 11 * 4 + 2 });
    assert.match(markup, /<span class="prl-card prl-card--md" role="img" aria-label="king of hearts"><img /u);
    assert.match(markup, /<img [^>]*alt=""/u);
    assert.match(markup, /<img [^>]*aria-hidden="true"/u);
    assert.equal([...markup.matchAll(/aria-label=/gu)].length, 1);
  });

  it('keeps a mark that is not colour alone when it is highlighted', async () => {
    const markup = await card({
      card: 8 * 4 + 2,
      highlighted: true,
      highlightLabel: 'part of the winning hand',
    });
    assert.match(markup, /class="[^"]*prl-card--highlighted[^"]*"/u, 'the class that draws the notch');
    assert.match(markup, /aria-label="ten of hearts, part of the winning hand"/u);
    assert.deepEqual(sources(markup), ['/cards/TH.svg']);
  });
});

describe('a face-down card', () => {
  it('always draws the back, whatever card it was handed', async () => {
    for (const value of [0, 25, 51, -1]) {
      const markup = await card({ card: value, faceDown: true });
      assert.deepEqual(sources(markup), ['/cards/back.svg'], `card ${value}`);
      assert.match(markup, /aria-label="face-down card"/u);
      assert.match(markup, /<img [^>]*aria-hidden="true"/u, 'the back is named once, on the wrapper');
    }
  });

  it('carries no value anywhere in its markup', async () => {
    const markup = await card({ card: 12 * 4 + 3, faceDown: true });
    assert.doesNotMatch(markup, /\b(ace|spades?)\b|AS\.svg|data-/iu);
  });
});

function seatWith(status: SeatStatus, holeCards: SeatView['holeCards']): SeatView {
  return {
    seat: 3,
    playerId: 'opponent',
    stack: 940,
    committedThisStreet: 0,
    committedTotal: 60,
    status,
    position: 'CO',
    holeCards,
    isSelf: false,
    isButton: false,
    isToAct: false,
  };
}

async function seat(status: SeatStatus, holeCards: SeatView['holeCards']): Promise<string> {
  const Seat = await loadComponent<SeatProps>('components/Seat', 'Seat');
  return renderToStaticMarkup(
    createElement(Seat, {
      seat: seatWith(status, holeCards),
      street: 'flop',
      name: 'Nit bot',
      ringIndex: 3,
      ringCount: 6,
    }),
  );
}

const backs = (markup: string): number => [...markup.matchAll(/prl-card--face-down/gu)].length;

describe('an opponent’s seat', () => {
  it('shows two backs while the opponent is still in the hand', async () => {
    assert.equal(backs(await seat('active', null)), 2);
    assert.equal(backs(await seat('allIn', null)), 2);
  });

  it('shows no backs and no card once the opponent has folded', async () => {
    const markup = await seat('folded', null);
    assert.equal(backs(markup), 0);
    assert.doesNotMatch(markup, /class="prl-card[ "]/u);
  });

  it('shows the cards themselves, not backs, when the server reveals them', async () => {
    const markup = await seat('active', [12 * 4 + 3, 12 * 4 + 2]);
    assert.equal(backs(markup), 0);
    assert.deepEqual(sources(markup), ['/cards/AS.svg', '/cards/AH.svg']);
  });
});

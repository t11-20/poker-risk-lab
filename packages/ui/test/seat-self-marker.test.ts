/**
 * The "(you)" marker on the reader's own plate. Every fixture names the reader "You", which read "You (you)".
 * A live seat is named "Guest 3FA2C1" by the API, and there the marker is the only sign of your seat.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SeatView } from '../src/view-types.ts';
import { loadComponent } from './support/render-component.ts';

interface SeatProps {
  readonly seat: SeatView;
  readonly street: 'flop';
  readonly name: string;
  readonly ringIndex: number;
  readonly ringCount: number;
  readonly as?: 'li' | 'div';
}

async function plateName(name: string, isSelf: boolean): Promise<string> {
  const Seat = await loadComponent<SeatProps>('components/Seat', 'Seat');
  const markup = renderToStaticMarkup(
    createElement(Seat, {
      seat: {
        seat: 0,
        playerId: 'fixture-user',
        stack: 970,
        committedThisStreet: 0,
        committedTotal: 30,
        status: 'active',
        position: 'BB',
        holeCards: null,
        isSelf,
        isButton: false,
        isToAct: false,
      },
      street: 'flop',
      name,
      ringIndex: 0,
      ringCount: 6,
      as: 'div',
    }),
  );
  const found = /<p class="prl-seat__name">(.*?)<\/p>/u.exec(markup);
  assert.ok(found !== null, `no name line in the rendered seat:\n${markup}`);
  return (found[1] ?? '').replace(/<[^>]+>/gu, '');
}

describe('the reader’s own plate', () => {
  it('marks a named seat as theirs', async () => {
    assert.equal(await plateName('Guest 3FA2C1', true), 'Guest 3FA2C1 (you)');
  });

  it('does not repeat a name that already says it', async () => {
    assert.equal(await plateName('You', true), 'You');
  });

  it('never marks somebody else’s seat', async () => {
    assert.equal(await plateName('Nit bot', false), 'Nit bot');
  });
});

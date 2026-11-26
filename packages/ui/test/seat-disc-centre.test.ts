/**
 * An opponent's disc over its plate when no cards are drawn beside it. The cluster centres its in-flow
 * items as a group, so an empty row left in the flow still took the gap and moved the disc half of it.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SeatStatus, SeatView, Street } from '../src/view-types.ts';
import { loadComponent } from './support/render-component.ts';

interface SeatProps {
  readonly seat: SeatView;
  readonly street: Street;
  readonly name: string;
  readonly ringIndex: number;
  readonly ringCount: number;
  readonly as?: 'li' | 'div';
}

const strip = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '');
const css = strip(readFileSync(new URL('../src/styles/components.css', import.meta.url), 'utf8'));
const tokens = strip(readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8'));

/** The cluster's gap in px at 16px text, read from the stylesheet and the token it names. */
function clusterGap(): number {
  const body = /(?:^|\})\s*\.prl-seat__cluster \{([^}]*)\}/.exec(css)?.[1] ?? '';
  const token = /(?:^|;)\s*gap:\s*var\((--[\w-]+)\);/.exec(body)?.[1];
  assert.ok(token !== undefined, 'the cluster sets its gap from a token');
  const rem = new RegExp(`${token}:\\s*([\\d.]+)rem;`).exec(tokens)?.[1];
  assert.ok(rem !== undefined, `tokens.css gives ${token} in rem`);
  return Number(rem) * 16;
}

/** Classes the stylesheet takes out of the cluster's flow, as `.prl-seat__cluster > .x { position: absolute }`. */
function outOfFlow(): Set<string> {
  const found = new Set<string>();
  for (const [, list = '', body = ''] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/(?:^|;)\s*position:\s*absolute;/.test(body)) continue;
    for (const part of list.split(',')) {
      const hit = /^\.prl-seat__cluster > \.([\w-]+)$/.exec(part.trim())?.[1];
      if (hit !== undefined) found.add(hit);
    }
  }
  return found;
}

/** The cluster's direct children, each as its class list and whether it is the disc or draws a card. */
function clusterChildren(markup: string): { classes: string[]; disc: boolean; drawsCards: boolean }[] {
  const open = '<div class="prl-seat__cluster">';
  const start = markup.indexOf(open);
  assert.ok(start >= 0, 'the seat renders a cluster');
  const children: { classes: string[]; disc: boolean; drawsCards: boolean }[] = [];
  let depth = 0;
  let from = 0;
  const tag = /<(\/?)([a-z][\w-]*)([^>]*?)(\/?)>/g;
  tag.lastIndex = start + open.length;
  for (let m = tag.exec(markup); m !== null; m = tag.exec(markup)) {
    const [whole, closing, , attrs = '', selfClosing] = m;
    if (closing === '/') {
      if (depth === 0) break;
      depth -= 1;
      if (depth === 0) {
        const child = children.at(-1);
        if (child) child.drawsCards = /class="prl-card-row__cards"/.test(markup.slice(from, m.index));
      }
      continue;
    }
    if (depth === 0) {
      const classes = (/class="([^"]*)"/.exec(attrs)?.[1] ?? '').split(' ');
      children.push({ classes, disc: classes.includes('prl-seat__disc'), drawsCards: false });
      from = m.index + whole.length;
    }
    if (selfClosing !== '/') depth += 1;
  }
  return children;
}

function opponent(status: SeatStatus, holeCards: SeatView['holeCards']): SeatView {
  return {
    seat: 3,
    playerId: 'fixture-bot',
    stack: 1_000,
    committedThisStreet: 0,
    committedTotal: 0,
    status,
    position: 'CO',
    holeCards,
    isSelf: false,
    isButton: false,
    isToAct: false,
  };
}

async function render(seat: SeatView, street: Street = 'flop'): Promise<string> {
  const Seat = await loadComponent<SeatProps>('components/Seat', 'Seat');
  return renderToStaticMarkup(
    createElement(Seat, { seat, street, name: 'Nit bot', ringIndex: 3, ringCount: 6, as: 'div' }),
  );
}

describe('an opponent’s disc with no cards beside it', () => {
  const states: [string, SeatView, Street][] = [
    ['folded', opponent('folded', null), 'flop'],
    ['folded and the hand over', opponent('folded', null), 'complete'],
    ['sitting out', opponent('sittingOut', null), 'flop'],
  ];

  for (const [state, seat, street] of states) {
    it(`is centred over the plate when ${state}`, async () => {
      const removed = outOfFlow();
      const children = clusterChildren(await render(seat, street));
      assert.equal(children.filter((child) => child.disc).length, 1, 'one disc');
      assert.ok(!children.some((child) => child.drawsCards), 'no card is drawn');
      const inFlow = children.filter((child) => !child.classes.some((name) => removed.has(name)));
      const offset = ((inFlow.length - 1) * clusterGap()) / 2;
      assert.equal(offset, 0, `${inFlow.length} items in the cluster's flow put the disc ${offset}px off`);
    });
  }

  it('reads a gap and a seat whose cards stay in the flow beside the disc', async () => {
    assert.ok(clusterGap() > 0);
    const removed = outOfFlow();
    const children = clusterChildren(await render(opponent('active', null)));
    const cards = children.find((child) => child.drawsCards);
    assert.ok(cards, 'two backs are drawn');
    assert.ok(!cards.classes.some((name) => removed.has(name)), 'the backs keep their place');
  });
});

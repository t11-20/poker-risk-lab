import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { lessonsInReadingOrder, quizzes } from '@prl/content';
import type { LiveCalculation } from '@prl/contracts';
import { cardNotationText } from '../src/cards.ts';
import { calculate, type DecisionQuestion, decisionSpot, figureLine } from '../src/learn.ts';

const ASCII_CARDS = /(?<![A-Za-z0-9])[2-9TJQKA][shdc](?: ?[2-9TJQKA][shdc])+(?![A-Za-z0-9])/;

describe('card notation', () => {
  test('a run of cards, joined or spaced, reads as the table writes it', () => {
    assert.equal(cardNotationText('You hold exactly AhKs.'), 'You hold exactly A♥ K♠.');
    assert.equal(cardNotationText('Equity of 7c7d: 55.4%'), 'Equity of 7♣ 7♦: 55.4%');
    assert.equal(
      cardNotationText('On Qh 7h 2h you hold Th 9c — high card queen.'),
      'On Q♥ 7♥ 2♥ you hold 10♥ 9♣ — high card queen.',
    );
    assert.equal(cardNotationText('board Qh7h2c, then "AsKs"'), 'board Q♥ 7♥ 2♣, then "A♠ K♠"');
  });

  test('words and range notation are not cards', () => {
    const prose = [
      'As things stand, pocket Ks hold up as often as not. Ah, the river.',
      'Ks is a king of spades only where a board or a holding says so.',
      '"AA, KK, QQ, AKs, T9s, JTs, A5s, K4o, Q8o, 22+"',
      'Ts and Js and 9s, said aloud.',
      'AsKsQ is not a run of cards, and neither is xAhKs.',
    ];
    for (const text of prose) assert.equal(cardNotationText(text), text);
  });
});

describe('lessons and quizzes show cards as the table does', () => {
  const shown: string[] = [];
  for (const lesson of lessonsInReadingOrder()) {
    for (const block of lesson.blocks) {
      if (block.kind !== 'liveCalculation') continue;
      const computed = calculate(block.calculation);
      shown.push(computed.method, computed.working, ...Object.values(computed.figures).map(figureLine));
    }
  }
  const decisions = quizzes()
    .flatMap((quiz) => quiz.questions)
    .filter((question): question is DecisionQuestion => question.kind === 'decision');
  for (const question of decisions) {
    const spot = decisionSpot(question);
    shown.push(spot.range, spot.facingAction, ...spot.assumptions);
  }

  test('the sweep read lessons and decision spots that carry cards', () => {
    assert.ok(shown.length > 50, `read ${shown.length} strings`);
    assert.ok(decisions.length > 0, 'read decision spots');
    assert.ok(shown.filter((text) => /[♣♦♥♠]/.test(text)).length >= 10, 'cards were found and rewritten');
  });

  test('no computed figure, working or spot writes cards as "7c7d"', () => {
    for (const text of shown) assert.doesNotMatch(text, ASCII_CARDS, text);
  });

  test('an equity figure is labelled with the opponent’s cards', () => {
    const calculation: LiveCalculation = { kind: 'equity', heroCards: 'AhKs', opponents: ['7c7d'] };
    const labels = Object.values(calculate(calculation).figures).map((figure) => figure.label);
    assert.ok(labels.includes('Equity of 7♣ 7♦'), labels.join(', '));
    assert.match(calculate(calculation).working, /You hold exactly A♥ K♠\./);
  });
});

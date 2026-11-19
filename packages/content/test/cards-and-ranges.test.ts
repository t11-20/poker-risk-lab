/**
 * Ranges and calculation cards are parsed at load, so a typo fails the build rather than a learner's
 * answer, which the API would otherwise turn into a 500.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { collectContentProblems, readRawContent } from '../src/index.ts';

type Editable = Record<string, unknown>;

function recordWithId(list: readonly unknown[], id: string): Editable {
  const found = list.find(
    (entry): entry is Editable =>
      typeof entry === 'object' && entry !== null && (entry as Editable)['id'] === id,
  );
  assert.ok(found !== undefined, `no record "${id}"`);
  return found;
}

function withScenarioRange(id: string, notation: string): readonly string[] {
  const raw = structuredClone(readRawContent());
  const range = recordWithId(raw.scenarios, id)['opponentRange'] as Editable;
  assert.equal(range['kind'], 'notation');
  range['notation'] = notation;
  return collectContentProblems(raw);
}

/** The top 0.1% is "AA". The board of eq-second-pair-vs-wide-range shows Ah. */
function topTenthWithHero(holeCards: string): readonly string[] {
  const raw = structuredClone(readRawContent());
  const scenario = recordWithId(raw.scenarios, 'eq-second-pair-vs-wide-range');
  scenario['opponentRange'] = { kind: 'topPercent', percent: 0.1, label: 'aces' };
  const seats = scenario['seats'] as Editable[];
  const hero = seats.find((seat) => seat['isHero'] === true);
  assert.ok(hero !== undefined, 'the scenario has a hero');
  hero['holeCards'] = holeCards;
  return collectContentProblems(raw).filter((problem) => problem.includes('.opponentRange'));
}

function withCalculation(questionId: string, edit: (calculation: Editable) => void): readonly string[] {
  const raw = structuredClone(readRawContent());
  const questions = raw.quizzes.flatMap((quiz) => (quiz as { questions: unknown[] }).questions);
  edit(recordWithId(questions, questionId)['calculation'] as Editable);
  return collectContentProblems(raw);
}

function refused(problems: readonly string[], pattern: RegExp): void {
  assert.ok(
    problems.some((problem) => pattern.test(problem)),
    `nothing matched ${pattern}: ${problems.join('; ')}`,
  );
}

describe('a scenario opponent range', () => {
  it('is refused when it does not parse', () => {
    refused(
      withScenarioRange('eq-set-on-connected-flop-jam', 'ZZ+, AKx'),
      /\.opponentRange\.notation: could not parse range "ZZ\+, AKx"/,
    );
  });

  it('is refused when hero and the board hold every card it could contain', () => {
    // Hero holds 8s8d and the board shows 8h, so no two eights are left for "88".
    refused(
      withScenarioRange('eq-set-on-connected-flop-jam', '88'),
      /\.opponentRange\.notation: every hand in "88" uses a card/,
    );
  });

  it('is accepted when some of it is left to deal', () => {
    assert.deepEqual(withScenarioRange('eq-set-on-connected-flop-jam', '88, 99'), []);
  });

  it('is refused as a top percentage when the blockers leave none of it', () => {
    // Hero's AsAd and the board's Ah leave no two aces for "AA".
    refused(topTenthWithHero('AsAd'), /\.opponentRange\.percent: every hand in "AA" uses a card/);
    assert.deepEqual(topTenthWithHero('9h8h'), [], 'control: with the shipped hand, aces are left');
  });
});

describe("a quiz calculation's cards", () => {
  it('are refused when an equity opponent holds a card hero holds', () => {
    // reading-board-q4: hero AhKh on Qh7h2c.
    const problems = withCalculation('reading-board-q4', (calculation) => {
      calculation['opponents'] = ['AhQd'];
    });
    refused(problems, /\.calculation: card appears twice — in heroCards and in opponents\[0\]/);
  });

  it('are refused when an equity opponent range does not parse, and accepted when it does', () => {
    const typo = withCalculation('reading-board-q4', (calculation) => {
      calculation['opponents'] = ['ZZ+'];
    });
    refused(typo, /\.calculation\.opponents\[0\]: could not parse range "ZZ\+"/);
    const range = withCalculation('reading-board-q4', (calculation) => {
      calculation['opponents'] = ['QQ+, AKs', 'top:15'];
    });
    assert.deepEqual(range, []);
  });

  it('are refused when an outs opponent is not a holding', () => {
    const problems = withCalculation('counting-outs-q4', (calculation) => {
      calculation['opponentCards'] = 'notcards';
    });
    refused(problems, /\.calculation\.opponentCards: could not parse cards from "notcards"/);
  });

  it('are refused when an outs opponent holds a card on the board', () => {
    // counting-outs-q4: hero Th9h on Ah7h2c4d.
    const problems = withCalculation('counting-outs-q4', (calculation) => {
      calculation['opponentCards'] = 'AhKs';
    });
    refused(problems, /\.calculation: card appears twice — in board and in opponentCards/);
  });
  it('are refused when hero is not two cards', () => {
    const hero = withCalculation('reading-board-q4', (calculation) => {
      calculation['heroCards'] = 'AhKhQd';
    });
    refused(hero, /\.calculation\.heroCards: a holding is exactly 2 cards, got 3/);
  });

  it('are refused when an equity opponent names three cards', () => {
    const opponent = withCalculation('reading-board-q4', (calculation) => {
      calculation['opponents'] = ['QsJcTd'];
    });
    refused(
      opponent,
      /\.calculation\.opponents\[0\]: an opponent is exactly 2 cards or a range, got 3 cards/,
    );
  });

  it('are refused when an outs opponent is present and empty', () => {
    const empty = withCalculation('counting-outs-q4', (calculation) => {
      calculation['opponentCards'] = '';
    });
    refused(empty, /\.calculation\.opponentCards: string is shorter than 1 characters/);
  });

  it('are refused when a top percentage is not a whole number from 1 to 100', () => {
    for (const bad of ['top:abc', 'top:0', 'top:12.5', 'top:101']) {
      const problems = withCalculation('reading-board-q4', (calculation) => {
        calculation['opponents'] = [bad];
      });
      refused(problems, /\.calculation\.opponents\[0\]: a top-percentage is written "top:15"/);
    }
  });
});

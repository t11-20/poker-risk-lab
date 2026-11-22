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
    refused(problems, /\.calculation: card Ah appears twice — in heroCards and in opponents\[0\]/);
  });

  it('are refused when an equity opponent is a range or a top percentage, not an exact hand', () => {
    // reading-board-q4: hero AhKh on Qh7h2c against QsJc.
    for (const opponent of ['QQ+, AKs', 'QQ+', 'top:15', 'ZZ+', '', '   ', 7]) {
      const problems = withCalculation('reading-board-q4', (calculation) => {
        calculation['opponents'] = [opponent];
      });
      const reported = problems.filter((problem) => problem.includes('.calculation.opponents[0]:'));
      assert.equal(reported.length, 1, `${JSON.stringify(opponent)}: ${problems.join('; ')}`);
    }
    for (const range of ['QQ+, AKs', 'top:15']) {
      const problems = withCalculation('reading-board-q4', (calculation) => {
        calculation['opponents'] = [range];
      });
      refused(problems, /\.calculation\.opponents\[0\]: an equity opponent is an exact two-card hand/);
    }
    // Ah and Kh are hero's and Qh is on the board, so each card would also be a duplicate.
    const tooMany = withCalculation('reading-board-q4', (calculation) => {
      calculation['opponents'] = ['AhKhQh'];
    });
    assert.equal(tooMany.length, 1, `a refused hand is not also a duplicate card: ${tooMany.join('; ')}`);
    const typo = withCalculation('reading-board-q4', (calculation) => {
      calculation['opponents'] = ['QsJx'];
    });
    refused(typo, /\.calculation\.opponents\[0\]: an equity opponent .* got "QsJx" \(.*suit.*\)/);
    const exact = withCalculation('reading-board-q4', (calculation) => {
      calculation['opponents'] = ['QsJc', 'Td9d'];
    });
    assert.deepEqual(exact, [], 'control: exact holdings are accepted');
  });

  it('are refused when an equity calculation has no opponents, too many, or no list', () => {
    for (const opponents of [[], ['QsJc', 'Td9d', '8c8d', '6s5s', '4c3c', '3d2d'], 'QsJc']) {
      const problems = withCalculation('reading-board-q4', (calculation) => {
        calculation['opponents'] = opponents;
      });
      const reported = problems.filter((problem) => problem.includes('.calculation.opponents:'));
      assert.equal(reported.length, 1, `${JSON.stringify(opponents)}: ${problems.join('; ')}`);
    }
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
    refused(problems, /\.calculation: card Ah appears twice — in board and in opponentCards/);
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
    refused(opponent, /\.calculation\.opponents\[0\]: a holding is exactly 2 cards, got 3/);
  });

  it('are refused when an outs calculation names no opponent', () => {
    // The browser and the bot count outs only against one exact hand, so a missing one cannot be shown.
    const missing = withCalculation('counting-outs-q4', (calculation) => {
      calculation['opponentCards'] = undefined;
    });
    refused(
      missing,
      /\.calculation\.opponentCards: an outs calculation names the opponent's exact two cards/,
    );
  });

  it('are refused once, as a board, when a board repeats a card', () => {
    // reading-board-q4 is equity with hero AhKh; counting-outs-q4 is outs with hero Th9h.
    for (const question of ['reading-board-q4', 'counting-outs-q4']) {
      const problems = withCalculation(question, (calculation) => {
        calculation['board'] = 'AhAh7c';
      });
      assert.deepEqual(
        problems.filter((problem) => problem.includes('.calculation')),
        problems.filter((problem) => problem.includes('.calculation.board: a board names each card once')),
        question,
      );
      refused(problems, /\.calculation\.board: a board names each card once, got "AhAh7c"/);
    }
  });

  it('are refused once when an equity opponent holds the same card twice', () => {
    // reading-board-q4: hero AhKh, so the old check also reported Ah as a clash, twice.
    const problems = withCalculation('reading-board-q4', (calculation) => {
      calculation['opponents'] = ['AhAh'];
    });
    assert.deepEqual(
      problems.filter((problem) => problem.includes('.calculation')),
      problems.filter((problem) =>
        problem.includes('.calculation.opponents[0]: a holding is two different cards'),
      ),
    );
    refused(problems, /\.calculation\.opponents\[0\]: a holding is two different cards, got "AhAh"/);
  });

  it('are refused when an outs opponent is empty', () => {
    const empty = withCalculation('counting-outs-q4', (calculation) => {
      calculation['opponentCards'] = '';
    });
    refused(empty, /\.calculation\.opponentCards: string is shorter than 1 characters/);
  });
});

describe("a quiz calculation's board, as the calculators will take it", () => {
  it('refuses an equity board that is not preflop, a flop, a turn or a river', () => {
    // reading-board-q4: hero AhKh on Qh7h2c.
    const two = withCalculation('reading-board-q4', (calculation) => {
      calculation['board'] = 'Qh7h';
    });
    refused(
      two,
      /\.calculation\.board: an equity board is left out before the flop, or has 3, 4 or 5 cards, got 2/,
    );
    const turn = withCalculation('reading-board-q4', (calculation) => {
      calculation['board'] = 'Qh7h2c3d';
    });
    assert.deepEqual(turn, [], 'control: a turn is a board');
  });

  it('refuses outs counted on anything but a flop or a turn', () => {
    // counting-outs-q4: hero Th9h on Ah7h2c4d.
    const river = withCalculation('counting-outs-q4', (calculation) => {
      calculation['board'] = 'Ah7h2c4dKs';
    });
    refused(river, /\.calculation\.board: outs are counted on a flop or a turn, 3 or 4 cards, got 5/);
    for (const empty of ['   ', ',', ' , ,']) {
      const blank = withCalculation('counting-outs-q4', (calculation) => {
        calculation['board'] = empty;
      });
      refused(blank, /\.calculation\.board: outs are counted on a flop or a turn, 3 or 4 cards, got 0/);
    }
    const flop = withCalculation('counting-outs-q4', (calculation) => {
      calculation['board'] = 'Ah7h2c';
    });
    assert.deepEqual(flop, [], 'control: a flop is counted');
  });

  it('reports a missing or empty outs board once, not also as zero cards', () => {
    for (const board of [undefined, '']) {
      const problems = withCalculation('counting-outs-q4', (calculation) => {
        calculation['board'] = board;
      });
      const reported = problems.filter((problem) => problem.includes('.calculation.board'));
      assert.equal(reported.length, 1, `${JSON.stringify(board)}: ${problems.join('; ')}`);
    }
  });

  it('reports an overlong outs board once, not also as unparseable', () => {
    const problems = withCalculation('counting-outs-q4', (calculation) => {
      calculation['board'] = 'Xx'.repeat(13);
    });
    assert.equal(
      problems.filter((problem) => problem.includes('.calculation.board:')).length,
      1,
      problems.join('; '),
    );
  });

  it('reports an unparseable outs board once, not also as zero cards', () => {
    const problems = withCalculation('counting-outs-q4', (calculation) => {
      calculation['board'] = 'Ah7hXx';
    });
    refused(problems, /\.calculation\.board: could not parse cards from "Ah7hXx"/);
    assert.ok(!problems.some((problem) => problem.includes('got 0')), problems.join('; '));
  });
});

describe("a calculation's holdings and equity board, each refused once", () => {
  const at = (problems: readonly string[], path: string) =>
    problems.filter((problem) => problem.includes(`.calculation.${path}:`));

  // reading-board-q4 is equity, hero AhKh on Qh7h2c. counting-outs-q4 is outs, hero Th9h on Ah7h2c4d.
  const holdings = [
    { question: 'reading-board-q4', field: 'heroCards', good: 'AhKh' },
    { question: 'counting-outs-q4', field: 'heroCards', good: 'Th9h' },
    { question: 'counting-outs-q4', field: 'opponentCards', good: 'AsKs' },
  ];

  it('refuses a holding that is missing, blank, unparseable or not two cards', () => {
    for (const { question, field } of holdings) {
      for (const value of [
        undefined,
        null,
        7,
        '',
        '   ',
        ',',
        ' , ',
        'Xx',
        '9c',
        '9c8c6c',
        'Xx'.repeat(13),
      ]) {
        const problems = withCalculation(question, (calculation) => {
          calculation[field] = value;
        });
        assert.equal(
          at(problems, field).length,
          1,
          `${question} ${field} ${JSON.stringify(value)}: ${problems.join('; ')}`,
        );
      }
    }
  });

  it('accepts the shipped holdings', () => {
    for (const { question, field, good } of holdings) {
      const problems = withCalculation(question, (calculation) => {
        calculation[field] = good;
      });
      assert.deepEqual(problems, [], `control: ${question} ${field}`);
    }
  });

  it('refuses an equity board that is present but is not a string or names no cards', () => {
    for (const board of [null, 7, ['Qh', '7h', '2c'], '', '   ', ',', 'Xx', 'Qh', 'Xx'.repeat(13)]) {
      const problems = withCalculation('reading-board-q4', (calculation) => {
        calculation['board'] = board;
      });
      assert.equal(at(problems, 'board').length, 1, `${JSON.stringify(board)}: ${problems.join('; ')}`);
    }
    const preflop = withCalculation('reading-board-q4', (calculation) => {
      calculation['board'] = undefined;
    });
    assert.deepEqual(preflop, [], 'control: a board left out is preflop');
  });
});

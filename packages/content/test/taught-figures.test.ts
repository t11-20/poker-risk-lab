/**
 * Every number the teaching prose works through as arithmetic, recomputed ("13 pairs at six each,
 * which is 78"). `scenarios.test.ts` covers `expectedInsight`, and nothing else checked these.
 * Each entry's quote must appear exactly once in its record, and every value `expect()` returns must
 * be derived by the engine, poker-math or arithmetic here and appear in the quote.
 * The second test sweeps every live calculation and numeric question for prose that states inputs
 * other than the ones the app grades against.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyAction,
  buildPotLayers,
  type Card,
  createDeterministicRandomForTests,
  evaluate,
  minimumRaiseTo,
  parseCards,
  type SeatSetup,
  startHand,
} from '@prl/poker-engine';
import {
  allHandClasses,
  combosOfClass,
  defenceFrequency,
  icmEquity,
  parseRange,
  potOdds,
  projectResults,
  riskOfRuin,
} from '@prl/poker-math';
import { content } from '../src/index.ts';

function lessonText(id: string): string {
  const lesson = content().lessons.find((one) => one.id === id);
  assert.ok(lesson !== undefined, `no lesson "${id}" — the registry names a record that no longer exists`);
  const parts: string[] = [lesson.title, lesson.summary, ...lesson.keyTakeaways];
  for (const block of lesson.blocks) {
    if ('text' in block) parts.push(block.text);
    if ('title' in block && typeof block.title === 'string') parts.push(block.title);
    if ('caption' in block) parts.push(block.caption);
    if ('expression' in block) parts.push(block.expression);
    if ('explanation' in block && typeof block.explanation === 'string') parts.push(block.explanation);
    if ('items' in block) parts.push(...block.items);
    if ('prompt' in block && typeof block.prompt === 'string') parts.push(block.prompt);
  }
  return parts.join('\n');
}

function quizText(id: string): string {
  const quiz = content().quizzes.find((one) => one.id === id);
  assert.ok(quiz !== undefined, `no quiz "${id}" — the registry names a record that no longer exists`);
  const parts: string[] = [quiz.title, quiz.reviewAdvice];
  for (const question of quiz.questions) {
    parts.push(question.prompt, question.explanation);
    if (question.kind === 'multipleChoice') {
      parts.push(...question.options);
      if (question.optionNotes !== undefined) parts.push(...question.optionNotes);
    }
  }
  return parts.join('\n');
}

function glossaryText(id: string): string {
  const entry = content().glossary.find((one) => one.id === id);
  assert.ok(
    entry !== undefined,
    `no glossary entry "${id}" — the registry names a record that no longer exists`,
  );
  return [entry.term, entry.definition, entry.formula ?? ''].join('\n');
}

function scenarioText(id: string): string {
  const scenario = content().scenarios.find((one) => one.id === id);
  assert.ok(
    scenario !== undefined,
    `no scenario "${id}" — the registry names a record that no longer exists`,
  );
  return [
    scenario.title,
    scenario.question,
    scenario.facingAction,
    scenario.reasoning,
    ...scenario.assumptions,
    ...scenario.commonMistakes,
  ].join('\n');
}

const HAND_CLASSES = allHandClasses();
const combosOf = (label: string): number => {
  const found = HAND_CLASSES.find((one) => one.label === label);
  assert.ok(found !== undefined, `no hand class "${label}"`);
  return combosOfClass(found).length;
};
const combosLeft = (label: string, blockers: string): number =>
  parseRange(label, parseCards(blockers)).combos.length;

/**
 * The minimum raise-to from a hand the engine actually dealt, not a re-typed formula.
 * Three seats, because heads-up puts the button on the small blind. Seat 0 acts first preflop.
 */
function engineMinimumRaiseAfterOpen(smallBlind: number, bigBlind: number, openTo: number): number {
  const seats: SeatSetup[] = [0, 1, 2].map((seat) => ({ seat, playerId: `p${seat}`, stack: 10_000 }));
  const { state } = startHand({
    handId: 'taught-figures',
    roomId: 'taught-figures',
    handNumber: 1,
    config: { smallBlind, bigBlind, ante: 0, maxSeats: 3, actionTimeoutSeconds: 30 },
    buttonSeat: 0,
    seats,
    random: createDeterministicRandomForTests(1),
  });
  assert.equal(state.toAct, 0, 'three-handed, the button acts first preflop');
  const opened = applyAction(state, 0, { type: 'raise', to: openTo }).state;
  assert.equal(opened.betLevel, openTo);
  return minimumRaiseTo(opened);
}

const scoreOf = (cards: string): number => evaluate(parseCards(cards));

interface TaughtFigure {
  readonly where: string;
  readonly quote: string;
  readonly source: () => string;
  /** Derived values, rendered as they must appear in the quote. None is copied from the content. */
  readonly expect: () => readonly string[];
}

const TAUGHT_FIGURES: readonly TaughtFigure[] = [
  {
    where: 'lesson ranges-and-combos — the chain from 169 classes to 1,326 combinations',
    quote:
      'There are 13 pairs at six each, which is 78; there are 78 suited classes at four each, which is 312; ' +
      'and 78 offsuit classes at twelve each, which is 936. Add them and you get 1326, which is exactly 52 ' +
      'times 51 divided by 2',
    source: () => lessonText('ranges-and-combos'),
    expect: () => {
      const pairs = HAND_CLASSES.filter((one) => one.shape === 'pair');
      const suited = HAND_CLASSES.filter((one) => one.shape === 'suited');
      const offsuit = HAND_CLASSES.filter((one) => one.shape === 'offsuit');
      const total = (classes: typeof HAND_CLASSES): number =>
        classes.reduce((sum, one) => sum + combosOfClass(one).length, 0);
      const everything = total(HAND_CLASSES);
      // The lesson claims 1326 from both the enumeration and C(52,2).
      assert.equal(everything, (52 * 51) / 2, 'the enumerated combinations must equal C(52,2)');
      assert.equal(HAND_CLASSES.length, 169, 'the 169 classes the sentence ends on');
      return [
        String(pairs.length),
        String(total(pairs)),
        String(suited.length),
        String(total(suited)),
        String(offsuit.length),
        String(total(offsuit)),
        String(everything),
      ];
    },
  },
  {
    where: 'lesson ranges-and-combos — combinations per class shape',
    quote:
      'A pair of ranks with no suit specified, such as ace-king in general: 4 suited plus 12 offsuit, so 16 combinations.',
    source: () => lessonText('ranges-and-combos'),
    expect: () => {
      const suited = combosOf('AKs');
      const offsuit = combosOf('AKo');
      const both = parseRange('AK').combos.length;
      assert.equal(suited + offsuit, both, 'AK is exactly its suited and offsuit halves');
      return [String(suited), String(offsuit), String(both)];
    },
  },
  {
    where: 'lesson ranges-and-combos — one blocker removes four combinations, not one',
    quote:
      'Suppose their range contains ace-king, all sixteen combinations of it. If you hold the ace of clubs, ' +
      'the four holdings that used that exact card are gone and twelve remain.',
    source: () => lessonText('ranges-and-combos'),
    expect: () => {
      const unblocked = parseRange('AK').combos.length;
      // 2d is not a blocker, so Ac is the only one in play.
      const blocked = combosLeft('AK', 'Ac 2d');
      return [wordFor(unblocked), wordFor(unblocked - blocked), wordFor(blocked)];
    },
  },
  {
    where: 'lesson ranges-and-combos — two visible queens leave one combination of QQ',
    quote:
      'Six combinations exist in the abstract, but the board queen removes three of them, leaving three. ' +
      'If you also hold a queen yourself, only one combination survives.',
    source: () => lessonText('ranges-and-combos'),
    expect: () => {
      const abstract = combosOf('QQ');
      const afterBoard = combosLeft('QQ', 'Qh 7h 2c');
      const afterBoth = combosLeft('QQ', 'Qh 7h 2c Qs');
      return [wordFor(abstract), wordFor(abstract - afterBoard), wordFor(afterBoard), wordFor(afterBoth)];
    },
  },
  {
    where: 'quiz quiz-ranges-and-combos — the blocker questions and the options offered',
    quote: 'Correct: four of the sixteen used your exact card.',
    source: () => quizText('quiz-ranges-and-combos'),
    expect: () => {
      const unblocked = parseRange('AK').combos.length;
      const blocked = combosLeft('AK', 'Ac 2d');
      return [wordFor(unblocked - blocked), wordFor(unblocked)];
    },
  },
  {
    where: 'quiz quiz-ranges-and-combos — the QQ count after two visible queens',
    quote:
      'Six combinations exist in the abstract. The queen on the board removes every combination containing it, ' +
      'leaving three.',
    source: () => quizText('quiz-ranges-and-combos'),
    expect: () => [wordFor(combosOf('QQ')), wordFor(combosLeft('QQ', 'Qh 7h 2c'))],
  },
  {
    where: 'lesson betting-actions — the minimum-raise chain at 10/20',
    quote:
      'Work it through with the blinds at 10 and 20. Someone opens to 60: they raised the level by 40 over the ' +
      'big blind. The next raise must therefore reach at least 100, not 80 and not 120. If instead that player ' +
      'had made it 180, the increment would be 160 and the following raise would have to reach at least 340.',
    source: () => lessonText('betting-actions'),
    expect: () => {
      const smallBlind = 10;
      const bigBlind = 20;
      const afterSixty = engineMinimumRaiseAfterOpen(smallBlind, bigBlind, 60);
      const afterOneEighty = engineMinimumRaiseAfterOpen(smallBlind, bigBlind, 180);
      // The sentence names two wrong answers. 80 adds the increment to the big blind, 120 doubles.
      assert.notEqual(afterSixty, 60 + bigBlind, "80 must not be the engine's answer");
      assert.notEqual(afterSixty, 60 * 2, "120 must not be the engine's answer");
      return [
        String(smallBlind),
        String(bigBlind),
        String(afterSixty - bigBlind),
        String(afterSixty),
        String(60 + bigBlind),
        String(60 * 2),
        String(afterOneEighty - 180),
        String(afterOneEighty),
      ];
    },
  },
  {
    where: 'quiz quiz-betting-actions — the smallest legal raise over a bet of 20',
    quote:
      'The last increment was 20 (from nothing to 20), so the smallest raise adds another 20, making your total 40.',
    source: () => quizText('quiz-betting-actions'),
    expect: () => {
      // A postflop first bet has the same arithmetic as an open over a big blind of that size.
      const minimum = engineMinimumRaiseAfterOpen(10, 20, 40);
      assert.equal(minimum, 60, 'the engine adds the increment to the level, it does not double');
      return [String(minimum - 20), String(minimum - 20), String(minimum - 20)];
    },
  },
  {
    where: 'lesson rule-of-2-and-4 — 47 unseen cards on the flop, and what one of them is worth',
    quote:
      'so forty-seven are unseen from your seat. One out is therefore one chance in forty-seven, which is a ' +
      'little more than two percent',
    source: () => lessonText('rule-of-2-and-4'),
    expect: () => {
      const unseenOnTheFlop = 52 - 2 - 3;
      const oneOut = 1 / unseenOnTheFlop;
      // "a little more than two percent" is a bound, above 2% and below 2.5%.
      assert.ok(oneOut > 0.02, `one out of ${unseenOnTheFlop} must be above 2%, it is ${oneOut}`);
      assert.ok(oneOut < 0.025, `one out of ${unseenOnTheFlop} must be close to 2%, it is ${oneOut}`);
      return [wordFor(unseenOnTheFlop), wordFor(unseenOnTheFlop)];
    },
  },
  {
    where: 'quiz quiz-counting-outs — thirteen of a suit minus the four you can see',
    quote:
      'There are thirteen cards of each suit. You can see four of them: two in your hand and two on the board.',
    source: () => quizText('quiz-counting-outs'),
    expect: () => {
      // Counted off the deck, two hearts in hand on a two-heart flop.
      const board = parseCards('Qh 7h 2c');
      const hero = parseCards('Ah Kh');
      const suitOf = (card: Card): number => card % 4;
      const hearts = parseCards('Ah Kh Qh Jh Th 9h 8h 7h 6h 5h 4h 3h 2h');
      const visibleHearts = [...hero, ...board].filter((card) => suitOf(card) === suitOf(hero[0] as Card));
      assert.equal(hearts.length, 13, 'thirteen cards carry any one suit');
      assert.equal(visibleHearts.length, 4, 'two in hand and two on the board');
      return [wordFor(hearts.length), wordFor(visibleHearts.length)];
    },
  },
  {
    where: 'quiz quiz-all-ins-and-side-pots — three all-ins at 20/100/100',
    quote:
      'The short stack put in 20, so 20 from each of the three forms a main pot of 60 that all three are ' +
      'eligible for. The extra 80 from each of the larger stacks forms a side pot of 160, contested only by them.',
    source: () => quizText('quiz-all-ins-and-side-pots'),
    expect: () => {
      const layers = buildPotLayers([
        { seat: 0, committedTotal: 20, status: 'allIn' },
        { seat: 1, committedTotal: 100, status: 'allIn' },
        { seat: 2, committedTotal: 100, status: 'allIn' },
      ]);
      assert.equal(layers.pots.length, 2, 'two distinct commitment levels make two pots');
      assert.deepEqual(layers.returns, [], 'every chip was matched, so nothing comes back');
      const main = layers.pots[0];
      const side = layers.pots[1];
      assert.ok(main !== undefined && side !== undefined);
      assert.equal(main.eligibleSeats.length, 3, 'all three contest the main pot');
      assert.equal(side.eligibleSeats.length, 2, 'only the two larger stacks contest the side pot');
      return [
        String(main.amount / 3),
        String(main.amount / 3),
        String(main.amount),
        String(side.amount / 2),
        String(side.amount),
      ];
    },
  },
  {
    where: 'quiz quiz-all-ins-and-side-pots — the uncalled part of a 200 bet against 120',
    quote: 'The extra 80 is returned to you before the showdown',
    source: () => quizText('quiz-all-ins-and-side-pots'),
    expect: () => {
      const layers = buildPotLayers([
        { seat: 0, committedTotal: 200, status: 'allIn' },
        { seat: 1, committedTotal: 120, status: 'allIn' },
      ]);
      // `pots.ts` returns an uncalled bet as a layer only its contributor is eligible for, not via
      // `returns`. So "the extra 80 is returned" is this layer.
      const uncalled = layers.pots.find((pot) => pot.eligibleSeats.length === 1);
      assert.ok(
        uncalled !== undefined,
        'the over-committed chips must end up somewhere only the bettor can win',
      );
      assert.deepEqual([...uncalled.eligibleSeats], [0], 'the bettor is the one who over-committed');
      return [String(uncalled.amount)];
    },
  },
  {
    where: 'lesson tournament-chips-and-icm — 300/100 chips against a 70/30 ladder',
    quote:
      'Two players, stacks 300 and 100, prizes 70 and 30. Chip share is 75 / 25. Prize equity is 60 / 40',
    source: () => lessonText('tournament-chips-and-icm'),
    expect: () => {
      const stacks = [300, 100] as const;
      const payouts = [70, 30] as const;
      const result = icmEquity([...stacks], [...payouts]);
      const chips = stacks[0] + stacks[1];
      const [leader, short] = result.equities;
      assert.ok(leader !== undefined && short !== undefined);
      assert.equal(leader + short, result.totalPrizePool, 'the ladder is fully distributed');
      return [
        String(stacks[0]),
        String(stacks[1]),
        String(payouts[0]),
        String(payouts[1]),
        String((stacks[0] / chips) * 100),
        String((stacks[1] / chips) * 100),
        String(leader),
        String(short),
      ];
    },
  },
  {
    where: 'quiz quiz-tournament-chips-and-icm — the working behind the 15-point gap',
    quote:
      "Chip share is 75%. Prize equity is 60%. The short stack's chance of finishing first is 100/400 = 25%, " +
      'so they take 25% of first plus 75% of second: 0.25×70 + 0.75×30 = 40. The leader holds the rest of a ' +
      '100-unit pool. The 15-point gap between chip share and prize share is the curve the lesson is about.',
    source: () => quizText('quiz-tournament-chips-and-icm'),
    expect: () => {
      const stacks = [300, 100];
      const payouts = [70, 30];
      const result = icmEquity(stacks, payouts);
      const chips = stacks.reduce((sum, one) => sum + one, 0);
      const shortWinsFirst = (stacks[1] as number) / chips;
      const leaderShare = ((result.equities[0] as number) / result.totalPrizePool) * 100;
      const chipShare = ((stacks[0] as number) / chips) * 100;
      // The quiz's Malmuth-Harville working must reproduce icmEquity for the short stack.
      const byHand = shortWinsFirst * (payouts[0] as number) + (1 - shortWinsFirst) * (payouts[1] as number);
      assert.ok(
        Math.abs(byHand - (result.equities[1] as number)) < 1e-9,
        'the hand-worked figure is icmEquity',
      );
      return [
        String(chipShare),
        String(leaderShare),
        `${stacks[1]}/${chips}`,
        String(shortWinsFirst * 100),
        String(shortWinsFirst),
        String(1 - shortWinsFirst),
        String(byHand),
        String(result.totalPrizePool),
        String(chipShare - leaderShare),
      ];
    },
  },
  {
    where: 'lesson sample-size-and-risk-of-ruin — the square-root law',
    quote:
      'To halve your uncertainty you need four times the hands; to divide it by ten you need a hundred times as many.',
    source: () => lessonText('sample-size-and-risk-of-ruin'),
    expect: () => {
      const spread = (hands: number): number =>
        projectResults({ hands, winRateBbPer100: 3, standardDeviationBbPer100: 90 }).standardDeviationBb /
        hands;
      const base = spread(100_000);
      const halved = factorFor(spread, base, 1 / 2);
      const tenth = factorFor(spread, base, 1 / 10);
      return [wordFor(halved), wordFor(tenth)];
    },
  },
  {
    where: 'quiz quiz-sample-size-and-risk-of-ruin — what twice and ten times the hands actually buy',
    quote: 'Twice the hands reduces uncertainty by a factor of about 1.4, not 2.',
    source: () => quizText('quiz-sample-size-and-risk-of-ruin'),
    expect: () => {
      const spread = (hands: number): number =>
        projectResults({ hands, winRateBbPer100: 3, standardDeviationBbPer100: 90 }).standardDeviationBb /
        hands;
      const shrink = spread(100_000) / spread(200_000);
      assert.ok(shrink > 1.4 && shrink < 1.45, `doubling the sample shrinks the interval by ${shrink}`);
      return [shrink.toFixed(1)];
    },
  },
  {
    where: 'lesson sample-size-and-risk-of-ruin — bankroll and win rate enter the exponent identically',
    quote:
      'It lands in the same place as tripling the bankroll did, because bankroll and win rate enter the exponent in exactly the same way.',
    source: () => lessonText('sample-size-and-risk-of-ruin'),
    expect: () => {
      const sd = 90;
      const tripledBankroll = riskOfRuin({
        bankrollBb: 3_000,
        winRateBbPer100: 3,
        standardDeviationBbPer100: sd,
      });
      const tripledEdge = riskOfRuin({
        bankrollBb: 1_000,
        winRateBbPer100: 9,
        standardDeviationBbPer100: sd,
      });
      assert.ok(
        Math.abs(tripledBankroll.probability - tripledEdge.probability) < 1e-12,
        `tripling the bankroll gives ${tripledBankroll.probability}, tripling the edge ${tripledEdge.probability}`,
      );
      // The claim is that the lesson's two calculators agree. The sentence carries no figure.
      return [];
    },
  },
  {
    where: 'glossary alpha and minimum defence frequency — two halves of one whole',
    quote: 'MDF = pot / (pot + bet) = 1 - alpha',
    source: () => glossaryText('minimum-defence-frequency'),
    expect: () => {
      for (const [pot, bet] of [
        [100, 50],
        [100, 100],
        [60, 45],
      ] as const) {
        const defence = defenceFrequency(pot, bet);
        assert.ok(Math.abs(defence.alpha - bet / (pot + bet)) < 1e-12, 'alpha is bet over pot-plus-bet');
        assert.ok(
          Math.abs(defence.minimumDefenceFrequency - pot / (pot + bet)) < 1e-12,
          'MDF is pot over pot-plus-bet',
        );
        assert.ok(Math.abs(defence.alpha + defence.minimumDefenceFrequency - 1) < 1e-12, 'they add to one');
      }
      return [];
    },
  },
  {
    where: 'glossary pot odds — the fraction the whole pot-odds topic rests on',
    quote: 'pot odds = call / (pot including the bet + call)',
    source: () => glossaryText('pot-odds'),
    expect: () => {
      for (const [pot, call] of [
        [120, 60],
        [90, 30],
        [180, 120],
      ] as const) {
        const odds = potOdds(pot, call);
        assert.ok(
          Math.abs(odds.breakEvenEquity - call / (pot + call)) < 1e-12,
          'break-even is call over final pot',
        );
        // `oddsRatio` is null only with nothing to call, and every spot here has a bet.
        assert.notEqual(odds.oddsRatio, null, 'a priced call must carry a ratio');
        assert.ok(
          Math.abs((odds.oddsRatio ?? Number.NaN) - pot / call) < 1e-12,
          'the ratio is pot over call',
        );
      }
      return [];
    },
  },
  {
    where: 'glossary risk of ruin — the closed form the lesson calculators use',
    quote: 'risk of ruin ~= exp(-2 x win rate x bankroll / standard deviation^2)',
    source: () => glossaryText('risk-of-ruin'),
    expect: () => {
      for (const [bankroll, rate, sd] of [
        [1_000, 3, 90],
        [3_000, 3, 90],
        [500, 5, 100],
      ] as const) {
        const computed = riskOfRuin({
          bankrollBb: bankroll,
          winRateBbPer100: rate,
          standardDeviationBbPer100: sd,
        }).probability;
        const closedForm = Math.exp((-2 * rate * bankroll) / (sd * sd));
        assert.ok(Math.abs(computed - closedForm) < 1e-12, `${computed} against ${closedForm}`);
      }
      return [];
    },
  },
  {
    where: 'glossary standard deviation — the square-root scaling',
    quote: 'standard deviation over n hands = (standard deviation per 100 hands) x sqrt(n / 100)',
    source: () => glossaryText('standard-deviation'),
    expect: () => {
      for (const hands of [10_000, 20_000, 250_000]) {
        const projected = projectResults({ hands, winRateBbPer100: 5, standardDeviationBbPer100: 100 });
        assert.ok(
          Math.abs(projected.standardDeviationBb - 100 * Math.sqrt(hands / 100)) < 1e-9,
          `${hands} hands projected ${projected.standardDeviationBb}`,
        );
      }
      return [];
    },
  },
  {
    where: 'glossary combos — C(52,2) and the per-shape counts',
    quote: 'two-card combinations in a full deck = C(52,2) = 1326; per class: pair 6, suited 4, offsuit 12',
    source: () => glossaryText('combos'),
    expect: () => {
      const everything = HAND_CLASSES.reduce((sum, one) => sum + combosOfClass(one).length, 0);
      assert.equal(everything, (52 * 51) / 2);
      return [String(everything), String(combosOf('QQ')), String(combosOf('AKs')), String(combosOf('AKo'))];
    },
  },
  {
    where: 'glossary straight — the wheel is legal, the ace does not wrap',
    quote:
      'A-2-3-4-5 (the wheel) is a legal straight and is the weakest one; the ace does not wrap around, so ' +
      'K-A-2-3-4 is not a straight.',
    source: () => glossaryText('straight'),
    expect: () => {
      // The evaluator is verified elsewhere over all 8,192 rank masks.
      const wheel = scoreOf('Ac 2d 3h 4s 5c');
      const sixHigh = scoreOf('2d 3h 4s 5c 6d');
      const wrap = scoreOf('Kc Ad 2h 3s 4c');
      const acePair = scoreOf('Ac Ad 7h 4s 2c');
      assert.ok(wheel > acePair, 'the wheel is a straight, so it beats a pair of aces');
      assert.ok(sixHigh > wheel, 'and it is the weakest straight — six-high beats it');
      assert.ok(wrap < wheel, 'K-A-2-3-4 is not a straight, so it loses to one');
      assert.ok(wrap < acePair, 'K-A-2-3-4 is ace-high and nothing more');
      return [];
    },
  },
  {
    where: 'glossary hand ranking — the fixed order, strongest to weakest',
    quote:
      'straight flush, four of a kind, full house, flush, straight, three of a kind, two pair, one pair, high card',
    source: () => glossaryText('hand-ranking'),
    expect: () => {
      // One hand per category, strictly descending in the glossary's order.
      const ladder = [
        'Ac Kc Qc Jc Tc',
        '9c 9d 9h 9s 2c',
        '8c 8d 8h 3s 3c',
        'Ac Jc 8c 5c 2c',
        '9c 8d 7h 6s 5c',
        '7c 7d 7h 4s 2c',
        'Kc Kd 5h 5s 2c',
        'Ac Ad 9h 6s 3c',
        'Ac Kd 9h 6s 3c',
      ].map(scoreOf);
      for (let i = 1; i < ladder.length; i++) {
        assert.ok(
          (ladder[i - 1] as number) > (ladder[i] as number),
          `rank ${i - 1} must beat rank ${i}: ${ladder[i - 1]} vs ${ladder[i]}`,
        );
      }
      return [];
    },
  },
  {
    where: 'glossary gutshot — half the outs of an open-ended draw',
    quote: 'roughly half the outs of an open-ended draw',
    source: () => glossaryText('gutshot'),
    expect: () => {
      // `scenarios.test.ts` re-derives the two counts. The claim here is their ratio.
      const outsClaimed = (scenarioId: string): number => {
        const scenario = content().scenarios.find((one) => one.id === scenarioId);
        assert.ok(scenario !== undefined, `no scenario "${scenarioId}"`);
        const claim = scenario.expectedInsight.find((one) => one.kind === 'cleanOutsEquals');
        assert.ok(claim !== undefined, `${scenarioId} carries no cleanOutsEquals claim`);
        return claim.outs;
      };
      const gutshot = outsClaimed('fl-gutshot-facing-turn-bet');
      const openEnded = outsClaimed('fl-open-ended-straight-draw-outs');
      assert.equal(gutshot * 2, openEnded, `${gutshot} gutshot outs against ${openEnded} open-ended`);
      return [];
    },
  },
  {
    where: 'scenario fl-board-plays-itself-river — the board is a queen-high straight',
    quote:
      'Those five cards are already a straight, so every player in the hand holds at least a queen-high straight',
    source: () => scenarioText('fl-board-plays-itself-river'),
    expect: () => {
      const scenario = content().scenarios.find((one) => one.id === 'fl-board-plays-itself-river');
      assert.ok(scenario !== undefined);
      const board = scenario.board;
      // Two worthless holdings that score identically means the board plays itself.
      const withRags = evaluate(parseCards(`${board} 2c 3d`));
      const withOtherRags = evaluate(parseCards(`${board} 2h 3s`));
      assert.equal(withRags, withOtherRags, 'the hole cards contribute nothing');
      const straightNoPair = scoreOf('9c 8d 7h 6s 5c');
      const threeOfAKind = scoreOf('7c 7d 7h 4s 2c');
      assert.ok(
        withRags > threeOfAKind,
        'the board alone beats three of a kind, so it is at least a straight',
      );
      assert.ok(withRags > straightNoPair, 'and it is a higher straight than nine-high');
      const withKing = evaluate(parseCards(`${board} Kc 2d`));
      assert.ok(withKing > withRags, 'a king makes the king-high straight the reasoning describes');
      return [];
    },
  },
  {
    where: 'scenario fl-small-straight-beats-trips — a straight outranks three of a kind',
    quote: 'your best five cards are eight-seven-six-five-four, a straight',
    source: () => scenarioText('fl-small-straight-beats-trips'),
    expect: () => {
      const scenario = content().scenarios.find((one) => one.id === 'fl-small-straight-beats-trips');
      assert.ok(scenario !== undefined);
      const hero = scenario.seats.find((seat) => seat.isHero === true);
      assert.ok(hero?.holeCards !== undefined, 'the scenario shows hero its own cards');
      const heroScore = evaluate(parseCards(`${hero.holeCards} ${scenario.board}`));
      const straight = scoreOf('8c 7d 6h 5s 4c');
      const tripAces = scoreOf('Ac Ad Ah 9s 3c');
      assert.equal(heroScore, straight, 'hero holds exactly the eight-high straight the reasoning names');
      assert.ok(heroScore > tripAces, 'a straight is above three of a kind, whatever the trips are');
      return [];
    },
  },
];

const NUMBER_WORDS: readonly string[] = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
];
function wordFor(value: number): string {
  const word = NUMBER_WORDS[value];
  if (word !== undefined) return word;
  if (value === 47) return 'forty-seven';
  if (value === 100) return 'hundred';
  return String(value);
}

/** How many times more hands are needed to shrink the interval to `target` of its width. */
function factorFor(spread: (hands: number) => number, base: number, target: number): number {
  for (const factor of [2, 4, 10, 100, 1_000]) {
    if (Math.abs(spread(100_000 * factor) / base - target) < 1e-6) return factor;
  }
  throw new Error(`no whole-number factor reaches ${target}`);
}

test('every numeric claim the teaching prose makes is reproduced by computation', () => {
  assert.ok(
    TAUGHT_FIGURES.length >= 25,
    `the registry must hold real claims, it holds ${TAUGHT_FIGURES.length}`,
  );
  const problems: string[] = [];
  let derivedValues = 0;

  for (const figure of TAUGHT_FIGURES) {
    const text = figure.source();
    const occurrences = text.split(figure.quote).length - 1;
    if (occurrences !== 1) {
      // An entry that stops matching fails exactly as a wrong figure would.
      problems.push(
        `${figure.where}: the quoted sentence appears ${occurrences} times in the content, expected once. ` +
          'Either the content was reworded (update the quote, having re-checked the maths) or the claim was ' +
          `deleted (delete the entry). Quote: "${figure.quote.slice(0, 90)}…"`,
      );
      continue;
    }
    for (const value of figure.expect()) {
      derivedValues += 1;
      if (!figure.quote.toLowerCase().includes(value.toLowerCase())) {
        problems.push(
          `${figure.where}: the computation produced "${value}", which the content's own sentence does not ` +
            `contain. The content is stating a figure the maths does not support. Quote: "${figure.quote}"`,
        );
      }
    }
  }

  assert.deepEqual(
    problems,
    [],
    `taught figures that do not survive recomputation:\n  - ${problems.join('\n  - ')}`,
  );
  // A sweep of nothing is not a pass. Entries returning [] assert inside `expect` instead.
  assert.ok(
    derivedValues >= 60,
    `expected the registry to match back at least 60 derived values, matched ${derivedValues}`,
  );
  console.log(
    `      ${TAUGHT_FIGURES.length} taught figures recomputed, ${derivedValues} derived values matched back into the prose`,
  );
});

const WORD_VALUES: Readonly<Record<string, number>> = Object.fromEntries([
  ...NUMBER_WORDS.map((word, value) => [word, value] as const),
  ['seventeen', 17],
  ['eighteen', 18],
  ['nineteen', 19],
  ['twenty', 20],
  ['thirty', 30],
  ['forty', 40],
  ['fifty', 50],
  ['sixty', 60],
  ['seventy', 70],
  ['eighty', 80],
  ['ninety', 90],
  ['hundred', 100],
  ['thousand', 1_000],
]);

function numbersIn(text: string): Set<number> {
  const found = new Set<number>();
  for (const match of text.replace(/,(?=\d{3}\b)/g, '').matchAll(/\d+(?:\.\d+)?/g)) {
    found.add(Number(match[0]));
  }
  for (const match of text.toLowerCase().matchAll(/[a-z]+/g)) {
    const value = WORD_VALUES[match[0]];
    if (value !== undefined) found.add(value);
  }
  return found;
}

/** The inputs a learner is told, per kind. `outs` and `equity` take cards, checked in `scenarios.test.ts`. */
const STATED_INPUTS: Readonly<Record<string, readonly string[]>> = {
  potOdds: ['pot', 'toCall'],
  ruleOf24: ['outs', 'cardsToCome'],
  callEv: ['pot', 'toCall', 'equity'],
  foldEquity: ['pot', 'betSize', 'foldProbability', 'equityWhenCalled'],
  spr: ['effectiveStack', 'pot'],
  variance: ['winRateBbPer100', 'standardDeviationBbPer100', 'hands'],
  riskOfRuin: ['bankrollBb', 'winRateBbPer100', 'standardDeviationBbPer100'],
  icm: ['stacks', 'payouts'],
  outs: [],
  equity: [],
};

const FRACTIONAL_INPUTS = new Set(['equity', 'foldProbability', 'equityWhenCalled']);

/**
 * Prose that is the second half of a pair and does not restate the first half's inputs.
 * Each entry must still match its `phrase`, and an exemption that never fires fails the sweep.
 * It excuses only an omitted number. A stated number that disagrees with the graded one still fails.
 */
interface ProseOmission {
  readonly where: string;
  readonly phrase: string;
  readonly omits: readonly string[];
  readonly why: string;
}

const PROSE_OMISSIONS: readonly ProseOmission[] = [
  {
    where: 'lesson expected-value',
    phrase: 'A smaller pot, a bigger bet relative to it',
    omits: ['pot', 'toCall'],
    why: 'the second of a pair, stated as a comparison with the first; the calculator itself shows both inputs',
  },
  {
    where: 'lesson fold-equity',
    phrase: 'The identical bet with the identical cards',
    omits: ['pot', 'betSize', 'foldProbability', 'equityWhenCalled'],
    why: 'the point of the pair is that only a claim about a person changed, so naming the numbers again buries it',
  },
  {
    where: 'lesson sample-size-and-risk-of-ruin',
    phrase: 'Three times the bankroll, with the same edge and the same variance',
    omits: ['bankrollBb', 'standardDeviationBbPer100'],
    why: 'a multiple of the previous calculator rather than a fresh figure',
  },
  {
    where: 'lesson sample-size-and-risk-of-ruin',
    phrase: 'Back to the smaller bankroll, with three times the edge instead',
    omits: ['bankrollBb', 'winRateBbPer100', 'standardDeviationBbPer100'],
    why: 'the same pair again from the other side; the sentence is about the two landing in the same place',
  },
  {
    where: 'lesson variance',
    phrase: 'Compare the width of this interval with the previous one',
    omits: ['winRateBbPer100', 'standardDeviationBbPer100', 'hands'],
    why: 'the second of a pair; the sentence is about how the interval narrows, not about the inputs',
  },
  {
    where: 'lesson rule-of-2-and-4',
    phrase: 'The same draw with two cards to come',
    omits: ['outs'],
    why: 'the same draw as the calculator above it, whose caption names it as a flush draw',
  },
  {
    where: 'quiz quiz-fold-equity/fold-equity-q3',
    phrase: 'Identical spot and identical cards',
    omits: ['betSize', 'equityWhenCalled'],
    why: 'the prompt states the one input that changed and says the rest are unchanged',
  },
  {
    where: 'quiz quiz-sample-size-and-risk-of-ruin/ror-q3',
    phrase: 'Same edge and same standard deviation',
    omits: ['standardDeviationBbPer100'],
    why: 'the prompt states the one input that changed and says the rest are unchanged',
  },
];

/** Out counts a caption states in words. Each is checked against the graded value, not excused. */
const OUTS_IN_WORDS: readonly { readonly phrase: string; readonly outs: number }[] = [
  { phrase: 'A flush draw with one card left to come', outs: 9 },
  { phrase: 'A large combined draw', outs: 15 },
];

/** Catches "the rule of 4" over a `cardsToCome: 1` calculation, a wrong multiplier with every digit right. */
function cardsToComeStatedIn(prose: string): 1 | 2 | null {
  const twoCards =
    /two cards to come|both the turn and the river|rule of 4|times four|multiply the outs by four/i;
  // "rule of 2 and 4" is the shortcut's name and marks neither branch.
  const oneCard = /one card (left )?to come|only the river is to come/i;
  if (twoCards.test(prose) && !oneCard.test(prose)) return 2;
  if (oneCard.test(prose) && !twoCards.test(prose)) return 1;
  return null;
}

test('every quiz prompt and lesson caption states the numbers its calculation is actually given', () => {
  const problems: string[] = [];
  const exemptionsUsed = new Map<string, number>();
  let checked = 0;
  let inputsCompared = 0;

  const check = (where: string, prose: string, calculation: Record<string, unknown>): void => {
    const kind = String(calculation['kind']);
    const wanted = STATED_INPUTS[kind];
    if (wanted === undefined) {
      problems.push(`${where}: unknown calculation kind "${kind}" — this sweep must be taught about it`);
      return;
    }
    checked += 1;
    const stated = numbersIn(prose);
    if (stated.size === 0) {
      exemptionsUsed.set(
        'no numbers stated at all',
        (exemptionsUsed.get('no numbers stated at all') ?? 0) + 1,
      );
      return;
    }
    const wordedOuts = OUTS_IN_WORDS.find((one) => prose.includes(one.phrase));
    const omission = PROSE_OMISSIONS.find((one) => one.where === where && prose.includes(one.phrase));

    for (const key of wanted) {
      const raw = calculation[key];
      const values = Array.isArray(raw) ? (raw as number[]) : [raw as number | undefined];
      for (const value of values) {
        if (typeof value !== 'number') continue;
        inputsCompared += 1;

        if (kind === 'ruleOf24' && key === 'cardsToCome') {
          const said = cardsToComeStatedIn(prose);
          if (said === null) {
            problems.push(
              `${where}: a rule-of-2-and-4 calculation whose prose names neither one card nor two to come`,
            );
          } else if (said !== value) {
            problems.push(
              `${where}: the prose describes ${said} card(s) to come and the app grades ${value}. ` +
                'That is the multiplier itself, so the lesson and the answer would teach opposite things.',
            );
          }
          continue;
        }

        const target = FRACTIONAL_INPUTS.has(key) ? Math.round(value * 100) : value;
        if (stated.has(target)) continue;

        if (wordedOuts !== undefined && key === 'outs') {
          if (wordedOuts.outs !== value) {
            problems.push(
              `${where}: the caption says "${wordedOuts.phrase}", which this sweep reads as ` +
                `${wordedOuts.outs} outs, but the calculation is graded on ${value}`,
            );
          }
          exemptionsUsed.set(wordedOuts.phrase, (exemptionsUsed.get(wordedOuts.phrase) ?? 0) + 1);
          continue;
        }
        if (omission?.omits.includes(key)) {
          exemptionsUsed.set(omission.phrase, (exemptionsUsed.get(omission.phrase) ?? 0) + 1);
          continue;
        }
        problems.push(
          `${where}: ${kind}.${key} is graded as ${value}` +
            `${FRACTIONAL_INPUTS.has(key) ? ` (${target}%)` : ''}, and the prose a learner reads never says so. ` +
            `Numbers in the prose: ${[...stated].sort((a, b) => a - b).join(', ')}`,
        );
      }
    }
  };

  for (const lesson of content().lessons) {
    for (const block of lesson.blocks) {
      if (block.kind !== 'liveCalculation') continue;
      check(`lesson ${lesson.id}`, block.caption, block.calculation as unknown as Record<string, unknown>);
    }
  }
  for (const quiz of content().quizzes) {
    for (const question of quiz.questions) {
      if (question.kind !== 'numeric') continue;
      check(
        `quiz ${quiz.id}/${question.id}`,
        `${question.prompt}\n${question.explanation}`,
        question.calculation as unknown as Record<string, unknown>,
      );
    }
  }

  assert.deepEqual(problems, [], `prose that disagrees with what is graded:\n  - ${problems.join('\n  - ')}`);

  // The sweep must read a real corpus, and every exemption must still fire.
  assert.ok(checked >= 60, `expected to sweep every live calculation and numeric question, swept ${checked}`);
  assert.ok(
    inputsCompared >= 100,
    `expected to compare a hundred or more graded inputs, compared ${inputsCompared}`,
  );
  for (const worded of OUTS_IN_WORDS) {
    assert.ok(
      (exemptionsUsed.get(worded.phrase) ?? 0) > 0,
      `nothing in the content still says "${worded.phrase}" — delete the exemption rather than leaving it armed`,
    );
  }
  for (const omission of PROSE_OMISSIONS) {
    assert.ok(
      (exemptionsUsed.get(omission.phrase) ?? 0) > 0,
      `the exemption for "${omission.phrase}" (${omission.where}) fired for nothing. Either the prose now ` +
        'states those inputs — in which case delete the entry — or it was reworded and the exemption is ' +
        'silently covering text nobody has read.',
    );
  }
  console.log(
    `      ${checked} calculations swept, ${inputsCompared} graded inputs compared against the prose ` +
      `(${[...exemptionsUsed].map(([reason, n]) => `${reason} x${n}`).join(', ')})`,
  );
});

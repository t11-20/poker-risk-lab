/**
 * The test that keeps the teaching material honest.
 *
 * Content stores situations, never answers (ADR 0006). This suite computes the answers
 * with the real maths and checks that every scenario's stated teaching point actually
 * holds. A scenario whose claim stops being true fails the build here, rather than
 * quietly misleading a learner.
 *
 * It also checks the things a schema cannot: that a scenario is *playable* (the cards are
 * legal and distinct, the board matches the street, the pot arithmetic is coherent), that
 * every range parses under the real grammar, and that the set as a whole covers the
 * syllabus rather than clustering on one topic.
 *
 * Runtime note: equity for a range-vs-hand spot is enumerated exactly where it fits and
 * sampled otherwise, and a scenario set of this size means a few thousand equity runs. The
 * sample count is kept modest here for that reason and stated in the assertions that
 * depend on it.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCards } from '@prl/poker-engine';
import {
  computeOuts,
  evOfBet,
  evOfCall,
  exactRange,
  potOdds,
  projectResults,
  requiredFoldEquity,
  riskOfRuin,
  ruleOf24,
  stackToPotRatio,
} from '@prl/poker-math';
import { collectContentProblems, content, contentStats, readRawContent } from '../src/index.ts';
import {
  analyseScenario,
  checkScenarioClaims,
  describeAnalysis,
  readSituation,
} from '../src/scenario-analysis.ts';

const SAMPLES = 20_000;
const SEED = 20260817;

test('the content bundle loads and validates', () => {
  const problems = collectContentProblems(readRawContent());
  assert.deepEqual(problems, [], `content validation failed:\n  - ${problems.join('\n  - ')}`);
});

test('the content set is substantial enough to teach with', () => {
  const stats = contentStats();
  console.log(
    `      ${stats.lessons} lessons, ${stats.quizzes} quizzes (${stats.quizQuestions} questions), ` +
      `${stats.scenarios} scenarios, ${stats.glossaryTerms} glossary terms, ${stats.topicsCovered} topics`,
  );
  // 30+ scenarios is the stated deliverable; the rest are floors that would catch a
  // content file failing to load rather than aspirations.
  assert.ok(stats.scenarios >= 30, `expected at least 30 scenarios, found ${stats.scenarios}`);
  assert.ok(stats.lessons >= 12, `expected at least 12 lessons, found ${stats.lessons}`);
  assert.ok(stats.glossaryTerms >= 45, `expected at least 45 glossary terms, found ${stats.glossaryTerms}`);
  assert.ok(stats.quizQuestions >= 30, `expected at least 30 quiz questions, found ${stats.quizQuestions}`);
  assert.ok(stats.topicsCovered >= 8, `expected at least 8 topics covered, found ${stats.topicsCovered}`);
});

test('every scenario is playable: legal distinct cards, board matches street, coherent pot', () => {
  for (const scenario of content().scenarios) {
    const situation = readSituation(scenario);

    // The validator already checks these, but re-asserting here means a regression shows
    // up as "scenario X is unplayable" rather than as a confusing equity failure later.
    assert.equal(situation.heroCards.length, 2, `${scenario.id}: hero must hold 2 cards`);
    const expectedBoard = { preflop: 0, flop: 3, turn: 4, river: 5 }[scenario.street];
    assert.equal(
      situation.board.length,
      expectedBoard,
      `${scenario.id}: board length wrong for ${scenario.street}`,
    );

    const known = [...situation.heroCards, ...situation.board];
    assert.equal(new Set(known).size, known.length, `${scenario.id}: duplicate card between hero and board`);

    assert.ok(situation.pot >= 0, `${scenario.id}: negative pot`);
    assert.ok(situation.toCall >= 0, `${scenario.id}: negative toCall`);
    assert.ok(situation.heroStack > 0, `${scenario.id}: hero has no chips`);
    assert.ok(situation.opponentStacks.length >= 1, `${scenario.id}: no opponents`);

    // A facing bet with nothing in the pot, or a price of zero while describing a bet,
    // means the situation text and the numbers disagree.
    if (situation.toCall > 0) {
      assert.ok(
        situation.pot > 0,
        `${scenario.id}: hero is facing a bet of ${situation.toCall} into an empty pot`,
      );
    }

    // The opponent's range must contain at least one hand hero does not block.
    assert.ok(
      situation.opponentRange.combos.length > 0,
      `${scenario.id}: the opponent range is empty once hero's cards and the board are removed`,
    );
  }
});

test('every scenario range parses under the real grammar', () => {
  // The range grammar deliberately REJECTS ambiguous notation ("T9s+", "AK+"). A scenario
  // written with one of those would throw here rather than silently meaning something the
  // author did not intend.
  for (const scenario of content().scenarios) {
    assert.doesNotThrow(
      () => readSituation(scenario),
      `${scenario.id}: range "${JSON.stringify(scenario.opponentRange)}" did not parse`,
    );
  }
});

test('CLAIMS: every scenario teaching point is verified against the computed maths', () => {
  const scenarios = content().scenarios;
  const failures: string[] = [];
  let verificationClaims = 0;
  let regressionClaims = 0;
  let scenariosWithClaims = 0;

  for (const scenario of scenarios) {
    if (scenario.expectedInsight.length === 0) continue;
    scenariosWithClaims += 1;

    const analysis = analyseScenario(scenario, { samples: SAMPLES, seed: SEED });
    const results = checkScenarioClaims(scenario, analysis);

    for (const result of results) {
      if (result.strength === 'verification') verificationClaims += 1;
      else regressionClaims += 1;

      if (!result.passed) {
        failures.push(
          `${scenario.id} [${result.kind}] ${result.detail}\n` +
            `      computed: ${result.actual}\n` +
            `      situation: ${describeAnalysis(analysis)}`,
        );
      }
    }
  }

  console.log(
    `      ${scenariosWithClaims}/${scenarios.length} scenarios carry claims: ` +
      `${verificationClaims} independent verification, ${regressionClaims} regression locks`,
  );

  assert.deepEqual(
    failures,
    [],
    `${failures.length} scenario claim(s) are not supported by the maths:\n\n${failures.join('\n\n')}`,
  );
  // A suite that verified nothing would pass silently, which is the failure mode worth
  // guarding against in a test whose whole purpose is verification.
  assert.ok(
    verificationClaims >= 20,
    `only ${verificationClaims} independent claims — the set should assert more`,
  );
});

test('scenario analysis is deterministic for a given seed', () => {
  // Reproducibility matters here beyond tidiness: a teaching scenario must show every
  // learner the same numbers, and a flaky claim check would be worse than no check.
  const scenario = content().scenarios[0];
  assert.ok(scenario !== undefined);
  const first = analyseScenario(scenario, { samples: 5_000, seed: 42 });
  const second = analyseScenario(scenario, { samples: 5_000, seed: 42 });
  assert.equal(first.heroEquity, second.heroEquity);
  assert.equal(first.callEv, second.callEv);
  assert.equal(first.spr, second.spr);
  assert.equal(first.outs?.cleanCount, second.outs?.cleanCount);
});

test('scenarios span the syllabus rather than clustering on one topic', () => {
  const byTopic = new Map<string, number>();
  const byDifficulty = new Map<string, number>();
  for (const scenario of content().scenarios) {
    byTopic.set(scenario.topic, (byTopic.get(scenario.topic) ?? 0) + 1);
    byDifficulty.set(scenario.difficulty, (byDifficulty.get(scenario.difficulty) ?? 0) + 1);
  }
  console.log(
    `      topics: ${[...byTopic.entries()].map(([topic, count]) => `${topic}=${count}`).join(', ')}`,
  );
  console.log(
    `      difficulty: ${[...byDifficulty.entries()].map(([level, count]) => `${level}=${count}`).join(', ')}`,
  );
  assert.ok(byTopic.size >= 6, `scenarios cover only ${byTopic.size} topics`);
  // No single topic should dominate — a set that is 80% pot odds is not a syllabus.
  const largest = Math.max(...byTopic.values());
  assert.ok(
    largest <= content().scenarios.length * 0.4,
    `one topic accounts for ${largest} of ${content().scenarios.length} scenarios`,
  );
  assert.ok(byDifficulty.size >= 2, 'scenarios should span more than one difficulty');
});

test('no scenario states a computed figure as prose fact', () => {
  // ADR 0006: prose describes relationships, not computed numbers. A percentage in the
  // reasoning is almost always a hard-coded equity that will drift out of step with the
  // maths. Explicitly labelled approximations are allowed, since the rule of 2 and 4 is
  // itself a lesson.
  const allowed = /(?:roughly|about|approximately|around|rule of|order of|near(?:ly)?|circa|ballpark)/i;
  const offenders: string[] = [];
  for (const scenario of content().scenarios) {
    const prose = [scenario.reasoning, ...scenario.commonMistakes, ...scenario.assumptions].join(' ');
    // Percentages, and "x in y" style odds statements.
    for (const match of prose.matchAll(/(\d+(?:\.\d+)?)\s*%/g)) {
      const start = Math.max(0, (match.index ?? 0) - 60);
      const context = prose.slice(start, (match.index ?? 0) + 20);
      if (!allowed.test(context)) {
        offenders.push(`${scenario.id}: "${match[0]}" in "...${context.trim()}..."`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these scenarios state a percentage as fact rather than computing it:\n  - ${offenders.join('\n  - ')}`,
  );
});

test('no lesson or quiz states a computed figure as prose fact', () => {
  const allowed =
    /(?:roughly|about|approximately|around|rule of|order of|near(?:ly)?|circa|ballpark|for example|say)/i;
  const offenders: string[] = [];
  const check = (where: string, text: string): void => {
    for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*%/g)) {
      const start = Math.max(0, (match.index ?? 0) - 60);
      const context = text.slice(start, (match.index ?? 0) + 20);
      if (!allowed.test(context)) offenders.push(`${where}: "${match[0]}" in "...${context.trim()}..."`);
    }
  };
  for (const lesson of content().lessons) {
    for (const [index, block] of lesson.blocks.entries()) {
      if (block.kind === 'prose' || block.kind === 'heading')
        check(`lesson ${lesson.id} block ${index}`, block.text);
      if (block.kind === 'callout')
        check(`lesson ${lesson.id} block ${index}`, `${block.title} ${block.text}`);
      if (block.kind === 'list') check(`lesson ${lesson.id} block ${index}`, block.items.join(' '));
      if (block.kind === 'formula') check(`lesson ${lesson.id} block ${index}`, block.explanation);
    }
    for (const takeaway of lesson.keyTakeaways) check(`lesson ${lesson.id} takeaway`, takeaway);
  }
  for (const quiz of content().quizzes) {
    for (const question of quiz.questions) {
      // A numeric question must NOT contain its own answer.
      check(`quiz ${quiz.id} question ${question.id}`, question.prompt);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these state a percentage as fact rather than computing it:\n  - ${offenders.join('\n  - ')}`,
  );
});

test('content contains no gambling or dark-pattern language', () => {
  // PRODUCT-GUARDRAILS §1 and §2, checked mechanically. A phrase list is crude, but it
  // catches the drift that matters: content that starts talking about money or streaks.
  const banned: readonly { readonly pattern: RegExp; readonly why: string }[] = [
    { pattern: /\breal money\b/i, why: 'implies real-money play' },
    { pattern: /\bcash ?out\b|\bwithdraw(?:al)?\b|\bdeposit\b/i, why: 'implies a money transfer' },
    { pattern: /\$\d|\b(?:usd|eur|gbp)\b/i, why: 'uses a currency' },
    { pattern: /\bwin ?streak\b|\bdaily (?:bonus|reward)\b/i, why: 'streak or login-reward mechanic' },
    {
      pattern: /\bguaranteed (?:win|profit)\b|\bcan'?t lose\b|\bsure thing\b/i,
      why: 'guarantees an outcome',
    },
    { pattern: /\byou'?re due\b|\bdue for a win\b|\bwin it back\b/i, why: 'loss-chasing framing' },
    { pattern: /\b(?:the )?(?:correct|optimal|right) play\b/i, why: 'claims a uniquely correct play' },
    { pattern: /\bGTO[- ]approved\b|\bsolved\b/i, why: 'overstates certainty' },
  ];
  const offenders: string[] = [];
  const scan = (where: string, text: string): void => {
    for (const { pattern, why } of banned) {
      if (pattern.test(text)) offenders.push(`${where}: ${why} — ${JSON.stringify(text.slice(0, 100))}`);
    }
  };

  for (const scenario of content().scenarios) {
    scan(`scenario ${scenario.id} reasoning`, scenario.reasoning);
    scan(`scenario ${scenario.id} question`, scenario.question);
    for (const mistake of scenario.commonMistakes) scan(`scenario ${scenario.id} mistake`, mistake);
  }
  for (const lesson of content().lessons) {
    for (const takeaway of lesson.keyTakeaways) scan(`lesson ${lesson.id} takeaway`, takeaway);
    for (const block of lesson.blocks) {
      if (block.kind === 'prose') scan(`lesson ${lesson.id}`, block.text);
      if (block.kind === 'callout') scan(`lesson ${lesson.id} callout`, block.text);
    }
  }
  for (const quiz of content().quizzes) {
    scan(`quiz ${quiz.id} advice`, quiz.reviewAdvice);
    for (const question of quiz.questions) scan(`quiz ${quiz.id} explanation`, question.explanation);
  }
  for (const entry of content().glossary) scan(`glossary ${entry.id}`, entry.definition);

  assert.deepEqual(offenders, [], `guardrail violations in content:\n  - ${offenders.join('\n  - ')}`);
});

test('quizzes have no score threshold or pass/fail language', () => {
  // PRODUCT-GUARDRAILS §2: quizzes surface reasoning, they do not gate progress.
  const banned =
    /\b(?:pass(?:ing)? (?:mark|score|grade)|fail(?:ed|ing)?|you scored|out of \d+ correct|\d+% to pass)\b/i;
  const offenders: string[] = [];
  for (const quiz of content().quizzes) {
    if (banned.test(quiz.reviewAdvice)) offenders.push(`${quiz.id} reviewAdvice`);
    for (const question of quiz.questions) {
      if (banned.test(question.explanation)) offenders.push(`${quiz.id}/${question.id} explanation`);
    }
  }
  assert.deepEqual(offenders, [], `pass/fail language found in: ${offenders.join(', ')}`);
});

test('the tournament lesson computes ICM for the learner', () => {
  const lesson = content().lessons.find((entry) => entry.id === 'tournament-chips-and-icm');
  assert.ok(lesson, 'the tournament lesson exists');
  const icmBlocks = lesson.blocks.filter(
    (block) => block.kind === 'liveCalculation' && block.calculation.kind === 'icm',
  );
  assert.ok(icmBlocks.length >= 1, 'the lesson must embed a live ICM calculation, not only prose');
  const quiz = content().quizzes.find((entry) => entry.id === 'quiz-tournament-chips-and-icm');
  assert.ok(quiz);
  const numeric = quiz.questions.filter(
    (question) => question.kind === 'numeric' && question.calculation.kind === 'icm',
  );
  assert.ok(numeric.length >= 1, 'the tournament quiz must grade a computed ICM figure');
});

test('numeric quiz questions ask for a field their calculation can actually produce', () => {
  // A mismatch here is invisible until a learner opens the quiz and the app cannot compute
  // an expected answer, so it is worth pinning down at build time.
  //
  // The valid field names are DERIVED by actually running each calculation and reading the
  // keys off the result, rather than maintained as a hand-written list. A hand-written list
  // is a second place for the truth to live, and it drifted the first time this test ran:
  // it claimed `outs` produced `cleanOuts` when the real field is `cleanCount`, so the test
  // failed on correct content. Deriving it means the test cannot be wrong about the API.
  const heroCards = parseCards('Ah Kh');
  const board = parseCards('Qh 7h 2c');
  const numericKeys = (value: object): readonly string[] =>
    Object.entries(value)
      .filter(([, v]) => typeof v === 'number')
      .map(([k]) => k);

  const validFields: Readonly<Record<string, readonly string[]>> = {
    potOdds: numericKeys(potOdds(100, 50)),
    ruleOf24: numericKeys(ruleOf24(9, 2)),
    callEv: numericKeys(evOfCall({ pot: 100, toCall: 50, equity: 0.4 })),
    spr: numericKeys(stackToPotRatio(300, 100)),
    foldEquity: [
      ...numericKeys(evOfBet({ pot: 100, betSize: 50, foldProbability: 0.4, equityWhenCalled: 0.3 })),
      ...numericKeys(requiredFoldEquity({ pot: 100, betSize: 50, equityWhenCalled: 0.3 })),
    ],
    variance: numericKeys(
      projectResults({ hands: 10_000, winRateBbPer100: 5, standardDeviationBbPer100: 90 }),
    ),
    riskOfRuin: numericKeys(
      riskOfRuin({ bankrollBb: 500, winRateBbPer100: 5, standardDeviationBbPer100: 90 }),
    ),
    // `equity` returns players in an array, so the learner-facing scalar is named here.
    equity: ['heroEquity', 'trials'],
    outs: numericKeys(computeOuts({ heroCards, board, opponent: exactRange(parseCards('Qs Qd')) })),
    // `icmEquity` returns per-player prizes in an array. The quiz grades the chip leader's
    // share of the prize pool, which the Learn/API resolvers name `chipLeaderShare`.
    icm: ['chipLeaderShare'],
  };
  const offenders: string[] = [];
  for (const quiz of content().quizzes) {
    for (const question of quiz.questions) {
      if (question.kind !== 'numeric') continue;
      const allowed = validFields[question.calculation.kind];
      if (allowed === undefined) {
        offenders.push(`${quiz.id}/${question.id}: unknown calculation kind "${question.calculation.kind}"`);
        continue;
      }
      if (!allowed.includes(question.field)) {
        offenders.push(
          `${quiz.id}/${question.id}: field "${question.field}" is not produced by ` +
            `"${question.calculation.kind}" (valid: ${allowed.join(', ')})`,
        );
      }
      if (question.tolerance <= 0) {
        offenders.push(`${quiz.id}/${question.id}: tolerance must be positive`);
      }
    }
  }
  assert.deepEqual(offenders, [], `numeric question problems:\n  - ${offenders.join('\n  - ')}`);
});

test('a scenario with an impossible card set is rejected rather than analysed', () => {
  // Proves the guard can fail. A validation suite that only ever sees good input is not
  // evidence of anything.
  const good = content().scenarios[0];
  assert.ok(good !== undefined);
  const hero = good.seats.find((seat) => seat.isHero === true);
  assert.ok(hero !== undefined);
  const broken = {
    ...good,
    // Give hero a card that is already on the board, if there is a board; otherwise
    // duplicate hero's own card.
    seats: good.seats.map((seat) =>
      seat.isHero === true
        ? {
            ...seat,
            holeCards:
              good.board !== ''
                ? `${good.board.split(/\s+/)[0]}${hero.holeCards?.slice(-2) ?? 'Ah'}`
                : 'AhAh',
          }
        : seat,
    ),
  };
  assert.throws(() => {
    const situation = readSituation(broken);
    const cards = [...situation.heroCards, ...situation.board];
    if (new Set(cards).size !== cards.length) throw new Error('duplicate card');
  }, /duplicate|not a valid card|twice/i);
});

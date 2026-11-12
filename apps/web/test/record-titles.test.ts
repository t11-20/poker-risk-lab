/**
 * `/record` names what a learner did in words, and links back to it.
 *
 * ## The failure this is written against
 *
 * Measured by the audit at 308fadf on `/record`: "Scenarios tried" listed
 * `eq-flush-draw-turn-small-bet`, "Topics touched" listed `positions-and-blinds`, both unlinked, and
 * the units reset said "back to 1000" where every other surface says "1,000 units". The page joined
 * the raw arrays from `GET /me/progress` with commas and rendered them.
 *
 * The ids below are real ones from the content bundle, not invented, so a renamed scenario breaks
 * this file instead of passing over a title nobody checked.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import type { ProgressResponse } from '@prl/contracts';
import { recordLists } from '../src/lib/record-links.ts';

const progress: ProgressResponse = {
  lessonsCompleted: ['position-basics'],
  scenariosAttempted: ['eq-flush-draw-turn-small-bet', 'retired-scenario-id'],
  quizQuestionsAnswered: 0,
  handsPlayed: 0,
  unitsNetLifetime: 0,
  topicsTouched: ['pot-odds-and-ev', 'positions-and-blinds', 'a-topic-this-build-has-never-heard-of'],
};

describe('the record lists', () => {
  const lists = recordLists(progress);

  it('give a scenario its title and a link to it in the Lab (REGRESSION)', () => {
    assert.deepEqual(lists.scenarios[0], {
      label: 'Flush draw facing a small bet',
      href: '/lab/eq-flush-draw-turn-small-bet',
    });
  });

  it('give a lesson its title and a link to it (REGRESSION)', () => {
    assert.deepEqual(lists.lessons[0], {
      label: 'Position: the value of acting last',
      href: '/learn/position-basics',
    });
  });

  it('give a topic its name, not its slug (REGRESSION)', () => {
    assert.deepEqual(
      lists.topics.slice(0, 2).map((topic) => topic.label),
      ['Pot odds and EV', 'Position and the blinds'],
    );
    assert.ok(
      lists.topics.every((topic) => topic.href === null),
      'a topic has no page of its own',
    );
  });

  it('print an id the bundle does not carry as itself, and link it nowhere', () => {
    assert.deepEqual(lists.scenarios[1], { label: 'retired-scenario-id', href: null });
    assert.deepEqual(lists.topics[2], { label: 'a-topic-this-build-has-never-heard-of', href: null });
  });

  it('keep the order the API sent', () => {
    assert.deepEqual(
      recordLists({
        ...progress,
        scenariosAttempted: ['retired-scenario-id', 'eq-flush-draw-turn-small-bet'],
      }).scenarios.map((entry) => entry.href),
      [null, '/lab/eq-flush-draw-turn-small-bet'],
    );
  });
});

describe('the record page', () => {
  const page = readFileSync(new URL('../src/app/record/page.tsx', import.meta.url), 'utf8');
  const reset = readFileSync(new URL('../src/app/record/UnitsReset.tsx', import.meta.url), 'utf8');

  it('renders the resolved lists, not the raw arrays joined with commas (REGRESSION)', () => {
    assert.doesNotMatch(page, /\.join\(', '\)/u);
    assert.match(page, /recordLists\(record\.progress\)/u);
  });

  it('formats the reset amount the way every other surface does (REGRESSION)', () => {
    assert.doesNotMatch(reset, /String\(reset\.units\)/u);
    assert.match(reset, /formatUnits\(reset\.units\)/u);
  });
});

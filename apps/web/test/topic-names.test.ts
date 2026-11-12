/**
 * A topic has one name on every screen.
 *
 * The Lab's filter and chips called `positions-and-blinds` "Positions and blinds"; Learn, the lesson
 * eyebrow and the glossary called it "Position and the blinds" (UX audit at 6b3886e, Minor 4). Each
 * screen had its own map, so nothing made them agree. Both now read `TOPIC_LABELS` in
 * `@prl/contracts`, and this compares what the two web helpers actually return for every topic.
 *
 * Negative control: the old `lab-labels.ts` put back fails "agree on every topic" on
 * `positions-and-blinds`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TOPIC_LABELS, TOPICS } from '@prl/contracts';
import { topicLabel as labTopicLabel } from '../src/lib/lab-labels.ts';
import { topicLabel as learnTopicLabel } from '../src/lib/learn-curriculum.ts';

describe('topic names', () => {
  it('reads every topic, so this cannot pass over an empty list', () => {
    assert.ok(TOPICS.length > 5);
  });

  it('agree on every topic between the Lab and Learn', () => {
    for (const topic of TOPICS) {
      assert.equal(labTopicLabel(topic), learnTopicLabel(topic), `${topic} has two names`);
      assert.equal(learnTopicLabel(topic), TOPIC_LABELS[topic]);
    }
  });

  it('is "Position and the blinds", the name the curriculum and the glossary use', () => {
    assert.equal(labTopicLabel('positions-and-blinds'), 'Position and the blinds');
  });

  it('still reads a topic this build has never heard of', () => {
    assert.equal(labTopicLabel('pot-geometry'), 'Pot geometry');
  });
});

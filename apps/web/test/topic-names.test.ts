/**
 * A topic has one name on every screen. The Lab and Learn each had their own map; both now read
 * `TOPIC_LABELS` in `@prl/contracts`, and this compares what the two web helpers return.
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

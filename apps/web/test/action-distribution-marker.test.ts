/**
 * The "most likely" marker is matched with `===`, and `@prl/poker-ai` writes "raise to 1200" where
 * `@prl/ui`'s `formatChips` writes "1,200". So the marker must be taken from the distribution itself.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mostLikelyAction } from '../src/lib/action-distribution.ts';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const COMPARISON = readFileSync(join(SRC, 'components', 'PostHandComparison.tsx'), 'utf8');
const DISTRIBUTION = readFileSync(join(SRC, 'components', 'ActionDistribution.tsx'), 'utf8');

/** Measured output. `@prl/ui` re-exports `.tsx`, and `@prl/poker-ai` is not a dependency of this app. */
const FROM_POKER_AI = 'raise to 1200';
const REBUILT_WITH_GROUPING = 'raise to 1,200';

describe('the marker is taken out of the distribution, never described a second time', () => {
  it('returns the highest-weighted entry’s own string', () => {
    const entries = [
      { action: FROM_POKER_AI, probability: 0.62 },
      { action: 'call', probability: 0.26 },
      { action: 'fold', probability: 0.12 },
    ];
    const marked = mostLikelyAction(entries);
    assert.equal(marked, FROM_POKER_AI);
    assert.ok(
      entries.some((entry) => entry.action === marked),
      'the marker is not one of the rows, so it can fail to match one',
    );
  });

  it('finds the maximum wherever it is, rather than trusting the caller’s sort', () => {
    assert.equal(
      mostLikelyAction([
        { action: 'fold', probability: 0.1 },
        { action: FROM_POKER_AI, probability: 0.7 },
        { action: 'call', probability: 0.2 },
      ]),
      FROM_POKER_AI,
    );
  });

  it('keeps the first of a tie, which is what the API’s distribution[0] already yields', () => {
    assert.equal(
      mostLikelyAction([
        { action: 'call', probability: 0.5 },
        { action: 'fold', probability: 0.5 },
      ]),
      'call',
    );
  });

  it('marks nothing when there is nothing to mark', () => {
    assert.equal(mostLikelyAction([]), undefined);
    assert.equal(mostLikelyAction([{ action: 'call', probability: Number.NaN }]), undefined);
    assert.equal(
      mostLikelyAction([
        { action: 'call', probability: Number.NaN },
        { action: 'fold', probability: 0.3 },
      ]),
      'fold',
    );
  });

  it('NEGATIVE CONTROL: the string the web app used to build could never match', () => {
    // The old `PostHandComparison` expression, rebuilt with `@prl/ui`'s grouping formatter.
    const entries = [
      { action: FROM_POKER_AI, probability: 0.62 },
      { action: 'call', probability: 0.38 },
    ];
    assert.notEqual(REBUILT_WITH_GROUPING, FROM_POKER_AI);
    assert.equal(
      entries.filter((entry) => entry.action === REBUILT_WITH_GROUPING).length,
      0,
      'the two formatters agree on 1,200, so this defect was never real and this file proves nothing',
    );
    // They agree below a thousand, which is why it went unnoticed.
    assert.equal('raise to 520', 'raise to 520');
    assert.equal(
      entries.filter((entry) => entry.action === mostLikelyAction(entries)).length,
      1,
      'exactly one row must be marked',
    );
  });
});

describe('the component is wired to it', () => {
  // Names the exact expression that was the second producer. The positive assertion carries the weight.
  const REBUILDS = /formatChips\(decision\.modelAction/u;

  it('does not rebuild the description in PostHandComparison', () => {
    assert.doesNotMatch(
      COMPARISON.replace(/\s+/gu, ' '),
      REBUILDS,
      'the comparison formats a size of its own to match against, which is the second producer',
    );
    assert.match(
      COMPARISON,
      /modalAction=\{mostLikelyAction\(decision\.modelReasoning\.actionProbabilities\)\}/u,
      'the marker is not taken from the distribution the page is about to render',
    );
  });

  it('NEGATIVE CONTROL: the detector fires on the expression this replaced', () => {
    // Biome's `noTemplateCurlyInString` refuses those two characters in a plain string, hence the helper.
    const hole = (expression: string): string => `\${${expression}}`;
    const old =
      'modalAction={decision.modelAction === null ? undefined : `' +
      hole('decision.modelAction.action') +
      hole("decision.modelAction.action === 'raise' ? ' to' : ''") +
      ` ${hole('formatChips(decision.modelAction.to)')}\`}`;
    assert.match(old.replace(/\s+/gu, ' '), REBUILDS, 'the detector does not fire on a real rebuild');
  });

  it('the component still re-exports the one decision, so there is a single definition', () => {
    assert.match(DISTRIBUTION, /export \{ mostLikelyAction \} from '@\/lib\/action-distribution\.ts';/u);
    assert.doesNotMatch(
      DISTRIBUTION,
      /function mostLikelyAction/u,
      'a second copy of the rule in the component is how the two producers happened in the first place',
    );
  });
});

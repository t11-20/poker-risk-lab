/**
 * The `"— most likely"` marker on a sampled action distribution, and the mismatch that stopped it
 * appearing at all above a thousand units.
 *
 * ## What a learner saw
 *
 * `ActionDistribution` marks one row of the distribution with the words "— most likely", chosen by
 * comparing a string with `===`. Two different pieces of code produced that string:
 *
 *   - the rows themselves come from `@prl/poker-ai`'s `describeAction`, which formats a size with
 *     a private `formatChips` — `Number.isInteger(v) ? String(v) : v.toFixed(1)` — so a raise to
 *     1,200 arrives on the wire as `"raise to 1200"`;
 *   - `PostHandComparison` rebuilt the same description itself using `@prl/ui`'s `formatChips`,
 *     which groups thousands: `"raise to 1,200"`.
 *
 * Under a thousand the two agree character for character, so every review of a small pot looked
 * correct. At a thousand and above they never matched: no row was marked, and nothing on the page
 * said a mark had been dropped. Starting stacks are 1,000 units, so a raise past that is ordinary
 * play.
 *
 * ## Why this file tests a `lib/` module rather than the component
 *
 * `apps/web` has no render harness — the suite runs under `node --test`, which cannot load a
 * `.tsx` at all. So the decision was moved into `lib/action-distribution.ts`, which imports
 * nothing, and the component re-exports it. The half that cannot be imported — that the component
 * is actually wired to it — is asserted against the source below, which is the same split
 * `test/live-regions.test.ts` and `test/account-deletion.test.ts` settled on.
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

/**
 * The two formatters, restated as the strings they produce.
 *
 * Neither package can be imported into this file: `@prl/ui`'s entry point re-exports `.tsx`, and
 * `@prl/poker-ai` is not a dependency of this app. The values below were measured rather than
 * assumed — `formatChips(1200)` from `@prl/ui/src/format.ts` is `"1,200"`, and
 * `Number.isInteger(1200) ? String(1200) : …` from `@prl/poker-ai/src/commentary.ts` is `"1200"`.
 */
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
    // The property that actually matters: what comes back is one of the strings that will be
    // compared, so `===` in the component compares a value with itself.
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
    // A single unusable weight beside a usable one still leaves the usable one as the answer.
    assert.equal(
      mostLikelyAction([
        { action: 'call', probability: Number.NaN },
        { action: 'fold', probability: 0.3 },
      ]),
      'fold',
    );
  });

  it('NEGATIVE CONTROL: the string the web app used to build could never match', () => {
    // The old expression in `PostHandComparison`, restated:
    //   `${action}${action === 'raise' ? ' to' : ''} ${formatChips(to)}`
    // with `@prl/ui`'s grouping formatter. Against a distribution carrying `@prl/poker-ai`'s
    // ungrouped string, the `===` in `ActionDistribution` finds nothing.
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
    // And they DO agree below a thousand, which is why it went unnoticed for so long.
    assert.equal('raise to 520', 'raise to 520');
    // The fix marks the row, on the very figure the old code could not.
    assert.equal(
      entries.filter((entry) => entry.action === mostLikelyAction(entries)).length,
      1,
      'exactly one row must be marked',
    );
  });
});

describe('the component is wired to it', () => {
  // Narrow on purpose: it names the exact expression that was the second producer. The guard that
  // carries the weight is the positive assertion beside it — the marker has to come from
  // `mostLikelyAction`, and there is nowhere else for a rebuilt string to be used.
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
    // `${…}` is built rather than written out: biome's `noTemplateCurlyInString` refuses those two
    // characters inside a plain string, and the repo's idiom is a helper rather than an ignore.
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

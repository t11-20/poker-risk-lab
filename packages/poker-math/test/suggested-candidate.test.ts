import assert from 'node:assert/strict';
import { test } from 'node:test';
import { suggestedCandidate } from '../src/consistency.ts';

const raise = (to: number, ev: number) => ({ action: 'raise' as const, to, cost: to, ev, derivation: '' });
const report = (candidates: ReturnType<typeof raise>[]) =>
  ({
    candidates,
    suggestion: { action: 'raise', sizeRange: { min: 100, max: 200 } },
  }) as unknown as Parameters<typeof suggestedCandidate>[0];

test('a tie in expected value names the smaller size, whatever order the rows arrive in', () => {
  assert.equal(suggestedCandidate(report([raise(200, 10), raise(100, 10)]))?.to, 100);
  assert.equal(suggestedCandidate(report([raise(100, 10), raise(200, 10)]))?.to, 100);
});

test('control: a strictly higher expected value still wins over a smaller size', () => {
  assert.equal(suggestedCandidate(report([raise(100, 10), raise(200, 11)]))?.to, 200);
});

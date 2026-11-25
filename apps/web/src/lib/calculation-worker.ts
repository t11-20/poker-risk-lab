/**
 * Computes a deferred lesson figure off the main thread with the same function the page would call, so
 * the figure cannot differ. Loaded same-origin, which `worker-src 'self'` permits.
 */

import type { CalculationReply, CalculationRequest } from './deferred-calculation.ts';
import { computeCalculation } from './learn-calculations.ts';

globalThis.addEventListener('message', (event: MessageEvent<CalculationRequest>) => {
  const reply: CalculationReply = { outcome: computeCalculation(event.data.calculation) };
  globalThis.postMessage(reply);
});

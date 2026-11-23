/**
 * Prices a spot off the main thread, because a first `top:NN` range builds a preflop ordering that
 * takes about three seconds and the page has to keep taking keystrokes meanwhile. Loaded same-origin,
 * which `worker-src 'self'` permits.
 */

import type { Spot } from './spot.ts';
import { reportForSpot, type SpotReport } from './spot-analysis.ts';

export interface SpotRequest {
  readonly seq: number;
  readonly spot: Spot;
}

export interface SpotReply {
  readonly seq: number;
  readonly result: SpotReport;
}

globalThis.addEventListener('message', (event: MessageEvent<SpotRequest>) => {
  const { seq, spot } = event.data;
  const reply: SpotReply = { seq, result: reportForSpot(spot) };
  globalThis.postMessage(reply);
});

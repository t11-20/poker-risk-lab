'use client';

/**
 * Prices the current spot on a worker and keeps only the answer for the latest one. A request made
 * while one is running waits, and only the newest waiting request is sent, so a burst of keystrokes
 * costs one extra run rather than one per key. The worker is never terminated for a newer request,
 * because that would throw away the preflop ordering a `top:NN` range paid seconds to build.
 * If the worker cannot start, the same function runs on the main thread after a short pause.
 */

import type { CoachReport } from '@prl/contracts';
import { useEffect, useRef, useState } from 'react';
import type { Spot } from './spot.ts';
import { reportForSpot, type SpotReport } from './spot-analysis.ts';
import type { SpotReply, SpotRequest } from './spot-worker.ts';

export type ReportState =
  /** No valid spot, so no numbers. */
  | { readonly kind: 'idle' }
  /** `previous` is the last report, shown marked as out of date until the new one lands. */
  | { readonly kind: 'working'; readonly previous: CoachReport | null }
  | { readonly kind: 'ready'; readonly report: CoachReport; readonly ms: number }
  | { readonly kind: 'refused'; readonly message: string };

/** Typing pauses longer than this between keys, so one run follows a word rather than each letter. */
const SETTLE_MS = 120;

interface Runner {
  worker: Worker | null;
  failed: boolean;
  /** The newest request number. A reply for any other is dropped. */
  seq: number;
  /** The newest spot, priced on the main thread if the worker dies under it. */
  latest: SpotRequest | null;
  inFlight: { readonly seq: number; readonly startedAt: number } | null;
  waiting: SpotRequest | null;
  lastReport: CoachReport | null;
}

export function useSpotReport(spot: Spot | null): ReportState {
  const [state, setState] = useState<ReportState>({ kind: 'idle' });
  const runner = useRef<Runner>({
    worker: null,
    failed: false,
    seq: 0,
    latest: null,
    inFlight: null,
    waiting: null,
    lastReport: null,
  });
  // The effect keys on the text, because the editor builds a new `spot` object on every render.
  const key = spot === null ? null : JSON.stringify(spot);

  useEffect(() => {
    const own = runner.current;
    return () => {
      own.worker?.terminate();
      own.worker = null;
    };
  }, []);

  useEffect(() => {
    const run = runner.current;
    const current = key === null ? null : (JSON.parse(key) as Spot);
    run.seq += 1;
    const seq = run.seq;
    if (current === null) {
      run.latest = null;
      run.waiting = null;
      setState({ kind: 'idle' });
      return;
    }
    run.latest = { seq, spot: current };
    setState({ kind: 'working', previous: run.lastReport });

    const settle = (reply: SpotReply, ms: number): void => {
      if (reply.seq !== run.seq) return;
      const result: SpotReport = reply.result;
      if (result.ok) {
        run.lastReport = result.report;
        setState({ kind: 'ready', report: result.report, ms });
      } else {
        setState({ kind: 'refused', message: result.message });
      }
    };

    const onMainThread = (request: SpotRequest): void => {
      const startedAt = performance.now();
      settle({ seq: request.seq, result: reportForSpot(request.spot) }, performance.now() - startedAt);
    };

    const startWorker = (): Worker | null => {
      if (run.failed || typeof Worker === 'undefined') return null;
      if (run.worker !== null) return run.worker;
      try {
        const thread = new Worker(new URL('./spot-worker.ts', import.meta.url), { type: 'module' });
        thread.addEventListener('message', (event: MessageEvent<SpotReply>) => {
          const started = run.inFlight?.startedAt ?? performance.now();
          run.inFlight = null;
          settle(event.data, performance.now() - started);
          const next = run.waiting;
          run.waiting = null;
          if (next !== null) send(next);
        });
        thread.addEventListener('error', () => {
          // A worker that cannot load falls back for good, and the latest spot is priced here instead.
          run.failed = true;
          thread.terminate();
          run.worker = null;
          run.inFlight = null;
          run.waiting = null;
          if (run.latest !== null) onMainThread(run.latest);
        });
        run.worker = thread;
        return thread;
      } catch {
        run.failed = true;
        return null;
      }
    };

    function send(request: SpotRequest): void {
      const thread = startWorker();
      if (thread === null) {
        onMainThread(request);
        return;
      }
      run.inFlight = { seq: request.seq, startedAt: performance.now() };
      thread.postMessage(request);
    }

    const timer = window.setTimeout(() => {
      const request: SpotRequest = { seq, spot: current };
      if (run.inFlight !== null) run.waiting = request;
      else send(request);
    }, SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [key]);

  return state;
}

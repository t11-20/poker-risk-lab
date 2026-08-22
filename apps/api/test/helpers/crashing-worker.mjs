/**
 * A worker that dies on the first task, the way an OOM or a native fault would.
 *
 * Used by `worker-pool-lifecycle.test.ts` to prove the pool surfaces a typed error rather
 * than hanging, and that the dead thread is dropped.
 */
import { parentPort } from 'node:worker_threads';

if (parentPort === null) {
  throw new Error('crashing-worker.mjs must run as a worker thread');
}

parentPort.on('message', () => {
  process.exit(99);
});

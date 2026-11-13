// Dies on the first task, like an OOM or native fault. worker-pool-lifecycle.test.ts uses it to
// prove the pool surfaces a typed error instead of hanging, and drops the dead thread.
import { parentPort } from 'node:worker_threads';

if (parentPort === null) {
  throw new Error('crashing-worker.mjs must run as a worker thread');
}

parentPort.on('message', () => {
  process.exit(99);
});

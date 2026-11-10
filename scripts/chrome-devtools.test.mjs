/**
 * Tests for `chrome-devtools.mjs`, with a stand-in for Chrome: a child process that lives or exits,
 * and a local HTTP server that answers `/json/version` when told to.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { waitForDevtools } from './chrome-devtools.mjs';

const VERSION = { Browser: 'Stand-in/1.0' };

function liveChild() {
  return spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
}

/** A port nothing listens on yet, and a function that starts answering on it. */
async function laterServer() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(VERSION));
  });
  return {
    port,
    open: () => new Promise((resolve) => server.listen(port, '127.0.0.1', resolve)),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** A port that accepts connections and never answers them. */
async function stalledServer() {
  const sockets = new Set();
  // No request listener, so a request is accepted and never answered.
  const server = createServer();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    close: () => {
      for (const socket of sockets) socket.destroy();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

describe('waitForDevtools', () => {
  it('returns /json/version once the port answers', async () => {
    const server = await laterServer();
    await server.open();
    const child = liveChild();
    try {
      assert.deepEqual(await waitForDevtools(child, server.port, 5_000), VERSION);
    } finally {
      child.kill();
      await server.close();
    }
  });

  it('waits past nine seconds, the budget that failed on CI (REGRESSION)', { timeout: 30_000 }, async () => {
    // The six gates gave Chrome 60 x 150ms. On the merge of PR #7 the contrast fixture's Chrome
    // took longer than that on a busy runner, and both PASS 3 tests failed at 9.2s.
    const server = await laterServer();
    const child = liveChild();
    const opened = delay(9_500).then(server.open);
    try {
      assert.deepEqual(await waitForDevtools(child, server.port), VERSION);
    } finally {
      child.kill();
      // Awaited before closing on the failing path too, or a server opened after the wait gave up
      // keeps this process alive.
      await opened;
      await server.close();
    }
  });

  it('fails at once, with the exit code, when Chrome exits instead of listening', async () => {
    const server = await laterServer();
    const child = spawn(process.execPath, ['-e', 'process.exit(3)'], { stdio: 'ignore' });
    const started = Date.now();
    await assert.rejects(waitForDevtools(child, server.port), /Chrome exited \(code 3/);
    assert.ok(Date.now() - started < 5_000, 'an exited Chrome was waited on until the deadline');
  });

  it('names the port and the budget when nothing ever answers', async () => {
    const server = await laterServer();
    const child = liveChild();
    try {
      await assert.rejects(
        waitForDevtools(child, server.port, 600),
        new RegExp(`did not open a debugging port on ${server.port} within 0.6s`),
      );
    } finally {
      child.kill();
    }
  });

  it('reports an exit while something on the port accepts and never answers', async () => {
    // From review on #11: the poll's fetch had no timeout, so a stalled listener kept it pending
    // past the deadline and past Chrome exiting.
    const stalled = await stalledServer();
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(3), 500)'], {
      stdio: 'ignore',
    });
    const started = Date.now();
    try {
      await assert.rejects(waitForDevtools(child, stalled.port), /Chrome exited \(code 3/);
      assert.ok(Date.now() - started < 5_000, `took ${Date.now() - started}ms`);
    } finally {
      await stalled.close();
    }
  });

  it('keeps its deadline while something on the port accepts and never answers', async () => {
    const stalled = await stalledServer();
    const child = liveChild();
    const started = Date.now();
    try {
      await assert.rejects(waitForDevtools(child, stalled.port, 1_500), /within 1.5s/);
      assert.ok(Date.now() - started < 4_000, `took ${Date.now() - started}ms`);
    } finally {
      child.kill();
      await stalled.close();
    }
  });
});

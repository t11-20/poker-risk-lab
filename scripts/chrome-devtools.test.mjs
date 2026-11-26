import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { DevtoolsReplies, waitForDevtools, withChrome } from './chrome-devtools.mjs';

const VERSION = { Browser: 'Stand-in/1.0' };

function liveChild() {
  return spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
}

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
    // The old budget was 60 x 150ms, and a busy runner's Chrome took longer than that.
    const server = await laterServer();
    const child = liveChild();
    const opened = delay(9_500).then(server.open);
    try {
      assert.deepEqual(await waitForDevtools(child, server.port), VERSION);
    } finally {
      child.kill();
      // Awaited on the failing path too, or a server opened after the wait gave up keeps the process alive.
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

/**
 * A stand-in Chrome that serves DevTools on a port of its own and, for port 0, writes it where Chrome
 * does. `PRL_FAKE_CHROME_PATH` makes it name another browser than the one it serves.
 */
const FAKE_CHROME = `#!${process.execPath}
const { writeFileSync } = require('node:fs');
const { createServer } = require('node:http');
const arg = (name) => process.argv.find((a) => a.startsWith(name + '='))?.slice(name.length + 1);
if (process.env.PRL_FAKE_CHROME_EXIT_MS) setTimeout(() => process.exit(3), Number(process.env.PRL_FAKE_CHROME_EXIT_MS));
if (process.env.PRL_FAKE_CHROME_SILENT) setInterval(() => {}, 60_000);
else {
  const server = createServer((request, response) => {
    const { port } = server.address();
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(request.url === '/json/version'
      ? { Browser: 'Fake/1.0', webSocketDebuggerUrl: 'ws://127.0.0.1:' + port + '/devtools/browser/fake' }
      : { webSocketDebuggerUrl: 'ws://127.0.0.1:' + port + '/devtools/page/fake' }));
  });
  server.listen(Number(arg('--remote-debugging-port')), '127.0.0.1', () => {
    const { port } = server.address();
    const path = process.env.PRL_FAKE_CHROME_PATH ?? '/devtools/browser/fake';
    writeFileSync(arg('--user-data-dir') + '/DevToolsActivePort', port + '\\n' + path);
  });
}
`;

describe('withChrome', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'prl-chrome-devtools-test-'));
  const fake = join(scratch, 'fake-chrome');
  writeFileSync(fake, FAKE_CHROME);
  chmodSync(fake, 0o755);
  const KEYS = ['CHROME_PATH', 'PRL_FAKE_CHROME_PATH', 'PRL_FAKE_CHROME_SILENT', 'PRL_FAKE_CHROME_EXIT_MS'];
  const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  const restore = () => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  };
  after(() => {
    restore();
    rmSync(scratch, { recursive: true, force: true });
  });

  // The fake reads these when it is spawned, so they are set for the launch and put back after it.
  const launch = async (options, env = {}) => {
    restore();
    Object.assign(process.env, { CHROME_PATH: fake, ...env });
    try {
      return await withChrome(
        { headful: false, freshProfile: 'prl-chrome-devtools-test-', flags: [], dim: (s) => s, ...options },
        async ({ version, openTab }) => ({ version, tab: await openTab() }),
      );
    } finally {
      restore();
    }
  };

  /** Answers as a leftover Chrome would, for the browser path `stale`. */
  async function standIn() {
    const server = createServer((_request, response) => {
      const url = `ws://127.0.0.1:${server.address().port}/devtools/browser/stale`;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ Browser: 'Stranger/1.0', webSocketDebuggerUrl: url }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
  }

  it('drives the Chrome it launched on port 0, at the port that Chrome wrote', async () => {
    const stranger = await standIn();
    try {
      const { version, tab } = await launch({ port: 0 });
      assert.equal(version.Browser, 'Fake/1.0');
      assert.match(tab, /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/page\/fake$/u);
      assert.doesNotMatch(tab, new RegExp(`:${stranger.port}/`));
    } finally {
      await stranger.close();
    }
  });

  // On CI a gate's fixed port met another gate's leftover Chrome, which it then drove (REGRESSION).
  it('refuses a fixed port something already answers on', async () => {
    const stranger = await standIn();
    try {
      await assert.rejects(
        launch({ port: stranger.port }, { PRL_FAKE_CHROME_SILENT: '1' }),
        new RegExp(`something is already listening on 127\\.0\\.0\\.1:${stranger.port}`),
      );
    } finally {
      await stranger.close();
    }
  });

  it('refuses a port that serves another browser than the one the file names', async () => {
    await assert.rejects(
      launch({ port: 0 }, { PRL_FAKE_CHROME_PATH: '/devtools/browser/other' }),
      /answered as ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/fake, not as the Chrome that wrote/u,
    );
  });

  it("does not read a fixed profile's file from the last run", async () => {
    const stranger = await standIn();
    const profile = join(scratch, 'fixed-profile');
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, 'DevToolsActivePort'), `${stranger.port}\n/devtools/browser/stale`);
    try {
      await assert.rejects(
        launch({ port: 0, profile }, { PRL_FAKE_CHROME_SILENT: '1', PRL_FAKE_CHROME_EXIT_MS: '500' }),
        /Chrome exited \(code 3, signal null\) before it wrote .*DevToolsActivePort/u,
      );
    } finally {
      await stranger.close();
    }
  });
});

describe('DevtoolsReplies', () => {
  it('rejects a call Chrome never answers, and every later call at once', async () => {
    const replies = new DevtoolsReplies(200);
    await assert.rejects(
      replies.expect(1, 'Runtime.evaluate'),
      /did not answer Runtime\.evaluate within 0\.2s/u,
    );
    const started = Date.now();
    await assert.rejects(replies.expect(2, 'Runtime.evaluate'), /did not answer Runtime\.evaluate/u);
    assert.ok(Date.now() - started < 100, 'a retry after a timeout waited the bound again');
  });

  it('settles a call with its answer and leaves no timer to break the page later', async () => {
    const replies = new DevtoolsReplies(20);
    const reply = replies.expect(1, 'Page.navigate');
    replies.settle({ id: 1, result: { frameId: 'f' } });
    assert.deepEqual(await reply, { frameId: 'f' });
    await delay(40);
    const next = replies.expect(2, 'Page.enable');
    replies.settle({ id: 2, result: {} });
    assert.deepEqual(await next, {});
  });

  it('rejects what is waiting when the socket closes, and reports the first failure, not a later one', async () => {
    const replies = new DevtoolsReplies(1_000);
    const reply = replies.expect(1, 'Runtime.evaluate');
    replies.fail(new Error('the DevTools socket closed'));
    await assert.rejects(reply, /socket closed/u);
    replies.fail(new Error('a later failure'));
    await assert.rejects(replies.expect(2, 'Page.enable'), /socket closed/u);
  });

  it('is how every script that sends DevTools commands waits for an answer', () => {
    const root = new URL('.', import.meta.url);
    const scripts = readdirSync(root, { recursive: true }).filter(
      (name) => name.endsWith('.mjs') && !name.endsWith('.test.mjs') && name !== 'chrome-devtools.mjs',
    );
    const senders = scripts.filter((name) =>
      readFileSync(new URL(name, root), 'utf8').includes('JSON.stringify({ id, method'),
    );
    assert.ok(senders.length >= 6, `found ${senders.length} DevTools senders; the scan read too little`);
    const unbounded = senders.filter((name) => {
      const source = readFileSync(new URL(name, root), 'utf8');
      return (
        !source.includes('this.#replies.expect(id, method)') || !source.includes("addEventListener('close'")
      );
    });
    assert.deepEqual(unbounded, [], 'these wait for Chrome with no time limit');
  });
});

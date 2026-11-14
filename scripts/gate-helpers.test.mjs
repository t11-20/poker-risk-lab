#!/usr/bin/env node
/**
 * Seven gates share these helpers, so each gate's busy-port sentence and Chrome command line are pinned
 * here: a shared change would otherwise alter every gate at once and show only when a port collides.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromePath } from './chrome-devtools.mjs';
import { ManagedServer, refuseOccupiedPort } from './gate-servers.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRATCH = mkdtempSync(join(tmpdir(), 'prl-gate-helpers-test-'));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));

async function listener() {
  const server = createNetServer((socket) => socket.destroy());
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return { port: server.address().port, close: () => new Promise((done) => server.close(done)) };
}

async function freePort() {
  const { port, close } = await listener();
  await close();
  return port;
}

async function refuses(port) {
  const { connect } = await import('node:net');
  return new Promise((done) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      done(false);
    });
    socket.once('error', () => done(true));
  });
}

/** Origins and secrets the developer's shell may carry, which would point a gate somewhere else. */
function gateEnv(extra) {
  const env = { ...process.env, NO_COLOR: '1', ...extra };
  for (const name of Object.keys(env)) {
    if (name.startsWith('PRL_') && !(name in extra)) delete env[name];
  }
  return env;
}

function runGate(script, args, env = {}) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [join('scripts', script), ...args], {
      cwd: REPO,
      env: gateEnv(env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    // Past check-contrast's fixed 120s readiness budget, so a gate that wrongly starts a server reaches
    // its own `finally` and stops it instead of being killed and orphaning it.
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      fail(new Error(`${script} ${args.join(' ')} ran past 180s:\n${output}`));
    }, 180_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      done({ code, output, pid: child.pid });
    });
  });
}

describe('refuseOccupiedPort', () => {
  it('resolves for a port nothing listens on', async () => {
    const port = await freePort();
    assert.equal(await refuseOccupiedPort(`http://127.0.0.1:${port}`, 'unused'), undefined);
  });

  it('refuses a bound port, names host and port, then gives the advice', async () => {
    const { port, close } = await listener();
    try {
      await assert.rejects(refuseOccupiedPort(`http://127.0.0.1:${port}/some/path`, 'Stop it.'), {
        message: `something is already listening on 127.0.0.1:${port}. Stop it.`,
      });
    } finally {
      await close();
    }
  });

  it('probes the host the URL names, brackets removed', async (t) => {
    const server = createNetServer((socket) => socket.destroy());
    const failure = await new Promise((done) => {
      server.once('error', (err) => done(err));
      server.listen(0, '::1', () => done(null));
    });
    if (failure !== null) {
      t.skip(`IPv6 loopback ::1 cannot be bound on this host (${failure.code ?? failure.message})`);
      return;
    }
    const { port } = server.address();
    try {
      await assert.rejects(refuseOccupiedPort(`http://[::1]:${port}`, 'x'), {
        message: `something is already listening on ::1:${port}. x`,
      });
    } finally {
      await new Promise((done) => server.close(done));
    }
  });
});

describe('refuseOccupiedPort, as each gate words it', () => {
  // One row per gate: the flags that point the first port it refuses at a listener, and its sentence.
  // `--ready-timeout 1` bounds a run that wrongly goes on to start a server; check-contrast has no such flag.
  const ROWS = [
    {
      script: 'a11y-audit.mjs',
      args: (url) => ['--base-url', url, '--ready-timeout', '1'],
      advice:
        '--start audits a server this run started, so it will not score one it did not. Stop it, pass ' +
        'another --base-url/--api-url, or pass --no-start to audit that server on purpose.',
    },
    {
      script: 'age-gate-audit.mjs',
      args: (_url, port) => ['--port', String(port), '--ready-timeout', '1'],
      advice:
        'This harness starts the servers it measures, so it will not reuse one it did not configure. ' +
        'Stop it, or pass --port/--site-port.',
      needsBuild: true,
    },
    {
      script: 'ax-tree-audit.mjs',
      args: (url) => ['--start', '--base-url', url, '--ready-timeout', '1'],
      advice:
        'This run starts the server it audits there, so it will not score one it did not. Stop it, or ' +
        'pass another --base-url, --api-url, --offline-url, --proxied-url or --proxy-url.',
    },
    {
      script: 'check-contrast.mjs',
      args: (url) => ['--base-url', url],
      advice:
        'This gate starts the web app it measures, so it will not score one it did not. Stop it, pass ' +
        'another --base-url, or pass --no-start to measure that server on purpose.',
    },
    {
      script: 'csp-negative-control.mjs',
      args: (url) => ['--start', '--base-url', url, '--ready-timeout', '1'],
      advice:
        '--start tests a server this run started, so it will not score one it did not. Stop it, pass ' +
        'another --base-url/--api-url, or leave out --start to test that server on purpose.',
    },
    {
      script: 'keyboard-audit.mjs',
      args: (url) => ['--start', '--web', url, '--ready-timeout', '1'],
      advice:
        '--start drives a server this run started, so it will not score one it did not. Stop it, pass ' +
        'another --web/--api, or leave out --start to drive that server on purpose.',
    },
    {
      script: 'text-layout-audit.mjs',
      args: (url) => ['--start', '--base-url', url, '--ready-timeout', '1'],
      advice:
        '--start measures a web app this run started, so it will not score one it did not. Stop it, ' +
        'pass another --base-url, or leave out --start to measure that server on purpose.',
    },
  ];
  const built = existsSync(join(REPO, 'apps', 'web', '.next', 'BUILD_ID'));

  for (const row of ROWS) {
    const skip =
      row.needsBuild && !built
        ? `${row.script} reads apps/web/.next/BUILD_ID before it probes a port; run pnpm run build`
        : false;
    it(`${row.script} refuses with its own sentence and exits 1`, { skip }, async () => {
      const { port, close } = await listener();
      try {
        const run = await runGate(row.script, row.args(`http://127.0.0.1:${port}`, port));
        assert.ok(
          run.output.includes(`something is already listening on 127.0.0.1:${port}. ${row.advice}`),
          run.output,
        );
        assert.equal(run.code, 1, run.output);
      } finally {
        await close();
      }
    });
  }
});

describe('chromePath', () => {
  const INSTALLED = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  const only =
    (...present) =>
    (path) =>
      present.includes(path);

  it('takes CHROME_PATH first when it exists', () => {
    const found = chromePath({ CHROME_PATH: '/opt/x/chrome' }, only('/opt/x/chrome', INSTALLED[0]));
    assert.equal(found, '/opt/x/chrome');
  });

  it('falls through a CHROME_PATH that does not exist, in the listed order', () => {
    assert.equal(chromePath({ CHROME_PATH: '/nope' }, only(INSTALLED[3], INSTALLED[2])), INSTALLED[2]);
    assert.equal(chromePath({}, only(...INSTALLED)), INSTALLED[0]);
    assert.equal(chromePath({ CHROME_PATH: '' }, only(INSTALLED[4])), INSTALLED[4]);
  });

  it('names CHROME_PATH and every candidate when none exists', () => {
    assert.throws(() => chromePath({ CHROME_PATH: '/nope' }, only()), {
      message: `no Chrome found. Set CHROME_PATH, or install one of:\n${['/nope', ...INSTALLED]
        .map((p) => `  ${p}`)
        .join('\n')}`,
    });
  });
});

describe('Chrome, as each gate launches it', () => {
  const LOG = join(SCRATCH, 'chrome-argv.jsonl');
  const FAKE = join(SCRATCH, 'fake-chrome');
  writeFileSync(
    FAKE,
    `#!${process.execPath}\n` +
      "require('node:fs').appendFileSync(process.env.PRL_FAKE_CHROME_LOG, " +
      "JSON.stringify(process.argv.slice(2)) + '\\n');\nprocess.exit(3);\n",
  );
  chmodSync(FAKE, 0o755);

  let site = null;
  const siteUrl = async () => {
    if (site === null) {
      // keyboard-audit refuses a landing page without the shell class, the others want any 200.
      const server = createHttpServer((_request, response) => {
        response.setHeader('content-type', 'text/html');
        response.end('<!doctype html><html><body class="prl-app">stand-in</body></html>');
      });
      await new Promise((done) => server.listen(0, '127.0.0.1', done));
      site = server;
    }
    return `http://127.0.0.1:${site.address().port}`;
  };
  after(() => site?.close());

  const COMMON = ['--no-first-run', '--no-default-browser-check', '--disable-background-timer-throttling'];
  // age-gate-audit launches Chrome only after two production servers answer; test:age-gate covers it.
  const ROWS = [
    {
      script: 'ax-tree-audit.mjs',
      args: (url) => ['--base-url', url, '--no-assertions'],
      port: (pid) => 9800 + (pid % 150),
      profile: '/tmp/prl-ax-tree-audit-profile',
      flags: ['--window-size=1440,900'],
    },
    {
      script: 'check-contrast.mjs',
      args: (url) => ['--no-start', '--base-url', url],
      port: (pid) => 9650 + (pid % 140),
      profile: '/tmp/prl-contrast-paint-profile',
      flags: ['--window-size=1440,900'],
    },
    {
      script: 'csp-negative-control.mjs',
      args: (url) => ['--base-url', url],
      port: (pid) => 9400 + (pid % 150),
      freshProfile: 'prl-csp-negative-control-',
      flags: ['--window-size=1440,900'],
    },
    {
      script: 'keyboard-audit.mjs',
      args: (url) => ['--web', url],
      port: (pid) => 9222 + (pid % 500),
      freshProfile: 'prl-keyboard-audit-',
      flags: ['--window-size=1440,900'],
    },
    {
      script: 'text-layout-audit.mjs',
      args: (url) => ['--base-url', url],
      port: (pid) => 9650 + (pid % 140),
      profile: '/tmp/prl-text-layout-audit-profile',
      flags: ['--hide-scrollbars', '--force-device-scale-factor=1', '--window-size=1920,1200'],
    },
  ];

  for (const row of ROWS) {
    it(`${row.script} launches CHROME_PATH with its own flags, and reports the exit`, async () => {
      rmSync(LOG, { force: true });
      const run = await runGate(row.script, row.args(await siteUrl()), {
        CHROME_PATH: FAKE,
        PRL_FAKE_CHROME_LOG: LOG,
      });
      const port = row.port(run.pid);
      assert.ok(
        run.output.includes(
          `Chrome exited (code 3, signal null) before it opened a debugging port on ${port}`,
        ),
        run.output,
      );
      assert.equal(run.code, 1, run.output);

      const launches = readFileSync(LOG, 'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(launches.length, 1, `Chrome was launched ${launches.length} times`);
      const [argv] = launches;
      const profileFlag = argv.find((arg) => arg.startsWith('--user-data-dir='));
      const profile = profileFlag?.slice('--user-data-dir='.length);
      if (row.freshProfile !== undefined) {
        assert.ok(profile?.startsWith(join(tmpdir(), row.freshProfile)), `profile ${profile}`);
        assert.equal(existsSync(profile), false, `the fresh profile ${profile} was left behind`);
      } else {
        assert.equal(profile, row.profile);
      }
      assert.deepEqual(argv, [
        '--headless=new',
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profile}`,
        ...COMMON,
        ...row.flags,
        'about:blank',
      ]);
    });
  }
});

describe('ManagedServer', () => {
  const FIXTURE = join(SCRATCH, 'fixture-server.mjs');
  writeFileSync(
    FIXTURE,
    "import { spawn } from 'node:child_process';\n" +
      'const [port] = process.argv.slice(2);\n' +
      "console.log('fixture-booting', process.env.PRL_FIXTURE_MARK);\n" +
      // pnpm forwards SIGTERM to its child, so the child ignores it and only a signal to the whole
      // process group reaches the listener, as with `next start` under `pnpm --filter`.
      "process.on('SIGTERM', () => {});\n" +
      // Any status counts as ready, so a 503 must too.
      "const serve = \"require('node:http').createServer((_q, r) => { r.statusCode = 503; r.end(); })" +
      ".listen(Number(process.argv[1]), '127.0.0.1')\";\n" +
      "const listener = spawn(process.execPath, ['-e', serve, port], { stdio: 'inherit' });\n" +
      "listener.on('exit', () => process.exit(0));\n",
  );

  it('is ready on any HTTP answer, runs in the repo with the env merged, and stops the group', async () => {
    const port = await freePort();
    const server = new ManagedServer(
      'fixture',
      ['exec', 'node', FIXTURE, String(port)],
      `http://127.0.0.1:${port}/`,
      {
        PRL_FIXTURE_MARK: 'merged',
      },
    );
    server.start();
    try {
      await server.waitUntilReady(30);
      assert.match(server.output.join(''), /fixture-booting merged/);
    } finally {
      server.stop();
    }
    try {
      for (let i = 0; i < 50 && !(await refuses(port)); i += 1) await delay(100);
      assert.ok(await refuses(port), 'the fixture server was still listening after stop()');
    } finally {
      // A stop() that missed the group would otherwise leave the listener running past the test.
      try {
        process.kill(-server.child.pid, 'SIGKILL');
      } catch {
        // ESRCH: the group is already gone, which is the passing case.
      }
    }
  });

  it('reports an exit before ready with the label and what the child printed', async () => {
    const server = new ManagedServer(
      'doomed',
      ['exec', 'node', '-e', 'console.log("doomed-output"); process.exit(7)'],
      `http://127.0.0.1:${await freePort()}/`,
      {},
    );
    server.start();
    try {
      await assert.rejects(
        server.waitUntilReady(30),
        /^Error: doomed exited \(7\) before it was ready:\n[\s\S]*doomed-output/,
      );
    } finally {
      server.stop();
    }
  });

  it('names the URL and the budget when nothing answers in time', async () => {
    const url = `http://127.0.0.1:${await freePort()}/`;
    const server = new ManagedServer(
      'silent',
      ['exec', 'node', '-e', 'setTimeout(() => {}, 60_000)'],
      url,
      {},
    );
    server.start();
    try {
      await assert.rejects(server.waitUntilReady(1), {
        message: new RegExp(`^silent was not ready at ${url} within 1s:\\n`),
      });
    } finally {
      server.stop();
    }
    for (let i = 0; i < 50 && server.exited === null; i += 1) await delay(100);
    assert.notEqual(server.exited, null, 'stop() did not end the child');
  });

  it('stop() is silent before start and after the child has gone', async () => {
    const lines = [];
    const log = console.log;
    console.log = (...args) => lines.push(args.join(' '));
    try {
      const never = new ManagedServer('never', ['--version'], 'http://127.0.0.1:1/', {});
      never.stop();
      const gone = new ManagedServer('gone', ['--version'], 'http://127.0.0.1:1/', {});
      gone.start();
      for (let i = 0; i < 100 && gone.exited === null; i += 1) await delay(100);
      gone.stop();
    } finally {
      console.log = log;
    }
    assert.deepEqual(lines, []);
  });
});

describe('one copy of each helper', () => {
  const GATES = [
    'a11y-audit.mjs',
    'age-gate-audit.mjs',
    'ax-tree-audit.mjs',
    'check-contrast.mjs',
    'csp-negative-control.mjs',
    'keyboard-audit.mjs',
    'text-layout-audit.mjs',
  ];
  const LOCAL_COPY =
    /^(?:async )?(?:function|class|const) (?:ManagedServer|refuseOccupiedPort|chromePath|CHROME_CANDIDATES)\b/m;

  it('no gate defines its own, and every gate imports the shared one', () => {
    const read = GATES.map((script) => [script, readFileSync(join(REPO, 'scripts', script), 'utf8')]);
    assert.equal(read.length, 7);
    for (const [script, source] of read) {
      assert.doesNotMatch(source, LOCAL_COPY, `${script} carries its own copy`);
      assert.match(
        source,
        /^import \{ ManagedServer, refuseOccupiedPort \} from '\.\/gate-servers\.mjs';$/m,
        script,
      );
      assert.doesNotMatch(source, /--remote-debugging-port/, `${script} launches Chrome itself`);
    }
  });
});

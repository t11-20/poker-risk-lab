#!/usr/bin/env node
/**
 * Tests for `pnpm run alerts:ack`. Run with `node --test scripts/alert-ack-page.test.mjs`.
 *
 * The behaviour that must never regress is that the command fails when nobody answers. The other
 * tests cover ways to a green result without a person: an empty code, a closed stdin, a code read
 * off stdout, unbounded guessing, and a rehearsal decided from env vars. The command tests spawn the
 * real `main()` against a stub Alertmanager shaped like `prom/alertmanager:v0.28.1`.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { connect, createServer as createSocketServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  alertmanagerDestinations,
  awaitAcknowledgement,
  codeInNotification,
  isLocalSmtpSink,
  isLocalWebhookSink,
  MAX_ATTEMPTS,
  makeCode,
  normaliseCode,
  redactCode,
  rehearsalCandidate,
} from './alert-ack-page.mjs';

function typing(lines, { close = false } = {}) {
  const stream = new Readable({
    read() {
      // Lines are pushed up front and the stream stays open, like a terminal with nobody at it.
    },
  });
  for (const line of lines) stream.push(`${line}\n`);
  if (close) stream.push(null);
  return stream;
}

const silence = () =>
  new Readable({
    read() {
      // Produces nothing, ever.
    },
  });

describe('NEGATIVE CONTROL: nobody acknowledges', () => {
  it('fails when the window closes with nothing typed', async () => {
    const outcome = await awaitAcknowledgement({
      input: silence(),
      expected: 'ABC123',
      deadlineMs: 120,
    });
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason, /nobody acknowledged/);
    assert.equal(outcome.attempts, 0);
  });

  it('fails when stdin closes without a matching code', async () => {
    // `< /dev/null` in CI. The end of input must be treated as a refusal.
    const outcome = await awaitAcknowledgement({
      input: typing([], { close: true }),
      expected: 'ABC123',
      deadlineMs: 5_000,
    });
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason, /input ended/);
  });

  it('fails on wrong codes alone, however many are typed', async () => {
    const attempts = [];
    const outcome = await awaitAcknowledgement({
      input: typing(['ABC124', 'nope', '']),
      expected: 'ABC123',
      deadlineMs: 200,
      onAttempt: (typed) => attempts.push(typed),
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.attempts, 3);
    assert.deepEqual(attempts, ['ABC124', 'nope', '']);
  });

  it('refuses an empty expected code rather than matching a blank line', async () => {
    // If the code were ever empty, a bare enter would acknowledge it.
    await assert.rejects(
      () => awaitAcknowledgement({ input: silence(), expected: '', deadlineMs: 50 }),
      /the expected code is empty/,
    );
  });
});

describe('a person types the code', () => {
  it('accepts it, and reports how long they took', async () => {
    const outcome = await awaitAcknowledgement({
      input: typing(['7QK3F2']),
      expected: '7QK3F2',
      deadlineMs: 5_000,
    });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.attempts, 1);
    assert.ok(outcome.elapsedMs >= 0);
  });

  it('accepts it after a wrong attempt, because a transcription slip is not a failure', async () => {
    // A typo by the person being paged must not end the run.
    const outcome = await awaitAcknowledgement({
      input: typing(['7QK3F1', '7QK3F2']),
      expected: '7QK3F2',
      deadlineMs: 5_000,
    });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.attempts, 2);
  });

  it('forgives case, spaces and a hyphen, and nothing else', async () => {
    assert.equal(normaliseCode(' 7qk-3 f2 \r'), '7QK3F2');
    assert.notEqual(normaliseCode('7QK3F3'), normaliseCode('7QK3F2'));
    const outcome = await awaitAcknowledgement({
      input: typing([' 7qk-3f2 ']),
      expected: '7QK3F2',
      deadlineMs: 5_000,
    });
    assert.equal(outcome.ok, true);
  });
});

describe('the code itself', () => {
  it('has no character that can be misread off a phone at night', () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      assert.match(makeCode(), /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
    }
  });

  it('uses the whole alphabet rather than a corner of it', () => {
    // Catches randomness that collapsed, such as a wrong modulo bound or a constant seed.
    const seen = new Set();
    for (let attempt = 0; attempt < 400; attempt += 1) for (const char of makeCode()) seen.add(char);
    assert.ok(seen.size > 24, `only ${seen.size} distinct characters in 2,400 draws`);
  });

  it('is read back out of a delivered notification by label, not by scraping text', () => {
    const payload = {
      alerts: [{ labels: { alertname: 'OperatorTestPage', severity: 'page', ack_code: '7QK3F2' } }],
    };
    assert.equal(codeInNotification(payload), '7QK3F2');
    assert.equal(codeInNotification({ alerts: [{ labels: { alertname: 'ApiDown' } }] }), null);
    assert.equal(codeInNotification({}), null);
  });
});

describe('the attempt cap', () => {
  it('closes the window after MAX_ATTEMPTS wrong codes, however long the window is', async () => {
    // Uncapped, a pty drove ~106,450 guesses/s. The deadline is an hour so the cap, not the clock,
    // ends the run.
    const outcome = await awaitAcknowledgement({
      input: typing(Array.from({ length: 50 }, (_, index) => `WRONG${index}`)),
      expected: '7QK3F2',
      deadlineMs: 3_600_000,
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.attempts, MAX_ATTEMPTS);
    assert.match(outcome.reason, /attempt limit/);
  });

  it('still forgives a transcription slip, which is what the cap is sized for', async () => {
    const outcome = await awaitAcknowledgement({
      input: typing(['7QK3F1', '7QK3FZ', '7QK3F2']),
      expected: '7QK3F2',
      deadlineMs: 5_000,
    });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.attempts, 3);
  });

  it('a caller may not raise the cap past what a person needs', () => {
    // Only this test passes `maxAttempts`. This keeps the default a real cap.
    assert.ok(MAX_ATTEMPTS <= 10, `MAX_ATTEMPTS is ${MAX_ATTEMPTS}, which is not a cap`);
  });
});

describe('the code is not printed', () => {
  it('redacts the code out of anything about to be shown', () => {
    assert.equal(
      redactCode('[FIRING:1] OperatorTestPage (7QK3F2 page)', '7QK3F2'),
      '[FIRING:1] OperatorTestPage (······ page)',
    );
    assert.equal(redactCode('nothing to redact', '7QK3F2'), 'nothing to redact');
    // Alertmanager's subject template can repeat a label, and a string `replace` takes only the first.
    assert.equal(redactCode('7QK3F2 and 7QK3F2', '7QK3F2'), '······ and ······');
  });
});

describe('where the page actually goes', () => {
  const REHEARSAL_CONFIG = `global:
  resolve_timeout: 1m
  smtp_from: alertmanager@staging.poker-risk-lab.invalid
  smtp_smarthost: host.docker.internal:9098
  smtp_require_tls: false
  pagerduty_url: https://events.pagerduty.com/v2/enqueue
  opsgenie_api_url: https://api.opsgenie.com/
route:
  receiver: paging
receivers:
- name: paging
  email_configs:
  - send_resolved: true
    to: oncall@staging.poker-risk-lab.invalid
    smarthost: host.docker.internal:9098
  webhook_configs:
  - send_resolved: true
    url: <secret>
    url_file: ""
`;

  it("reads a real Alertmanager's own config, redactions and vendor defaults and all", () => {
    // `pagerduty_url` and `opsgenie_api_url` are global defaults in every config, not destinations.
    const found = alertmanagerDestinations(REHEARSAL_CONFIG);
    assert.deepEqual([...found.integrations].sort(), ['email_configs', 'webhook_configs']);
    assert.deepEqual([...found.smarthosts], ['host.docker.internal:9098']);
    assert.deepEqual([...found.recipients], ['oncall@staging.poker-risk-lab.invalid']);
    assert.deepEqual(found.webhooks, []);
    assert.equal(found.redactedWebhooks, 1, 'the redacted webhook was not counted');
    assert.equal(found.webhookFiles, 0);
  });

  it('calls the rehearsal a rehearsal candidate', () => {
    const candidate = rehearsalCandidate(REHEARSAL_CONFIG);
    assert.deepEqual(candidate.reasons, []);
    assert.equal(candidate.sinkOnly, true);
  });

  it('refuses to call it one when the mail leaves this machine', () => {
    // Every `PRL_ALERT_*` at its default while the Alertmanager relays to a real smarthost. The old
    // env-derived classifier called this a rehearsal.
    const candidate = rehearsalCandidate(
      REHEARSAL_CONFIG.replaceAll('host.docker.internal:9098', 'smtp.example:587'),
    );
    assert.equal(candidate.sinkOnly, false);
    assert.match(candidate.reasons.join('\n'), /smtp\.example:587/);
  });

  it('fails closed on everything it cannot read', () => {
    for (const [why, config] of [
      ['no config at all', ''],
      [
        'an integration it cannot read a destination out of',
        `${REHEARSAL_CONFIG}  pagerduty_configs:\n  - routing_key: <secret>\n`,
      ],
      [
        'a webhook URL from a file',
        REHEARSAL_CONFIG.replace('url_file: ""', 'url_file: /etc/alertmanager/hook'),
      ],
      [
        'a webhook this command can read and does not own',
        REHEARSAL_CONFIG.replace('url: <secret>', 'url: https://events.pagerduty.com/v2/enqueue'),
      ],
      [
        'no email destination, so nothing readable pins the delivery',
        REHEARSAL_CONFIG.replace(/^\s*to:.*$/m, ''),
      ],
    ]) {
      const candidate = rehearsalCandidate(config);
      assert.equal(candidate.sinkOnly, false, `${why} was accepted as a rehearsal`);
      assert.ok(candidate.reasons.length > 0, `${why} gave no reason`);
    }
  });

  it('knows its own two sinks, and nothing else', () => {
    assert.equal(isLocalSmtpSink('host.docker.internal:9098'), true);
    assert.equal(isLocalSmtpSink('127.0.0.1:9098'), true);
    assert.equal(
      isLocalSmtpSink('host.docker.internal:587'),
      false,
      'a real relay on this host is not a sink',
    );
    assert.equal(isLocalSmtpSink('smtp.example:9098'), false, 'the port alone must not be enough');
    assert.equal(isLocalSmtpSink('nonsense'), false);
    assert.equal(isLocalWebhookSink('http://host.docker.internal:9099/page'), true);
    assert.equal(isLocalWebhookSink('http://127.0.0.1:9099/heartbeat'), true);
    assert.equal(isLocalWebhookSink('https://events.pagerduty.com/v2/enqueue'), false);
    assert.equal(isLocalWebhookSink('http://evil.example:9099/page'), false);
    assert.equal(isLocalWebhookSink('not a url'), false);
  });
});

const HERE = dirname(fileURLToPath(import.meta.url));
const COMMAND = join(HERE, 'alert-ack-page.mjs');

const SINK_PORTS = [9099, 9098];

const portIsFree = (port) =>
  new Promise((done) => {
    const probe = createSocketServer();
    probe.once('error', () => done(false));
    probe.listen(port, '0.0.0.0', () => probe.close(() => done(true)));
  });

/**
 * Answers `/api/v2/status` as v0.28.1 does, including `url: <secret>`, and delivers a webhook POST
 * and an SMTP transaction to the command's sinks so the observed stage is exercised.
 */
function startStubAlertmanager({ config }) {
  const posted = [];
  const sendMail = (to, subject, body) =>
    new Promise((done) => {
      const socket = connect(9098, '127.0.0.1');
      const script = [
        'EHLO localhost',
        'MAIL FROM:<alertmanager@staging.poker-risk-lab.invalid>',
        `RCPT TO:<${to}>`,
        'DATA',
      ];
      let step = -1;
      socket.on('data', () => {
        step += 1;
        if (step < script.length) socket.write(`${script[step]}\r\n`);
        else if (step === script.length)
          socket.write(`Subject: ${subject}\r\nTo: ${to}\r\n\r\n${body}\r\n.\r\n`);
        else {
          socket.write('QUIT\r\n');
          socket.end();
          done();
        }
      });
      socket.on('error', () => done());
      socket.on('close', () => done());
    });

  const server = createServer((request, response) => {
    if (request.method === 'GET' && (request.url ?? '').startsWith('/api/v2/status')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ config: { original: config } }));
      return;
    }
    if (request.method === 'POST' && request.url === '/api/v2/alerts') {
      let body = '';
      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', async () => {
        const alerts = JSON.parse(body);
        posted.push(...alerts);
        response.writeHead(200).end('{}');
        for (const alert of alerts) {
          // A resolve is `endsAt` in the past and must not be delivered as `firing`.
          if (Date.parse(alert.endsAt) <= Date.now()) continue;
          await fetch('http://127.0.0.1:9099/page', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              status: 'firing',
              alerts: [{ labels: alert.labels, annotations: alert.annotations }],
            }),
          }).catch(() => {
            // A closed sink is reported by the command's own assertion.
          });
          await sendMail(
            'oncall@staging.poker-risk-lab.invalid',
            `[FIRING:1] ${alert.labels.alertname} (${alert.labels.ack_code} page)`,
            `Alert: ${alert.labels.alertname}\n${alert.annotations?.summary ?? ''}`,
          );
        }
      });
      return;
    }
    response.writeHead(404).end('{}');
  });
  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () =>
      done({ url: `http://127.0.0.1:${server.address().port}`, posted, close: () => server.close() }),
    );
  });
}

function runCommand(args, env = {}) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [COMMAND, ...args], {
      cwd: dirname(HERE),
      env: { ...process.env, NO_COLOR: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.on('close', (status) => done({ status, output }));
  });
}

const REHEARSAL_ALERTMANAGER_CONFIG = `global:
  resolve_timeout: 1m
  smtp_from: alertmanager@staging.poker-risk-lab.invalid
  smtp_smarthost: host.docker.internal:9098
  smtp_require_tls: false
route:
  receiver: paging
receivers:
- name: paging
  email_configs:
  - send_resolved: true
    to: oncall@staging.poker-risk-lab.invalid
    smarthost: host.docker.internal:9098
  webhook_configs:
  - send_resolved: true
    url: <secret>
    url_file: ""
`;

const REAL_ALERTMANAGER_CONFIG = `global:
  resolve_timeout: 1m
  smtp_smarthost: smtp.sendgrid.example:587
route:
  receiver: paging
receivers:
- name: paging
  email_configs:
  - send_resolved: true
    to: 5551234567@txt.example
    smarthost: smtp.sendgrid.example:587
`;

describe('the command, run for real', () => {
  it('refuses a pipe, because a pipe is a script and not a person', async (context) => {
    // The isTTY gate in `main()`.
    const stub = await startStubAlertmanager({ config: REHEARSAL_ALERTMANAGER_CONFIG });
    try {
      const run = await runCommand(['--alertmanager', stub.url, '--within', '5s']);
      assert.equal(run.status, 1, run.output);
      assert.match(run.output, /stdin is not a terminal/);
      assert.equal(
        stub.posted.length,
        0,
        'a page was sent before the refusal — nobody should have been paged',
      );
    } finally {
      stub.close();
    }
    context.diagnostic('isTTY gate exercised against the real command');
  });

  it('refuses a duration it cannot parse, before sending anything', async () => {
    const stub = await startStubAlertmanager({ config: REHEARSAL_ALERTMANAGER_CONFIG });
    try {
      const run = await runCommand(['--alertmanager', stub.url, '--within', 'soon']);
      assert.equal(run.status, 1, run.output);
      assert.match(run.output, /--within is not a duration/);
      assert.equal(stub.posted.length, 0);
    } finally {
      stub.close();
    }
  });

  it('refuses an unattended run against an Alertmanager that relays somewhere real', async () => {
    // Every PRL_ALERT_* at its default, and the Alertmanager config says real. The Alertmanager decides.
    const stub = await startStubAlertmanager({ config: REAL_ALERTMANAGER_CONFIG });
    try {
      const run = await runCommand(['--alertmanager', stub.url, '--within', '5s'], {
        PRL_ALERT_ACK_UNATTENDED: '1',
      });
      assert.equal(run.status, 1, run.output);
      assert.match(run.output, /can reach a destination that is not a sink/);
      assert.match(run.output, /this run pages a REAL destination/);
      assert.match(run.output, /smtp\.sendgrid\.example:587/);
      assert.equal(stub.posted.length, 0, 'a page was sent to a real destination by an unattended run');
    } finally {
      stub.close();
    }
  });

  it('refuses an unattended run when the Alertmanager will not say what it is configured for', async () => {
    // Fail closed. A status endpoint that 404s means real.
    const server = createServer((request, response) => {
      if (request.method === 'POST') return void response.writeHead(200).end('{}');
      response.writeHead(404).end('{}');
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    try {
      const run = await runCommand(
        ['--alertmanager', `http://127.0.0.1:${server.address().port}`, '--within', '5s'],
        { PRL_ALERT_ACK_UNATTENDED: '1' },
      );
      assert.equal(run.status, 1, run.output);
      assert.match(run.output, /did not report a configuration/);
    } finally {
      server.close();
    }
  });

  it('passes an unattended rehearsal, and never prints the code while doing it', async (context) => {
    // The whole passing path of `main()`. The code from the record must appear nowhere in stdout,
    // because a robot can scrape it from there.
    for (const port of SINK_PORTS) {
      if (await portIsFree(port)) continue;
      context.skip(
        `port ${port} is in use, so this test cannot run the command's own rehearsal sinks — an ` +
          '`alerts:verify` or `alerts:ack` run is probably still holding it. NOT a pass: the ' +
          'unattended passing path was not exercised.',
      );
      return;
    }
    const stub = await startStubAlertmanager({ config: REHEARSAL_ALERTMANAGER_CONFIG });
    const out = join(mkdtempSync(join(tmpdir(), 'prl-ack-')), 'ack.json');
    try {
      const run = await runCommand(['--alertmanager', stub.url, '--within', '30s', '--out', out], {
        PRL_ALERT_ACK_UNATTENDED: '1',
      });
      assert.equal(run.status, 0, run.output);
      const record = JSON.parse(readFileSync(out, 'utf8'));
      assert.equal(record.ok, true);
      assert.equal(record.attended, false, 'an unattended run must never be stamped attended');
      assert.equal(
        record.rehearsal,
        true,
        `rehearsal was not confirmed: ${JSON.stringify(record.rehearsalBasis)}`,
      );
      assert.equal(record.maxAttempts, MAX_ATTEMPTS);
      assert.ok(
        record.alertmanagerConfigSha256,
        'the record does not pin what the Alertmanager was configured with',
      );
      assert.equal(record.alertmanagerFrom, 'the --alertmanager flag');
      assert.match(record.caveat, /unauthenticated/);
      assert.match(record.code, /^[A-Z0-9]{6}$/);
      assert.ok(
        !run.output.includes(record.code),
        `the command printed the code:\n${run.output
          .split('\n')
          .filter((line) => line.includes(record.code))
          .join('\n')}`,
      );
      assert.match(run.output, /NO PERSON WAS INVOLVED/);
    } finally {
      stub.close();
    }
  });

  it('will not call a run a rehearsal when the page is not seen arriving', async (context) => {
    // Sinks-only config, but nothing is delivered. Stopping at the config would stamp `rehearsal: true`.
    for (const port of SINK_PORTS) {
      if (await portIsFree(port)) continue;
      context.skip(`port ${port} is in use — the sinks could not be started. NOT a pass.`);
      return;
    }
    const server = createServer((request, response) => {
      if (request.method === 'GET' && (request.url ?? '').startsWith('/api/v2/status')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ config: { original: REHEARSAL_ALERTMANAGER_CONFIG } }));
        return;
      }
      response.writeHead(200).end('{}');
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    try {
      const run = await runCommand(
        ['--alertmanager', `http://127.0.0.1:${server.address().port}`, '--within', '3s'],
        { PRL_ALERT_ACK_UNATTENDED: '1' },
      );
      assert.equal(run.status, 1, run.output);
      assert.match(run.output, /cannot be treated as a rehearsal/);
    } finally {
      server.close();
    }
  });
});

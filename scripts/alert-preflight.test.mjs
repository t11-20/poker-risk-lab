#!/usr/bin/env node
/**
 * Tests for `pnpm run alerts:preflight`. Run with `node --test scripts/alert-preflight.test.mjs`.
 *
 * Each case builds one bad configuration and asserts that the owning check goes red and names the
 * variable to change. The SMTP dialogue runs over a real socket against a relay that accepts one
 * credential. The STARTTLS case makes a certificate with `openssl` and FAILS, rather than skips,
 * when openssl is missing, so the TLS leg is always exercised.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { createServer as createTlsServer, TLSSocket } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { ALERT_DESTINATION_DEFAULTS, alertmanagerValues } from './alert-delivery.mjs';
import {
  hostsIn,
  placeholderProblem,
  routingInRenderedConfig,
  SWEPT_DESTINATIONS,
  smarthostParts,
  smtpHandshake,
  staticChecks,
  wellFormedProblem,
} from './alert-preflight.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OBSERVABILITY = join(REPO_ROOT, 'deploy', 'staging', 'observability');
const RULES = readFileSync(join(OBSERVABILITY, 'alert-rules.yml'), 'utf8');
const TEMPLATE = readFileSync(join(OBSERVABILITY, 'alertmanager.template.yml'), 'utf8');

/** `acme-poker.io`, not `example.com`, because the preflight refuses reserved domains. */
const CONFIGURED = {
  PRL_ALERT_PAGE_WEBHOOK_URL: 'https://events.pagerduty.com/v2/enqueue',
  PRL_ALERT_TICKET_WEBHOOK_URL: 'https://hooks.jira.acme-poker.io/intake/alerts',
  // `https`, because a ping URL is a credential.
  PRL_ALERT_HEARTBEAT_WEBHOOK_URL: 'https://nosnch.in/c7f2a1b93d',
  PRL_ALERT_HEARTBEAT_INTERVAL: '1m',
  PRL_ALERT_PAGE_EMAIL_TO: 'oncall@acme-poker.io',
  PRL_ALERT_TICKET_EMAIL_TO: 'tickets@acme-poker.io',
  PRL_ALERT_SMTP_SMARTHOST: 'smtp.acme-poker.io:587',
  PRL_ALERT_EMAIL_FROM: 'alertmanager@acme-poker.io',
  PRL_ALERT_SMTP_HELLO: 'deploy-1.acme-poker.io',
  PRL_ALERT_SMTP_REQUIRE_TLS: 'true',
  PRL_ALERT_SMTP_USERNAME: 'prl-alerts',
};

function analyse(overrides = {}, { password = 'a-real-looking-secret', template = TEMPLATE } = {}) {
  const { values, overridden } = alertmanagerValues({ ...CONFIGURED, ...overrides });
  return staticChecks({ values, overridden, password, rulesText: RULES, template });
}

function check(checks, fragment) {
  const found = checks.find((entry) => entry.name.includes(fragment));
  assert.ok(found !== undefined, `no check matching ${fragment}; have: ${checks.map((c) => c.name)}`);
  return found;
}

const problemText = (checks, fragment) => (check(checks, fragment).problems ?? []).join(' | ');

describe('a configured deployment passes every static check', () => {
  it('accepts a plausible real configuration', () => {
    for (const entry of analyse()) {
      assert.ok(entry.ok, `${entry.name} — ${(entry.problems ?? []).join('; ')}`);
    }
  });

  it('accepts a deployment that pages by webhook alone', () => {
    // Dropping one transport keeps the tier's other one, so a webhook-only deployment must pass.
    const checks = analyse({ PRL_ALERT_PAGE_EMAIL_TO: '', PRL_ALERT_TICKET_EMAIL_TO: '' });
    for (const entry of checks) {
      assert.ok(entry.ok, `${entry.name} — ${(entry.problems ?? []).join('; ')}`);
    }
  });
});

describe('NEGATIVE CONTROL: a placeholder receiver', () => {
  it('refuses a run in which nothing at all was configured', () => {
    // A fresh checkout. Every destination is `alerts:verify`'s own sink.
    const { values, overridden } = alertmanagerValues({});
    const checks = staticChecks({
      values,
      overridden,
      password: '',
      rulesText: RULES,
      template: TEMPLATE,
    });
    assert.equal(check(checks, 'came from the environment').ok, false);
    assert.match(problemText(checks, 'came from the environment'), /not one PRL_ALERT_\* variable is set/);
  });

  it('refuses each rehearsal default individually, by name', () => {
    // One at a time, so five of six configured is still refused on the sixth.
    for (const name of SWEPT_DESTINATIONS) {
      const checks = analyse({ [name]: ALERT_DESTINATION_DEFAULTS[name] });
      assert.equal(check(checks, 'no destination is a placeholder').ok, false, name);
      assert.match(problemText(checks, 'no destination is a placeholder'), new RegExp(name));
    }
  });

  it('refuses a reserved documentation domain, which can never receive anything', () => {
    const checks = analyse({ PRL_ALERT_PAGE_EMAIL_TO: 'oncall@poker-risk-lab.invalid' });
    assert.match(problemText(checks, 'no destination is a placeholder'), /reserved for documentation/);
  });

  it('refuses an address that names the machine the rehearsal ran on', () => {
    const checks = analyse({ PRL_ALERT_SMTP_SMARTHOST: 'host.docker.internal:1025' });
    assert.match(problemText(checks, 'no destination is a placeholder'), /names the machine this runs on/);
  });

  it('refuses a marker somebody was supposed to replace', () => {
    const checks = analyse({ PRL_ALERT_PAGE_WEBHOOK_URL: 'https://events.pagerduty.com/<routing-key>' });
    assert.match(problemText(checks, 'no destination is a placeholder'), /meant to replace/);
  });

  it('refuses the words people type when they mean "later"', () => {
    const checks = analyse({ PRL_ALERT_TICKET_EMAIL_TO: 'changeme@acme-poker.io' });
    assert.match(problemText(checks, 'no destination is a placeholder'), /reads as a placeholder/);
  });

  it('does not refuse a real host whose name merely contains those letters', () => {
    // A false refusal gets the gate switched off, which is why the word list uses lookaround.
    for (const value of ['alerts@foobar-systems.io', 'oncall@barclay.io', 'x@sampler.dev']) {
      assert.equal(placeholderProblem('PRL_ALERT_PAGE_EMAIL_TO', value), null, value);
    }
  });

  it('checks every address in a comma-separated recipient list, not just the first', () => {
    const checks = analyse({ PRL_ALERT_PAGE_EMAIL_TO: 'oncall@acme-poker.io, oncall@example.com' });
    assert.match(problemText(checks, 'no destination is a placeholder'), /example\.com/);
  });

  it('refuses a sweep that examined nothing', () => {
    // All destinations empty must not pass the sweep vacuously.
    const checks = analyse({
      PRL_ALERT_PAGE_WEBHOOK_URL: '',
      PRL_ALERT_TICKET_WEBHOOK_URL: '',
      PRL_ALERT_HEARTBEAT_WEBHOOK_URL: '',
      PRL_ALERT_PAGE_EMAIL_TO: '',
      PRL_ALERT_TICKET_EMAIL_TO: '',
      PRL_ALERT_SMTP_SMARTHOST: '',
      PRL_ALERT_EMAIL_FROM: '',
    });
    assert.equal(check(checks, 'no destination is a placeholder').ok, false);
    assert.match(problemText(checks, 'no destination is a placeholder'), /examined nothing/);
  });
});

describe('NEGATIVE CONTROL: a missing credential', () => {
  it('refuses a username with no password', () => {
    const checks = analyse({}, { password: '' });
    assert.equal(check(checks, 'credentials the relay will ask for').ok, false);
    assert.match(
      problemText(checks, 'credentials the relay will ask for'),
      /PRL_ALERT_SMTP_PASSWORD is empty/,
    );
  });

  it('refuses a password with no username, which is never sent', () => {
    const checks = analyse({ PRL_ALERT_SMTP_USERNAME: '' }, { password: 'a-real-looking-secret' });
    assert.match(problemText(checks, 'credentials the relay will ask for'), /never sent/);
  });

  it('refuses a submission port with no credentials at all', () => {
    // RFC 6409 submission requires authentication.
    const checks = analyse({ PRL_ALERT_SMTP_USERNAME: '' }, { password: '' });
    assert.match(problemText(checks, 'credentials the relay will ask for'), /RFC 6409/);
  });

  it('refuses a password that is a placeholder word, without printing it', () => {
    const checks = analyse({}, { password: 'changeme' });
    const text = problemText(checks, 'credentials the relay will ask for');
    assert.match(text, /reads as a placeholder/);
    assert.ok(!text.includes('changeme'), 'the preflight must never echo the password');
  });

  it('accepts an unauthenticated relay on this host, which is a legitimate deployment', () => {
    // A loopback relay needs no credential and no TLS.
    const checks = analyse(
      {
        PRL_ALERT_SMTP_SMARTHOST: '127.0.0.1:25',
        PRL_ALERT_SMTP_USERNAME: '',
        PRL_ALERT_SMTP_REQUIRE_TLS: 'false',
      },
      { password: '' },
    );
    assert.equal(check(checks, 'credentials the relay will ask for').ok, true);
    assert.equal(check(checks, 'in the clear').ok, true);
    // The smarthost is still a local name, so the placeholder sweep refuses it.
    assert.equal(check(checks, 'no destination is a placeholder').ok, false);
  });
});

describe('NEGATIVE CONTROL: a tier that routes nowhere', () => {
  it('refuses a paging receiver left with no destination in it', () => {
    // Renders to `- name: paging` with nothing underneath, which Alertmanager loads.
    const checks = analyse({ PRL_ALERT_PAGE_WEBHOOK_URL: '', PRL_ALERT_PAGE_EMAIL_TO: '' });
    assert.equal(check(checks, 'resolves to a receiver with a destination').ok, false);
    assert.match(
      problemText(checks, 'resolves to a receiver with a destination'),
      /has no destination in it/,
    );
  });

  it('refuses a route tree with no branch for the paging tier', () => {
    // Without the `severity = "page"` branch, every page falls to the catch-all as a ticket.
    const withoutPage = TEMPLATE.replace(
      /- matchers:\n\s+- severity = "page"\n\s+receiver: paging\n\s+continue: false\n\s+group_wait: 5s\n/,
      '',
    );
    assert.ok(!withoutPage.includes('severity = "page"'), 'the fixture did not remove the route');
    const checks = analyse({}, { template: withoutPage });
    assert.equal(check(checks, 'resolves to a receiver with a destination').ok, false);
    assert.match(
      problemText(checks, 'resolves to a receiver with a destination'),
      /severity page matches no route/,
    );
  });

  it('refuses a route that points at a receiver which does not exist', () => {
    const misdirected = TEMPLATE.replace(
      'receiver: paging\n      continue: false',
      'receiver: pagingg\n      continue: false',
    );
    const checks = analyse({}, { template: misdirected });
    assert.match(problemText(checks, 'resolves to a receiver with a destination'), /which does not exist/);
  });

  it('requires both tiers to resolve even if the rules file stopped using one', () => {
    // Both tiers must resolve even when no rule uses one.
    const ticketsOnly = RULES.replace(/severity: page/g, 'severity: ticket');
    const { values, overridden } = alertmanagerValues({
      ...CONFIGURED,
      PRL_ALERT_PAGE_WEBHOOK_URL: '',
      PRL_ALERT_PAGE_EMAIL_TO: '',
    });
    const checks = staticChecks({
      values,
      overridden,
      password: 'a-real-looking-secret',
      rulesText: ticketsOnly,
      template: TEMPLATE,
    });
    assert.match(problemText(checks, 'resolves to a receiver with a destination'), /severity page routes/);
  });

  it('refuses a rules file that parsed to nothing', () => {
    const checks = analyse({}, {});
    assert.equal(check(checks, 'resolves to a receiver with a destination').ok, true);
    const { values, overridden } = alertmanagerValues(CONFIGURED);
    const empty = staticChecks({
      values,
      overridden,
      password: 'a-real-looking-secret',
      rulesText: 'groups: []\n',
      template: TEMPLATE,
    });
    assert.match(problemText(empty, 'resolves to a receiver with a destination'), /analysis of nothing/);
  });
});

describe('NEGATIVE CONTROL: the two tiers collapse into one', () => {
  it('refuses a pager and a ticket queue that are the same address', () => {
    const checks = analyse({ PRL_ALERT_TICKET_EMAIL_TO: 'oncall@acme-poker.io' });
    assert.equal(check(checks, 'different destinations').ok, false);
    assert.match(problemText(checks, 'different destinations'), /every ticket would wake somebody/);
  });
});

describe("NEGATIVE CONTROL: a dead man's switch that watches nothing", () => {
  it('refuses a heartbeat still pointed at the machine somebody rehearsed on', () => {
    // A placeholder heartbeat is never discovered from inside the deployment.
    const checks = analyse({
      PRL_ALERT_HEARTBEAT_WEBHOOK_URL: ALERT_DESTINATION_DEFAULTS.PRL_ALERT_HEARTBEAT_WEBHOOK_URL,
    });
    assert.equal(check(checks, 'no destination is a placeholder').ok, false);
    assert.match(problemText(checks, 'no destination is a placeholder'), /PRL_ALERT_HEARTBEAT_WEBHOOK_URL/);
  });

  it('refuses a heartbeat pointed at a human tier', () => {
    // `Watchdog` repeats every interval, so the pager would get muted.
    const checks = analyse({ PRL_ALERT_HEARTBEAT_WEBHOOK_URL: CONFIGURED.PRL_ALERT_PAGE_WEBHOOK_URL });
    assert.equal(check(checks, 'different destinations').ok, false);
    assert.match(problemText(checks, 'different destinations'), /heartbeat fires\s+forever/);
  });

  it('refuses a snitch pinged over plaintext, because the ping URL is the credential', () => {
    const checks = analyse({ PRL_ALERT_HEARTBEAT_WEBHOOK_URL: 'http://nosnch.in/c7f2a1b93d' });
    assert.equal(check(checks, 'in the clear').ok, false);
    assert.match(problemText(checks, 'in the clear'), /ping URL is its credential/);
  });

  it('refuses a deployment with no heartbeat destination at all', () => {
    const checks = analyse({ PRL_ALERT_HEARTBEAT_WEBHOOK_URL: '' });
    assert.equal(check(checks, 'every tier has a destination').ok, false);
    assert.match(
      problemText(checks, 'every tier has a destination'),
      /PRL_ALERT_HEARTBEAT_WEBHOOK_URL is empty/,
    );
  });

  it('follows severity: heartbeat to a receiver that has somewhere to send', () => {
    const checks = analyse();
    assert.equal(check(checks, 'resolves to a receiver with a destination').ok, true);
    assert.match(check(checks, 'resolves to a receiver with a destination').detail, /3 severities/);
    assert.match(check(checks, 'resolves to a receiver with a destination').detail, /heartbeat:1/);
  });
});

describe('NEGATIVE CONTROL: an alert body in the clear', () => {
  it('refuses cleartext SMTP to a relay that is not on this host', () => {
    const checks = analyse({ PRL_ALERT_SMTP_REQUIRE_TLS: 'false' });
    assert.equal(check(checks, 'in the clear').ok, false);
    assert.match(problemText(checks, 'in the clear'), /PRL_ALERT_SMTP_REQUIRE_TLS is "false"/);
  });

  it('refuses a plaintext http webhook to a remote host', () => {
    const checks = analyse({ PRL_ALERT_TICKET_WEBHOOK_URL: 'http://hooks.acme-poker.io/intake' });
    assert.match(problemText(checks, 'in the clear'), /plaintext http/);
  });
});

describe('malformed values', () => {
  it('names the shape each destination must have', () => {
    assert.match(wellFormedProblem('PRL_ALERT_PAGE_WEBHOOK_URL', 'events.pagerduty.com'), /is not a URL/);
    assert.match(wellFormedProblem('PRL_ALERT_PAGE_WEBHOOK_URL', 'ftp://a.io/x'), /not an http\(s\) URL/);
    assert.match(wellFormedProblem('PRL_ALERT_PAGE_EMAIL_TO', 'oncall'), /is not an email address/);
    assert.match(
      wellFormedProblem('PRL_ALERT_PAGE_EMAIL_TO', 'oncall@localdomain'),
      /is not an email address/,
    );
    // Alertmanager does not default the SMTP port, so a bare hostname fails at notification time.
    assert.match(wellFormedProblem('PRL_ALERT_SMTP_SMARTHOST', 'smtp.acme-poker.io'), /needs host:port/);
    assert.match(wellFormedProblem('PRL_ALERT_SMTP_SMARTHOST', 'smtp.acme-poker.io:0'), /is not host:port/);
    assert.match(
      wellFormedProblem('PRL_ALERT_SMTP_SMARTHOST', 'smtp.acme-poker.io:https'),
      /is not host:port/,
    );
  });

  it('accepts the shapes a deployment legitimately has', () => {
    assert.equal(wellFormedProblem('PRL_ALERT_PAGE_EMAIL_TO', 'a@b.io, c@d.io'), null);
    assert.equal(wellFormedProblem('PRL_ALERT_SMTP_SMARTHOST', '[2001:db8::1]:587'), null);
    assert.deepEqual(smarthostParts('[2001:db8::1]:587'), { host: '2001:db8::1', port: 587 });
    assert.deepEqual(hostsIn('PRL_ALERT_PAGE_EMAIL_TO', 'a@b.io, c@d.io'), ['b.io', 'd.io']);
  });
});

describe('routingInRenderedConfig', () => {
  it('counts destinations rather than transport headers', () => {
    // Counting `webhook_configs:` headers would pass an empty one.
    const parsed = routingInRenderedConfig(
      [
        'route:',
        '  receiver: tickets',
        '  routes:',
        '    - matchers:',
        '        - severity = "page"',
        '      receiver: paging',
        'receivers:',
        '  - name: paging',
        '    webhook_configs:',
        '  - name: tickets',
        '    email_configs:',
        '      - to: tickets@acme-poker.io',
      ].join('\n'),
    );
    assert.equal(parsed.defaultReceiver, 'tickets');
    assert.deepEqual(parsed.routes, [{ severity: 'page', receiver: 'paging' }]);
    assert.equal(parsed.receivers.get('paging'), 0);
    assert.equal(parsed.receivers.get('tickets'), 1);
  });

  it('ignores the template prose, which quotes the keys it documents', () => {
    // The rendered header contains lines like `# | PRL_ALERT_PAGE_EMAIL_TO | … |`, which must not be read.
    const parsed = routingInRenderedConfig(
      ['# receivers:', '#   - name: ghost', 'route:', '  receiver: tickets', 'receivers:'].join('\n'),
    );
    assert.equal(parsed.receivers.has('ghost'), false);
  });
});

/**
 * `secure` swaps `net` for `tls` to exercise port 465. `smtpHandshake` has no way to turn certificate
 * verification off, so an unverified relay can never pass.
 */
function startRelay({
  username = 'prl-alerts',
  password = 'right',
  secure = null,
  mechanisms = 'PLAIN LOGIN',
} = {}) {
  const expected = Buffer.from(`\0${username}\0${password}`, 'utf8').toString('base64');
  const handle = (socket) => {
    let buffer = '';
    let awaiting = null;
    const say = (line) => socket.write(`${line}\r\n`);
    say('220 relay-under-test ESMTP ready');
    socket.on('error', () => {
      // A client that vanishes is under test here, and an unhandled ECONNRESET would end the run.
    });
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1');
      for (;;) {
        const end = buffer.indexOf('\r\n');
        if (end === -1) break;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (awaiting === 'username') {
          awaiting = 'password';
          say('334 UGFzc3dvcmQ6');
          continue;
        }
        if (awaiting === 'password') {
          awaiting = null;
          const given = Buffer.from(line.trim(), 'base64').toString('utf8');
          say(given === password ? '235 2.7.0 Authentication successful' : '535 5.7.8 not accepted');
          continue;
        }
        const verb = line.split(' ', 1)[0].toUpperCase();
        if (verb === 'EHLO') {
          const advertised = mechanisms === '' ? [] : [`250-AUTH ${mechanisms}`];
          socket.write(['250-relay-under-test', ...advertised, '250 SIZE 33554432', ''].join('\r\n'));
        } else if (verb === 'AUTH' && line.toUpperCase().startsWith('AUTH LOGIN')) {
          awaiting = 'username';
          say('334 VXNlcm5hbWU6');
        } else if (verb === 'AUTH') {
          say(
            line.trim() === `AUTH PLAIN ${expected}`
              ? '235 2.7.0 Authentication successful'
              : '535 5.7.8 not accepted',
          );
        } else if (verb === 'QUIT') {
          say('221 2.0.0 Bye');
          socket.end();
          return;
        } else {
          say('502 5.5.1 Command not implemented');
        }
      }
    });
  };
  const server = secure === null ? createServer(handle) : createTlsServer(secure, handle);
  return new Promise((done, failed) => {
    server.on('error', failed);
    server.listen(0, '127.0.0.1', () => done({ port: server.address().port, close: () => server.close() }));
  });
}

/**
 * Offers AUTH only after the upgrade, as real relays do. `ehlos()` records which side each greeting
 * arrived on, so the test asserts the sequence.
 */
function startStartTlsRelay({ key, cert, username = 'prl-alerts', password = 'right' }) {
  const expected = Buffer.from(`\0${username}\0${password}`, 'utf8').toString('base64');
  const greetings = [];
  const speak = (socket, phase) => {
    let buffer = '';
    const say = (line) => socket.write(`${line}\r\n`);
    socket.on('error', () => {
      // See `startRelay`.
    });
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1');
      for (;;) {
        const end = buffer.indexOf('\r\n');
        if (end === -1) break;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const verb = line.split(' ', 1)[0].toUpperCase();
        if (verb === 'EHLO') {
          greetings.push(phase);
          socket.write(
            phase === 'cleartext'
              ? '250-relay-under-test\r\n250-STARTTLS\r\n250 SIZE 33554432\r\n'
              : '250-relay-under-test\r\n250-AUTH PLAIN\r\n250 SIZE 33554432\r\n',
          );
        } else if (verb === 'STARTTLS' && phase === 'cleartext') {
          say('220 2.0.0 Ready to start TLS');
          socket.removeAllListeners('data');
          speak(new TLSSocket(socket, { isServer: true, key, cert }), 'secure');
          return;
        } else if (verb === 'AUTH' && phase === 'secure') {
          say(
            line.trim() === `AUTH PLAIN ${expected}` ? '235 2.7.0 Authentication successful' : '535 5.7.8 no',
          );
        } else if (verb === 'QUIT') {
          say('221 2.0.0 Bye');
          socket.end();
          return;
        } else {
          say('502 5.5.1 Command not implemented');
        }
      }
    });
  };
  const server = createServer((socket) => {
    socket.write('220 relay-under-test ESMTP ready\r\n');
    speak(socket, 'cleartext');
  });
  return new Promise((done, failed) => {
    server.on('error', failed);
    server.listen(0, '127.0.0.1', () =>
      done({ port: server.address().port, ehlos: () => greetings, close: () => server.close() }),
    );
  });
}

/** Fails hard when openssl is absent. See the header. */
function selfSignedCertificate() {
  const version = spawnSync('openssl', ['version'], { encoding: 'utf8' });
  assert.equal(
    version.status,
    0,
    'openssl is not on PATH. This is a failure and not a skip: the TLS leg of the handshake would ' +
      'go unexercised and the run would still report green. scripts/staging.mjs needs openssl too.',
  );
  const directory = mkdtempSync(join(tmpdir(), 'prl-preflight-tls-'));
  const key = join(directory, 'key.pem');
  const cert = join(directory, 'cert.pem');
  const made = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-keyout',
      key,
      '-out',
      cert,
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(made.status, 0, `openssl could not make a certificate: ${made.stderr}`);
  return {
    directory,
    key: readFileSync(key, 'utf8'),
    cert: readFileSync(cert, 'utf8'),
  };
}

describe('the handshake stops at AUTH and reports what the relay said', () => {
  const cleanup = [];
  after(() => {
    for (const remove of cleanup) remove();
  });

  it('accepts a credential the relay accepts', async () => {
    const relay = await startRelay();
    try {
      const result = await smtpHandshake({
        host: '127.0.0.1',
        port: relay.port,
        username: 'prl-alerts',
        password: 'right',
        requireTls: false,
      });
      assert.equal(result.ok, true, result.problem ?? '');
      assert.equal(result.authenticated, true);
      assert.ok(result.steps.some((step) => step.includes('AUTH accepted')));
      // The report is attached to promotions, so the password must not be in it.
      assert.ok(!JSON.stringify(result).includes('right'), 'the password reached the report');
    } finally {
      relay.close();
    }
  });

  it('REFUSES a credential the relay rejects, and quotes the 535', async () => {
    // Without the handshake, a wrong password looks healthy until an alert is not delivered.
    const relay = await startRelay();
    try {
      const result = await smtpHandshake({
        host: '127.0.0.1',
        port: relay.port,
        username: 'prl-alerts',
        password: 'wrong',
        requireTls: false,
      });
      assert.equal(result.ok, false);
      assert.equal(result.authenticated, false);
      assert.match(result.problem, /535/);
    } finally {
      relay.close();
    }
  });

  it('speaks AUTH LOGIN when that is all the relay offers', async () => {
    const relay = await startRelay({ mechanisms: 'LOGIN' });
    try {
      const result = await smtpHandshake({
        host: '127.0.0.1',
        port: relay.port,
        username: 'prl-alerts',
        password: 'right',
        requireTls: false,
      });
      assert.equal(result.ok, true, result.problem ?? '');
      assert.equal(result.authenticated, true);
    } finally {
      relay.close();
    }
  });

  it('REFUSES a relay that advertises no mechanism this deployment can use', async () => {
    // `smtp_auth_password_file` satisfies neither, so Alertmanager would send unauthenticated.
    const relay = await startRelay({ mechanisms: 'CRAM-MD5' });
    try {
      const result = await smtpHandshake({
        host: '127.0.0.1',
        port: relay.port,
        username: 'prl-alerts',
        password: 'right',
        requireTls: false,
      });
      assert.equal(result.ok, false);
      assert.match(result.problem, /no AUTH mechanism this can use/);
    } finally {
      relay.close();
    }
  });

  it('REFUSES a relay with no STARTTLS when TLS is required', async () => {
    // Alertmanager refuses to send rather than downgrade.
    const relay = await startRelay({ mechanisms: '' });
    try {
      const result = await smtpHandshake({
        host: '127.0.0.1',
        port: relay.port,
        requireTls: true,
      });
      assert.equal(result.ok, false);
      assert.match(result.problem, /does not advertise STARTTLS/);
    } finally {
      relay.close();
    }
  });

  it('reports a relay nothing is listening on rather than hanging', async () => {
    const relay = await startRelay();
    const port = relay.port;
    relay.close();
    const result = await smtpHandshake({ host: '127.0.0.1', port, requireTls: false, timeoutMs: 4000 });
    assert.equal(result.ok, false);
    assert.match(result.problem, /ECONNREFUSED|closed|timed out|within/);
  });

  it('negotiates implicit TLS and authenticates over it', async () => {
    const tls = selfSignedCertificate();
    cleanup.push(() => rmSync(tls.directory, { recursive: true, force: true }));
    const relay = await startRelay({ secure: { key: tls.key, cert: tls.cert } });
    try {
      const result = await smtpHandshake({
        host: '127.0.0.1',
        port: relay.port,
        implicitTls: true,
        username: 'prl-alerts',
        password: 'right',
        // Passing a `ca` exercises verification against the throwaway root.
        ca: tls.cert,
      });
      assert.equal(result.ok, true, result.problem ?? '');
      assert.equal(result.tls, 'implicit');
      assert.equal(result.authenticated, true);
    } finally {
      relay.close();
    }
  });

  it('REFUSES a TLS relay whose certificate does not verify', async () => {
    // Trust anchor withheld, so the self-signed leaf fails as a machine in the middle would.
    const tls = selfSignedCertificate();
    cleanup.push(() => rmSync(tls.directory, { recursive: true, force: true }));
    const relay = await startRelay({ secure: { key: tls.key, cert: tls.cert } });
    try {
      const result = await smtpHandshake({
        host: '127.0.0.1',
        port: relay.port,
        implicitTls: true,
        username: 'prl-alerts',
        password: 'right',
      });
      assert.equal(result.ok, false);
      assert.match(result.problem, /self.signed|unable to verify|certificate/i);
      assert.equal(result.authenticated, false);
    } finally {
      relay.close();
    }
  });

  it('upgrades a cleartext connection with STARTTLS before it authenticates', async () => {
    // RFC 3207 requires a second EHLO after the upgrade.
    const tls = selfSignedCertificate();
    cleanup.push(() => rmSync(tls.directory, { recursive: true, force: true }));
    const relay = await startStartTlsRelay({ key: tls.key, cert: tls.cert });
    try {
      const result = await smtpHandshake({
        host: '127.0.0.1',
        port: relay.port,
        username: 'prl-alerts',
        password: 'right',
        requireTls: true,
        ca: tls.cert,
      });
      assert.equal(result.ok, true, result.problem ?? '');
      assert.equal(result.tls, 'starttls');
      assert.equal(result.authenticated, true);
      assert.ok(result.steps.some((step) => step.includes('STARTTLS negotiated')));
      assert.deepEqual(relay.ehlos(), ['cleartext', 'secure']);
    } finally {
      relay.close();
    }
  });
});

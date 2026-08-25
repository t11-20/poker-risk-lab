#!/usr/bin/env node
/**
 * Tests for the refusals behind `pnpm run alerts:preflight`.
 *
 * Run with:  node --test scripts/alert-preflight.test.mjs
 *
 * ## Why every case here is a NEGATIVE control
 *
 * `alert-preflight.mjs` exists to refuse four configurations that are otherwise
 * indistinguishable from a working one: a placeholder receiver, a missing
 * credential, a tier that routes nowhere, and a relay that will not accept these
 * credentials. Every one of them produces an Alertmanager that starts, reports
 * itself healthy, routes by severity exactly as designed, and notifies nobody. There
 * is no observation from inside the deployment that tells them apart from a quiet
 * night, which is why the gate has to be a refusal rather than a warning.
 *
 * A gate like that is worth precisely what its failing cases are worth. So the tests
 * below are not "does a good configuration pass" — that is one case at the top and
 * it is the cheap half. They are constructions of each bad configuration, asserting
 * that the specific check that owns it goes red and that the message names the
 * variable somebody has to change. Against the code as it was before this file
 * existed — no preflight at all — every one of them was a promotion.
 *
 * ## Why the SMTP dialogue is driven over a real socket
 *
 * The same reason `alert-delivery.test.mjs` gives for its sink: the alternative
 * place to discover a bug in a protocol implementation is in production, at the
 * moment somebody is trying to find out why they were not paged. The relay below is
 * a few dozen lines of `node:net` that answers `235` to one credential and `535` to
 * every other, so "the handshake reports a rejected password" is an observed
 * behaviour rather than a claim about a code path.
 *
 * The STARTTLS case needs a certificate, so it makes one with `openssl` — the same
 * dependency `scripts/staging.mjs` already has for the staging origin. If openssl is
 * missing the test FAILS rather than skipping: a TLS upgrade that was never
 * exercised is exactly the kind of thing that is discovered to have never worked,
 * and a green suite that quietly checked less is the failure mode this whole
 * repository is written against.
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

/**
 * A configuration a real deployment could plausibly have, used as the baseline every
 * case below breaks exactly one thing in.
 *
 * The domain is `acme-poker.io` rather than `example.com` on purpose: the preflight
 * refuses reserved documentation domains, so a fixture built on one would make every
 * test pass for the wrong reason and the negative controls would prove nothing.
 */
const CONFIGURED = {
  PRL_ALERT_PAGE_WEBHOOK_URL: 'https://events.pagerduty.com/v2/enqueue',
  PRL_ALERT_TICKET_WEBHOOK_URL: 'https://hooks.jira.acme-poker.io/intake/alerts',
  PRL_ALERT_PAGE_EMAIL_TO: 'oncall@acme-poker.io',
  PRL_ALERT_TICKET_EMAIL_TO: 'tickets@acme-poker.io',
  PRL_ALERT_SMTP_SMARTHOST: 'smtp.acme-poker.io:587',
  PRL_ALERT_EMAIL_FROM: 'alertmanager@acme-poker.io',
  PRL_ALERT_SMTP_HELLO: 'deploy-1.acme-poker.io',
  PRL_ALERT_SMTP_REQUIRE_TLS: 'true',
  PRL_ALERT_SMTP_USERNAME: 'prl-alerts',
};

/** The static half of the preflight, over an environment this test invents. */
function analyse(overrides = {}, { password = 'a-real-looking-secret', template = TEMPLATE } = {}) {
  const { values, overridden } = alertmanagerValues({ ...CONFIGURED, ...overrides });
  return staticChecks({ values, overridden, password, rulesText: RULES, template });
}

/** The named check, or a failure that says which names do exist. */
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
    // Dropping a transport must not read as dropping a destination: a tier keeps its
    // other one. Asserted because the placeholder sweep counts what it examined, and
    // an off-by-one there would refuse a legitimate webhook-only deployment.
    const checks = analyse({ PRL_ALERT_PAGE_EMAIL_TO: '', PRL_ALERT_TICKET_EMAIL_TO: '' });
    for (const entry of checks) {
      assert.ok(entry.ok, `${entry.name} — ${(entry.problems ?? []).join('; ')}`);
    }
  });
});

describe('NEGATIVE CONTROL: a placeholder receiver', () => {
  it('refuses a run in which nothing at all was configured', () => {
    // The shipped state of a fresh checkout, and the single most likely thing to be
    // promoted by accident. Every destination is `alerts:verify`'s own sink.
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
    // One at a time, so that a deployment which configured five of six is still
    // refused on the sixth. The failure this models is a partial edit, which is more
    // likely than a total one and much harder to see.
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
    // The one that actually happens: `host.docker.internal` works perfectly on the
    // laptop and is not a name at all on the deploy host.
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
    // The other half of the guard, and the reason the word list uses lookaround
    // rather than substring matching. A gate that refuses correct configurations is a
    // gate somebody switches off, and then it protects nothing.
    for (const value of ['alerts@foobar-systems.io', 'oncall@barclay.io', 'x@sampler.dev']) {
      assert.equal(placeholderProblem('PRL_ALERT_PAGE_EMAIL_TO', value), null, value);
    }
  });

  it('checks every address in a comma-separated recipient list, not just the first', () => {
    // One real address beside one placeholder is not half a working pager. It is a
    // pager whose second recipient bounces on every notification.
    const checks = analyse({ PRL_ALERT_PAGE_EMAIL_TO: 'oncall@acme-poker.io, oncall@example.com' });
    assert.match(problemText(checks, 'no destination is a placeholder'), /example\.com/);
  });

  it('refuses a sweep that examined nothing', () => {
    // Every destination empty satisfies "no placeholder found" vacuously. The same
    // principle `secret-scan.mjs` states for itself: a sweep of nothing is not a pass.
    const checks = analyse({
      PRL_ALERT_PAGE_WEBHOOK_URL: '',
      PRL_ALERT_TICKET_WEBHOOK_URL: '',
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
    // Alertmanager authenticates with the empty string, the relay answers 535, and
    // the only record of it is a line in a log nobody is watching at 3am.
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
    // RFC 6409 submission requires authentication. A deployment pointed at :587 with
    // no username has a relay that will refuse every notification it is ever sent.
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
    // A relay on the same machine, reached over loopback, needs no credential and no
    // TLS. Refusing it would be wrong, and the checks that guard the remote case must
    // not fire here.
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
    // …but the smarthost is still a local name, so the placeholder sweep refuses it
    // as a destination. That is the correct split: the credential rules are satisfied
    // and the destination is still not one a deployment can page through.
    assert.equal(check(checks, 'no destination is a placeholder').ok, false);
  });
});

describe('NEGATIVE CONTROL: a tier that routes nowhere', () => {
  it('refuses a paging receiver left with no destination in it', () => {
    // Renders to `- name: paging` with nothing underneath. Alertmanager loads that
    // without complaint, routes `severity: page` to it, and drops the notification.
    const checks = analyse({ PRL_ALERT_PAGE_WEBHOOK_URL: '', PRL_ALERT_PAGE_EMAIL_TO: '' });
    assert.equal(check(checks, 'resolves to a receiver with a destination').ok, false);
    assert.match(
      problemText(checks, 'resolves to a receiver with a destination'),
      /has no destination in it/,
    );
  });

  it('refuses a route tree with no branch for the paging tier', () => {
    // The template with its `severity = "page"` branch deleted. Everything else is
    // valid: the receiver exists, has two destinations, and is never reached — every
    // page falls to the catch-all and is filed as a ticket instead of waking anybody.
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
    // A rules file with no paging rule left in it would make "every severity the
    // rules use resolves" vacuously true for the paging tier. The two-tier rule is a
    // property of the deployment, not of whichever rules happen to exist today.
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
    // Two identical real addresses are individually valid, present and non-placeholder.
    // What they are is the two-tier rule deleted: every ticket wakes somebody.
    const checks = analyse({ PRL_ALERT_TICKET_EMAIL_TO: 'oncall@acme-poker.io' });
    assert.equal(check(checks, 'different destinations').ok, false);
    assert.match(problemText(checks, 'different destinations'), /every ticket would wake somebody/);
  });
});

describe('NEGATIVE CONTROL: an alert body in the clear', () => {
  it('refuses cleartext SMTP to a relay that is not on this host', () => {
    // Alertmanager's default body names the instance, the job, the threshold that
    // tripped and the runbook — a description of how to attack this deployment,
    // written at the moment it is least able to cope.
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
    // The one that reaches production: Alertmanager does not default the SMTP port,
    // and a bare hostname makes it fail at notification time rather than at load.
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
    // A `webhook_configs:` with nothing under it is valid YAML and is exactly the
    // shape of a receiver that notifies nobody, so counting headers would pass it.
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
    // The rendered file keeps the template's comment header, and that header contains
    // lines like `# | PRL_ALERT_PAGE_EMAIL_TO | … |`. A scanner that read comments
    // would find receivers and routes that do not exist.
    const parsed = routingInRenderedConfig(
      ['# receivers:', '#   - name: ghost', 'route:', '  receiver: tickets', 'receivers:'].join('\n'),
    );
    assert.equal(parsed.receivers.has('ghost'), false);
  });
});

// ---------------------------------------------------------------------------
// The handshake, over real sockets
// ---------------------------------------------------------------------------

/**
 * A submission relay that accepts exactly one credential.
 *
 * `secure` swaps `net` for `tls`, which is how the implicit-TLS path (port 465) is
 * exercised. There is deliberately no STARTTLS here and no way to turn certificate
 * verification off in `smtpHandshake` — a preflight that accepted an unverified
 * relay would pass against a machine in the middle, which is a worse outcome than
 * failing to check at all, because it would be recorded as proof.
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
      // A client that vanishes mid-dialogue is the case under test in one of these,
      // and an unhandled ECONNRESET would take the whole test run down with it.
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
 * A relay that offers STARTTLS in cleartext and AUTH only after the upgrade.
 *
 * That ordering is the point and it is what real submission relays do: a client that
 * did not re-`EHLO` after the upgrade would see no AUTH mechanism, send the
 * notification unauthenticated, and be refused. `ehlos()` records which side of the
 * upgrade each greeting arrived on, so the test asserts the sequence rather than
 * only the outcome.
 */
function startStartTlsRelay({ key, cert, username = 'prl-alerts', password = 'right' }) {
  const expected = Buffer.from(`\0${username}\0${password}`, 'utf8').toString('base64');
  const greetings = [];
  const speak = (socket, phase) => {
    let buffer = '';
    const say = (line) => socket.write(`${line}\r\n`);
    socket.on('error', () => {
      // See `startRelay`: a client that vanishes is one of the cases under test.
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

/**
 * A throwaway self-signed certificate for 127.0.0.1, made with openssl.
 *
 * A hard failure rather than a skip when openssl is absent, for the reason at the
 * top of this file: the TLS leg is the half of the handshake that cannot be reasoned
 * about from the code, and a suite that silently stopped exercising it would report
 * the same green as one that did.
 */
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
      // The credential must not survive into the report: this JSON is meant to be
      // attachable to a promotion record.
      assert.ok(!JSON.stringify(result).includes('right'), 'the password reached the report');
    } finally {
      relay.close();
    }
  });

  it('REFUSES a credential the relay rejects, and quotes the 535', async () => {
    // The negative control the whole handshake exists for. Before it, a wrong
    // submission password was indistinguishable from a working one until an alert
    // fired and was not delivered.
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
    // CRAM-MD5 or XOAUTH2 only. Alertmanager's `smtp_auth_password_file` cannot
    // satisfy either, so it would send unauthenticated and be refused.
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
    // Alertmanager would refuse to send rather than downgrade, so this configuration
    // delivers nothing — and it looks completely healthy from every other angle.
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
        // The trust anchor is the throwaway root this test just made. Passing a `ca`
        // EXERCISES verification; there is deliberately no option that turns it off,
        // because a preflight that accepted an unverified relay would pass against a
        // machine in the middle and be recorded as proof that it had not.
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
    // The machine-in-the-middle case: something answers on the right port with an
    // identity nothing vouches for. Same relay as the test above, with the trust
    // anchor withheld, so the system store is used and the self-signed leaf fails.
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
    // RFC 3207: the client must discard everything the cleartext session advertised
    // and re-EHLO. Relays routinely offer AUTH only after the upgrade, so a client
    // that skipped the second EHLO would find no mechanism and send unauthenticated.
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
      // AUTH was advertised only after the upgrade, so this could not have succeeded
      // without the second EHLO.
      assert.deepEqual(relay.ehlos(), ['cleartext', 'secure']);
    } finally {
      relay.close();
    }
  });
});

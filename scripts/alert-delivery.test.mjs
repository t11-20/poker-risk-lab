#!/usr/bin/env node
/**
 * Tests for the parsers, the config renderer and the SMTP sink behind `pnpm run alerts:verify`.
 * Run with `node --test scripts/alert-delivery.test.mjs`.
 *
 * The verification needs a staging stack and six minutes, so this covers what it is built on. A
 * parser that finds fewer alerts makes every check pass by looking at less, and a blank destination
 * renders an Alertmanager that notifies nobody. The SMTP sink is driven over a real socket. An empty
 * parse must not read as agreement.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ALERT_DESTINATION_DEFAULTS,
  alertmanagerSeriesReferencedBy,
  alertmanagerValues,
  alertsInDocument,
  alertsInRulesFile,
  decodeQuotedPrintable,
  destinationProblems,
  durationMs,
  emailsFor,
  expressionsInRulesFile,
  heartbeatGaps,
  heartbeatProblem,
  parseMessage,
  probeSeriesReferencedBy,
  renderAlertmanagerConfig,
  runbookNamingProblems,
  runbookSection,
  seriesReferencedBy,
  startSmtpSink,
  watchForSilence,
} from './alert-delivery.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OBSERVABILITY = join(REPO_ROOT, 'deploy', 'staging', 'observability');
const RULES = readFileSync(join(OBSERVABILITY, 'alert-rules.yml'), 'utf8');
const TEMPLATE = readFileSync(join(OBSERVABILITY, 'alertmanager.template.yml'), 'utf8');
const DOC = readFileSync(join(REPO_ROOT, 'docs', 'production', 'alerts.md'), 'utf8');

/** Built rather than typed, so the linter's rule against `${…}` in plain strings stays on. */
const ref = (name) => `\${${name}}`;

describe('alertsInRulesFile', () => {
  it('reads the name, the severity and the runbook of each rule', () => {
    const parsed = alertsInRulesFile(
      [
        'groups:',
        '  - name: availability',
        '    rules:',
        '      - alert: ApiDown',
        '        expr: up == 0',
        '        for: 2m',
        '        labels:',
        '          severity: page',
        '        annotations:',
        '          runbook: docs/production/runbooks/api-unhealthy.md',
        '      - alert: ArchiveFailing',
        '        expr: rate(x[5m]) > 0',
        '        labels:',
        '          severity: ticket',
        '        annotations:',
        '          runbook: docs/production/runbooks/db-saturation.md',
      ].join('\n'),
    );
    assert.deepEqual([...parsed.keys()], ['ApiDown', 'ArchiveFailing']);
    assert.equal(parsed.get('ApiDown').severity, 'page');
    assert.equal(parsed.get('ArchiveFailing').runbook, 'docs/production/runbooks/db-saturation.md');
  });
});

describe('expressionsInRulesFile', () => {
  it('reads an inline expression', () => {
    const parsed = expressionsInRulesFile(
      ['      - alert: A', '        expr: prl_readiness_state == 0'].join('\n'),
    );
    assert.equal(parsed.get('A'), 'prl_readiness_state == 0');
  });

  it('joins a folded block scalar into one expression (REGRESSION)', () => {
    // The bug returned ' >-' for every rule written this way, and Prometheus answered 400.
    const parsed = expressionsInRulesFile(
      [
        '      - alert: HttpErrorRateHigh',
        '        expr: >-',
        '          sum(rate(prl_http_requests_total{status="5xx"}[5m]))',
        '            / sum(rate(prl_http_requests_total[5m])) > 0.02',
        '        for: 5m',
      ].join('\n'),
    );
    assert.equal(
      parsed.get('HttpErrorRateHigh'),
      'sum(rate(prl_http_requests_total{status="5xx"}[5m])) / sum(rate(prl_http_requests_total[5m])) > 0.02',
    );
  });

  it('stops the folded body at the next key rather than swallowing it', () => {
    const parsed = expressionsInRulesFile(
      [
        '      - alert: A',
        '        expr: >-',
        '          up == 0',
        '        for: 2m',
        '        labels:',
      ].join('\n'),
    );
    assert.equal(parsed.get('A'), 'up == 0');
  });

  it('finds an expression for every rule in the real file', () => {
    const declared = alertsInRulesFile(RULES);
    const expressions = expressionsInRulesFile(RULES);
    assert.ok(declared.size >= 20, `only ${declared.size} rules parsed out of the real file`);
    assert.deepEqual(
      [...declared.keys()].filter((name) => !expressions.has(name)),
      [],
    );
    for (const [name, expression] of expressions) {
      assert.ok(expression.length > 5, `${name} parsed to a suspiciously short expression: ${expression}`);
      assert.ok(!/^[>|][-+]?$/.test(expression), `${name} parsed to a block indicator`);
    }
  });
});

describe('the parsers are scoped to the rule they belong to', () => {
  // Bugs found by fuzzing the parsers. Each returned something wrong rather than nothing.

  it("does not let a `- record:` rule steal the previous alert's expression (REGRESSION)", () => {
    // A recording rule's `expr:` overwrote the previous alert's, and the map size did not change.
    const parsed = expressionsInRulesFile(
      [
        '      - alert: A',
        '        expr: prl_a > 1',
        '      - record: job:prl_x:rate5m',
        '        expr: sum(rate(prl_nonexistent_total[5m]))',
      ].join('\n'),
    );
    assert.equal(parsed.get('A'), 'prl_a > 1');
    assert.equal(parsed.size, 1, 'the recording rule must not appear as an alert');
  });

  it('does not read an expr-shaped line inside an annotation as the expression (REGRESSION)', () => {
    const parsed = expressionsInRulesFile(
      [
        '      - alert: A',
        '        expr: prl_a > 1',
        '        annotations:',
        '          description: |',
        '            expr: prl_bogus > 999',
      ].join('\n'),
    );
    assert.equal(parsed.get('A'), 'prl_a > 1');
  });

  it('does not read a severity inside an annotation as the label (REGRESSION)', () => {
    const parsed = alertsInRulesFile(
      [
        '      - alert: A',
        '        expr: prl_a > 1',
        '        labels:',
        '          severity: ticket',
        '        annotations:',
        '          description: |',
        '            severity: page is what this would be if it paged.',
      ].join('\n'),
    );
    assert.equal(parsed.get('A').severity, 'ticket');
  });

  it('keeps a folded expression whole across a blank line (REGRESSION)', () => {
    // A blank line inside `>-` is a paragraph break. Stopping there truncated it to its numerator.
    const parsed = expressionsInRulesFile(
      [
        '      - alert: A',
        '        expr: >-',
        '          sum(rate(prl_http_requests_total{status="5xx"}[5m]))',
        '',
        '            / sum(rate(prl_http_requests_total[5m])) > 0.02',
        '        for: 5m',
      ].join('\n'),
    );
    assert.match(parsed.get('A'), /> 0\.02$/);
  });

  it('strips surrounding quotes, which Prometheus would otherwise evaluate as a string', () => {
    // A quoted `expr` parses as a string literal and answers `status: success`.
    const parsed = expressionsInRulesFile(['      - alert: A', '        expr: "prl_a > 1"'].join('\n'));
    assert.equal(parsed.get('A'), 'prl_a > 1');
  });
});

describe('seriesReferencedBy', () => {
  it('resolves histogram series back to the metric family', () => {
    const found = seriesReferencedBy(
      'histogram_quantile(0.99, sum by (le) (rate(prl_http_request_duration_seconds_bucket[5m]))) > 1',
    );
    assert.deepEqual([...found], ['prl_http_request_duration_seconds']);
  });

  it('ignores PromQL functions and label values', () => {
    const found = seriesReferencedBy(
      'absent(up{job="prl-api"}) or max_over_time(up{job="prl-api"}[2m]) == 0',
    );
    assert.deepEqual([...found], []);
  });
});

describe('the document and the rules describe the same alerts', () => {
  // Check 2 of `alerts:verify`, run without a container so drift is caught in the pull request.
  it('agrees on every name and every severity', () => {
    const documented = alertsInDocument(DOC);
    const declared = alertsInRulesFile(RULES);
    assert.ok(documented.size >= 20, `only ${documented.size} alerts parsed out of alerts.md`);
    assert.deepEqual(
      [...documented.keys()].sort(),
      [...declared.keys()].sort(),
      'docs/production/alerts.md and deploy/staging/observability/alert-rules.yml disagree',
    );
    for (const [name, severity] of documented) {
      assert.equal(declared.get(name).severity, severity, `${name}: the two files disagree on severity`);
    }
  });

  it('every runbook the rules name exists', () => {
    for (const [name, rule] of alertsInRulesFile(RULES)) {
      assert.ok(rule.runbook !== null, `${name} names no runbook`);
      assert.ok(
        readFileSync(join(REPO_ROOT, rule.runbook), 'utf8').length > 0,
        `${name}: ${rule.runbook} is empty`,
      );
    }
  });

  // Also run here so a wrong annotation is caught in the pull request. See `runbookNamingProblems`.
  it('every runbook names the alert that opens it, in its Detection section', () => {
    const declared = alertsInRulesFile(RULES);
    assert.ok(declared.size >= 20, `only ${declared.size} alerts parsed out of the rules file`);
    const problems = runbookNamingProblems(declared, (path) => readFileSync(join(REPO_ROOT, path), 'utf8'));
    assert.deepEqual(
      problems.map((p) => `${p.alert} → ${p.runbook.replace('docs/production/runbooks/', '')} ${p.reason}`),
      [],
    );
  });
});

describe('runbookSection', () => {
  it('returns one section, stopping at the next heading of the same level', () => {
    const text = ['# T', '', '## Detection', '', 'a', '', '## Recovery', '', 'b'].join('\n');
    assert.equal(runbookSection(text, 'Detection').trim(), 'a');
    assert.equal(runbookSection(text, 'Recovery').trim(), 'b');
    assert.equal(runbookSection(text, 'Escalation'), null);
  });

  it('does not stop at a deeper heading inside the section', () => {
    const text = ['## Detection', '', '### By code', 'a', '', '## Recovery', 'b'].join('\n');
    assert.match(runbookSection(text, 'Detection'), /### By code/);
    assert.doesNotMatch(runbookSection(text, 'Detection'), /^b$/m);
  });
});

/** Without these, `runbookNamingProblems` returning `[]` would look like a correct tree. */
describe('NEGATIVE CONTROL: runbookNamingProblems refusing a mismatched runbook', () => {
  const rules = (runbook) => new Map([['HandsFailing', { severity: 'page', runbook }]]);
  const DETECTION_WITH = ['# R', '## Detection', '', '| `HandsFailing` | hands abandoned |', ''].join('\n');

  it('accepts a runbook whose Detection section names the alert', () => {
    assert.deepEqual(
      runbookNamingProblems(rules('r.md'), () => DETECTION_WITH),
      [],
    );
  });

  it('refuses a runbook that never mentions the alert', () => {
    const text = ['# R', '## Detection', '', '| `AuthzFailureSpike` | enumeration |', ''].join('\n');
    assert.deepEqual(
      runbookNamingProblems(rules('r.md'), () => text),
      [{ alert: 'HandsFailing', runbook: 'r.md', reason: 'never mentions it at all' }],
    );
  });

  it('refuses a runbook that mentions the alert only in a cross-reference', () => {
    // A "see also" line in Escalation must not count.
    const text = ['# R', '## Detection', '', 'nothing', '', '## Escalation', '', 'see `HandsFailing`'].join(
      '\n',
    );
    assert.deepEqual(
      runbookNamingProblems(rules('r.md'), () => text),
      [{ alert: 'HandsFailing', runbook: 'r.md', reason: 'mentions it only outside its Detection section' }],
    );
  });

  it('refuses a runbook with no Detection section, however much else it says', () => {
    const text = ['# R', '', 'HandsFailing is discussed at length here.'].join('\n');
    assert.deepEqual(
      runbookNamingProblems(rules('r.md'), () => text),
      [{ alert: 'HandsFailing', runbook: 'r.md', reason: 'has no "## Detection" section' }],
    );
  });

  it('is not satisfied by a name this one is a substring of', () => {
    // `TableActorFailing` must not stand in for `HandsFailing` or `Failing`.
    const text = ['# R', '## Detection', '', '| `TableActorFailing` | a seat cannot act |'].join('\n');
    assert.equal(runbookNamingProblems(rules('r.md'), () => text).length, 1);
    assert.deepEqual(
      runbookNamingProblems(new Map([['Failing', { severity: 'page', runbook: 'r.md' }]]), () => text),
      [{ alert: 'Failing', runbook: 'r.md', reason: 'never mentions it at all' }],
    );
  });

  it('leaves a missing or absent runbook to the check that reports those', () => {
    assert.deepEqual(
      runbookNamingProblems(rules('gone.md'), () => null),
      [],
    );
    assert.deepEqual(
      runbookNamingProblems(new Map([['A', { severity: 'page', runbook: null }]]), () => DETECTION_WITH),
      [],
    );
  });
});

describe('renderAlertmanagerConfig', () => {
  it('substitutes a value', () => {
    const rendered = renderAlertmanagerConfig(`      - url: '${ref('A')}'`, {
      A: 'http://example.test/page',
    });
    assert.equal(rendered, "      - url: 'http://example.test/page'");
  });

  it('drops an @if block whose value is empty, and keeps one whose value is not', () => {
    const template = [
      'receivers:',
      '# @if WEBHOOK',
      '    webhook_configs:',
      `      - url: '${ref('WEBHOOK')}'`,
      '# @endif',
      '# @if EMAIL',
      '    email_configs:',
      `      - to: '${ref('EMAIL')}'`,
      '# @endif',
    ].join('\n');
    const emailOnly = renderAlertmanagerConfig(template, { WEBHOOK: '', EMAIL: 'oncall@example.test' });
    assert.ok(!emailOnly.includes('webhook_configs'));
    assert.ok(emailOnly.includes("- to: 'oncall@example.test'"));
    const both = renderAlertmanagerConfig(template, {
      WEBHOOK: 'http://example.test/page',
      EMAIL: 'oncall@example.test',
    });
    assert.ok(both.includes('webhook_configs') && both.includes('email_configs'));
  });

  it('refuses an empty value rather than emitting a destination that is blank', () => {
    // `url: ''` is accepted by Alertmanager and notifies nobody.
    assert.throws(() => renderAlertmanagerConfig(`      - url: '${ref('A')}'`, { A: '' }), /is empty/);
  });

  it('refuses a name it has no value for rather than leaving it literal', () => {
    assert.throws(
      () => renderAlertmanagerConfig(`      - url: '${ref('NOPE')}'`, { A: 'x' }),
      /no such value/,
    );
    assert.throws(() => renderAlertmanagerConfig('# @if NOPE\na\n# @endif', { A: 'x' }), /no such value/);
  });

  it('refuses an unclosed @if', () => {
    assert.throws(() => renderAlertmanagerConfig('# @if A\nx', { A: 'y' }), /never closed/);
    assert.throws(() => renderAlertmanagerConfig('x\n# @endif', { A: 'y' }), /no matching @if/);
  });

  it('leaves a comment line untouched, so the documentation table stays a table', () => {
    // The header documents variables by name and must not become a list of real destinations.
    const documented = `# | \`${ref('A')}\` | what it is |`;
    const rendered = renderAlertmanagerConfig([documented, `  url: '${ref('A')}'`].join('\n'), {
      A: 'http://example.test/page',
    });
    assert.ok(rendered.includes(documented));
    assert.ok(rendered.includes("url: 'http://example.test/page'"));
  });
});

describe('the real alertmanager.template.yml', () => {
  it('renders with the shipped defaults and leaves no placeholder behind', () => {
    const { values } = alertmanagerValues({});
    const rendered = renderAlertmanagerConfig(TEMPLATE, values);
    assert.ok(!/^[^#]*\$\{/m.test(rendered), 'a placeholder survived into a non-comment line');
    for (const key of ['smtp_smarthost:', 'webhook_configs:', 'email_configs:']) {
      assert.ok(rendered.includes(key), `the rendered config has no ${key}`);
    }
    // Both human tiers, both transports, plus the heartbeat's webhook.
    assert.equal(rendered.match(/webhook_configs:/g).length, 3);
    assert.equal(rendered.match(/email_configs:/g).length, 2);
    assert.ok(rendered.includes(values.PRL_ALERT_PAGE_EMAIL_TO));
    assert.ok(rendered.includes(values.PRL_ALERT_TICKET_EMAIL_TO));
  });

  it('keeps the two-tier route tree exactly as it was, whatever the destinations are', () => {
    const { values } = alertmanagerValues({});
    const rendered = renderAlertmanagerConfig(TEMPLATE, values);
    assert.match(rendered, /severity = "page"\n {6}receiver: paging\n {6}continue: false/);
    assert.match(rendered, /severity = "ticket"\n {6}receiver: tickets\n {6}continue: false/);
    assert.match(rendered, /^ {2}receiver: tickets$/m, 'the catch-all receiver changed');
  });

  it('renders an email-only deployment with no webhook blocks for either human tier', () => {
    // The one surviving webhook is the heartbeat's. "Email-only" is about how humans are reached.
    const { values } = alertmanagerValues({
      PRL_ALERT_PAGE_WEBHOOK_URL: '',
      PRL_ALERT_TICKET_WEBHOOK_URL: '',
    });
    const rendered = renderAlertmanagerConfig(TEMPLATE, values);
    assert.equal(rendered.match(/webhook_configs:/g).length, 1);
    assert.ok(rendered.includes(values.PRL_ALERT_HEARTBEAT_WEBHOOK_URL));
    assert.equal(rendered.match(/email_configs:/g).length, 2);
    assert.deepEqual(destinationProblems(values), []);
  });

  it('renders a webhook-only deployment with no SMTP settings at all', () => {
    const { values } = alertmanagerValues({ PRL_ALERT_PAGE_EMAIL_TO: '', PRL_ALERT_TICKET_EMAIL_TO: '' });
    const rendered = renderAlertmanagerConfig(TEMPLATE, values);
    assert.ok(!rendered.includes('email_configs:'));
    assert.equal(rendered.match(/webhook_configs:/g).length, 3);
    assert.deepEqual(destinationProblems(values), []);
  });

  it('emits smtp_auth_password_file, and never the password itself', () => {
    const { values } = alertmanagerValues({ PRL_ALERT_SMTP_USERNAME: 'apikey' });
    const rendered = renderAlertmanagerConfig(TEMPLATE, values);
    assert.ok(rendered.includes("smtp_auth_username: 'apikey'"));
    assert.ok(rendered.includes('smtp_auth_password_file: /etc/alertmanager/smtp-password'));
    assert.ok(!/^\s*smtp_auth_password:/m.test(rendered), 'a password would be written into the config');
  });
});

describe('alertmanagerValues and destinationProblems', () => {
  it('falls back to the local sinks and reports nothing as overridden', () => {
    const { values, overridden } = alertmanagerValues({});
    assert.deepEqual(values, ALERT_DESTINATION_DEFAULTS);
    assert.deepEqual(overridden, []);
  });

  it('records what the environment supplied, so a failed check can be explained', () => {
    const { values, overridden } = alertmanagerValues({
      PRL_ALERT_PAGE_EMAIL_TO: '  5551234567@txt.example.test  ',
    });
    assert.equal(values.PRL_ALERT_PAGE_EMAIL_TO, '5551234567@txt.example.test');
    assert.deepEqual(overridden, ['PRL_ALERT_PAGE_EMAIL_TO']);
  });

  it('refuses a tier with no destination left in it', () => {
    const { values } = alertmanagerValues({
      PRL_ALERT_PAGE_WEBHOOK_URL: '',
      PRL_ALERT_PAGE_EMAIL_TO: '',
    });
    assert.match(destinationProblems(values).join(' '), /paging receiver would have no destination/);
  });

  it('refuses email with no relay to send it through', () => {
    const { values } = alertmanagerValues({ PRL_ALERT_SMTP_SMARTHOST: '' });
    assert.match(destinationProblems(values).join(' '), /PRL_ALERT_SMTP_SMARTHOST is empty/);
  });

  it('refuses a require_tls that is not a YAML boolean', () => {
    // `smtp_require_tls: yes` is a string to Alertmanager and the container refuses to start.
    const { values } = alertmanagerValues({ PRL_ALERT_SMTP_REQUIRE_TLS: 'yes' });
    assert.match(destinationProblems(values).join(' '), /must be exactly true or false/);
  });
});

describe('decodeQuotedPrintable', () => {
  it('rejoins a word split by a soft line break', () => {
    assert.equal(decodeQuotedPrintable('Api=\r\nDown'), 'ApiDown');
    assert.equal(decodeQuotedPrintable('Api=\nDown'), 'ApiDown');
  });

  it('decodes escaped bytes', () => {
    assert.equal(decodeQuotedPrintable('a=3Db'), 'a=b');
  });
});

describe('parseMessage', () => {
  it('splits headers from body, lowercases names and unfolds a continuation', () => {
    const parsed = parseMessage(
      [
        'From: alertmanager@example.test',
        'To: oncall@example.test',
        'Subject: [FIRING:1]',
        ' ApiDown',
        'Content-Transfer-Encoding: quoted-printable',
        '',
        '<p>Alert: Api=',
        'Down</p>',
      ].join('\r\n'),
    );
    assert.equal(parsed.headers.get('subject'), '[FIRING:1] ApiDown');
    assert.equal(parsed.headers.get('to'), 'oncall@example.test');
    assert.ok(parsed.body.includes('ApiDown'));
  });

  it('does not decode the headers, because a MIME boundary looks like an escape', () => {
    const parsed = parseMessage(
      ['Content-Type: multipart/alternative; boundary=3f9a2b', '', 'body'].join('\r\n'),
    );
    assert.equal(parsed.headers.get('content-type'), 'multipart/alternative; boundary=3f9a2b');
  });
});

describe('the SMTP sink speaks the protocol', () => {
  function dialogue(port, script) {
    return new Promise((done, failed) => {
      const socket = connect(port, '127.0.0.1');
      const replies = [];
      let buffer = '';
      let step = -1;
      socket.setEncoding('utf8');
      socket.on('error', failed);
      socket.on('data', (chunk) => {
        buffer += chunk;
        // Complete when the last line has a space after the code. Getting this wrong hangs the test.
        const lines = buffer.split('\r\n').filter((line) => line !== '');
        if (lines.length === 0 || !/^\d{3} /.test(lines[lines.length - 1])) return;
        if (!buffer.endsWith('\r\n')) return;
        replies.push(buffer);
        buffer = '';
        step += 1;
        if (step >= script.length) {
          socket.end();
          done(replies);
          return;
        }
        socket.write(script[step]);
      });
    });
  }

  it('captures a message, its envelope, and undoes dot-stuffing', async () => {
    const sink = await startSmtpSink(0);
    try {
      const replies = await dialogue(sink.port, [
        'EHLO localhost\r\n',
        'MAIL FROM:<alertmanager@example.test>\r\n',
        'RCPT TO:<oncall@example.test>\r\n',
        'RCPT TO:<duty@example.test>\r\n',
        'DATA\r\n',
        // `..hidden` is dot-stuffing.
        'Subject: [FIRING:1] ApiDown\r\n\r\nAlert: ApiDown\r\n..hidden\r\n.\r\n',
        'QUIT\r\n',
      ]);
      assert.match(replies[0], /^220 /, 'no greeting');
      assert.match(replies[1], /^250-/, 'EHLO must answer with a multi-line 250');
      assert.ok(!replies[1].includes('STARTTLS'), 'a sink with no certificate must not offer STARTTLS');
      assert.ok(!replies[1].includes('AUTH'), 'advertising AUTH would invite an invented credential');
      assert.match(replies[5], /^354 /, 'DATA must answer 354');
      assert.match(replies[6], /^250 /, 'the message must be accepted');
      assert.match(replies[7], /^221 /, 'QUIT must answer 221');

      assert.equal(sink.received.length, 1);
      const [message] = sink.received;
      assert.equal(message.from, 'alertmanager@example.test');
      assert.deepEqual(message.recipients, ['oncall@example.test', 'duty@example.test']);
      assert.ok(message.raw.includes('.hidden'), 'dot-stuffing was not undone');
      assert.ok(!message.raw.includes('..hidden'));
      assert.ok(!message.raw.endsWith('.'), 'the terminating dot must not be part of the message');
      assert.equal(parseMessage(message.raw).headers.get('subject'), '[FIRING:1] ApiDown');
    } finally {
      sink.close();
    }
  });

  it('takes two messages on one connection, as a client with a queue would', async () => {
    // A second transaction on one socket must not be swallowed.
    const sink = await startSmtpSink(0);
    try {
      await dialogue(sink.port, [
        'EHLO localhost\r\n',
        'MAIL FROM:<a@example.test>\r\n',
        'RCPT TO:<one@example.test>\r\n',
        'DATA\r\n',
        'Subject: first\r\n\r\nbody\r\n.\r\n',
        'MAIL FROM:<a@example.test>\r\n',
        'RCPT TO:<two@example.test>\r\n',
        'DATA\r\n',
        'Subject: second\r\n\r\nbody\r\n.\r\n',
        'QUIT\r\n',
      ]);
      assert.deepEqual(
        sink.received.map((entry) => entry.recipients),
        [['one@example.test'], ['two@example.test']],
      );
      assert.deepEqual(
        sink.received.map((entry) => parseMessage(entry.raw).headers.get('subject')),
        ['first', 'second'],
      );
    } finally {
      sink.close();
    }
  });
});

describe('emailsFor', () => {
  const message = (recipients, subject, body) => ({
    from: 'alertmanager@example.test',
    recipients,
    raw: `Subject: ${subject}\r\nTo: ${recipients.join(', ')}\r\n\r\n${body}`,
    at: '2026-01-01T00:00:00.000Z',
  });

  it('matches on the envelope recipient, the status, the subject and the body together', () => {
    const received = [message(['oncall@example.test'], '[FIRING:1] ApiDown', '<p>Alert: ApiDown</p>')];
    assert.equal(emailsFor(received, 'oncall@example.test', 'ApiDown', 'firing').length, 1);
    assert.equal(emailsFor(received, 'tickets@example.test', 'ApiDown', 'firing').length, 0);
    assert.equal(emailsFor(received, 'oncall@example.test', 'ApiDown', 'resolved').length, 0);
    assert.equal(emailsFor(received, 'oncall@example.test', 'RateLimitBans', 'firing').length, 0);
  });

  it('does not accept a subject that names the alert with an empty body', () => {
    // The subject comes from a different template, so an empty body still looks correct.
    const received = [message(['oncall@example.test'], '[FIRING:1] ApiDown', '')];
    assert.equal(emailsFor(received, 'oncall@example.test', 'ApiDown', 'firing').length, 0);
  });

  it('requires every address in a comma-separated recipient list', () => {
    const received = [message(['oncall@example.test'], '[RESOLVED] ApiDown', 'ApiDown')];
    assert.equal(emailsFor(received, 'oncall@example.test', 'ApiDown', 'resolved').length, 1);
    assert.equal(
      emailsFor(received, 'oncall@example.test, backup@example.test', 'ApiDown', 'resolved').length,
      0,
    );
  });
});

describe('emailsFor with no address configured', () => {
  it('matches nothing at all (REGRESSION-shaped)', () => {
    // An empty recipient list used to match every message.
    const received = [
      {
        from: 'alertmanager@example.test',
        recipients: ['tickets@example.test'],
        raw: 'Subject: [FIRING:1] RateLimitBans\r\n\r\nRateLimitBans',
        at: '2026-01-01T00:00:00.000Z',
      },
    ];
    assert.equal(emailsFor(received, '', 'RateLimitBans', 'firing').length, 0);
    assert.equal(emailsFor(received, '  ,  ', 'RateLimitBans', 'firing').length, 0);
  });
});

describe('alertmanagerSeriesReferencedBy', () => {
  it('finds the series the alerting-itself rules are built on', () => {
    // Without this, a misspelled `alertmanager_*` series would load, evaluate, and never fire.
    assert.deepEqual(
      [...alertmanagerSeriesReferencedBy('sum(increase(alertmanager_notifications_failed_total[15m])) > 0')],
      ['alertmanager_notifications_failed_total'],
    );
    assert.deepEqual([...alertmanagerSeriesReferencedBy('prl_hands_failed_total > 0')], []);
  });

  it('is used by at least one shipped rule, so check 3 is not grounding nothing', () => {
    const named = new Set();
    for (const expression of expressionsInRulesFile(RULES).values()) {
      for (const series of alertmanagerSeriesReferencedBy(expression)) named.add(series);
    }
    assert.ok(
      named.size > 0,
      'no rule watches the alerting system itself, so nothing would report a deployment whose ' +
        'alerts fire, route correctly and reach nobody',
    );
  });
});

describe('probeSeriesReferencedBy', () => {
  it('finds the series the blackbox probe produces, and nothing else', () => {
    assert.deepEqual(
      [...probeSeriesReferencedBy('probe_success{job="prl-public-origin"} == 0')],
      ['probe_success'],
    );
    assert.deepEqual(
      [...probeSeriesReferencedBy('min(probe_ssl_earliest_cert_expiry) - time() < 21 * 86400')],
      ['probe_ssl_earliest_cert_expiry'],
    );
    assert.deepEqual([...probeSeriesReferencedBy('prl_readiness_state == 0')], []);
  });

  /**
   * The API is scraped directly on the compose network, so a dead proxy, TLS or page server fires
   * nothing. Only the probe sees the deployment from outside. Measured when written: `probe_success
   * == 0` fired at 2m10s, and `probe_ssl_earliest_cert_expiry` matched the staging cert's `notAfter`.
   */
  it('is used by at least one shipped rule, so the public origin is watched at all', () => {
    const named = new Set();
    for (const expression of expressionsInRulesFile(RULES).values()) {
      for (const series of probeSeriesReferencedBy(expression)) named.add(series);
    }
    assert.ok(
      named.size > 0,
      'no rule names a probe_* series, so nothing watches this deployment from outside the ' +
        'application: the proxy, TLS and the page server can all be dead with every alert green',
    );
  });
});

describe('the counts docs/production/alerts.md states about itself', () => {
  const WORDS = new Map(
    [
      'zero',
      'one',
      'two',
      'three',
      'four',
      'five',
      'six',
      'seven',
      'eight',
      'nine',
      'ten',
      'eleven',
      'twelve',
      'thirteen',
      'fourteen',
      'fifteen',
      'sixteen',
      'seventeen',
      'eighteen',
      'nineteen',
      'twenty',
    ].map((word, index) => [word, index]),
  );
  // Tens above twenty. `spelled` returns null for an unknown word, so extend this map rather than
  // rewording the document.
  for (const [word, value] of [
    ['thirty', 30],
    ['forty', 40],
    ['fifty', 50],
  ]) {
    WORDS.set(word, value);
  }
  const spelled = (text) => {
    const [tens, units] = text.toLowerCase().split('-');
    const base = WORDS.get(tens);
    if (base === undefined) return null;
    return units === undefined ? base : base + (WORDS.get(units) ?? Number.NaN);
  };

  it('agrees with the number of rules that actually exist', () => {
    // The document once said "all twenty-two rules" while the file held twenty-three.
    const total = alertsInRulesFile(RULES).size;
    const stated = /establishes four things about \*\*all ([a-z-]+)\*\* rules/.exec(DOC);
    assert.ok(stated !== null, 'the document no longer states how many rules it covers');
    assert.equal(spelled(stated[1]), total, `the document says ${stated[1]}, the rules file has ${total}`);
  });

  it('agrees about how many of them have never been provoked', () => {
    // Three are driven end to end: `ApiDown`, `RateLimitBans` and `Watchdog`.
    const total = alertsInRulesFile(RULES).size;
    const stated = /\*\*([A-Za-z-]+) rules have not been provoked\.\*\*/.exec(DOC);
    assert.ok(stated !== null, 'the document no longer states how many rules are unprovoked');
    assert.equal(spelled(stated[1]), total - 3, `${stated[1]} stated, ${total - 3} unprovoked`);
  });
});

describe("the dead man's switch", () => {
  it('is exactly one rule, is named Watchdog, and cannot stop firing for any other reason', () => {
    // `vector(1)` depends on nothing that can go quiet. A `for:` would delay the first ping after a restart.
    const rules = alertsInRulesFile(RULES);
    const heartbeats = [...rules].filter(([, rule]) => rule.severity === 'heartbeat');
    assert.deepEqual(
      heartbeats.map(([name]) => name),
      ['Watchdog'],
    );
    assert.equal(expressionsInRulesFile(RULES).get('Watchdog'), 'vector(1)');
    assert.ok(
      !/- alert: Watchdog[\s\S]{0,400}?\n {8}for:/.test(RULES),
      'Watchdog has a for: duration, which delays every ping after a restart',
    );
  });

  it('is documented as a heartbeat and not as a page, which check 2 would otherwise allow', () => {
    // `severity: page` on a permanently firing rule notifies a human every repeat_interval.
    assert.equal(alertsInDocument(DOC).get('Watchdog'), 'heartbeat');
    assert.equal(alertsInRulesFile(RULES).get('Watchdog').severity, 'heartbeat');
  });

  it('routes to its own receiver, and that receiver is in neither human tier', () => {
    const { values } = alertmanagerValues({});
    const rendered = renderAlertmanagerConfig(TEMPLATE, values);
    assert.match(rendered, /severity = "heartbeat"\n {6}receiver: heartbeat\n {6}continue: false/);
    // A resolved heartbeat would look like a clean shutdown to the watcher.
    assert.match(rendered, /- url: '[^']*\/heartbeat'\n(?: *#[^\n]*\n)* *send_resolved: false/);
    const paging = rendered.slice(rendered.indexOf('- name: paging'), rendered.indexOf('- name: tickets'));
    assert.ok(!paging.includes(values.PRL_ALERT_HEARTBEAT_WEBHOOK_URL));
  });

  it('refuses to render without a heartbeat destination, or with a malformed interval', () => {
    // An unset heartbeat is never discovered, unlike an unset pager.
    const empty = alertmanagerValues({ PRL_ALERT_HEARTBEAT_WEBHOOK_URL: '' }).values;
    assert.match(destinationProblems(empty).join(' '), /PRL_ALERT_HEARTBEAT_WEBHOOK_URL is empty/);
    const bad = alertmanagerValues({ PRL_ALERT_HEARTBEAT_INTERVAL: '20 seconds' }).values;
    assert.match(destinationProblems(bad).join(' '), /must be a Prometheus duration/);
    assert.deepEqual(destinationProblems(alertmanagerValues({}).values), []);
  });

  it('sizes its own budgets from the configured interval rather than from a constant', () => {
    assert.equal(durationMs('20s'), 20_000);
    assert.equal(durationMs('1m'), 60_000);
    assert.equal(durationMs('2h'), 7_200_000);
    assert.equal(durationMs('500ms'), 500);
    assert.equal(durationMs('20 s'), null);
    assert.equal(durationMs('later'), null);
  });
});

describe("NEGATIVE CONTROL: the dead man's switch alarming", () => {
  // The live negative control costs a stopped Alertmanager and two minutes. These construct the same alarm.
  const at = (...seconds) => seconds.map((second) => 1_700_000_000_000 + second * 1_000);

  it('passes a steady rhythm inside the deadline', () => {
    assert.equal(heartbeatProblem(at(0, 20, 40, 60), { deadlineMs: 60_000 }), null);
    assert.deepEqual(heartbeatGaps(at(0, 20, 45)), [20_000, 25_000]);
  });

  it('refuses a heartbeat that never arrived', () => {
    assert.match(heartbeatProblem([], { deadlineMs: 60_000 }), /no heartbeat has ever arrived/);
  });

  it('refuses a single ping, which proves the route and not the rhythm', () => {
    // A rounded-up `repeat_interval` or a single `group_wait` ping both look perfect at first.
    assert.match(heartbeatProblem(at(0), { deadlineMs: 60_000 }), /only 1 heartbeat/);
    assert.match(heartbeatProblem(at(0, 20), { deadlineMs: 60_000 }), /only 2 heartbeat/);
  });

  it('refuses a rhythm with a gap past the deadline a watcher would page on', () => {
    const problem = heartbeatProblem(at(0, 20, 110, 130), { deadlineMs: 60_000 });
    assert.match(problem, /longest gap between pings was 90\.0s, past the 60s deadline/);
  });

  it('detects silence from the last ping, not from the moment somebody started watching', async () => {
    // Measured from the last ping, which is what an external watcher sees.
    const lastPing = Date.now() - 5_000;
    const silence = await watchForSilence(() => [lastPing], 3_000, 10_000);
    assert.ok(silence >= 5_000, `silence was ${silence}`);
  });

  it('does not report silence when a ping arrives inside the deadline', async () => {
    // A watcher stuck in the alarm state is as useless as one stuck quiet.
    const arrivals = [Date.now() - 1_000];
    setTimeout(() => arrivals.push(Date.now()), 200);
    assert.equal(await watchForSilence(() => arrivals, 3_000, 6_000), null);
  });
});

describe('every rule is covered by a promtool unit test, in both directions', () => {
  /**
   * Every rule must have a case in `rule-tests/`, and every case must name a real rule. An audit found
   * nineteen of thirty-five rules untested while the rules file claimed coverage. `promtool` cannot
   * see a missing case, and `ALERTS{alertname="ApiDwon"}` with `exp_samples: []` passes against any
   * file. Runs under `test:scripts` because `alerts:unit` needs Docker.
   */
  const RULE_TESTS = join(OBSERVABILITY, 'rule-tests');
  const caseFiles = readdirSync(RULE_TESTS)
    .filter((name) => name.endsWith('.test.yml'))
    .map((name) => ({ name, text: readFileSync(join(RULE_TESTS, name), 'utf8') }));
  const declared = alertsInRulesFile(RULES);

  it('read a non-empty rules file and a non-empty set of case files', () => {
    // A sweep of nothing is not a pass.
    assert.ok(caseFiles.length >= 7, `only ${caseFiles.length} *.test.yml files were read`);
    assert.ok(declared.size >= 35, `only ${declared.size} rules parsed out of alert-rules.yml`);
  });

  it('names every rule in alert-rules.yml in some rule-tests/*.test.yml', () => {
    const uncovered = [...declared.keys()].filter(
      (alert) => !caseFiles.some(({ text }) => text.includes(`alertname="${alert}"`)),
    );
    assert.deepEqual(
      uncovered,
      [],
      `${uncovered.length} of ${declared.size} rules have no promtool unit test: ${uncovered.join(', ')}`,
    );
  });

  it('asserts on no alertname that alert-rules.yml does not define', () => {
    const unknown = new Set();
    for (const { name, text } of caseFiles) {
      for (const [, alert] of text.matchAll(/alertname="([A-Za-z0-9_]+)"/g)) {
        if (!declared.has(alert)) unknown.add(`${alert} (${name})`);
      }
    }
    assert.deepEqual([...unknown], [], `assertions on alerts that do not exist: ${[...unknown].join(', ')}`);
  });
});

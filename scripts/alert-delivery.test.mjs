#!/usr/bin/env node
/**
 * Tests for the parsers, the config renderer and the SMTP sink behind
 * `pnpm run alerts:verify`.
 *
 * Run with:  node --test scripts/alert-delivery.test.mjs
 *
 * The verification itself needs a running staging stack, a Prometheus, an
 * Alertmanager and about six minutes, so it is not a unit test and does not
 * pretend to be. What IS testable here is everything the checks are built on:
 * three small parsers that read the rules file and the document, the renderer that
 * turns `alertmanager.template.yml` into the file Alertmanager loads, and the SMTP
 * server the email proof depends on. Their failures are silent in the worst way —
 * a parser that returns fewer alerts than exist makes every check pass by looking
 * at less, and a renderer that emits a blank destination produces an Alertmanager
 * that starts, routes correctly and notifies nobody.
 *
 * ## Why the SMTP sink is driven over a real socket here
 *
 * Because the alternative place to find a protocol bug in it is six minutes into a
 * verification run, after the staging API has already been stopped. The dialogue
 * test opens a TCP connection to the sink on an ephemeral port and speaks the same
 * sequence Alertmanager's client does, including the two things a naive
 * implementation gets wrong: multi-line `250` framing after `EHLO`, and undoing
 * dot-stuffing in the captured body.
 *
 * ## The defect these were written against
 *
 * `expressionsInRulesFile` recognised a folded block scalar (`expr: >-`) with a
 * negative lookahead. The lookahead backtracked over the space after `expr:`, so
 * seven rules — every multi-line expression in the file — were recorded as the
 * literal string ` >-` and sent to Prometheus, which answered 400 to all seven.
 * The check caught it on its first real run, which is the argument for having
 * check 4 at all; this file is the argument for not needing a container to find
 * it next time.
 *
 * The last two cases are the ones that matter most: a parser that finds NOTHING
 * must not read as agreement. Two empty sets are identical, and a check built on
 * that comparison would report "the two sets are identical — 0 alerts" and pass.
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

/**
 * `${NAME}`, assembled rather than typed.
 *
 * Everywhere else in this repository a literal `${…}` inside an ordinary quoted
 * string is a template literal somebody forgot to backtick, and the linter says so.
 * This file is the one place the sequence is data — it is the substitution syntax
 * under test — so it is built, which keeps that rule earning its keep rather than
 * being switched off for a file that legitimately needs the characters.
 */
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
    // The bug: this returned ' >-' — the block indicator itself — for every rule
    // written this way, and Prometheus answered 400 to all of them.
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
  /**
   * Three sibling bugs of the folded-scalar one above, all found by adversarially fuzzing the
   * parsers rather than by a container. Each makes a parser return something WRONG rather than
   * nothing, which is worse: the checks built on it then pass against text nobody deployed.
   */

  it("does not let a `- record:` rule steal the previous alert's expression (REGRESSION)", () => {
    // `current` was never cleared, so any `expr:` not preceded by a recognised `- alert:` line
    // overwrote the last alert's. A recording rule is an ordinary thing to add to a rules file,
    // and the map size stayed the same, so even a count assertion would not have noticed.
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
    // `alerts.md`'s prose quotes PromQL, and annotations quote `alerts.md`.
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
    // This one defeats the two-tier routing assertion the whole script exists to make.
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
    // A blank line inside `>-` is a paragraph break, not a terminator. Breaking on it truncated
    // the expression to its numerator — still valid PromQL, so the evaluation check passed and
    // the threshold the alert is about was never seen by anything.
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
    // `query="prl_a > 1"` parses as a string literal and answers `status: success`, so the
    // evaluation check went green for a rule that was never evaluated.
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
  // This is check 2 of `alerts:verify`, run here without a container, because the
  // way these two drift is somebody editing one of them — and that happens in a
  // pull request, not during a release rehearsal.
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

  /**
   * The half of check 1 that a file existing does not answer.
   *
   * Run here as well as in `alerts:verify` deliberately, and it is the same argument
   * as the check above it: an annotation is edited in a pull request, and a release
   * rehearsal is a very late place to discover that six of them point at runbooks
   * that had never heard of their alert. `runbookNamingProblems`'s own comment
   * records what that cost — `HandsFailing`, a page, opening the hidden-card
   * incident runbook and its "roll back to the last digest, notify the incident
   * owner, even out of hours".
   */
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

/**
 * NEGATIVE CONTROL: the check refusing a runbook that does not cover its alert.
 *
 * Without these, `runbookNamingProblems` returning `[]` for everything would look
 * exactly like a tree in which every annotation is right — which is precisely the
 * state the repository was in for six rules while `existsSync` reported a green
 * check over all of them.
 */
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
    // The failure a whole-file substring search would have passed: a "see also" line
    // in Escalation is not somebody deciding this runbook treats this alert.
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
    // `TableActorFailing` contains neither `HandsFailing` nor `Failing` as a word, and
    // must not stand in for either. A plain `includes` gets the general case of this
    // wrong in both directions.
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
  /**
   * The renderer is the thing standing between "an operator set a variable" and
   * "Alertmanager notifies somebody". Every failure mode it has is silent in the
   * same way the parsers above are silent: a config that renders, loads, routes
   * and drops. So the cases below are all about what must NOT survive a render.
   */

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
    // `url: ''` is accepted by Alertmanager. It notifies nobody, reports no error,
    // and looks exactly like a working configuration from every API it exposes —
    // which is the shape of the blocker this whole feature exists to close.
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
    // The template's header documents every variable by name. Substituting there
    // would turn the reference table in the rendered file into a list of one
    // deployment's real destinations — including, on a production host, the
    // address of somebody's phone.
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
    // Both human tiers, both transports, plus the heartbeat's webhook. Counting is the
    // point: one `email_configs` would mean a receiver quietly lost its mail
    // destination, and two `webhook_configs` would mean the dead man's switch had no
    // way to ping anything — which is the failure that reports itself to nobody.
    assert.equal(rendered.match(/webhook_configs:/g).length, 3);
    assert.equal(rendered.match(/email_configs:/g).length, 2);
    assert.ok(rendered.includes(values.PRL_ALERT_PAGE_EMAIL_TO));
    assert.ok(rendered.includes(values.PRL_ALERT_TICKET_EMAIL_TO));
  });

  it('keeps the two-tier route tree exactly as it was, whatever the destinations are', () => {
    // The routing is the part that is verified in both directions against a live
    // Alertmanager, and making the receivers configurable must not have cost it.
    const { values } = alertmanagerValues({});
    const rendered = renderAlertmanagerConfig(TEMPLATE, values);
    assert.match(rendered, /severity = "page"\n {6}receiver: paging\n {6}continue: false/);
    assert.match(rendered, /severity = "ticket"\n {6}receiver: tickets\n {6}continue: false/);
    assert.match(rendered, /^ {2}receiver: tickets$/m, 'the catch-all receiver changed');
  });

  it('renders an email-only deployment with no webhook blocks for either human tier', () => {
    // One webhook block survives, and it is the heartbeat's. That is not a leak in the
    // conditional: a dead man's switch pings an HTTP endpoint that counts pings, and
    // the one destination it must never have is an inbox. "Email-only" is a statement
    // about how humans are reached, and the heartbeat does not reach a human.
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
    // `smtp_require_tls: yes` is a string to Alertmanager's parser and the container
    // refuses to start on it — six minutes into a run, after the API has been stopped.
    const { values } = alertmanagerValues({ PRL_ALERT_SMTP_REQUIRE_TLS: 'yes' });
    assert.match(destinationProblems(values).join(' '), /must be exactly true or false/);
  });
});

describe('decodeQuotedPrintable', () => {
  it('rejoins a word split by a soft line break', () => {
    // Alertmanager's default HTML body is one very long line, so the alert name in
    // it is genuinely likely to be split mid-word. An assertion on the raw bytes
    // would fail against a message that contains exactly what it is looking for.
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
  /**
   * The one part of `alerts:verify` that is a network protocol implementation, driven
   * here over a real socket with no containers. A defect in the state machine below
   * would otherwise surface six minutes into a run that had already stopped the
   * staging API — which is the most expensive place in this repository to find a bug.
   */

  /** Sends each line as the previous reply completes, and returns every reply in order. */
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
        // A reply is complete when its LAST line puts a space after the code rather
        // than a hyphen. That is the whole of SMTP's multi-line framing, and reading
        // it wrongly here would make this test hang rather than fail.
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
        // The doubled dot on the last body line is dot-stuffing: a body line starting
        // with `.` is sent with two so it cannot be read as the terminator.
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
    // Alertmanager opens a connection per notification today. Handling a second
    // transaction after the first `250` costs one line of state and means the sink
    // cannot silently swallow a page because a ticket shared its socket.
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
    // Every one of these is a real way the email path breaks while still delivering.
    assert.equal(emailsFor(received, 'tickets@example.test', 'ApiDown', 'firing').length, 0);
    assert.equal(emailsFor(received, 'oncall@example.test', 'ApiDown', 'resolved').length, 0);
    assert.equal(emailsFor(received, 'oncall@example.test', 'RateLimitBans', 'firing').length, 0);
  });

  it('does not accept a subject that names the alert with an empty body', () => {
    // A mail template that renders to nothing still produces a correct-looking
    // subject, because the subject comes from a different template.
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
    // `every` over an empty recipient list is vacuously true, so an unconfigured tier
    // used to match EVERY captured message — which turns "a ticket did not also page"
    // into a guaranteed failure for a deployment that pages by webhook alone.
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
    // `seriesReferencedBy` matches `prl_*` and only `prl_*`, so before this existed the
    // rules watching the alerting system were the one part of the file check 3 never
    // grounded — an expression on a misspelled `alertmanager_*` series would have
    // loaded, evaluated without error, and been permanently false.
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
   * The regression guard on the blind spot itself.
   *
   * Prometheus scrapes the API directly on the compose network and the API's healthcheck
   * targets its own container, so a dead proxy, unreadable TLS material, an expired
   * certificate or a dead page server leaves `up{job="prl-api"}` at 1,
   * `prl_readiness_state` at 1 and every counter merely flat — a total user-facing outage
   * that fires nothing at all. The probe is the only thing that looks at the deployment
   * from outside the application, so a rules file that names no `probe_*` series is a
   * rules file with that hole open again, and it looks exactly like a healthy one.
   *
   * Measured while this was written: with the exporter running and a throwaway TLS target
   * stopped, `probe_success == 0` went pending in 10 s and fired at 2m10s, and
   * `probe_ssl_earliest_cert_expiry` read 1795200901 — Nov 20 2026 18:55:01 UTC, which is
   * to the second the `notAfter` of `deploy/staging/tls/staging-cert.pem`.
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
  /** The number words that document uses, which is all it will ever need. */
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
  // The tens above twenty, added when the rules file passed thirty. `spelled` returns null for a
  // word it does not know, and `assert.equal(null, 35)` fails with a message about the wrong
  // thing — so a counter that outgrows this map turns a count check into a spelling check. Extend
  // it rather than rewording the document to stay inside it.
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
    // This control was already rotten when it was written: the document said
    // "all twenty-two rules" while the rules file held twenty-three, because a rule was
    // added and the prose was not. A stated count nobody checks is a claim that decays
    // silently, and this document's counts are quoted straight into release reports.
    const total = alertsInRulesFile(RULES).size;
    const stated = /establishes four things about \*\*all ([a-z-]+)\*\* rules/.exec(DOC);
    assert.ok(stated !== null, 'the document no longer states how many rules it covers');
    assert.equal(spelled(stated[1]), total, `the document says ${stated[1]}, the rules file has ${total}`);
  });

  it('agrees about how many of them have never been provoked', () => {
    // THREE are driven end to end by `alerts:verify`, not two: `ApiDown` for the paging
    // tier, `RateLimitBans` for the ticket tier, and `Watchdog` for the heartbeat —
    // which is provoked by nothing at all, because it is always firing, and is then
    // followed through its own receiver, through a deliberate silence and back.
    // Everything else is loaded, agreed, grounded and evaluable, which is not the same
    // as tested, and the document says so with a number.
    const total = alertsInRulesFile(RULES).size;
    const stated = /\*\*([A-Za-z-]+) rules have not been provoked\.\*\*/.exec(DOC);
    assert.ok(stated !== null, 'the document no longer states how many rules are unprovoked');
    assert.equal(spelled(stated[1]), total - 3, `${stated[1]} stated, ${total - 3} unprovoked`);
  });
});

describe("the dead man's switch", () => {
  it('is exactly one rule, is named Watchdog, and cannot stop firing for any other reason', () => {
    // Three properties in one test because they are one property: a heartbeat that can
    // go quiet for a reason other than the deployment dying is a heartbeat whose
    // watcher gets a longer grace period the first time it cries wolf, and then it is
    // decoration. `vector(1)` depends on no scrape, no metric and no subsystem; a `for:`
    // would delay the first ping after every restart for no benefit at all.
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
    // The tempting mistake, and the expensive one: `severity: page` on a permanently
    // firing rule is a notification to a human every repeat_interval, forever. The
    // document and the rules file are compared by severity, so the two spellings have
    // to agree — and this asserts the parser can even see the third value, which it
    // could not before the switch existed.
    assert.equal(alertsInDocument(DOC).get('Watchdog'), 'heartbeat');
    assert.equal(alertsInRulesFile(RULES).get('Watchdog').severity, 'heartbeat');
  });

  it('routes to its own receiver, and that receiver is in neither human tier', () => {
    const { values } = alertmanagerValues({});
    const rendered = renderAlertmanagerConfig(TEMPLATE, values);
    assert.match(rendered, /severity = "heartbeat"\n {6}receiver: heartbeat\n {6}continue: false/);
    // `send_resolved: false` on this receiver only. A resolved heartbeat would be the
    // last thing a watcher heard and would look like a clean shutdown.
    assert.match(rendered, /- url: '[^']*\/heartbeat'\n(?: *#[^\n]*\n)* *send_resolved: false/);
    // And the paging receiver must not contain the heartbeat URL under any rendering.
    const paging = rendered.slice(rendered.indexOf('- name: paging'), rendered.indexOf('- name: tickets'));
    assert.ok(!paging.includes(values.PRL_ALERT_HEARTBEAT_WEBHOOK_URL));
  });

  it('refuses to render without a heartbeat destination, or with a malformed interval', () => {
    // The one destination that may not be dropped, and the reason is asymmetric: an
    // unset pager is discovered during the first incident by the person who was not
    // woken. An unset heartbeat is discovered never.
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
  // A dead man's switch that has never been observed to fire is the purest possible
  // decoration, and the live run's negative control costs a stopped Alertmanager and
  // two minutes. These are the same alarm, constructed, so that a change to the
  // arithmetic is caught in a pull request instead of in a rehearsal.
  const at = (...seconds) => seconds.map((second) => 1_700_000_000_000 + second * 1_000);

  it('passes a steady rhythm inside the deadline', () => {
    assert.equal(heartbeatProblem(at(0, 20, 40, 60), { deadlineMs: 60_000 }), null);
    assert.deepEqual(heartbeatGaps(at(0, 20, 45)), [20_000, 25_000]);
  });

  it('refuses a heartbeat that never arrived', () => {
    assert.match(heartbeatProblem([], { deadlineMs: 60_000 }), /no heartbeat has ever arrived/);
  });

  it('refuses a single ping, which proves the route and not the rhythm', () => {
    // The failure this is against: a `repeat_interval` Alertmanager rounded up, or a
    // receiver that fired once at `group_wait` and never again. Both deliver a first
    // ping that looks perfect, and both are already broken when they are installed.
    assert.match(heartbeatProblem(at(0), { deadlineMs: 60_000 }), /only 1 heartbeat/);
    assert.match(heartbeatProblem(at(0, 20), { deadlineMs: 60_000 }), /only 2 heartbeat/);
  });

  it('refuses a rhythm with a gap past the deadline a watcher would page on', () => {
    const problem = heartbeatProblem(at(0, 20, 110, 130), { deadlineMs: 60_000 });
    assert.match(problem, /longest gap between pings was 90\.0s, past the 60s deadline/);
  });

  it('detects silence from the last ping, not from the moment somebody started watching', async () => {
    // What an external watcher can actually see. It has no idea when anybody started
    // looking; it knows only how long since it was last told anything, which is the
    // number its grace period is compared against.
    const lastPing = Date.now() - 5_000;
    const silence = await watchForSilence(() => [lastPing], 3_000, 10_000);
    assert.ok(silence >= 5_000, `silence was ${silence}`);
  });

  it('does not report silence when a ping arrives inside the deadline', async () => {
    // The other half, and the half that keeps this from being a timer that always
    // rings: a watcher stuck in the alarm state is as useless as one stuck quiet.
    const arrivals = [Date.now() - 1_000];
    setTimeout(() => arrivals.push(Date.now()), 200);
    assert.equal(await watchForSilence(() => arrivals, 3_000, 6_000), null);
  });
});

describe('every rule is covered by a promtool unit test, in both directions', () => {
  /**
   * The guard that closes the gap this whole directory was created for.
   *
   * ## The measurement it exists because of
   *
   * A mutation audit compared the `- alert:` names in `alert-rules.yml` against
   * every `alertname=` in `deploy/staging/observability/rule-tests/`: **nineteen
   * of thirty-five rules had no unit test at all**, and the rules file's own
   * header claimed two of them — `SeatReleaseFailing` and `RoomOwnershipRefused` —
   * were covered "in both directions". They were not. The sentence describing the
   * coverage was the only evidence of it, which is the same class of defect as a
   * runbook that names the wrong alert: a claim nothing was checking.
   *
   * The auditor named this check and declined to add it, because it would have
   * failed immediately for those nineteen. That is the right reason to write a
   * guard and the wrong reason to skip one, so it is here now that they are
   * covered, and it is what stops the gap reopening one convenient rule at a
   * time.
   *
   * ## Why here and not in `run.sh`
   *
   * `promtool test rules` reads the cases and the rules and cannot see that a
   * rule has no case — silence and absence are the same to it. This is also why
   * the check runs under `test:scripts`, and therefore under `pnpm run verify`,
   * rather than only under `alerts:unit`: `alerts:unit` needs Docker, and a
   * coverage claim that only holds on machines with a daemon running is a
   * coverage claim that lapses on the machine that matters.
   *
   * ## Both directions, and what this can honestly assert about them
   *
   * A name appearing in a file is not proof that both directions were asserted —
   * only a reader can judge that. What this CAN do is refuse the two states that
   * make the question moot, and it does both: a rule with no case anywhere, and a
   * case naming a rule that does not exist. The second is not hypothetical
   * bookkeeping. `ALERTS{alertname="ApiDwon"}` with `exp_samples: []` passes
   * against any rules file ever written, so a typo in a silent assertion is a
   * green test over nothing — and `exp_samples: []` is precisely the spelling of
   * the "stays silent" half.
   */
  const RULE_TESTS = join(OBSERVABILITY, 'rule-tests');
  const caseFiles = readdirSync(RULE_TESTS)
    .filter((name) => name.endsWith('.test.yml'))
    .map((name) => ({ name, text: readFileSync(join(RULE_TESTS, name), 'utf8') }));
  const declared = alertsInRulesFile(RULES);

  it('read a non-empty rules file and a non-empty set of case files', () => {
    // A sweep of nothing is not a pass. A renamed directory, a glob that stopped
    // matching or a parser that quietly returned an empty map would make every
    // assertion below vacuously true — which is the exact shape of the defect
    // this suite exists to catch, one level up.
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

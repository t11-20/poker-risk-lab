#!/usr/bin/env node
/**
 * `pnpm run alerts:verify`: the alerts in `docs/production/alerts.md` fire, route and arrive, checked
 * against a real Prometheus and Alertmanager, because a rule that was never evaluated fails silently
 * (a renamed metric, a wrong `job` label, an unrouted severity).
 *
 * Not proved: that a provider accepts this deployment's credentials, that a phone watches the
 * address, that a person is awake (`pnpm run alerts:ack`), or that the watcher outside this host is
 * watching (`scripts/alert-preflight.mjs` refuses a heartbeat URL that names this machine). The
 * unprovoked rules are only loaded, agreed, grounded and evaluable.
 *
 * `deploy/staging/observability/alertmanager.yml` is untracked and rendered here from
 * `alertmanager.template.yml` with `PRL_ALERT_*` values. Overriding a destination off this host
 * makes the delivery checks fail, so the run prints which values were overridden.
 *
 * It stops the API rather than posting to Alertmanager's API, so the scrape, rule, `for` and routing
 * label are all exercised. `max_over_time(up[2m]) == 0` plus `for: 2m` fires a little over four
 * minutes after the stop, and a whole run takes six to seven minutes.
 *
 * Flags (no --help): --skip-provoke, --only-heartbeat, --keep-up, --render-config, --json, --out <file>.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createSocketServer } from 'node:net';
import { basename, join } from 'node:path';
import { bold, dim, green, measureUntil, REPO_ROOT, red, run, yellow } from './drills/harness.mjs';

const STAGING_ENV = join(REPO_ROOT, 'deploy', 'staging', '.env.staging');
const OBSERVABILITY = join(REPO_ROOT, 'deploy', 'staging', 'observability');
const RULES_FILE = join(OBSERVABILITY, 'alert-rules.yml');
const TOKEN_FILE = join(OBSERVABILITY, 'metrics-token');
const TEMPLATE_FILE = join(OBSERVABILITY, 'alertmanager.template.yml');
const CONFIG_FILE = join(OBSERVABILITY, 'alertmanager.yml');
const SMTP_PASSWORD_FILE = join(OBSERVABILITY, 'smtp-password');
const ALERTS_DOC = join(REPO_ROOT, 'docs', 'production', 'alerts.md');

const COMPOSE = [
  '--env-file',
  STAGING_ENV,
  '-f',
  join(REPO_ROOT, 'docker-compose.staging.yml'),
  '-f',
  join(REPO_ROOT, 'docker-compose.observability.yml'),
];

const SINK_PORT = 9099;

/** Not 25, which would need root. Alertmanager is told the port by `smtp_smarthost`. */
const SMTP_SINK_PORT = 9098;

/** A path rather than a server, because the route that chose it is what check 7 asserts. */
const HEARTBEAT_PATH = '/heartbeat';

/** Read by the interrupt handler, because `finally` does not run on a signal. */
let apiStopped = false;

/** The same, for the Alertmanager that check 7 stops on purpose. */
let alertmanagerStopped = false;

const options = {
  skipProvoke: process.argv.includes('--skip-provoke'),
  // Checks 1-4 and 7. The heartbeat needs about three minutes, so it is kept out of `--skip-provoke`.
  onlyHeartbeat: process.argv.includes('--only-heartbeat'),
  keepUp: process.argv.includes('--keep-up'),
  renderConfig: process.argv.includes('--render-config'),
  json: process.argv.includes('--json'),
  out: (() => {
    const at = process.argv.indexOf('--out');
    return at === -1 ? null : (process.argv[at + 1] ?? null);
  })(),
};

const checks = [];

function pass(name, detail) {
  checks.push({ name, ok: true, detail });
  console.log(`  ${green('✓')} ${name}${detail === undefined ? '' : dim(` — ${detail}`)}`);
}

function fail(name, detail) {
  checks.push({ name, ok: false, detail });
  console.log(`  ${red('✗')} ${name}${detail === undefined ? '' : ` — ${detail}`}`);
}

function note(text) {
  console.log(`  ${dim('·')} ${text}`);
}

function section(title) {
  console.log(bold(`\n${title}`));
}

/**
 * Line-scanned, because the repo ships no YAML parser and Prometheus refuses a malformed file itself.
 *
 * @returns {Map<string, {severity: string|null, runbook: string|null}>}
 */
export function alertsInRulesFile(text) {
  const found = new Map();
  let current = null;
  let keyIndent = -1;
  for (const line of text.split('\n')) {
    const indent = indentOf(line);
    const alert = /^\s*-\s*alert:\s*(\S+)\s*$/.exec(line);
    if (alert !== null) {
      current = { severity: null, runbook: null };
      // Later matches are scoped to this rule's key indent, so annotation prose is not read as config.
      keyIndent = indent + 2;
      found.set(alert[1], current);
      continue;
    }
    if (current === null) continue;
    // Any list item above the key indent ends the rule, including `- record:`.
    if (/^\s*-\s/.test(line) && indent < keyIndent) {
      current = null;
      keyIndent = -1;
      continue;
    }
    const severity = /^\s*severity:\s*(\S+)\s*$/.exec(line);
    if (severity !== null && indent > keyIndent) current.severity = severity[1];
    const runbook = /^\s*runbook:\s*(\S+)\s*$/.exec(line);
    if (runbook !== null && indent > keyIndent) current.runbook = runbook[1];
  }
  return found;
}

function indentOf(line) {
  return (line.match(/^\s*/) ?? [''])[0].length;
}

/**
 * Headings shaped `### \`ApiDown\` — page`. `heartbeat` is matched like any severity, so a
 * `Watchdog` documented as `page` fails check 2.
 *
 * @returns {Map<string, string>} name -> severity
 */
export function alertsInDocument(text) {
  const found = new Map();
  for (const line of text.split('\n')) {
    const heading = /^###\s+`([A-Za-z0-9_]+)`\s+—\s+(page|ticket|heartbeat)\s*$/.exec(line);
    if (heading !== null) found.set(heading[1], heading[2]);
  }
  return found;
}

export function runbookSection(text, heading) {
  const match = new RegExp(`^##\\s+${heading}\\s*$`, 'm').exec(text);
  if (match === null) return null;
  const rest = text.slice(match.index + match[0].length);
  const next = /^##\s/m.exec(rest);
  return next === null ? rest : rest.slice(0, next.index);
}

/**
 * Asks each rule's runbook whether its Detection section names the alert. `existsSync` alone let
 * six of twenty-nine rules open the wrong runbook, including `HandsFailing` (a page) opening
 * `hidden-card-incident.md` and its "roll back to the last digest". The Detection section is used
 * rather than the whole file so a "see also" line cannot satisfy it. Missing runbooks are reported by
 * the check above and skipped here.
 *
 * @param {Map<string, {severity: string|null, runbook: string|null}>} declared
 * @param {(path: string) => string|null} readRunbook — null when the file is missing
 * @returns {{alert: string, runbook: string, reason: string}[]}
 */
export function runbookNamingProblems(declared, readRunbook) {
  const problems = [];
  for (const [alert, rule] of declared) {
    if (rule.runbook === null) continue;
    const text = readRunbook(rule.runbook);
    if (text === null) continue;
    // Explicit boundaries, so `Failing` does not match inside `TableActorFailing`.
    const names = (haystack) => new RegExp(`(?<![A-Za-z0-9_])${alert}(?![A-Za-z0-9_])`).test(haystack);
    const detection = runbookSection(text, 'Detection');
    if (detection === null) {
      problems.push({ alert, runbook: rule.runbook, reason: 'has no "## Detection" section' });
      continue;
    }
    if (names(detection)) continue;
    problems.push({
      alert,
      runbook: rule.runbook,
      reason: names(text) ? 'mentions it only outside its Detection section' : 'never mentions it at all',
    });
  }
  return problems;
}

/**
 * Histogram suffixes are stripped so the name is checked against the scrape's `# TYPE` lines, not
 * by substring, which would accept a prefix of a real name.
 */
export function seriesReferencedBy(expression) {
  const names = new Set();
  for (const match of expression.matchAll(/\bprl_[a-z0-9_]+/g)) {
    names.add(match[0].replace(/_(?:bucket|sum|count)$/, ''));
  }
  return names;
}

/** Separate from `seriesReferencedBy` because these are grounded against Alertmanager's own scrape. */
export function alertmanagerSeriesReferencedBy(expression) {
  const names = new Set();
  for (const match of expression.matchAll(/\balertmanager_[a-z0-9_]+/g)) {
    names.add(match[0].replace(/_(?:bucket|sum|count)$/, ''));
  }
  return names;
}

/**
 * `probe_*` series exist in no exposition. The blackbox exporter makes them per scrape, so check 3
 * grounds them against Prometheus' query API. They cover a dead proxy, an expired certificate or a
 * dead page server, which leave every `prl_*` rule green.
 */
export function probeSeriesReferencedBy(expression) {
  const names = new Set();
  for (const match of expression.matchAll(/\bprobe_[a-z0-9_]+/g)) {
    names.add(match[0].replace(/_(?:bucket|sum|count)$/, ''));
  }
  return names;
}

export function expressionsInRulesFile(text) {
  const found = new Map();
  const lines = text.split('\n');
  let current = null;
  let keyIndent = -1;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const indent = indentOf(line);
    const alert = /^\s*-\s*alert:\s*(\S+)\s*$/.exec(line);
    if (alert !== null) {
      current = alert[1];
      keyIndent = indent + 2;
      continue;
    }
    if (current === null) continue;
    // Only an `expr:` at this rule's key indent counts, because annotation prose quotes expressions.
    if (/^\s*-\s/.test(line) && indent < keyIndent) {
      current = null;
      keyIndent = -1;
      continue;
    }
    const raw = /^\s*expr:\s*(.*)$/.exec(line);
    if (raw === null || indent !== keyIndent) continue;
    const value = raw[1].trim();
    // An explicit comparison, not a lookahead. The lookahead version captured ` >-` as seven rules' query.
    if (value !== '' && !/^[>|][-+]?$/.test(value)) {
      found.set(current, unquote(value));
      continue;
    }
    if (/^[>|][-+]?$/.test(value)) {
      const body = [];
      for (let scan = index + 1; scan < lines.length; scan++) {
        const scanned = lines[scan];
        // A blank line in a folded scalar is a paragraph break. Stopping there truncated `HttpErrorRateHigh`.
        if (scanned.trim() === '') continue;
        if (indentOf(scanned) <= indent) break;
        body.push(scanned.trim());
      }
      found.set(current, unquote(body.join(' ')));
    }
  }
  return found;
}

/** Prometheus parses a quoted `expr` as a string literal and answers success without evaluating it. */
function unquote(value) {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  if ((first === '"' || first === "'") && trimmed.endsWith(first)) return trimmed.slice(1, -1).trim();
  return trimmed;
}

/**
 * The defaults are local sinks and a `.invalid` domain, so a fresh checkout can rehearse and an
 * unconfigured deployment fails loudly. `PRL_ALERT_SMTP_PASSWORD` is not here. It goes to the file
 * read by `smtp_auth_password_file`, never into the rendered YAML.
 */
export const ALERT_DESTINATION_DEFAULTS = {
  PRL_ALERT_PAGE_WEBHOOK_URL: `http://host.docker.internal:${SINK_PORT}/page`,
  PRL_ALERT_TICKET_WEBHOOK_URL: `http://host.docker.internal:${SINK_PORT}/ticket`,
  // `alert-preflight.mjs` refuses to promote while this still names this machine.
  PRL_ALERT_HEARTBEAT_WEBHOOK_URL: `http://host.docker.internal:${SINK_PORT}${HEARTBEAT_PATH}`,
  // 20s lets a run see several arrivals and one silence. It must sit inside the watcher's grace period.
  PRL_ALERT_HEARTBEAT_INTERVAL: '20s',
  PRL_ALERT_PAGE_EMAIL_TO: 'oncall@staging.poker-risk-lab.invalid',
  PRL_ALERT_TICKET_EMAIL_TO: 'tickets@staging.poker-risk-lab.invalid',
  PRL_ALERT_SMTP_SMARTHOST: `host.docker.internal:${SMTP_SINK_PORT}`,
  PRL_ALERT_EMAIL_FROM: 'alertmanager@staging.poker-risk-lab.invalid',
  PRL_ALERT_SMTP_HELLO: 'localhost',
  PRL_ALERT_SMTP_REQUIRE_TLS: 'false',
  PRL_ALERT_SMTP_USERNAME: '',
};

/** Overrides are reported, because a run pointed at a real pager cannot observe its notifications. */
export function alertmanagerValues(env = process.env) {
  const values = {};
  const overridden = [];
  for (const [name, fallback] of Object.entries(ALERT_DESTINATION_DEFAULTS)) {
    const supplied = env[name];
    values[name] = supplied === undefined ? fallback : supplied.trim();
    if (values[name] !== fallback) overridden.push(name);
  }
  return { values, overridden };
}

/** Each of these renders valid YAML for an Alertmanager that accepts alerts and drops them. */
export function destinationProblems(values) {
  const problems = [];
  for (const tier of ['PAGE', 'TICKET']) {
    if (values[`PRL_ALERT_${tier}_WEBHOOK_URL`] === '' && values[`PRL_ALERT_${tier}_EMAIL_TO`] === '') {
      problems.push(
        `the ${tier === 'PAGE' ? 'paging' : 'ticket'} receiver would have no destination — ` +
          `set PRL_ALERT_${tier}_WEBHOOK_URL or PRL_ALERT_${tier}_EMAIL_TO`,
      );
    }
  }
  const wantsEmail = values.PRL_ALERT_PAGE_EMAIL_TO !== '' || values.PRL_ALERT_TICKET_EMAIL_TO !== '';
  if (wantsEmail) {
    if (values.PRL_ALERT_SMTP_SMARTHOST === '')
      problems.push('an email recipient is configured but PRL_ALERT_SMTP_SMARTHOST is empty');
    if (values.PRL_ALERT_EMAIL_FROM === '')
      problems.push('an email recipient is configured but PRL_ALERT_EMAIL_FROM is empty');
    if (values.PRL_ALERT_SMTP_HELLO === '')
      problems.push('an email recipient is configured but PRL_ALERT_SMTP_HELLO is empty');
  }
  if (values.PRL_ALERT_SMTP_REQUIRE_TLS !== 'true' && values.PRL_ALERT_SMTP_REQUIRE_TLS !== 'false') {
    problems.push(
      `PRL_ALERT_SMTP_REQUIRE_TLS must be exactly true or false, not ${JSON.stringify(values.PRL_ALERT_SMTP_REQUIRE_TLS)}`,
    );
  }
  // A heartbeat with nowhere to go is dropped inside Alertmanager and looks like a healthy month.
  if (values.PRL_ALERT_HEARTBEAT_WEBHOOK_URL === '') {
    problems.push(
      "PRL_ALERT_HEARTBEAT_WEBHOOK_URL is empty, so the dead man's switch would fire forever into " +
        'a receiver with nothing in it — set it to the ping URL of a watcher outside this deployment',
    );
  }
  if (!/^\d+(?:ms|[smh])$/.test(values.PRL_ALERT_HEARTBEAT_INTERVAL)) {
    problems.push(
      'PRL_ALERT_HEARTBEAT_INTERVAL must be a Prometheus duration such as 20s or 1m, not ' +
        `${JSON.stringify(values.PRL_ALERT_HEARTBEAT_INTERVAL)} — Alertmanager refuses to start on ` +
        'a malformed one, which is the good case; the bad case is a value that parses to something ' +
        'nobody intended',
    );
  }
  return problems;
}

/** Check 7 sizes its budgets from this, so a changed interval is still tested. */
export function durationMs(text) {
  const parsed = /^(\d+)(ms|[smh])$/.exec(text.trim());
  if (parsed === null) return null;
  const scale = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };
  return Number(parsed[1]) * scale[parsed[2]];
}

/**
 * Two directives, spelled as YAML comments. `${NAME}` is substituted, and an empty value is an
 * error because `url: ` notifies nobody. `# @if NAME` … `# @endif` keeps its lines only when `NAME`
 * is non-empty. Comment lines are copied untouched, so the template's prose can name variables.
 *
 * @param {string} template
 * @param {Record<string, string>} values
 */
export function renderAlertmanagerConfig(template, values) {
  const kept = [];
  /** @type {{name: string, keep: boolean}[]} */
  const open = [];
  const lines = template.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const opening = /^\s*#\s*@if\s+([A-Za-z0-9_]+)\s*$/.exec(line);
    if (opening !== null) {
      if (!(opening[1] in values)) {
        throw new Error(`alertmanager.template.yml:${index + 1}: @if ${opening[1]} — no such value`);
      }
      open.push({ name: opening[1], keep: values[opening[1]] !== '' });
      continue;
    }
    if (/^\s*#\s*@endif\s*$/.test(line)) {
      if (open.pop() === undefined) {
        throw new Error(`alertmanager.template.yml:${index + 1}: @endif with no matching @if`);
      }
      continue;
    }
    if (open.some((frame) => !frame.keep)) continue;
    if (/^\s*#/.test(line)) {
      kept.push(line);
      continue;
    }
    kept.push(
      line.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_, name) => {
        if (!(name in values)) {
          throw new Error(`alertmanager.template.yml:${index + 1}: \${${name}} — no such value`);
        }
        if (values[name] === '') {
          throw new Error(
            `alertmanager.template.yml:${index + 1}: \${${name}} is empty, and an empty ` +
              'destination is a receiver that notifies nobody',
          );
        }
        return values[name];
      }),
    );
  }
  if (open.length > 0) {
    throw new Error(`alertmanager.template.yml: @if ${open.map((f) => f.name).join(', ')} never closed`);
  }
  return kept.join('\n');
}

/**
 * `rmSync` first, because Docker creates a directory for a missing bind-mount source. The password
 * file is written even when empty because the compose mount is unconditional.
 */
function writeAlertmanagerConfig(values) {
  // The rendered file is deleted every run, so edits to it are lost.
  const banner = [
    '# GENERATED — do not edit.',
    '#',
    '# Rendered by scripts/alert-delivery.mjs from alertmanager.template.yml. Change a',
    '# destination by setting the PRL_ALERT_* variable the table below names, then',
    '# re-render; an edit here is deleted at the end of the next verification run.',
    '#',
    `# Rendered at ${new Date().toISOString()}.`,
    '',
  ].join('\n');
  const rendered = banner + renderAlertmanagerConfig(readFileSync(TEMPLATE_FILE, 'utf8'), values);
  rmSync(CONFIG_FILE, { force: true, recursive: true });
  // 0644, because it holds destinations, not credentials. The password file below is 0600.
  writeFileSync(CONFIG_FILE, rendered, { mode: 0o644 });
  rmSync(SMTP_PASSWORD_FILE, { force: true, recursive: true });
  writeFileSync(SMTP_PASSWORD_FILE, process.env.PRL_ALERT_SMTP_PASSWORD ?? '', { mode: 0o600 });
  return rendered;
}

async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.json();
}

const PROMETHEUS = `http://127.0.0.1:${process.env.PRL_STAGING_PROMETHEUS_PORT ?? 9090}`;
const ALERTMANAGER = `http://127.0.0.1:${process.env.PRL_STAGING_ALERTMANAGER_PORT ?? 9093}`;

/**
 * Records what Alertmanager sent and on which path. The path is the assertion. `/page`, `/ticket`
 * and `/heartbeat` are the three routes. Exported so `alert-ack-page.mjs` uses the same recorder.
 */
export function startSink(port = SINK_PORT) {
  const received = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      let payload = null;
      try {
        payload = JSON.parse(body);
      } catch {
        payload = { unparseable: body.slice(0, 200) };
      }
      received.push({ path: request.url ?? '', payload, at: new Date().toISOString() });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });
  });
  return new Promise((done, failed) => {
    server.on('error', failed);
    // 0.0.0.0, because the notification comes from a container over the host gateway.
    server.listen(port, '0.0.0.0', () => done({ received, close: () => server.close() }));
  });
}

export const notificationsFor = (received, path, alertname, status) =>
  received.filter(
    (entry) =>
      entry.path === path &&
      entry.payload?.status === status &&
      (entry.payload?.alerts ?? []).some((alert) => alert?.labels?.alertname === alertname),
  );

/** Status must be `firing`. This alert never resolves, and the receiver sets `send_resolved: false`. */
export const heartbeatArrivals = (received, path = HEARTBEAT_PATH) =>
  notificationsFor(received, path, 'Watchdog', 'firing').map((entry) => Date.parse(entry.at));

export const heartbeatGaps = (arrivals) => arrivals.slice(1).map((at, index) => at - arrivals[index]);

/**
 * Pure, so the test can drive no arrivals, one, and an overdue gap. `minimum` is 3, because one
 * arrival proves the route but not that the pings keep coming.
 *
 * @param {number[]} arrivals epoch milliseconds, ascending
 * @param {{deadlineMs: number, minimum?: number}} bounds
 */
export function heartbeatProblem(arrivals, { deadlineMs, minimum = 3 }) {
  if (arrivals.length === 0) return 'no heartbeat has ever arrived';
  if (arrivals.length < minimum) {
    return `only ${arrivals.length} heartbeat(s) arrived, and ${minimum} are needed to show a rhythm rather than a one-off`;
  }
  const gaps = heartbeatGaps(arrivals);
  const worst = Math.max(...gaps);
  if (worst > deadlineMs) {
    return `the longest gap between pings was ${(worst / 1000).toFixed(1)}s, past the ${(deadlineMs / 1000).toFixed(0)}s deadline a watcher would page on`;
  }
  return null;
}

/**
 * Polls until the heartbeat has been silent past the deadline. Returns the silence in ms, or `null`
 * if a ping arrived inside the budget, which the caller must fail.
 *
 * @param {() => number[]} arrivals a fresh read each poll; the sink is cumulative
 */
export async function watchForSilence(arrivals, deadlineMs, budgetMs) {
  const startedAt = Date.now();
  const seen = arrivals();
  // Measured from the last ping, which is all an outside watcher can see.
  const lastPing = seen.length > 0 ? seen[seen.length - 1] : startedAt;
  const before = seen.length;
  for (;;) {
    const now = Date.now();
    // A new ping resets the timer, as it would a snitch's.
    if (arrivals().length > before) return null;
    const silence = now - lastPing;
    if (silence > deadlineMs) return silence;
    if (now - startedAt > budgetMs) return null;
    await new Promise((done) => setTimeout(done, 1_000));
  }
}

/**
 * Alertmanager's HTML body is one long line, so quoted-printable soft breaks split the alert name
 * mid-word and a raw `includes()` would miss it.
 */
export function decodeQuotedPrintable(text) {
  return text
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}

/**
 * Only the body is decoded. A MIME boundary parameter looks like `=XX` escapes and would be corrupted.
 *
 * @param {string} raw the message as it arrived, without the terminating dot
 */
export function parseMessage(raw) {
  const normalised = raw.replace(/\r\n/g, '\n');
  const split = normalised.indexOf('\n\n');
  const headerText = split === -1 ? normalised : normalised.slice(0, split);
  const body = split === -1 ? '' : normalised.slice(split + 2);
  const headers = new Map();
  let name = null;
  for (const line of headerText.split('\n')) {
    if (/^\s/.test(line) && name !== null) {
      headers.set(name, `${headers.get(name)} ${line.trim()}`);
      continue;
    }
    const header = /^([A-Za-z0-9-]+):\s*(.*)$/.exec(line);
    if (header === null) continue;
    name = header[1].toLowerCase();
    headers.set(name, header[2]);
  }
  return { headers, body: decodeQuotedPrintable(body) };
}

/**
 * A real SMTP server that records what Alertmanager sends. A log says "sent", while the captured
 * RFC822 shows the recipient, subject and body. Go's `net/smtp` cannot tell it from a smarthost.
 * `STARTTLS` and `AUTH` are not advertised, since the sink has no certificate and no credential to
 * check. Exported, with a port, so the test drives the dialogue over a real socket.
 */
export function startSmtpSink(port = SMTP_SINK_PORT) {
  const received = [];
  const server = createSocketServer((socket) => {
    socket.setEncoding('utf8');
    socket.on('error', () => {
      // Empty on purpose. An unhandled ECONNRESET would end the whole run.
    });

    let buffer = '';
    let inData = false;
    let envelope = { from: null, recipients: [] };
    const say = (line) => socket.write(`${line}\r\n`);

    say('220 prl-alert-sink ESMTP ready');

    socket.on('data', (chunk) => {
      buffer += chunk;
      for (;;) {
        if (inData) {
          // A leading CRLF makes an empty body, where the dot arrives first, the same search.
          const haystack = `\r\n${buffer}`;
          const at = haystack.indexOf('\r\n.\r\n');
          if (at === -1) break;
          const message = haystack.slice(2, at);
          buffer = buffer.slice(at + 3);
          inData = false;
          received.push({
            from: envelope.from,
            recipients: envelope.recipients,
            // Dot-unstuffing, so the stored text is the message rather than its wire encoding.
            raw: message.replace(/\r\n\.\./g, '\r\n.').replace(/^\.\./, '.'),
            at: new Date().toISOString(),
          });
          envelope = { from: null, recipients: [] };
          say('250 2.0.0 Ok: queued');
          continue;
        }
        const end = buffer.indexOf('\r\n');
        if (end === -1) break;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const verb = line.split(/[\s:]/, 1)[0].toUpperCase();
        const address = /<([^>]*)>/.exec(line)?.[1] ?? null;
        if (verb === 'EHLO') {
          // Every line but the last is `250-`. `net/smtp` parses these into its extension set.
          socket.write('250-prl-alert-sink\r\n250-8BITMIME\r\n250 SIZE 33554432\r\n');
        } else if (verb === 'HELO') {
          say('250 prl-alert-sink');
        } else if (verb === 'MAIL') {
          envelope.from = address;
          say('250 2.1.0 Ok');
        } else if (verb === 'RCPT') {
          if (address !== null) envelope.recipients.push(address);
          say('250 2.1.5 Ok');
        } else if (verb === 'DATA') {
          inData = true;
          say('354 End data with <CR><LF>.<CR><LF>');
        } else if (verb === 'RSET') {
          envelope = { from: null, recipients: [] };
          say('250 2.0.0 Ok');
        } else if (verb === 'NOOP') {
          say('250 2.0.0 Ok');
        } else if (verb === 'QUIT') {
          say('221 2.0.0 Bye');
          socket.end();
          return;
        } else {
          // Covers STARTTLS and AUTH, so a client that tries them gets an answer instead of a hang.
          say('502 5.5.1 Command not implemented');
        }
      }
    });
  });
  return new Promise((done, failed) => {
    server.on('error', failed);
    // 0.0.0.0 for the container's host-gateway connection. The bound port is returned because the
    // test uses an ephemeral one.
    server.listen(port, '0.0.0.0', () =>
      done({ received, port: server.address().port, close: () => server.close() }),
    );
  });
}

/**
 * Matches on envelope recipients (the tier), `[FIRING`/`[RESOLVED` at the head of the subject, and
 * the alert name in both subject and decoded body.
 *
 * @param {string} to a recipient list as `email_configs.to` spells it, comma-separated
 */
export const emailsFor = (received, to, alertname, status) => {
  const wanted = to
    .split(',')
    .map((address) => address.trim())
    .filter((address) => address !== '');
  // Without this, `every` over no addresses matches every message.
  if (wanted.length === 0) return [];
  const marker = status === 'firing' ? '[FIRING' : '[RESOLVED';
  return received
    .map((entry) => ({ ...entry, ...parseMessage(entry.raw) }))
    .filter((entry) => {
      const subject = entry.headers.get('subject') ?? '';
      return (
        wanted.every((address) => entry.recipients.includes(address)) &&
        subject.startsWith(marker) &&
        subject.includes(alertname) &&
        entry.body.includes(alertname)
      );
    });
};

/** Skips, rather than fails, a tier with no email address, as for a webhook-only deployment. */
async function expectEmail(mail, to, alertname, status, name, budgetMs) {
  if (to === '') {
    note(`${name}: skipped — this tier has no email destination configured`);
    return;
  }
  const waited = await measureUntil(
    () => emailsFor(mail.received, to, alertname, status).length > 0,
    budgetMs,
    500,
  );
  if (waited === null) {
    fail(name, `no ${status} RFC822 message for ${alertname} reached ${to}`);
    return;
  }
  const [message] = emailsFor(mail.received, to, alertname, status);
  pass(
    name,
    `${(waited / 1000).toFixed(0)}s later — ${message.from} → ${message.recipients.join(', ')} — ` +
      `${message.headers.get('subject')}`,
  );
}

const compose = (args) => run('docker', ['compose', ...COMPOSE, ...args]);

async function apiIsHealthy() {
  const result = await run('docker', ['compose', ...COMPOSE, 'ps', '--format', '{{.Service}} {{.Health}}']);
  return /(^|\n)api healthy/.test(result.stdout);
}

/**
 * `smtp_require_tls: false` is right for the local sink and dangerous elsewhere, since the body names
 * the instance, job, threshold and runbook. A same-host relay is legitimate, so this warns.
 */
function warnIfCleartextToARemoteRelay(values) {
  const local = /^(?:host\.docker\.internal|localhost|127\.0\.0\.1|\[::1\]):/;
  if (values.PRL_ALERT_SMTP_SMARTHOST === '' || values.PRL_ALERT_SMTP_REQUIRE_TLS !== 'false') return;
  if (local.test(values.PRL_ALERT_SMTP_SMARTHOST)) return;
  note(yellow(`PRL_ALERT_SMTP_REQUIRE_TLS is false and the relay is ${values.PRL_ALERT_SMTP_SMARTHOST}.`));
  note(yellow('An alert body names the instance, the threshold and the runbook. Set it to true.'));
}

async function main() {
  console.log(bold('\nPoker Risk Lab — alert delivery verification'));

  const { values, overridden } = alertmanagerValues();
  const problems = destinationProblems(values);
  if (problems.length > 0) {
    console.log(red('\n  the alerting destinations are not usable:'));
    for (const problem of problems) console.log(red(`    · ${problem}`));
    console.log(dim('\n  see deploy/staging/observability/alertmanager.template.yml for every variable.\n'));
    return 1;
  }

  // Writes the two files a run would, so the compose command in docker-compose.observability.yml's
  // header can be run by hand.
  if (options.renderConfig) {
    writeAlertmanagerConfig(values);
    console.log(dim(`\n  wrote ${CONFIG_FILE}`));
    console.log(dim(`  wrote ${SMTP_PASSWORD_FILE} (0600)`));
    warnIfCleartextToARemoteRelay(values);
    console.log('');
    return 0;
  }

  if (!existsSync(STAGING_ENV)) {
    console.log(red('\n  deploy/staging/.env.staging does not exist. Run `pnpm run staging init` first.\n'));
    return 1;
  }
  const stagingEnv = readFileSync(STAGING_ENV, 'utf8');
  const token = /^PRL_STAGING_METRICS_TOKEN=(.+)$/m.exec(stagingEnv)?.[1]?.trim() ?? null;
  if (token === null) {
    console.log(red('\n  PRL_STAGING_METRICS_TOKEN is not in deploy/staging/.env.staging.\n'));
    return 1;
  }
  if (!(await apiIsHealthy())) {
    console.log(red('\n  The staging API is not healthy. Run `pnpm run staging up` first.\n'));
    return 1;
  }

  let sink;
  let mail;
  try {
    sink = await startSink();
    mail = await startSmtpSink();
  } catch (error) {
    // Usually a previous run, often `--keep-up`, still holding a port. Close the webhook sink too, or
    // the next run fails on the other port.
    sink?.close();
    console.log(
      red(`\n  a notification sink could not listen on ${SINK_PORT}/${SMTP_SINK_PORT}: ${error.message}`),
    );
    console.log(
      dim('  another alerts:verify run is probably still up. `pnpm run alerts:verify -- --keep-up`'),
    );
    console.log(dim('  leaves one behind on purpose; stop it, or free the port, and run this again.\n'));
    return 1;
  }
  let broughtUp = false;

  try {
    // Written every run, at 0600, so a rotated token never leaves a stale one. It is written inside
    // the `try` so the `finally` deletes it when a sink port is busy. `rmSync` first, because Docker
    // creates a directory for a missing bind-mount source, and Prometheus then reports "is a
    // directory" as if the token were bad.
    rmSync(TOKEN_FILE, { force: true, recursive: true });
    writeFileSync(TOKEN_FILE, `${token}\n`, { mode: 0o600 });

    // The rendered text is kept so the check below can compare it with the running process.
    const rendered = writeAlertmanagerConfig(values);

    section('Bringing up Prometheus and Alertmanager beside the staging stack');
    note(`webhook sink on :${SINK_PORT}, SMTP sink on :${SMTP_SINK_PORT}, both on 0.0.0.0`);
    note(`page → ${values.PRL_ALERT_PAGE_WEBHOOK_URL} and ${values.PRL_ALERT_PAGE_EMAIL_TO}`);
    note(`ticket → ${values.PRL_ALERT_TICKET_WEBHOOK_URL} and ${values.PRL_ALERT_TICKET_EMAIL_TO}`);
    note(
      `heartbeat → ${values.PRL_ALERT_HEARTBEAT_WEBHOOK_URL} every ` +
        `${values.PRL_ALERT_HEARTBEAT_INTERVAL} (a machine, never a person)`,
    );
    if (overridden.length > 0) {
      note(yellow(`overridden from the environment: ${overridden.join(', ')}`));
      note(yellow('a destination outside this host cannot be observed here, and its check will fail'));
    }
    warnIfCleartextToARemoteRelay(values);
    // `--force-recreate`, or a container from an interrupted run keeps a directory mounted at
    // /etc/prometheus/metrics-token. `blackbox` is named because nothing depends on it.
    const up = await compose(['up', '-d', '--force-recreate', 'prometheus', 'alertmanager', 'blackbox']);
    if (up.code !== 0) {
      fail('compose up', up.stderr.trim().split('\n').slice(-3).join(' | '));
      return 1;
    }
    broughtUp = true;

    const ready = await measureUntil(
      async () =>
        (await fetch(`${PROMETHEUS}/-/ready`).then((r) => r.ok)) &&
        (await fetch(`${ALERTMANAGER}/-/ready`).then((r) => r.ok)),
      60_000,
      500,
    );
    if (ready === null) {
      fail('both services ready', 'Prometheus or Alertmanager never answered /-/ready');
      return 1;
    }
    pass('both services ready', `${(ready / 1000).toFixed(1)}s`);

    // Asks the running Alertmanager what it loaded, which catches a stale mount. It also runs under
    // `--skip-provoke`.
    const status = await getJson(`${ALERTMANAGER}/api/v2/status`);
    const liveConfig = status?.config?.original ?? '';
    // Webhook URLs come back as `<secret>`, so webhooks are compared by count of blocks and the email
    // recipient and smarthost by value.
    const blocks = (text, key) => (text.match(new RegExp(`${key}:`, 'g')) ?? []).length;
    const shapeProblems = [];
    for (const key of ['webhook_configs', 'email_configs']) {
      if (blocks(liveConfig, key) !== blocks(rendered, key)) {
        shapeProblems.push(`${blocks(liveConfig, key)} ${key} live, ${blocks(rendered, key)} rendered`);
      }
    }
    for (const destination of [
      values.PRL_ALERT_PAGE_EMAIL_TO,
      values.PRL_ALERT_TICKET_EMAIL_TO,
      values.PRL_ALERT_SMTP_SMARTHOST,
    ]) {
      if (destination !== '' && !liveConfig.includes(destination)) shapeProblems.push(destination);
    }
    if (shapeProblems.length > 0) {
      fail('Alertmanager loaded the rendered destinations', shapeProblems.join('; '));
    } else {
      pass(
        'Alertmanager loaded the rendered destinations',
        `${blocks(rendered, 'webhook_configs')} webhook, ${blocks(rendered, 'email_configs')} email ` +
          '(the webhook URLs read back as <secret>, so they are compared by shape)',
      );
    }

    // One scrape interval plus a margin before any expression has real data.
    const scraped = await measureUntil(
      async () => {
        const result = await getJson(`${PROMETHEUS}/api/v1/query?query=up%7Bjob%3D%22prl-api%22%7D`);
        return result?.data?.result?.[0]?.value?.[1] === '1';
      },
      60_000,
      1_000,
    );
    if (scraped === null) {
      fail('the API is being scraped', 'up{job="prl-api"} never became 1 — check the bearer token');
      return 1;
    }
    pass('the API is being scraped', `up{job="prl-api"} = 1 after ${(scraped / 1000).toFixed(1)}s`);

    const rulesText = readFileSync(RULES_FILE, 'utf8');
    const declared = alertsInRulesFile(rulesText);
    const expressions = expressionsInRulesFile(rulesText);

    // Every check below is a `filter(...).length === 0`, which an empty parse passes. So the parse
    // must be non-empty and `expressions.size` must equal `declared.size`.
    if (declared.size === 0) {
      fail(
        'the rules file parsed to at least one alert',
        `${RULES_FILE} yielded no alerts — a parse of nothing is not a pass`,
      );
      return 1;
    }
    const withoutExpression = [...declared.keys()].filter((name) => !expressions.has(name));
    if (withoutExpression.length > 0 || expressions.size !== declared.size) {
      fail(
        'every parsed rule has exactly one parsed expression',
        `${declared.size} alert(s), ${expressions.size} expression(s)` +
          (withoutExpression.length > 0 ? `; no expression for ${withoutExpression.join(', ')}` : ''),
      );
      return 1;
    }
    pass('the rules file parses', `${declared.size} alerts, ${expressions.size} expressions`);

    section('1. Every rule is loaded, has a severity, and names a runbook that exists');
    // A loaded rule reports `health: "unknown"` until its first evaluation, so wait for every rule to
    // be evaluated once before judging health.
    const readRules = async () => {
      const loaded = await getJson(`${PROMETHEUS}/api/v1/rules`);
      const rules = new Map();
      for (const group of loaded?.data?.groups ?? []) {
        for (const rule of group.rules ?? []) {
          if (rule.type === 'alerting') rules.set(rule.name, rule);
        }
      }
      return rules;
    };
    const evaluated = await measureUntil(
      async () => {
        const rules = await readRules();
        return rules.size > 0 && [...rules.values()].every((rule) => rule.health !== 'unknown');
      },
      90_000,
      1_000,
    );
    if (evaluated === null)
      note('some rules were still unevaluated after 90s; reporting their health as it stands');
    const live = await readRules();
    const missing = [...declared.keys()].filter((name) => !live.has(name));
    if (missing.length > 0)
      fail('every declared rule is loaded', `Prometheus does not have ${missing.join(', ')}`);
    else pass('every declared rule is loaded', `${live.size} alerting rules`);

    const withErrors = [...live.values()].filter((rule) => rule.health !== 'ok');
    if (withErrors.length > 0) {
      fail(
        'no rule reports an evaluation error',
        withErrors.map((r) => `${r.name}: ${r.lastError}`).join('; '),
      );
    } else {
      pass('no rule reports an evaluation error');
    }

    const ROUTED_SEVERITIES = ['page', 'ticket', 'heartbeat'];
    const badSeverity = [...declared].filter(([, rule]) => !ROUTED_SEVERITIES.includes(rule.severity));
    const bySeverity = (wanted) => [...declared].filter(([, rule]) => rule.severity === wanted);
    if (badSeverity.length > 0) {
      fail('every rule is page, ticket or heartbeat', badSeverity.map(([name]) => name).join(', '));
    } else {
      pass(
        'every rule is page, ticket or heartbeat',
        ROUTED_SEVERITIES.map((severity) => `${bySeverity(severity).length} ${severity}`).join(', '),
      );
    }

    // Exactly one heartbeat, `Watchdog`. Another rule on that route makes the snitch alarm for the
    // wrong reason.
    const heartbeats = bySeverity('heartbeat').map(([name]) => name);
    if (heartbeats.length !== 1 || heartbeats[0] !== 'Watchdog') {
      fail(
        'exactly one rule is the heartbeat, and it is Watchdog',
        heartbeats.length === 0
          ? "no rule carries severity: heartbeat, so nothing pings the dead man's switch and its " +
              'silence would be permanent and meaningless'
          : `severity: heartbeat is carried by ${heartbeats.join(', ')}`,
      );
    } else {
      pass('exactly one rule is the heartbeat, and it is Watchdog');
    }

    const badRunbook = [...declared].filter(
      ([, rule]) => rule.runbook === null || !existsSync(join(REPO_ROOT, rule.runbook)),
    );
    if (badRunbook.length > 0) {
      fail('every runbook annotation exists on disk', badRunbook.map(([name]) => name).join(', '));
    } else {
      pass('every runbook annotation exists on disk');
    }

    // See `runbookNamingProblems`.
    const naming = runbookNamingProblems(declared, (path) => {
      const full = join(REPO_ROOT, path);
      return existsSync(full) ? readFileSync(full, 'utf8') : null;
    });
    if (naming.length > 0) {
      fail(
        'every runbook names the alert that opens it, in its Detection section',
        naming.map((p) => `${p.alert} → ${basename(p.runbook)} ${p.reason}`).join('; '),
      );
    } else {
      pass(
        'every runbook names the alert that opens it, in its Detection section',
        `${declared.size} alerts`,
      );
    }

    section('2. The rules file and docs/production/alerts.md describe the same alerts');
    const documented = alertsInDocument(readFileSync(ALERTS_DOC, 'utf8'));
    const onlyInDoc = [...documented.keys()].filter((name) => !declared.has(name));
    const onlyInRules = [...declared.keys()].filter((name) => !documented.has(name));
    if (onlyInDoc.length > 0 || onlyInRules.length > 0) {
      fail(
        'the two sets are identical',
        `only in the document: ${onlyInDoc.join(', ') || 'none'}; only in the rules: ${onlyInRules.join(', ') || 'none'}`,
      );
    } else {
      pass('the two sets are identical', `${documented.size} alerts`);
    }
    const severityDrift = [...documented].filter(
      ([name, severity]) => declared.get(name)?.severity !== severity,
    );
    if (severityDrift.length > 0) {
      fail(
        'the severities agree',
        severityDrift.map(([name, severity]) => `${name}: doc says ${severity}`).join(', '),
      );
    } else {
      pass('the severities agree');
    }

    section('3. Every series the rules name appears in a live scrape');
    // Retried, because check 6 floods the limiter from this same loopback address and the ban
    // outlasts the run. A 429 is not an answer. The budget is bounded, so a real gap still fails.
    let exported = new Set();
    const read = await measureUntil(
      async () => {
        const exposition = await run('docker', [
          'compose',
          ...COMPOSE,
          'exec',
          '-T',
          'api',
          'node',
          '-e',
          "fetch('http://127.0.0.1:3001/metrics',{headers:{authorization:'Bearer '+process.env.METRICS_TOKEN}})" +
            '.then((r)=>r.text()).then((t)=>console.log(t))',
        ]);
        exported = new Set(
          exposition.stdout
            .split('\n')
            .filter((line) => line.startsWith('# TYPE '))
            .map((line) => line.split(' ')[2]),
        );
        return exported.size > 0;
      },
      90_000,
      5_000,
    );
    if (read !== null && read > 6_000) {
      note(
        `the exposition took ${(read / 1000).toFixed(0)}s to read — a previous run's ban was still in force`,
      );
    }
    if (exported.size === 0) {
      fail('the API exposition could be read', 'no # TYPE lines came back from the api container within 90s');
    } else {
      const unknown = new Map();
      for (const [name, expression] of expressions) {
        for (const series of seriesReferencedBy(expression)) {
          if (!exported.has(series)) unknown.set(series, name);
        }
      }
      if (unknown.size > 0) {
        fail('every series exists', [...unknown].map(([series, alert]) => `${series} (${alert})`).join(', '));
      } else {
        pass('every series exists', `${exported.size} metric families exported`);
      }
    }

    // Both the `/metrics` read and `up{job="prl-alertmanager"} == 1` are required. Without the second,
    // `AlertmanagerNotificationsFailing` could never fire and nothing would report it.
    const alertmanagerSeries = new Map();
    for (const [name, expression] of expressions) {
      for (const series of alertmanagerSeriesReferencedBy(expression)) alertmanagerSeries.set(series, name);
    }
    const exposition = await fetch(`${ALERTMANAGER}/metrics`, { signal: AbortSignal.timeout(10_000) })
      .then((response) => (response.ok ? response.text() : ''))
      .catch(() => '');
    const alertmanagerExported = new Set(
      exposition
        .split('\n')
        .filter((line) => line.startsWith('# TYPE '))
        .map((line) => line.split(' ')[2]),
    );
    const scrapingAlertmanager = await measureUntil(
      async () => {
        const result = await getJson(
          `${PROMETHEUS}/api/v1/query?query=${encodeURIComponent('up{job="prl-alertmanager"}')}`,
        );
        return result?.data?.result?.[0]?.value?.[1] === '1';
      },
      60_000,
      1_000,
    );
    const alertmanagerUnknown = [...alertmanagerSeries].filter(
      ([series]) => !alertmanagerExported.has(series),
    );
    if (alertmanagerSeries.size === 0) {
      // A grounding of zero series is not a pass.
      fail(
        'every alertmanager_* series exists and Prometheus is scraping Alertmanager',
        'no rule names an alertmanager_* series, so nothing watches the alerting system itself',
      );
    } else if (alertmanagerExported.size === 0) {
      fail(
        'every alertmanager_* series exists and Prometheus is scraping Alertmanager',
        `no # TYPE lines came back from ${ALERTMANAGER}/metrics`,
      );
    } else if (alertmanagerUnknown.length > 0) {
      fail(
        'every alertmanager_* series exists and Prometheus is scraping Alertmanager',
        alertmanagerUnknown.map(([series, alert]) => `${series} (${alert})`).join(', '),
      );
    } else if (scrapingAlertmanager === null) {
      fail(
        'every alertmanager_* series exists and Prometheus is scraping Alertmanager',
        'up{job="prl-alertmanager"} never became 1 — the scrape job in prometheus.yml is missing ' +
          'or misnamed, and AlertmanagerDown is keyed on that exact job label',
      );
    } else {
      pass(
        'every alertmanager_* series exists and Prometheus is scraping Alertmanager',
        `${alertmanagerSeries.size} series in ${alertmanagerExported.size} families, ` +
          `up{job="prl-alertmanager"} = 1 after ${(scrapingAlertmanager / 1000).toFixed(1)}s`,
      );
    }

    // The empty case fails. The API is scraped on the compose network, so without a `probe_*` rule a
    // dead proxy, TLS or page server leaves every alert green.
    const probeSeries = new Map();
    for (const [name, expression] of expressions) {
      for (const series of probeSeriesReferencedBy(expression)) probeSeries.set(series, name);
    }
    const PROBE_JOB = 'prl-public-origin';
    const probeCheck = `every probe_* series exists and the ${PROBE_JOB} probe is being scraped`;
    if (probeSeries.size === 0) {
      fail(
        probeCheck,
        'no rule names a probe_* series, so nothing looks at this deployment from outside the ' +
          'application: with the API scraped on the compose network, a dead proxy, an expired ' +
          'certificate or a dead page server would fire nothing at all',
      );
    } else {
      const probeUp = await measureUntil(
        async () => {
          const result = await getJson(
            `${PROMETHEUS}/api/v1/query?query=${encodeURIComponent(`up{job="${PROBE_JOB}"}`)}`,
          );
          const series = result?.data?.result ?? [];
          return series.length > 0 && series.every((s) => s.value?.[1] === '1');
        },
        90_000,
        1_000,
      );
      // Asked with the rules' job selector, since a real name under another job never fires.
      const probeUnknown = [];
      for (const [series, alert] of probeSeries) {
        const result = await getJson(
          `${PROMETHEUS}/api/v1/query?query=${encodeURIComponent(`${series}{job="${PROBE_JOB}"}`)}`,
        );
        if ((result?.data?.result ?? []).length === 0) probeUnknown.push(`${series} (${alert})`);
      }
      if (probeUp === null) {
        fail(
          probeCheck,
          `up{job="${PROBE_JOB}"} is not 1 for every target — the blackbox scrape job in ` +
            'prometheus.yml is missing, misnamed, or the exporter is not answering /probe',
        );
      } else if (probeUnknown.length > 0) {
        fail(probeCheck, probeUnknown.join(', '));
      } else {
        pass(probeCheck, `${probeSeries.size} series, up{job="${PROBE_JOB}"} = 1 for every target`);
      }
    }

    section('4. Every expression evaluates against the live data');
    const broken = [];
    for (const [name, expression] of expressions) {
      try {
        const result = await getJson(`${PROMETHEUS}/api/v1/query?query=${encodeURIComponent(expression)}`);
        if (result?.status !== 'success') broken.push(`${name}: ${result?.error ?? 'unknown error'}`);
      } catch (error) {
        broken.push(`${name}: ${error.message}`);
      }
    }
    if (broken.length > 0) fail('every expression evaluates', broken.join('; '));
    else pass('every expression evaluates', `${expressions.size} expressions`);

    if (options.skipProvoke || options.onlyHeartbeat) {
      section('5. Delivery');
      const flag = options.skipProvoke ? '--skip-provoke' : '--only-heartbeat';
      note(`${flag}: the API was not stopped, so nothing was provoked. This run does NOT`);
      note('verify delivery of an incident over either transport; it verifies that the rules are');
      note('loaded, agreed, grounded and evaluable, and that Alertmanager loaded the destinations.');
    } else {
      section('5. ApiDown, provoked: stop the API and follow the alert to a receiver');
      note('the staging API is stopped for about four minutes: two of failed scrapes before');
      note("max_over_time(up[2m]) == 0 can hold, and then ApiDown's own for: 2m on top of it");
      const stopped = await compose(['stop', 'api']);
      apiStopped = stopped.code === 0;
      if (stopped.code !== 0) {
        fail('the API could be stopped', stopped.stderr.trim());
      } else {
        try {
          // Six minutes. `for: 2m` starts only after `max_over_time(up[2m])` has two minutes of
          // failures, so firing comes a little over four minutes after the stop.
          const firing = await measureUntil(
            async () => {
              const result = await getJson(`${PROMETHEUS}/api/v1/rules?type=alert`);
              for (const group of result?.data?.groups ?? []) {
                for (const rule of group.rules ?? []) {
                  if (rule.name !== 'ApiDown') continue;
                  if ((rule.alerts ?? []).some((alert) => alert.state === 'firing')) return true;
                }
              }
              return false;
            },
            360_000,
            2_000,
          );
          if (firing === null)
            fail('ApiDown reached firing', 'it never left inactive or pending within six minutes');
          else pass('ApiDown reached firing', `${(firing / 1000).toFixed(0)}s after the API stopped`);

          const atManager = await measureUntil(
            async () => {
              const alerts = await getJson(`${ALERTMANAGER}/api/v2/alerts`);
              return alerts.some((alert) => alert?.labels?.alertname === 'ApiDown');
            },
            90_000,
            1_000,
          );
          if (atManager === null) fail('Alertmanager received it', 'no ApiDown in /api/v2/alerts');
          else pass('Alertmanager received it', `${(atManager / 1000).toFixed(0)}s later`);

          const delivered = await measureUntil(
            () => notificationsFor(sink.received, '/page', 'ApiDown', 'firing').length > 0,
            90_000,
            500,
          );
          if (delivered === null) fail('the paging receiver was notified', 'no POST to /page named ApiDown');
          else pass('the paging receiver was notified', `${(delivered / 1000).toFixed(0)}s later, on /page`);

          // The same notification over SMTP. Asserts the paging address, the firing subject, and the body.
          await expectEmail(
            mail,
            values.PRL_ALERT_PAGE_EMAIL_TO,
            'ApiDown',
            'firing',
            'the paging address was emailed over SMTP',
            90_000,
          );
        } finally {
          const restarted = await compose(['start', 'api']);
          if (restarted.code === 0) apiStopped = false;
          if (restarted.code !== 0) {
            fail('the API was restored', restarted.stderr.trim());
          } else {
            const healthy = await measureUntil(apiIsHealthy, 180_000, 2_000);
            if (healthy === null) fail('the API was restored', 'the container never became healthy again');
            else pass('the API was restored', `healthy after ${(healthy / 1000).toFixed(0)}s`);
          }
        }

        // `send_resolved` is off by default in several receivers. A missing resolve leaves an incident open.
        const resolved = await measureUntil(
          () => notificationsFor(sink.received, '/page', 'ApiDown', 'resolved').length > 0,
          180_000,
          1_000,
        );
        if (resolved === null)
          fail('the resolved notification arrived', 'nothing with status=resolved reached /page');
        else pass('the resolved notification arrived', `${(resolved / 1000).toFixed(0)}s after recovery`);

        await expectEmail(
          mail,
          values.PRL_ALERT_PAGE_EMAIL_TO,
          'ApiDown',
          'resolved',
          'the resolved email arrived',
          180_000,
        );

        // Checked last, after the ticket route's own `group_wait`, so a duplicate on `/ticket` has had
        // time to arrive. This tests `continue: false`.
        const wrongPath = notificationsFor(sink.received, '/ticket', 'ApiDown', 'firing');
        // `continue: false` governs both transports, so check the ticket inbox too.
        const wrongInbox = emailsFor(mail.received, values.PRL_ALERT_TICKET_EMAIL_TO, 'ApiDown', 'firing');
        if (wrongPath.length > 0 || wrongInbox.length > 0) {
          fail(
            'a page did not also raise a ticket',
            `${wrongPath.length} notification(s) reached /ticket, ${wrongInbox.length} email(s) reached ${values.PRL_ALERT_TICKET_EMAIL_TO}`,
          );
        } else {
          pass(
            'a page did not also raise a ticket',
            'severity routing holds on both transports, checked after settling',
          );
        }
      }

      // Check 6. `RateLimitBans` has no `for:`, so one ban fires it within a scrape interval. The
      // flood runs inside the api container on its own loopback, so it is one bucket and does not
      // spend the smoke test's guest budget.
      section('6. RateLimitBans, provoked: a ticket must reach the ticket receiver and not the pager');
      const flood = await run('docker', [
        'compose',
        ...COMPOSE,
        'exec',
        '-T',
        'api',
        'node',
        '-e',
        // 700 sequential requests. The defaults are 300/minute and a ban 200 past it, so a ban lands
        // past 500. Parallel sockets would measure the accept queue.
        "const base='http://127.0.0.1:'+(process.env.PORT||3001)+'/api/v1/ready';" +
          '(async()=>{let banned=0,ok=0;for(let i=0;i<700;i+=1){' +
          'const r=await fetch(base).catch(()=>null);if(r===null)continue;' +
          'if(r.status===200)ok+=1;if(r.status===429)banned+=1;}' +
          'console.log(JSON.stringify({ok,refused:banned}));})()',
      ]);
      if (flood.code !== 0) {
        fail(
          'the limiter could be driven past its ban threshold',
          flood.stderr.trim().split('\n').slice(-2).join(' | '),
        );
      } else {
        pass('the limiter was driven past its ban threshold', flood.stdout.trim().split('\n').pop() ?? '');

        // The metric first, so a silent rule with no ban is not reported as broken.
        const banned = await measureUntil(
          async () => {
            const result = await getJson(
              `${PROMETHEUS}/api/v1/query?query=${encodeURIComponent('sum(increase(prl_rate_limit_events_total{kind="banned"}[15m]))')}`,
            );
            return Number(result?.data?.result?.[0]?.value?.[1] ?? 0) > 0;
          },
          120_000,
          2_000,
        );
        if (banned === null) {
          fail('a ban was recorded in the metrics', 'prl_rate_limit_events_total{kind="banned"} never rose');
        } else {
          pass('a ban was recorded in the metrics', `${(banned / 1000).toFixed(0)}s after the flood`);

          const ticketed = await measureUntil(
            () => notificationsFor(sink.received, '/ticket', 'RateLimitBans', 'firing').length > 0,
            180_000,
            1_000,
          );
          if (ticketed === null) {
            fail('the ticket receiver was notified', 'no POST to /ticket named RateLimitBans');
          } else {
            pass('the ticket receiver was notified', `${(ticketed / 1000).toFixed(0)}s later, on /ticket`);
          }

          await expectEmail(
            mail,
            values.PRL_ALERT_TICKET_EMAIL_TO,
            'RateLimitBans',
            'firing',
            'the ticket address was emailed over SMTP',
            180_000,
          );

          // A ticket must not page, on either transport.
          const paged = notificationsFor(sink.received, '/page', 'RateLimitBans', 'firing');
          const pagedByMail = emailsFor(
            mail.received,
            values.PRL_ALERT_PAGE_EMAIL_TO,
            'RateLimitBans',
            'firing',
          );
          if (paged.length > 0 || pagedByMail.length > 0) {
            fail(
              'a ticket did not also page',
              `${paged.length} notification(s) reached /page, ${pagedByMail.length} email(s) reached ${values.PRL_ALERT_PAGE_EMAIL_TO}`,
            );
          } else {
            pass('a ticket did not also page', 'both tiers proven, both directions, both transports');
          }
        }
      }
    }

    if (options.skipProvoke) {
      section("7. The dead man's switch");
      note('--skip-provoke: the heartbeat was NOT observed. This run does not show that the');
      note('Watchdog notification keeps arriving, that it stays off both human tiers, or that');
      note('its absence is detected. `--only-heartbeat` runs exactly this section in ~3 minutes.');
    } else {
      section("7. The dead man's switch: the heartbeat, its rhythm, and its silence");
      const intervalMs = durationMs(values.PRL_ALERT_HEARTBEAT_INTERVAL) ?? 20_000;
      // Three intervals, so one missed beat does not alarm and the blind window stays near a minute.
      const deadlineMs = 3 * intervalMs;
      note(
        `interval ${values.PRL_ALERT_HEARTBEAT_INTERVAL}, deadline ${(deadlineMs / 1000).toFixed(0)}s ` +
          `(3 intervals) → ${values.PRL_ALERT_HEARTBEAT_WEBHOOK_URL}`,
      );

      // Asked of Prometheus, to separate "the rule is not firing" from "delivery is broken".
      const watchdogFiring = await measureUntil(
        async () => {
          const result = await getJson(`${PROMETHEUS}/api/v1/rules?type=alert`);
          for (const group of result?.data?.groups ?? []) {
            for (const rule of group.rules ?? []) {
              if (rule.name !== 'Watchdog') continue;
              return (rule.alerts ?? []).some((alert) => alert.state === 'firing');
            }
          }
          return false;
        },
        60_000,
        2_000,
      );
      if (watchdogFiring === null) {
        fail(
          'the Watchdog rule is firing',
          'no firing Watchdog in Prometheus — an always-on rule that is not on is the switch ' +
            'already dead, and nothing downstream of it can be trusted',
        );
      } else {
        pass('the Watchdog rule is firing', 'always, by construction — vector(1), no for:');
      }

      const arrivals = () => heartbeatArrivals(sink.received);
      const first = await measureUntil(() => arrivals().length > 0, deadlineMs + 30_000, 1_000);
      if (first === null) {
        fail(
          'the heartbeat reaches its own receiver',
          `nothing named Watchdog has arrived on ${HEARTBEAT_PATH}`,
        );
      } else {
        pass(
          'the heartbeat reaches its own receiver',
          `${arrivals().length} ping(s) so far, on ${HEARTBEAT_PATH}`,
        );
      }

      // Three arrivals, with measured gaps. A rounded-up `repeat_interval` or a single `group_wait`
      // ping both produce a perfect first ping.
      const rhythm = await measureUntil(() => arrivals().length >= 3, 5 * intervalMs + 60_000, 1_000);
      const measured = arrivals();
      const problem = heartbeatProblem(measured, { deadlineMs });
      if (rhythm === null || problem !== null) {
        fail('it keeps arriving on a schedule', problem ?? 'fewer than three pings arrived in time');
      } else {
        pass(
          'it keeps arriving on a schedule',
          `${measured.length} pings, gaps ${heartbeatGaps(measured)
            .map((gap) => `${(gap / 1000).toFixed(1)}s`)
            .join(', ')} — all inside the ${(deadlineMs / 1000).toFixed(0)}s deadline`,
        );
      }

      // A Watchdog on the pager notifies a human every twenty seconds and passes every other check.
      const heartbeatPaged = notificationsFor(sink.received, '/page', 'Watchdog', 'firing');
      const heartbeatTicketed = notificationsFor(sink.received, '/ticket', 'Watchdog', 'firing');
      const heartbeatMailed = [
        ...emailsFor(mail.received, values.PRL_ALERT_PAGE_EMAIL_TO, 'Watchdog', 'firing'),
        ...emailsFor(mail.received, values.PRL_ALERT_TICKET_EMAIL_TO, 'Watchdog', 'firing'),
      ];
      if (heartbeatPaged.length + heartbeatTicketed.length + heartbeatMailed.length > 0) {
        fail(
          'the heartbeat never reaches a human tier',
          `${heartbeatPaged.length} on /page, ${heartbeatTicketed.length} on /ticket, ` +
            `${heartbeatMailed.length} email(s) — a permanently firing alert on a human tier is a ` +
            'notification every interval, forever',
        );
      } else {
        pass(
          'the heartbeat never reaches a human tier',
          'nothing named Watchdog on /page, /ticket or either inbox',
        );
      }

      // The negative control. Alertmanager is stopped and every rule keeps evaluating with nobody
      // reached. Alertmanager is this script's own container, so stopping it is fair.
      const stoppedManager = await compose(['stop', 'alertmanager']);
      alertmanagerStopped = stoppedManager.code === 0;
      if (stoppedManager.code !== 0) {
        fail('Alertmanager could be stopped for the negative control', stoppedManager.stderr.trim());
      } else {
        // Three seconds for in-flight pings to land.
        await new Promise((done) => setTimeout(done, 3_000));
        const webhooksBefore = sink.received.length;
        const mailsBefore = mail.received.length;
        // Recorded first, so a heartbeat routed to an unwatched path cannot report a vacuous silence.
        const pingsBeforeStop = arrivals().length;
        const silence = await watchForSilence(arrivals, deadlineMs, deadlineMs + 90_000);
        // The incident `alerting-blind.md` opens with. Rules fire and nothing is delivered.
        const stillFiring = await getJson(`${PROMETHEUS}/api/v1/alerts`)
          .then((result) => (result?.data?.alerts ?? []).filter((a) => a.state === 'firing').length)
          .catch(() => -1);
        if (pingsBeforeStop === 0) {
          fail(
            "the dead man's switch fires: a stopped Alertmanager is detected by absence",
            'nothing had ever arrived, so this watched nothing go quiet. A silence with no ' +
              'heartbeat before it is a sweep of nothing, not a detection',
          );
        } else if (silence === null) {
          fail(
            "the dead man's switch fires: a stopped Alertmanager is detected by absence",
            'a ping arrived after Alertmanager was stopped, or the deadline never elapsed — the ' +
              'watcher would not have noticed',
          );
        } else {
          pass(
            "the dead man's switch fires: a stopped Alertmanager is detected by absence",
            `silent for ${(silence / 1000).toFixed(0)}s, past the ${(deadlineMs / 1000).toFixed(0)}s ` +
              `deadline, after ${pingsBeforeStop} ping(s). Prometheus still reports ${stillFiring} ` +
              'alert(s) firing and delivered ' +
              `${sink.received.length - webhooksBefore} webhook(s) and ` +
              `${mail.received.length - mailsBefore} email(s) of any kind in that window`,
          );
        }
        // The detector must also see recovery. This also restores the container for `--keep-up`.
        const restartedManager = await compose(['start', 'alertmanager']);
        if (restartedManager.code === 0) alertmanagerStopped = false;
        if (restartedManager.code !== 0) {
          fail('Alertmanager was restored', restartedManager.stderr.trim());
        } else {
          const wasAt = arrivals().length;
          // Up to `--rules.alert.resend-delay` (1m by default) before Prometheus
          // re-notifies an alert it has already sent, plus the flush, plus a margin.
          const resumed = await measureUntil(() => arrivals().length > wasAt, 180_000, 1_000);
          if (resumed === null) {
            fail(
              'and the heartbeat resumes when it comes back',
              'no further ping after Alertmanager restarted — the switch would stay alarmed',
            );
          } else {
            pass(
              'and the heartbeat resumes when it comes back',
              `${(resumed / 1000).toFixed(0)}s after the restart`,
            );
          }
        }
      }
    }
  } finally {
    sink.close();
    mail.close();
    if (broughtUp && !options.keepUp) {
      await compose(['stop', 'prometheus', 'alertmanager', 'blackbox']);
      await compose(['rm', '-f', 'prometheus', 'alertmanager', 'blackbox']);
    }
    if (!options.keepUp) {
      rmSync(TOKEN_FILE, { force: true, recursive: true });
      // `--keep-up` keeps all three, so no container loses its mounted config.
      rmSync(CONFIG_FILE, { force: true, recursive: true });
      rmSync(SMTP_PASSWORD_FILE, { force: true, recursive: true });
    }
  }

  const failed = checks.filter((check) => !check.ok);
  console.log('');
  if (failed.length === 0) {
    console.log(green(bold(`${checks.length} check(s) passed.`)));
    if (options.skipProvoke) {
      console.log(yellow('  --skip-provoke was used: alert DELIVERY was not verified by this run,'));
      console.log(yellow('  and neither was the heartbeat. This is checks 1-4 and nothing else.'));
    }
    if (options.onlyHeartbeat) {
      console.log(yellow('  --only-heartbeat was used: no incident was provoked, so this run does'));
      console.log(yellow('  NOT verify that a page or a ticket is delivered. Checks 1-4 and 7 only.'));
    }
  } else {
    console.log(red(bold(`${failed.length} of ${checks.length} check(s) failed.`)));
  }
  /** Closing paragraphs are conditional, so a summary never claims what the run disproved. */
  const allPassed = (pattern) =>
    checks.filter((check) => pattern.test(check.name)).every((check) => check.ok);

  if (!options.skipProvoke && !options.onlyHeartbeat && allPassed(/receiver|emailed|page|ticket/)) {
    console.log(
      dim(
        '\n  Both tiers were delivered over an HTTP webhook and over SMTP, to sinks this script\n' +
          '  runs. The SMTP transaction and the RFC822 message are real; what is NOT rehearsed is\n' +
          '  that a provider accepts this deployment’s credentials, that the configured address is\n' +
          '  one a phone watches, or that anybody is awake. Set PRL_ALERT_* to point a deployment\n' +
          '  at its own pager — see deploy/staging/observability/alertmanager.template.yml.\n',
      ),
    );
  }
  if (!options.skipProvoke && allPassed(/heartbeat|dead man's switch|Watchdog/)) {
    console.log(
      dim(
        '\n  The heartbeat was emitted, routed away from both human tiers, and its absence was\n' +
          '  detected here — Alertmanager was stopped and the silence outlasted the deadline. The\n' +
          '  WATCHING half is external by construction: a watcher on this host dies with the host\n' +
          '  it is watching. Point PRL_ALERT_HEARTBEAT_WEBHOOK_URL at a snitch that is not this\n' +
          '  host, and run `pnpm run alerts:ack` for the hop that ends at a person.\n',
      ),
    );
  } else if (!options.skipProvoke) {
    console.log(
      red(
        "\n  The dead man's switch did NOT pass. Read the check lines above rather than this\n" +
          '  paragraph: a heartbeat that is not arriving where the watcher looks is a switch that\n' +
          '  will never alarm, and it fails silently in exactly the way it exists to prevent.\n',
      ),
    );
  }

  if (options.json || options.out !== null) {
    const report = {
      schema: 'prl.alert-delivery.v3',
      provoked: !options.skipProvoke && !options.onlyHeartbeat,
      destinations: values,
      overridden,
      checks,
      // The observed gaps, since the claim is about a cadence.
      heartbeat: {
        path: HEARTBEAT_PATH,
        intervalMs: durationMs(values.PRL_ALERT_HEARTBEAT_INTERVAL),
        arrivals: heartbeatArrivals(sink.received).length,
        gapsMs: heartbeatGaps(heartbeatArrivals(sink.received)),
        reachedAHumanTier:
          notificationsFor(sink.received, '/page', 'Watchdog', 'firing').length +
          notificationsFor(sink.received, '/ticket', 'Watchdog', 'firing').length,
      },
      notifications: sink.received.map((entry) => ({
        path: entry.path,
        status: entry.payload?.status ?? null,
        receiver: entry.payload?.receiver ?? null,
        alerts: (entry.payload?.alerts ?? []).map((alert) => alert?.labels?.alertname ?? null),
        at: entry.at,
      })),
      // The label block only. The default template is ten kilobytes of HTML per message.
      emails: mail.received.map((entry) => {
        const { headers, body } = parseMessage(entry.raw);
        return {
          from: entry.from,
          recipients: entry.recipients,
          subject: headers.get('subject') ?? null,
          to: headers.get('to') ?? null,
          contentType: headers.get('content-type') ?? null,
          bytes: entry.raw.length,
          bodyExcerpt: body
            .split('\n')
            .filter((line) => line.includes('alertname'))
            .map((line) =>
              line
                .replace(/<[^>]*>/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 200),
            ),
          at: entry.at,
        };
      }),
    };
    const text = `${JSON.stringify(report, null, 2)}\n`;
    if (options.out !== null) writeFileSync(options.out, text);
    if (options.json) console.log(text);
  }

  return failed.length === 0 ? 0 : 1;
}

// The test imports this file and must not bring a compose stack up.
if (import.meta.main) {
  // A signal does not run `finally`, so restart the API and exit non-zero.
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      if (apiStopped) {
        console.log(yellow(`\n  ${signal}: restarting the staging API before exiting.`));
        spawnSync('docker', ['compose', ...COMPOSE, 'start', 'api'], { stdio: 'inherit' });
      }
      if (alertmanagerStopped) {
        console.log(yellow(`  ${signal}: restarting Alertmanager before exiting.`));
        spawnSync('docker', ['compose', ...COMPOSE, 'start', 'alertmanager'], { stdio: 'inherit' });
      }
      process.exit(130);
    });
  }
  process.exitCode = await main();
}

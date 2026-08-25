#!/usr/bin/env node
/**
 * Verifies that the alerts in `docs/production/alerts.md` fire, route and arrive.
 *
 * This is what `pnpm run alerts:verify` does.
 *
 * ## The gap this closes
 *
 * `docs/production/alerts.md` ends with a sentence it earned: *"Provoking a rule
 * and watching it fire is the only evidence that it is wired correctly. Until that
 * has been done against a real Prometheus, this file describes intent — and says
 * so."* Two independent release reviews of this project then recorded the same
 * finding from the other side — "alert delivery UNVERIFIED", "no Alertmanager in
 * staging compose" — and both were correct. Twenty-two rules existed as PromQL in
 * a markdown file, and not one of them had ever been evaluated.
 *
 * A rule that has never been evaluated fails in ways prose cannot show. A metric
 * renamed in `observability/metrics.ts` leaves the expression syntactically
 * perfect and permanently false. A `job` label that does not match the scrape
 * config disables `ApiDown` — the alert whose entire job is to notice that
 * everything else stopped reporting. A severity label nobody routes on sends a
 * page to a ticket queue. Each of those is silent, and each is checked below.
 *
 * ## The five checks, and why each one is separate
 *
 * 1. **Loaded** — every rule in `alert-rules.yml` is present in a live Prometheus
 *    with no evaluation error, carries `severity: page` or `severity: ticket`, and
 *    names a runbook that exists on disk.
 * 2. **Agreed** — the alert names and severities in the rules file and in
 *    `docs/production/alerts.md` are the same set. The document is the reasoning;
 *    the file is the behaviour. Two sets that drift is how a threshold gets
 *    changed in one place.
 * 3. **Grounded** — every `prl_*` series an expression mentions appears in a live
 *    scrape of the API. This is the invariant that document states in its own
 *    second paragraph: *"If a name below does not appear in a live scrape of GET
 *    /metrics, the rule is wrong."*
 * 4. **Evaluable** — every expression is executed by Prometheus. A rule that
 *    cannot be parsed or that references a label set that does not exist is a rule
 *    that will never fire, and it looks identical to a quiet one.
 * 5. **Delivered** — `ApiDown` is provoked for real: the API container is stopped,
 *    the rule is watched through pending into firing, Alertmanager is watched for
 *    the alert, and a receiver on this host is watched for the notification. Then
 *    the API is restored and the resolved notification is watched for too. The
 *    notification must arrive on the PAGING path and not the ticket one, which is
 *    what makes it a test of the two-tier rule rather than of a webhook.
 *
 * ## What this does NOT prove
 *
 * That a human is reached. Both receivers are a webhook sink this script runs on
 * loopback; there is no PagerDuty account here and no ticket queue, and inventing
 * credentials for either would rehearse somebody else's configuration rather than
 * this one. Production replaces two URLs in `alertmanager.yml`. The last hop — the
 * one that ends at somebody's phone at 3am — remains unrehearsed and the readiness
 * report says so.
 *
 * It also proves nothing about the twenty-one rules it does not provoke. Checks 1
 * to 4 say they are loaded, agreed, grounded and evaluable, which is a great deal
 * more than a markdown file said and a great deal less than "tested".
 * `docs/production/alerts.md` § Verifying these rules lists how to provoke each of
 * them by hand.
 *
 * ## Why it stops the API rather than fabricating an alert
 *
 * Alertmanager has an API that accepts an alert directly, and using it would make
 * this finish in five seconds. It would also skip Prometheus entirely — the scrape,
 * the rule, the `for` duration and the label that routes it — which is most of what
 * can be wrong. `ApiDown` is the right rule to provoke because it is the only one
 * whose condition is reachable without generating load, and because it is keyed on
 * `up`, so it also proves the scrape itself works.
 *
 * The cost is time: `for: 2m` plus `group_wait` plus the scrape interval, so a run
 * takes roughly three to four minutes and the staging API is stopped for about two
 * of them. Staging is disposable and that is the point of having one.
 *
 * Usage:
 *     pnpm run alerts:verify
 *     node scripts/alert-delivery.mjs --skip-provoke   # checks 1-4 only, ~20s
 *     node scripts/alert-delivery.mjs --keep-up        # leave Prometheus running
 *     node scripts/alert-delivery.mjs --json --out alerts.json
 *
 * Exit codes:
 *     0  every check passed
 *     1  any check failed, or the stack could not be brought up
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { bold, dim, green, measureUntil, REPO_ROOT, red, run, yellow } from './drills/harness.mjs';

// ---------------------------------------------------------------------------
// Where everything lives
// ---------------------------------------------------------------------------

const STAGING_ENV = join(REPO_ROOT, 'deploy', 'staging', '.env.staging');
const OBSERVABILITY = join(REPO_ROOT, 'deploy', 'staging', 'observability');
const RULES_FILE = join(OBSERVABILITY, 'alert-rules.yml');
const TOKEN_FILE = join(OBSERVABILITY, 'metrics-token');
const ALERTS_DOC = join(REPO_ROOT, 'docs', 'production', 'alerts.md');

const COMPOSE = [
  '--env-file',
  STAGING_ENV,
  '-f',
  join(REPO_ROOT, 'docker-compose.staging.yml'),
  '-f',
  join(REPO_ROOT, 'docker-compose.observability.yml'),
];

/** The port the sink listens on. It matches the receiver URLs in alertmanager.yml. */
const SINK_PORT = 9099;

/**
 * Whether the API container is stopped right now.
 *
 * Read by the interrupt handler below. A `finally` block does not run when the process is
 * signalled, and the one thing this script must never do is leave somebody's staging API
 * stopped because they pressed Ctrl-C during the two minutes it waits for `ApiDown`.
 */
let apiStopped = false;

const options = {
  skipProvoke: process.argv.includes('--skip-provoke'),
  keepUp: process.argv.includes('--keep-up'),
  json: process.argv.includes('--json'),
  out: (() => {
    const at = process.argv.indexOf('--out');
    return at === -1 ? null : (process.argv[at + 1] ?? null);
  })(),
};

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Reading the two sources of truth
// ---------------------------------------------------------------------------

/**
 * Alert names and severities as the RULES file states them.
 *
 * Parsed with a line scanner rather than a YAML library on purpose: this
 * repository ships no YAML parser, adding one to read a file it also writes would
 * be a dependency for nothing, and the shape being read is two keys in a known
 * order. A malformed rules file does not have to be diagnosed here — Prometheus
 * refuses to start on one, which is a louder and more accurate error than
 * anything this could produce.
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
      // A rule item's keys are indented two past the `-`. Recording that lets every later match
      // be scoped to this rule rather than to "anywhere below it", which is what stopped the
      // prose inside an annotation from being read as configuration.
      keyIndent = indent + 2;
      found.set(alert[1], current);
      continue;
    }
    if (current === null) continue;
    // Any new list item at or above the rule's own indent ends this rule — including
    // `- record:`, which is an ordinary thing to put in a Prometheus rules file and which used
    // to leave `current` pointing at the previous alert.
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

/** Leading-space count, which is the only structure a line scanner over YAML can rely on. */
function indentOf(line) {
  return (line.match(/^\s*/) ?? [''])[0].length;
}

/**
 * Alert names and severities as the DOCUMENT states them.
 *
 * The document's own convention, used consistently by all twenty-two entries:
 *
 *     ### `ApiDown` — page
 *
 * A heading that does not match is not silently ignored — it simply is not an
 * alert, and check 2 then reports the difference between the two sets, which is
 * the same failure seen from the other end.
 *
 * @returns {Map<string, string>} name -> severity
 */
export function alertsInDocument(text) {
  const found = new Map();
  for (const line of text.split('\n')) {
    const heading = /^###\s+`([A-Za-z0-9_]+)`\s+—\s+(page|ticket)\s*$/.exec(line);
    if (heading !== null) found.set(heading[1], heading[2]);
  }
  return found;
}

/**
 * Every `prl_*` series name an expression mentions, with histogram suffixes
 * resolved back to the metric family.
 *
 * `prl_http_request_duration_seconds_bucket` is not a metric, it is one of the
 * three series a histogram named `prl_http_request_duration_seconds` exports, and
 * a scrape lists the family in its `# TYPE` line. Stripping the suffix is what
 * makes "does this metric exist" answerable from the exposition's type lines
 * rather than from a substring search, which would answer yes for a name that is
 * merely a prefix of a real one.
 */
export function seriesReferencedBy(expression) {
  const names = new Set();
  for (const match of expression.matchAll(/\bprl_[a-z0-9_]+/g)) {
    names.add(match[0].replace(/_(?:bucket|sum|count)$/, ''));
  }
  return names;
}

/** Every `expr:` in the rules file, keyed by the alert it belongs to. */
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
    // Same scoping as `alertsInRulesFile`: a new list item ends the rule, and only a key at the
    // rule's own key indent is this rule's `expr`. Without the second half, an `expr:`-shaped
    // line inside an `annotations: description: |` block — and this document's prose does quote
    // expressions — silently replaced the real one, and every downstream check then passed
    // against text nobody deployed.
    if (/^\s*-\s/.test(line) && indent < keyIndent) {
      current = null;
      keyIndent = -1;
      continue;
    }
    const raw = /^\s*expr:\s*(.*)$/.exec(line);
    if (raw === null || indent !== keyIndent) continue;
    const value = raw[1].trim();
    // Anything but a block-scalar indicator is the expression itself. Written as
    // an explicit comparison rather than a negative lookahead: the lookahead
    // spelling of this backtracked over the space after `expr:` and captured the
    // literal indicator ` >-` as seven rules' entire query, which Prometheus
    // answered 400 to — the check caught it, and this is what it caught.
    if (value !== '' && !/^[>|][-+]?$/.test(value)) {
      found.set(current, unquote(value));
      continue;
    }
    if (/^[>|][-+]?$/.test(value)) {
      const body = [];
      for (let scan = index + 1; scan < lines.length; scan++) {
        const scanned = lines[scan];
        // A blank line inside a folded scalar is a paragraph break, not a terminator. Breaking
        // on it truncated `HttpErrorRateHigh` to its numerator — still valid PromQL, so every
        // check passed while the threshold the alert is about was never seen by anything.
        if (scanned.trim() === '') continue;
        if (indentOf(scanned) <= indent) break;
        body.push(scanned.trim());
      }
      found.set(current, unquote(body.join(' ')));
    }
  }
  return found;
}

/**
 * Strips one matched pair of surrounding quotes.
 *
 * `expr: "prl_a > 1"` is ordinary YAML. Passed through verbatim, Prometheus parses the quotes as
 * a STRING LITERAL expression and answers `status: success` — so the evaluation check went green
 * for a rule that had never been evaluated.
 */
function unquote(value) {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  if ((first === '"' || first === "'") && trimmed.endsWith(first)) return trimmed.slice(1, -1).trim();
  return trimmed;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.json();
}

const PROMETHEUS = `http://127.0.0.1:${process.env.PRL_STAGING_PROMETHEUS_PORT ?? 9090}`;
const ALERTMANAGER = `http://127.0.0.1:${process.env.PRL_STAGING_ALERTMANAGER_PORT ?? 9093}`;

// ---------------------------------------------------------------------------
// The webhook sink
// ---------------------------------------------------------------------------

/**
 * A receiver, on this host, that records what Alertmanager sent it and on which
 * path.
 *
 * The path is the assertion. `alertmanager.yml` routes `severity: page` to `/page`
 * and `severity: ticket` to `/ticket`, so a `page` alert arriving on `/ticket` — or
 * on both — is the two-tier rule in `docs/production/alerts.md` not being
 * implemented, which is invisible to every other check here.
 */
function startSink() {
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
    // 0.0.0.0, not loopback: the notification arrives from inside a container, so
    // it reaches this process over the host gateway address rather than over
    // 127.0.0.1, and a loopback-only listener would never see it. Nothing else is
    // exposed by this — the port is open for the seconds this script runs.
    server.listen(SINK_PORT, '0.0.0.0', () => done({ received, close: () => server.close() }));
  });
}

/** Notifications that name this alert with this status, on this path. */
const notificationsFor = (received, path, alertname, status) =>
  received.filter(
    (entry) =>
      entry.path === path &&
      entry.payload?.status === status &&
      (entry.payload?.alerts ?? []).some((alert) => alert?.labels?.alertname === alertname),
  );

// ---------------------------------------------------------------------------
// Compose
// ---------------------------------------------------------------------------

const compose = (args) => run('docker', ['compose', ...COMPOSE, ...args]);

async function apiIsHealthy() {
  const result = await run('docker', ['compose', ...COMPOSE, 'ps', '--format', '{{.Service}} {{.Health}}']);
  return /(^|\n)api healthy/.test(result.stdout);
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

async function main() {
  console.log(bold('\nPoker Risk Lab — alert delivery verification'));

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
  try {
    sink = await startSink();
  } catch (error) {
    // Almost always a previous run still holding the port — including a `--keep-up` run. An
    // unhandled EADDRINUSE stack is a poor way to say that, and it also skipped the summary and
    // the `--out` report entirely.
    console.log(red(`\n  the notification sink could not listen on ${SINK_PORT}: ${error.message}`));
    console.log(
      dim('  another alerts:verify run is probably still up. `pnpm run alerts:verify -- --keep-up`'),
    );
    console.log(dim('  leaves one behind on purpose; stop it, or free the port, and run this again.\n'));
    return 1;
  }
  let broughtUp = false;

  try {
    // The credential Prometheus scrapes with. Written every run rather than kept, so a rotated
    // token in .env.staging cannot leave a stale one behind, and 0600 because it is the
    // credential that reads every metric this deployment has.
    //
    // Inside the `try`: it used to be written before `startSink()`, which rejects when the sink
    // port is already in use, and that rejection propagates out of `main` before the `finally`
    // that deletes the file — so the token was left on disk on the one failure most likely to
    // recur. The header's claim that it is never left behind was false on exactly that path.
    //
    // The `rmSync` first is the other half. Docker resolves a bind-mount source that does not
    // exist by creating a DIRECTORY, and the teardown removes this file, so an interrupted run
    // leaves a directory here. Prometheus then answers every scrape with "unable to read
    // authorization credentials: is a directory", which reads as a bad token rather than as a
    // stale mount — it cost an hour once already.
    rmSync(TOKEN_FILE, { force: true, recursive: true });
    writeFileSync(TOKEN_FILE, `${token}\n`, { mode: 0o600 });

    section('Bringing up Prometheus and Alertmanager beside the staging stack');
    // `--force-recreate`, and it is not belt and braces. Docker resolves a bind-mount source
    // that does not exist by creating a DIRECTORY, and the teardown below removes the token file.
    // A container left over from an interrupted run therefore holds a directory at
    // /etc/prometheus/metrics-token, `up -d` sees no configuration change and reuses it, and
    // every scrape then fails with "unable to read authorization credentials: is a directory" —
    // which reads as a bad token rather than as a stale mount. Recreating both containers costs
    // about a second and makes the mount resolve against the file this run just wrote.
    const up = await compose(['up', '-d', '--force-recreate', 'prometheus', 'alertmanager']);
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

    // The first scrape has to land before any expression can evaluate against
    // real data. One scrape interval plus a margin.
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

    /**
     * The parse itself, checked before anything is built on it.
     *
     * Every check below is a `filter(...).length === 0` over what these two parsers returned, and
     * an empty set satisfies all of them: with `declared` empty the report reads "the two sets are
     * identical — 0 alerts", "every expression evaluates — 0 expressions", and passes. That turns
     * every parser bug into a green run, which is the opposite of what a verification is for —
     * `secret-scan.mjs` states the same principle for itself ("a sweep of nothing proves nothing").
     *
     * `expressions.size === declared.size` is the cheap half and catches most of it: a rule whose
     * `alert:` line the scanner missed, or an `expr` that landed on the wrong rule, changes one
     * count and not the other.
     */
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

    // --- Check 1: loaded ---------------------------------------------------
    section('1. Every rule is loaded, has a severity, and names a runbook that exists');
    /**
     * Prometheus reports `health: "unknown"` for a rule it has loaded and not yet
     * evaluated, and the first evaluation is up to one `evaluation_interval`
     * away. Reading the rules the instant the container is ready therefore found
     * fourteen of twenty-two "unhealthy" with `lastError: undefined`, which is
     * not an error — it is a question asked too early. So wait for every rule to
     * have been evaluated once, and only then judge the health.
     */
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

    const badSeverity = [...declared].filter(
      ([, rule]) => rule.severity !== 'page' && rule.severity !== 'ticket',
    );
    if (badSeverity.length > 0) {
      fail('every rule is page or ticket', badSeverity.map(([name]) => name).join(', '));
    } else {
      const paging = [...declared.values()].filter((rule) => rule.severity === 'page').length;
      pass('every rule is page or ticket', `${paging} page, ${declared.size - paging} ticket`);
    }

    const badRunbook = [...declared].filter(
      ([, rule]) => rule.runbook === null || !existsSync(join(REPO_ROOT, rule.runbook)),
    );
    if (badRunbook.length > 0) {
      fail('every runbook annotation exists on disk', badRunbook.map(([name]) => name).join(', '));
    } else {
      pass('every runbook annotation exists on disk');
    }

    // --- Check 2: the document and the rules agree -------------------------
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

    // --- Check 3: every metric named exists in a live scrape ---------------
    section('3. Every series the rules name appears in a live scrape');
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
    const exported = new Set(
      exposition.stdout
        .split('\n')
        .filter((line) => line.startsWith('# TYPE '))
        .map((line) => line.split(' ')[2]),
    );
    if (exported.size === 0) {
      fail('the API exposition could be read', 'no # TYPE lines came back from the api container');
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

    // --- Check 4: every expression evaluates -------------------------------
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

    // --- Check 5: delivery, end to end -------------------------------------
    if (options.skipProvoke) {
      section('5. Delivery');
      note('--skip-provoke: the API was not stopped, so nothing was delivered. This run does NOT');
      note('verify delivery; it verifies that the rules are loaded, agreed, grounded and evaluable.');
    } else {
      section('5. ApiDown, provoked: stop the API and follow the alert to a receiver');
      note('the staging API is stopped for about two minutes; ApiDown has for: 2m');
      const stopped = await compose(['stop', 'api']);
      apiStopped = stopped.code === 0;
      if (stopped.code !== 0) {
        fail('the API could be stopped', stopped.stderr.trim());
      } else {
        try {
          // Six minutes, not four. `max_over_time(up[2m]) == 0` cannot be true until two minutes
          // of failed scrapes have accumulated, and only THEN does `for: 2m` start counting — so
          // the earliest possible firing is a little over four minutes after the container stops,
          // and a four-minute budget times out on a rule that is working.
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

        // A resolved notification is not a formality: a receiver that only ever
        // sees firings leaves an incident open in whatever it feeds, and
        // `send_resolved` is off by default in several Alertmanager receivers.
        const resolved = await measureUntil(
          () => notificationsFor(sink.received, '/page', 'ApiDown', 'resolved').length > 0,
          180_000,
          1_000,
        );
        if (resolved === null)
          fail('the resolved notification arrived', 'nothing with status=resolved reached /page');
        else pass('the resolved notification arrived', `${(resolved / 1000).toFixed(0)}s after recovery`);

        /**
         * The routing assertion, and the reason both receivers exist — checked LAST.
         *
         * It used to run the instant the first `/page` notification landed, which is before a
         * duplicate could possibly have reached `/ticket`: that route has a `group_wait` of its
         * own, so a wrong-path notification would arrive seconds after the snapshot was taken.
         * It passed whether or not routing worked. `sink.received` is cumulative, so asking here
         * — after the firing round trip, the recovery and the resolved notification — costs
         * nothing and actually tests `continue: false`, which `alertmanager.yml` calls the
         * important line.
         */
        const wrongPath = notificationsFor(sink.received, '/ticket', 'ApiDown', 'firing');
        if (wrongPath.length > 0) {
          fail('a page did not also raise a ticket', `${wrongPath.length} notification(s) reached /ticket`);
        } else {
          pass('a page did not also raise a ticket', 'severity routing holds, checked after settling');
        }
      }

      /**
       * Check 6: the OTHER tier.
       *
       * Everything above proves the paging half. Until this existed, the ticket receiver had
       * never received anything — so "a page did not also raise a ticket" was consistent with a
       * ticket route that was broken, misconfigured or pointed at nothing, and half the two-tier
       * rule at the top of `docs/production/alerts.md` was asserted only by its own absence.
       *
       * `RateLimitBans` is the right rule to provoke for it: `increase(...[15m]) > 0` with no
       * `for:`, so one recorded ban is enough and the whole thing takes a scrape interval rather
       * than four minutes. It is also a rule an operator genuinely wants to trust, since it is the
       * one that distinguishes a script from a busy person.
       *
       * The flood runs INSIDE the api container, against its own loopback address. Through the
       * proxy it would be keyed on the forwarded client address and would consume the same guest
       * budget the smoke test needs; from in here it is one bucket, deterministic, and touches
       * nothing a later run depends on.
       */
      section('6. RateLimitBans, provoked: a ticket must reach the ticket receiver and not the pager');
      const flood = await run('docker', [
        'compose',
        ...COMPOSE,
        'exec',
        '-T',
        'api',
        'node',
        '-e',
        // 700 requests: the shipped defaults are a 300/minute global limit and a ban 200 past it,
        // so a ban is recorded somewhere past 500. Sequential on purpose — a burst of 700 parallel
        // sockets measures the accept queue rather than the limiter.
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

        // The metric first: if no ban was recorded there is nothing for the rule to fire on, and a
        // silent `RateLimitBans` would then be correct rather than broken. Distinguishing the two
        // is the difference between a test and a coin toss.
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

          // The mirror of the assertion above, and the half that was never tested: a ticket must
          // not wake anybody up.
          const paged = notificationsFor(sink.received, '/page', 'RateLimitBans', 'firing');
          if (paged.length > 0) {
            fail('a ticket did not also page', `${paged.length} notification(s) reached /page`);
          } else {
            pass('a ticket did not also page', 'both tiers are now proven, in both directions');
          }
        }
      }
    }
  } finally {
    sink.close();
    if (broughtUp && !options.keepUp) {
      await compose(['stop', 'prometheus', 'alertmanager']);
      await compose(['rm', '-f', 'prometheus', 'alertmanager']);
    }
    if (!options.keepUp) rmSync(TOKEN_FILE, { force: true, recursive: true });
  }

  const failed = checks.filter((check) => !check.ok);
  console.log('');
  if (failed.length === 0) {
    console.log(green(bold(`${checks.length} check(s) passed.`)));
    if (options.skipProvoke) {
      console.log(yellow('  --skip-provoke was used: alert DELIVERY was not verified by this run.'));
    }
  } else {
    console.log(red(bold(`${failed.length} of ${checks.length} check(s) failed.`)));
  }
  console.log(
    dim(
      '\n  Both receivers are a local webhook sink. Production replaces the two URLs in\n' +
        '  deploy/staging/observability/alertmanager.yml; the hop that ends at a person is not\n' +
        '  rehearsed here and docs/production/alerts.md says so.\n',
    ),
  );

  if (options.json || options.out !== null) {
    const report = {
      schema: 'prl.alert-delivery.v1',
      provoked: !options.skipProvoke,
      checks,
      notifications: sink.received.map((entry) => ({
        path: entry.path,
        status: entry.payload?.status ?? null,
        receiver: entry.payload?.receiver ?? null,
        alerts: (entry.payload?.alerts ?? []).map((alert) => alert?.labels?.alertname ?? null),
        at: entry.at,
      })),
    };
    const text = `${JSON.stringify(report, null, 2)}\n`;
    if (options.out !== null) writeFileSync(options.out, text);
    if (options.json) console.log(text);
  }

  return failed.length === 0 ? 0 : 1;
}

// `import.meta.main` is Node 24 and this file is also imported by its test, which
// must not bring a compose stack up on import.
if (import.meta.main) {
  // Ctrl-C during the two-minute wait would otherwise leave the staging API stopped, because
  // a signal does not run a `finally`. Restart it, say so, and exit non-zero — an interrupted
  // verification is not a passed one.
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      if (apiStopped) {
        console.log(yellow(`\n  ${signal}: restarting the staging API before exiting.`));
        spawnSync('docker', ['compose', ...COMPOSE, 'start', 'api'], { stdio: 'inherit' });
      }
      process.exit(130);
    });
  }
  process.exitCode = await main();
}

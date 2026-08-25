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
 * ## The seven checks, and why each one is separate
 *
 * 1. **Loaded** — every rule in `alert-rules.yml` is present in a live Prometheus
 *    with no evaluation error, carries `severity: page` or `severity: ticket`, and
 *    names a runbook that exists on disk.
 * 2. **Agreed** — the alert names and severities in the rules file and in
 *    `docs/production/alerts.md` are the same set. The document is the reasoning;
 *    the file is the behaviour. Two sets that drift is how a threshold gets
 *    changed in one place.
 * 3. **Grounded** — every `prl_*` series an expression mentions appears in a live
 *    scrape of the API, and every `alertmanager_*` series appears in a live scrape of
 *    Alertmanager. This is the invariant that document states in its own second
 *    paragraph: *"If a name below does not appear in a live scrape of GET /metrics,
 *    the rule is wrong."* Read with a retry budget, because check 6 floods the limiter
 *    from the same loopback address this reads from, and the ban outlives the run that
 *    caused it. The Alertmanager half also asserts `up{job="prl-alertmanager"} == 1`:
 *    a series that exists and is not being scraped grounds a rule that can never fire,
 *    and `AlertmanagerNotificationsFailing` is the one rule whose silence nothing else
 *    here could report.
 * 4. **Evaluable** — every expression is executed by Prometheus. A rule that
 *    cannot be parsed or that references a label set that does not exist is a rule
 *    that will never fire, and it looks identical to a quiet one.
 * 5. **Delivered** — `ApiDown` is provoked for real: the API container is stopped,
 *    the rule is watched through pending into firing, Alertmanager is watched for
 *    the alert, and a receiver on this host is watched for the notification. Then
 *    the API is restored and the resolved notification is watched for too. The
 *    notification must arrive on the PAGING path and not the ticket one, which is
 *    what makes it a test of the two-tier rule rather than of a webhook.
 * 6. **Delivered the other way too** — `RateLimitBans` is provoked, and must reach
 *    the ticket tier and not the pager. Half a routing rule is not a routing rule.
 * 7. **The dead man's switch** — the `Watchdog` rule fires permanently, its
 *    notification arrives repeatedly on its own third destination, it never reaches
 *    a human tier, and then Alertmanager is STOPPED and the absence is watched for
 *    and detected. That last part is the only check in this file whose subject is a
 *    thing not happening.
 *
 * Every delivery in 5 and 6 is checked over BOTH transports the receivers declare:
 * an HTTP webhook, and email over SMTP.
 *
 * ## Check 7, and the one failure nothing in band can report
 *
 * Checks 1 to 6 all share an assumption, and `AlertmanagerNotificationsFailing` and
 * `AlertmanagerDown` share it too: that a report about a broken alerting system can
 * be delivered by the alerting system. `docs/production/runbooks/alerting-blind.md`
 * names the case where it cannot — both delivery paths broken at once — and says
 * plainly that no rule can close it, because the channel carrying the report is the
 * channel that failed.
 *
 * A dead man's switch inverts the direction. `Watchdog` is `expr: vector(1)`: always
 * firing, routed to a third receiver whose destination is a machine outside this
 * deployment whose only job is to notice that the pings stopped. Nothing is wrong
 * when a ping arrives. Everything is wrong when they stop, and the report is made by
 * something that did not depend on the thing that failed.
 *
 * What check 7 can prove locally is the emitting half, and it proves all of it: the
 * rule fires, the route sends it to its own receiver and to neither human tier, the
 * notifications keep arriving with measured gaps inside a watcher's grace period,
 * and — with Alertmanager stopped — the silence is detected while Prometheus goes on
 * reporting the same alerts firing to nobody, and the pings resume when it returns.
 *
 * What it cannot prove is the watching half, and no amount of code here can: a
 * watcher on this host dies with the host it is watching. That is one URL,
 * `PRL_ALERT_HEARTBEAT_WEBHOOK_URL`, and `scripts/alert-preflight.mjs` refuses to let
 * a release be promoted while it still names this machine — so the firing half cannot
 * ship alone, which was the stated reason this repository had no switch at all.
 *
 * ## The SMTP half, and why it is the part that closes the blocker
 *
 * Until this existed, both receivers were `webhook_configs` pointing at a sink
 * this script runs, and every document about them ended the same way: "production
 * replaces two URLs; the hop that ends at somebody's phone is unrehearsed". That
 * was true and it was a hole. A webhook proves Alertmanager can POST JSON. It does
 * not prove that the thing a real deployment configures — a receiver that speaks a
 * mail protocol to a relay it does not control — is even syntactically reachable
 * from this configuration, because nothing here had ever spoken that protocol.
 *
 * So `startSmtpSink` below is a real SMTP server: `220` on connect, `250` to
 * `EHLO`, `MAIL FROM` and `RCPT TO`, `354` to `DATA`, capture to `\r\n.\r\n`,
 * `221` to `QUIT`. Two hundred lines of `node:net` and no dependency. Alertmanager
 * cannot tell it from a smarthost, and what it captures is the message a provider
 * would have received: envelope sender, envelope recipients, `Subject:`, and a
 * quoted-printable body. All four are asserted, against the tier the routing was
 * supposed to choose.
 *
 * ## What this does NOT prove
 *
 * That a pager rings. An SMTP transaction to a sink this process controls proves
 * the transport and the message — that Alertmanager's email path is configured,
 * reachable, correctly addressed per tier, and produces a message with the alert
 * in it. It proves nothing whatever about what happens after a relay accepts the
 * mail. Three things remain unrehearsed and they are now nameable:
 *
 *   * that a provider accepts this deployment's credentials — no API key and no
 *     SMTP submission password is exercised here, because the sink asks for
 *     neither and inventing one would rehearse somebody else's account;
 *   * that the address configured is one a phone actually watches — an
 *     email-to-SMS gateway that has been decommissioned looks exactly like one
 *     that works, from this end;
 *   * that a person is awake. Nothing a repository can run proves that, and check 7
 *     does not change it — a dead man's switch narrows the question from "is anybody
 *     watching" to "is the watcher this deployment named still watching", which is
 *     answered by `pnpm run alerts:ack` and a human typing a code.
 *
 * It also proves nothing about the twenty-six rules it does not provoke. Checks 1
 * to 4 say they are loaded, agreed, grounded and evaluable, which is a great deal
 * more than a markdown file said and a great deal less than "tested".
 * `docs/production/alerts.md` § Verifying these rules lists how to provoke each of
 * them by hand.
 *
 * ## Where the destinations come from
 *
 * `deploy/staging/observability/alertmanager.yml` is no longer tracked. It is
 * rendered here from `alertmanager.template.yml` before the overlay comes up, the
 * same way `metrics-token` is written from `PRL_STAGING_METRICS_TOKEN`, so that a
 * deployment points its alerts at its own pager by setting `PRL_ALERT_*` variables
 * rather than by editing a file in a checkout and hoping the edit survives.
 * `alertmanagerValues` lists every variable and its rehearsal default.
 *
 * The verification asserts against the values it rendered with. Overriding a
 * destination to something outside this host is therefore expected to FAIL the
 * delivery checks — the sinks cannot observe a notification that went to
 * PagerDuty — and the run says which values were overridden so that the failure
 * reads as "you pointed it elsewhere" rather than as "delivery is broken".
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
 * The cost is time. `max_over_time(up[2m]) == 0` cannot be true until two minutes of
 * failed scrapes have accumulated, and only then does `for: 2m` start counting, so
 * the firing is a little over four minutes after the container stops; with the
 * recovery, the resolved notification and the ticket-tier provocation after it, a
 * whole run is six to seven minutes and the staging API is stopped for about four.
 * Staging is disposable and that is the point of having one.
 *
 * Usage:
 *     pnpm run alerts:verify
 *     node scripts/alert-delivery.mjs --skip-provoke    # checks 1-4 only, ~30s
 *     node scripts/alert-delivery.mjs --only-heartbeat  # checks 1-4 and 7, ~4m, API untouched
 *     node scripts/alert-delivery.mjs --keep-up         # leave Prometheus running
 *     node scripts/alert-delivery.mjs --render-config  # render alertmanager.yml and stop
 *     node scripts/alert-delivery.mjs --json --out alerts.json
 *
 * Exit codes:
 *     0  every check passed
 *     1  any check failed, or the stack could not be brought up
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createSocketServer } from 'node:net';
import { join } from 'node:path';
import { bold, dim, green, measureUntil, REPO_ROOT, red, run, yellow } from './drills/harness.mjs';

// ---------------------------------------------------------------------------
// Where everything lives
// ---------------------------------------------------------------------------

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

/** The port the webhook sink listens on. It matches the rendered receiver URLs. */
const SINK_PORT = 9099;

/**
 * The port the SMTP sink listens on.
 *
 * One below the webhook sink so that "the alerting rehearsal is holding two ports"
 * is one thing to remember rather than two. Not 25: binding a privileged port
 * would need root, and Alertmanager is told the port explicitly by
 * `smtp_smarthost`, so there is nothing to gain from the well-known one.
 */
const SMTP_SINK_PORT = 9098;

/**
 * The path on the webhook sink that the dead man's switch pings.
 *
 * A third path on the same sink rather than a third server, because what makes it a
 * separate destination is the ROUTE that chose it, and the route is what check 7
 * asserts: a `Watchdog` notification arriving on `/page` would be the heartbeat
 * waking somebody every twenty seconds, which is the failure this design is against.
 */
const HEARTBEAT_PATH = '/heartbeat';

/**
 * Whether the API container is stopped right now.
 *
 * Read by the interrupt handler below. A `finally` block does not run when the process is
 * signalled, and the one thing this script must never do is leave somebody's staging API
 * stopped because they pressed Ctrl-C during the two minutes it waits for `ApiDown`.
 */
let apiStopped = false;

/**
 * The same, for the Alertmanager container that check 7 stops on purpose.
 *
 * Check 7's negative control is a dead man's switch actually firing: Alertmanager is
 * stopped, the heartbeat goes quiet, and the silence is detected. A Ctrl-C inside that
 * window would otherwise leave the overlay half up, and `--keep-up` would hand the next
 * run an Alertmanager that is not running for a reason nothing recorded.
 */
let alertmanagerStopped = false;

const options = {
  skipProvoke: process.argv.includes('--skip-provoke'),
  /**
   * Checks 1-4 and 7, without stopping the staging API.
   *
   * The dead man's switch needs no provocation — it is already firing — but it does
   * need about three minutes of wall clock to show several arrivals and one detected
   * silence. Bundling it with `--skip-provoke` would have made that flag stop being
   * the thirty-second one, and leaving it out of a fast path would have made the
   * heartbeat the slowest thing in the file to iterate on. So it gets its own.
   */
  onlyHeartbeat: process.argv.includes('--only-heartbeat'),
  keepUp: process.argv.includes('--keep-up'),
  renderConfig: process.argv.includes('--render-config'),
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
 * The document's own convention, used consistently by every entry:
 *
 *     ### `ApiDown` — page
 *
 * A heading that does not match is not silently ignored — it simply is not an
 * alert, and check 2 then reports the difference between the two sets, which is
 * the same failure seen from the other end.
 *
 * `heartbeat` is the third value and there is exactly one rule with it. It is
 * matched here rather than being special-cased so that the document and the rules
 * file are still compared by the same mechanism as everything else — a `Watchdog`
 * documented as a `page` has to fail check 2, because that is a real and tempting
 * mistake and it would deliver a notification to a human every twenty seconds.
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

/**
 * The same question for the series Alertmanager exports about ITSELF.
 *
 * `seriesReferencedBy` matches `prl_*` and only `prl_*`, which was complete until the
 * rules file gained `AlertmanagerNotificationsFailing` — a rule on
 * `alertmanager_notifications_failed_total`, a name this repository does not own and
 * therefore cannot check by reading `metrics.ts`. Leaving it ungrounded would have made
 * check 3 pass over a rule whose series name it never looked at, which is the exact hole
 * that check exists to close: an expression on a series that does not exist is
 * syntactically perfect, evaluates without error, and is permanently false.
 *
 * A separate function rather than a widened regex, because the two are grounded against
 * two different scrapes — the API's exposition and Alertmanager's — and merging them
 * would mean looking for one system's names in the other's output.
 */
export function alertmanagerSeriesReferencedBy(expression) {
  const names = new Set();
  for (const match of expression.matchAll(/\balertmanager_[a-z0-9_]+/g)) {
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
// Rendering alertmanager.yml
// ---------------------------------------------------------------------------

/**
 * Every destination a deployment can set, and what the rehearsal uses instead.
 *
 * The defaults are all local on purpose: two paths on this script's webhook sink,
 * and this script's SMTP sink. That is what makes `pnpm run alerts:verify` work in
 * a fresh checkout with nothing configured, and it is also the reason the defaults
 * cannot quietly become production's — `host.docker.internal` and a `.invalid`
 * domain are both unroutable anywhere that matters, so a deployment that forgot to
 * configure this fails to deliver loudly rather than delivering to a stranger.
 *
 * `PRL_ALERT_SMTP_PASSWORD` is deliberately NOT in this map. It is written to a
 * file that Alertmanager reads through `smtp_auth_password_file`, never
 * substituted into the rendered YAML, because the rendered YAML is the artefact
 * somebody pastes into a bug report.
 */
export const ALERT_DESTINATION_DEFAULTS = {
  PRL_ALERT_PAGE_WEBHOOK_URL: `http://host.docker.internal:${SINK_PORT}/page`,
  PRL_ALERT_TICKET_WEBHOOK_URL: `http://host.docker.internal:${SINK_PORT}/ticket`,
  /**
   * The dead man's switch, and the one destination whose rehearsal default being
   * local is a bigger lie than the others.
   *
   * `/page` pointing at this host merely means no human was paged by a test. A
   * heartbeat pointing at this host means the watcher dies with the thing it is
   * watching, which is the whole mechanism inverted. Check 7 proves everything that
   * happens on THIS side of that URL — the rule fires, routes to its own receiver,
   * arrives on a schedule, and its absence is detected — and `alert-preflight.mjs`
   * refuses to let a release be promoted while this value still names this machine.
   */
  PRL_ALERT_HEARTBEAT_WEBHOOK_URL: `http://host.docker.internal:${SINK_PORT}${HEARTBEAT_PATH}`,
  /**
   * How often the heartbeat is re-sent.
   *
   * 20 s in the rehearsal, so that a verification run can watch several arrivals and
   * one detected silence inside a couple of minutes. A deployment sets whatever its
   * snitch expects and the constraint is the same either way: comfortably inside the
   * watcher's grace period, because the watcher pages on the gap.
   */
  PRL_ALERT_HEARTBEAT_INTERVAL: '20s',
  PRL_ALERT_PAGE_EMAIL_TO: 'oncall@staging.poker-risk-lab.invalid',
  PRL_ALERT_TICKET_EMAIL_TO: 'tickets@staging.poker-risk-lab.invalid',
  PRL_ALERT_SMTP_SMARTHOST: `host.docker.internal:${SMTP_SINK_PORT}`,
  PRL_ALERT_EMAIL_FROM: 'alertmanager@staging.poker-risk-lab.invalid',
  PRL_ALERT_SMTP_HELLO: 'localhost',
  PRL_ALERT_SMTP_REQUIRE_TLS: 'false',
  PRL_ALERT_SMTP_USERNAME: '',
};

/**
 * The values this run will render with, and which of them the environment supplied.
 *
 * The second half is not cosmetic. Every delivery check below asserts against these
 * values, and a run that has been pointed at a real pager cannot observe its own
 * notifications — so the overrides are printed, and the failure then reads as "you
 * sent it somewhere this cannot watch" instead of as "delivery is broken".
 */
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

/**
 * Configuration that would render into valid YAML and notify nobody.
 *
 * Checked before rendering rather than after, because every one of these produces
 * an Alertmanager that starts, reports itself healthy, accepts alerts, routes them
 * correctly and drops them on the floor. That is the failure this whole file exists
 * to make impossible, and it is not detectable from the outside.
 */
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
  /**
   * The heartbeat, which unlike the two human tiers may not be dropped.
   *
   * Every other destination announces its own absence the first time something fires:
   * an unset pager is noticed during the first incident, loudly and by the person who
   * was not woken. A heartbeat with nowhere to go announces nothing, ever — the rule
   * fires forever, the route matches, the receiver has no `webhook_configs` in it, and
   * the notification is dropped inside Alertmanager. From every dashboard here that is
   * identical to a healthy month, which is the exact failure the switch exists for.
   */
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

/**
 * A Prometheus duration in milliseconds, or `null`.
 *
 * Only the units this file can produce, which is the point: `PRL_ALERT_HEARTBEAT_INTERVAL`
 * is validated above and then converted here, and check 7 sizes every budget it waits on
 * from the result. A verification that hard-coded twenty seconds would quietly stop
 * testing the thing it claims to test the moment a deployment changed the interval.
 */
export function durationMs(text) {
  const parsed = /^(\d+)(ms|[smh])$/.exec(text.trim());
  if (parsed === null) return null;
  const scale = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };
  return Number(parsed[1]) * scale[parsed[2]];
}

/**
 * `alertmanager.template.yml` with the deployment's values in it.
 *
 * Two directives, both spelled as YAML comments so the template still reads as the
 * file it becomes:
 *
 *   * `${NAME}` — substituted. A name with no value is an ERROR rather than an
 *     empty string. `url: ` is accepted by Alertmanager and notifies nobody, which
 *     is the whole class of defect this file is against.
 *   * `# @if NAME` … `# @endif` — the enclosed lines survive only when `NAME` has a
 *     non-empty value. That is what makes each destination independently optional,
 *     so a deployment that pages by email and tickets by webhook emits exactly
 *     those two blocks rather than two more pointing at nothing.
 *
 * A comment line is copied through untouched. The template's header is several
 * screens of prose explaining what each variable is FOR, and that prose has to be
 * able to write `${PRL_ALERT_PAGE_EMAIL_TO}` without the renderer helpfully
 * replacing it with an address — a documentation table that silently becomes a
 * list of one deployment's real destinations is worse than no table. It also means
 * the reasoning survives into the rendered file, which is the copy an operator
 * actually opens.
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
 * Renders the config and the password file, replacing whatever is there.
 *
 * `rmSync` first, and both files rewritten every run, for the reason the token
 * file gives below: Docker resolves a missing bind-mount source by creating a
 * DIRECTORY, so an interrupted run leaves one here and the next container reports
 * it as unreadable configuration rather than as a stale mount.
 *
 * The password file is written even when empty. The mount is unconditional in
 * `docker-compose.observability.yml` — a conditional bind mount is not a thing
 * compose has — so the file has to exist whether or not anything reads it.
 */
function writeAlertmanagerConfig(values) {
  // A banner, because the rendered file looks exactly like a file somebody could
  // edit and it is deleted at the end of every run. Without this, the first
  // reasonable thing an operator does with a broken destination — open it and fix
  // the URL — is work that disappears the next time anything renders.
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
  // 0644, not 0600: the rendered file holds destinations, not credentials, and the
  // container reads it as an unprivileged user. The one credential in this feature
  // is the SMTP password, and it is in the file below at 0600.
  writeFileSync(CONFIG_FILE, rendered, { mode: 0o644 });
  rmSync(SMTP_PASSWORD_FILE, { force: true, recursive: true });
  writeFileSync(SMTP_PASSWORD_FILE, process.env.PRL_ALERT_SMTP_PASSWORD ?? '', { mode: 0o600 });
  return rendered;
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
 * The path is the assertion. The rendered route tree sends `severity: page` to the
 * paging receiver and `severity: ticket` to the ticket one, and in the rehearsal those
 * are `/page` and `/ticket` on this sink — so a `page` alert arriving on `/ticket` — or
 * on both — is the two-tier rule in `docs/production/alerts.md` not being
 * implemented, which is invisible to every other check here.
 *
 * `/heartbeat` is the third path, and the same reasoning is why it is a path on this
 * sink rather than a second server: what makes the dead man's switch a separate
 * destination is the ROUTE that chose it, and the route is the thing worth asserting.
 *
 * Exported, and taking a port, so that `alert-ack-page.mjs` can raise the same
 * receiver when it rehearses an acknowledged page against the local defaults. Two
 * copies of a webhook recorder is how one of them stops recording the path.
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
    // 0.0.0.0, not loopback: the notification arrives from inside a container, so
    // it reaches this process over the host gateway address rather than over
    // 127.0.0.1, and a loopback-only listener would never see it. Nothing else is
    // exposed by this — the port is open for the seconds this script runs.
    server.listen(port, '0.0.0.0', () => done({ received, close: () => server.close() }));
  });
}

/** Notifications that name this alert with this status, on this path. */
export const notificationsFor = (received, path, alertname, status) =>
  received.filter(
    (entry) =>
      entry.path === path &&
      entry.payload?.status === status &&
      (entry.payload?.alerts ?? []).some((alert) => alert?.labels?.alertname === alertname),
  );

// ---------------------------------------------------------------------------
// The dead man's switch, as arithmetic
// ---------------------------------------------------------------------------

/**
 * The instants a heartbeat ping arrived, in milliseconds since the epoch.
 *
 * Read off the same sink every other notification lands on, filtered to the
 * heartbeat PATH — because the path is what the route chose, and a `Watchdog` that
 * arrived on `/page` is not a heartbeat, it is somebody's phone ringing every twenty
 * seconds. Status is asserted as `firing` for the same reason `send_resolved: false`
 * is set on that receiver: this alert never resolves, and a resolved notification
 * arriving would be the last thing a watcher heard.
 */
export const heartbeatArrivals = (received, path = HEARTBEAT_PATH) =>
  notificationsFor(received, path, 'Watchdog', 'firing').map((entry) => Date.parse(entry.at));

/** The gaps between consecutive arrivals, in milliseconds. */
export const heartbeatGaps = (arrivals) => arrivals.slice(1).map((at, index) => at - arrivals[index]);

/**
 * What is wrong with a run of heartbeat arrivals, or `null` if nothing is.
 *
 * This is the whole of the local half of a dead man's switch, and it is a pure
 * function so that its failure modes can be constructed in a test rather than waited
 * for: `alert-delivery.test.mjs` drives it with no arrivals, with one arrival, and
 * with a gap past the deadline. A watcher whose alarm has never been seen to sound
 * is the purest possible decoration, and this one's alarm is three lines below.
 *
 * `minimum` is 3 rather than 1 deliberately. One arrival proves the route; it does
 * not prove the thing the mechanism depends on, which is that the notification KEEPS
 * coming. A `repeat_interval` that Alertmanager silently rounded up, or a receiver
 * that fired once at `group_wait` and never again, both deliver exactly one ping and
 * both are a dead man's switch that has already failed at the moment it is installed.
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
 * Waits until the heartbeat has been silent for longer than the deadline.
 *
 * The active half of the mechanism, and the reason it is a function rather than a
 * comparison at the end: a dead man's switch does not detect absence by looking back
 * over a log, it detects it by a timer that nothing reset. This polls, and it returns
 * the moment the silence exceeds the deadline — which is what a snitch does, and what
 * check 7's negative control demonstrates actually happening.
 *
 * Returns the observed silence in milliseconds, or `null` if a ping arrived inside the
 * budget, in which case the absence was NOT detected and the caller must fail.
 *
 * @param {() => number[]} arrivals a fresh read each poll; the sink is cumulative
 */
export async function watchForSilence(arrivals, deadlineMs, budgetMs) {
  const startedAt = Date.now();
  const seen = arrivals();
  // Measured from the LAST PING and not from the moment this was called, because that
  // is what a watcher outside the deployment can see. It has no idea when anybody
  // started watching; it knows only how long it has been since it was last told
  // anything, and that is the number its grace period is compared against.
  const lastPing = seen.length > 0 ? seen[seen.length - 1] : startedAt;
  const before = seen.length;
  for (;;) {
    const now = Date.now();
    // A ping arriving after the watch began resets the timer, exactly as it resets a
    // snitch's, and it means the silence was not real.
    if (arrivals().length > before) return null;
    const silence = now - lastPing;
    if (silence > deadlineMs) return silence;
    if (now - startedAt > budgetMs) return null;
    await new Promise((done) => setTimeout(done, 1_000));
  }
}

// ---------------------------------------------------------------------------
// The SMTP sink
// ---------------------------------------------------------------------------

/**
 * Undoes the transfer encoding Alertmanager applies to a mail body.
 *
 * Quoted-printable exists because SMTP is a line protocol with a 998-character
 * limit, and it does two things a naive `includes()` cannot survive: it escapes
 * bytes as `=XX`, and it breaks long lines with a soft break — an `=` immediately
 * before the newline, which is not part of the content.
 *
 * That soft break is the reason this function is here rather than being skipped as
 * over-engineering. Alertmanager's default HTML body is one very long line of
 * inline-styled markup, so the alert name in it is not merely likely to be split
 * across a line boundary, it is likely to be split MID-WORD — and an assertion
 * that `ApiDown` appears in the body would then fail against a message that
 * contains it, which is the worst kind of test.
 */
export function decodeQuotedPrintable(text) {
  return text
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}

/**
 * An RFC822 message split into its headers and its decoded body.
 *
 * Header folding is undone (a continuation line begins with whitespace and belongs
 * to the header above it), names are lowercased, and the body is quoted-printable
 * decoded whole. Decoding the body but NOT the headers is deliberate: a MIME
 * boundary parameter is full of `=`-followed-by-hex-looking text and decoding it
 * would corrupt exactly the header that says how to read the rest.
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
 * A real SMTP server, on this host, that records the messages Alertmanager sends it.
 *
 * ## Why write one rather than assert on Alertmanager's own logs
 *
 * Because the log line says "sent"; the message says what was sent. Everything that
 * can be wrong about the email path after "sent" — the wrong recipient for the
 * tier, a subject with no alert name in it, an empty body from a broken template,
 * a `from` a relay will reject — is invisible in a log and unmissable in the
 * captured RFC822.
 *
 * And because SMTP is small enough to answer honestly. The dialogue below is the
 * whole of what a submission relay must do for a client that is not authenticating:
 * greet, accept a hello, take an envelope, take a body terminated by a lone dot,
 * say goodbye. Alertmanager's client is Go's `net/smtp` and it cannot tell this
 * from a smarthost, which is the point — what lands in `received` is the message a
 * provider would have received, not an approximation of one.
 *
 * ## What is deliberately NOT advertised
 *
 * `STARTTLS` and `AUTH`. A sink with no certificate that advertised STARTTLS would
 * make Alertmanager negotiate TLS and fail, and one that advertised AUTH would
 * invite this script to invent a credential — which is the thing the whole feature
 * refuses to do. `PRL_ALERT_SMTP_REQUIRE_TLS` therefore defaults to `false` for the
 * rehearsal and the template says, in the file, that a deployment must set it.
 *
 * Exported, and taking a port, so that `alert-delivery.test.mjs` can drive the whole
 * dialogue over a real socket with no containers. A protocol bug in here would
 * otherwise surface only six minutes into a run that had already stopped the API.
 */
export function startSmtpSink(port = SMTP_SINK_PORT) {
  const received = [];
  const server = createSocketServer((socket) => {
    socket.setEncoding('utf8');
    socket.on('error', () => {
      // Deliberately empty. A mail client that vanishes mid-transaction is not this
      // script's problem, and an unhandled ECONNRESET on a socket would take the whole
      // run down during the two minutes it is waiting for something else.
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
          // The terminator is `<CRLF>.<CRLF>`, and the leading CRLF may be the one
          // that ended the last header rather than anything in `buffer` — a message
          // whose body is empty ends with the dot arriving first. Prefixing a CRLF
          // makes both cases the same search instead of two.
          const haystack = `\r\n${buffer}`;
          const at = haystack.indexOf('\r\n.\r\n');
          if (at === -1) break;
          const message = haystack.slice(2, at);
          buffer = buffer.slice(at + 3);
          inData = false;
          received.push({
            from: envelope.from,
            recipients: envelope.recipients,
            // Dot-unstuffing: a body line that begins with `.` was sent with two, so
            // that it could not be mistaken for the terminator. Undoing it here means
            // what is stored is the message, not the wire encoding of it.
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
          // Multi-line 250: every line but the last is `250-`. Nothing here is
          // optional decoration — `net/smtp` parses these into the extension set it
          // will then use, and a malformed continuation is a client-side error.
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
          // Includes STARTTLS and AUTH, which are not advertised and so should never
          // arrive. Refusing them explicitly means a client that tries anyway gets a
          // protocol answer rather than a hang, and the run fails with a reason.
          say('502 5.5.1 Command not implemented');
        }
      }
    });
  });
  return new Promise((done, failed) => {
    server.on('error', failed);
    // 0.0.0.0 for the same reason as the webhook sink: the connection is opened from
    // inside the alertmanager container and arrives over the host gateway address.
    // The bound port is handed back rather than assumed: the test drives this on an
    // ephemeral port so it can never collide with a verification run in another shell.
    server.listen(port, '0.0.0.0', () =>
      done({ received, port: server.address().port, close: () => server.close() }),
    );
  });
}

/**
 * Messages that carry this alert, with this status, to every one of these recipients.
 *
 * Four assertions in one filter, and they are all the same assertion: the message
 * that reached this address is the one the routing intended.
 *
 *   * the envelope recipients — what the relay would actually deliver to, which is
 *     the tier. A page in the ticket inbox is this filter returning nothing.
 *   * `[FIRING` / `[RESOLVED` at the head of the subject — Alertmanager's default
 *     subject template, and the difference between an incident opening and closing.
 *   * the alert name in the subject, which is what a phone shows on a locked screen
 *     and often the only part anybody reads at 3am.
 *   * the alert name in the decoded body, which is what proves the body is the
 *     alert rather than a template that rendered to nothing.
 *
 * @param {string} to a recipient list as `email_configs.to` spells it, comma-separated
 */
export const emailsFor = (received, to, alertname, status) => {
  const wanted = to
    .split(',')
    .map((address) => address.trim())
    .filter((address) => address !== '');
  // No address means no messages to it. Without this, `every` over an empty list is
  // vacuously true and a tier with no email destination would match EVERY captured
  // message — turning the "a ticket did not also page" assertion into a guaranteed
  // failure for a deployment that pages by webhook alone.
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

/**
 * Waits for the message this tier's routing should have produced, and reports it.
 *
 * Skipping rather than failing when a tier has no email address is the only honest
 * answer for a deployment that pages by webhook alone: there is nothing to wait for,
 * and a red check against a destination nobody configured teaches people to ignore
 * red checks — the same failure mode as an alert that cries wolf.
 *
 * The detail line carries the envelope and the subject rather than a duration alone,
 * because that is the evidence: the addresses are what the routing chose, and the
 * subject is what a locked screen would show.
 */
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

// ---------------------------------------------------------------------------
// Compose
// ---------------------------------------------------------------------------

const compose = (args) => run('docker', ['compose', ...COMPOSE, ...args]);

async function apiIsHealthy() {
  const result = await run('docker', ['compose', ...COMPOSE, 'ps', '--format', '{{.Service}} {{.Health}}']);
  return /(^|\n)api healthy/.test(result.stdout);
}

/**
 * The one destination combination worth shouting about that is not an error.
 *
 * `smtp_require_tls: false` is correct for the rehearsal — the sink has no
 * certificate — and dangerous anywhere else, because an alert body is not
 * innocuous: Alertmanager's default template names the instance, the job, the
 * threshold that tripped and the runbook path, which together are a description of
 * how to attack this deployment while it is already unwell. Refusing the
 * combination outright would be wrong (a relay on the same host is a legitimate
 * deployment); saying nothing would be worse.
 */
function warnIfCleartextToARemoteRelay(values) {
  const local = /^(?:host\.docker\.internal|localhost|127\.0\.0\.1|\[::1\]):/;
  if (values.PRL_ALERT_SMTP_SMARTHOST === '' || values.PRL_ALERT_SMTP_REQUIRE_TLS !== 'false') return;
  if (local.test(values.PRL_ALERT_SMTP_SMARTHOST)) return;
  note(yellow(`PRL_ALERT_SMTP_REQUIRE_TLS is false and the relay is ${values.PRL_ALERT_SMTP_SMARTHOST}.`));
  note(yellow('An alert body names the instance, the threshold and the runbook. Set it to true.'));
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

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

  // `--render-config` exists so that the compose command in
  // docker-compose.observability.yml's header can be run by hand. It writes the same
  // two files this run would and stops, touching no container and no port.
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
    // Almost always a previous run still holding a port — including a `--keep-up` run. An
    // unhandled EADDRINUSE stack is a poor way to say that, and it also skipped the summary and
    // the `--out` report entirely.
    //
    // Closing the webhook sink here matters now that there are two: the SMTP sink is the one
    // more likely to collide, and without this the first listener stayed open for the life of
    // the process and made the NEXT run fail on the other port instead.
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

    // The configuration Alertmanager loads, rendered from the template for the same
    // reasons and with the same lifetime as the token above. The rendered text is kept
    // so that the check below can compare it with what the running process reports.
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

    /**
     * The rendered configuration, read back out of the RUNNING Alertmanager.
     *
     * Not a formality. Everything about the template could be right and still not be
     * what is loaded: a stale container reusing an old mount, a bind mount that
     * resolved to a directory, a render that wrote somewhere else. This asks the
     * process itself what its destinations are, and it is the only check here that
     * runs under `--skip-provoke` — which makes the fast path able to catch a
     * receiver that has quietly lost a transport.
     */
    const status = await getJson(`${ALERTMANAGER}/api/v2/status`);
    const liveConfig = status?.config?.original ?? '';
    /**
     * A webhook `url` comes back as `<secret>`, because Alertmanager types it as one
     * and redacts it from every API — which is correct, and is why this compares two
     * things rather than one. The email recipient and the smarthost are not secrets
     * and are compared by value; the webhooks are compared by SHAPE, counting the
     * blocks in the live config against the blocks this run rendered. A receiver that
     * lost a transport changes that count, which is the failure worth catching.
     */
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

    /**
     * Exactly one rule may be a heartbeat, and it is `Watchdog`.
     *
     * A separate check because the one above would pass with fifteen of them. The
     * heartbeat destination is a machine that counts pings and pages on their absence,
     * so it can carry precisely one signal — a second rule routed there is an incident
     * delivered to something with no way to report it, and worse, a rule that CAN stop
     * firing on that route makes the snitch alarm for a reason that is not the one it
     * exists for. Once a dead man's switch has cried wolf it gets a longer grace
     * period, and then it is decoration.
     */
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
    /**
     * Read with a retry budget, and the reason is check 6.
     *
     * The exposition is fetched from INSIDE the api container over its own loopback
     * address, and so is the rate-limit flood that check 6 uses to provoke
     * `RateLimitBans` — same address, same bucket. A ban outlives the run that caused
     * it by the length of the limiter's window, so a second `alerts:verify` started
     * within about a minute of the first found its own `/metrics` read answered 429
     * and reported "no # TYPE lines came back", which reads as a broken API rather
     * than as this script's own previous flood.
     *
     * Retrying is the honest fix rather than a workaround: the question this check
     * asks is "does the API export these series", and a 429 is not an answer to it.
     * The budget is bounded, so an API that genuinely exports nothing still fails —
     * ninety seconds later, with the same message.
     */
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

    /**
     * The other exposition: Alertmanager's own.
     *
     * Two conditions, one check, and both are required — because either alone passes
     * for the wrong reason. Reading Alertmanager's `/metrics` proves the series the
     * `alerting-itself` rules name really are exported by this version; asserting
     * `up{job="prl-alertmanager"} == 1` proves Prometheus is actually scraping them.
     * Without the second, a scrape job that was deleted or misnamed leaves the rules
     * evaluating against a series that will never have a sample, which is silent, and
     * `AlertmanagerNotificationsFailing` is the one rule whose silence cannot be
     * reported by anything else in this file.
     */
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
      // Reached only if the alerting-itself rules were deleted, and then this check has
      // examined nothing. A grounding of zero series is not a pass, for the same reason
      // the parse guard above is not.
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

          /**
           * The same notification, over the other transport — and the one that is not a
           * webhook to a sink pretending to be a provider.
           *
           * Alertmanager opened a TCP connection to `startSmtpSink`, spoke EHLO, MAIL
           * FROM, RCPT TO and DATA, and delivered a message. What is asserted is that
           * message: the envelope recipient is the PAGING address, the subject is
           * Alertmanager's firing subject naming this alert, and the decoded body
           * contains it too. A mail relay would have accepted exactly these bytes.
           */
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

        // And the resolved message, for the same reason: an inbox that only ever
        // receives openings is an inbox somebody stops trusting. `[RESOLVED]` is the
        // head of Alertmanager's own subject template, so this asserts the message
        // says so rather than merely that another one arrived.
        await expectEmail(
          mail,
          values.PRL_ALERT_PAGE_EMAIL_TO,
          'ApiDown',
          'resolved',
          'the resolved email arrived',
          180_000,
        );

        /**
         * The routing assertion, and the reason both receivers exist — checked LAST.
         *
         * It used to run the instant the first `/page` notification landed, which is before a
         * duplicate could possibly have reached `/ticket`: that route has a `group_wait` of its
         * own, so a wrong-path notification would arrive seconds after the snapshot was taken.
         * It passed whether or not routing worked. `sink.received` is cumulative, so asking here
         * — after the firing round trip, the recovery and the resolved notification — costs
         * nothing and actually tests `continue: false`, which `alertmanager.template.yml` calls the
         * important line.
         */
        const wrongPath = notificationsFor(sink.received, '/ticket', 'ApiDown', 'firing');
        // The mail half of the same question. `continue: false` is one setting and it
        // governs both transports at once, so a broken route would put a duplicate in
        // the ticket INBOX as readily as on the ticket webhook — and the inbox is the
        // one somebody has to triage by hand.
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

          await expectEmail(
            mail,
            values.PRL_ALERT_TICKET_EMAIL_TO,
            'RateLimitBans',
            'firing',
            'the ticket address was emailed over SMTP',
            180_000,
          );

          // The mirror of the assertion above, and the half that was never tested: a ticket must
          // not wake anybody up. Checked on both transports, because an email to the paging
          // address at 3am is a page whatever the routing table calls it.
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

    // --- Check 7: the dead man's switch ------------------------------------
    if (options.skipProvoke) {
      section("7. The dead man's switch");
      note('--skip-provoke: the heartbeat was NOT observed. This run does not show that the');
      note('Watchdog notification keeps arriving, that it stays off both human tiers, or that');
      note('its absence is detected. `--only-heartbeat` runs exactly this section in ~3 minutes.');
    } else {
      section("7. The dead man's switch: the heartbeat, its rhythm, and its silence");
      const intervalMs = durationMs(values.PRL_ALERT_HEARTBEAT_INTERVAL) ?? 20_000;
      /**
       * The grace period a watcher would page on, and the number this whole section is
       * sized from.
       *
       * Three intervals, because a snitch that alarms on ONE missed ping alarms on a
       * deploy, a leader election, or a slow flush — and a dead man's switch that has
       * cried wolf once is given a longer grace period by the person it woke, which is
       * how it becomes decoration. Three is the smallest number that survives a single
       * missed beat and still bounds the blind window at a minute at these settings.
       */
      const deadlineMs = 3 * intervalMs;
      note(
        `interval ${values.PRL_ALERT_HEARTBEAT_INTERVAL}, deadline ${(deadlineMs / 1000).toFixed(0)}s ` +
          `(3 intervals) → ${values.PRL_ALERT_HEARTBEAT_WEBHOOK_URL}`,
      );

      /**
       * The rule itself, asked of Prometheus rather than inferred from a notification.
       *
       * `vector(1)` has no `for:` and no dependency on a scrape, so it must be firing
       * the first time it is evaluated and every time after. Reading its state here
       * separates "the heartbeat is not arriving because the rule is not firing" from
       * "the heartbeat is not arriving because delivery is broken", which are the two
       * halves of this section and have completely different runbooks.
       */
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

      /**
       * The rhythm, which is the part that makes it a heartbeat rather than a
       * notification that happened once.
       *
       * A `repeat_interval` that Alertmanager rounded up to `group_interval`, or a
       * receiver that fired at `group_wait` and never again, both deliver a first ping
       * that looks perfect. The watcher then pages on the second missed beat of a
       * cadence nobody configured. So this waits for three and reports the measured
       * gaps rather than the configured ones.
       */
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

      /**
       * And it must not be a page or a ticket, which is the routing half of the whole
       * argument for a third destination.
       *
       * A Watchdog delivered to the pager is a notification to a human every twenty
       * seconds, forever. That is not a smaller version of the right answer, it is the
       * fastest way to make the pager unreadable — and it would pass every other check
       * in this file, because the notification did arrive and the alert was routed.
       */
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

      /**
       * The negative control, and the reason this section is not decoration.
       *
       * Alertmanager is stopped. Every rule in the file keeps evaluating in Prometheus
       * and not one of them can reach anybody — including `AlertmanagerDown`, whose
       * whole subject is the thing that just happened. The only signal that leaves this
       * deployment is the one that stops, and this waits for a watcher's grace period
       * to elapse over it.
       *
       * The staging API is untouched here. Alertmanager is a container this script
       * created and will remove, which is what makes stopping it a fair test rather
       * than an intrusion into somebody's deployment.
       */
      const stoppedManager = await compose(['stop', 'alertmanager']);
      alertmanagerStopped = stoppedManager.code === 0;
      if (stoppedManager.code !== 0) {
        fail('Alertmanager could be stopped for the negative control', stoppedManager.stderr.trim());
      } else {
        // Three seconds for anything already on the wire to land, so that the counts
        // below are of the silence rather than of the moment before it.
        await new Promise((done) => setTimeout(done, 3_000));
        const webhooksBefore = sink.received.length;
        const mailsBefore = mail.received.length;
        /**
         * How many pings there were to lose, recorded BEFORE the silence is watched for.
         *
         * Without this the check goes green over nothing, and it was observed doing
         * exactly that: a run whose heartbeat was routed to a path this sink does not
         * watch failed the two checks above and then reported "silent for 15s, past the
         * 15s deadline" — true, vacuous, and green. A watcher that has never heard
         * anything cannot tell "stopped" from "never started", and this repository's own
         * rule for every sweep applies here too: a sweep of nothing is not a pass.
         */
        const pingsBeforeStop = arrivals().length;
        const silence = await watchForSilence(arrivals, deadlineMs, deadlineMs + 90_000);
        // What Prometheus thinks, while nothing is being delivered. This is the exact
        // shape of the incident `alerting-blind.md` opens with: the rules are perfect,
        // the evaluation is perfect, and the deployment is blind.
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
        // The other half of a detector worth having: it must also be able to say
        // "recovered". A watcher stuck in the alarm state is as useless as one stuck
        // quiet, and this is also what restores the container for `--keep-up`.
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
      await compose(['stop', 'prometheus', 'alertmanager']);
      await compose(['rm', '-f', 'prometheus', 'alertmanager']);
    }
    if (!options.keepUp) {
      rmSync(TOKEN_FILE, { force: true, recursive: true });
      // The rendered config and the password file go with the containers that read
      // them. `--keep-up` keeps all three, because a container whose mounted config
      // has been deleted underneath it is a confusing thing to inherit.
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
  /**
   * Whether the checks a closing paragraph is about actually passed.
   *
   * Both paragraphs below are conditional, and both had to become so after being
   * caught claiming things the run had just disproved: a `--skip-provoke` log said
   * "both tiers were delivered" three lines under a warning that delivery was not
   * verified, and a run whose heartbeat never arrived still ended with "its absence was
   * detected here". A summary that contradicts its own checks is worse than no summary,
   * because the summary is the part that gets pasted into a report and the checks are
   * the part that does not.
   */
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
      /**
       * The heartbeat, as measurements rather than as a pass.
       *
       * The gaps are the evidence a reader of a release artefact actually wants: a
       * dead man's switch is a claim about a cadence, and "PASS" says nothing about
       * whether the cadence was the configured one. These are the intervals that were
       * observed between real notifications arriving at a real receiver.
       */
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
      // The captured mail, as evidence rather than as a pass/fail.
      //
      // The body is excerpted rather than included whole: Alertmanager's default
      // template is ten kilobytes of inline-styled HTML per message, and pasting three
      // of those into a release artefact would bury the four lines a reader is
      // actually checking. The excerpt is the label block, which is where the alert
      // name lives — so the report shows that the message CONTAINED the alert rather
      // than only asserting that it did.
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
      // Check 7 stops Alertmanager on purpose for about a minute. A Ctrl-C inside that
      // window is the one way this script can leave the overlay half up, and `--keep-up`
      // would then hand the next run an Alertmanager that is down for a reason nothing
      // wrote anywhere.
      if (alertmanagerStopped) {
        console.log(yellow(`  ${signal}: restarting Alertmanager before exiting.`));
        spawnSync('docker', ['compose', ...COMPOSE, 'start', 'alertmanager'], { stdio: 'inherit' });
      }
      process.exit(130);
    });
  }
  process.exitCode = await main();
}

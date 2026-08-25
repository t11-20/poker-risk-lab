#!/usr/bin/env node
/**
 * Refuses a paging configuration that would accept every alert and page nobody.
 *
 * This is what `pnpm run alerts:preflight` does, and what `pnpm run staging promote`
 * runs before it will call a release promotable.
 *
 * ## The incident this exists for
 *
 * `pnpm run alerts:verify` proves the pipeline: a metric condition becomes a firing
 * rule in a real Prometheus, is routed by severity in a real Alertmanager, and is
 * handed to a receiver over an HTTP webhook and a real SMTP transaction. Every part
 * of that is genuine and none of it is this.
 *
 * The realistic production failure is not a broken pipeline. It is a deployment
 * promoted with `PRL_ALERT_PAGE_EMAIL_TO` still holding `oncall@…invalid` — the
 * rehearsal default, an RFC 2606 domain that cannot receive mail — or with
 * `PRL_ALERT_SMTP_USERNAME` set and `PRL_ALERT_SMTP_PASSWORD` unset, or with a
 * smarthost of `host.docker.internal` that resolves only on the machine somebody
 * rehearsed on. Every one of those produces an Alertmanager that starts, reports
 * itself healthy, accepts alerts, routes them correctly by severity, and drops them.
 * Nothing in band can report it: the channel that would carry the report is the
 * channel that is broken. The first symptom is an outage nobody was told about.
 *
 * `alerts:verify` cannot catch it, and the reason is structural rather than an
 * oversight. That script renders the destinations it is about to assert against, so
 * it is *checking its own defaults* — and its defaults are deliberately unroutable
 * sinks on this host, because that is what makes a fresh checkout able to rehearse
 * alerting with no account anywhere. It passes hardest exactly when nothing is
 * configured. This file is the opposite question: are these values ones a stranger's
 * mail relay and a stranger's pager would accept?
 *
 * ## What is checkable here, honestly
 *
 * Everything except the last hop, and the split is worth being exact about because
 * the temptation is to let a green run imply more than it earned.
 *
 * Checkable with no third party at all — checks 1 to 7 below:
 *
 *   * that the configuration came from somewhere. A run where nothing was supplied
 *     is the placeholder case in its purest form and is refused first, before any
 *     individual value is judged, so the message names the cause rather than six
 *     symptoms of it.
 *   * that no destination is a placeholder: the rehearsal default itself, a reserved
 *     documentation domain (`.invalid`, `.example`, `example.com`, `.test`), an
 *     address that names this machine (`localhost`, `127.0.0.1`,
 *     `host.docker.internal`), an unfilled `<…>` marker, or one of the words people
 *     type when they mean "I will come back to this".
 *   * that every destination is well formed — a URL that parses to an http(s) origin
 *     with a host, an address with a local part and a dotted domain, a smarthost that
 *     is `host:port` with a port in range. Alertmanager accepts several of these
 *     malformed and fails at delivery time, which is the wrong time.
 *   * that both severity tiers resolve. The rendered route tree is parsed and every
 *     severity the rules file actually uses is followed to a receiver, and that
 *     receiver is required to contain at least one destination. A tier that matches
 *     no route falls to the catch-all; a receiver with no `url:` and no `to:` in it
 *     is a receiver that notifies nobody. Both are silent.
 *   * that the two tiers are not the same destination. If the pager and the ticket
 *     queue are one address, the two-tier rule at the top of `docs/production/alerts.md`
 *     is prose: every ticket wakes somebody, and people stop reading the pager.
 *   * that the alert body does not cross a network in the clear. Alertmanager's
 *     default template names the instance, the job, the threshold that tripped and
 *     the runbook path — together, a description of how to attack this deployment
 *     while it is already unwell.
 *   * that the credentials the relay is going to ask for are set. A submission port
 *     (587, 465) with no username, or a username with no password, is a `535` at
 *     3am and nothing before it.
 *
 * Checkable only by talking to the relay — check 8, opt in with `--handshake`:
 *
 *   * that the relay is reachable at all, that its certificate verifies, and that it
 *     accepts these credentials. TCP, TLS, `EHLO`, `AUTH`, `QUIT`. Nothing else.
 *
 * ## What this does NOT prove, and will not
 *
 * **That a human wakes up.** A `235 Authentication successful` proves a relay will
 * accept mail from this deployment. It says nothing about whether the address on the
 * other side is one a phone watches, whether the email-to-SMS gateway behind it was
 * decommissioned last year, or whether the person holding the phone is on holiday.
 * Those are answered by sending a test page to a real human and having them reply,
 * which is a deployment's job and is not something a repository can do for it — and
 * this script deliberately never sends one. The handshake stops at `AUTH`: no
 * `MAIL FROM`, no `RCPT TO`, no `DATA`, so running it a thousand times cannot put a
 * single message in anybody's inbox.
 *
 * ## Why the skip is loud
 *
 * `--handshake` needs the relay to be reachable from wherever this runs, which is
 * true on a deploy host and often false on a laptop behind a network that blocks
 * outbound 587. So it is opt-in. The failure mode of an opt-in check is that it is
 * never opted into and its absence reads as a pass — `scripts/supply-chain/*` states
 * the same principle as "a scan of nothing proves nothing" — so a skipped handshake
 * changes the final line of this report, prints in yellow, and is recorded in the
 * JSON as a skip rather than omitted. A run that did not talk to the relay must not
 * be quotable as one that did.
 *
 * Usage:
 *     pnpm run alerts:preflight
 *     pnpm run alerts:preflight -- --handshake     # also talk to the relay
 *     PRL_ALERT_PREFLIGHT_HANDSHAKE=1 pnpm run alerts:preflight
 *     node scripts/alert-preflight.mjs --json --out preflight.json
 *
 * Exit codes:
 *     0  every check passed (the handshake may have been skipped; the report says so)
 *     1  any check failed
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import { join } from 'node:path';
import { connect as tlsConnect } from 'node:tls';
import {
  ALERT_DESTINATION_DEFAULTS,
  alertmanagerValues,
  alertsInRulesFile,
  destinationProblems,
  renderAlertmanagerConfig,
} from './alert-delivery.mjs';
import { bold, dim, green, REPO_ROOT, red, yellow } from './drills/harness.mjs';

const OBSERVABILITY = join(REPO_ROOT, 'deploy', 'staging', 'observability');
const TEMPLATE_FILE = join(OBSERVABILITY, 'alertmanager.template.yml');
const RULES_FILE = join(OBSERVABILITY, 'alert-rules.yml');

// ---------------------------------------------------------------------------
// What counts as a placeholder
// ---------------------------------------------------------------------------

/**
 * The six values that are a destination, as opposed to a setting about one.
 *
 * `PRL_ALERT_SMTP_HELLO` is deliberately not here: its rehearsal default
 * (`localhost`) is also a legitimate production value on a host that has no better
 * name to give, so refusing it would be a false refusal — and a gate that refuses
 * correct configurations is a gate somebody switches off. `PRL_ALERT_SMTP_USERNAME`
 * is not a destination either; it is checked as a credential in check 7.
 */
export const SWEPT_DESTINATIONS = [
  'PRL_ALERT_PAGE_WEBHOOK_URL',
  'PRL_ALERT_TICKET_WEBHOOK_URL',
  'PRL_ALERT_PAGE_EMAIL_TO',
  'PRL_ALERT_TICKET_EMAIL_TO',
  'PRL_ALERT_SMTP_SMARTHOST',
  'PRL_ALERT_EMAIL_FROM',
];

/**
 * Names that resolve to this machine and nowhere else.
 *
 * `host.docker.internal` is the one that actually happens: it is the rehearsal
 * default for the smarthost, it works perfectly on the laptop somebody tested on,
 * and it is not a name at all on the deploy host. The failure is a connection
 * refused inside Alertmanager's notification loop, which is a log line nobody reads.
 */
const LOCAL_HOST =
  /^(?:localhost|127(?:\.\d{1,3}){3}|::1|0\.0\.0\.0|host\.docker\.internal|[^.]+\.local|[^.]+\.localhost)$/i;

/**
 * The domains reserved so that documentation cannot accidentally name a real one.
 *
 * RFC 2606 reserves `.test`, `.example`, `.invalid`, `.localhost` and the three
 * `example.*` second-level domains; RFC 6761 confirms them. Mail to any of them is
 * undeliverable by design, which is exactly why this repository's own rehearsal
 * defaults use `.invalid` — an unconfigured deployment fails loudly rather than
 * quietly mailing a stranger. Promoting one of them is the same mistake with the
 * loudness removed.
 */
const RESERVED_DOMAIN = /(?:^|\.)(?:test|example|invalid|localhost)$|(?:^|\.)example\.(?:com|net|org)$/i;

/**
 * The words people type when they mean "I will come back to this".
 *
 * Bounded by non-alphanumeric lookaround rather than `\b`, so `barclays.example` is
 * matched on its domain and not on the letters `bar`, and a real host like
 * `alerts.foobar.io` is left alone. The list is deliberately short: every entry is a
 * word that has no business in a destination, because a false refusal here blocks a
 * promotion and teaches people to distrust the gate.
 */
const PLACEHOLDER_WORD =
  /(?<![a-z0-9])(?:changeme|change[-_]me|placeholder|replaceme|replace[-_]me|todo|tbd|fixme|dummy|example|sample|foo|bar|baz|xxx|your[-_]?(?:domain|email|company|org|team|key|token|pager))(?![a-z0-9])/i;

/** A marker somebody was supposed to replace, left in place. */
const UNFILLED_MARKER = /[<>{}]|\.\.\./;

/**
 * Every host named by a value, which is where most of the placeholder signal lives.
 *
 * An address list is split, because `email_configs.to` takes a comma-separated list
 * and a deployment that pages two addresses must have BOTH of them checked — one
 * real address beside one placeholder is not half a working pager, it is a pager
 * whose second recipient bounces every time.
 */
export function hostsIn(name, value) {
  if (value === '') return [];
  if (name.endsWith('_WEBHOOK_URL')) {
    try {
      return [new URL(value).hostname.replace(/^\[|\]$/g, '')];
    } catch {
      // Not a URL at all. `wellFormedProblem` reports that; returning no hosts here
      // keeps the two checks from both shouting about the same character.
      return [];
    }
  }
  if (name.endsWith('_EMAIL_TO') || name === 'PRL_ALERT_EMAIL_FROM') {
    return value
      .split(',')
      .map((address) => address.trim())
      .filter((address) => address.includes('@'))
      .map((address) => address.slice(address.lastIndexOf('@') + 1))
      .filter((host) => host !== '');
  }
  if (name === 'PRL_ALERT_SMTP_SMARTHOST') {
    const host = smarthostParts(value).host;
    return host === null ? [] : [host];
  }
  return [];
}

/** `host:port`, or nulls when it is not that shape. Shared with the handshake. */
export function smarthostParts(value) {
  if (value === '') return { host: null, port: null };
  const at = value.lastIndexOf(':');
  if (at === -1) return { host: null, port: null };
  const host = value.slice(0, at).replace(/^\[|\]$/g, '');
  const port = Number(value.slice(at + 1));
  if (host === '' || !Number.isInteger(port) || port < 1 || port > 65535) {
    return { host: null, port: null };
  }
  return { host, port };
}

/**
 * Why this value could not page anybody, or null if nothing here says it could not.
 *
 * The rehearsal-default comparison is first and is the strongest test in the file:
 * it needs no heuristic at all, because `ALERT_DESTINATION_DEFAULTS` IS the set of
 * values that point at `alerts:verify`'s own sinks. A deployment that promoted one
 * of them has promoted a receiver whose entire purpose is to be thrown away at the
 * end of a verification run.
 */
export function placeholderProblem(name, value) {
  if (value === '') return null;
  if (value === ALERT_DESTINATION_DEFAULTS[name]) {
    return `is still the rehearsal default — ${value} is alerts:verify's own throwaway sink, not a pager`;
  }
  if (UNFILLED_MARKER.test(value)) return `has a marker somebody was meant to replace: ${value}`;
  const word = PLACEHOLDER_WORD.exec(value);
  if (word !== null) return `reads as a placeholder — "${word[0]}" in ${value}`;
  for (const host of hostsIn(name, value)) {
    if (LOCAL_HOST.test(host)) {
      return `${host} names the machine this runs on; nothing off it can be reached there`;
    }
    if (RESERVED_DOMAIN.test(host)) {
      return `${host} is reserved for documentation (RFC 2606) and can never receive anything`;
    }
  }
  return null;
}

/**
 * Why Alertmanager or its relay would reject this value's SHAPE.
 *
 * Separate from the placeholder sweep because the two failures want different fixes:
 * a placeholder is "you forgot", a malformed value is "you typed it wrong", and the
 * second is the one that produces an Alertmanager which starts and then throws at
 * notification time, hours later, into a log.
 */
export function wellFormedProblem(name, value) {
  if (value === '') return null;
  if (name.endsWith('_WEBHOOK_URL')) {
    let url;
    try {
      url = new URL(value);
    } catch {
      return `is not a URL: ${value}`;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return `is not an http(s) URL: ${value}`;
    }
    if (url.hostname === '') return `has no host: ${value}`;
    return null;
  }
  if (name.endsWith('_EMAIL_TO') || name === 'PRL_ALERT_EMAIL_FROM') {
    const addresses = value
      .split(',')
      .map((address) => address.trim())
      .filter((address) => address !== '');
    if (addresses.length === 0) return `is punctuation with no address in it: ${JSON.stringify(value)}`;
    for (const address of addresses) {
      // A local part, an `@`, and a dotted domain. Deliberately not an attempt at
      // RFC 5322 — that grammar admits things no relay accepts, and the failures
      // worth catching here are a missing `@` and a bare hostname with no dot.
      if (!/^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,.<>]+$/.test(address)) {
        return `is not an email address: ${address}`;
      }
    }
    return null;
  }
  if (name === 'PRL_ALERT_SMTP_SMARTHOST') {
    if (!value.includes(':')) {
      return `needs host:port — Alertmanager does not default the port, and ${value} has none`;
    }
    if (smarthostParts(value).host === null) return `is not host:port: ${value}`;
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reading the route tree that will actually be loaded
// ---------------------------------------------------------------------------

/**
 * The receivers and the severity routes in a RENDERED alertmanager.yml.
 *
 * Rendered, not templated: the `# @if` blocks mean the template always mentions both
 * transports for both tiers, and the question worth asking is what survives
 * substitution for THIS deployment. A receiver whose two `@if` blocks were both
 * dropped is still `- name: paging` in the output, with nothing underneath it, and
 * Alertmanager loads that without complaint.
 *
 * Line-scanned rather than parsed, for the reason `alertsInRulesFile` gives: this
 * repository ships no YAML parser, the shape is a handful of keys in a known order,
 * and a genuinely malformed file is refused by Alertmanager itself with a better
 * error than anything reproduced here.
 *
 * @returns {{defaultReceiver: string|null, routes: {severity: string, receiver: string}[],
 *            receivers: Map<string, number>}} receivers maps a name to how many
 *            destinations (`url:` or `to:` entries) it actually contains.
 */
export function routingInRenderedConfig(rendered) {
  const receivers = new Map();
  const routes = [];
  let defaultReceiver = null;
  let section = null;
  let receiver = null;
  let pendingSeverity = null;
  for (const line of rendered.split('\n')) {
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    if (/^route:\s*$/.test(line)) {
      section = 'route';
      continue;
    }
    if (/^receivers:\s*$/.test(line)) {
      section = 'receivers';
      receiver = null;
      continue;
    }
    // Any other top-level key — `global:`, `templates:`, `inhibit_rules:` — ends the
    // section that was open. Without this, an `inhibit_rules` block below the
    // receivers would have its `- ...` items counted as somebody's destinations.
    if (/^[A-Za-z_]/.test(line)) {
      section = null;
      continue;
    }
    if (section === 'route') {
      const top = /^ {2}receiver:\s*(\S+)\s*$/.exec(line);
      if (top !== null) {
        defaultReceiver = top[1];
        continue;
      }
      const severity = /^\s*-\s*severity\s*=\s*"([^"]+)"\s*$/.exec(line);
      if (severity !== null) {
        pendingSeverity = severity[1];
        continue;
      }
      const target = /^\s*receiver:\s*(\S+)\s*$/.exec(line);
      if (target !== null && pendingSeverity !== null) {
        routes.push({ severity: pendingSeverity, receiver: target[1] });
        pendingSeverity = null;
      }
      continue;
    }
    if (section === 'receivers') {
      const name = /^\s*-\s*name:\s*(\S+)\s*$/.exec(line);
      if (name !== null) {
        receiver = name[1];
        receivers.set(receiver, 0);
        continue;
      }
      // `- url:` and `- to:` are the only two destination keys either receiver kind
      // can carry here. Counting the ENTRIES rather than the `*_configs:` headers is
      // the point: a `webhook_configs:` with nothing under it is valid YAML and is
      // precisely the shape of a receiver that notifies nobody.
      if (receiver !== null && /^\s*-\s*(?:url|to):\s*\S/.test(line)) {
        receivers.set(receiver, (receivers.get(receiver) ?? 0) + 1);
      }
    }
  }
  return { defaultReceiver, routes, receivers };
}

/**
 * Every severity a rule actually carries, plus the two tiers that must always exist.
 *
 * The union with `page` and `ticket` is not belt and braces. If a rules file lost
 * every paging rule, checking only the severities it still uses would report that
 * the configuration is fine — and it would be, for the rules that remain, which is
 * the wrong question. The two-tier rule is a property of the DEPLOYMENT, so both
 * tiers are required to resolve whether or not anything currently uses them.
 */
export function severitiesToRoute(rulesText) {
  const declared = [...alertsInRulesFile(rulesText).values()];
  const severities = new Set(['page', 'ticket']);
  for (const rule of declared) if (rule.severity !== null) severities.add(rule.severity);
  return { severities, ruleCount: declared.length };
}

// ---------------------------------------------------------------------------
// The static checks
// ---------------------------------------------------------------------------

/**
 * Every check that can be made without opening a socket, as a list of results.
 *
 * Returned as data rather than printed, so that `alert-preflight.test.mjs` can drive
 * the whole analysis against a configuration it invents — including the four
 * configurations this file exists to refuse — with no environment, no containers and
 * no relay. A guard whose failure mode has never been observed is decoration, and
 * the only cheap way to observe six failure modes is to construct them.
 *
 * @param {{values: Record<string,string>, overridden: string[], password: string,
 *          rulesText: string, template: string}} input
 * @returns {{name: string, ok: boolean, detail: string}[]}
 */
export function staticChecks({ values, overridden, password, rulesText, template }) {
  const checks = [];
  // `problems` is kept as a list rather than joined into the detail line. Six
  // placeholder destinations on one line is a paragraph nobody reads to the end of,
  // and the whole value of this gate is that the reason is legible at the moment
  // somebody is being told they cannot promote.
  const record = (name, problems, detail) =>
    checks.push({ name, ok: problems.length === 0, detail, problems });

  // --- 1: the configuration came from somewhere ----------------------------
  //
  // First, and on its own, because every other check below would otherwise report a
  // separate symptom of the same one cause and bury it. A run with nothing supplied
  // is not "six bad destinations", it is "this deployment never configured alerting"
  // — and that is the sentence an operator needs to read.
  record(
    'the alerting configuration came from the environment',
    overridden.length === 0
      ? [
          'not one PRL_ALERT_* variable is set, so every destination below is the rehearsal ' +
            "default: two paths on alerts:verify's own webhook sink and its own SMTP sink, both " +
            'on this machine. Nothing here could page anybody. Set them in the deployment ' +
            'environment — deploy/staging/observability/alertmanager.template.yml lists every one',
        ]
      : [],
    `${overridden.length} of ${Object.keys(ALERT_DESTINATION_DEFAULTS).length} supplied: ${overridden.join(', ')}`,
  );

  // --- 2: every routed tier has a destination at all -----------------------
  //
  // `destinationProblems` is imported rather than reimplemented on purpose. It is
  // the same predicate `alerts:verify` refuses to render with, and two copies of a
  // rule about what makes a receiver empty is how one of them stops being true.
  record(
    'every tier has a destination, and email has a relay to reach it through',
    destinationProblems(values),
    'both tiers carry at least one transport, and the SMTP settings email needs are present',
  );

  // --- 3: no destination is a placeholder ----------------------------------
  const placeholders = [];
  let swept = 0;
  for (const name of SWEPT_DESTINATIONS) {
    if (values[name] === '') continue;
    swept += 1;
    const problem = placeholderProblem(name, values[name]);
    if (problem !== null) placeholders.push(`${name} ${problem}`);
  }
  if (swept === 0) {
    // Reached only when every destination is empty, which check 2 also reports —
    // but a sweep that examined nothing must say so itself rather than passing,
    // because "no placeholders found" over an empty set is true and useless.
    placeholders.push('every destination is empty, so this sweep examined nothing — that is not a pass');
  }
  record('no destination is a placeholder', placeholders, `${swept} destination(s) examined`);

  // --- 4: every destination is well formed ---------------------------------
  const malformed = [];
  for (const name of SWEPT_DESTINATIONS) {
    const problem = wellFormedProblem(name, values[name]);
    if (problem !== null) malformed.push(`${name} ${problem}`);
  }
  record('every destination is well formed', malformed, `${swept} destination(s) parsed`);

  // --- 5: the two tiers are not the same place -----------------------------
  //
  // Not a formality, and not caught by anything above: two identical real addresses
  // are individually valid, present and non-placeholder. What they are is the
  // two-tier rule deleted. Every ticket then wakes somebody, and the predictable
  // consequence is that the pager stops being read — which is worse than having no
  // ticket tier at all, because the failure is in the humans and is invisible here.
  const collisions = [];
  for (const transport of ['WEBHOOK_URL', 'EMAIL_TO']) {
    const page = values[`PRL_ALERT_PAGE_${transport}`];
    const ticket = values[`PRL_ALERT_TICKET_${transport}`];
    if (page !== '' && page === ticket) {
      collisions.push(
        `the paging and ticket ${transport === 'EMAIL_TO' ? 'addresses' : 'webhooks'} are both ` +
          `${page} — every ticket would wake somebody, which is how a pager stops being read`,
      );
    }
  }
  record('the paging tier and the ticket tier are different destinations', collisions, 'they differ');

  // --- 6: nothing carrying an alert body crosses a network in the clear ----
  //
  // Alertmanager's default template names the instance, the job, the threshold that
  // tripped and the runbook path. That is a description of how to attack this
  // deployment, written at the moment it is least able to cope, and it must not go
  // out over plaintext to anywhere but this host. `alerts:verify` only WARNS about
  // the same combination, correctly: its own relay is a local sink with no
  // certificate. A promotion is the other case, so here it is a refusal.
  const cleartext = [];
  const relay = smarthostParts(values.PRL_ALERT_SMTP_SMARTHOST);
  if (relay.host !== null && !LOCAL_HOST.test(relay.host) && values.PRL_ALERT_SMTP_REQUIRE_TLS !== 'true') {
    cleartext.push(
      `PRL_ALERT_SMTP_REQUIRE_TLS is ${JSON.stringify(values.PRL_ALERT_SMTP_REQUIRE_TLS)} and the ` +
        `relay is ${values.PRL_ALERT_SMTP_SMARTHOST}, which is not on this host`,
    );
  }
  for (const name of ['PRL_ALERT_PAGE_WEBHOOK_URL', 'PRL_ALERT_TICKET_WEBHOOK_URL']) {
    const value = values[name];
    if (value === '') continue;
    let url;
    try {
      url = new URL(value);
    } catch {
      continue;
    }
    if (url.protocol === 'http:' && !LOCAL_HOST.test(url.hostname)) {
      cleartext.push(`${name} posts an alert body over plaintext http to ${url.hostname}`);
    }
  }
  record('no alert body crosses a network in the clear', cleartext, 'TLS to every off-host destination');

  // --- 7: the credentials the relay will ask for are set -------------------
  //
  // The password is never read for its VALUE here and is never printed — only its
  // presence, and whether it is one of the placeholder words. The rendered
  // configuration is the artefact somebody pastes into a bug report and this report
  // is the artefact somebody pastes beside it.
  const credentials = [];
  const username = values.PRL_ALERT_SMTP_USERNAME;
  if (username !== '' && password === '') {
    credentials.push(
      'PRL_ALERT_SMTP_USERNAME is set and PRL_ALERT_SMTP_PASSWORD is empty. Alertmanager would ' +
        'authenticate with an empty password and every submission relay answers 535 — at 3am, ' +
        'into a log, with the page undelivered',
    );
  }
  if (username === '' && password !== '') {
    credentials.push(
      'PRL_ALERT_SMTP_PASSWORD is set and PRL_ALERT_SMTP_USERNAME is not. The template emits ' +
        'smtp_auth_password_file only inside the username block, so the password is written to ' +
        'disk and never sent — which looks configured and authenticates nothing',
    );
  }
  if (password !== '' && PLACEHOLDER_WORD.test(password)) {
    credentials.push('PRL_ALERT_SMTP_PASSWORD reads as a placeholder word rather than a secret');
  }
  if (relay.host !== null && !LOCAL_HOST.test(relay.host) && username === '') {
    if (relay.port === 587 || relay.port === 465) {
      credentials.push(
        `the relay ${values.PRL_ALERT_SMTP_SMARTHOST} is a submission port and no ` +
          'PRL_ALERT_SMTP_USERNAME is set. RFC 6409 submission requires authentication, so this ' +
          'relay will refuse every notification',
      );
    }
  }
  record(
    'the credentials the relay will ask for are set',
    credentials,
    username === ''
      ? 'no SMTP username is configured, so Alertmanager will not attempt AUTH'
      : `PRL_ALERT_SMTP_USERNAME is set and a password of ${password.length} characters is present`,
  );

  // --- 8: both tiers resolve to a receiver that has somewhere to send ------
  const routing = [];
  let rendered = null;
  try {
    rendered = renderAlertmanagerConfig(template, values);
  } catch (error) {
    // The renderer refuses an empty substitution outright, which is a refusal worth
    // surfacing as this check rather than as a stack trace: it means the file
    // Alertmanager would load could not be produced at all.
    routing.push(`alertmanager.yml could not be rendered: ${error.message}`);
  }
  const { severities, ruleCount } = severitiesToRoute(rulesText);
  if (ruleCount === 0) {
    routing.push(`${RULES_FILE} yielded no alert rules — an analysis of nothing is not a pass`);
  }
  let receivers = new Map();
  if (rendered !== null) {
    const parsed = routingInRenderedConfig(rendered);
    receivers = parsed.receivers;
    if (receivers.size === 0) {
      routing.push('the rendered configuration declares no receivers at all');
    }
    for (const severity of [...severities].sort()) {
      const route = parsed.routes.find((entry) => entry.severity === severity);
      const target = route?.receiver ?? parsed.defaultReceiver;
      if (route === undefined) {
        routing.push(
          `severity ${severity} matches no route, so it would fall to the catch-all receiver ` +
            `${parsed.defaultReceiver ?? '(none)'} — a page delivered to the ticket queue is a page ` +
            'nobody was woken for',
        );
        continue;
      }
      const count = receivers.get(target);
      if (count === undefined) {
        routing.push(`severity ${severity} routes to receiver ${target}, which does not exist`);
      } else if (count === 0) {
        routing.push(
          `severity ${severity} routes to receiver ${target}, which has no destination in it. ` +
            'Alertmanager loads that, routes to it, and drops the notification',
        );
      }
    }
    const unmatched = [...alertsInRulesFile(rulesText)].filter(
      ([, rule]) => rule.severity === null || !severities.has(rule.severity),
    );
    if (unmatched.length > 0) {
      routing.push(`rule(s) with no usable severity: ${unmatched.map(([name]) => name).join(', ')}`);
    }
  }
  record(
    'every severity the rules use resolves to a receiver with a destination',
    routing,
    `${ruleCount} rules, ${severities.size} severities, ` +
      `${[...receivers].map(([name, count]) => `${name}:${count}`).join(' ')}`,
  );

  return checks;
}

// ---------------------------------------------------------------------------
// The handshake
// ---------------------------------------------------------------------------

/**
 * Binds a line reader and a writer to a socket, and turns every way a socket can end
 * into a rejected read.
 *
 * SMTP frames a reply as one or more lines where every line but the last puts a
 * HYPHEN after the three-digit code. Reading that wrongly is not a wrong answer, it
 * is a hang — the reader waits for a line that already arrived — which is why the
 * completion test is on the last line's separator and not on a newline.
 *
 * Buffered data is delivered before a failure is reported. A relay that answers
 * `535` and immediately closes is the single most important case this function
 * handles, and reporting the close instead of the `535` would turn "your password is
 * wrong" into "the connection dropped".
 */
function attach(socket) {
  let buffer = '';
  let waiting = null;
  let failure = null;
  const settle = () => {
    if (waiting === null) return;
    const lines = buffer.split('\r\n');
    const at = lines.findIndex((line) => /^\d{3}(?: |$)/.test(line));
    if (at !== -1) {
      const reply = lines.slice(0, at + 1).join('\r\n');
      buffer = lines.slice(at + 1).join('\r\n');
      const settled = waiting;
      waiting = null;
      settled.resolve(reply);
      return;
    }
    if (failure !== null) {
      const settled = waiting;
      waiting = null;
      settled.reject(failure);
    }
  };
  // latin1 rather than utf8, and no `setEncoding`: a STARTTLS upgrade hands this same
  // socket to `tls.connect`, and a decoder left on it would corrupt the TLS records.
  const onData = (chunk) => {
    buffer += chunk.toString('latin1');
    settle();
  };
  const onError = (error) => {
    failure = error;
    settle();
  };
  const onClose = () => {
    failure ??= new Error('the relay closed the connection without replying');
    settle();
  };
  socket.on('data', onData);
  socket.on('error', onError);
  socket.on('close', onClose);
  return {
    read: () =>
      new Promise((resolve, reject) => {
        waiting = { resolve, reject };
        settle();
      }),
    say: (line) => socket.write(`${line}\r\n`),
    /** Detaches every listener, so the socket can be handed to the TLS layer clean. */
    release: () => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
      return buffer;
    },
  };
}

const codeOf = (reply) => Number.parseInt(reply.slice(0, 3), 10);

/** The extension keywords an `EHLO` reply advertised, upper-cased, one per line. */
const extensionsIn = (reply) =>
  reply
    .split('\r\n')
    .slice(1)
    .map((line) => line.slice(4).trim().toUpperCase())
    .filter((line) => line !== '');

/**
 * The SNI name for a host, or nothing when the host is a literal address.
 *
 * RFC 6066 forbids an IP in `server_name`, and Node warns that it will start
 * ignoring one. A relay named by address is a legitimate deployment — an internal
 * relay with no DNS entry — so the answer is to omit the extension rather than to
 * send something invalid, which some servers answer by aborting the handshake.
 */
const sni = (host) => (/^[\d.]+$/.test(host) || host.includes(':') ? {} : { servername: host });

function openSocket({ host, port, implicitTls, timeoutMs, ca }) {
  return new Promise((done, failed) => {
    const socket = implicitTls
      ? tlsConnect({ host, port, ...sni(host), ...(ca === null ? {} : { ca }) }, () => done(socket))
      : netConnect({ host, port }, () => done(socket));
    socket.setTimeout(timeoutMs, () => {
      socket.destroy(new Error(`no answer from ${host}:${port} within ${timeoutMs} ms`));
    });
    socket.once('error', failed);
  });
}

function upgrade(socket, host, timeoutMs, ca) {
  return new Promise((done, failed) => {
    // `host` is not decoration on this path: when `tls.connect` is handed an existing
    // socket it has no idea what was dialled, and it verifies the certificate against
    // the string `localhost` by default. That silently inverts the check — a relay
    // presenting a certificate for `localhost` would be accepted and the real relay's
    // own certificate would be rejected — so the name the configuration named is passed
    // explicitly. SNI is sent separately, and only when that name is not an address.
    const secure = tlsConnect({ socket, host, ...sni(host), ...(ca === null ? {} : { ca }) }, () =>
      done(secure),
    );
    secure.setTimeout(timeoutMs, () => {
      secure.destroy(new Error(`the TLS handshake with ${host} did not finish within ${timeoutMs} ms`));
    });
    secure.once('error', failed);
  });
}

/**
 * Proves, as far as anything can prove without waking somebody, that this
 * deployment's mail credentials work.
 *
 * TCP, then TLS, then `EHLO`, then `AUTH`, then `QUIT`. That is the entire dialogue
 * and the omission is the point: there is no `MAIL FROM`, no `RCPT TO` and no
 * `DATA`, so this cannot deliver a message to a human however many times it runs.
 * Somebody will eventually want to "just send a test one" from here; that is a
 * deployment's decision to make deliberately, with a real recipient who has agreed
 * to it, and not a side effect of a preflight run in a loop by CI.
 *
 * What a `235` establishes, exactly: this relay, reached over a verified TLS
 * connection, accepts this username and this password today. What it does not
 * establish: that the recipient address exists, that mail to it is delivered, that
 * anything forwards it to a phone, or that a person reads it. Those are the residual
 * and they stay the residual.
 *
 * Exported and fully parameterised so `alert-preflight.test.mjs` can drive it against
 * a relay it starts itself — including one that answers `535` — because a bug in the
 * dialogue below would otherwise surface for the first time during a promotion.
 *
 * @returns {Promise<{ok: boolean, steps: string[], problem: string|null,
 *                    tls: 'implicit'|'starttls'|'none', authenticated: boolean}>}
 */
export async function smtpHandshake({
  host,
  port,
  hello = 'localhost',
  username = '',
  password = '',
  requireTls = true,
  timeoutMs = 15_000,
  ca = null,
  // 465 is SMTPS: TLS from the first byte, with no cleartext phase and no STARTTLS.
  // Anything else is submission or relay, where TLS arrives through STARTTLS. The
  // override exists so the test can drive the implicit branch on an ephemeral port —
  // binding 465 needs root, and a branch that can only be exercised as root is a
  // branch that never is.
  implicitTls = port === 465,
}) {
  const steps = [];
  let tls = implicitTls ? 'implicit' : 'none';
  let socket = null;
  try {
    socket = await openSocket({ host, port, implicitTls, timeoutMs, ca });
    steps.push(`TCP connected to ${host}:${port}${implicitTls ? ' and completed a TLS handshake' : ''}`);
    let wire = attach(socket);

    const greeting = await wire.read();
    if (codeOf(greeting) !== 220) {
      return { ok: false, steps, tls, authenticated: false, problem: `greeting was ${greeting.trim()}` };
    }
    steps.push(`greeting ${greeting.trim().split('\r\n')[0]}`);

    wire.say(`EHLO ${hello}`);
    let ehlo = await wire.read();
    if (codeOf(ehlo) !== 250) {
      return { ok: false, steps, tls, authenticated: false, problem: `EHLO was refused: ${ehlo.trim()}` };
    }
    let extensions = extensionsIn(ehlo);
    steps.push(`EHLO accepted, ${extensions.length} extension(s) advertised`);

    if (!implicitTls) {
      const offersStartTls = extensions.some((line) => line.split(' ')[0] === 'STARTTLS');
      if (!offersStartTls && requireTls) {
        return {
          ok: false,
          steps,
          tls,
          authenticated: false,
          problem:
            'the relay does not advertise STARTTLS and PRL_ALERT_SMTP_REQUIRE_TLS is true, so ' +
            'Alertmanager would refuse to send rather than downgrade',
        };
      }
      if (offersStartTls) {
        wire.say('STARTTLS');
        const ready = await wire.read();
        if (codeOf(ready) !== 220) {
          return {
            ok: false,
            steps,
            tls,
            authenticated: false,
            problem: `STARTTLS was refused: ${ready.trim()}`,
          };
        }
        // Detached before the upgrade, so the TLS layer — not this reader — owns the
        // bytes from here. Leaving the listener attached would race the handshake for
        // the ServerHello and fail in a way that reads as a certificate problem.
        wire.release();
        socket = await upgrade(socket, host, timeoutMs, ca);
        tls = 'starttls';
        const cipher = socket.getCipher?.() ?? null;
        steps.push(
          `STARTTLS negotiated, ${socket.getProtocol?.() ?? 'TLS'}${cipher === null ? '' : ` ${cipher.name}`}, ` +
            'certificate verified against the system trust store',
        );
        wire = attach(socket);
        // A second EHLO is required after an upgrade, not optional: RFC 3207 says the
        // client must discard everything the cleartext session advertised, and AUTH is
        // routinely offered only after TLS.
        wire.say(`EHLO ${hello}`);
        ehlo = await wire.read();
        if (codeOf(ehlo) !== 250) {
          return {
            ok: false,
            steps,
            tls,
            authenticated: false,
            problem: `EHLO after STARTTLS was refused: ${ehlo.trim()}`,
          };
        }
        extensions = extensionsIn(ehlo);
      }
    } else {
      steps.push(
        `implicit TLS on ${port}, ${socket.getProtocol?.() ?? 'TLS'}, certificate verified against ` +
          'the system trust store',
      );
    }

    let authenticated = false;
    if (username !== '') {
      const advertised = extensions.find((line) => line.split(' ')[0] === 'AUTH') ?? '';
      const mechanisms = advertised.split(/[\s=]+/).slice(1);
      const problem = await authenticate(wire, mechanisms, username, password);
      if (problem !== null) return { ok: false, steps, tls, authenticated: false, problem };
      // The mechanism, never the credential. An `AUTH PLAIN <base64>` line contains
      // the password in a form anybody can read, and this report is meant to be
      // pasteable.
      authenticated = true;
      steps.push(`AUTH accepted for ${username}`);
    }

    wire.say('QUIT');
    await wire.read().catch(() => '');
    return { ok: true, steps, tls, authenticated, problem: null };
  } catch (error) {
    return { ok: false, steps, tls, authenticated: false, problem: error.message };
  } finally {
    socket?.destroy();
  }
}

/**
 * One AUTH exchange, in whichever of the two mechanisms every relay speaks.
 *
 * PLAIN first because it is one round trip and is what Go's `net/smtp` — the client
 * Alertmanager actually uses — prefers; LOGIN as the fallback because a handful of
 * relays still offer only that. Anything else advertised is ignored rather than
 * attempted: `CRAM-MD5` and `XOAUTH2` are not what `smtp_auth_password_file`
 * configures, so succeeding at one of them would prove something about a credential
 * this deployment does not use.
 */
async function authenticate(wire, mechanisms, username, password) {
  const encode = (text) => Buffer.from(text, 'utf8').toString('base64');
  if (mechanisms.includes('PLAIN')) {
    wire.say(`AUTH PLAIN ${encode(`\0${username}\0${password}`)}`);
    const reply = await wire.read();
    return codeOf(reply) === 235 ? null : `AUTH PLAIN was refused: ${reply.trim()}`;
  }
  if (mechanisms.includes('LOGIN')) {
    wire.say('AUTH LOGIN');
    const wantsUser = await wire.read();
    if (codeOf(wantsUser) !== 334) return `AUTH LOGIN was refused: ${wantsUser.trim()}`;
    wire.say(encode(username));
    const wantsPassword = await wire.read();
    if (codeOf(wantsPassword) !== 334) return `the username was refused: ${wantsPassword.trim()}`;
    wire.say(encode(password));
    const reply = await wire.read();
    return codeOf(reply) === 235 ? null : `AUTH LOGIN was refused: ${reply.trim()}`;
  }
  return (
    'a username is configured but the relay advertises no AUTH mechanism this can use ' +
    `(offered: ${mechanisms.join(', ') || 'none'}). Alertmanager would send the notification ` +
    'unauthenticated, and the relay would refuse it'
  );
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

const options = {
  handshake:
    process.argv.includes('--handshake') ||
    /^(?:1|true|yes|on)$/i.test(process.env.PRL_ALERT_PREFLIGHT_HANDSHAKE ?? ''),
  json: process.argv.includes('--json'),
  out: (() => {
    const at = process.argv.indexOf('--out');
    return at === -1 ? null : (process.argv[at + 1] ?? null);
  })(),
};

/** The username as the renderer sees it, which is the empty string when unset. */
const username = (values) => values.PRL_ALERT_SMTP_USERNAME;

/**
 * How the connection was protected, in words rather than in a field name.
 *
 * "over none TLS" is what the field spells, and the one thing this line must not do is
 * be skimmed past — a cleartext leg is only ever acceptable to a relay on this host,
 * and it should read as the exception it is.
 */
const transportOf = (handshake) =>
  handshake.tls === 'none' ? 'a CLEARTEXT connection' : `TLS (${handshake.tls})`;

function report(checks) {
  for (const check of checks) {
    if (check.skipped === true) {
      console.log(`  ${yellow('⚠')} ${check.name} — ${yellow('SKIPPED')}`);
      for (const line of check.detail.split('\n')) console.log(yellow(`      ${line}`));
      continue;
    }
    if (check.ok) {
      console.log(`  ${green('✓')} ${check.name}${dim(` — ${check.detail}`)}`);
      continue;
    }
    console.log(`  ${red('✗')} ${check.name}`);
    for (const problem of check.problems ?? [check.detail]) {
      console.log(red(`      · ${wrap(problem)}`));
    }
  }
}

/** Folds a problem onto continuation lines at the same indent, so it stays readable. */
function wrap(text, width = 96, indent = '        ') {
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line !== '' && `${line} ${word}`.length > width) {
      lines.push(line);
      line = word;
      continue;
    }
    line = line === '' ? word : `${line} ${word}`;
  }
  if (line !== '') lines.push(line);
  return lines.join(`\n${indent}`);
}

async function main() {
  console.log(bold('\nPoker Risk Lab — alerting preflight'));
  console.log(
    dim(
      '  Does this deployment have a paging destination a stranger would accept, or the\n' +
        "  rehearsal's own throwaway sinks? A promotion turns on the difference.\n",
    ),
  );

  const { values, overridden } = alertmanagerValues();
  const password = (process.env.PRL_ALERT_SMTP_PASSWORD ?? '').trim();
  const checks = staticChecks({
    values,
    overridden,
    password,
    rulesText: readFileSync(RULES_FILE, 'utf8'),
    template: readFileSync(TEMPLATE_FILE, 'utf8'),
  });
  report(checks);

  console.log(bold('\nReachability'));
  const relay = smarthostParts(values.PRL_ALERT_SMTP_SMARTHOST);
  let handshake = null;
  if (!options.handshake) {
    checks.push({
      name: 'the relay accepts these credentials',
      ok: true,
      skipped: true,
      detail:
        'not requested, so NOTHING in this run connected to a relay. This run does NOT prove that\n' +
        `${values.PRL_ALERT_SMTP_SMARTHOST || '(no relay is configured)'} is reachable, that its ` +
        'certificate verifies, or that it accepts\n' +
        'PRL_ALERT_SMTP_USERNAME / PRL_ALERT_SMTP_PASSWORD. Re-run with --handshake (or\n' +
        'PRL_ALERT_PREFLIGHT_HANDSHAKE=1) from a host that can reach the relay.',
    });
  } else if (relay.host === null) {
    checks.push({
      name: 'the relay accepts these credentials',
      ok: false,
      detail: `--handshake was requested and PRL_ALERT_SMTP_SMARTHOST is ${JSON.stringify(values.PRL_ALERT_SMTP_SMARTHOST)}, which is not a host:port to connect to`,
    });
  } else {
    console.log(
      dim(
        `  connecting to ${relay.host}:${relay.port} — EHLO, ${username(values) === '' ? 'no AUTH' : 'AUTH'}, QUIT.\n` +
          '  No MAIL FROM, no RCPT TO, no DATA: this cannot put a message in anybody’s inbox.\n',
      ),
    );
    handshake = await smtpHandshake({
      host: relay.host,
      port: relay.port,
      hello: values.PRL_ALERT_SMTP_HELLO,
      username: username(values),
      password,
      requireTls: values.PRL_ALERT_SMTP_REQUIRE_TLS === 'true',
      timeoutMs: Number(process.env.PRL_ALERT_PREFLIGHT_TIMEOUT_MS ?? 15_000),
    });
    for (const step of handshake.steps) console.log(dim(`      · ${step}`));
    checks.push({
      name: 'the relay accepts these credentials',
      ok: handshake.ok,
      detail: handshake.ok
        ? handshake.authenticated
          ? `${relay.host} authenticated ${username(values)} over ${transportOf(handshake)}`
          : `${relay.host} answered EHLO over ${transportOf(handshake)}; NO credential was ` +
            'exercised, because none is configured'
        : (handshake.problem ?? 'the handshake failed'),
    });
  }
  report(checks.slice(-1));

  const failed = checks.filter((check) => !check.ok);
  const skipped = checks.filter((check) => check.skipped === true);
  console.log('');
  if (failed.length > 0) {
    console.log(red(bold(`PREFLIGHT REFUSED — ${failed.length} of ${checks.length} check(s) failed.`)));
    console.log(
      dim(
        '\n  Every failure above is a way for an alert to fire, route correctly and reach nobody.\n' +
          '  Set the PRL_ALERT_* variables listed in\n' +
          '  deploy/staging/observability/alertmanager.template.yml and run this again.\n' +
          '\n  `pnpm run staging promote` runs this check and will not call a release promotable\n' +
          '  while it fails.\n',
      ),
    );
  } else if (skipped.length > 0) {
    // Deliberately not the word "passed" on its own. An opt-in check that is never
    // opted into has to leave a mark on the summary line, or its absence becomes a
    // pass by habit — which is the failure mode of every skippable gate.
    console.log(
      yellow(bold(`PREFLIGHT PASSED — CREDENTIALS UNPROVEN (${checks.length - 1} checked, 1 skipped)`)),
    );
    console.log(
      dim(
        '\n  The configuration is not a placeholder and both tiers resolve to somewhere real.\n' +
          '  Nothing here talked to the relay. Run with --handshake before a production\n' +
          '  promotion, from a host that can reach it.\n',
      ),
    );
  } else {
    console.log(green(bold(`PREFLIGHT PASSED — ${checks.length} check(s), the relay was reached.`)));
  }
  if (failed.length === 0) {
    // Printed only on a pass, and it is the sentence this whole file is careful
    // about. A green run says the destinations are real; it does not say a person
    // wakes up, and nothing in this repository can.
    console.log(
      dim(
        '  What a pass means: the destinations are real, well formed, distinct per tier, reached\n' +
          '  over TLS where a relay was contacted, and every severity resolves to a receiver that\n' +
          '  has somewhere to send. What it does NOT mean, here or anywhere: that the address is\n' +
          '  one a phone watches, or that a person wakes up. Send yourself a real test page.\n',
      ),
    );
  }

  if (options.json || options.out !== null) {
    const text = `${JSON.stringify(
      {
        schema: 'prl.alert-preflight.v1',
        handshake:
          handshake === null
            ? { attempted: false, reason: 'not requested — pass --handshake' }
            : {
                attempted: true,
                ok: handshake.ok,
                tls: handshake.tls,
                authenticated: handshake.authenticated,
                steps: handshake.steps,
                problem: handshake.problem,
              },
        // The destinations, but never the password: this file is meant to be
        // attachable to a promotion record.
        destinations: values,
        supplied: overridden,
        smtpPasswordPresent: password !== '',
        checks,
      },
      null,
      2,
    )}\n`;
    if (options.out !== null) writeFileSync(options.out, text);
    if (options.json) console.log(text);
  }

  return failed.length === 0 ? 0 : 1;
}

if (import.meta.main) {
  process.exitCode = await main();
}

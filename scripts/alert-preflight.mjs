#!/usr/bin/env node
/**
 * Refuses a paging configuration that would accept every alert and page nobody. This is
 * `pnpm run alerts:preflight`, and `pnpm run staging promote` runs it before calling a release
 * promotable. `alerts:verify` cannot catch this, because it checks its own unroutable defaults and
 * passes hardest when nothing is configured. This asks whether a stranger's relay and pager would
 * accept these values. It refuses placeholders (the rehearsal defaults, RFC 2606 domains,
 * `host.docker.internal`), malformed values, tiers that route nowhere, a pager equal to the ticket
 * queue, a heartbeat on a placeholder or human destination, cleartext bodies, and missing SMTP
 * credentials.
 *
 * `--handshake` also talks to the relay (TCP, TLS, `EHLO`, `AUTH`, `QUIT`). It never sends
 * `MAIL FROM`, `RCPT TO` or `DATA`, so no run can deliver a message. A `235` does not prove a human
 * wakes up. `pnpm run alerts:ack` asks that. The handshake is opt-in because outbound 587 is often
 * blocked, so a skip changes the summary line, prints yellow, and is recorded in the JSON.
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

/**
 * `PRL_ALERT_SMTP_HELLO` is left out because its default (`localhost`) is also a legitimate
 * production value. `PRL_ALERT_SMTP_USERNAME` is checked as a credential instead.
 */
export const SWEPT_DESTINATIONS = [
  'PRL_ALERT_PAGE_WEBHOOK_URL',
  'PRL_ALERT_TICKET_WEBHOOK_URL',
  // A placeholder heartbeat is never discovered, because `Watchdog` keeps firing and routing
  // correctly. This is the only place it can be refused.
  'PRL_ALERT_HEARTBEAT_WEBHOOK_URL',
  'PRL_ALERT_PAGE_EMAIL_TO',
  'PRL_ALERT_TICKET_EMAIL_TO',
  'PRL_ALERT_SMTP_SMARTHOST',
  'PRL_ALERT_EMAIL_FROM',
];

/** `host.docker.internal` is the smarthost rehearsal default and is not a name on the deploy host. */
const LOCAL_HOST =
  /^(?:localhost|127(?:\.\d{1,3}){3}|::1|0\.0\.0\.0|host\.docker\.internal|[^.]+\.local|[^.]+\.localhost)$/i;

/** RFC 2606 reserved domains. The rehearsal defaults use `.invalid` so they fail loudly. */
const RESERVED_DOMAIN = /(?:^|\.)(?:test|example|invalid|localhost)$|(?:^|\.)example\.(?:com|net|org)$/i;

/**
 * Bounded by non-alphanumeric lookaround rather than `\b`, so `alerts.foobar.io` is left alone. The
 * list stays short because a false refusal blocks a promotion.
 */
const PLACEHOLDER_WORD =
  /(?<![a-z0-9])(?:changeme|change[-_]me|placeholder|replaceme|replace[-_]me|todo|tbd|fixme|dummy|example|sample|foo|bar|baz|xxx|your[-_]?(?:domain|email|company|org|team|key|token|pager))(?![a-z0-9])/i;

const UNFILLED_MARKER = /[<>{}]|\.\.\./;

/** An address list is split so every recipient of `email_configs.to` is checked. */
export function hostsIn(name, value) {
  if (value === '') return [];
  if (name.endsWith('_WEBHOOK_URL')) {
    try {
      return [new URL(value).hostname.replace(/^\[|\]$/g, '')];
    } catch {
      // Not a URL. `wellFormedProblem` reports that, so this does not report it twice.
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

/** The rehearsal-default comparison comes first because those values are `alerts:verify`'s own sinks. */
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

/** Malformed values make Alertmanager start and then fail at notification time. */
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
      // Deliberately not RFC 5322. The failures worth catching are a missing `@` and an undotted host.
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

/**
 * The receivers and severity routes in a RENDERED alertmanager.yml. A receiver whose `@if` blocks
 * were both dropped still renders as `- name: paging` with nothing under it, and Alertmanager loads
 * it. Line-scanned because the repo ships no YAML parser and the shape is fixed.
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
    // Any other top-level key ends the open section, so `inhibit_rules` items are not counted.
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
      // Count entries, not `*_configs:` headers. An empty `webhook_configs:` notifies nobody.
      if (receiver !== null && /^\s*-\s*(?:url|to):\s*\S/.test(line)) {
        receivers.set(receiver, (receivers.get(receiver) ?? 0) + 1);
      }
    }
  }
  return { defaultReceiver, routes, receivers };
}

/** `page` and `ticket` must always resolve, even if no rule currently uses them. */
export function severitiesToRoute(rulesText) {
  const declared = [...alertsInRulesFile(rulesText).values()];
  const severities = new Set(['page', 'ticket']);
  for (const rule of declared) if (rule.severity !== null) severities.add(rule.severity);
  return { severities, ruleCount: declared.length };
}

/**
 * Every check that can be made without opening a socket. Returned as data so the test can drive
 * invented configurations through it.
 *
 * @param {{values: Record<string,string>, overridden: string[], password: string,
 *          rulesText: string, template: string}} input
 * @returns {{name: string, ok: boolean, detail: string}[]}
 */
export function staticChecks({ values, overridden, password, rulesText, template }) {
  const checks = [];
  const record = (name, problems, detail) =>
    checks.push({ name, ok: problems.length === 0, detail, problems });

  // 1. Checked first, so an unconfigured deployment gets one cause rather than six symptoms.
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

  // 2. `destinationProblems` is the same predicate `alerts:verify` renders with.
  record(
    'every tier has a destination, and email has a relay to reach it through',
    destinationProblems(values),
    'both tiers carry at least one transport, and the SMTP settings email needs are present',
  );

  // 3. No placeholders.
  const placeholders = [];
  let swept = 0;
  for (const name of SWEPT_DESTINATIONS) {
    if (values[name] === '') continue;
    swept += 1;
    const problem = placeholderProblem(name, values[name]);
    if (problem !== null) placeholders.push(`${name} ${problem}`);
  }
  if (swept === 0) {
    // A sweep over an empty set must not pass.
    placeholders.push('every destination is empty, so this sweep examined nothing — that is not a pass');
  }
  record('no destination is a placeholder', placeholders, `${swept} destination(s) examined`);

  // 4. Well formed.
  const malformed = [];
  for (const name of SWEPT_DESTINATIONS) {
    const problem = wellFormedProblem(name, values[name]);
    if (problem !== null) malformed.push(`${name} ${problem}`);
  }
  record('every destination is well formed', malformed, `${swept} destination(s) parsed`);

  // 5. One destination for both tiers means every ticket wakes somebody.
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
  // The heartbeat repeats every `PRL_ALERT_HEARTBEAT_INTERVAL`, so on a human tier it gets the pager muted.
  const heartbeat = values.PRL_ALERT_HEARTBEAT_WEBHOOK_URL;
  for (const name of ['PRL_ALERT_PAGE_WEBHOOK_URL', 'PRL_ALERT_TICKET_WEBHOOK_URL']) {
    if (heartbeat !== '' && heartbeat === values[name]) {
      collisions.push(
        `PRL_ALERT_HEARTBEAT_WEBHOOK_URL and ${name} are both ${heartbeat}. The heartbeat fires ` +
          'forever and repeats every PRL_ALERT_HEARTBEAT_INTERVAL, so this destination would ' +
          'receive a notification about nothing every interval until somebody muted it',
      );
    }
  }
  record('the paging, ticket and heartbeat tiers are different destinations', collisions, 'all three differ');

  // 6. The alert body names instance, job, threshold and runbook, so it must not cross a network in
  // the clear. `alerts:verify` only warns, because its relay is a local sink.
  const cleartext = [];
  const relay = smarthostParts(values.PRL_ALERT_SMTP_SMARTHOST);
  if (relay.host !== null && !LOCAL_HOST.test(relay.host) && values.PRL_ALERT_SMTP_REQUIRE_TLS !== 'true') {
    cleartext.push(
      `PRL_ALERT_SMTP_REQUIRE_TLS is ${JSON.stringify(values.PRL_ALERT_SMTP_REQUIRE_TLS)} and the ` +
        `relay is ${values.PRL_ALERT_SMTP_SMARTHOST}, which is not on this host`,
    );
  }
  for (const name of [
    'PRL_ALERT_PAGE_WEBHOOK_URL',
    'PRL_ALERT_TICKET_WEBHOOK_URL',
    'PRL_ALERT_HEARTBEAT_WEBHOOK_URL',
  ]) {
    const value = values[name];
    if (value === '') continue;
    let url;
    try {
      url = new URL(value);
    } catch {
      continue;
    }
    if (url.protocol === 'http:' && !LOCAL_HOST.test(url.hostname)) {
      // A snitch's ping URL is its credential, so a cleartext one can be replayed to keep it alive.
      cleartext.push(
        name === 'PRL_ALERT_HEARTBEAT_WEBHOOK_URL'
          ? `${name} pings ${url.hostname} over plaintext http, and a snitch's ping URL is its ` +
              'credential — anyone who can read it can keep the switch alive after this deployment dies'
          : `${name} posts an alert body over plaintext http to ${url.hostname}`,
      );
    }
  }
  record('no alert body crosses a network in the clear', cleartext, 'TLS to every off-host destination');

  // 7. The password is checked only for presence and placeholder words. It is never printed.
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

  // 8. Both tiers resolve to a receiver with a destination.
  const routing = [];
  let rendered = null;
  try {
    rendered = renderAlertmanagerConfig(template, values);
  } catch (error) {
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

/**
 * SMTP multi-line replies put a hyphen after the code on every line but the last, so completion is
 * tested on that separator, or the reader hangs. Buffered data is delivered before a close, so a
 * `535` followed by a close reports the `535`.
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
  // latin1 and no `setEncoding`, because STARTTLS hands this socket to `tls.connect` and a decoder
  // would corrupt the TLS records.
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
    release: () => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
      return buffer;
    },
  };
}

const codeOf = (reply) => Number.parseInt(reply.slice(0, 3), 10);

const extensionsIn = (reply) =>
  reply
    .split('\r\n')
    .slice(1)
    .map((line) => line.slice(4).trim().toUpperCase())
    .filter((line) => line !== '');

/** RFC 6066 forbids an IP in `server_name`, so SNI is omitted for a literal address. */
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
    // `host` is required. Given an existing socket, `tls.connect` verifies against `localhost` by
    // default, which accepts the wrong certificate and rejects the right one.
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
 * TCP, TLS, `EHLO`, `AUTH`, `QUIT`. There is no `MAIL FROM`, `RCPT TO` or `DATA`, so it cannot
 * deliver a message. A `235` proves this relay accepts these credentials over verified TLS today,
 * and nothing about the recipient.
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
  // 465 is SMTPS. The override lets the test drive implicit TLS on an ephemeral port, since 465 needs root.
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
        // Detached before the upgrade, or this listener races the TLS layer for the ServerHello.
        wire.release();
        socket = await upgrade(socket, host, timeoutMs, ca);
        tls = 'starttls';
        const cipher = socket.getCipher?.() ?? null;
        steps.push(
          `STARTTLS negotiated, ${socket.getProtocol?.() ?? 'TLS'}${cipher === null ? '' : ` ${cipher.name}`}, ` +
            'certificate verified against the system trust store',
        );
        wire = attach(socket);
        // RFC 3207 requires a second EHLO after STARTTLS. AUTH is often offered only then.
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
      // Report the mechanism, never the credential. `AUTH PLAIN` carries the password in base64.
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
 * PLAIN first, as Go's `net/smtp` (Alertmanager's client) prefers it. LOGIN as the fallback. Other
 * mechanisms are skipped because `smtp_auth_password_file` does not configure them.
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

const username = (values) => values.PRL_ALERT_SMTP_USERNAME;

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
    // Not "passed" on its own. A skipped opt-in check must mark the summary line.
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
    // A green run says the destinations are real, not that a person wakes up.
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
        // Never the password. This record is attached to promotions.
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

#!/usr/bin/env node
/**
 * Sends a REAL page through this deployment's Alertmanager and refuses to exit 0
 * until somebody types back, at a terminal and within a bounded number of attempts,
 * a code that was carried in that page.
 *
 * This is what `pnpm run alerts:ack` does. It is a rehearsal with a pass/fail, and
 * it is meant to be run before go-live and after any change to the paging
 * destinations.
 *
 * ## The gap this exists for, stated exactly
 *
 * `docs/production/final-readiness-report.md` has carried the same sentence for
 * several candidates: *"a handshake proves a relay accepts credentials; it does not
 * prove a human wakes up."* That was true and it stayed true through everything
 * built around it. `alerts:verify` proves the pipeline — rule, route, both tiers,
 * both transports, a real SMTP transaction. `alerts:preflight` refuses a
 * destination a stranger's relay would not accept and blocks a promotion on it.
 * `--handshake` gets a `235` out of the real relay. Every one of those stops one
 * hop short of the only hop that matters, and the hop they stop short of is a
 * person.
 *
 * The gap is not a missing check. It is that no check can close it: from inside a
 * deployment, an email-to-SMS gateway decommissioned last year is byte-for-byte
 * indistinguishable from one somebody is holding. The only thing that can tell the
 * difference is the person, and the only way to ask them is to send something and
 * see whether they answer.
 *
 * ## What a pass proves — and the claim this file used to make and could not keep
 *
 * This file used to say the code "appears nowhere except in the delivered
 * notification", and `CLAUDE.md` repeated it. **That was false, and it is false for
 * a structural reason no amount of code here can fix.** The code travels as an alert
 * LABEL, and Alertmanager's `GET /api/v2/alerts` is unauthenticated and echoes
 * labels back. Measured against a genuine `prom/alertmanager:v0.28.1`:
 *
 *     $ curl -s http://127.0.0.1:19094/api/v2/alerts
 *     [{"annotations":{"summary":"TEST PAGE"},…,"labels":{"ack_code":"SENTINELACK7",
 *      "alertname":"OperatorTestPage","severity":"page"}}]
 *
 * So anyone who can reach the Alertmanager can read the code without ever seeing a
 * page — and the person running this command can always reach it, because they
 * chose the URL. Measured: an automated caller pointed `--alertmanager` at an
 * Alertmanager it controlled, read `ack_code` out of its own POST body, typed it
 * into a pty, and got `EXIT=0` with a record stamped `"attended": true`.
 *
 * There is no way to push a secret through Alertmanager to a receiver without
 * Alertmanager holding it, and no way to keep a secret from the process that mints
 * it. So the claim changed rather than the mechanism. **A pass proves: somebody was
 * at a terminal, inside a bounded window, and had a code this run generated and sent
 * as a `severity: page` alert through the Alertmanager this run named.** It does not
 * prove they read a page rather than the Alertmanager API. It is evidence a
 * cooperating operator produces for themselves; it is not an attestation that
 * survives a caller who wants a green result.
 *
 * What IS closed, because it could be:
 *
 *   * **The code is never printed by this command on the passing path.** It used to
 *     be: a networked rehearsal printed the delivered `Subject:` — which contains the
 *     code, by construction, because that is what the subject assertion is about —
 *     six lines above the sentence "the code is deliberately not on this screen".
 *     Measured: a robot scraped the code off this command's own stdout and typed it
 *     back. Subjects are now redacted before they are shown.
 *   * **The attempts are bounded.** There was no cap. Measured through a real pty:
 *     ~106,000 counted guesses per second, which is ~383 million inside `--within
 *     1h` against a 2^30 code space — better than a one-in-three chance of guessing
 *     it, with nobody reading anything. `MAX_ATTEMPTS` is 5.
 *   * **`rehearsal` is derived from where the page went**, not from this checkout's
 *     environment variables. See below.
 *
 * A pass is also not a promise about 3am next Tuesday. It says nothing about the
 * holiday nobody put in the rota, the phone that is face-down in another room, the
 * gateway that is decommissioned three months from now, or the second person who was
 * never on the test. An acknowledgement is a measurement of one moment.
 *
 * ## Why it goes through Alertmanager rather than sending its own mail
 *
 * Because the thing under test is the deployment's paging path, not SMTP. Posting to
 * `/api/v2/alerts` with `severity: page` exercises the real route tree, the real
 * receiver, the real credentials and the real destinations — every part of the
 * configuration that a promotion turns on. A script that opened its own SMTP session
 * would prove that this script can send mail.
 *
 * It deliberately does NOT go through Prometheus. `alerts:verify` already proves the
 * rule-evaluation half by stopping the API and following `ApiDown` for four minutes,
 * and repeating that here would make a command an operator is meant to run under
 * time pressure take four minutes before it could even ask the question.
 *
 * ## The rehearsal, and how it is decided now
 *
 * `rehearsal` used to be computed from three `PRL_ALERT_*` environment variables and
 * nothing else — which says what THIS CHECKOUT would render, and nothing whatever
 * about the Alertmanager the run is pointed at. Measured: a run with every variable
 * at its default printed *"this run pages NOBODY"* while posting to an Alertmanager
 * that would have delivered somewhere else entirely.
 *
 * It is now decided from evidence, in two stages, and both must hold:
 *
 *   1. **Read** — `GET /api/v2/status` on the targeted Alertmanager returns its own
 *      loaded configuration. Every email destination in it must be routed through
 *      this process's own SMTP sink, and every receiver must use only integrations
 *      this command can read (`webhook_configs`, `email_configs`). Anything it
 *      cannot read at all — a `url_file`, a PagerDuty or Opsgenie receiver, a status
 *      endpoint that does not answer — makes the run REAL. Fail closed: this test
 *      can refuse a rehearsal that was one, and must never bless a real page.
 *   2. **Observed** — the page must then actually arrive at this process's own
 *      webhook sink and its own SMTP sink, carrying THIS run's code. A rehearsal
 *      that cannot be seen arriving is not a rehearsal.
 *
 * One thing that cannot be established and is therefore said out loud rather than
 * assumed away: **Alertmanager redacts webhook URLs in its own API** — they come
 * back as `url: <secret>` — so this command cannot enumerate them and cannot prove
 * there is no second webhook destination beside its sink. The banner says that
 * instead of saying "pages NOBODY".
 *
 * `PRL_ALERT_ACK_UNATTENDED=1` is permitted only when both stages hold, which is how
 * this repository's own tests and release captures exercise the passing path. An
 * unattended run is stamped `attended: false` and prints a banner saying it is not a
 * rehearsal of the on-call arrangement, because a skip that is quiet is a pass.
 *
 * Usage:
 *     pnpm run alerts:ack
 *     pnpm run alerts:ack -- --within 10m --by ada@example.org --out ack.json
 *     pnpm run alerts:ack -- --alertmanager https://alertmanager.internal:9093
 *
 * Exit codes:
 *     0  a person acknowledged inside the window
 *     1  nobody did, the attempt limit was reached, or the alert could not be sent
 */

import { createHash, randomInt } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import {
  ALERT_DESTINATION_DEFAULTS,
  alertmanagerValues,
  durationMs,
  emailsFor,
  notificationsFor,
  startSink,
  startSmtpSink,
} from './alert-delivery.mjs';
import { bold, dim, green, measureUntil, red, yellow } from './drills/harness.mjs';

/**
 * The alert name a locked screen will show.
 *
 * Chosen to be unmistakable at a glance and impossible to confuse with an incident.
 * Somebody woken by this must know within one word that nothing is broken —
 * otherwise the rehearsal costs more than it proves, and the next one gets skipped.
 */
const ALERT_NAME = 'OperatorTestPage';

/**
 * The label the code travels in.
 *
 * A LABEL and not an annotation, and that is still the right call for the reason it
 * always was: Alertmanager's default subject template renders the common labels that
 * are not group labels, so a label puts the code in the `Subject:` line — the part
 * that shows on a locked screen without unlocking it. An annotation would put it in
 * the body, which is one more action away at the exact moment somebody is least
 * willing to take one. It also makes each run a distinct alert, because labels are
 * an alert's identity, and two rehearsals half an hour apart must not deduplicate
 * into one notification.
 *
 * What it is NOT is a secret channel. Alertmanager echoes labels back on an
 * unauthenticated `GET /api/v2/alerts`; an annotation would be echoed there too.
 * See the header: the code being readable from the Alertmanager is a property of
 * Alertmanager, not a choice made here, and it is disclosed rather than papered over.
 */
const CODE_LABEL = 'ack_code';

/**
 * The alphabet, and the four characters that are not in it.
 *
 * No `I`, `O`, `0` or `1`. The code is read off a phone screen, at night, by somebody
 * who has just been woken, and typed into a terminal — and a rehearsal that fails
 * because a zero was read as an O has measured the font rather than the on-call
 * arrangement. `normaliseCode` forgives spacing and case; it cannot forgive an
 * ambiguous glyph, so the ambiguity is removed at the source.
 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * How many wrong codes end the run.
 *
 * There was no limit, and a six-character code out of a 32-character alphabet is
 * about thirty bits — which sounds like plenty until somebody measures how fast a
 * terminal can be typed into by something that is not a person. Measured, through a
 * real pty, against this command with no cap:
 *
 *     [driver] window --within 1h; drove guesses for 8.0s through a real pty
 *     [driver] the command counted 852123 wrong attempts and never stopped accepting them
 *     [driver] ~106,450 counted guesses/s -> 383,221,393 in a --within 1h window
 *
 * 383 million guesses against 2^30 possibilities is a better-than-one-in-three
 * chance of a green acknowledgement with nobody reading anything at all. Five is
 * generous for the case this exists to be kind to — the person this is meant to
 * prove was reached, mistyping a code off a phone screen at night — and it takes the
 * guessing attack from "a third of the time" to about one in two hundred million.
 */
export const MAX_ATTEMPTS = 5;

/** A fresh single-use code. Six characters of this alphabet is about thirty bits. */
export function makeCode(length = 6, pick = (bound) => randomInt(bound)) {
  let code = '';
  for (let index = 0; index < length; index += 1) code += ALPHABET[pick(ALPHABET.length)];
  return code;
}

/**
 * What two people typing the same code can disagree about, removed.
 *
 * Case, spaces and any punctuation somebody adds while transcribing — a hyphen in the
 * middle is the common one. Nothing else: this must not be so forgiving that a
 * DIFFERENT code matches, which is why it strips rather than fuzzily compares.
 */
export const normaliseCode = (text) =>
  String(text ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

/** The code, replaced by dots, wherever it appears in something about to be printed. */
export const redactCode = (text, code) =>
  String(text ?? '')
    .split(code)
    .join('·'.repeat(code.length));

/**
 * Waits for the code to be typed, or for the window to close, or for the attempts to
 * run out.
 *
 * Taking the input stream as a parameter rather than reaching for `process.stdin` is
 * what makes the failure path testable: `alert-ack-page.test.mjs` drives this with a
 * stream that stays silent and asserts that it FAILS, which is the one behaviour of
 * this whole file that must never regress. A command that passes when nobody answers
 * is worse than no command, because it produces a record saying somebody did.
 *
 * A wrong code does not end the run immediately — the realistic wrong-code case is a
 * transcription slip by exactly the person this is meant to prove was reached, and
 * failing them on a typo measures nothing — but there are only `maxAttempts` of them.
 * See MAX_ATTEMPTS for the measurement that put a number there.
 *
 * @param {{input: NodeJS.ReadableStream, expected: string, deadlineMs: number,
 *          maxAttempts?: number, onAttempt?: (typed: string, attempts: number) => void}} options
 * @returns {Promise<{ok: boolean, attempts: number, elapsedMs: number, reason?: string}>}
 */
export async function awaitAcknowledgement({
  input,
  expected,
  deadlineMs,
  maxAttempts = MAX_ATTEMPTS,
  onAttempt = () => {
    // A caller that does not want to be told about wrong attempts. The default is a
    // no-op rather than a console write so that the test can count attempts without
    // printing a wall of red into a passing run.
  },
}) {
  const wanted = normaliseCode(expected);
  if (wanted === '') {
    // An empty expectation matches the first blank line, which would turn this whole
    // command into a green light nobody earned.
    throw new Error('awaitAcknowledgement: the expected code is empty');
  }
  const startedAt = Date.now();
  const reader = createInterface({ input });
  let attempts = 0;
  let timer = null;
  try {
    const expired = new Promise((resolve) => {
      timer = setTimeout(
        () => resolve({ ok: false, reason: 'nobody acknowledged inside the window' }),
        deadlineMs,
      );
    });
    const typed = (async () => {
      for await (const line of reader) {
        attempts += 1;
        if (normaliseCode(line) === wanted) return { ok: true };
        onAttempt(line, attempts);
        if (attempts >= maxAttempts) {
          return {
            ok: false,
            reason: `the attempt limit was reached — ${maxAttempts} wrong codes and the window closed`,
          };
        }
      }
      // Reached when stdin closes — a pipe that ran dry, or `< /dev/null`. Not an
      // acknowledgement, and it must not read as one.
      return { ok: false, reason: 'the input ended without a matching code' };
    })();
    const outcome = await Promise.race([typed, expired]);
    return { ...outcome, attempts, elapsedMs: Date.now() - startedAt };
  } finally {
    if (timer !== null) clearTimeout(timer);
    reader.close();
  }
}

/** The code carried by a webhook notification for this alert, or null. */
export function codeInNotification(payload) {
  for (const alert of payload?.alerts ?? []) {
    const code = alert?.labels?.[CODE_LABEL];
    if (alert?.labels?.alertname === ALERT_NAME && typeof code === 'string' && code !== '') return code;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Where the page actually goes
// ---------------------------------------------------------------------------

/**
 * The two ports this process's own sinks listen on, read off the rehearsal defaults.
 *
 * Derived rather than repeated, because the defaults ARE the sinks: `alert-delivery.mjs`
 * points the rehearsal at `host.docker.internal:9099` and `…:9098` and starts servers
 * there. A second copy of those numbers here would be a second thing to keep in step,
 * and the failure mode of it drifting is a run that calls a real destination a sink.
 */
export const SINK_WEBHOOK_PORT = new URL(ALERT_DESTINATION_DEFAULTS.PRL_ALERT_PAGE_WEBHOOK_URL).port;
export const SINK_SMTP_PORT = ALERT_DESTINATION_DEFAULTS.PRL_ALERT_SMTP_SMARTHOST.split(':').pop();

/**
 * Host names that mean "the machine this command is running on".
 *
 * `host.docker.internal` is in the list because that is how a container reaches back
 * out to this process, and `host-gateway` is the compose spelling of the same idea.
 */
const LOCAL_HOSTS = new Set([
  '127.0.0.1',
  'localhost',
  '::1',
  '[::1]',
  'host.docker.internal',
  'host-gateway',
]);

/** Does this `host:port` name this process's own SMTP sink? */
export function isLocalSmtpSink(smarthost) {
  const text = String(smarthost ?? '').replace(/^['"]|['"]$/g, '');
  const at = text.lastIndexOf(':');
  if (at === -1) return false;
  return LOCAL_HOSTS.has(text.slice(0, at)) && text.slice(at + 1) === SINK_SMTP_PORT;
}

/** Does this URL name this process's own webhook sink? */
export function isLocalWebhookSink(url) {
  try {
    const parsed = new URL(String(url ?? '').replace(/^['"]|['"]$/g, ''));
    return LOCAL_HOSTS.has(parsed.hostname) && parsed.port === SINK_WEBHOOK_PORT;
  } catch {
    return false;
  }
}

/**
 * Receiver integrations this command knows how to read a destination out of.
 *
 * Everything else — `pagerduty_configs`, `opsgenie_configs`, `slack_configs`, the
 * dozen others Alertmanager ships — sends somewhere this cannot inspect, and their
 * destination is frequently a compiled-in vendor URL that does not appear in the
 * config at all. A receiver this cannot read is a run that must be treated as real.
 */
export const READABLE_INTEGRATIONS = new Set(['webhook_configs', 'email_configs']);

/**
 * Every destination in an Alertmanager's OWN loaded configuration.
 *
 * Read from `GET /api/v2/status`, which returns the config Alertmanager actually
 * parsed — not this checkout's environment, and not the template this repository
 * would have rendered. That distinction is the whole point: `--alertmanager` is a
 * caller-supplied URL and a run pointed at a different Alertmanager used to print a
 * banner describing destinations that Alertmanager had never heard of.
 *
 * One field comes back useless and it is the important one. Alertmanager marshals a
 * webhook URL as `url: <secret>`, so the webhook destinations can be COUNTED and not
 * READ. Measured against `prom/alertmanager:v0.28.1` with a plain local URL in the
 * file:
 *
 *     webhook_configs:
 *     - send_resolved: true
 *       url: <secret>
 *       url_file: ""
 *
 * So `webhooks` below is a count and a list of what could be read, `redactedWebhooks`
 * is how many could not, and nothing downstream is allowed to conclude "there is no
 * other webhook" from either.
 */
export function alertmanagerDestinations(configText) {
  const integrations = new Set();
  const smarthosts = new Set();
  const recipients = new Set();
  const webhooks = [];
  let redactedWebhooks = 0;
  let webhookFiles = 0;
  for (const line of String(configText ?? '').split('\n')) {
    const integration = /^\s*-?\s*([a-z0-9]+_configs):\s*$/.exec(line);
    if (integration !== null) integrations.add(integration[1]);
    const smarthost = /^\s*-?\s*(?:smtp_smarthost|smarthost):\s*(\S+)\s*$/.exec(line);
    if (smarthost !== null) smarthosts.add(smarthost[1].replace(/^['"]|['"]$/g, ''));
    const recipient = /^\s*-?\s*to:\s*(\S+)\s*$/.exec(line);
    if (recipient !== null) recipients.add(recipient[1].replace(/^['"]|['"]$/g, ''));
    const file = /^\s*-?\s*url_file:\s*(\S+)\s*$/.exec(line);
    if (file !== null && file[1].replace(/^['"]|['"]$/g, '') !== '') webhookFiles += 1;
    const url = /^\s*-?\s*url:\s*(\S+)\s*$/.exec(line);
    if (url === null) continue;
    const value = url[1].replace(/^['"]|['"]$/g, '');
    if (value === '<secret>') redactedWebhooks += 1;
    else webhooks.push(value);
  }
  return { integrations, smarthosts, recipients, webhooks, redactedWebhooks, webhookFiles };
}

/**
 * Could this run be a rehearsal — as far as the targeted Alertmanager's own
 * configuration can say?
 *
 * Stage one of two; see the header. It answers "is there anything here that a page
 * could reach that is not one of this process's sinks", and every unknown counts as
 * yes. Stage two is observing the page arrive, and `rehearsal` requires both.
 *
 * @returns {{sinkOnly: boolean, reasons: string[], destinations: object}}
 */
export function rehearsalCandidate(configText) {
  const destinations = alertmanagerDestinations(configText);
  const reasons = [];
  if (String(configText ?? '').trim() === '') {
    reasons.push('the Alertmanager did not report a configuration, so nothing about it could be read');
    return { sinkOnly: false, reasons, destinations };
  }
  for (const integration of destinations.integrations) {
    if (!READABLE_INTEGRATIONS.has(integration)) {
      reasons.push(`a receiver uses ${integration}, whose destination this command cannot read`);
    }
  }
  for (const smarthost of destinations.smarthosts) {
    if (!isLocalSmtpSink(smarthost))
      reasons.push(`mail is relayed through ${smarthost}, which is not this process's SMTP sink`);
  }
  for (const url of destinations.webhooks) {
    if (!isLocalWebhookSink(url))
      reasons.push(`a webhook points at ${url}, which is not this process's sink`);
  }
  if (destinations.webhookFiles > 0) {
    reasons.push(
      `${destinations.webhookFiles} webhook destination(s) come from a url_file this command cannot read`,
    );
  }
  if (destinations.recipients.size === 0) {
    // Nothing readable pins the delivery. The email half is the only half whose
    // destination Alertmanager will actually disclose, so a config with no email
    // destination at all leaves this command with no evidence to reason from — and
    // no evidence means real.
    reasons.push(
      'no email destination is configured, and the email half is the only one Alertmanager discloses',
    );
  }
  return { sinkOnly: reasons.length === 0, reasons, destinations };
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

const flag = (name, fallback = null) => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : (process.argv[at + 1] ?? fallback);
};

const alertmanagerFrom = process.argv.includes('--alertmanager')
  ? 'the --alertmanager flag'
  : process.env.PRL_ALERT_ACK_ALERTMANAGER !== undefined
    ? 'PRL_ALERT_ACK_ALERTMANAGER'
    : 'the default';

const options = {
  within: flag('within', '5m'),
  by: flag('by', process.env.USER ?? 'an unnamed operator'),
  out: flag('out'),
  alertmanager: (
    flag('alertmanager') ??
    process.env.PRL_ALERT_ACK_ALERTMANAGER ??
    `http://127.0.0.1:${process.env.PRL_STAGING_ALERTMANAGER_PORT ?? 9093}`
  ).replace(/\/$/, ''),
  json: process.argv.includes('--json'),
  unattended: /^(?:1|true|yes|on)$/i.test(process.env.PRL_ALERT_ACK_UNATTENDED ?? ''),
};

const say = (text) => console.log(text);
const tick = (name, detail) =>
  say(`  ${green('✓')} ${name}${detail === undefined ? '' : dim(` — ${detail}`)}`);
const cross = (name, detail) => say(`  ${red('✗')} ${name}${detail === undefined ? '' : ` — ${detail}`}`);
const note = (text) => say(`  ${dim('·')} ${text}`);

const asDuration = (ms) => {
  const seconds = Math.round(ms / 1000);
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
};

// ---------------------------------------------------------------------------
// Alertmanager
// ---------------------------------------------------------------------------

/**
 * The configuration the targeted Alertmanager is actually running, and a digest of it.
 *
 * The digest goes in the record. A record that names an Alertmanager URL says where
 * the run was pointed; a record that also carries the sha256 of that Alertmanager's
 * own config says what was there at the time, and two runs a month apart can be
 * compared without trusting anybody's memory of what the destinations were.
 */
async function readAlertmanagerConfig(base) {
  const response = await fetch(`${base}/api/v2/status`, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`${base}/api/v2/status answered ${response.status}`);
  const status = await response.json();
  const original = status?.config?.original ?? '';
  return { text: original, sha256: createHash('sha256').update(original).digest('hex') };
}

/**
 * Posts the alert, or the same alert with `endsAt` in the past to resolve it.
 *
 * The resolve half is not tidiness. This alert is `severity: page`, so while it is
 * active it is an open incident in whatever the deployment pages with, and a
 * rehearsal that leaves one behind is a rehearsal people stop agreeing to run.
 */
async function postAlert(base, { code, endsAt, startsAt }) {
  const response = await fetch(`${base}/api/v2/alerts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify([
      {
        labels: { alertname: ALERT_NAME, severity: 'page', [CODE_LABEL]: code },
        annotations: {
          summary: `TEST PAGE — nothing is broken. Acknowledge with the code ${code}.`,
          description:
            "A rehearsal of this deployment's paging path, started by hand with `pnpm run " +
            'alerts:ack`. Somebody is sitting at a terminal waiting for this code to be typed ' +
            'back. There is no incident and no action to take beyond that. If you were not ' +
            'expecting this, say so in the team channel — an unexpected test page is worth ' +
            'asking about.',
          runbook: 'docs/production/alerts.md#the-acknowledged-test-page',
        },
        startsAt,
        endsAt,
      },
    ]),
  });
  if (!response.ok) throw new Error(`${base}/api/v2/alerts answered ${response.status}`);
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

async function main() {
  say(bold('\nPoker Risk Lab — acknowledged test page'));
  say(
    dim(
      "  Sends a REAL page through this deployment's Alertmanager, then waits for a person to\n" +
        '  type back a code carried in it. The code is not printed by this command.\n',
    ),
  );

  const deadlineMs = durationMs(options.within);
  if (deadlineMs === null || deadlineMs < 1_000) {
    cross('--within is not a duration', `${JSON.stringify(options.within)} — try 5m, 90s, 1h`);
    return 1;
  }

  // Stage one: read the Alertmanager's own configuration, before anything is sent.
  // Where a page goes is a property of THAT, and of nothing in this checkout.
  let configured = { text: '', sha256: null };
  let unreadable = null;
  try {
    configured = await readAlertmanagerConfig(options.alertmanager);
  } catch (error) {
    unreadable = error.message;
  }
  const candidate = rehearsalCandidate(unreadable === null ? configured.text : '');
  const { values, overridden } = alertmanagerValues();

  say(bold('What this run will page'));
  note(`alertmanager   ${options.alertmanager}  ${dim(`(from ${alertmanagerFrom})`)}`);
  note(`routed as      severity=page → whatever this Alertmanager's paging receiver is`);
  if (unreadable !== null) {
    note(yellow(`config         could not be read: ${unreadable}`));
  } else {
    note(`config sha256  ${configured.sha256.slice(0, 16)}…  ${dim('(read from GET /api/v2/status)')}`);
    note(
      `mail relay     ${[...candidate.destinations.smarthosts].join(', ') || '(none)'} → ${[...candidate.destinations.recipients].join(', ') || '(no recipient)'}`,
    );
    note(
      `webhooks       ${candidate.destinations.webhooks.length + candidate.destinations.redactedWebhooks} destination(s), of which ${candidate.destinations.redactedWebhooks} redacted by Alertmanager as \`<secret>\``,
    );
  }
  note(`window         ${asDuration(deadlineMs)}, at most ${MAX_ATTEMPTS} attempts`);
  if (candidate.sinkOnly) {
    note(
      yellow(
        "every destination this Alertmanager will disclose is this process's own sink, so this looks like",
      ),
    );
    note(yellow('a rehearsal. It is not confirmed until the page is seen arriving at those sinks.'));
    note(dim('Alertmanager redacts webhook URLs in its own API, so this command cannot prove there'));
    note(dim('is no other webhook destination beside its sink. It does not claim to.'));
  } else {
    say(`  ${green('·')} this run pages a REAL destination. Why this is not a rehearsal:`);
    for (const reason of candidate.reasons) note(`  ${reason}`);
    if (overridden.length > 0) {
      note(
        dim(
          `(this checkout also has ${overridden.length} PRL_ALERT_* override(s), which decide nothing here)`,
        ),
      );
    }
  }

  if (options.unattended && !candidate.sinkOnly) {
    // The fence, and it now stands on what the Alertmanager said rather than on what
    // this checkout's environment says. There is no supported way to produce a green
    // acknowledgement against a configured pager without a person.
    say('');
    cross(
      'PRL_ALERT_ACK_UNATTENDED is set and this Alertmanager can reach a destination that is not a sink',
      'unattended acknowledgement exists so that this repository can test its own passing path ' +
        'against its own sinks. Anywhere else it would be a record saying a person was reached when ' +
        'none was. Unset it and run this at a terminal.',
    );
    return 1;
  }
  if (!options.unattended && !process.stdin.isTTY) {
    say('');
    cross(
      'stdin is not a terminal',
      'the acknowledgement has to come from a person at a keyboard; a pipe is a script. Run this ' +
        'in a terminal. (For rehearsing the mechanism against the local sinks alone, ' +
        'PRL_ALERT_ACK_UNATTENDED=1 reads the code out of the delivered notification and stamps ' +
        'the record attended: false.)',
    );
    return 1;
  }

  let sink = null;
  let mail = null;
  if (candidate.sinkOnly) {
    try {
      sink = await startSink();
      mail = await startSmtpSink();
    } catch (error) {
      sink?.close();
      say('');
      cross('a rehearsal sink could not listen', error.message);
      note('an `alerts:verify` run is probably still holding 9099/9098. Wait for it, or free them.');
      return 1;
    }
  }

  const code = makeCode();
  const sentAt = new Date();
  // Half an hour, and then explicitly resolved in the `finally`. Long enough that the
  // alert cannot self-resolve out from under a long window (Alertmanager expires an
  // alert with no `endsAt` after `resolve_timeout`, which is a minute here), short
  // enough that a run killed with SIGKILL leaves an incident that closes itself.
  const endsAt = new Date(sentAt.getTime() + 30 * 60_000);

  /** Stage two: was the page SEEN arriving at this process's own two sinks? */
  const observed = { webhook: false, mail: false };
  let outcome = { ok: false, attempts: 0, elapsedMs: 0, reason: 'the page was never sent' };
  try {
    say(bold('\nSending'));
    try {
      await postAlert(options.alertmanager, {
        code,
        startsAt: sentAt.toISOString(),
        endsAt: endsAt.toISOString(),
      });
    } catch (error) {
      cross('Alertmanager accepted the alert', error.message);
      note('is the overlay up? `pnpm run alerts:verify -- --keep-up`, or point --alertmanager at');
      note("the deployment's own Alertmanager. Nothing was sent, so nobody was paged.");
      return 1;
    }
    tick('Alertmanager accepted the alert', `${ALERT_NAME}, severity=page, code in the ${CODE_LABEL} label`);

    if (sink !== null) {
      /**
       * The delivery is observed rather than assumed, and this is what makes both the
       * rehearsal classification and an unattended run mean anything: the code that
       * unlocks the command is READ OUT OF what was actually delivered, and the
       * "rehearsal" stamp is only earned by the page being seen at this process's own
       * sinks. If the page never arrived, there is no code to read and the run fails
       * on the same clock a person would have failed on.
       */
      const delivered = await measureUntil(
        () => notificationsFor(sink.received, '/page', ALERT_NAME, 'firing').length > 0,
        Math.min(deadlineMs, 60_000),
        500,
      );
      if (delivered === null) {
        cross('the page reached this process’s own webhook sink', 'nothing arrived on /page');
      } else {
        observed.webhook = true;
        tick(
          'the page reached this process’s own webhook sink',
          `on /page, ${(delivered / 1000).toFixed(0)}s later`,
        );
      }
      const mailed = await measureUntil(
        () => emailsFor(mail.received, values.PRL_ALERT_PAGE_EMAIL_TO, ALERT_NAME, 'firing').length > 0,
        Math.min(deadlineMs, 60_000),
        500,
      );
      if (mailed === null) {
        cross('and over SMTP, with the code in the subject', 'no message reached the paging address');
      } else {
        const [message] = emailsFor(mail.received, values.PRL_ALERT_PAGE_EMAIL_TO, ALERT_NAME, 'firing');
        const subject = message.headers.get('subject') ?? '';
        // The subject is the assertion, not the delivery. A locked screen shows the
        // subject and nothing else, so a code that is only in the body is a code
        // somebody has to unlock a phone to read at 3am.
        //
        // It is REDACTED before it is printed. This line used to print the subject
        // verbatim — which contains the code, necessarily, because that is what is
        // being asserted — six lines above the promise that the code is not on this
        // screen. Measured: a robot scraped it off this command's own stdout and
        // typed it back for a green result.
        if (subject.includes(code)) {
          observed.mail = true;
          tick('and over SMTP, with the code in the subject', redactCode(subject, code));
        } else {
          cross(
            'and over SMTP, with the code in the subject',
            `the code is not in ${JSON.stringify(redactCode(subject, code))}`,
          );
        }
      }
    }

    say(bold('\nAcknowledgement'));
    if (options.unattended) {
      if (!(observed.webhook && observed.mail)) {
        cross(
          'this run cannot be treated as a rehearsal',
          'PRL_ALERT_ACK_UNATTENDED is only honoured when the page is SEEN arriving at this process’s ' +
            'own webhook and SMTP sinks. It was not, so where it went is unknown, and an unattended ' +
            'green against an unknown destination is the record this fence exists to prevent.',
        );
        outcome = {
          ok: false,
          attempts: 0,
          elapsedMs: 0,
          reason: 'the page was not observed reaching the sinks',
        };
      } else {
        say(yellow('  ⚠ PRL_ALERT_ACK_UNATTENDED — the code is being read out of the delivered'));
        say(yellow('    notification instead of off a keyboard. NO PERSON WAS INVOLVED in this run,'));
        say(yellow('    it is stamped attended: false, and it must not be quoted as a rehearsal.'));
        const arrived = notificationsFor(sink?.received ?? [], '/page', ALERT_NAME, 'firing')
          .map((entry) => codeInNotification(entry.payload))
          .find((found) => found !== null);
        outcome =
          arrived === undefined
            ? { ok: false, attempts: 0, elapsedMs: 0, reason: 'no delivered notification carried a code' }
            : { ok: normaliseCode(arrived) === normaliseCode(code), attempts: 1, elapsedMs: 0 };
        if (outcome.ok) tick('the delivered notification carried the code that was sent', '******');
        else
          cross('the delivered notification carried the code that was sent', outcome.reason ?? 'it did not');
      }
    } else {
      note(`the code is in the page, and not on this screen: ${'*'.repeat(code.length)}`);
      say(
        `\n  Type the code from the page and press enter — ${asDuration(deadlineMs)}, ${MAX_ATTEMPTS} attempts.\n`,
      );
      outcome = await awaitAcknowledgement({
        input: process.stdin,
        expected: code,
        deadlineMs,
        onAttempt: (typed, attempts) =>
          say(
            red(
              `  ✗ ${JSON.stringify(typed.trim())} is not the code (attempt ${attempts} of ${MAX_ATTEMPTS})`,
            ),
          ),
      });
    }
  } finally {
    // Resolve whatever happened, including on the failure path: a rehearsal that
    // leaves an open page behind is a rehearsal that gets refused next time.
    await postAlert(options.alertmanager, {
      code,
      startsAt: sentAt.toISOString(),
      endsAt: new Date().toISOString(),
    }).catch(() => {
      note(yellow('the test alert could not be resolved; it expires on its own within 30 minutes'));
    });
    sink?.close();
    mail?.close();
    process.stdin.pause();
  }

  const rehearsal = candidate.sinkOnly && observed.webhook && observed.mail;
  const record = {
    schema: 'prl.alert-ack.v2',
    alertname: ALERT_NAME,
    code,
    by: options.by,
    attended: !options.unattended,
    /**
     * Measured, not configured. True only when the targeted Alertmanager's own
     * configuration disclosed nothing but this process's sinks AND the page was seen
     * arriving at both of them.
     */
    rehearsal,
    rehearsalBasis: rehearsal
      ? [
          "every destination the Alertmanager disclosed is this process's own sink",
          'the page was observed arriving at the webhook sink and the SMTP sink with this run’s code',
        ]
      : candidate.reasons.concat(
          candidate.sinkOnly && !(observed.webhook && observed.mail)
            ? ['the page was not observed arriving at both of this process’s sinks']
            : [],
        ),
    alertmanager: options.alertmanager,
    alertmanagerFrom,
    alertmanagerConfigSha256: configured.sha256,
    /** What the Alertmanager itself disclosed. Webhook URLs come back as `<secret>`. */
    disclosedDestinations: {
      smarthosts: [...candidate.destinations.smarthosts],
      recipients: [...candidate.destinations.recipients],
      readableWebhooks: candidate.destinations.webhooks,
      redactedWebhooks: candidate.destinations.redactedWebhooks,
      integrations: [...candidate.destinations.integrations],
    },
    /** What this checkout's environment WOULD render. It decides nothing here. */
    localEnvironmentWouldRender: {
      webhook: values.PRL_ALERT_PAGE_WEBHOOK_URL,
      email: values.PRL_ALERT_PAGE_EMAIL_TO,
      smarthost: values.PRL_ALERT_SMTP_SMARTHOST,
    },
    windowMs: deadlineMs,
    maxAttempts: MAX_ATTEMPTS,
    sentAt: sentAt.toISOString(),
    acknowledgedAt: outcome.ok ? new Date().toISOString() : null,
    elapsedMs: outcome.elapsedMs,
    attempts: outcome.attempts,
    ok: outcome.ok,
    /**
     * In the record, because a record gets quoted long after the terminal output is
     * gone, and this is the sentence that stops it being quoted as more than it is.
     */
    caveat:
      'The code travels as an alert label and Alertmanager echoes labels back on an unauthenticated ' +
      'GET /api/v2/alerts, so a caller who chose the --alertmanager URL could read this code without ' +
      'seeing a page. A pass is evidence a cooperating operator produced for themselves; it is not ' +
      'proof against a caller who wanted a green result.',
  };

  say('');
  if (outcome.ok && options.unattended) {
    // A different paragraph, not the same one with a caveat bolted on. An unattended
    // run establishes that the pipeline carries a code intact to a receiver, and
    // NOTHING about a person — and the claim it does not make must not be printed
    // above the disclaimer, where it is the sentence that gets quoted.
    say(yellow(bold('ACK REHEARSED — the mechanism works. NO PERSON WAS INVOLVED.')));
    say(
      dim(
        '\n  What this proves: the code generated here reached a receiver, in the subject line and\n' +
          "  in the payload, over this deployment's real route tree — and that the command unlocks\n" +
          '  on that code and on no other. It is stamped attended: false.\n' +
          '\n  What it does NOT prove: that anybody read anything. Nobody was paged; every\n' +
          '  destination this Alertmanager disclosed was a sink this process started, and the page\n' +
          '  was seen arriving at both of them. This run must not be quoted as a rehearsal of the\n' +
          '  on-call arrangement. Run it attended, at a terminal, against the deployment’s own\n' +
          '  Alertmanager, for the claim that matters.\n',
      ),
    );
  } else if (outcome.ok) {
    say(green(bold(`ACK PASSED — acknowledged by ${options.by} after ${asDuration(outcome.elapsedMs)}`)));
    say(
      dim(
        '\n  What this proves: somebody was at this terminal, inside the window and inside ' +
          `${MAX_ATTEMPTS} attempts,\n` +
          '  and had a code this run generated and sent as a severity=page alert through the\n' +
          `  Alertmanager at ${options.alertmanager}. That is a fact with a timestamp, and it is recorded.\n` +
          '\n  What it does NOT prove: that they read a PAGE. Alertmanager echoes alert labels back on\n' +
          '  an unauthenticated GET /api/v2/alerts, so the code was also readable from the\n' +
          '  Alertmanager this run was pointed at — which the caller chose. This is evidence a\n' +
          '  cooperating operator produces for themselves, not proof against a hostile one.\n' +
          '\n  And nothing about 3am next Tuesday: not the holiday nobody put in the rota, not the\n' +
          '  phone face-down in another room, not the gateway decommissioned three months from now,\n' +
          '  and not the second person who was never on this test. Run it again whenever the\n' +
          '  destinations change, and keep the rota somewhere that is not this repository.\n',
      ),
    );
  } else {
    say(red(bold(`ACK FAILED — ${outcome.reason ?? 'nobody acknowledged'}`)));
    say(
      dim(
        `\n  The code sent was ${code}. It is printed now, and only now, because the useful\n` +
          '  question after a failure is whether the page arrived at all and arrived intact — and\n' +
          '  because this code is spent: the next run mints a new one.\n' +
          '\n  Three things this distinguishes between, and they have different fixes:\n' +
          '    · the page never arrived            → alerts:preflight -- --handshake, then the\n' +
          "                                          provider's own delivery log\n" +
          '    · it arrived and nobody saw it      → the destination is not a device anybody\n' +
          '                                          watches. This is the failure worth finding.\n' +
          '    · it arrived and nobody answered    → the rota, not the pipeline\n' +
          '\n  This is a go-live blocker. A paging path nobody answered in ' +
          `${asDuration(deadlineMs)} is not a paging path.\n`,
      ),
    );
  }

  if (options.out !== null || options.json) {
    const text = `${JSON.stringify(record, null, 2)}\n`;
    if (options.out !== null) writeFileSync(options.out, text);
    if (options.json) say(text);
  }
  return outcome.ok ? 0 : 1;
}

if (import.meta.main) {
  process.exitCode = await main();
}

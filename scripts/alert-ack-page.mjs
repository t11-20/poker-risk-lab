#!/usr/bin/env node
/**
 * `pnpm run alerts:ack`: sends a real `severity: page` alert through this deployment's Alertmanager
 * and exits 0 only if somebody types back, at a terminal and within MAX_ATTEMPTS tries, a code
 * carried in that page. `alerts:verify` proves the pipeline and `--handshake` the relay's
 * credentials, but neither proves a person is reached.
 *
 * What a pass proves. The code travels as an alert label, and Alertmanager's unauthenticated
 * `GET /api/v2/alerts` echoes labels back (measured against `prom/alertmanager:v0.28.1`). The caller
 * also chooses `--alertmanager`, so an automated caller can read the code out of its own POST, type
 * it into a pty and get exit 0. A pass is evidence a cooperating operator produces for themselves.
 * It is not an attestation that survives a caller who wants a green result.
 *
 * What is closed:
 *   * The code is never printed on the passing path, and delivered subjects are redacted, so a
 *     robot cannot scrape it off this command's own stdout.
 *   * Attempts are capped. Uncapped, a pty drove ~106,000 guesses/s, ~383 million inside
 *     `--within 1h` against a 2^30 code space.
 *   * `rehearsal` is decided from where the page went, never from `PRL_ALERT_*`, which only say
 *     what this checkout would render. Both stages must hold.
 *     1. Read. `GET /api/v2/status` returns the target's loaded config. Every email destination must
 *        be this process's SMTP sink and every receiver must use only `webhook_configs` or
 *        `email_configs`. Anything unreadable makes the run real. Fail closed.
 *     2. Observed. The page must arrive at this process's own webhook and SMTP sinks with this
 *        run's code.
 *   Alertmanager redacts webhook URLs as `<secret>`, so a second webhook beside the sink cannot be
 *   ruled out. The banner says so.
 *
 * It posts to Alertmanager rather than sending its own mail, so the real route tree, receiver and
 * credentials are under test. It skips Prometheus because `alerts:verify` already proves rule
 * evaluation and that takes four minutes.
 *
 * `PRL_ALERT_ACK_UNATTENDED=1` is allowed only when both rehearsal stages hold. Such a run is
 * stamped `attended: false` and says so in a banner.
 *
 * Flags (no --help): --within <duration> (default 5m), --by <name>, --out <file>, --alertmanager <url>.
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

/** Unmistakable on a locked screen, so somebody woken by it knows nothing is broken. */
const ALERT_NAME = 'OperatorTestPage';

/**
 * A label, not an annotation, so the default subject template puts the code in the `Subject:`
 * line a locked screen shows. Labels are also an alert's identity, so two runs never deduplicate.
 * It is not secret. See the header.
 */
const CODE_LABEL = 'ack_code';

/** No `I`, `O`, `0` or `1`. The code is read off a phone at night and must not be misread. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * Six characters of this alphabet is about 30 bits. Uncapped, a pty drove ~106,450 guesses/s, which
 * is ~383 million in a 1h window and a better than one-in-three chance. Five allows for typos and
 * cuts the guessing odds to about one in two hundred million.
 */
export const MAX_ATTEMPTS = 5;

export function makeCode(length = 6, pick = (bound) => randomInt(bound)) {
  let code = '';
  for (let index = 0; index < length; index += 1) code += ALPHABET[pick(ALPHABET.length)];
  return code;
}

/** Strips case, spaces and punctuation, never fuzzily compares, so a different code never matches. */
export const normaliseCode = (text) =>
  String(text ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

export const redactCode = (text, code) =>
  String(text ?? '')
    .split(code)
    .join('·'.repeat(code.length));

/**
 * Resolves when the code is typed, the window closes or the attempts run out. The input stream is a
 * parameter so `alert-ack-page.test.mjs` can drive it with silence and assert that it FAILS.
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
    // A no-op, so the test can count attempts without printing into a passing run.
  },
}) {
  const wanted = normaliseCode(expected);
  if (wanted === '') {
    // An empty expectation would match the first blank line.
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
      // stdin closed, from a dry pipe or `< /dev/null`. That is not an acknowledgement.
      return { ok: false, reason: 'the input ended without a matching code' };
    })();
    const outcome = await Promise.race([typed, expired]);
    return { ...outcome, attempts, elapsedMs: Date.now() - startedAt };
  } finally {
    if (timer !== null) clearTimeout(timer);
    reader.close();
  }
}

export function codeInNotification(payload) {
  for (const alert of payload?.alerts ?? []) {
    const code = alert?.labels?.[CODE_LABEL];
    if (alert?.labels?.alertname === ALERT_NAME && typeof code === 'string' && code !== '') return code;
  }
  return null;
}

/** Derived from the rehearsal defaults, because those defaults are the sinks `alert-delivery.mjs` starts. */
export const SINK_WEBHOOK_PORT = new URL(ALERT_DESTINATION_DEFAULTS.PRL_ALERT_PAGE_WEBHOOK_URL).port;
export const SINK_SMTP_PORT = ALERT_DESTINATION_DEFAULTS.PRL_ALERT_SMTP_SMARTHOST.split(':').pop();

/** `host.docker.internal` and `host-gateway` are how a container reaches back to this process. */
const LOCAL_HOSTS = new Set([
  '127.0.0.1',
  'localhost',
  '::1',
  '[::1]',
  'host.docker.internal',
  'host-gateway',
]);

export function isLocalSmtpSink(smarthost) {
  const text = String(smarthost ?? '').replace(/^['"]|['"]$/g, '');
  const at = text.lastIndexOf(':');
  if (at === -1) return false;
  return LOCAL_HOSTS.has(text.slice(0, at)) && text.slice(at + 1) === SINK_SMTP_PORT;
}

export function isLocalWebhookSink(url) {
  try {
    const parsed = new URL(String(url ?? '').replace(/^['"]|['"]$/g, ''));
    return LOCAL_HOSTS.has(parsed.hostname) && parsed.port === SINK_WEBHOOK_PORT;
  } catch {
    return false;
  }
}

/** Every other integration sends somewhere this cannot inspect, so its receiver makes the run real. */
export const READABLE_INTEGRATIONS = new Set(['webhook_configs', 'email_configs']);

/**
 * Every destination in the targeted Alertmanager's own loaded config, from `GET /api/v2/status`.
 * Alertmanager returns webhook URLs as `url: <secret>` (measured on v0.28.1), so webhooks can be
 * counted but not read. Nothing downstream may conclude "there is no other webhook".
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
 * Stage one of the rehearsal decision. Every unknown counts as a possible real destination.
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
    // Only email destinations are disclosed, so with none there is no evidence, and no evidence means real.
    reasons.push(
      'no email destination is configured, and the email half is the only one Alertmanager discloses',
    );
  }
  return { sinkOnly: reasons.length === 0, reasons, destinations };
}

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

/** The sha256 goes in the record so runs a month apart can be compared on what was configured. */
async function readAlertmanagerConfig(base) {
  const response = await fetch(`${base}/api/v2/status`, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`${base}/api/v2/status answered ${response.status}`);
  const status = await response.json();
  const original = status?.config?.original ?? '';
  return { text: original, sha256: createHash('sha256').update(original).digest('hex') };
}

/** Resolving matters. An open `severity: page` alert is an open incident in the pager. */
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
  // Alertmanager expires an alert with no `endsAt` after `resolve_timeout` (a minute here). Thirty
  // minutes outlasts a long window, and a SIGKILLed run leaves an incident that closes itself.
  const endsAt = new Date(sentAt.getTime() + 30 * 60_000);

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
      // The code is read out of what was delivered, so a page that never arrived fails on the
      // same clock a person would.
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
        // A locked screen shows only the subject, so the code must be there. The subject is
        // redacted before printing because it contains the code.
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
    /** True only when the config disclosed nothing but this process's sinks and the page reached both. */
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
    disclosedDestinations: {
      smarthosts: [...candidate.destinations.smarthosts],
      recipients: [...candidate.destinations.recipients],
      readableWebhooks: candidate.destinations.webhooks,
      redactedWebhooks: candidate.destinations.redactedWebhooks,
      integrations: [...candidate.destinations.integrations],
    },
    /** What this checkout's environment would render. It decides nothing. */
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
    caveat:
      'The code travels as an alert label and Alertmanager echoes labels back on an unauthenticated ' +
      'GET /api/v2/alerts, so a caller who chose the --alertmanager URL could read this code without ' +
      'seeing a page. A pass is evidence a cooperating operator produced for themselves; it is not ' +
      'proof against a caller who wanted a green result.',
  };

  say('');
  if (outcome.ok && options.unattended) {
    // An unattended run proves nothing about a person, so it gets its own paragraph.
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

#!/usr/bin/env node
/**
 * Sends a REAL page through this deployment's Alertmanager and refuses to exit 0
 * until a human types back a code that appears nowhere except in the delivered
 * notification.
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
 * ## Why a code, and why THIS code
 *
 * The acknowledgement has to prove that the page was *read*, not that a command was
 * run. So the thing typed back must exist only in the delivered notification:
 *
 *   * it is generated fresh here, from `crypto.randomInt`, and it is NEVER printed
 *     to this terminal in an attended run. The operator sees `******`;
 *   * it travels as an alert LABEL, so Alertmanager's default subject template puts
 *     it in the `Subject:` — which is what a locked screen shows, and often the only
 *     part anybody reads at 3am — and in the webhook payload, and in the mail body;
 *   * it is single-use, and dies with the process.
 *
 * A person who types it has, necessarily, read a notification this deployment
 * delivered to the destination it pages. There is no path to the code that does not
 * go through the pager.
 *
 * ## What a pass proves, and what it does not
 *
 * A pass proves exactly this: **somebody acknowledged one page, at a known time,
 * within a bounded window, through this deployment's real paging path.** That is a
 * fact with a timestamp, and it is the first fact of its kind this repository has
 * been able to produce.
 *
 * It is not a promise about 3am next Tuesday. It says nothing about the holiday
 * nobody put in the rota, the phone that is face-down in another room, the gateway
 * that is decommissioned three months from now, or the second person who was never
 * on the test. An acknowledgement is a measurement of one moment, and treating it as
 * a property of the on-call arrangement is the same mistake as treating a green test
 * run as a proof of correctness. Run it again when the destinations change, and keep
 * the rota somewhere that is not this repository.
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
 * ## The rehearsal, and why unattended mode is fenced
 *
 * With the destinations left at their rehearsal defaults, this pages
 * `oncall@…invalid` through sinks it runs itself, so the whole mechanism can be
 * exercised on a laptop with no account anywhere and no message reaching a person.
 * In that configuration — and ONLY in that configuration —
 * `PRL_ALERT_ACK_UNATTENDED=1` lets the code be read out of the delivered
 * notification instead of off a keyboard, which is how this repository's own tests
 * and its release captures exercise the passing path.
 *
 * The fence is the point. Unattended mode is refused outright the moment a real
 * destination is configured, so there is no way to produce a green acknowledgement
 * against a real pager without a person. And an unattended run is stamped
 * `attended: false` in its record and prints a banner saying it is not a rehearsal,
 * because a skip that is quiet is a pass.
 *
 * Usage:
 *     pnpm run alerts:ack
 *     pnpm run alerts:ack -- --within 10m --by ada@example.org --out ack.json
 *     pnpm run alerts:ack -- --alertmanager https://alertmanager.internal:9093
 *
 * Exit codes:
 *     0  a person acknowledged inside the window
 *     1  nobody did, or the alert could not be sent
 */

import { randomInt } from 'node:crypto';
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
 * A LABEL and not an annotation, and that is the whole design. Alertmanager's default
 * subject template renders the common labels that are not group labels, so a label
 * puts the code in the `Subject:` line — the part that shows on a locked screen
 * without unlocking it. An annotation would put it in the body, which is one more
 * action away at the exact moment somebody is least willing to take one.
 *
 * It also makes each run a distinct alert, because labels are an alert's identity.
 * Two rehearsals half an hour apart must not deduplicate into one notification.
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

/**
 * Waits for the code to be typed, or for the window to close.
 *
 * Taking the input stream as a parameter rather than reaching for `process.stdin` is
 * what makes the failure path testable: `alert-ack-page.test.mjs` drives this with a
 * stream that stays silent and asserts that it FAILS, which is the one behaviour of
 * this whole file that must never regress. A command that passes when nobody answers
 * is worse than no command, because it produces a record saying somebody did.
 *
 * A wrong code does not end the run. It is counted and the window keeps running: the
 * realistic wrong-code case is a transcription slip by exactly the person this is
 * meant to prove was reached, and failing them on a typo measures nothing.
 *
 * @param {{input: NodeJS.ReadableStream, expected: string, deadlineMs: number,
 *          onAttempt?: (typed: string, attempts: number) => void}} options
 * @returns {Promise<{ok: boolean, attempts: number, elapsedMs: number, reason?: string}>}
 */
export async function awaitAcknowledgement({
  input,
  expected,
  deadlineMs,
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
// Options
// ---------------------------------------------------------------------------

const flag = (name, fallback = null) => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : (process.argv[at + 1] ?? fallback);
};

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
        '  type back a code that exists nowhere except in the delivered notification.\n',
    ),
  );

  const deadlineMs = durationMs(options.within);
  if (deadlineMs === null || deadlineMs < 1_000) {
    cross('--within is not a duration', `${JSON.stringify(options.within)} — try 5m, 90s, 1h`);
    return 1;
  }

  const { values, overridden } = alertmanagerValues();
  /**
   * Whether every destination a page could travel to is one of this script's own
   * sinks.
   *
   * The question is asked of all three paging destinations rather than of one,
   * because a half-configured deployment — a real webhook and a rehearsal inbox — is
   * a run that DOES reach somebody, and the unattended fence must not be opened for
   * it. Anything other than "all three are the shipped defaults" is treated as real.
   */
  const rehearsal = [
    'PRL_ALERT_PAGE_WEBHOOK_URL',
    'PRL_ALERT_PAGE_EMAIL_TO',
    'PRL_ALERT_SMTP_SMARTHOST',
  ].every((name) => values[name] === ALERT_DESTINATION_DEFAULTS[name]);

  say(bold('What this run will page'));
  note(`alertmanager   ${options.alertmanager}`);
  note(`routed as      severity=page → whatever this Alertmanager's paging receiver is`);
  note(`page webhook   ${values.PRL_ALERT_PAGE_WEBHOOK_URL || '(none)'}`);
  note(
    `page email     ${values.PRL_ALERT_PAGE_EMAIL_TO || '(none)'} via ${values.PRL_ALERT_SMTP_SMARTHOST || '(no relay)'}`,
  );
  note(`window         ${asDuration(deadlineMs)}`);
  if (rehearsal) {
    note(
      yellow("every paging destination is this repository's own throwaway sink, so this run pages NOBODY."),
    );
    note(yellow('It rehearses the mechanism. Set PRL_ALERT_* to page a real device.'));
  } else {
    note(green(`${overridden.length} PRL_ALERT_* value(s) supplied — this run pages a real destination.`));
  }

  if (options.unattended && !rehearsal) {
    // The fence. There is no supported way to produce a green acknowledgement against
    // a configured pager without a person, and this is where that is enforced.
    say('');
    cross(
      'PRL_ALERT_ACK_UNATTENDED is set and this deployment has real paging destinations',
      'unattended acknowledgement exists so that this repository can test its own passing path ' +
        'against its own sinks. Against a real pager it would be a record saying a person was ' +
        'reached when none was. Unset it and run this at a terminal.',
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
  if (rehearsal) {
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
  const record = {
    schema: 'prl.alert-ack.v1',
    alertname: ALERT_NAME,
    code,
    by: options.by,
    attended: !options.unattended,
    rehearsal,
    alertmanager: options.alertmanager,
    destinations: {
      webhook: values.PRL_ALERT_PAGE_WEBHOOK_URL,
      email: values.PRL_ALERT_PAGE_EMAIL_TO,
      smarthost: values.PRL_ALERT_SMTP_SMARTHOST,
    },
    windowMs: deadlineMs,
    sentAt: sentAt.toISOString(),
    acknowledgedAt: null,
    elapsedMs: null,
    attempts: 0,
    ok: false,
  };

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
       * In a rehearsal, the delivery is observed rather than assumed — and this is the
       * assertion that makes an unattended run mean anything at all: the code that
       * unlocks the command is READ OUT OF what was actually delivered. If the page
       * never arrived, there is no code to read and the run fails on the same clock a
       * person would have failed on.
       */
      const delivered = await measureUntil(
        () => notificationsFor(sink.received, '/page', ALERT_NAME, 'firing').length > 0,
        Math.min(deadlineMs, 60_000),
        500,
      );
      if (delivered === null) {
        cross('the page reached the paging receiver', 'nothing arrived on /page');
      } else {
        tick('the page reached the paging receiver', `on /page, ${(delivered / 1000).toFixed(0)}s later`);
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
        if (subject.includes(code)) {
          tick('and over SMTP, with the code in the subject', subject);
        } else {
          cross(
            'and over SMTP, with the code in the subject',
            `the code is not in ${JSON.stringify(subject)}`,
          );
        }
      }
    }

    say(bold('\nAcknowledgement'));
    if (options.unattended) {
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
      if (outcome.ok) tick('the delivered notification carried the code that was sent', arrived);
      else cross('the delivered notification carried the code that was sent', outcome.reason ?? 'it did not');
    } else {
      note(`the code is in the page, and deliberately not on this screen: ${'*'.repeat(code.length)}`);
      say(`\n  Type the code from the page and press enter — ${asDuration(deadlineMs)} to answer.\n`);
      outcome = await awaitAcknowledgement({
        input: process.stdin,
        expected: code,
        deadlineMs,
        onAttempt: (typed, attempts) =>
          say(red(`  ✗ ${JSON.stringify(typed.trim())} is not the code (attempt ${attempts}) — try again`)),
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

  record.ok = outcome.ok;
  record.attempts = outcome.attempts;
  record.elapsedMs = outcome.elapsedMs;
  record.acknowledgedAt = outcome.ok ? new Date().toISOString() : null;

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
          '  destination in this run was a sink this process started. This run must not be quoted\n' +
          '  as a rehearsal of the on-call arrangement. Run it attended, at a terminal, with this\n' +
          "  environment's PRL_ALERT_* set, for the claim that matters.\n",
      ),
    );
  } else if (outcome.ok) {
    say(green(bold(`ACK PASSED — acknowledged by ${options.by} after ${asDuration(outcome.elapsedMs)}`)));
    say(
      dim(
        "\n  What this proves: one page, sent through this deployment's real paging path, was READ\n" +
          '  by a person, who proved it by returning a code that existed nowhere else. That is a\n' +
          '  fact with a timestamp, and it is recorded above.\n' +
          '\n  What it does NOT prove: anything about 3am next Tuesday. Not the holiday nobody put\n' +
          '  in the rota, not the phone face-down in another room, not the gateway that is\n' +
          '  decommissioned three months from now, and not the second person who was never on\n' +
          '  this test. Run it again whenever the destinations change, and keep the rota\n' +
          '  somewhere that is not this repository.\n',
      ),
    );
  } else {
    say(red(bold(`ACK FAILED — ${outcome.reason ?? 'nobody acknowledged'}`)));
    say(
      dim(
        `\n  The code sent was ${code}. It is printed now, and only now, because the useful\n` +
          '  question after a failure is whether the page arrived at all and arrived intact.\n' +
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

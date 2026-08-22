'use client';

/**
 * How long you have been here, and a reminder you can set for yourself.
 *
 * ## The defect this exists for
 *
 * `docs/PRODUCT-GUARDRAILS.md` §8 says the product respects the reader's time and attention, and §2
 * rules out every mechanism that makes stopping harder. Both were satisfied by absence: there is no
 * autoplay, no streak, no daily reward and nothing that punishes leaving. What there was nothing of
 * either was anything that helped a reader NOTICE they had been here two hours. A poker table has
 * no natural end — the next hand always deals — and "we did not add a hook" is a weaker position
 * than "we tell you what time it is".
 *
 * ## Why this is not tracking, stated precisely
 *
 * The clock starts when this component first runs in a tab, from `Date.now()`. That value goes in
 * `sessionStorage`, which is per-tab and is discarded when the tab closes. The reminder preference
 * is a number of minutes in `localStorage`. Neither is sent anywhere: there is no fetch in this
 * file, no cookie, no field on any API request, and nothing here reaches `prl.users`,
 * `prl.sessions` or the audit log. `/privacy` describes both keys by name, which is only possible
 * because they are the whole of it.
 *
 * A server-side version — "you have been playing for 40 minutes", computed from
 * `sessions.created_at` — was the other option and is rejected twice over. It would turn a local
 * convenience into an account-level record of when somebody plays and for how long, which is
 * exactly the behavioural profile this product has gone out of its way not to build. And it would
 * be wrong: a session cookie outlives a browser restart, so it measures the age of a credential
 * rather than the length of a sitting.
 *
 * ## What makes it not a dark pattern
 *
 * It never blocks anything. No modal, no overlay, no "are you sure" — the reminder is a sentence in
 * the footer, in ordinary document flow, and the table behind it keeps dealing. There is no default
 * interval: an unasked-for nag every thirty minutes would be the same attention-grab with a
 * friendlier face, so either the reader picks one or there is none. The operator cannot configure
 * it, so it is not a lever anybody can tune. And it is dismissible for the tab, with the way back
 * stated on `/responsible-use` rather than hidden.
 *
 * The inverse of each of those is what a casino's "session timer" does, and the difference is not
 * subtle: theirs interrupts, congratulates, and offers to continue.
 *
 * ## Why the readout is not a live region
 *
 * It changes on a timer without the reader doing anything, and a live region that announces itself
 * every thirty seconds is unusable. The elapsed line is ordinary text, read when somebody goes
 * looking for it. Only the REMINDER — which fires once, at a moment the reader chose — is a
 * `role="status"`, and that paragraph is in the DOM from the first render after mount, empty, so
 * its text arrives into a region that already exists. Several screen readers miss a live region
 * that appears at the same instant as its content; `app/record/UnitsReset.tsx` carries the same
 * note for the same reason.
 *
 * ## Why nothing renders on the server
 *
 * The elapsed time comes from `sessionStorage`, which the server cannot read, so a server render
 * would have to guess and then correct itself — a hydration mismatch on every page of the app.
 * `Onboarding.tsx` takes the same approach and its header explains the trade: one small insertion
 * immediately after load, once per tab, at the very bottom of the document, is much the cheaper
 * mistake.
 *
 * ## Why it introduces no CSS of its own
 *
 * Every class here already exists in `@prl/ui`'s global stylesheet or in the app shell's footer
 * rules. That is not thrift: this component renders inside `SiteFooter` on every page, and a
 * stylesheet imported from a component in `src/components` is outside the `app` directory that
 * Next documents global CSS imports for. Reusing the footer's own classes keeps the block looking
 * like the three beside it, which is what it is.
 */

import { Button, pluralise } from '@prl/ui';
import { type ReactElement, useEffect, useState } from 'react';

/** Per-tab, so closing the tab genuinely ends the sitting. Namespaced against the origin's keys. */
const STARTED_KEY = 'prl.session.startedAt';

/**
 * Per-device. Re-choosing an interval in every new tab is the kind of friction that teaches a
 * reader to stop using a control, and a number of minutes is not a fact about anybody.
 */
const REMINDER_KEY = 'prl.session.reminderMinutes';

/** Per-tab: hiding is a decision about this sitting, not a permanent opt-out of knowing the time. */
const HIDDEN_KEY = 'prl.session.hidden';

/**
 * How often the readout re-computes: thirty seconds.
 *
 * The figure has minute resolution, so a thirty-second tick is never more than half a minute stale.
 * A one-second tick would re-render the footer sixty times a minute, on every page in the app
 * including a live table, to move a digit that changes once.
 */
const TICK_MS = 30_000;

/**
 * The intervals offered, in minutes. `0` is "no reminder" and is what an unconfigured reader gets.
 *
 * Short enough at the bottom to suit somebody who meant to take five minutes, and stopping at
 * ninety because an interval longer than that is not a reminder, it is a bedtime.
 */
const REMINDER_CHOICES: readonly number[] = [0, 15, 30, 45, 60, 90];

/**
 * Storage access, wrapped.
 *
 * `window.localStorage` THROWS rather than returning null in Safari's private mode and wherever
 * site data is blocked by policy, so an unguarded read in a component that renders on every page is
 * a blank page for a subset of readers. `src/lib/theme.ts` documents the same hazard; its helpers
 * are private to that module, which exists to feed the pre-paint inline script and has no business
 * growing a general storage API, so the two guards are written out in both places.
 */
function readStorage(storage: 'localStorage' | 'sessionStorage', key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window[storage].getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(storage: 'localStorage' | 'sessionStorage', key: string, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    window[storage].setItem(key, value);
  } catch {
    // Storage refused. The clock still runs for this page view from the value held in state; losing
    // it on the next navigation is the correct degradation, and throwing would lose the page.
  }
}

/** The stored interval, or 0. Anything unrecognised is 0 rather than a guess at what was meant. */
function readReminder(): number {
  const stored = readStorage('localStorage', REMINDER_KEY);
  if (stored === null) return 0;
  const parsed = Number(stored);
  return REMINDER_CHOICES.includes(parsed) ? parsed : 0;
}

/**
 * When this sitting started: whatever the tab has stored, or now.
 *
 * A stored value that is not a plausible timestamp — corrupt, or written before a clock change that
 * moved the machine backwards — is replaced rather than trusted. The alternative is a footer
 * confidently reporting a sitting of nine thousand hours, which is the sort of wrong number that
 * makes a reader distrust every other number on the page.
 */
function readStartedAt(now: number): number {
  const stored = readStorage('sessionStorage', STARTED_KEY);
  if (stored !== null) {
    const parsed = Number(stored);
    if (Number.isFinite(parsed) && parsed > 0 && parsed <= now) return parsed;
  }
  writeStorage('sessionStorage', STARTED_KEY, String(now));
  return now;
}

/** "less than a minute", "1 minute", "42 minutes", "2 hours 5 minutes". */
export function describeElapsed(milliseconds: number): string {
  const totalMinutes = Math.floor(milliseconds / 60_000);
  if (totalMinutes < 1) return 'less than a minute';
  if (totalMinutes < 60) return pluralise(totalMinutes, 'minute');
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (minutes === 0) return pluralise(hours, 'hour');
  return `${pluralise(hours, 'hour')} ${pluralise(minutes, 'minute')}`;
}

export function SessionDuration(): ReactElement | null {
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  const [reminderMinutes, setReminderMinutes] = useState(0);
  /**
   * When the reader last acknowledged a reminder, or null. The next one is counted from here rather
   * than from the start of the sitting, which is what makes acknowledging mean "tell me again
   * later" instead of "tell me again immediately".
   */
  const [acknowledgedAt, setAcknowledgedAt] = useState<number | null>(null);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    if (readStorage('sessionStorage', HIDDEN_KEY) !== null) {
      setHidden(true);
      return undefined;
    }
    setStartedAt(readStartedAt(Date.now()));
    setNow(Date.now());
    setReminderMinutes(readReminder());
    const tick = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(tick);
  }, []);

  const chooseReminder = (minutes: number): void => {
    setReminderMinutes(minutes);
    // Choosing an interval restarts the count from now, so picking "30 minutes" an hour into a
    // sitting does not fire instantly with a reminder about a decision just taken.
    setAcknowledgedAt(Date.now());
    writeStorage('localStorage', REMINDER_KEY, String(minutes));
  };

  const hide = (): void => {
    setHidden(true);
    writeStorage('sessionStorage', HIDDEN_KEY, '1');
  };

  if (hidden || startedAt === null) return null;

  const elapsed = Math.max(0, now - startedAt);
  const since = acknowledgedAt ?? startedAt;
  const reminderDue = reminderMinutes > 0 && now - since >= reminderMinutes * 60_000;

  return (
    <div className="prl-footer__statement">
      <p className="prl-footer__heading prl-label">This sitting</p>

      <p className="prl-footer__prose">{`You have had this tab open for ${describeElapsed(elapsed)}.`}</p>

      <div className="prl-field">
        <label className="prl-field__label" htmlFor="prl-session-reminder">
          Remind me after
        </label>
        <select
          className="prl-select"
          id="prl-session-reminder"
          onChange={(event) => chooseReminder(Number(event.target.value))}
          value={String(reminderMinutes)}
        >
          {REMINDER_CHOICES.map((minutes) => (
            <option key={minutes} value={String(minutes)}>
              {minutes === 0 ? 'No reminder' : pluralise(minutes, 'minute')}
            </option>
          ))}
        </select>
      </div>

      {/*
        In the DOM from the first render after mount, empty. The earliest a reminder can fire is
        fifteen minutes later, so the region is long established by the time anything arrives in it
        — which is the condition several screen readers need in order to announce it at all.
      */}
      <p className="prl-footer__prose" role="status">
        {reminderDue
          ? `You asked to be reminded after ${pluralise(reminderMinutes, 'minute')}, and that has passed. Nothing has changed, nothing is waiting for you, and nothing happens if you stop here.`
          : ''}
      </p>

      <p className="prl-btn-row">
        {reminderDue ? (
          <Button onClick={() => setAcknowledgedAt(Date.now())} size="sm" variant="ghost">
            {`Remind me again in ${pluralise(reminderMinutes, 'minute')}`}
          </Button>
        ) : null}
        <Button onClick={hide} size="sm" variant="ghost">
          Hide this
        </Button>
      </p>

      <p className="prl-note">
        Counted in this tab only, from when the page first loaded. It is not sent anywhere, not attached to
        your account and not recorded — closing the tab is the whole of forgetting it. Hiding it lasts for
        this tab; a new one brings it back.
      </p>
    </div>
  );
}

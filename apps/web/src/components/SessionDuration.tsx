'use client';

/**
 * How long you have been here, and a reminder you can set for yourself (guardrails §8 and §2).
 *
 * Not tracking. The start time is in `sessionStorage` (per tab) and the reminder interval in
 * `localStorage`, and neither leaves the browser. `/privacy` names both keys. A server-side version
 * from `sessions.created_at` was rejected, because it would profile when somebody plays.
 *
 * Not a dark pattern. It never blocks, has no default interval, cannot be configured by the operator,
 * and can be hidden for the tab. Only the reminder is a `role="status"`, because a readout announced
 * every thirty seconds is unusable. Nothing renders on the server, because it cannot read
 * `sessionStorage`. It reuses the footer's classes and adds no CSS.
 */

import { Button, pluralise } from '@prl/ui';
import { type ReactElement, useEffect, useState } from 'react';

/** Per-tab, so closing the tab genuinely ends the sitting. Namespaced against the origin's keys. */
const STARTED_KEY = 'prl.session.startedAt';

/** Per device, so a reader does not re-choose an interval in every tab. */
const REMINDER_KEY = 'prl.session.reminderMinutes';

/** Per tab, because hiding is a decision about this sitting, not a permanent opt-out of knowing the time. */
const HIDDEN_KEY = 'prl.session.hidden';

/** The figure has minute resolution, so a 30-second tick is at most half a minute stale. */
const TICK_MS = 30_000;

/** In minutes. `0` is no reminder and the default. Ninety is the longest that is still a reminder. */
const REMINDER_CHOICES: readonly number[] = [0, 15, 30, 45, 60, 90];

/**
 * Storage throws rather than returning null in Safari private mode and where site data is blocked,
 * and this renders on every page. `src/lib/theme.ts` carries its own private copy of this guard.
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
    // Storage refused. The clock still runs for this page view from state.
  }
}

/** The stored interval, or 0. Anything unrecognised is 0 rather than a guess at what was meant. */
function readReminder(): number {
  const stored = readStorage('localStorage', REMINDER_KEY);
  if (stored === null) return 0;
  const parsed = Number(stored);
  return REMINDER_CHOICES.includes(parsed) ? parsed : 0;
}

/** The tab's stored start, or now. An implausible timestamp is replaced rather than trusted. */
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
  /** When the reader last acknowledged a reminder. The next one counts from here. */
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
    // Choosing restarts the count, so a new interval never fires instantly.
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

      {/* Mounted empty. The first reminder is at least fifteen minutes later, so it is announced. */}
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

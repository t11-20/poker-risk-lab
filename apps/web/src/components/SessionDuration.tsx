'use client';

/**
 * How long you have been here, and a reminder you can set for yourself (guardrails §8 and §2).
 *
 * Not tracking. The start time is in `sessionStorage` (per tab) and the reminder interval in
 * `localStorage`, and neither leaves the browser. `/privacy` names every key. A server-side version
 * from `sessions.created_at` was rejected, because it would profile when somebody plays.
 *
 * Not a dark pattern. It never blocks, has no default interval, cannot be configured by the operator,
 * and can be hidden for the tab. Only the reminder is a `role="status"`, because a readout announced
 * every thirty seconds is unusable. Nothing renders on the server, because it cannot read
 * `sessionStorage`. It reuses the footer's classes and adds no CSS.
 */

import { Button, pluralise } from '@prl/ui';
import { type ReactElement, useEffect, useRef, useState } from 'react';
import {
  HIDDEN_KEY,
  REMINDER_CHOICES,
  REMINDER_KEY,
  readAcknowledgedAt,
  readReminder,
  readStartedAt,
  readStorage,
  writeAcknowledgedAt,
  writeStorage,
} from '@/lib/session-sitting.ts';

/** The figure has minute resolution, so a 30-second tick is at most half a minute stale. */
const TICK_MS = 30_000;

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
  const reminderRef = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    if (readStorage('sessionStorage', HIDDEN_KEY) !== null) {
      setHidden(true);
      return undefined;
    }
    const loadedAt = Date.now();
    const started = readStartedAt(loadedAt);
    setStartedAt(started);
    setAcknowledgedAt(readAcknowledgedAt(started, loadedAt));
    setNow(loadedAt);
    setReminderMinutes(readReminder());
    const tick = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(tick);
  }, []);

  const acknowledge = (): void => {
    const at = Date.now();
    setAcknowledgedAt(at);
    writeAcknowledgedAt(at);
  };

  const chooseReminder = (minutes: number): void => {
    setReminderMinutes(minutes);
    // Choosing restarts the count, so a new interval never fires instantly.
    acknowledge();
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
          ref={reminderRef}
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
          <Button
            onClick={() => {
              // The button unmounts on this press. The interval it restarted is the nearest thing left.
              reminderRef.current?.focus();
              acknowledge();
            }}
            size="sm"
            variant="ghost"
          >
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

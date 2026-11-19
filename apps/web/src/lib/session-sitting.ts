/**
 * What the footer's sitting timer keeps in this browser. Nothing here leaves it, and `/privacy` names
 * every key.
 */

/** Per tab, so closing the tab genuinely ends the sitting. Namespaced against the origin's keys. */
export const STARTED_KEY = 'prl.session.startedAt';

/** Per device, so a reader does not re-choose an interval in every tab. */
export const REMINDER_KEY = 'prl.session.reminderMinutes';

/** Per tab, because hiding is a decision about this sitting, not a permanent opt-out of knowing the time. */
export const HIDDEN_KEY = 'prl.session.hidden';

/** Per tab, like the start it counts from, so a reload does not repeat a reminder already acknowledged. */
export const ACKNOWLEDGED_KEY = 'prl.session.acknowledgedAt';

/** In minutes. `0` is no reminder and the default. Ninety is the longest that is still a reminder. */
export const REMINDER_CHOICES: readonly number[] = [0, 15, 30, 45, 60, 90];

/**
 * Storage throws rather than returning null in Safari private mode and where site data is blocked,
 * and this renders on every page. `src/lib/theme.ts` carries its own private copy of this guard.
 */
export function readStorage(storage: 'localStorage' | 'sessionStorage', key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window[storage].getItem(key);
  } catch {
    return null;
  }
}

export function writeStorage(storage: 'localStorage' | 'sessionStorage', key: string, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    window[storage].setItem(key, value);
  } catch {
    // Storage refused. The clock still runs for this page view from state.
  }
}

/** The stored interval, or 0. Anything unrecognised is 0 rather than a guess at what was meant. */
export function readReminder(): number {
  const stored = readStorage('localStorage', REMINDER_KEY);
  if (stored === null) return 0;
  const parsed = Number(stored);
  return REMINDER_CHOICES.includes(parsed) ? parsed : 0;
}

/** The tab's stored start, or now. An implausible timestamp is replaced rather than trusted. */
export function readStartedAt(now: number): number {
  const stored = readStorage('sessionStorage', STARTED_KEY);
  if (stored !== null) {
    const parsed = Number(stored);
    if (Number.isFinite(parsed) && parsed > 0 && parsed <= now) return parsed;
  }
  writeStorage('sessionStorage', STARTED_KEY, String(now));
  return now;
}

/**
 * The tab's last acknowledgement, or null. One from before this sitting began or from the future is
 * ignored, which counts from the start again and so can only bring a reminder sooner, never hide one.
 */
export function readAcknowledgedAt(startedAt: number, now: number): number | null {
  const stored = readStorage('sessionStorage', ACKNOWLEDGED_KEY);
  if (stored === null) return null;
  const parsed = Number(stored);
  return Number.isFinite(parsed) && parsed >= startedAt && parsed <= now ? parsed : null;
}

export function writeAcknowledgedAt(at: number): void {
  writeStorage('sessionStorage', ACKNOWLEDGED_KEY, String(at));
}

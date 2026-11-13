/**
 * Human labels for the content package's machine ids. An explicit map, because no transform turns
 * "ev" into "EV". An id with no entry falls back to its de-hyphenated form rather than throwing.
 */

import { TOPIC_LABELS } from '@prl/contracts';

const DIFFICULTY_LABELS: Readonly<Record<string, string>> = {
  intro: 'Intro',
  core: 'Core',
  advanced: 'Advanced',
};

const STREET_LABELS: Readonly<Record<string, string>> = {
  preflop: 'Preflop',
  flop: 'Flop',
  turn: 'Turn',
  river: 'River',
  showdown: 'Showdown',
  complete: 'Complete',
};

/** The maps' key order, so levels run Intro to Advanced and streets in deal order, never alphabetical. */
export const DIFFICULTY_ORDER: readonly string[] = Object.keys(DIFFICULTY_LABELS);
export const STREET_ORDER: readonly string[] = Object.keys(STREET_LABELS);

function fallback(id: string): string {
  const spaced = id.replace(/-/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** From the one map in `@prl/contracts`, so Learn, the glossary and the Lab name topics alike. */
export function topicLabel(id: string): string {
  return (TOPIC_LABELS as Readonly<Record<string, string>>)[id] ?? fallback(id);
}

export function difficultyLabel(id: string): string {
  return DIFFICULTY_LABELS[id] ?? fallback(id);
}

export function streetLabel(id: string): string {
  return STREET_LABELS[id] ?? fallback(id);
}

/**
 * Fixed and locale-independent (`17 Aug 2026, 18:42 UTC`), because Node and the browser disagree on
 * the host locale, which is a hydration mismatch. The zone is named so server time cannot mislead.
 */
const MONTHS: readonly string[] = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

export function formatTimestamp(iso: string): string {
  const at = new Date(iso);
  const time = at.getTime();
  // An unparseable timestamp is shown as itself, so the bad row stays visible.
  if (Number.isNaN(time)) return iso;
  const day = String(at.getUTCDate()).padStart(2, '0');
  const month = MONTHS[at.getUTCMonth()] ?? '???';
  const hours = String(at.getUTCHours()).padStart(2, '0');
  const minutes = String(at.getUTCMinutes()).padStart(2, '0');
  return `${day} ${month} ${at.getUTCFullYear()}, ${hours}:${minutes} UTC`;
}

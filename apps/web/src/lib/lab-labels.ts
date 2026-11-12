/**
 * Human labels for the content package's machine ids.
 *
 * ## Why an explicit map rather than a transform
 *
 * `'pot-odds-and-ev'.replace(/-/g, ' ')` gets you "pot odds and ev", and there is no rule that turns
 * "ev" into "EV", "spr" into "SPR" or "icm" into "ICM" without a list of exceptions — which is a map
 * with extra steps and a worse failure mode. An id with no entry falls back to the de-hyphenated form
 * rather than throwing, so a topic added to `@prl/contracts` before it is added here reads slightly
 * plainly instead of taking the page down.
 *
 * These are labels, not content. The teaching text lives in `@prl/content`; this module exists only
 * so a filter dropdown and a chip can say "Pot odds and EV" instead of a slug.
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

/**
 * The order a learner meets the levels in, and the order the streets are dealt.
 *
 * Both maps above are written in that order, and these are their keys rather than a second list, so
 * a level or street added to a map is ranked by being added. The Lab's filter options used to be
 * sorted with `localeCompare` on the label, which read "Advanced, Core, Intro" and "Flop, Preflop,
 * River, Turn" — alphabetical, which is no order anybody learns or plays in.
 */
export const DIFFICULTY_ORDER: readonly string[] = Object.keys(DIFFICULTY_LABELS);
export const STREET_ORDER: readonly string[] = Object.keys(STREET_LABELS);

function fallback(id: string): string {
  const spaced = id.replace(/-/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * A topic's name, from the one map in `@prl/contracts` that Learn and the glossary use too.
 *
 * This module had its own topic map, which called `positions-and-blinds` "Positions and blinds"
 * while the curriculum called it "Position and the blinds" (UX audit at 6b3886e, Minor 4).
 */
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
 * A UTC timestamp rendered in a fixed, locale-independent form.
 *
 * `toLocaleString()` with no locale reads the host default, and these pages render twice — once in
 * Node, once in the browser — on hosts that routinely disagree. That is a hydration mismatch that
 * only reproduces on some machines, which is the same trap `@prl/ui`'s `format.ts` documents for
 * numbers. So the format is fixed: `17 Aug 2026, 18:42 UTC`. The zone is named rather than implied,
 * because a hand history that quietly shows server time is a hand history that misleads about when
 * something happened.
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
  // An unparseable timestamp is shown as itself. Hiding it behind an em dash would hide the bad row.
  if (Number.isNaN(time)) return iso;
  const day = String(at.getUTCDate()).padStart(2, '0');
  const month = MONTHS[at.getUTCMonth()] ?? '???';
  const hours = String(at.getUTCHours()).padStart(2, '0');
  const minutes = String(at.getUTCMinutes()).padStart(2, '0');
  return `${day} ${month} ${at.getUTCFullYear()}, ${hours}:${minutes} UTC`;
}

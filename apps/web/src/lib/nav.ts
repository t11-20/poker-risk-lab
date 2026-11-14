/**
 * The five destinations in learning order, as data shared by the nav, the mobile sheet, the footer
 * and `not-found.tsx`. The `01…05` indices are derived from position (§9). The legal documents and
 * the record are separate lists, because an entry outside the learning order would blunt it.
 */

import { LEGAL_PATHS } from './legal-config.ts';
import { RECORD_PATH } from './record-data.ts';

/** Drawn by `SuitMark`. */
export type NavArea = 'learn' | 'play' | 'lab' | 'legends' | 'review';

export interface NavDestination {
  /** Matched exactly for `/`, by prefix for everything else. */
  readonly href: string;
  readonly label: string;
  /** One line for the footer and the not-found page. Not a marketing sentence. */
  readonly summary: string;
  /** Present on the five sections only. */
  readonly area?: NavArea;
}

export const NAV_DESTINATIONS: readonly NavDestination[] = [
  { href: '/learn', area: 'learn', label: 'Learn', summary: 'Lessons, quizzes and the glossary.' },
  {
    href: '/play',
    area: 'play',
    label: 'Play',
    summary: 'Tables against bots, AI Legends and private rooms.',
  },
  {
    href: '/lab',
    area: 'lab',
    label: 'Lab',
    summary: 'The Scenario Lab: change one input, watch the maths move.',
  },
  {
    href: '/legends',
    area: 'legends',
    label: 'Legends',
    summary: 'Twelve computer opponents, each a different style of play.',
  },
  {
    href: '/review',
    area: 'review',
    label: 'Review',
    summary: 'Hand history, with every decision priced afterwards.',
  },
];

/** Terms first, which the other two elaborate. No `06 07 08` index, because they are not next steps. */
export const DOCUMENT_DESTINATIONS: readonly NavDestination[] = [
  { href: LEGAL_PATHS.terms, label: 'Terms of use', summary: 'What this is, and what you may do with it.' },
  {
    href: LEGAL_PATHS.privacy,
    label: 'What is stored about you',
    summary: 'Every table in the database, and what is in it.',
  },
  {
    href: LEGAL_PATHS.responsibleUse,
    label: 'Responsible use',
    summary: 'What play money cannot teach you, and how to stop.',
  },
];

/**
 * Listed after the five, unnumbered, in the sheet, the footer and the 404, so it is reachable from
 * more than the footer. Exported after `DOCUMENT_DESTINATIONS`, because
 * `legal-pages.test.ts` counts the five by slicing between the two lists.
 */
export const RECORD_DESTINATION: NavDestination = {
  href: RECORD_PATH,
  label: 'Your record',
  summary: 'What you have read, tried and played, and the reset for your units.',
};

/** `/` matches exactly. Others match their subtree, so a reader deep in a lesson stays in Learn. */
export function isCurrentDestination(href: string, pathname: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Duplicates the `860px` breakpoint in `globals.css`, because `var()` is invalid inside a media
 * feature and `matchMedia` needs a string.
 */
export const NAV_SHEET_QUERY = '(min-width: 860px)';

/**
 * The five destinations, in learning order, as data.
 *
 * ## Why this is a module and not a literal in the header
 *
 * Three components render the same five entries — the desktop nav, the mobile sheet, and the
 * footer's site map — and a fourth (`not-found.tsx`) offers them as a way out of a dead end.
 * Four copies of an ordered list is four places for a route to be renamed in three of them.
 *
 * The order is the product's argument and not an arbitrary sort: learn the idea, play a hand,
 * take the idea apart in the Lab, meet the opponents, then review what you actually did. The
 * `01…05` indices exist to make that argument visible (§9), which is also why they are derived
 * from position rather than stored — a hand-written index can disagree with the array it sits in.
 *
 * ## The second list, and why it is a second list rather than three more entries
 *
 * `DOCUMENT_DESTINATIONS` holds the three documents — terms, what is stored about you, responsible
 * use. They are real pages with real content and they are deliberately NOT in `NAV_DESTINATIONS`.
 * `/record` set the precedent and its own header states the reasoning: the five numbered
 * destinations are an argument about learning order, and an entry that is not part of that argument
 * blunts it. A document is not a step in learning to price a decision; it is something a reader
 * goes looking for, and the footer is where people look.
 *
 * They are here rather than as literals in `SiteFooter.tsx` for the same reason the five are: a
 * route list with two copies is two places for a rename to be applied to one of them. The paths
 * themselves come from `lib/legal-config.ts`, which is the feature's own module — the same
 * relationship `/record` has with `RECORD_PATH` in `lib/record-data.ts`.
 *
 * ## The breakpoint literal
 *
 * `NAV_SHEET_QUERY` duplicates the `860px` in `globals.css`, and it has to: `var()` is invalid
 * inside a media feature, and `matchMedia` needs a string. The design system already names 860
 * as the nav breakpoint (§9) and `components.css` records the same exception for its four
 * breakpoints. It is here rather than inline in `MobileNav` so the duplication is one grep away
 * from the CSS it mirrors.
 */

import { LEGAL_PATHS } from './legal-config.ts';
import { RECORD_PATH } from './record-data.ts';

export interface NavDestination {
  /** Route path. Matched exactly for `/`, by prefix for everything else. */
  readonly href: string;
  /** The word on the control, uppercased by `--prl-type-label` in CSS, not in the string. */
  readonly label: string;
  /** One line for the footer and the not-found page. Not a marketing sentence. */
  readonly summary: string;
}

export const NAV_DESTINATIONS: readonly NavDestination[] = [
  { href: '/learn', label: 'Learn', summary: 'Lessons, quizzes and the glossary.' },
  { href: '/play', label: 'Play', summary: 'Tables against bots, AI Legends and private rooms.' },
  { href: '/lab', label: 'Lab', summary: 'The Scenario Lab: change one input, watch the maths move.' },
  {
    href: '/legends',
    label: 'Legends',
    summary: 'Twelve computer opponents, each a different style of play.',
  },
  { href: '/review', label: 'Review', summary: 'Hand history, with every decision priced afterwards.' },
];

/**
 * The three documents, in the order the footer lists them.
 *
 * Terms first because it is what the other two elaborate on, then the data inventory, then
 * responsible use — which is last because it is the one somebody may arrive at directly and the
 * only one with an argument rather than a description in it.
 *
 * These carry no index. The `01…05` motif belongs to the numbered argument above; putting `06 07 08`
 * on a set of documents would say they are the next steps in it, which is precisely what they are
 * not.
 */
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
 * The reader's own record — progress, the units reset, and account deletion.
 *
 * Not one of the five, for the reason `/record`'s own header gives: the five are an argument about
 * learning order and a sixth step that is not a step blunts it. But "not numbered" had become "not
 * listed": the audit at 6b3886e found it in neither the header nor the menu sheet, with the
 * footer's inline "reset to the starting amount" as the only way in on every page. So it is listed
 * after the five, unnumbered, wherever they are — the sheet, the footer's site map and the 404 — and
 * the header's units figure links to it.
 *
 * Exported AFTER `DOCUMENT_DESTINATIONS`, not between the two lists: `legal-pages.test.ts` counts the
 * five by slicing from one `export const` to the next, and an entry between them would be counted
 * as a sixth numbered destination.
 */
export const RECORD_DESTINATION: NavDestination = {
  href: RECORD_PATH,
  label: 'Your record',
  summary: 'What you have read, tried and played, and the reset for your units.',
};

/**
 * Whether a destination is the one currently open.
 *
 * `/` is matched exactly because every path starts with it. Everything else matches its own
 * path and anything beneath it, so `/learn/pot-odds` still marks `01 LEARN` as current — a
 * reader three levels into a lesson has not left the section, and a nav that forgets where they
 * are is worse than no nav.
 */
export function isCurrentDestination(href: string, pathname: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Mirrors the `860px` nav breakpoint in `globals.css`. See the module comment. */
export const NAV_SHEET_QUERY = '(min-width: 860px)';

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
 * ## The breakpoint literal
 *
 * `NAV_SHEET_QUERY` duplicates the `860px` in `globals.css`, and it has to: `var()` is invalid
 * inside a media feature, and `matchMedia` needs a string. The design system already names 860
 * as the nav breakpoint (§9) and `components.css` records the same exception for its four
 * breakpoints. It is here rather than inline in `MobileNav` so the duplication is one grep away
 * from the CSS it mirrors.
 */

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
  { href: '/legends', label: 'Legends', summary: 'The twelve opponent profiles, as trait vectors.' },
  { href: '/review', label: 'Review', summary: 'Hand history, with every decision priced afterwards.' },
];

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

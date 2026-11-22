/**
 * Every tip sentence this package shows, in one place, so one test can hold all of them to the rule
 * the owner set: one plain sentence per tip. `apps/web` keeps its own catalogue and runs the same check.
 */

export interface TipCopy {
  /** What the tip explains, read after "About" in the button's name, so lower case unless a name. */
  readonly term: string;
  /** One sentence, ending in a full stop. */
  readonly text: string;
}

/** About two lines at 360px. A tip that needs more is a paragraph, and paragraphs belong on the page. */
export const TIP_MAX_LENGTH = 120;

/**
 * Words a casual player would not know. A tip may use one only as the term it is explaining, since a
 * tip that leans on another piece of jargon explains nothing.
 */
const JARGON: readonly RegExp[] = [
  /\bEV\b/u,
  /\bSPR\b/u,
  /\bGTO\b/u,
  /\bequity\b/iu,
  /\bexpected value\b/iu,
  /\benumerat/iu,
  /\bvariance\b/iu,
  /\bimplied odds\b/iu,
  /\bfold equity\b/iu,
  /\bmonte carlo\b/iu,
];

/** Why `text` is not one plain sentence, as sentences a test can print. Empty means it is. */
export function tipSentenceProblems(copy: TipCopy): readonly string[] {
  const { term, text } = copy;
  const problems: string[] = [];
  if (term.trim() === '') problems.push('the tip names no term, so its button would be "About"');
  if (text.length > TIP_MAX_LENGTH) problems.push(`${text.length} characters, over ${TIP_MAX_LENGTH}`);
  if (!/^[A-Z0-9½⅓⅔]/u.test(text)) problems.push('does not start with a capital');
  if (!/[^.!?]\.$/u.test(text)) problems.push('does not end with one full stop');
  // A stop, question or exclamation mark followed by more words is a second sentence.
  if (/[.!?]["”’)]?\s+\S/u.test(text)) problems.push('has a second sentence');
  if (/[;:]/u.test(text)) problems.push('joins two sentences with a colon or semicolon');
  if (/\s{2,}/u.test(text)) problems.push('has a double space');
  for (const word of JARGON) {
    if (word.test(text) && !word.test(term))
      problems.push(`uses jargon it does not explain (${word.source})`);
  }
  return problems;
}

/** The tips `@prl/ui` components attach. Keyed by what they sit beside. */
export const UI_TIPS = {
  sizeButtons: {
    term: 'the size buttons',
    text: 'Each button sets your bet to a share of the pot, and All in puts in every chip you have.',
  },
  betBounds: {
    term: 'min and max',
    text: 'The smallest and largest amounts the rules let you put in right now.',
  },
  stackAfter: {
    term: 'stack after',
    text: 'The chips you would have left in front of you once this amount goes in.',
  },
  equity: {
    term: 'equity',
    text: 'Equity is how often your hand would win if every card still to come were dealt out.',
  },
  method: {
    term: 'exact and monte carlo',
    text: 'Exact means every possible deal was counted, and monte carlo means a large random sample was used.',
  },
  heroShare: {
    term: 'your share of the pot',
    text: 'The part of the pot your hand wins on average, with ties counted as a split.',
  },
  breakEven: {
    term: 'break-even equity',
    text: 'If your share of the pot is higher than this, calling wins chips over time.',
  },
  potOdds: {
    term: 'pot odds',
    text: 'How big the pot is compared with what it costs you to call.',
  },
  effectiveStack: {
    term: 'effective stack',
    text: 'The most you can win or lose this hand, which is the smaller of your stack and the biggest other one.',
  },
  stackToPot: {
    term: 'stack-to-pot ratio',
    text: 'Your chips left to bet divided by the pot, so a small number means you are close to all in.',
  },
} as const satisfies Readonly<Record<string, TipCopy>>;

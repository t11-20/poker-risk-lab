/**
 * The document title for `/review/[handId]`, from what the page actually found.
 *
 * ## The defect this replaced
 *
 * `generateMetadata` looked the id up in the bundled fixtures and nowhere else, so every real hand
 * — and every id the API answered 404 for, including another guest's hand — was titled "Hand
 * replay". The audit at 6b3886e opened `/review/nope` and a foreign guest's hand id: the body was
 * the 404 screen, and a screen reader announced "Hand replay" over it. The title is the first thing
 * that is read on arrival, so it was the page's first sentence and it was wrong.
 *
 * So the title now follows the same `ReviewState` the page renders from, member for member, and
 * the page shares one load between the two (`cache` in the page) rather than asking the API twice
 * for a replay that takes the server a second or two to build.
 *
 * A leaf module, because the page imports CSS and cannot be loaded under `node --test`.
 */

/** The part of the page's `ReviewState` a title depends on. */
export type ReviewTitleInput =
  | { readonly state: 'live' | 'sampled'; readonly handNumber: number }
  | { readonly state: 'missing' }
  | { readonly state: 'unavailable'; readonly cause: 'unreachable' | 'signedOut' };

/** The 404 body's heading says "Page not found"; the title says which kind of page it was. */
export const HAND_NOT_FOUND_TITLE = 'Hand not found';

export function reviewPageMetadata(input: ReviewTitleInput): {
  readonly title: string;
  readonly description?: string;
} {
  switch (input.state) {
    case 'missing':
      return { title: HAND_NOT_FOUND_TITLE };
    // The unavailable screen's own headline, so the title and the h1 say the same thing.
    case 'unavailable':
      return {
        title: input.cause === 'signedOut' ? 'This replay needs a session' : 'This hand could not be loaded',
      };
    default:
      return {
        title: `Hand ${input.handNumber}`,
        description: `Replay of hand ${input.handNumber}, decision by decision, with the analysis for your own choices.`,
      };
  }
}

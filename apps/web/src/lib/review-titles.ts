/**
 * The document title for `/review/[handId]`, following the same `ReviewState` the page renders, so a
 * 404 is never announced as "Hand replay". A leaf module, because the page imports CSS.
 */

export type ReviewTitleInput =
  | { readonly state: 'live' | 'sampled'; readonly handNumber: number }
  | { readonly state: 'missing' }
  | { readonly state: 'unavailable'; readonly cause: 'unreachable' | 'signedOut' };

/** The 404 body says "Page not found". The title says which kind of page it was. */
export const HAND_NOT_FOUND_TITLE = 'Hand not found';

export function reviewPageMetadata(input: ReviewTitleInput): {
  readonly title: string;
  readonly description?: string;
} {
  switch (input.state) {
    case 'missing':
      return { title: HAND_NOT_FOUND_TITLE };
    // The unavailable screen's own headline, so the title and the h1 agree.
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

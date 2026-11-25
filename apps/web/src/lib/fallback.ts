/**
 * Why a page shows bundled copy, with the transport message kept apart from the sentence: the message
 * carries a URL, which has no break opportunity, and at 200% text on a phone it widened the page.
 */
export interface FallbackReason {
  readonly text: string;
  readonly cause: string;
}

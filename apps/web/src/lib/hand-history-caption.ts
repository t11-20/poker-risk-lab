/**
 * The `/review` table caption. The hand list arrives a page at a time with a cursor and no total, so
 * the count is this page's, and the caption says so whenever the page is not the whole history.
 */

export interface HistoryPage {
  readonly count: number;
  readonly firstPage: boolean;
  /** The API sent a cursor for a further page. */
  readonly more: boolean;
  /** "newest", as the sort control words it. */
  readonly order: string;
}

export function historyCaption(page: HistoryPage): string {
  const hands = page.count === 1 ? 'hand' : 'hands';
  const counted = page.firstPage
    ? `${page.more ? 'The first ' : ''}${String(page.count)} ${hands}`
    : `${String(page.count)} more ${hands}`;
  return `${counted}, ordered by ${page.order}${page.more ? ', with more on the next page' : ''}.`;
}

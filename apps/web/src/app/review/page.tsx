/**
 * The hand history index. The net is never colour alone. Sign, unit and word carry it (WCAG 1.4.1),
 * and a null net reads "not settled", never 0. `?sort=` and `?cursor=` are links, and the server sorts
 * the whole history in SQL before cutting the page, so this page never re-sorts the rows it gets. The
 * cursor is a row id, not an offset, so a finishing hand does not shift rows. The reader's cookie is
 * forwarded through `readerCallOptions()` because `credentials: 'include'` does nothing server-side.
 */

import type { HandListResponse, HandSort, HandSummary } from '@prl/contracts';
import { DEFAULT_HAND_SORT, HAND_SORTS } from '@prl/contracts';
import { Chip, formatSignedUnits, formatUnits, PlayingCard, parseCardText } from '@prl/ui';
import type { Metadata } from 'next';
import type { ReactElement } from 'react';
import { ScrollRegion } from '../../components/ScrollRegion.tsx';
import { emptyHandListFixture, HAND_PAGE_SIZE, REVIEW_HAND_SUMMARIES } from '../../fixtures/review.ts';
import { API_PATHS, apiGet, isApiUnavailable, isRejectedCursor, isSignedOut } from '../../lib/api.ts';
import { formatTimestamp } from '../../lib/lab-labels.ts';
import { netWord } from '../../lib/net-words.ts';
import { readerCallOptions } from '../../lib/server-session.ts';
import '../../styles/page.css';
import '../../styles/review.css';
import { SuitMark } from '@/components/SuitMark.tsx';

export const metadata: Metadata = {
  title: 'Review your hand history',
  description:
    'Every hand you have played, with the board, the net result and whether it ended by folding. Open one to replay it decision by decision.',
};

const ROUTE = '/review';

/**
 * A scrolling region is a tab stop and needs a name (WCAG 2.1.1). The name says nothing about
 * scrolling, because below 1024px the rows are cards and the region never scrolls.
 */
const TABLE_LABEL = 'Hand history table';

const SORT_SELECT_ID = 'prl-review-sort';

/** The contract's list, so the control cannot offer an ordering the endpoint does not perform. */
const SORTS = HAND_SORTS;
type Sort = HandSort;

const SORT_LABEL: Readonly<Record<Sort, string>> = {
  recent: 'Most recent first',
  oldest: 'Oldest first',
  'net-high': 'Biggest gain first',
  'net-low': 'Biggest loss first',
  'pot-high': 'Largest pot first',
};

function readSort(value: string | string[] | undefined): Sort {
  const raw = Array.isArray(value) ? value[0] : value;
  return SORTS.find((candidate) => candidate === raw) ?? DEFAULT_HAND_SORT;
}

function readCursor(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === undefined || raw === '' ? null : raw;
}

/**
 * The fixture path only. Mirrors the server's `HAND_ORDERINGS` clause for clause, including nulls last
 * in both net orderings and a `(startedAt, id)` tiebreak in the leading column's direction.
 */
function sortHands(hands: readonly HandSummary[], sort: Sort): readonly HandSummary[] {
  const rows = [...hands];
  switch (sort) {
    case 'oldest':
      return rows.sort(byTime(1));
    case 'net-high':
      return rows.sort(nullsLast((hand) => hand.heroNet, -1));
    case 'net-low':
      return rows.sort(nullsLast((hand) => hand.heroNet, 1));
    case 'pot-high':
      return rows.sort(nullsLast((hand) => hand.potTotal, -1));
    default:
      return rows.sort(byTime(-1));
  }
}

function byTime(direction: 1 | -1): (a: HandSummary, b: HandSummary) => number {
  return (a, b) => direction * (a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
}

function nullsLast(
  key: (hand: HandSummary) => number | null,
  direction: 1 | -1,
): (a: HandSummary, b: HandSummary) => number {
  const tiebreak = byTime(direction);
  return (a, b) => {
    const left = key(a);
    const right = key(b);
    if (left === null || right === null) {
      if (left === right) return tiebreak(a, b);
      return left === null ? 1 : -1;
    }
    return direction * (left - right) || tiebreak(a, b);
  };
}

/** `'signed-out'` is not an outage, and the notice must not describe it as one. */
type FixtureReason = 'unavailable' | 'signed-out';

interface HistoryData {
  readonly response: HandListResponse;
  readonly fromFixture: FixtureReason | null;
  /** True when the API refused the cursor in the URL and this is page one in its place. */
  readonly cursorRejected: boolean;
}

/**
 * `?state=empty` shows the empty state from the fixture. It is read only on the fixture path, so it
 * cannot blank a real history.
 */
async function loadHistory(sort: Sort, cursor: string | null, forceEmpty: boolean): Promise<HistoryData> {
  // The cursor names a position in the `sort` ordering, so the two always travel together.
  const query = new URLSearchParams({ limit: String(HAND_PAGE_SIZE), sort });
  if (cursor !== null) query.set('cursor', cursor);
  try {
    const response = await apiGet<HandListResponse>(
      API_PATHS.hands(query.toString()),
      await readerCallOptions(),
    );
    return { response, fromFixture: null, cursorRejected: false };
  } catch (error) {
    // A stale or edited cursor falls back to page one. The retry has no cursor, so it cannot loop.
    if (cursor !== null && isRejectedCursor(error)) {
      return { ...(await loadHistory(sort, null, forceEmpty)), cursorRejected: true };
    }
    const signedOut = isSignedOut(error);
    if (!signedOut && !isApiUnavailable(error)) throw error;
    const reason: FixtureReason = signedOut ? 'signed-out' : 'unavailable';
    if (forceEmpty) {
      return { response: emptyHandListFixture(), fromFixture: reason, cursorRejected: false };
    }
    // Sort the whole list, then cut the page, as the endpoint does.
    const ordered = sortHands(REVIEW_HAND_SUMMARIES, sort);
    const start = cursor === null ? 0 : ordered.findIndex((row) => row.id === cursor);
    const from = start < 0 ? 0 : start;
    const page = ordered.slice(from, from + HAND_PAGE_SIZE);
    const next = ordered[from + HAND_PAGE_SIZE];
    return {
      response: { hands: page, nextCursor: next === undefined ? null : next.id },
      fromFixture: reason,
      cursorRejected: false,
    };
  }
}

/** A card that will not parse is shown as its own text, not dropped. */
function BoardCells({ board }: { readonly board: readonly string[] }): ReactElement {
  if (board.length === 0) {
    return (
      <span className="prl-review-board prl-review-board--empty">
        <span aria-hidden="true">—</span>
        <span className="prl-visually-hidden">no board: the hand ended before the flop</span>
      </span>
    );
  }
  return (
    <span className="prl-review-board">
      {board.map((notation) => {
        const card = parseCardText(notation);
        if (card === null) {
          return (
            <span className="prl-chip" key={notation}>
              {notation}
            </span>
          );
        }
        return <PlayingCard card={card} size="sm" key={notation} />;
      })}
    </span>
  );
}

function NetCell({ net }: { readonly net: number | null }): ReactElement {
  if (net === null) {
    return (
      <span className="prl-review-net" data-sign="unknown">
        not settled
      </span>
    );
  }
  const sign = net > 0 ? 'positive' : net < 0 ? 'negative' : 'neutral';
  return (
    <span className="prl-review-net" data-sign={sign}>
      <span className="prl-review-net__value">{formatSignedUnits(net)}</span>
      <span className="prl-review-net__word">{netWord(net)}</span>
    </span>
  );
}

/**
 * The column name inside the cell, for the card layout below 600px. `aria-hidden` because the header
 * row is still in the accessibility tree and already names each cell.
 */
function CellLabel({ children }: { readonly children: string }): ReactElement {
  return (
    <span className="prl-review-table__cell-label" aria-hidden="true">
      {children}
    </span>
  );
}

function sortHref(sort: Sort): string {
  return `${ROUTE}?sort=${sort}`;
}

export default async function ReviewIndexPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactElement> {
  const query = await searchParams;
  const sort = readSort(query['sort']);
  const requestedCursor = readCursor(query['cursor']);
  const forceEmpty = readCursor(query['state']) === 'empty';
  const { response, fromFixture, cursorRejected } = await loadHistory(sort, requestedCursor, forceEmpty);
  const cursor = cursorRejected ? null : requestedCursor;
  const hands = response.hands;

  return (
    <div className="prl-container prl-review-page">
      <header className="prl-page-head">
        <p className="prl-eyebrow">
          <SuitMark area="review" />
          Review
        </p>
        {/* Carries the nav's word, "Review", so the place has one name. */}
        <h1 className="prl-display-2 prl-page-head__title">Review your hand history</h1>
        <p className="prl-page-head__standfirst">
          Every hand you have finished. Open one to step through it decision by decision, with the analysis
          for your own choices and the deck proof you can check yourself.
        </p>
      </header>

      {fromFixture === null ? null : (
        <p className="prl-source-note prl-note">
          <span className="prl-label prl-label--accent">Fixture data</span>{' '}
          {fromFixture === 'signed-out'
            ? 'Hand history is private to one reader, and you are not signed in — so there is no history to read and the rows below come from '
            : 'The hands API is not reachable, so this list comes from '}
          <code className="prl-mono">src/fixtures/review.ts</code>. Two of these hands have a full review
          behind them; the rest are index rows only, which is what the second page of a real history looks
          like while it is being built.
        </p>
      )}

      {cursorRejected ? (
        <p className="prl-note">
          That page link is not one this history issued — it may be out of date, or have been edited — so this
          is the first page instead.
        </p>
      ) : null}

      {hands.length === 0 ? (
        <div className="prl-empty">
          <p>
            You have not finished a hand yet, so there is nothing to review. Hand history fills up as you play
            — every hand you complete arrives here with its own replay, the analysis for each of your
            decisions, and the deck proof for the deal.
          </p>
          <p>
            Nothing is at stake in getting here: units are free, resettable and worth nothing, and this page
            exists to be read afterwards rather than to be filled.
          </p>
          <a className="prl-btn prl-btn--primary" href="/play">
            Sit at a table
          </a>
        </div>
      ) : (
        <>
          {/* Two forms of one control, the other `display: none`. Below 600px the links wrapped to
              247px at 360x640, so a GET form with a select takes their place and needs no script. */}
          <nav className="prl-review-sorts" aria-label="Sort hand history">
            <p className="prl-label prl-review-sorts__heading">Order</p>
            <ul className="prl-review-sorts__list">
              {SORTS.map((candidate) => (
                <li key={candidate}>
                  <a
                    className="prl-review-sorts__link"
                    href={sortHref(candidate)}
                    aria-current={candidate === sort ? 'true' : undefined}
                  >
                    {SORT_LABEL[candidate]}
                  </a>
                </li>
              ))}
            </ul>
            <form className="prl-review-sorts__form" method="get" action={ROUTE}>
              <label className="prl-label" htmlFor={SORT_SELECT_ID}>
                Order
              </label>
              <select className="prl-select" id={SORT_SELECT_ID} name="sort" defaultValue={sort}>
                {SORTS.map((candidate) => (
                  <option key={candidate} value={candidate}>
                    {SORT_LABEL[candidate]}
                  </option>
                ))}
              </select>
              <button className="prl-btn prl-btn--secondary" type="submit">
                Sort
              </button>
            </form>
          </nav>

          <ScrollRegion className="prl-review-scroll" label={TABLE_LABEL}>
            <table className="prl-review-table">
              <caption>
                {`${hands.length === 1 ? '1 hand' : `${hands.length} hands`}, ordered by ${SORT_LABEL[sort].toLowerCase()}. Net is the change across the whole hand, blinds included.`}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Hand</th>
                  <th scope="col">When</th>
                  <th scope="col">Board</th>
                  {/* The class end-aligns the header over its digits. Not `:nth-child(4)`, which breaks
                      when a column is inserted. */}
                  <th className="prl-review-table__pot" scope="col">
                    Pot
                  </th>
                  <th scope="col">Net to you</th>
                  <th scope="col">Ending</th>
                </tr>
              </thead>
              <tbody>
                {hands.map((hand) => (
                  <tr key={hand.id}>
                    <th className="prl-review-table__hand" scope="row">
                      {/* The link covers the whole row (`review.css`, "THE ROW IS THE TARGET"). */}
                      <a className="prl-review-table__link" href={`${ROUTE}/${hand.id}`}>
                        {`Replay hand ${hand.handNumber}`}
                      </a>
                    </th>
                    <td className="prl-review-table__when">{formatTimestamp(hand.startedAt)}</td>
                    <td className="prl-review-table__board">
                      <BoardCells board={hand.board} />
                    </td>
                    <td className="prl-review-table__pot">
                      <CellLabel>Pot</CellLabel>
                      {formatUnits(hand.potTotal)}
                    </td>
                    <td className="prl-review-table__net">
                      <CellLabel>Net to you</CellLabel>
                      <NetCell net={hand.heroNet} />
                    </td>
                    <td className="prl-review-table__ending">
                      <Chip tone={hand.endedByFold ? 'neutral' : 'info'} glyph={hand.endedByFold ? '⤶' : '⇄'}>
                        {hand.endedByFold ? 'folded out' : 'showdown'}
                      </Chip>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollRegion>

          <nav className="prl-review-paging" aria-label="Hand history pages">
            {cursor === null ? (
              <span className="prl-review-paging__inert">First page</span>
            ) : (
              <a className="prl-btn prl-btn--ghost" href={sortHref(sort)}>
                Back to the first page
              </a>
            )}
            {response.nextCursor === null ? (
              <span className="prl-review-paging__inert">No further hands</span>
            ) : (
              <a
                className="prl-btn prl-btn--secondary"
                href={`${ROUTE}?sort=${sort}&cursor=${encodeURIComponent(response.nextCursor)}`}
              >
                Older hands
              </a>
            )}
          </nav>
        </>
      )}
    </div>
  );
}

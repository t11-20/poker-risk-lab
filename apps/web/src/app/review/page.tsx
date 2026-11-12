/**
 * The hand history index: a dense, sortable, cursor-paginated table of finished hands.
 *
 * ## The net result is never colour alone
 *
 * `heroNet` is the one figure on this page somebody could get badly wrong, so it carries three
 * independent signals: an explicit `+` or `-` in the digits, the unit word ("units"), and the word
 * "gained", "lost" or "broke even" beside it (`netWord`). The semantic colour is the fourth signal and the only one a
 * reader could be unable to perceive. Thrown away, the column still reads correctly — which is the
 * test WCAG 1.4.1 actually asks.
 *
 * `heroNet` is also nullable, and null is not zero. A hand still being settled has no net yet, and
 * rendering that as `0 units` would state that it broke even. It reads "not settled".
 *
 * ## Sorting and paging are both server concerns, expressed as query parameters
 *
 * `?sort=` and `?cursor=` are links, not state. Two reasons: a sorted, paged view is then linkable
 * and survives a reload, and the sort has to be applied to the whole history rather than to the page
 * in front of you. Sorting one page of six rows client-side would produce an ordering that changes
 * meaning as you page — the second page's "biggest win" would be smaller than the first page's
 * smallest — which is worse than no sort at all.
 *
 * With the fixture the same rule holds: the sort is applied to the whole list and then the page is
 * cut from it, in that order, exactly as a keyset-paginated endpoint would.
 *
 * The cursor is the id of the first row of the next page rather than an offset, so a hand finishing
 * while somebody is paging does not shift rows under them.
 *
 * ## `sort` is served by the API, and the control offers nothing else
 *
 * `GET /api/v1/hands?sort=` takes one of `HAND_SORTS` and applies it in SQL over the reader's whole
 * history before the page is cut (`apps/api/src/routes/hands.ts`). This page sends the name it was
 * asked for and renders what comes back; it does not re-sort the rows it was handed, and there is no
 * ordering in the control that the server does not perform.
 *
 * That is the second half of a defect worth remembering. The schema for this endpoint was closed and
 * had no `sort`, so the `sort=` this page used to append came back `invalid_request` — invisible for
 * as long as every request 404'd on the wrong path, and a 400 on a working screen once the path was
 * fixed. The response at the time was to stop sending it, which left five orderings in the interface
 * and one performed by the server: four of the five labels named an ordering that nothing produced.
 * Removing the parameter and keeping the control is the worse of the two failures, because it looks
 * like it works.
 *
 * ## The session comes from the request, not from a browser
 *
 * Hand history is per-reader, and `credentials: 'include'` does nothing in a server-side `fetch`. So
 * this render forwards the reader's own session cookie through `readerCallOptions()` — see
 * `src/lib/server-session.ts` for the boundary that keeps that from becoming a general credential
 * forwarder. `signed-out` is now a real answer about this reader rather than a permanent property of
 * server rendering.
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

export const metadata: Metadata = {
  title: 'Hand history',
  description:
    'Every hand you have played, with the board, the net result and whether it ended by folding. Open one to replay it decision by decision.',
};

const ROUTE = '/review';

/**
 * The scroll container's accessible name.
 *
 * The region is a tab stop only while it scrolls sideways (`ScrollRegion`, and the 360px finding in
 * `../../lib/scroll-region.ts`), and whenever it is one it needs a name: a scrollable region has to
 * be keyboard-reachable (axe `scrollable-region-focusable`, WCAG 2.1.1) and an unnamed tab stop is a
 * silent one. The name stays when the stop goes, so a screen reader still finds the table as a
 * named region. Same problem as the EV table in `@prl/ui`'s CoachPanel, which is always a table.
 *
 * The name says nothing about scrolling: below 1024px the rows are cards and the region never
 * scrolls, so "scrolls sideways when the window is too narrow" was read out as a false sentence on
 * every phone.
 */
const TABLE_LABEL = 'Hand history table';

/** The narrow layout's sort `<select>`, for its `<label>`. One per page, so a constant is enough. */
const SORT_SELECT_ID = 'prl-review-sort';

/**
 * The orderings the page offers — the contract's list, not a second copy of it.
 *
 * Imported rather than re-declared so the control cannot offer a name the endpoint does not
 * accept, and cannot omit one it does. `SORT_LABEL` is annotated `Record<HandSort, string>`, so a
 * new ordering on the wire without a label here is a compile error rather than a blank link.
 */
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
 * Sorts the whole fixture history, mirroring the five clauses in `HAND_ORDERINGS` on the server.
 *
 * Only the offline path uses this. It exists so the control means the same thing whichever source
 * answered — a fixture that sorted differently from the endpoint would make the fallback teach a
 * different ordering under the same label — and it mirrors the server clause for clause: the same
 * nulls-last rule, and the same rule that the `(startedAt, id)` tiebreak runs in the same direction
 * as the leading column, so a page boundary falls in the same place.
 *
 * An unsettled hand (`heroNet === null`) sorts LAST in both net orderings, not first in one of them.
 * It has no net; slotting it among the break-even hands would invent one, and sorting it to the
 * front of "biggest loss first" would state that it was the worst.
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

/** `(startedAt, id)`, both in `direction`. The tiebreak every ordering below ends with. */
function byTime(direction: 1 | -1): (a: HandSummary, b: HandSummary) => number {
  return (a, b) => direction * (a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
}

/** `key` in `direction`, nulls after everything, then the timestamp tiebreak in the same direction. */
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

/**
 * Why a fixture was used, when one was.
 *
 * `'signed-out'` is not an outage and must not be described as one. Hand history is per-reader, and
 * this render forwards the reader's own session cookie, so `not_authenticated` now means exactly
 * what it says: whoever is looking at this page has not signed in. The notice says which of the two
 * it is, and no longer claims the server render is the reason.
 */
type FixtureReason = 'unavailable' | 'signed-out';

interface HistoryData {
  readonly response: HandListResponse;
  readonly fromFixture: FixtureReason | null;
  /** True when the API refused the cursor in the URL and this is page one in its place. */
  readonly cursorRejected: boolean;
}

/**
 * `?state=empty` renders the no-hands-yet state from the fixture.
 *
 * The empty state is a real deliverable — a reader arriving with no history must not meet a broken
 * table — and it is unreachable otherwise, because the fixture always has hands and the API is not
 * built. This is the same `?state=` affordance the Play screen uses for its loading, error and
 * completed states, and it is safe for the same reason: the parameter is only consulted on the
 * fixture path, so once the API answers it is ignored entirely and cannot blank a real history.
 */
async function loadHistory(sort: Sort, cursor: string | null, forceEmpty: boolean): Promise<HistoryData> {
  // Everything `prl:handListQuery` accepts that this page has an opinion about. `sort` is applied by
  // the database over the whole history; the cursor the server hands back names a position in that
  // same ordering, which is why the two always travel together.
  const query = new URLSearchParams({ limit: String(HAND_PAGE_SIZE), sort });
  if (cursor !== null) query.set('cursor', cursor);
  try {
    const response = await apiGet<HandListResponse>(
      API_PATHS.hands(query.toString()),
      await readerCallOptions(),
    );
    return { response, fromFixture: null, cursorRejected: false };
  } catch (error) {
    // An edited or stale `?cursor=` — see `isRejectedCursor`. Page one, once, and the page says so.
    // The retry carries no cursor, so it cannot come back here.
    if (cursor !== null && isRejectedCursor(error)) {
      return { ...(await loadHistory(sort, null, forceEmpty)), cursorRejected: true };
    }
    const signedOut = isSignedOut(error);
    if (!signedOut && !isApiUnavailable(error)) throw error;
    const reason: FixtureReason = signedOut ? 'signed-out' : 'unavailable';
    if (forceEmpty) {
      return { response: emptyHandListFixture(), fromFixture: reason, cursorRejected: false };
    }
    // Sort the whole list, then cut the page from it — the order a paginated endpoint uses, and the
    // only order in which a cursor means anything. `sortHands` mirrors the server's five clauses so
    // the control means the same thing on both paths.
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

/** The board as small cards. A card that will not parse is shown as its own text, not dropped. */
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

/** The net cell: sign, unit and word, with the colour as the fourth signal rather than the only one. */
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
 * A column's name, printed inside the cell for the narrow layout only.
 *
 * Below 600px the header row is visually hidden and each row is drawn as a card, so a bare
 * "1,520 units" no longer sits under a "Pot" a reader can see. `aria-hidden`, because the header
 * row is still in the accessibility tree and a screen reader already announces each cell with its
 * column header — "Pot" twice is noise. `review.css` hides it from 600px up.
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
  // The page shown is page one when the cursor was refused, so the paging links must say so too.
  const cursor = cursorRejected ? null : requestedCursor;
  const hands = response.hands;

  return (
    // `prl-review-page` is the hook `review.css` needs to lay this page's opener out without editing
    // `page.css`, which the Lab shares. It carries no styling of its own — see section 0 there.
    <div className="prl-container prl-review-page">
      <header className="prl-page-head">
        <p className="prl-eyebrow">
          <span className="prl-index" aria-hidden="true">
            05
          </span>{' '}
          Review
        </p>
        <h1 className="prl-display-2 prl-page-head__title">Hand history</h1>
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
          {/* Two forms of one control, and only one is rendered at a time: the other is
              `display: none`, so it is out of the tab order and the accessibility tree, not merely out
              of sight. The links are one press per ordering and fit one row from 600px up. Below that
              they wrapped to five rows — measured at 360x640 on the fixture history, 247px of control,
              and the first hand started at y=931 under a 640px fold. The select is one row and still
              needs no script: a GET form, so the ordering stays a link a reader can share and the
              server still applies it to the whole history. */}
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
                  {/* The class is on the header as well as on the cells so the label sits over the
                      column it names: `.prl-review-table__pot` end-aligns a tabular figure, and a
                      start-aligned "Pot" above end-aligned digits is the misalignment the rule was
                      added to remove. Adding the class beats an `:nth-child(4)` in the stylesheet,
                      which would silently point at the wrong column the day one is inserted. */}
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
                      {/* The words are visible and the link covers the whole row — `review.css`, "THE
                          ROW IS THE TARGET". Measured before: the way into a hand was its number, a
                          21x44px target at every width, while the rest of the row did nothing and
                          still lit up on hover as though it would. */}
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

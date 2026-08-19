/**
 * `/play` — the table screen.
 *
 * A Server Component. It owns the page's single `h1`, decides whether this request wants the live
 * table or one of the reviewable fixture states, and renders one of them. `@prl/ui` components emit
 * `h2` and below, so the heading outline is h1 (here) -> h2 (the connection panel, the table, the
 * Coach) -> h3 (the Coach's sections).
 *
 * ## The live table is the page
 *
 * `/play` opens a real WebSocket to `/api/v1/ws`, sits the reader down at a private six-handed room
 * with five bots, and plays hands driven entirely by the server. That is `LiveTable.tsx`, which is
 * the client boundary because a socket, a bet sizer, a sheet and a turn clock all need state.
 *
 * This route used to render from `src/fixtures/table.ts` in every case, with a header explaining
 * that the socket was still being built. It has landed, so that explanation is gone rather than
 * softened: a comment describing a state the code is no longer in is worse than no comment, because
 * the next reader believes it.
 *
 * ## Why the fixture states are still addressable, and how they are kept honest
 *
 * `?state=loading|error|complete|decision` renders the typed fixture instead of connecting. Those
 * are not a fallback the live path can slip into — nothing here can choose them, only an explicit
 * query parameter can — and they exist for two reasons that survive the socket landing:
 *
 *   - A state you cannot navigate to is a state nobody reviews. Loading, unreachable and
 *     completed-hand are all states a reader will meet, and they are hard to produce on demand
 *     against a live server.
 *   - The static accessibility audit crawls them, so it checks four renderings of this screen
 *     rather than one.
 *
 * Every fixture rendering says at the top of the page, not in a collapsed disclosure, that there is
 * no server behind it — a fixture that is merely *labelled quietly* is how a review found six
 * scenarios in a product that ships thirty-six.
 *
 * ## `searchParams` is a promise in this version of Next
 *
 * It is awaited rather than read synchronously (the synchronous form is deprecated), and reading it
 * opts the route into dynamic rendering at request time — which is correct here: a live table is not
 * a static page, and every state below depends on the request.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactElement } from 'react';
import { TableStage, type TableStageStatus } from '@/components/TableStage.tsx';
import {
  COMPLETED_HAND_ANNOUNCEMENT,
  COMPLETED_HAND_HIGHLIGHT,
  COMPLETED_HAND_SUMMARY,
  COMPLETED_HAND_VIEW,
  FLOP_DECISION_ANNOUNCEMENT,
  FLOP_DECISION_REPORT,
  FLOP_DECISION_TURN,
  FLOP_DECISION_VIEW,
  isTableStateName,
  SEAT_NAMES,
  TABLE_ERROR_MESSAGE,
  TABLE_STATES,
  type TableStateName,
} from '@/fixtures/table.ts';
import { LiveTable } from './LiveTable.tsx';
import '@/styles/play.css';

export const metadata: Metadata = {
  title: 'Play',
  description:
    'A six-handed play-money table with the Coach beside it: equity with its interval, the price, ' +
    'the expected value of every line, and the assumptions all of them rest on.',
};

interface PlayPageProps {
  readonly searchParams: Promise<{ readonly [key: string]: string | string[] | undefined }>;
}

/** One sentence per fixture state, shown under the `h1` so the screen says what it is showing. */
const STATE_LEDE: Readonly<Record<TableStateName, string>> = {
  decision:
    'A fixed decision on the flop. The Coach panel prices it: what the hand is worth, what the call ' +
    'costs, and what every line is worth against folding.',
  loading: 'Waiting for the table. The blocks below are the size of the content that will replace them.',
  error: 'The table is unreachable. Nothing was staked and nothing was sent.',
  complete:
    'The hand is over, with three hands shown and the pot split into two layers. The analysis beside it ' +
    'is where the useful feedback is, not the result.',
};

const LIVE_LEDE =
  'A private table against five bots, dealt and settled by the server. Every card, every stack, ' +
  'every pot and every legal action on this screen arrived over the socket — nothing here is decided ' +
  'in your browser.';

/** What each fixture state hands to the stage. Built here so the page reads as one table of cases. */
function stagePropsFor(state: TableStateName): {
  readonly status: TableStageStatus;
  readonly view: typeof FLOP_DECISION_VIEW | null;
  readonly report: typeof FLOP_DECISION_REPORT | null;
} {
  if (state === 'loading') return { status: 'loading', view: null, report: null };
  if (state === 'error') return { status: 'error', view: null, report: null };
  if (state === 'complete') {
    return { status: 'complete', view: COMPLETED_HAND_VIEW, report: FLOP_DECISION_REPORT };
  }
  return { status: 'ready', view: FLOP_DECISION_VIEW, report: FLOP_DECISION_REPORT };
}

/** The list of fixture renderings, used from both branches so the audit can crawl all four. */
function FixtureLinks({ current }: { readonly current: TableStateName | null }): ReactElement {
  return (
    <ul className="prl-play__states">
      {TABLE_STATES.map((name) => (
        <li key={name}>
          <Link
            className="prl-btn prl-btn--secondary prl-btn--sm"
            href={`/play?state=${name}`}
            aria-current={name === current ? 'page' : undefined}
          >
            {name}
          </Link>
        </li>
      ))}
      <li>
        <Link
          className="prl-btn prl-btn--secondary prl-btn--sm"
          href="/play"
          aria-current={current === null ? 'page' : undefined}
        >
          live table
        </Link>
      </li>
    </ul>
  );
}

/** The fixture rendering. Reachable only by an explicit `?state=`, and it says so on the page. */
function FixturePage({ state }: { readonly state: TableStateName }): ReactElement {
  const stage = stagePropsFor(state);
  const isComplete = state === 'complete';

  return (
    <div className="prl-play">
      <header className="prl-play__head">
        <p className="prl-play__eyebrow">
          <span className="prl-index" aria-hidden="true">
            02
          </span>
          <span className="prl-label">Play — fixture</span>
        </p>
        <h1 className="prl-play__title">Six-handed table</h1>
        <p className="prl-play__lede">{STATE_LEDE[state]}</p>
      </header>

      {/*
        Stated at the top and never collapsed. `onAct` is absent from the stage below, which is what
        "no server" means in code; this says the same thing to a reader before they press anything.
      */}
      <div className="prl-error">
        <p className="prl-error__title">
          <span aria-hidden="true">{'▲ '}</span>
          Fixture — no server is connected
        </p>
        <p>
          This is a typed fixture used for design and accessibility review, not a table. A decision submitted
          here is not applied anywhere and no socket is open. The live table is at{' '}
          <Link href="/play">/play</Link>.
        </p>
      </div>

      <TableStage
        status={stage.status}
        view={stage.view}
        report={stage.report}
        seatNames={SEAT_NAMES}
        turn={state === 'decision' ? FLOP_DECISION_TURN : null}
        announcement={isComplete ? COMPLETED_HAND_ANNOUNCEMENT : FLOP_DECISION_ANNOUNCEMENT}
        {...(isComplete
          ? {
              highlightedCards: COMPLETED_HAND_HIGHLIGHT,
              highlightLabel: 'part of the winning hand',
              summary: COMPLETED_HAND_SUMMARY,
            }
          : {})}
        {...(state === 'error' ? { errorMessage: TABLE_ERROR_MESSAGE } : {})}
      />

      <details className="prl-disclose">
        <summary className="prl-disclose__summary">The other fixture states</summary>
        <div className="prl-disclose__body">
          <p>
            Each is a real state this screen has to handle, addressable so it can be reviewed and audited.
          </p>
          <FixtureLinks current={state} />
        </div>
      </details>
    </div>
  );
}

/** The difficulties `POST /legends/matches` accepts. Mirrors `LiveTable`'s own prop type. */
type MatchDifficulty = 'educational' | 'realistic' | 'expert';

/**
 * A narrowing predicate, rather than the `===` chain that used to be written inline.
 *
 * The inline form did not typecheck, and the reason is worth recording because it looks like it
 * should: TypeScript narrows the *reference* `difficulty` inside the conditional, but a fresh
 * object literal built from it widens the property straight back to `string`. So
 * `{ profileId: profile, difficulty }` was inferred as `{ difficulty: string }` and failed against
 * `LiveTable`'s literal union under `exactOptionalPropertyTypes`. A type predicate carries the
 * narrowing across the literal because the return type says what the value is, rather than
 * leaving it to be re-inferred.
 */
function isMatchDifficulty(value: string | undefined): value is MatchDifficulty {
  return value === 'educational' || value === 'realistic' || value === 'expert';
}

/** The first value of a repeated query parameter, or undefined. `?a=1&a=2` is a caller mistake. */
function firstValue(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw;
}

export default async function PlayPage({ searchParams }: PlayPageProps): Promise<ReactElement> {
  const params = await searchParams;
  const requested = params['state'];
  const asked = Array.isArray(requested) ? requested[0] : requested;

  // Only an explicit, valid `?state=` reaches the fixture. Anything else — including a typo — gets
  // the live table, because a fixture that a wrong URL can fall into is a fixture that ships.
  if (isTableStateName(asked)) return <FixturePage state={asked} />;

  const profile = firstValue(params['profile']);
  const difficulty = firstValue(params['difficulty']);
  const legendMatch =
    profile !== undefined && isMatchDifficulty(difficulty) ? { profileId: profile, difficulty } : undefined;

  return (
    <div className="prl-play">
      <header className="prl-play__head">
        <p className="prl-play__eyebrow">
          <span className="prl-index" aria-hidden="true">
            02
          </span>
          <span className="prl-label">Play</span>
        </p>
        <h1 className="prl-play__title">
          {legendMatch === undefined ? 'Six-handed table' : 'Heads-up against this style'}
        </h1>
        <p className="prl-play__lede">{LIVE_LEDE}</p>
      </header>

      <LiveTable {...(legendMatch === undefined ? {} : { legendMatch })} />

      <details className="prl-disclose">
        <summary className="prl-disclose__summary">Fixture renderings, for design and audit</summary>
        <div className="prl-disclose__body">
          <p>
            Four states this screen has to handle, rendered from a typed fixture so they can be reviewed
            without waiting for a live table to reach them. They are not what this page is showing, and no
            link below opens a socket.
          </p>
          <FixtureLinks current={null} />
        </div>
      </details>
    </div>
  );
}

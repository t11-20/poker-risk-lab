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

import type { LegendDifficultyDto } from '@prl/contracts';
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
import { disclaimerFraming } from '@/lib/disclaimer-framing.ts';
import { legendMatchCopy } from '@/lib/legend-match-copy.ts';
import {
  findProfile,
  LEGENDS_PATH,
  loadLegendProfiles,
  MATCH_DIFFICULTY_PARAM,
  MATCH_PROFILE_PARAM,
  profileHref,
} from '@/lib/legends-data.ts';
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
    'The hand is over, with three hands shown and the pot split into two layers. There is no decision ' +
    'left for the Coach to price; the useful feedback is in the hand’s review, not in the result.',
};

/**
 * The six-handed table's lede. A legend match has its own — see `legendMatchCopy`.
 *
 * True of every table this page can seat the reader at, because it is rendered before any room
 * exists. It said "A private table against five bots", which the private table (two bots) and a
 * friend's table reached by code are not (audit at 308fadf). Who is actually at the table is in the
 * Room line of the connection panel, from `describeTable`, once there is a table to describe.
 */
const LIVE_LEDE =
  'A play-money table dealt and settled by the server: five bots to practise against, or a private ' +
  'table with seats kept for people you invite. Every card, every stack, every pot and every legal ' +
  'action on this screen arrived over the socket — nothing here is decided in your browser.';

/** What each fixture state hands to the stage. Built here so the page reads as one table of cases. */
function stagePropsFor(state: TableStateName): {
  readonly status: TableStageStatus;
  readonly view: typeof FLOP_DECISION_VIEW | null;
  readonly report: typeof FLOP_DECISION_REPORT | null;
} {
  if (state === 'loading') return { status: 'loading', view: null, report: null };
  if (state === 'error') return { status: 'error', view: null, report: null };
  if (state === 'complete') {
    // No report: a finished hand has no decision to price, and the stage says so on its own.
    return { status: 'complete', view: COMPLETED_HAND_VIEW, report: null };
  }
  return { status: 'ready', view: FLOP_DECISION_VIEW, report: FLOP_DECISION_REPORT };
}

/**
 * The legend match's head: the style the reader picked, the setting, and the framing, from the same
 * profiles response `/legends` rendered. An outage falls back to the bundled profiles inside
 * `loadLegendProfiles`; anything else it throws is caught here and costs only the archetype name,
 * because a heading is not worth failing the table over.
 *
 * ## `specific`: the profile's own disclaimers, every one but the universal
 *
 * The framing line restates the universal disclaimer in one sentence. A profile can carry more —
 * the course-derived notice on "Fundamentals-First Study Model", the attribution notice in
 * attributed naming mode — and until "Start a match" on `/legends` (PR #41) the only way here was a
 * card or a profile page that had printed them in full above its Play link. The form lists every
 * profile by name, so a reader could pick that one and be dealt in without either screen saying it
 * is not affiliated with any course provider (Devin Review on #41). They are printed here, in full,
 * so every path to a legend table passes them, whichever page it started from.
 */
async function legendHead(profileId: string, difficulty: MatchDifficulty) {
  let archetypeName: string | null = null;
  let setting: LegendDifficultyDto | null = null;
  let specific: readonly string[] = [];
  try {
    const profiles = await loadLegendProfiles();
    const profile = findProfile(profiles.data.profiles, profileId);
    archetypeName = profile?.disclosure.archetypeName ?? null;
    setting = profiles.data.difficulties.find((entry) => entry.id === difficulty) ?? null;
    if (profile !== null) {
      specific = disclaimerFraming(profile.disclosure.disclaimers, profiles.data.universalDisclaimer).inFull;
    }
  } catch {
    // Fail in the safe direction: a generic heading, still framed, and the table still loads.
  }
  return {
    known: archetypeName !== null,
    copy: legendMatchCopy({ profileId, archetypeName, difficulty, setting }),
    specific,
  };
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

  const profile = firstValue(params[MATCH_PROFILE_PARAM]);
  const difficulty = firstValue(params[MATCH_DIFFICULTY_PARAM]);
  const legendMatch =
    profile !== undefined && isMatchDifficulty(difficulty) ? { profileId: profile, difficulty } : undefined;
  const legend =
    legendMatch === undefined ? null : await legendHead(legendMatch.profileId, legendMatch.difficulty);
  // One live table per match. `/play?profile=…` and `/play` are the same route, so a client-side
  // navigation between them re-renders this page and React keeps `<LiveTable>` mounted: the legend
  // match's "open the bot table" link changed the heading to "Six-handed table" while
  // `useLiveTable` kept the match's room and its socket (Devin Review on #24). A new key unmounts
  // it, which closes the socket and aborts any setup in flight, and the next start chooses afresh.
  const tableKey =
    legendMatch === undefined ? 'bot-table' : `legend:${legendMatch.profileId}:${legendMatch.difficulty}`;

  return (
    <div className="prl-play">
      <header className="prl-play__head">
        <p className="prl-play__eyebrow">
          <span className="prl-index" aria-hidden="true">
            02
          </span>
          <span className="prl-label">{legend === null ? 'Play' : legend.copy.eyebrow}</span>
        </p>
        <h1 className="prl-play__title">{legend === null ? 'Six-handed table' : legend.copy.heading}</h1>
        <p className="prl-play__lede">{legend === null ? LIVE_LEDE : legend.copy.lede}</p>
        {legend === null || legendMatch === undefined ? null : (
          <p className="prl-play__framing prl-note">
            {`${legend.copy.framing} `}
            {legend.known ? (
              <>
                <Link href={profileHref(legendMatch.profileId, legendMatch.difficulty)}>
                  The profile in full
                </Link>
                {' · '}
              </>
            ) : null}
            <Link href={LEGENDS_PATH}>Choose another opponent</Link>
          </p>
        )}
        {legend?.specific.map((disclaimer) => (
          <p className="prl-play__framing prl-note" key={disclaimer}>
            {disclaimer}
          </p>
        ))}
      </header>

      <LiveTable key={tableKey} {...(legendMatch === undefined ? {} : { legendMatch })} />

      {/*
        Deliberately public, and deliberately below the table with a rule above it. The four fixture
        states are an audit surface: `test:ax`, `test:keyboard` and `test:layout` crawl
        `/play?state=…` on the PRODUCTION build (`next start`), so they cannot be hidden outside
        development without hiding them from the gates that check them, and a reviewer reaches them
        from here. What was wrong was only that they read as part of the table; the separator and the
        "For reviewers" label say they are not.
      */}
      <div className="prl-play__review-states">
        <p className="prl-label">For reviewers</p>
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
    </div>
  );
}

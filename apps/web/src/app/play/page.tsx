/**
 * `/play`. Owns the page's single `h1`, and `@prl/ui` emits `h2` and below. The live table is
 * `LiveTable.tsx`. `?state=loading|error|complete|decision` renders a typed fixture so the audits can
 * crawl hard-to-reach states, and only an explicit valid value reaches it. A fixture says so at the
 * top of the page, never in a collapsed disclosure.
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
import {
  LEGENDS_PATH,
  MATCH_DIFFICULTY_PARAM,
  MATCH_PROFILE_PARAM,
  profileHref,
} from '@/lib/legend-links.ts';
import { legendMatchCopy } from '@/lib/legend-match-copy.ts';
import { findProfile, loadLegendProfiles } from '@/lib/legends-data.ts';
import { LiveTable } from './LiveTable.tsx';
import '@/styles/play.css';
import { SuitMark } from '@/components/SuitMark.tsx';

export const metadata: Metadata = {
  title: 'Play',
  description:
    'A six-handed play-money table with the Coach beside it: equity with its interval, the price, ' +
    'the expected value of every line, and the assumptions all of them rest on.',
};

interface PlayPageProps {
  readonly searchParams: Promise<{ readonly [key: string]: string | string[] | undefined }>;
}

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
 * Rendered before any room exists, so it must be true of the bot table, a private table and a
 * friend's table. `describeTable` says who is actually seated.
 */
const LIVE_LEDE =
  'A play-money table dealt and settled by the server: five bots to practise against, or a private ' +
  'table with seats kept for people you invite. Every card, every stack, every pot and every legal ' +
  'action on this screen arrived over the socket — nothing here is decided in your browser.';

function stagePropsFor(state: TableStateName): {
  readonly status: TableStageStatus;
  readonly view: typeof FLOP_DECISION_VIEW | null;
  readonly report: typeof FLOP_DECISION_REPORT | null;
} {
  if (state === 'loading') return { status: 'loading', view: null, report: null };
  if (state === 'error') return { status: 'error', view: null, report: null };
  if (state === 'complete') {
    return { status: 'complete', view: COMPLETED_HAND_VIEW, report: null };
  }
  return { status: 'ready', view: FLOP_DECISION_VIEW, report: FLOP_DECISION_REPORT };
}

/**
 * A failure here costs only the archetype name, never the table. `specific` is every disclaimer but
 * the universal one, printed in full because "Start a match" can reach this page without passing a
 * card or profile page that showed them.
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
    // Safe direction. The heading goes generic but stays framed, and the table still loads.
  }
  return {
    known: archetypeName !== null,
    copy: legendMatchCopy({ profileId, archetypeName, difficulty, setting }),
    specific,
  };
}

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

function FixturePage({ state }: { readonly state: TableStateName }): ReactElement {
  const stage = stagePropsFor(state);
  const isComplete = state === 'complete';

  return (
    <div className="prl-play">
      <header className="prl-play__head">
        <p className="prl-play__eyebrow">
          <SuitMark area="play" />
          <span className="prl-label">Play — fixture</span>
        </p>
        <h1 className="prl-play__title">Six-handed table</h1>
        <p className="prl-play__lede">{STATE_LEDE[state]}</p>
      </header>

      {/* Never collapsed. The stage below has no `onAct`, which is "no server" in code. */}
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

/** Mirrors `LiveTable`'s own prop type. */
type MatchDifficulty = 'educational' | 'realistic' | 'expert';

/**
 * A predicate, because an inline `===` chain does not narrow the property of a fresh object literal,
 * which then fails `LiveTable`'s union under `exactOptionalPropertyTypes`.
 */
function isMatchDifficulty(value: string | undefined): value is MatchDifficulty {
  return value === 'educational' || value === 'realistic' || value === 'expert';
}

function firstValue(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw;
}

export default async function PlayPage({ searchParams }: PlayPageProps): Promise<ReactElement> {
  const params = await searchParams;
  const showFixtures = process.env.NODE_ENV !== 'production' || params.fixtures !== undefined;
  const requested = params['state'];
  const asked = Array.isArray(requested) ? requested[0] : requested;

  // A typo gets the live table, so no wrong URL can fall into a fixture.
  if (isTableStateName(asked)) return <FixturePage state={asked} />;

  const profile = firstValue(params[MATCH_PROFILE_PARAM]);
  const difficulty = firstValue(params[MATCH_DIFFICULTY_PARAM]);
  const legendMatch =
    profile !== undefined && isMatchDifficulty(difficulty) ? { profileId: profile, difficulty } : undefined;
  const legend =
    legendMatch === undefined ? null : await legendHead(legendMatch.profileId, legendMatch.difficulty);
  // `/play?profile=…` and `/play` are one route, so React would keep the table mounted with the
  // match's socket. A new key per match closes it and aborts any setup in flight.
  const tableKey =
    legendMatch === undefined ? 'bot-table' : `legend:${legendMatch.profileId}:${legendMatch.difficulty}`;

  return (
    <div className="prl-play">
      <header className="prl-play__head">
        <p className="prl-play__eyebrow">
          <SuitMark area="play" />
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
        The fixture routes stay public because the audits crawl them on the production build. This
        panel shows only in development or with `?fixtures`, so learners do not see the harness.
      */}
      {showFixtures ? (
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
      ) : null}
    </div>
  );
}

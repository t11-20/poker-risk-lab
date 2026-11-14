/**
 * One Legends profile in full. The archetype name is the `h1` and the attributed name a label beneath
 * it, and the counter-strategy section is required. The simulated measurement and the reader's own
 * play are separate sections, so one is never shown under the other's caption. No likeness, no
 * ranking or score, and no first-person commentary.
 */

import type { LearnFromProfileResponse, LegendProfileCardDto, ProfileObservedStats } from '@prl/contracts';
import {
  Callout,
  Chip,
  formatChips,
  formatPoints,
  formatProbability,
  Metric,
  NOT_A_PROBABILITY,
  Panel,
  pluralise,
  RadarChart,
  withKeys,
} from '@prl/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Fragment, type ReactElement } from 'react';
import { NotFoundBody } from '@/app/not-found.tsx';
import { LegendSigil } from '@/components/LegendSigil.tsx';
import { ProfileDisclaimers } from '@/components/ProfileDisclaimers.tsx';
import { TraitBars } from '@/components/TraitBars.tsx';
import { LEGEND_PROFILE_FIXTURES } from '@/fixtures/legends.ts';
import {
  compareHref,
  LEGENDS_HAND_REVIEW_PATH,
  LEGENDS_PATH,
  legendMatchHref,
  MATCH_DIFFICULTY_PARAM,
  parseDifficulty,
  profileHref,
  type SearchParams,
} from '@/lib/legend-links.ts';
import {
  findProfile,
  loadLearnFromProfile,
  loadLegendProfiles,
  loadProfileStats,
} from '@/lib/legends-data.ts';

const TRAIT_DECIMALS = 2;

interface RouteParams {
  readonly profileId: string;
}

export function generateStaticParams(): { profileId: string }[] {
  return LEGEND_PROFILE_FIXTURES.map((profile) => ({ profileId: profile.id }));
}

export const dynamicParams = false;

const BEST_FOR_WORD: Readonly<Record<LegendProfileCardDto['bestFor'], string>> = {
  'heads-up': 'Best met heads-up',
  'six-max': 'Best met six-max',
  both: 'Heads-up or six-max',
};

/**
 * The archetype, never the attributed name. A tab title truncates the "(modelled style)" framing, and
 * a bare attributed name there reads as a claim about a person.
 */
export async function generateMetadata({
  params,
}: {
  readonly params: Promise<RouteParams>;
}): Promise<Metadata> {
  const { profileId } = await params;
  const profiles = await loadLegendProfiles();
  const profile = findProfile(profiles.data.profiles, profileId);
  if (profile === null) return { title: 'Profile not found' };
  return {
    title: profile.disclosure.archetypeName,
    description: `${profile.disclosure.tagline} An educational strategy simulation described by sixteen trait values.`,
  };
}

/**
 * Seven rows are frequencies. `averageBetSizeAsPotFraction` is a mean of pot fractions, legitimately
 * above 1 (1.0685 for old-school-pressure), so it must not go through the probability domain, and the
 * binomial `confidenceHalfWidth` does not describe it.
 */
type ObservedKind = 'frequency' | 'potFraction';

/** Words, not a dash, because a bare dash reads as a missing measurement. */
const NO_INTERVAL = 'not a frequency';

interface ObservedRow {
  readonly label: string;
  readonly value: number;
  readonly note: string;
  readonly kind: ObservedKind;
}

function observedRows(observed: ProfileObservedStats): readonly ObservedRow[] {
  return [
    {
      label: 'Hands entered voluntarily',
      value: observed.vpip,
      note: 'Its VPIP over the run.',
      kind: 'frequency',
    },
    {
      label: 'Hands raised preflop',
      value: observed.pfr,
      note: 'Its PFR, which cannot exceed the row above.',
      kind: 'frequency',
    },
    {
      label: 'Re-raised preflop',
      value: observed.threeBetFrequency,
      note: 'How often it three-bet an opener.',
      kind: 'frequency',
    },
    {
      label: 'Aggression',
      value: observed.aggressionFrequency,
      note: 'Bets and raises as a share of its actions.',
      kind: 'frequency',
    },
    {
      label: 'Bluffing',
      value: observed.bluffFrequency,
      note: 'Bets with a hand that could not win at showdown.',
      kind: 'frequency',
    },
    {
      label: 'Reached showdown',
      value: observed.wentToShowdown,
      note: 'How often the hand was decided by cards.',
      kind: 'frequency',
    },
    {
      label: 'Folded to a bet',
      value: observed.foldToBetFrequency,
      // Not the card's fold-under-pressure trait, which counts only made hands. Pairing them makes
      // calling-station look fifteen intervals off its own card (`stats.ts`).
      note: 'How often it folded facing a bet, on any street. Not the fold-under-pressure trait on its card, which is about giving up a made hand.',
      kind: 'frequency',
    },
    {
      label: 'Average bet size',
      value: observed.averageBetSizeAsPotFraction,
      note: 'As a fraction of the pot, across every bet it made. A pot-sized bet is 1.00.',
      kind: 'potFraction',
    },
  ];
}

function observedFigure(row: ObservedRow): string {
  if (row.kind === 'frequency') return formatProbability(row.value) ?? NOT_A_PROBABILITY;
  // `formatChips` still refuses a non-finite value.
  return `${formatChips(row.value, { decimals: 2 })} × pot`;
}

/** `caption` and `note` are props, so the provenance comes from the caller that knows it. */
function ObservedTable({
  observed,
  caption,
  note,
}: {
  readonly observed: ProfileObservedStats;
  readonly caption: string;
  readonly note: string;
}): ReactElement {
  const halfWidth = formatPoints(observed.confidenceHalfWidth * 100);
  return (
    <div className="prl-stack">
      <p className="prl-legend-observed__note">
        {`${note} Every FREQUENCY below carries the same sampling interval of ${halfWidth}, and several of the differences between profiles are narrower than that — which is the whole reason the interval is printed rather than implied. The average bet size is a mean of pot fractions rather than a frequency, so that interval does not describe it and is not printed against it.`}
      </p>
      <div className="prl-legend-table-wrap">
        <table className="prl-legend-table">
          <caption>{caption}</caption>
          <thead>
            <tr>
              <th scope="col">Frequency</th>
              <th className="prl-legend-table__figure" scope="col">
                Observed
              </th>
              <th className="prl-legend-table__figure" scope="col">
                Interval
              </th>
              <th scope="col">What it counts</th>
            </tr>
          </thead>
          <tbody>
            {observedRows(observed).map((row) => (
              <tr key={row.label}>
                <th scope="row">{row.label}</th>
                <td className="prl-legend-table__figure">{observedFigure(row)}</td>
                <td className="prl-legend-table__figure">
                  {row.kind === 'frequency' ? `± ${halfWidth}` : NO_INTERVAL}
                </td>
                <td>{row.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ContrastSection({
  contrasts,
}: {
  readonly contrasts: LearnFromProfileResponse['contrasts'];
}): ReactElement {
  return (
    <div className="prl-legend-contrast">
      {contrasts.map((contrast) => (
        <div className="prl-legend-contrast__group" key={contrast.otherProfileId}>
          <h3 className="prl-legend-contrast__title">
            <Link href={profileHref(contrast.otherProfileId)}>{contrast.otherDisplayName}</Link>
          </h3>
          <dl className="prl-legend-contrast__list">
            {contrast.differences.map((difference) => {
              const direction = difference.delta > 0 ? 'higher' : difference.delta < 0 ? 'lower' : 'level';
              const sign = difference.delta > 0 ? '+' : '';
              return (
                <Fragment key={difference.key}>
                  <dt className="prl-legend-contrast__label">{difference.label}</dt>
                  {/* Sign in the text and direction in the name, so colour is never the only cue. */}
                  <dd className="prl-legend-contrast__delta" data-direction={direction}>
                    {`${sign}${formatChips(difference.delta, { decimals: TRAIT_DECIMALS })}`}
                    <span className="prl-visually-hidden">{` ${direction} on this axis`}</span>
                  </dd>
                </Fragment>
              );
            })}
          </dl>
        </div>
      ))}
    </div>
  );
}

export default async function ProfilePage({
  params,
  searchParams,
}: {
  readonly params: Promise<RouteParams>;
  readonly searchParams: Promise<SearchParams>;
}): Promise<ReactElement> {
  const { profileId } = await params;
  const query = await searchParams;
  const difficulty = parseDifficulty(query[MATCH_DIFFICULTY_PARAM]);

  const profiles = await loadLegendProfiles();
  const profile = findProfile(profiles.data.profiles, profileId);
  const learn = await loadLearnFromProfile(profileId);
  if (profile === null || learn === null) return <NotFoundBody />;

  const stats = await loadProfileStats(profileId);

  const { disclosure } = profile;
  const signature = profile.axes.filter((axis) => profile.signatureTraits.includes(axis.key));

  return (
    <div className="prl-legend-page">
      <div className="prl-legend-head">
        <div className="prl-legend-identity">
          <LegendSigil profileId={profile.id} size="lg" />
          <div className="prl-legend-identity__names">
            <h1 className="prl-legend-head__title prl-display-2">{disclosure.archetypeName}</h1>
            {/* Beneath the `h1`, at label size. The server's string carries "(modelled style)". */}
            {disclosure.attributed ? (
              <span className="prl-legend-identity__attributed prl-label">{disclosure.displayName}</span>
            ) : null}
            <p className="prl-legend-head__standfirst">{disclosure.tagline}</p>
          </div>
        </div>
        <div className="prl-legend-head__meta">
          <Chip>{BEST_FOR_WORD[profile.bestFor]}</Chip>
          <Chip tone="accent">{`Setting: ${difficulty}`}</Chip>
        </div>
        {/* Also in the masthead, because the bottom copy is at y=11,328 of 13,883px at 360px. */}
        <div className="prl-legend-card__actions">
          <Link
            className="prl-btn prl-btn--primary prl-btn--md"
            href={legendMatchHref(profile.id, difficulty)}
          >
            Play this style
            <span className="prl-visually-hidden">
              {`: ${disclosure.archetypeName}, ${difficulty} setting`}
            </span>
          </Link>
        </div>
        <nav className="prl-legend-nav" aria-label="Legends navigation">
          <Link href={LEGENDS_PATH}>All profiles</Link>
          <Link href={compareHref([profile.id], difficulty)}>Compare this style with others</Link>
          <Link href={LEGENDS_HAND_REVIEW_PATH}>A finished hand, reviewed</Link>
        </nav>
      </div>

      {profiles.fallbackReason === null ? null : (
        <Callout tone="warning" title="This profile is bundled sample data">
          <p>{profiles.fallbackReason}</p>
        </Callout>
      )}

      {/* `--wide` is layout only, two capped columns above 900px. Nothing is hidden. */}
      <ProfileDisclaimers className="prl-legend-disclaimers--wide" disclosure={disclosure} />

      <section className="prl-legend-section">
        <h2>The style, at a glance</h2>
        <div className="prl-legend-card__metrics">
          {signature.map((axis) => (
            <Metric
              decimals={TRAIT_DECIMALS}
              key={axis.key}
              label={axis.label}
              note={axis.description}
              size="md"
              unit="of 1"
              value={axis.value}
            />
          ))}
        </div>
        <RadarChart
          axes={profile.axes}
          axisLabels="index"
          className="prl-legend-radar prl-legend-radar--lg"
          label={`${disclosure.archetypeName}, sixteen trait axes`}
        />
      </section>

      <section className="prl-legend-section">
        <h2>All sixteen axes</h2>
        <p className="prl-prose">
          Every axis runs from 0 to 1 on the same scale, so two profiles can be compared axis by axis without
          rescaling anything. There is no ranking here and no total: each description says what the trait buys
          and what it costs, because a high value on one of these is a different opponent rather than a better
          one.
        </p>
        <TraitBars axes={profile.axes} signature={profile.signatureTraits} />
      </section>

      <section className="prl-legend-section">
        <h2>What can I learn from this style?</h2>
        <ul className="prl-prose">
          {withKeys(learn.data.learnFrom, 'learn').map((entry) => (
            <li key={entry.key}>{entry.value}</li>
          ))}
        </ul>
      </section>

      <section className="prl-legend-section">
        <h2>How the style shows up at the table</h2>
        <ul className="prl-prose">
          {withKeys(profile.styleNotes, 'style').map((entry) => (
            <li key={entry.key}>{entry.value}</li>
          ))}
        </ul>
      </section>

      <section className="prl-legend-section">
        <h2>How to play against it</h2>
        <p className="prl-prose">
          Included deliberately, and not as an afterthought: an opponent you cannot form a plan against
          teaches nothing.
        </p>
        <ul className="prl-prose">
          {withKeys(learn.data.counterStrategy, 'counter').map((entry) => (
            <li key={entry.key}>{entry.value}</li>
          ))}
        </ul>
      </section>

      <Panel eyebrow="Provenance" title="Where these numbers came from" tone="inset">
        <p>{profile.modelBasis}</p>
        <p>
          They are design parameters chosen to produce a specific, contrasting teaching style. They are not
          measurements: nobody's statistics are in them, and no claim is made that they reproduce how any
          individual plays.
        </p>
      </Panel>

      <section className="prl-legend-section">
        <h2>What this profile declares, against what it actually does</h2>
        {stats.stats === null ? (
          <p className="prl-prose">{stats.unavailableReason}</p>
        ) : (
          <>
            <ObservedTable
              observed={stats.stats.simulated}
              caption={`Frequencies measured over ${pluralise(stats.stats.simulationHands, 'simulated hand')}, with their sampling interval`}
              note={`Measured by playing this model — not declared by it, and not your own play: ${pluralise(stats.stats.simulationHands, 'hand')} heads-up against the ${stats.stats.referenceName} at the ${stats.stats.simulationDifficulty} setting, from seed ${stats.stats.simulationSeed}. The run is deterministic, so these are the same figures every time and anyone can reproduce them.`}
            />
            <Callout
              tone={stats.stats.divergences.length === 0 ? 'insight' : 'warning'}
              title={
                stats.stats.divergences.length === 0
                  ? 'The card and the play agree'
                  : `${stats.stats.divergences.length} axis or axes where the model does not match its own card`
              }
            >
              {stats.stats.divergences.length === 0 ? (
                <p>
                  Every axis this run can measure came out inside the tolerance its own card allows. That is a
                  measured result and not an absence of one: seven of the sixteen traits are frequencies a
                  simulation can count, and none of those seven disagreed. The other nine change real
                  decisions but are not frequencies, so no single observed rate is the same kind of number and
                  none is claimed here.
                </p>
              ) : (
                <ul className="prl-prose">
                  {stats.stats.divergences.map((divergence) => (
                    <li key={divergence.key}>{divergence.note}</li>
                  ))}
                </ul>
              )}
            </Callout>
          </>
        )}
      </section>

      <section className="prl-legend-section">
        <h2>What this profile declares, against what you have seen</h2>
        {learn.data.observed === null || learn.data.observedBasis?.kind !== 'your-play' ? (
          <p className="prl-prose">
            Nothing yet, and this section will stay empty until your own hands against this style can be
            counted honestly. The table above measures this model against a fixed reference opponent; this one
            would measure it against <em>you</em>, which is a different and more useful number — and the
            server cannot produce it today. Three things are missing rather than one: the saved hand rows
            cannot record which of the twelve styles sat in a seat, one of the nine frequencies asks what a
            bet was made with, and the action log does not record whether raising was legal on a given turn.
            An early number here would be more misleading than none, and an invented one would be worse than
            either.
          </p>
        ) : (
          <ObservedTable
            observed={learn.data.observed}
            caption="Observed frequencies from your session, with their sampling interval"
            note={`Measured over ${pluralise(learn.data.observedBasis.handsObserved, 'hand')} of your own play against this style, not declared by the profile.`}
          />
        )}
        {learn.fallbackReason === null ? null : <p className="prl-note">{learn.fallbackReason}</p>}
      </section>

      <section className="prl-legend-section">
        <h2>Where it differs most from the other profiles</h2>
        <p className="prl-prose">
          The axes with the largest gap against each of the three most different profiles. A positive figure
          means this style sits higher on that axis; it does not mean better. Two styles that disagree by 0.4
          on how much they fold are the pair worth playing back to back.
        </p>
        {learn.data.contrasts.length === 0 ? (
          <p className="prl-prose">No other profile was available to compare this one against.</p>
        ) : (
          <ContrastSection contrasts={learn.data.contrasts} />
        )}
      </section>

      <div className="prl-legend-card__actions">
        <Link className="prl-btn prl-btn--primary prl-btn--lg" href={legendMatchHref(profile.id, difficulty)}>
          Play this style
          <span className="prl-visually-hidden">
            {`: ${disclosure.archetypeName}, ${difficulty} setting`}
          </span>
        </Link>
        <Link className="prl-btn prl-btn--secondary prl-btn--lg" href={compareHref([profile.id], difficulty)}>
          Put it against other styles
        </Link>
      </div>
    </div>
  );
}

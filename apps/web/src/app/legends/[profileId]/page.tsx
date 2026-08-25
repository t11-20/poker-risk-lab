/**
 * `/legends/[profileId]` — one profile in full, and what can be learned from it.
 *
 * ## The order of the page is the argument
 *
 * Identity, then the framing, then the numbers, then what to do with them:
 *
 *   01 the archetype name (`h1`), the attributed name beneath it, the tagline
 *   02 the disclaimers, inline, in full
 *   03 three signature axes and the sixteen-axis radar
 *   04 all sixteen axes as labelled bars, each with its plain-language meaning
 *   05 what you can learn from the style, how it shows up, and how to play against it
 *   06 where the numbers came from
 *   07 declared traits against what the model actually did, measured, with the sampling interval
 *   08 declared traits against what YOU have seen it do — empty, and saying why
 *   09 the axes where this style differs most from the others
 *
 * Sections 07 and 08 are two sections rather than one, and separating them is a correction. There
 * was a single "against what you have seen" table, and what it rendered was a bundled constant
 * under the sentence "Measured over 128 hands of your own play". Two measurements exist here and
 * only one of them can be made today: what a deterministic simulation of the model did (07, real,
 * reproducible from a stated seed) and what it did against this reader (08, not yet computable).
 * Collapsing them is how one gets shown under the other's caption.
 *
 * Two of those are guardrails rather than layout. The **archetype name is the `h1`** and the
 * attributed name is a label beneath it, never the other way round. And the **counter-strategy
 * section is not optional**: an opponent a learner cannot form a plan against teaches nothing, so
 * "how to play against it" carries the same weight as "what to learn from it".
 *
 * ## What is deliberately not on this page
 *
 * No portrait, no likeness, no photograph. No ranking of the axes, no overall score, no stars, no
 * "difficulty rating" for the profile as a whole — the difficulty control chooses how *legible* the
 * style is, not how good it is. And no first-person commentary: every sentence here describes the
 * model, in the third person, exactly as it arrives on the wire.
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
  findProfile,
  LEGENDS_HAND_REVIEW_PATH,
  LEGENDS_PATH,
  legendMatchHref,
  loadLearnFromProfile,
  loadLegendProfiles,
  loadProfileStats,
  parseDifficulty,
  profileHref,
  type SearchParams,
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
 * The metadata names the archetype, never the attributed name.
 *
 * A browser tab, a bookmark and a shared link are all places the "(modelled style)" framing would
 * be truncated away, and an attributed name on its own in a title bar is the one context where it
 * reads as a claim about a person.
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
 * What KIND of measurement a row holds, because the table has two and used to render one.
 *
 * ## The defect
 *
 * Every row went through `formatProbability(...) ?? NOT_A_PROBABILITY`, with a comment saying "a
 * measured frequency out of a simulation: a probability, so it goes through the domain". Seven of
 * the eight are. The eighth, `averageBetSizeAsPotFraction`, is a mean of pot fractions and is
 * legitimately greater than 1 — which `packages/ui/src/probability.ts`'s own header says in as
 * many words: "the ones that hold a pot fraction (a bet size as a share of the pot…) deliberately
 * do not [go through the domain], because those are legitimately greater than 1 and refusing them
 * would be the same conflation in reverse."
 *
 * Measured in Chrome 151 against the running API: `/legends/old-school-pressure` rendered the row
 * `Average bet size · not a probability · ± 1.5 points` for a perfectly ordinary average of
 * 1.0685 × the pot. A reader was shown a refusal where a figure belongs, on a page whose whole
 * subject is what a style measurably does.
 *
 * The interval column was wrong on that row too, and for the same reason: `confidenceHalfWidth` is
 * the binomial half-width of the FREQUENCIES. A mean of ratios has a different sampling
 * distribution and this page has no figure for it, so the honest cell says so rather than
 * borrowing one that does not apply.
 */
type ObservedKind = 'frequency' | 'potFraction';

/**
 * The interval cell for a row the frequencies' interval does not describe.
 *
 * Not an em dash on its own: a bare dash in a numeric column reads as a missing measurement, and
 * this one is not missing — it is a different quantity with a different sampling distribution that
 * this page has no figure for. Saying which is the whole point.
 */
const NO_INTERVAL = 'not a frequency';

interface ObservedRow {
  readonly label: string;
  readonly value: number;
  readonly note: string;
  readonly kind: ObservedKind;
}

/** The observed figures, in the order a hand actually produces them. */
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
      note: 'The frequency its card describes as folding under pressure.',
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

/** The figure, in the domain the row actually lives in. See `ObservedKind` for the defect. */
function observedFigure(row: ObservedRow): string {
  if (row.kind === 'frequency') return formatProbability(row.value) ?? NOT_A_PROBABILITY;
  // A share of the pot, so never refused for exceeding 1. `formatChips` still answers the em dash
  // for a value that is not a finite number, which is the only refusal this figure can earn.
  return `${formatChips(row.value, { decimals: 2 })} × pot`;
}

/**
 * The measured-frequencies table.
 *
 * `caption` and `note` are props rather than literals, and that is the fix for a P1 rather than a
 * refactor. This component used to print "Measured over N hands of your own play" over whatever it
 * was handed, and what it was handed was a bundled constant describing no play at all. A component
 * that states the provenance of data it did not fetch will eventually state it wrongly, so the
 * sentence now comes from the caller that knows which measurement this is — and the two callers
 * are separated by `ObservedBasis`, not by convention.
 */
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
                {/*
                  A measured FREQUENCY out of a simulation is a probability, so it goes through the
                  domain: a run that somehow published a rate above 1 must say so rather than print
                  it beside a confidence interval as though it were a finding. A pot fraction is not
                  one and must not be refused for exceeding 1 — see `ObservedKind` for the row that
                  was, and what a reader was shown in place of it.
                */}
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
                  {/*
                    The sign is in the text and the direction word is in the accessible name, so the
                    colour is the third cue rather than the only one.
                  */}
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
  const difficulty = parseDifficulty(query['difficulty']);

  const profiles = await loadLegendProfiles();
  const profile = findProfile(profiles.data.profiles, profileId);
  const learn = await loadLearnFromProfile(profileId);
  if (profile === null || learn === null) return <NotFoundBody />;

  // After the existence check, deliberately: `notFound()` has to be reached before anything is sent,
  // and this call is what makes the "what it actually does" section real rather than a constant.
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
            {/*
              Beneath the `h1`, at label size, carrying the "(modelled style)" framing the server put
              in the string. The archetype is the profile; this is a mnemonic for it.
            */}
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

      {/*
        `--wide` is layout only: this copy of the block spans the page rather than sitting inside a
        card, so above 900px its entries run in two capped columns instead of leaving four fifths of
        a full-width panel empty. Nothing is shortened, collapsed or hidden by it.
      */}
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

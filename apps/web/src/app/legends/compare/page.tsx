/**
 * `/legends/compare` — one spot, several styles, side by side.
 *
 * ## Why this screen exists
 *
 * A profile card tells you a style is aggressive. This page shows you what that means: the same
 * cards, the same pot, the same price, and four different answers. One shared maths panel at the
 * top establishes that nothing about the situation differs between the columns, so every difference
 * below it is the *style* and not the spot.
 *
 * ## The takeaway points at the disagreement, and does not resolve it
 *
 * `CompareProfilesResponse.takeaway` is written to name the disagreement rather than to pick a
 * winner, and this page renders it that way — after the columns, where a reader meets it having
 * already seen the spread. Two strong styles differing on one spot is the lesson; a page that
 * announced which column was right would have deleted it.
 *
 * ## Two honesty requirements this page carries
 *
 *  1. **Each weight is a sampled frequency, not a rule.** The distributions come from a finite
 *     number of trials, so the page prints the sampling interval that follows from that count, with
 *     the arithmetic shown. A distribution presented without one invites a reader to treat 46% and
 *     44% as different answers.
 *  2. **Every column carries the profile's disclaimers in full.** Four copies of the same framing is
 *     repetitive, and it is deliberate: the wire type makes the disclaimers non-optional per
 *     profile, a column is independently readable, and de-duplicating them would be exactly the
 *     kind of tidying that leaves a named opponent unlabelled.
 */

import {
  Button,
  Callout,
  CardRow,
  Chip,
  CoachPanel,
  Formula,
  formatChips,
  formatUnits,
  parseCardText,
  withKeys,
} from '@prl/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Fragment, type ReactElement } from 'react';
import { ActionDistribution } from '@/components/ActionDistribution.tsx';
import { DifficultyPicker } from '@/components/DifficultyPicker.tsx';
import { LegendSigil } from '@/components/LegendSigil.tsx';
import { ProfileDisclaimers } from '@/components/ProfileDisclaimers.tsx';
import {
  COMPARE_SITUATION,
  DEFAULT_COMPARE_PROFILE_IDS,
  LEGENDS_COMPARE_PATH,
  LEGENDS_HAND_REVIEW_PATH,
  LEGENDS_PATH,
  loadLegendProfiles,
  loadProfileComparison,
  parseDifficulty,
  parseProfileIds,
  profileHref,
  type SearchParams,
} from '@/lib/legends-data.ts';

export const metadata: Metadata = {
  title: 'One spot, several styles',
  description:
    'The same decision handed to several opponent profiles, with one shared analysis and a column ' +
    'per style showing the weights it would have sampled its action from.',
};

/**
 * The 95% normal-approximation multiplier.
 *
 * Named rather than inlined because it is the one number on this page that is a statistical
 * convention rather than a measurement, and a reader should be able to see which one it is.
 */
const Z_95 = 1.96;

/** The widest a 95% interval on a sampled proportion gets, which is at p = 0.5. */
function worstCaseHalfWidthPoints(trials: number): number {
  if (!Number.isFinite(trials) || trials <= 0) return Number.NaN;
  return Z_95 * Math.sqrt(0.25 / trials) * 100;
}

function capitalise(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** Engine card integers, dropping anything that does not parse. */
function cards(text: string): readonly number[] {
  const parsed: number[] = [];
  for (const part of text.trim().split(/\s+/)) {
    // Two-character groups with no separator, e.g. "AhJh", are the wire's hole-card spelling.
    const chunks = part.length > 2 && part.length % 2 === 0 ? (part.match(/.{2}/g) ?? []) : [part];
    for (const chunk of chunks) {
      const card = parseCardText(chunk);
      if (card !== null) parsed.push(card);
    }
  }
  return parsed;
}

export default async function ComparePage({
  searchParams,
}: {
  readonly searchParams: Promise<SearchParams>;
}): Promise<ReactElement> {
  const query = await searchParams;
  const difficulty = parseDifficulty(query['difficulty']);
  const requested = parseProfileIds(query['profiles']);
  const profileIds = requested.length === 0 ? DEFAULT_COMPARE_PROFILE_IDS : requested;

  const profiles = await loadLegendProfiles();
  const comparison = await loadProfileComparison({
    profileIds,
    difficulty,
    situation: COMPARE_SITUATION,
  });
  const { analysis, entries, trials, takeaway } = comparison.data;
  const halfWidth = worstCaseHalfWidthPoints(trials);

  return (
    <div className="prl-legend-page">
      <div className="prl-legend-head">
        <span aria-hidden="true" className="prl-index">
          04
        </span>
        <h1 className="prl-legend-head__title prl-display-2">One spot, several styles</h1>
        <p className="prl-legend-head__standfirst">
          The same cards, the same pot and the same price, handed to each style in turn. The analysis below is
          computed once and is identical for every column, so everything that differs between the columns is
          the style rather than the situation.
        </p>
        <div className="prl-legend-head__meta">
          <Chip tone="accent">{`${formatChips(trials)} trials per style`}</Chip>
          <Chip>{`Setting: ${difficulty}`}</Chip>
        </div>
        <nav aria-label="Legends navigation" className="prl-legend-nav">
          <Link href={LEGENDS_PATH}>All profiles</Link>
          <Link href={LEGENDS_HAND_REVIEW_PATH}>A finished hand, reviewed</Link>
        </nav>
      </div>

      {comparison.fallbackReason === null ? null : (
        <Callout tone="warning" title="This comparison is a bundled sample spot">
          <p>{comparison.fallbackReason}</p>
        </Callout>
      )}

      <section className="prl-legend-section">
        <h2>The situation</h2>
        <div className="prl-legend-maths">
          <CardRow cards={cards(COMPARE_SITUATION.heroCards)} label="Your cards" size="md" />
          <CardRow
            cards={cards(COMPARE_SITUATION.board ?? '')}
            emptyText="No community cards yet"
            label="Community cards"
            size="md"
          />
        </div>
        <div className="prl-legend-head__meta">
          <Chip>{capitalise(COMPARE_SITUATION.street)}</Chip>
          <Chip>{`Pot ${formatUnits(COMPARE_SITUATION.pot)}`}</Chip>
          <Chip>
            {COMPARE_SITUATION.toCall > 0
              ? `${formatUnits(COMPARE_SITUATION.toCall)} to call`
              : 'Nothing to call'}
          </Chip>
          <Chip>{`Your stack ${formatUnits(COMPARE_SITUATION.heroStack)}`}</Chip>
          <Chip>{`Their stack ${formatUnits(COMPARE_SITUATION.opponentStack)}`}</Chip>
        </div>
      </section>

      {/*
        One shared analysis, at the top. The full Coach panel rather than a summary of it: the
        assumptions, the method, the interval and the per-action expected values are what make the
        columns below readable, and none of them may be dropped to save room.
      */}
      <CoachPanel report={analysis} title="The maths for this spot, computed once" />

      <section className="prl-legend-section">
        <h2>What each style does with it</h2>
        <p className="prl-prose">
          Each column is one style's weights over the legal actions, before it sampled one. They are
          tendencies rather than rules, so a column showing 46% on a raise is not a style that raises here —
          it is a style that raises here slightly more often than not.
        </p>
        <Formula
          eyebrow="Sampling interval"
          expression={`half-width = ${Z_95} x sqrt(p(1 - p) / ${formatChips(trials)}) <= ${formatChips(halfWidth, { decimals: 1 })} points`}
          explanation={`Every weight below is measured over ${formatChips(trials)} trials, so it carries sampling error. At its widest — a weight near 50% — the 95% interval is ${formatChips(halfWidth, { decimals: 1 })} points either side. Two weights closer together than that are not two different answers.`}
        />
        <div className="prl-legend-columns">
          {entries.map((entry) => (
            <article className="prl-legend-column" key={entry.profileId}>
              <header className="prl-legend-identity">
                <LegendSigil profileId={entry.profileId} />
                <div className="prl-legend-identity__names">
                  <h3 className="prl-legend-identity__archetype">
                    <Link href={profileHref(entry.profileId, difficulty)}>
                      {entry.disclosure.archetypeName}
                    </Link>
                  </h3>
                  {entry.disclosure.attributed ? (
                    <span className="prl-legend-identity__attributed prl-label">
                      {entry.disclosure.displayName}
                    </span>
                  ) : null}
                  <p className="prl-legend-identity__tagline">{entry.disclosure.tagline}</p>
                </div>
              </header>

              <ActionDistribution
                entries={entry.actionDistribution}
                label={`Action mix over ${formatChips(trials)} trials`}
                modalAction={entry.modalAction}
              />

              <div className="prl-stack prl-stack--tight">
                <span className="prl-label">Why this model prefers that</span>
                <p>{entry.reasoning.modelPreference}</p>
              </div>

              <div className="prl-stack prl-stack--tight">
                <span className="prl-label">The axes driving it</span>
                <dl className="prl-legend-contrast__list">
                  {entry.reasoning.drivingTraits.map((trait) => (
                    <Fragment key={trait.key}>
                      <dt className="prl-legend-contrast__label">{trait.label}</dt>
                      <dd className="prl-legend-contrast__delta">
                        {formatChips(trait.value, { decimals: 2 })}
                        <span className="prl-visually-hidden"> of 1</span>
                      </dd>
                    </Fragment>
                  ))}
                </dl>
              </div>

              <div className="prl-stack prl-stack--tight">
                <span className="prl-label">What would change it</span>
                <ul>
                  {withKeys(entry.reasoning.whatChangedIt, `changed-${entry.profileId}`).map((note) => (
                    <li key={note.key}>{note.value}</li>
                  ))}
                </ul>
              </div>

              <ProfileDisclaimers disclosure={entry.disclosure} />
            </article>
          ))}
        </div>
      </section>

      <Callout tone="insight" title="What the disagreement is telling you">
        <p>{takeaway}</p>
      </Callout>

      <section className="prl-legend-section">
        <h2>Change the comparison</h2>
        {/*
          Named, because a form with an accessible name is a `form` landmark and this page has two of
          them. Two unnamed landmarks with the same role are indistinguishable in a landmark list.
        */}
        <form
          action={LEGENDS_COMPARE_PATH}
          aria-label="Choose which styles to compare"
          className="prl-legend-difficulty"
          method="get"
        >
          <input name="difficulty" type="hidden" value={difficulty} />
          <fieldset>
            <legend className="prl-legend-difficulty__legend prl-label">Styles to put side by side</legend>
            <div className="prl-legend-picker__options">
              {profiles.data.profiles.map((profile) => (
                <label className="prl-legend-picker__option" key={profile.id}>
                  <input
                    className="prl-legend-picker__control"
                    defaultChecked={profileIds.includes(profile.id)}
                    name="profiles"
                    type="checkbox"
                    value={profile.id}
                  />
                  {profile.disclosure.archetypeName}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="prl-legend-difficulty__actions">
            <Button type="submit" variant="secondary">
              Compare these styles
            </Button>
            <p className="prl-legend-difficulty__note">
              Pick at least two: a comparison with one column has nothing to disagree with. The choice stays
              in the address bar, so a spot can be shared exactly as it was read.
            </p>
          </div>
        </form>

        <DifficultyPicker
          action={LEGENDS_COMPARE_PATH}
          difficulties={profiles.data.difficulties}
          hidden={[{ name: 'profiles', value: profileIds.join(',') }]}
          legend="How hard the styles play"
          selected={difficulty}
        />
      </section>
    </div>
  );
}

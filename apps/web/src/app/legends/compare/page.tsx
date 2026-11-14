/**
 * `/legends/compare`, one spot handed to several styles. One shared analysis shows the situation is
 * identical across columns. The takeaway names the disagreement and never picks a winner. Each weight
 * is sampled, so the interval is printed with its arithmetic. Every column carries its profile's
 * disclaimers in full on purpose, because each column must read on its own.
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
import { CompareChoiceLimit } from '@/components/CompareChoiceLimit.tsx';
import { DifficultyPicker } from '@/components/DifficultyPicker.tsx';
import { LegendSigil } from '@/components/LegendSigil.tsx';
import { ProfileDisclaimers } from '@/components/ProfileDisclaimers.tsx';
import { SuitMark } from '@/components/SuitMark.tsx';
import {
  LEGENDS_COMPARE_PATH,
  LEGENDS_HAND_REVIEW_PATH,
  LEGENDS_PATH,
  MATCH_DIFFICULTY_PARAM,
  MAX_COMPARE_PROFILES,
  MIN_COMPARE_PROFILES,
  parseCompareSelection,
  parseDifficulty,
  profileHref,
  type SearchParams,
  selectionNotices,
} from '@/lib/legend-links.ts';
import {
  COMPARE_SITUATION,
  DEFAULT_COMPARE_PROFILE_IDS,
  loadLegendProfiles,
  loadProfileComparison,
} from '@/lib/legends-data.ts';

export const metadata: Metadata = {
  title: 'One spot, several styles',
  description:
    'The same decision handed to several opponent profiles, with one shared analysis and a column ' +
    'per style showing the weights it would have sampled its action from.',
};

/** The 95% normal-approximation multiplier, a convention rather than a measurement. */
const Z_95 = 1.96;

const PICKER_HEADING_ID = 'change-comparison';

/** The widest a 95% interval on a sampled proportion gets, which is at p = 0.5. */
function worstCaseHalfWidthPoints(trials: number): number {
  if (!Number.isFinite(trials) || trials <= 0) return Number.NaN;
  return Z_95 * Math.sqrt(0.25 / trials) * 100;
}

function capitalise(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

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
  const difficulty = parseDifficulty(query[MATCH_DIFFICULTY_PARAM]);
  // The profile list first, because it decides which requested ids are real.
  const profiles = await loadLegendProfiles();
  const selection = parseCompareSelection(
    query['profiles'],
    profiles.data.profiles.map((profile) => profile.id),
  );
  const profileIds = selection.ids.length === 0 ? DEFAULT_COMPARE_PROFILE_IDS : selection.ids;
  const nameOf = (id: string): string =>
    profiles.data.profiles.find((profile) => profile.id === id)?.disclosure.archetypeName ?? id;
  const comparison = await loadProfileComparison({
    profileIds,
    difficulty,
    situation: COMPARE_SITUATION,
  });
  const notices = selectionNotices(selection, profileIds, nameOf, comparison.source === 'api');
  const { analysis, entries, trials, takeaway } = comparison.data;
  const halfWidth = worstCaseHalfWidthPoints(trials);

  return (
    <div className="prl-legend-page">
      <div className="prl-legend-head">
        <SuitMark area="legends" />
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
          {/* The picker is fourteen screens down on a phone. A plain anchor, so fragment navigation
              scrolls and moves focus. */}
          <a href={`#${PICKER_HEADING_ID}`}>Change the styles</a>
          <Link href={LEGENDS_PATH}>All profiles</Link>
          <Link href={LEGENDS_HAND_REVIEW_PATH}>A finished hand, reviewed</Link>
        </nav>
      </div>

      {notices.length === 0 ? null : (
        <Callout tone="warning" title="Not exactly the styles you picked">
          {notices.map((notice) => (
            <p key={notice}>{notice}</p>
          ))}
        </Callout>
      )}

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

      {/* The full Coach panel, not a summary. None of its parts may be dropped to save room. */}
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

      {/* One column has no disagreement to describe; `selectionNotices` says so above instead. */}
      {entries.length < MIN_COMPARE_PROFILES ? null : (
        <Callout tone="insight" title="What the disagreement is telling you">
          <p>{takeaway}</p>
        </Callout>
      )}

      <section className="prl-legend-section">
        {/* `tabIndex={-1}` so the link at the top moves focus here as well as scroll. */}
        <h2 id={PICKER_HEADING_ID} tabIndex={-1}>
          Change the comparison
        </h2>
        {/* Named, because this page has two `form` landmarks. */}
        <form
          action={LEGENDS_COMPARE_PATH}
          aria-label="Choose which styles to compare"
          className="prl-legend-difficulty"
          method="get"
        >
          <input name="difficulty" type="hidden" value={difficulty} />
          <fieldset>
            <legend className="prl-legend-difficulty__legend prl-label">Styles to put side by side</legend>
            <CompareChoiceLimit className="prl-legend-picker__options" max={MAX_COMPARE_PROFILES}>
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
            </CompareChoiceLimit>
          </fieldset>
          <div className="prl-legend-difficulty__actions">
            <Button type="submit" variant="secondary">
              Compare these styles
            </Button>
            <p className="prl-legend-difficulty__note">
              Pick two to five: one column has nothing to disagree with, and more than five is more than one
              request can price. The choice stays in the address bar, so a spot can be shared exactly as it
              was read.
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

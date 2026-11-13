/**
 * `/legends`, the profile selector. The universal disclaimer is printed once above the grid as visible
 * prose, and each card links back to it (`lib/disclaimer-framing.ts`). The page names the naming mode
 * in force and warns when the profiles are bundled sample data.
 */

import { Callout, Chip, pluralise } from '@prl/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactElement } from 'react';
import { DifficultyPicker } from '@/components/DifficultyPicker.tsx';
import { LegendCard } from '@/components/LegendCard.tsx';
import { LegendDifficultyScope } from '@/components/LegendDifficultyScope.tsx';
import { LegendQuickStart } from '@/components/LegendQuickStart.tsx';
import { SuitMark } from '@/components/SuitMark.tsx';
import {
  compareHref,
  DEFAULT_COMPARE_PROFILE_IDS,
  LEGENDS_HAND_REVIEW_PATH,
  LEGENDS_PATH,
  loadLegendProfiles,
  MATCH_PROFILE_PARAM,
  parseDifficulty,
  type SearchParams,
} from '@/lib/legends-data.ts';

export const metadata: Metadata = {
  title: 'AI Legends',
  description:
    'Educational opponent profiles, each one a set of sixteen trait values chosen to contrast with ' +
    'the others. Not real people, and not copies of anyone.',
};

/** The operator's `namingMode`, in the reader's words rather than the config key's. */
const NAMING_NOTE: Readonly<Record<'archetype' | 'attributed', string>> = {
  archetype:
    'Each profile is named for the style it plays. The sixteen trait values beneath the name are the ' +
    'whole model, and nothing about what you can learn here depends on whose name is on the seat.',
  attributed:
    'Some profiles also show a person’s name. Where one does, it appears BENEATH the style name and ' +
    'always reads "(modelled style)", because the style is the profile and the name is only a memory ' +
    'aid for it. No profile reproduces how any person plays.',
};

const NAMING_CHIP: Readonly<Record<'archetype' | 'attributed', string>> = {
  archetype: 'Named by style',
  attributed: 'Named by style, some with a person’s name',
};

const FRAMING_ID = 'what-these-profiles-are';

const SETTING_ID = 'how-the-opponent-plays';

export default async function LegendsPage({
  searchParams,
}: {
  readonly searchParams: Promise<SearchParams>;
}): Promise<ReactElement> {
  const params = await searchParams;
  const difficulty = parseDifficulty(params['difficulty']);
  const profiles = await loadLegendProfiles();
  // Kept only if this page lists it, or the select would show one name and submit another.
  const asked = params[MATCH_PROFILE_PARAM];
  const opponent =
    profiles.data.profiles.find((profile) => profile.id === (Array.isArray(asked) ? asked[0] : asked))?.id ??
    null;
  const { namingMode, universalDisclaimer, difficulties } = profiles.data;

  return (
    <div className="prl-legend-page">
      <div className="prl-legend-head">
        <SuitMark area="legends" />
        <h1 className="prl-legend-head__title prl-display-2">AI Legends: opponent profiles</h1>
        <p className="prl-legend-head__standfirst">
          Each opponent is sixteen trait values — how many hands it plays, how hard it bets, how much it cares
          about position — and no two are set alike.
        </p>
        <div className="prl-legend-head__meta">
          <Chip>{pluralise(profiles.data.profiles.length, 'profile')}</Chip>
          <Chip tone="accent">{NAMING_CHIP[namingMode]}</Chip>
        </div>
        <nav className="prl-legend-nav" aria-label="Other legends screens">
          <Link href={compareHref(DEFAULT_COMPARE_PROFILE_IDS, difficulty)}>Compare styles on one spot</Link>
          <Link href={LEGENDS_HAND_REVIEW_PATH}>A finished hand, reviewed</Link>
        </nav>
      </div>

      {profiles.fallbackReason === null ? null : (
        <Callout tone="warning" title="These profiles are bundled sample data">
          <p>{profiles.fallbackReason}</p>
        </Callout>
      )}

      {/*
        One scope to the last card, so every Play link follows the picker before "Apply setting" is
        pressed. `display: contents`, so the grid gaps are unchanged.
      */}
      <LegendDifficultyScope>
        {/* At 375px the first card's Play was at y=2,869. See `LegendQuickStart.tsx`. */}
        <LegendQuickStart
          difficulty={difficulty}
          framingHref={`#${FRAMING_ID}`}
          profiles={profiles.data.profiles.map((profile) => ({
            id: profile.id,
            archetypeName: profile.disclosure.archetypeName,
          }))}
          selected={opponent}
          settingHref={`#${SETTING_ID}`}
          settings={difficulties.map(({ id, label, coachAvailable }) => ({ id, label, coachAvailable }))}
        />

        {/* Above every card, inline and never collapsed. */}
        <div className="prl-legend-disclaimers prl-legend-disclaimers--wide" id={FRAMING_ID}>
          <span className="prl-legend-disclaimers__title prl-label">What these profiles are</span>
          <ul className="prl-legend-disclaimers__list">
            <li className="prl-legend-disclaimers__item">{universalDisclaimer}</li>
            <li className="prl-legend-disclaimers__item">{NAMING_NOTE[namingMode]}</li>
          </ul>
        </div>

        <DifficultyPicker
          action={LEGENDS_PATH}
          difficulties={difficulties}
          carryOpponent={{ initial: opponent }}
          id={SETTING_ID}
          selected={difficulty}
        />

        <section className="prl-legend-section">
          <h2>The profiles</h2>
          <p className="prl-prose">
            Three signature axes are called out on each card so it is readable at a glance; the radar behind
            them is all sixteen, numbered 01 to 16, with the full table of values available to a screen
            reader. No axis is ranked and no value is a score — a high figure on "folds under pressure" is a
            different opponent, not a worse one.
          </p>
          <div className="prl-legend-grid">
            {profiles.data.profiles.map((profile) => (
              <LegendCard
                difficulty={difficulty}
                key={profile.id}
                profile={profile}
                shownAbove={{ text: universalDisclaimer, href: `#${FRAMING_ID}` }}
              />
            ))}
          </div>
        </section>
      </LegendDifficultyScope>
    </div>
  );
}

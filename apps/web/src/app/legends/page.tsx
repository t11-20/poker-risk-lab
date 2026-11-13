/**
 * `/legends` — the profile selector.
 *
 * ## What this screen is for
 *
 * Choosing an opponent, and understanding what you are choosing. The learning value of the mode
 * comes from facing *contrasting* styles, so the selector's job is to make the contrast legible
 * before a hand is played: eight portrait cards, each with its three signature axes as metric
 * blocks and its whole sixteen-axis radar, so a reader can see that the tightest profile and the
 * loosest one are not two settings on a slider.
 *
 * ## What it says out loud, every time
 *
 *  - **The universal disclaimer, at the top, in the body.** `LegendProfilesResponse` carries it as
 *    its own field precisely so it is shown once above the grid, and it is rendered as visible
 *    prose rather than as a footer nobody reads. Each card then carries a visible one-line
 *    statement of it with a link back here, plus every disclaimer specific to that card in full —
 *    see `lib/disclaimer-framing.ts` for why the full text is no longer printed thirteen times.
 *  - **Which naming mode is in force.** If a deployment has opted into attributed names, the page
 *    says so and says what those names are: a mnemonic for a modelled style, beneath the archetype.
 *  - **Where the data came from.** When the API is unreachable the page renders from a typed
 *    fixture and says that in a warning, because sample numbers presented as live ones would be
 *    fabrication in a product about how much a number can be trusted.
 *
 * The page owns the single `h1`; the cards emit `h3` under the grid's `h2`.
 */

import { Callout, Chip, pluralise } from '@prl/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactElement } from 'react';
import { DifficultyPicker } from '@/components/DifficultyPicker.tsx';
import { LegendCard } from '@/components/LegendCard.tsx';
import { LegendDifficultyScope } from '@/components/LegendDifficultyScope.tsx';
import {
  compareHref,
  DEFAULT_COMPARE_PROFILE_IDS,
  LEGENDS_HAND_REVIEW_PATH,
  LEGENDS_PATH,
  loadLegendProfiles,
  parseDifficulty,
  type SearchParams,
} from '@/lib/legends-data.ts';

export const metadata: Metadata = {
  title: 'AI Legends',
  description:
    'Educational opponent profiles, each one a set of sixteen trait values chosen to contrast with ' +
    'the others. Not real people, and not copies of anyone.',
};

/**
 * What the naming mode means for the reader, in their words.
 *
 * `namingMode` is an operator setting (`resolveNamingMode` in `@prl/poker-ai`): `archetype`, the
 * default, or an opt-in `attributed`. These used to say "This deployment shows archetype names
 * only", and the chip above them read "Naming: archetype" — the config key and its value, shown to
 * a learner who has never heard of either (UX audit at 6b3886e, M5).
 */
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

/** The page-level framing block's fragment, which every card's one-line pointer links to. */
const FRAMING_ID = 'what-these-profiles-are';

export default async function LegendsPage({
  searchParams,
}: {
  readonly searchParams: Promise<SearchParams>;
}): Promise<ReactElement> {
  const params = await searchParams;
  const difficulty = parseDifficulty(params['difficulty']);
  const profiles = await loadLegendProfiles();
  const { namingMode, universalDisclaimer, difficulties } = profiles.data;

  return (
    <div className="prl-legend-page">
      <div className="prl-legend-head">
        <span className="prl-index" aria-hidden="true">
          04
        </span>
        <h1 className="prl-legend-head__title prl-display-2">AI Legends: opponent profiles</h1>
        <p className="prl-legend-head__standfirst">
          Each profile is a set of sixteen trait values — how many hands it plays, how hard it bets, how much
          it cares about position — chosen to contrast with the others so you can feel the difference between
          styles rather than read about it.
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
        The framing, above every card. Same treatment as the per-card disclaimers — inline prose at
        body-sm, never collapsed — so a reader meets it before the first profile rather than after
        the last one.
      */}
      <div className="prl-legend-disclaimers prl-legend-disclaimers--wide" id={FRAMING_ID}>
        <span className="prl-legend-disclaimers__title prl-label">What these profiles are</span>
        <ul className="prl-legend-disclaimers__list">
          <li className="prl-legend-disclaimers__item">{universalDisclaimer}</li>
          <li className="prl-legend-disclaimers__item">{NAMING_NOTE[namingMode]}</li>
        </ul>
      </div>

      {/*
        One scope around the picker and the cards, so every Play link follows the ticked option
        before "Apply setting" is pressed. See `LegendDifficultyScope.tsx` for the measurement.
      */}
      <LegendDifficultyScope>
        <DifficultyPicker action={LEGENDS_PATH} difficulties={difficulties} selected={difficulty} />

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

/**
 * One profile as a card. The reading order is the guardrail. The archetype name is the heading,
 * and the attributed name sits beneath it carrying the "(modelled style)" suffix that
 * `profileDisclosure()` builds. Disclaimers are visible body text via `ProfileDisclaimers`.
 * No image of a person. The visual identity is `LegendSigil`.
 * Actions navigate, so they are links styled `.prl-btn`, each with a visually-hidden profile suffix.
 */

import type { LegendDifficulty, LegendProfileCardDto, LegendTraitAxis } from '@prl/contracts';
import { Chip, cx, type HeadingLevel, Metric, RadarChart } from '@prl/ui';
import type { ReactElement } from 'react';
import { LegendPlayLink, LegendProfileLink } from './LegendDifficultyScope.tsx';
import { LegendSigil } from './LegendSigil.tsx';
import { ProfileDisclaimers } from './ProfileDisclaimers.tsx';

const TRAIT_DECIMALS = 2;

const SIGNATURE_LIMIT = 3;

const BEST_FOR_WORD: Readonly<Record<LegendProfileCardDto['bestFor'], string>> = {
  'heads-up': 'Best heads-up',
  'six-max': 'Best six-max',
  both: 'Heads-up or six-max',
};

export interface LegendCardProps {
  readonly profile: LegendProfileCardDto;
  /** The applied setting from the URL. Inside a `LegendDifficultyScope` the links follow the tick. */
  readonly difficulty: LegendDifficulty;
  /** Never 1. The page owns the `h1`. */
  readonly headingLevel?: HeadingLevel;
  readonly className?: string;
  readonly shownAbove?: { readonly text: string; readonly href: string };
}

function signatureAxes(profile: LegendProfileCardDto): readonly LegendTraitAxis[] {
  const found: LegendTraitAxis[] = [];
  for (const key of profile.signatureTraits) {
    const axis = profile.axes.find((candidate) => candidate.key === key);
    if (axis !== undefined) found.push(axis);
    if (found.length === SIGNATURE_LIMIT) break;
  }
  return found;
}

export function LegendCard(props: LegendCardProps): ReactElement {
  const { profile, difficulty, headingLevel = 3, className, shownAbove } = props;
  const { disclosure } = profile;
  const Heading = `h${headingLevel}` as const;
  const signature = signatureAxes(profile);

  return (
    <article className={cx('prl-legend-card', className)}>
      <header className="prl-legend-identity">
        <LegendSigil profileId={profile.id} />
        <div className="prl-legend-identity__names">
          <Heading className="prl-legend-identity__archetype">{disclosure.archetypeName}</Heading>
          {disclosure.attributed ? (
            <span className="prl-legend-identity__attributed prl-label">{disclosure.displayName}</span>
          ) : null}
          <p className="prl-legend-identity__tagline">{disclosure.tagline}</p>
        </div>
      </header>

      <div className="prl-legend-head__meta">
        <Chip>{BEST_FOR_WORD[profile.bestFor]}</Chip>
      </div>

      {/* Values and units, never a rank. A trait value says what the style does, not whether it is good. */}
      <div className="prl-legend-card__metrics">
        {signature.map((axis) => (
          <Metric
            decimals={TRAIT_DECIMALS}
            key={axis.key}
            label={axis.label}
            size="sm"
            unit="of 1"
            value={axis.value}
          />
        ))}
      </div>

      <RadarChart
        axes={profile.axes}
        axisLabels="index"
        className="prl-legend-radar"
        label={`${disclosure.archetypeName}, sixteen trait axes`}
      />

      <ProfileDisclaimers disclosure={disclosure} {...(shownAbove === undefined ? {} : { shownAbove })} />

      <div className="prl-legend-card__actions">
        <LegendPlayLink
          archetypeName={disclosure.archetypeName}
          className="prl-btn prl-btn--primary prl-btn--md"
          difficulty={difficulty}
          profileId={profile.id}
        >
          Play this style
        </LegendPlayLink>
        <LegendProfileLink
          archetypeName={disclosure.archetypeName}
          className="prl-btn prl-btn--secondary prl-btn--md"
          difficulty={difficulty}
          profileId={profile.id}
        >
          Full profile
        </LegendProfileLink>
      </div>
    </article>
  );
}

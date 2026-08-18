/**
 * One profile, as a portrait panel.
 *
 * ## The labelling rules, expressed as structure rather than as a convention
 *
 * Reading order is fixed and it is the guardrail:
 *
 *   sigil -> ARCHETYPE NAME (the heading) -> attributed name (a label, beneath) -> tagline ->
 *   three signature metrics -> the sixteen-axis radar -> the disclaimers -> the action
 *
 * Three things about that order are not stylistic:
 *
 *  1. **The archetype name is the heading.** It is what the profile *is*. The attributed name is a
 *     mnemonic for a style and it sits below, at `--prl-type-label`, always carrying the
 *     "(modelled style)" framing that `profileDisclosure()` put in the string. This component never
 *     builds that suffix itself, so it cannot forget it.
 *  2. **The disclaimers are in the body**, rendered by `ProfileDisclaimers`, which renders the whole
 *     array as visible text. Not a tooltip, not an icon, not a `<details>`.
 *  3. **No image of a person, ever.** The visual identity is `LegendSigil`, a mark generated from
 *     the profile id. There is no `src` anywhere in this file.
 *
 * ## The hover state
 *
 * The hairline goes accent and the sigil turns a few degrees over `--prl-dur-quick`. `:focus-within`
 * is paired with `:hover` in the stylesheet so a keyboard reader gets the same cue when the card's
 * link takes focus, and the rotation is removed rather than shortened under
 * `prefers-reduced-motion` — a mark that snaps six degrees is worse than one that never moves.
 *
 * ## Why the actions are links and not buttons
 *
 * Both actions navigate, so both are links. `Button` in `@prl/ui` deliberately has no `href`, and
 * its own comment says to style a link with the `.prl-btn` classes — which is what happens here,
 * with `next/link` doing the navigation. Each link carries a visually-hidden suffix naming the
 * profile and the difficulty, because a page of eight cards otherwise offers a screen-reader user
 * eight links all called "Play this style".
 *
 * Server-render safe: no state, no effects.
 */

import type { LegendDifficulty, LegendProfileCardDto, LegendTraitAxis } from '@prl/contracts';
import { Chip, cx, type HeadingLevel, Metric, RadarChart } from '@prl/ui';
import Link from 'next/link';
import type { ReactElement } from 'react';
import { legendMatchHref, profileHref } from '@/lib/legends-data.ts';
import { LegendSigil } from './LegendSigil.tsx';
import { ProfileDisclaimers } from './ProfileDisclaimers.tsx';

/** Two decimals, matching the scale `@prl/poker-ai` documents for every trait. */
const TRAIT_DECIMALS = 2;

/** How many signature axes get a metric block. The wire supplies three. */
const SIGNATURE_LIMIT = 3;

const BEST_FOR_WORD: Readonly<Record<LegendProfileCardDto['bestFor'], string>> = {
  'heads-up': 'Best heads-up',
  'six-max': 'Best six-max',
  both: 'Heads-up or six-max',
};

export interface LegendCardProps {
  readonly profile: LegendProfileCardDto;
  /** Threaded into the play link, so the card's action starts the match the reader chose. */
  readonly difficulty: LegendDifficulty;
  /** Defaults to 3: a page owns its `h1` and the grid's section owns the `h2`. Never 1. */
  readonly headingLevel?: HeadingLevel;
  readonly className?: string;
}

/** The signature axes, in the order the profile declares them, skipping any the axes list lacks. */
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
  const { profile, difficulty, headingLevel = 3, className } = props;
  const { disclosure } = profile;
  const Heading = `h${headingLevel}` as const;
  const signature = signatureAxes(profile);

  return (
    <article className={cx('prl-legend-card', className)}>
      <header className="prl-legend-identity">
        <LegendSigil profileId={profile.id} />
        <div className="prl-legend-identity__names">
          <Heading className="prl-legend-identity__archetype">{disclosure.archetypeName}</Heading>
          {/*
            Beneath the heading, at label size, and only when the deployment has opted into
            attributed names. The string already reads "<name> (modelled style)" — see
            `profileDisclosure()`. Nothing here shortens it.
          */}
          {disclosure.attributed ? (
            <span className="prl-legend-identity__attributed prl-label">{disclosure.displayName}</span>
          ) : null}
          <p className="prl-legend-identity__tagline">{disclosure.tagline}</p>
        </div>
      </header>

      <div className="prl-legend-head__meta">
        <Chip>{BEST_FOR_WORD[profile.bestFor]}</Chip>
      </div>

      {/*
        The three signature axes, so the card is readable at a glance. Values, units and labels —
        never a rank: `0.92 of 1` on position awareness says what the style does, and says nothing
        about whether that is good.
      */}
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

      <ProfileDisclaimers disclosure={disclosure} />

      <div className="prl-legend-card__actions">
        <Link className="prl-btn prl-btn--primary prl-btn--md" href={legendMatchHref(profile.id, difficulty)}>
          Play this style
          <span className="prl-visually-hidden">
            {`: ${disclosure.archetypeName}, ${difficulty} setting`}
          </span>
        </Link>
        <Link className="prl-btn prl-btn--secondary prl-btn--md" href={profileHref(profile.id, difficulty)}>
          Full profile
          <span className="prl-visually-hidden">{`: ${disclosure.archetypeName}`}</span>
        </Link>
      </div>
    </article>
  );
}

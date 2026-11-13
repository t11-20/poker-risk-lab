/**
 * What `/play?profile=…&difficulty=…` says above the table, so the page names the style and setting
 * the reader picked and explains the API's short seat plate (`botDisplayName`). Archetype names only,
 * because an attributed name must travel with "(modelled style)" and a heading loses suffixes.
 */

import type { LegendDifficulty, LegendDifficultyDto } from '@prl/contracts';

export interface LegendMatchCopy {
  readonly eyebrow: string;
  readonly heading: string;
  readonly lede: string;
  /** Shown with a link to the profile. Never omitted. */
  readonly framing: string;
}

export interface LegendMatchCopyInput {
  readonly profileId: string;
  /** Null when the id is not a listed profile. The table says why it failed. */
  readonly archetypeName: string | null;
  readonly difficulty: LegendDifficulty;
  /** Null if the difficulty was not listed. */
  readonly setting: LegendDifficultyDto | null;
}

function capitalise(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

export function legendMatchCopy(input: LegendMatchCopyInput): LegendMatchCopy {
  const settingLabel = input.setting?.label ?? capitalise(input.difficulty);
  const named = input.archetypeName;
  const coach =
    input.setting === null
      ? ''
      : input.setting.coachAvailable
        ? ' The Coach stays beside the table while you play.'
        : ' The Coach is held back until the hand is over and you open its review.';
  return {
    eyebrow: `Play — AI Legends · ${settingLabel} setting`,
    heading: named === null ? 'Heads-up against a modelled style' : `Heads-up against ${named}`,
    lede:
      `Just you and one modelled style, at the ${settingLabel} setting, dealt and settled by the server.` +
      `${coach} Its seat shows a short name made from the profile id (${input.profileId}); it is the same style.`,
    framing:
      'An educational strategy simulation of a style, defined by sixteen trait values — not a real person, ' +
      'and not a copy of anyone.',
  };
}

/**
 * One copy, so the "Start a match" form and the picker's chip cannot disagree. Not in a `'use client'`
 * module, because a server component calling a client export got a reference and failed to render.
 */
export function coachWords(coachAvailable: boolean): string {
  return coachAvailable ? 'Coach available while you play' : 'Coach in review only';
}

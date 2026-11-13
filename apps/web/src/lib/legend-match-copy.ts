/**
 * What `/play?profile=…&difficulty=…` says at the top, before the table.
 *
 * ## The defect
 *
 * Measured on the running build: a reader who chose "High-Variance Tournament Aggressor" at Expert
 * landed on an `h1` of "Heads-up against this style" over a lede reading "A private table against
 * five bots" — the six-handed table's sentence, on a heads-up match — while the room line said
 * "2 at the table". The opponent's seat said "Vocal Aggressor". Nothing on the page named the style
 * they had picked or the setting they had picked it at.
 *
 * The seat plate is the API's (`botDisplayName` in `apps/api/src/rooms/bots.ts`): whole words of
 * the profile id, inside the 24-character limit the users table puts on a display name. That is a
 * reasonable plate and it is not this page's to change, so the page says what the plate is instead
 * of leaving a reader to wonder whether they were given a different opponent.
 *
 * Archetype names only, never the attributed name: the attributed name is a mnemonic that must
 * travel with "(modelled style)" and its disclaimers, and a page heading is where a suffix is lost.
 */

import type { LegendDifficulty, LegendDifficultyDto } from '@prl/contracts';

export interface LegendMatchCopy {
  readonly eyebrow: string;
  readonly heading: string;
  readonly lede: string;
  /** The one-line framing, shown with a link to the profile. Never omitted. */
  readonly framing: string;
}

export interface LegendMatchCopyInput {
  readonly profileId: string;
  /** Null when the id is not a profile this deployment lists; the table will say why it failed. */
  readonly archetypeName: string | null;
  readonly difficulty: LegendDifficulty;
  /** The difficulty's own wording from the profiles response, or null if it was not listed. */
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
 * What a setting does to the Coach, in the words the picker's chip uses. One copy, because the
 * "Start a match" form names the setting it will start in this same sentence, and a form that said
 * "Coach available" above a chip that said "Coach in review only" would be two answers to the one
 * question a learner actually feels.
 *
 * Here and not in `LegendDifficultyScope.tsx`, which is where it was first written: a function
 * exported from a `'use client'` module reaches a server component as a client REFERENCE, not as a
 * function, and `DifficultyPicker` (a server component) calling it took `/legends` down with "This
 * screen did not load" on the production build. A module with no directive is callable from both.
 */
export function coachWords(coachAvailable: boolean): string {
  return coachAvailable ? 'Coach available while you play' : 'Coach in review only';
}

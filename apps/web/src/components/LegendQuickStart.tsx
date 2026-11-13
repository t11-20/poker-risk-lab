/**
 * "Start a match": the first thing on `/legends` a reader can press to play.
 *
 * ## The defect
 *
 * Measured on the production build with the API up, 2026-11-13: the first "Play this style" on
 * `/legends` was at y=2,869 at 375x812 — three and a half screens — and at y=1,968 at 1440x900, below
 * the fold on a desktop too. Above it: the head, the framing block, the difficulty picker, the
 * section's intro and the whole of the first card, whose order (sigil, figures, radar, disclaimers,
 * then the action) is a guardrail (`LegendCard.tsx`). `legends.css` section 8 records the four ways
 * of shrinking the picker that were tried and why none of them could get past that floor.
 *
 * So this is not a smaller version of anything on the page. It is a second way in: one GET form to
 * `/play` with the opponent as a `<select>` of the same profiles the cards show, directly under the
 * head.
 *
 * ## Why it may sit above the framing block
 *
 * The rule the page keeps is "a reader meets the framing before the first PROFILE", and a list of
 * archetype names is not a profile — no figures, no radar. What this form carries instead is the
 * one-line pointer every card already carries in place of the full text (`POINTER_TEXT`, linking to
 * the block), and the match screen restates the same fact under its heading
 * (`legendMatchCopy().framing`). The full text is a link away here and one block below.
 *
 * ## Why the setting is named, not chosen, here
 *
 * The picker below is where a setting is explained: what each one does to the opponent and to the
 * Coach. A second three-way control up here would be two answers to one question. So the form names
 * the setting it will start — label and Coach consequence, the part a learner feels — follows the
 * picker's tick through `LegendDifficultyScope` exactly as the card links do, and links down to the
 * picker to change it. Without JavaScript the hidden field and the sentence are both the applied
 * setting from the URL, which is what "Apply setting" puts there.
 *
 * The sentence sits UNDER the button, as its caption, and the button is `aria-describedby` it. It
 * was above the select first, and measured at 375x812 that put the button's bottom edge at y=910,
 * a screen and a bit; under the button the same words cost the button nothing. A screen reader
 * hears them with the button either way.
 *
 * ## Accessibility
 *
 * The form is a named landmark ("Start a match", by its `h2`), distinct from the picker's "How the
 * opponent plays" — two unnamed forms on one page read as "form, form" in a landmark list. The
 * select has a visible `<label>`. The submit button is described by the sentence naming the
 * setting, so a screen reader hears what it will start before pressing it.
 *
 * Server component: the only client pieces are the two that follow the tick.
 */

import type { LegendDifficulty } from '@prl/contracts';
import type { ReactElement } from 'react';
import { MATCH_DIFFICULTY_PARAM, MATCH_PROFILE_PARAM, PLAY_PATH } from '@/lib/legend-links.ts';
import { ScopedDifficultyInput, ScopedSettingName, type SettingName } from './LegendDifficultyScope.tsx';
import { POINTER_TEXT } from './ProfileDisclaimers.tsx';

const TITLE_ID = 'legend-quick-start-title';
const SELECT_ID = 'legend-quick-start-opponent';
const SETTING_ID = 'legend-quick-start-setting';

export interface LegendQuickStartProps {
  /** Id and archetype name, in the order the cards are shown. Never the attributed name. */
  readonly profiles: readonly { readonly id: string; readonly archetypeName: string }[];
  readonly settings: readonly SettingName[];
  /** The applied setting, from the URL. */
  readonly difficulty: LegendDifficulty;
  /** Fragment of the page-level framing block. */
  readonly framingHref: string;
  /** Fragment of the difficulty picker. */
  readonly settingHref: string;
  /** The opponent the URL carried back through "Apply setting", if it is one of `profiles`. */
  readonly selected: string | null;
}

export function LegendQuickStart(props: LegendQuickStartProps): ReactElement | null {
  const { profiles, settings, difficulty, framingHref, settingHref, selected } = props;
  const first = profiles.find((profile) => profile.id === selected) ?? profiles[0];
  // No profiles is not a form with an empty select: it is nothing to start, and the page's own
  // empty grid says why.
  if (first === undefined) return null;

  return (
    <form action={PLAY_PATH} aria-labelledby={TITLE_ID} className="prl-legend-quick" method="get">
      <h2 className="prl-legend-quick__title" id={TITLE_ID}>
        Start a match
      </h2>
      <p className="prl-legend-quick__framing">
        {`${POINTER_TEXT} `}
        <a href={framingHref}>Read what these profiles are</a>
      </p>
      <div className="prl-legend-quick__row">
        <div className="prl-field prl-legend-quick__field">
          <label className="prl-field__label" htmlFor={SELECT_ID}>
            Opponent
          </label>
          <select className="prl-select" defaultValue={first.id} id={SELECT_ID} name={MATCH_PROFILE_PARAM}>
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.archetypeName}
              </option>
            ))}
          </select>
        </div>
        <ScopedDifficultyInput difficulty={difficulty} name={MATCH_DIFFICULTY_PARAM} />
        <button aria-describedby={SETTING_ID} className="prl-btn prl-btn--primary prl-btn--md" type="submit">
          Play
          <span className="prl-visually-hidden"> the chosen opponent</span>
        </button>
      </div>
      <p className="prl-legend-quick__setting">
        <span id={SETTING_ID}>
          {'Starts at '}
          <ScopedSettingName difficulty={difficulty} settings={settings} />.
        </span>{' '}
        <a href={settingHref}>Change the setting</a>
      </p>
    </form>
  );
}

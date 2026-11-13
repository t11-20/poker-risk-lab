/**
 * "Start a match", a GET form to `/play` directly under the `/legends` head. The first card's Play
 * link sat at y=2,869 at 375x812. It may precede the framing block because a list of archetype names
 * is not a profile, and it carries the one-line `POINTER_TEXT`. The setting is named, not chosen,
 * because the picker below is the one control for it. The naming sentence sits under the button and
 * describes it, which kept the button on the first screen. Named landmark via its `h2`.
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
  /** Archetype names only, never the attributed name. */
  readonly profiles: readonly { readonly id: string; readonly archetypeName: string }[];
  readonly settings: readonly SettingName[];
  readonly difficulty: LegendDifficulty;
  readonly framingHref: string;
  readonly settingHref: string;
  readonly selected: string | null;
}

export function LegendQuickStart(props: LegendQuickStartProps): ReactElement | null {
  const { profiles, settings, difficulty, framingHref, settingHref, selected } = props;
  const first = profiles.find((profile) => profile.id === selected) ?? profiles[0];
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

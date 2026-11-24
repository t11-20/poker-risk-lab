/**
 * The difficulty picker, a plain GET form that keeps the setting in the URL. It never navigates on
 * change, because arrowing through radios would navigate per option (WCAG 3.2.2).
 * `LegendDifficultyScope` reads an unapplied tick where a page wraps the picker.
 * Every option states its Coach consequence, which is the part a learner feels.
 * The whole option is the `<label>`, so the target clears 44px.
 */

import type { LegendDifficulty, LegendDifficultyDto } from '@prl/contracts';
import { Button, Chip, cx, Tip } from '@prl/ui';
import type { ReactElement } from 'react';
import { MATCH_DIFFICULTY_PARAM } from '@/lib/legend-links.ts';
import { coachWords } from '@/lib/legend-match-copy.ts';
import { WEB_TIPS } from '@/lib/tips.ts';
import { ScopedDifficultyNote, ScopedOpponentInput } from './LegendDifficultyScope.tsx';

export interface DifficultyPickerProps {
  readonly difficulties: readonly LegendDifficultyDto[];
  readonly selected: LegendDifficulty;
  readonly action: string;
  /** Parameters to keep across the submit, which a GET form otherwise drops. */
  readonly hidden?: readonly { readonly name: string; readonly value: string }[];
  readonly legend?: string;
  readonly className?: string;
  readonly id?: string;
  /** `/legends` only. See `ScopedOpponentInput`. */
  readonly carryOpponent?: { readonly initial: string | null };
}

export function DifficultyPicker(props: DifficultyPickerProps): ReactElement {
  const {
    difficulties,
    selected,
    action,
    hidden = [],
    legend = 'How the opponent plays',
    className,
    id,
    carryOpponent,
  } = props;

  return (
    /*
      Named, so the compare page's two forms are distinct landmarks rather than "form, form".
    */
    <form
      action={action}
      aria-label={legend}
      className={cx('prl-legend-difficulty', className)}
      id={id}
      method="get"
    >
      {hidden.map((field) => (
        <input key={`${field.name}:${field.value}`} name={field.name} type="hidden" value={field.value} />
      ))}
      {carryOpponent === undefined ? null : <ScopedOpponentInput initial={carryOpponent.initial} />}
      <fieldset>
        <legend className="prl-legend-difficulty__legend prl-label">{legend}</legend>
        <div className="prl-legend-difficulty__options">
          {difficulties.map((difficulty) => {
            const isSelected = difficulty.id === selected;
            return (
              <label className="prl-legend-difficulty__option" key={difficulty.id}>
                <input
                  className="prl-legend-difficulty__control"
                  defaultChecked={isSelected}
                  name={MATCH_DIFFICULTY_PARAM}
                  type="radio"
                  value={difficulty.id}
                />
                <span className="prl-legend-difficulty__label">
                  {difficulty.label}
                  {/* Not "selected": the radio is uncontrolled, so the name would outlive the tick. */}
                  {isSelected ? <span className="prl-visually-hidden">, the applied setting</span> : null}
                </span>
                <p className="prl-legend-difficulty__description">{difficulty.description}</p>
                <span className="prl-legend-difficulty__coach">
                  <Chip tone={difficulty.coachAvailable ? 'accent' : 'caution'}>
                    {coachWords(difficulty.coachAvailable)}
                  </Chip>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>
      <div className="prl-legend-difficulty__actions">
        {/* Beside the button, because a tip in the legend would join the radio group's name. */}
        <span className="prl-tip-row">
          <Button type="submit" variant="secondary">
            Apply setting
          </Button>
          <Tip tip={WEB_TIPS.legendSetting} />
        </span>
        <p className="prl-legend-difficulty__note">
          {/* The children are the no-script sentence, and the only true one outside `/legends`. */}
          <ScopedDifficultyNote following="Play buttons follow your selection. Apply to save it in the address bar.">
            Apply to save this setting in the address bar so the spot can be shared.
          </ScopedDifficultyNote>
        </p>
      </div>
    </form>
  );
}

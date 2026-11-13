/**
 * Choosing how hard — and how legible — the opponent is.
 *
 * ## Why this is a plain GET form and not a client component
 *
 * A form with radio inputs and a visible submit works with JavaScript disabled, needs no
 * hydration, and keeps the chosen setting in the URL where it can be linked, bookmarked and
 * reloaded. Two things it deliberately does not do:
 *
 *  - **It does not navigate on change.** Auto-submitting on `change` means a keyboard user
 *    arrow-keying through the options triggers a navigation per option, which is WCAG 3.2.2 (On
 *    Input) and also makes the third option unreachable without visiting the first two.
 *  - **It does not hold the value in React state.** There is nothing to hold: the current setting
 *    arrives as a prop from the URL, and the server render is the source of truth. What is ticked
 *    but not yet applied is read by `LegendDifficultyScope` where a page wraps the picker in one,
 *    so the page's Play links can start the match the reader picked without a navigation here.
 *
 * ## What each option has to say
 *
 * `educational` is not "easier" in the sense of "worse" — it is *more legible*: the style is muted,
 * the sizing is uniform, and the Coach stays available while the hand is being played. `expert`
 * expresses the traits fully and takes the Coach away until review. That last fact is the part of
 * the choice a learner actually feels, so `coachAvailable` is stated on every option rather than
 * left in a footnote.
 *
 * ## Accessibility
 *
 * A `fieldset` with a `legend` groups the radios, so the group's purpose is announced once rather
 * than repeated per option. The whole option block is the `<label>`, which makes the target the
 * block rather than the dot — comfortably past the 44px floor. The selected option is marked three
 * ways: the radio's own checked state, an accent border, and the word "Selected" in the label, so
 * it survives forced-colors mode and colour-vision deficiency.
 *
 * Server-render safe: no state, no effects.
 */

import type { LegendDifficulty, LegendDifficultyDto } from '@prl/contracts';
import { Button, Chip, cx } from '@prl/ui';
import type { ReactElement } from 'react';
import { coachWords } from '@/lib/legend-match-copy.ts';
import { ScopedDifficultyNote } from './LegendDifficultyScope.tsx';

/** The query parameter this control writes. Shared with `parseDifficulty` in `legends-data.ts`. */
export const DIFFICULTY_PARAM = 'difficulty';

export interface DifficultyPickerProps {
  readonly difficulties: readonly LegendDifficultyDto[];
  readonly selected: LegendDifficulty;
  /** Where the form submits. The page's own path, so the choice lands back on this screen. */
  readonly action: string;
  /**
   * Other parameters this page needs to keep across the submit — the compare page's profile list,
   * for instance. Without them a GET form silently drops every parameter it does not carry.
   */
  readonly hidden?: readonly { readonly name: string; readonly value: string }[];
  readonly legend?: string;
  readonly className?: string;
  /** A fragment target, for a page that links to the picker from above it. */
  readonly id?: string;
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
  } = props;

  return (
    /*
      `aria-label` on the form, not just on the fieldset. A `<form>` with an accessible name is a
      `form` landmark, and two unnamed landmarks of the same role on one page is a real navigation
      failure — the compare page has two forms. Naming both makes them distinguishable in a screen
      reader's landmark list instead of "form, form".
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
                  name={DIFFICULTY_PARAM}
                  type="radio"
                  value={difficulty.id}
                />
                <span className="prl-legend-difficulty__label">
                  {difficulty.label}
                  {isSelected ? <span className="prl-visually-hidden">, selected</span> : null}
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
        <Button type="submit" variant="secondary">
          Apply setting
        </Button>
        <p className="prl-legend-difficulty__note">
          {/*
            On `/legends` the Play links follow the ticked option before a submit (see
            `LegendDifficultyScope.tsx`), and the sentence says so once that is true. Anywhere else —
            the compare page, where the setting changes the figures themselves — and with scripts
            off, the first sentence is the one that holds.
          */}
          <ScopedDifficultyNote following="Every Play button and link on this page starts a match at the option you tick. Applying it also puts it in the address bar, so the page can be shared exactly as it was read.">
            The setting is applied when you submit, not while you are moving through the options, and it stays
            in the address bar so a spot can be shared exactly as it was read.
          </ScopedDifficultyNote>
        </p>
      </div>
    </form>
  );
}

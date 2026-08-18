/**
 * The disclaimers, rendered inline, in the body, in full.
 *
 * ## This component is the guarantee
 *
 * `ProfileDisclosureDto.disclaimers` is a required, non-empty array on the wire, and there is no
 * server code path that produces a profile without it — `profileDisclosure()` throws rather than
 * return an unlabelled profile. That guarantee stops at the wire, and this is where the client
 * either keeps it or quietly drops it.
 *
 * So every screen in this feature renders the disclaimers through this one component, and this
 * component has exactly one behaviour: **iterate the whole array and render every entry as
 * visible body text.** There is no `slice`, no "first disclaimer only", no `title` attribute, no
 * tooltip, no `<details>`, no line clamp and no `max-height`. Each of those is a way to appear to
 * render a disclaimer while hiding most of it, and the design system rules all of them out by
 * name: inline in the card body, at `--prl-type-body-sm`, not behind an info icon.
 *
 * ## What happens if the array is empty
 *
 * It should be impossible. If it happens anyway — a hand-edited fixture, a future endpoint that
 * builds a disclosure by hand — this renders a **warning in place of the profile's framing**
 * rather than nothing at all. Nothing is the failure mode that ships: a card that looks finished
 * and is not labelled. A visible warning is a bug report on screen, which is the only version of
 * this that gets fixed.
 *
 * Server-render safe: no state, no effects.
 */

import type { ProfileDisclosureDto } from '@prl/contracts';
import { Callout, cx, withKeys } from '@prl/ui';
import type { ReactElement } from 'react';

export interface ProfileDisclaimersProps {
  readonly disclosure: ProfileDisclosureDto;
  /**
   * The visible marker above the list. It is a label rather than a heading on purpose: a card
   * that emitted a heading here would insert a level into the page outline for a block that is
   * framing rather than a section.
   */
  readonly title?: string;
  readonly className?: string;
}

export function ProfileDisclaimers(props: ProfileDisclaimersProps): ReactElement {
  const { disclosure, title = 'What these profiles are', className } = props;
  const disclaimers = disclosure.disclaimers;

  if (disclaimers.length === 0) {
    // `exactOptionalPropertyTypes` rejects `className={undefined}`, so the prop is spread in only
    // when there is one. That is the setting doing its job rather than a workaround for it.
    return (
      <Callout
        title="This profile arrived without its required labelling"
        tone="warning"
        {...(className === undefined ? {} : { className })}
      >
        <p>
          {`"${disclosure.archetypeName}" was delivered with an empty disclaimers list. The wire contract requires at least one, because a profile shown without it reads as a claim about a person rather than as an educational simulation. Nothing below this point should be treated as labelled, and this is a defect in whatever produced the profile rather than in the screen showing it.`}
        </p>
      </Callout>
    );
  }

  return (
    <div className={cx('prl-legend-disclaimers', className)}>
      <span className="prl-legend-disclaimers__title prl-label">{title}</span>
      <ul className="prl-legend-disclaimers__list">
        {withKeys(disclaimers, 'disclaimer').map((entry) => (
          <li className="prl-legend-disclaimers__item" key={entry.key}>
            {entry.value}
          </li>
        ))}
      </ul>
    </div>
  );
}

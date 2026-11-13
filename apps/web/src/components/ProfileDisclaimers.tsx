/**
 * Every disclaimer as visible body text. Every profile screen renders them through here.
 * No slice, `title`, tooltip, `<details>`, line clamp or `max-height`, each of which hides text.
 * An empty array renders a visible warning, never nothing.
 * `shownAbove` is `/legends` only. An entry identical to the page's printed universal text becomes a
 * one-line pointer in the same list (`lib/disclaimer-framing.ts`).
 */

import type { ProfileDisclosureDto } from '@prl/contracts';
import { Callout, cx, withKeys } from '@prl/ui';
import type { ReactElement } from 'react';
import { disclaimerFraming } from '@/lib/disclaimer-framing.ts';

export interface ProfileDisclaimersProps {
  readonly disclosure: ProfileDisclosureDto;
  /** A label, not a heading, so the card adds no level to the page outline. */
  readonly title?: string;
  readonly className?: string;
  readonly shownAbove?: { readonly text: string; readonly href: string };
}

export const POINTER_TEXT =
  'An educational strategy simulation of a style — not a real person, and not a copy of anyone.';

export function ProfileDisclaimers(props: ProfileDisclaimersProps): ReactElement {
  const { disclosure, title = 'What these profiles are', className, shownAbove } = props;
  const disclaimers = disclosure.disclaimers;

  if (disclaimers.length === 0) {
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

  const framing = disclaimerFraming(disclaimers, shownAbove?.text);

  return (
    <div className={cx('prl-legend-disclaimers', className)}>
      <span className="prl-legend-disclaimers__title prl-label">{title}</span>
      <ul className="prl-legend-disclaimers__list">
        {framing.pointer && shownAbove !== undefined ? (
          <li className="prl-legend-disclaimers__item">
            {`${POINTER_TEXT} `}
            <a href={shownAbove.href}>Read what these profiles are</a>
          </li>
        ) : null}
        {withKeys(framing.inFull, 'disclaimer').map((entry) => (
          <li className="prl-legend-disclaimers__item" key={entry.key}>
            {entry.value}
          </li>
        ))}
      </ul>
    </div>
  );
}

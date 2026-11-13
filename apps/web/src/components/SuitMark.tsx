/**
 * The suit mark for each part of the product, and a court letter for the Legends. Decorative and
 * always beside the area's name, so it is `aria-hidden`. U+FE0E requests text presentation, because
 * without it iOS draws the heart and diamond as emoji.
 */

import type { ReactElement } from 'react';
import type { NavArea } from '@/lib/nav.ts';

const MARKS: Readonly<Record<NavArea, string>> = {
  learn: '♠︎',
  lab: '♦︎',
  play: '♥︎',
  legends: 'K',
  review: '♣︎',
};

export function SuitMark({
  area,
  className,
}: {
  readonly area: NavArea | null;
  readonly className?: string;
}): ReactElement {
  const classes = className === undefined ? 'prl-suit-mark' : `prl-suit-mark ${className}`;
  if (area === null) return <span aria-hidden="true" className={`${classes} prl-suit-mark--blank`} />;
  return (
    <span aria-hidden="true" className={classes} data-area={area}>
      {MARKS[area]}
    </span>
  );
}

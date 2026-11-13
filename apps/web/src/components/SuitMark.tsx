/**
 * The mark each part of the product carries: the four suits for the four steps of the loop the
 * product is built around — learn the idea (spade), work the number in the Lab (diamond), decide at
 * the table (heart), review it afterwards (club) — and a court letter for the Legends, the
 * opponents.
 *
 * It replaced a hand-written `01…05` index on every page head. Those numbers implied a sequence
 * the sections are not in (nobody reads Legends fourth), and two of them disagreed with the nav
 * order they claimed to mirror. A suit says "which part of the product am I in" and nothing else.
 *
 * Always decorative and always beside the area's name in words, so it is hidden from assistive
 * technology and never carries meaning by colour or shape alone. U+FE0E asks for the text
 * presentation: without it iOS draws the heart and the diamond as emoji, in its own colours.
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

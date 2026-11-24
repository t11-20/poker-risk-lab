/**
 * The home page's hand, its price of calling and the two numbers that decide it. The figures come
 * from `homeSpot()`, computed from the deck at render.
 */

import { formatPercent, formatUnits, PlayingCard } from '@prl/ui';
import Link from 'next/link';
import type { CSSProperties, ReactElement } from 'react';
import type { HomeSpot as Spot } from '@/lib/home-spot.ts';
import { lessonHref } from '@/lib/learn-data.ts';

const TO_COME = ['turn', 'river'] as const;

export function HomeSpot({ spot }: { readonly spot: Spot }): ReactElement {
  const need = formatPercent(spot.need);
  const have = formatPercent(spot.have);
  const pays = spot.have > spot.need;
  const total = spot.pot + spot.toCall;
  // Custom properties, so the stylesheet owns how a share is drawn.
  const barStyle = {
    '--prl-spot-have': `${(spot.have * 100).toFixed(2)}%`,
    '--prl-spot-need': `${(spot.need * 100).toFixed(2)}%`,
  } as CSSProperties;
  return (
    <figure aria-labelledby="home-spot-caption" className="prl-spot">
      <div className="prl-spot__table">
        <div className="prl-spot__hand prl-spot__hand--theirs">
          <p className="prl-spot__who">Their hand, face up for this example</p>
          <div className="prl-spot__cards">
            {spot.theirs.map((card) => (
              <PlayingCard card={card} key={card} size="sm" />
            ))}
          </div>
        </div>

        <div className="prl-spot__board">
          <p className="prl-spot__who">The flop, with the turn and river to come</p>
          <div className="prl-spot__cards">
            {spot.board.map((card) => (
              <PlayingCard card={card} key={card} size="md" />
            ))}
            {TO_COME.map((street) => (
              <span aria-hidden="true" className="prl-spot__slot" key={street} />
            ))}
          </div>
        </div>

        <div className="prl-spot__hand prl-spot__hand--yours">
          <p className="prl-spot__who">Your hand</p>
          <div className="prl-spot__cards">
            {spot.yours.map((card) => (
              <PlayingCard card={card} key={card} size="lg" />
            ))}
          </div>
        </div>
      </div>

      <div className="prl-spot__price">
        <p className="prl-spot__bet">
          They bet. There are <strong>{formatUnits(spot.pot)}</strong> in the pot and calling costs{' '}
          <strong>{formatUnits(spot.toCall)}</strong>.
        </p>
        <dl className="prl-spot__figures">
          <div className="prl-spot__figure">
            <dt>Your share must be at least</dt>
            <dd>{need}</dd>
          </div>
          <div className="prl-spot__figure prl-spot__figure--have">
            <dt>Your share is</dt>
            <dd>{have}</dd>
          </div>
        </dl>
        {/* Hidden because it repeats the two figures above. */}
        <div aria-hidden="true" className="prl-spot__bar" style={barStyle}>
          <span className="prl-spot__bar-have" />
          <span className="prl-spot__bar-need" />
        </div>
        <figcaption className="prl-spot__caption" id="home-spot-caption">
          Your {formatUnits(spot.toCall)} would be {need} of a {formatUnits(total)} pot, so that is the share
          you need to break even. Over all {spot.runouts.toLocaleString('en-GB')} ways the turn and river can
          fall, you win {formatPercent(spot.win)}
          {spot.tie > 0 ? ` and split the pot ${formatPercent(spot.tie)}` : ''} of the time.{' '}
          {/* Equity assumes no more betting to the river (`equity.ts`), so the conclusion states that. */}
          If nobody bets again before the river, the call {pays ? 'pays' : 'costs'} at this price. A bet on
          the turn can make you fold before you see that share;{' '}
          <Link href={lessonHref('pot-odds')}>the pot odds lesson</Link> covers what later betting does to a
          price.
        </figcaption>
      </div>
    </figure>
  );
}

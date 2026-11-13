/**
 * A deterministic geometric mark derived from a profile id. Never a portrait or face, because a
 * profile is a modelled style and not a person. Nested polygons take side counts and rotations from
 * a hash of the id, inside a fixed sixteen-sided frame (one side per trait axis).
 * No bitwise operators. Every product stays exact (hash under 2.9e11, MINSTD under 1.0e14), so the
 * server and client render the same bytes. Decoration only, never the deck's randomness.
 * `aria-hidden`, because the heading beside it carries the information.
 */

import { cx, ringPoints } from '@prl/ui';
import type { ReactElement } from 'react';

const VIEWBOX = 48;
const CENTRE = VIEWBOX / 2;

const FRAME_SIDES = 16;
const FRAME_RADIUS = 22;

const LAYER_RADII: readonly number[] = [18, 12.5, 7];
const CORE_RADIUS = 2.6;

/** Triangle to octagon. Above eight sides a polygon reads as a ring. */
const MIN_SIDES = 3;
const SIDE_CHOICES = 6;

const ROTATION_STEPS = 24;
const ROTATION_STEP_DEGREES = 15;

const HASH_MULTIPLIER = 131;
/** 2^31 - 1, prime. */
const MODULUS = 2_147_483_647;
const MINSTD_MULTIPLIER = 48_271;
/** FNV-1a's offset basis, reduced into range. */
const HASH_SEED = 2_166_136_261 % MODULUS;

/** Never zero, which MINSTD would be stuck on. */
function seedFrom(profileId: string): number {
  let hash = HASH_SEED;
  for (const character of profileId) {
    hash = (hash * HASH_MULTIPLIER + (character.codePointAt(0) ?? 0)) % MODULUS;
  }
  return hash === 0 ? 1 : hash;
}

/** Park-Miller MINSTD. */
function makeStream(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * MINSTD_MULTIPLIER) % MODULUS;
    return state;
  };
}

interface SigilLayer {
  readonly radius: number;
  readonly sides: number;
  readonly rotation: number;
}

export function sigilLayers(profileId: string): readonly SigilLayer[] {
  const stream = makeStream(seedFrom(profileId));
  return LAYER_RADII.map((radius) => ({
    radius,
    sides: MIN_SIDES + (stream() % SIDE_CHOICES),
    rotation: (stream() % ROTATION_STEPS) * ROTATION_STEP_DEGREES,
  }));
}

export interface LegendSigilProps {
  readonly profileId: string;
  readonly size?: 'md' | 'lg';
  readonly className?: string;
}

export function LegendSigil(props: LegendSigilProps): ReactElement {
  const { profileId, size = 'md', className } = props;
  const layers = sigilLayers(profileId);
  const coreSides = MIN_SIDES + (seedFrom(profileId) % SIDE_CHOICES);

  return (
    <svg
      className={cx('prl-legend-sigil', size === 'lg' && 'prl-legend-sigil--lg', className)}
      viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}
      aria-hidden="true"
      focusable="false"
    >
      <polygon
        className="prl-legend-sigil__frame"
        points={ringPoints(FRAME_SIDES, 1, {
          centreX: CENTRE,
          centreY: CENTRE,
          radius: FRAME_RADIUS,
        })}
        vectorEffect="non-scaling-stroke"
      />
      {layers.map((layer, index) => (
        <polygon
          key={`prl-sigil-layer-${layer.radius}`}
          className="prl-legend-sigil__layer"
          data-layer={index}
          points={ringPoints(layer.sides, 1, {
            centreX: CENTRE,
            centreY: CENTRE,
            radius: layer.radius,
          })}
          transform={`rotate(${layer.rotation} ${CENTRE} ${CENTRE})`}
          vectorEffect="non-scaling-stroke"
        />
      ))}
      <polygon
        className="prl-legend-sigil__core"
        points={ringPoints(coreSides, 1, {
          centreX: CENTRE,
          centreY: CENTRE,
          radius: CORE_RADIUS,
        })}
      />
    </svg>
  );
}

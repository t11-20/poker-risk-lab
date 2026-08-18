/**
 * The sigil: a deterministic geometric mark derived from a profile id.
 *
 * ## Why this exists instead of a portrait
 *
 * There are no portraits, likenesses, photographs, AI-generated faces or caricatures anywhere in
 * this feature, and there is no configuration that can turn one on. A profile that carries an
 * attributed name is a *modelled style*, not a person, and a face beside that name would undo
 * every disclaimer on the card in one image.
 *
 * A generated mark is also the honest representation. The profile IS a set of numbers — sixteen
 * of them — so its identity is drawn from its identifier and nothing else: nested polygons whose
 * side counts and rotations come from a hash of the id. Same id, same mark, on every screen and
 * in every session. Two profiles get different marks because they have different ids, which is
 * exactly as much as a visual identity should claim here.
 *
 * ## The algorithm, and why it avoids the obvious shortcuts
 *
 *  1. `seedFrom` is a polynomial rolling hash over the id's code points, taken modulo the Mersenne
 *     prime 2147483647. **No bitwise operators**: the usual FNV-1a spelling relies on 32-bit
 *     wrap-around, and in JavaScript that means either `|0` tricks or products past 2^53 where
 *     integer arithmetic stops being exact. Every product here stays under 2.9e11.
 *  2. `stream` is Park-Miller MINSTD (`x = 48271x mod 2147483647`), a published generator whose
 *     largest intermediate is about 1.0e14 — still exactly representable. It is a *decoration*
 *     generator, never used for anything that needs unpredictability; the deck's randomness comes
 *     from the server's CSPRNG and nothing here touches it.
 *  3. The outer frame is always a **sixteen-sided ring**, one side per trait axis. That is the one
 *     part of the mark that is not derived from the hash, because it is a statement about what a
 *     profile is rather than about which profile this is.
 *  4. Geometry comes from `ringPoints` in `@prl/ui`, which is unit-tested against hand-worked
 *     coordinates. Rotation is applied as an SVG `transform` rather than by re-deriving the
 *     trigonometry with a phase offset.
 *
 * Deterministic, server-render safe, and identical byte-for-byte between a server render and a
 * client render — which is what stops React reporting a hydration mismatch on a decorative mark.
 *
 * ## Accessibility
 *
 * The `<svg>` is `aria-hidden`. It carries no information that is not already in the heading
 * beside it, and "geometric mark with five sides rotated 45 degrees" is noise in a screen
 * reader's ear. The profile's real content — its sixteen axes and their values — is rendered as
 * text and as a table elsewhere on every screen that shows a sigil.
 */

import { cx, ringPoints } from '@prl/ui';
import type { ReactElement } from 'react';

/** The drawing box. Square, centred, in user units — the CSS decides how large it renders. */
const VIEWBOX = 48;
const CENTRE = VIEWBOX / 2;

/** One side per trait axis. Not derived from the hash: see the module comment. */
const FRAME_SIDES = 16;
const FRAME_RADIUS = 22;

/** Three nested layers, outermost first. Enough to read as a mark, few enough to stay legible. */
const LAYER_RADII: readonly number[] = [18, 12.5, 7];
const CORE_RADIUS = 2.6;

/** Polygons run from a triangle to an octagon: below three is not a polygon, above eight is a ring. */
const MIN_SIDES = 3;
const SIDE_CHOICES = 6;

/** Rotations land on 15-degree steps, so the mark reads as engineered rather than jittered. */
const ROTATION_STEPS = 24;
const ROTATION_STEP_DEGREES = 15;

const HASH_MULTIPLIER = 131;
/** 2^31 - 1, prime. Shared by the hash and the generator so both stay inside exact integers. */
const MODULUS = 2_147_483_647;
const MINSTD_MULTIPLIER = 48_271;
/** FNV-1a's offset basis, reduced into range. Any non-zero start works; a named one is traceable. */
const HASH_SEED = 2_166_136_261 % MODULUS;

/** A profile id as a seed in 1..MODULUS-1. Never zero, which MINSTD would be stuck on. */
function seedFrom(profileId: string): number {
  let hash = HASH_SEED;
  for (const character of profileId) {
    hash = (hash * HASH_MULTIPLIER + (character.codePointAt(0) ?? 0)) % MODULUS;
  }
  return hash === 0 ? 1 : hash;
}

/** Park-Miller MINSTD. Deterministic, and used for decoration only. */
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

/**
 * The layers for one profile.
 *
 * `map` visits indices in ascending order by specification, so the generator is consumed in a
 * fixed sequence and the mark is stable. Exported so a test can assert that two ids differ and
 * that one id does not.
 */
export function sigilLayers(profileId: string): readonly SigilLayer[] {
  const stream = makeStream(seedFrom(profileId));
  return LAYER_RADII.map((radius) => ({
    radius,
    sides: MIN_SIDES + (stream() % SIDE_CHOICES),
    rotation: (stream() % ROTATION_STEPS) * ROTATION_STEP_DEGREES,
  }));
}

export interface LegendSigilProps {
  /** The profile's stable id. The mark is a function of this and nothing else. */
  readonly profileId: string;
  /** `lg` for a page hero; the default sits beside a card heading. */
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

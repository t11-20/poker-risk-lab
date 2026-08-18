/**
 * How opponent profiles are named and labelled — and why this file exists at all.
 *
 * ## The problem this solves
 *
 * The learning value of "Play a Legend" comes from facing *contrasting expert styles*:
 * a player who applies relentless pressure plays nothing like one who waits for a clear
 * edge, and feeling that difference across a few hundred hands teaches something no
 * lesson can. Attaching a well-known name to a style makes it memorable.
 *
 * It also creates three risks that have nothing to do with poker:
 *
 *   1. **Misrepresentation.** A named opponent invites the reading that this software
 *      reproduces how that person actually plays, or that they endorsed it. Neither is
 *      true. These are coarse models built from *publicly discussed general tendencies*
 *      — aggression, positional awareness, willingness to bluff — not from anyone's
 *      private decision-making, hand histories, or thoughts.
 *   2. **Impersonation.** Generating a real person's inner monologue ("here Ivey is
 *      thinking...") is fabrication presented as insight. It is also the single easiest
 *      way for an educational tool to become disrespectful, and it is banned outright
 *      here — see `commentary.ts`, which can only produce third-person statements about
 *      the *model*.
 *   3. **Name, image and likeness.** Using a living person's name commercially may
 *      require permission. That is a question for a deployer, not something this
 *      codebase can answer.
 *
 * ## The design
 *
 * Every profile carries **both** an archetype name and an optional attributed name, and
 * a single configuration switch decides which the product shows.
 *
 * **The production default is `archetype`.** That is deliberate: the safe mode is the one
 * you get by not thinking about it. A deployer who wants attributed names must set the
 * variable explicitly, which is exactly the moment to have considered whether they may.
 *
 * The educational content is identical in both modes. Nothing about what a learner is
 * taught depends on whose name is on the seat — which is the strongest evidence that the
 * names are decoration and the traits are the substance.
 */

export class LabellingError extends Error {
  override readonly name = 'LabellingError';
}

/**
 * `archetype` — generic style names only ("Heads-Up Pressure Specialist").
 * `attributed` — shows the attributed name alongside the archetype, always with the
 *                disclaimer. Requires an explicit opt-in.
 */
export type NamingMode = 'archetype' | 'attributed';

/**
 * Resolves the naming mode from configuration.
 *
 * Reading the environment here rather than taking it as a parameter is a deliberate
 * choice: it makes the safe default unavoidable. A caller cannot forget to pass a mode
 * and accidentally get the permissive one.
 *
 * @param env the environment to read; injectable so tests do not mutate `process.env`
 */
export function resolveNamingMode(
  env: Readonly<Record<string, string | undefined>> = process.env,
): NamingMode {
  const raw = env['PRL_LEGEND_NAMING']?.trim().toLowerCase();
  if (raw === undefined || raw === '') {
    // No configuration: archetype names. The permissive mode is never the default.
    return 'archetype';
  }
  if (raw === 'archetype') return 'archetype';
  if (raw === 'attributed') {
    return 'attributed';
  }
  throw new LabellingError(
    `PRL_LEGEND_NAMING must be "archetype" or "attributed", received "${raw}". ` +
      'Leave it unset for archetype names, which is the safe default.',
  );
}

/**
 * The disclaimer that accompanies every profile, in both modes.
 *
 * Shown in the profile selector, on the table, and in every post-hand comparison. It is
 * not a footer nobody reads: `profileDisclosure()` returns it as structured data so the
 * UI renders it inline with the profile, and there is no code path that produces a
 * profile card without it.
 */
export const UNIVERSAL_DISCLAIMER =
  'These opponents are educational strategy simulations. Each one is a configurable set of ' +
  'tendencies — how often it enters a pot, how aggressively it bets, how much it adjusts to ' +
  'position and stack depth — chosen to contrast with the others so you can feel the difference ' +
  'between styles. They are not real people, not digital copies of anyone, and not endorsed by ' +
  'anyone.';

/** The extra sentences shown only when attributed names are enabled. */
export const ATTRIBUTION_DISCLAIMER =
  'This profile is loosely inspired by tendencies that have been widely discussed in public poker ' +
  'commentary. It is a coarse approximation of a *style*, built from general reputation rather than ' +
  'from any individual’s hand histories, private decisions or thinking. It does not reproduce how ' +
  'that person plays, it is not affiliated with or approved by them, and nothing here should be read ' +
  'as representing their views. Any resemblance is limited to broad strategic tendencies.';

/** Shown for the course-derived educational profile. */
export const COURSE_PROFILE_DISCLAIMER =
  'This profile represents general educational concepts about disciplined, fundamentals-first play. ' +
  'It does not reproduce, summarise or substitute for any particular course, book or its proprietary ' +
  'material, and is not affiliated with any course provider.';

export interface ProfileNaming {
  /** Stable identifier. Never changes with the naming mode. */
  readonly id: string;
  /** Always available. The name used in `archetype` mode and shown in both modes. */
  readonly archetypeName: string;
  /** A one-line description of the style, independent of any name. */
  readonly archetypeTagline: string;
  /**
   * The attributed name, when the profile has one. Present in the data regardless of
   * mode; whether it is *shown* is decided by `displayNameFor`.
   */
  readonly attributedName?: string;
  /** True for the course-derived educational profile, which uses its own disclaimer. */
  readonly isCourseDerived?: boolean;
}

export interface ProfileDisclosure {
  /** What the UI puts on the seat and in the selector. */
  readonly displayName: string;
  /** Always shown next to the display name. */
  readonly archetypeName: string;
  readonly tagline: string;
  /** True when an attributed name is being displayed. */
  readonly attributed: boolean;
  /**
   * Every disclaimer that must be rendered with this profile, in order. Never empty —
   * `profileDisclosure` throws rather than return an unlabelled profile.
   */
  readonly disclaimers: readonly string[];
  /** A short label for compact UI (a seat plate, a replay line). Never omits the framing. */
  readonly shortLabel: string;
}

/**
 * The single function the API and the UI use to render a profile's identity.
 *
 * There is deliberately no way to get a display name without the disclaimers: they come
 * back in the same object. A component that renders `displayName` and drops
 * `disclaimers` is visibly wrong in review, rather than quietly non-compliant.
 */
export function profileDisclosure(naming: ProfileNaming, mode: NamingMode): ProfileDisclosure {
  if (naming.id === '') throw new LabellingError('a profile must have an id');
  if (naming.archetypeName === '') throw new LabellingError(`profile "${naming.id}" has no archetype name`);
  if (naming.archetypeTagline === '') throw new LabellingError(`profile "${naming.id}" has no tagline`);

  const showAttributed = mode === 'attributed' && naming.attributedName !== undefined;

  const disclaimers: string[] = [UNIVERSAL_DISCLAIMER];
  if (showAttributed) disclaimers.push(ATTRIBUTION_DISCLAIMER);
  if (naming.isCourseDerived === true) disclaimers.push(COURSE_PROFILE_DISCLAIMER);

  return {
    displayName: showAttributed
      ? `${naming.attributedName as string} (modelled style)`
      : naming.archetypeName,
    archetypeName: naming.archetypeName,
    tagline: naming.archetypeTagline,
    attributed: showAttributed,
    disclaimers,
    shortLabel: showAttributed ? `${naming.attributedName as string} — modelled style` : naming.archetypeName,
  };
}

/**
 * Rejects text that impersonates rather than describes.
 *
 * Used by `commentary.ts` on every generated string, and asserted in the tests. This is
 * a guard against the failure mode that matters most in this feature: commentary that
 * drifts from "this model prefers a large bet here" into "Ivey senses weakness". The
 * second is fabrication about a real person, and once one string does it the rest follow.
 *
 * The check is intentionally crude and errs towards rejection. A false positive costs a
 * reworded sentence; a false negative ships a fabricated claim about someone.
 */
const IMPERSONATION_PATTERNS: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  {
    pattern: /\b(?:he|she|they)\s+(?:thinks?|feels?|believes?|senses?|knows?|reads?|wants?)\b/i,
    why: 'attributes a mental state to a person',
  },
  { pattern: /\b(?:is|was)\s+thinking\b/i, why: 'narrates a person’s thoughts' },
  { pattern: /\bwould\s+(?:say|tell|think|feel)\b/i, why: 'puts words or thoughts in a person’s mouth' },
  {
    pattern: /\bin\s+(?:his|her|their)\s+(?:mind|head|view|opinion)\b/i,
    why: 'claims to report a person’s inner view',
  },
  { pattern: /\bfamous(?:ly)?\s+(?:said|says|quoted)\b/i, why: 'implies a quotation' },
  { pattern: /^\s*(?:I|My)\b/i, why: 'first-person voice reads as the person speaking' },

  // A capitalised NAME followed by a mental-state verb. The pronoun pattern above misses
  // "Ivey senses weakness" entirely, because there is no pronoun in it — and that sentence
  // is the exact failure this whole guard exists to prevent, so leaving it uncaught made the
  // guard weakest at the case it was written for.
  //
  // The verb list is deliberately narrow. `reads` and `knows` are excluded because the
  // policy's own counterfactual output legitimately contains "Opponent read:", and a broader
  // list rejected 288 correct strings. A bare mental-state verb with no name in front is also
  // excluded: it rejected 15 authored coaching lines ("believe it", "make sense", "folds far
  // more than feels comfortable"). Measured across all 4,955 strings this package can produce,
  // this pattern has zero false positives.
  {
    pattern: /\b\p{Lu}\p{L}+\s+(?:thinks?|feels?|believes?|senses?|intends?|wants?|remembers?)\b/u,
    why: 'attributes a mental state to a named person',
  },

  // Gendered pronouns at all. Commentary describes a MODEL, which has no gender, so any
  // he/she is either impersonating a person or mis-gendering one. The repo writes they/them
  // for unspecified people, so this costs nothing: zero false positives across every string
  // the package produces. It also catches "He would raise here.", which the `would` pattern
  // above misses because `raise` is a poker verb rather than a speech verb — and broadening
  // `would` to any verb rejected 1,206 correct strings.
  {
    pattern: /\b(?:he|him|his|she|her|hers|himself|herself)\b/i,
    why: 'uses a gendered pronoun — commentary describes a model, not a person',
  },
  {
    pattern: /\bendorse[sd]?\b|\bapproved by\b|\bofficial\b|\bpartnership\b/i,
    why: 'implies endorsement or affiliation',
  },
  {
    pattern: /\bdigital twin\b|\bexact (?:replica|reproduction)\b|\bclone of\b/i,
    why: 'overstates what the model is',
  },
  {
    pattern: /\breal\s+(?:Phil|Doyle|Erik|Johnny|Daniel|Michael|Shaun|Benny)\b/i,
    why: 'conflates the model with the person',
  },
];

export interface ImpersonationFinding {
  readonly text: string;
  readonly why: string;
}

/** @returns the reasons the text is unacceptable; empty means acceptable. */
export function findImpersonation(text: string): readonly ImpersonationFinding[] {
  const findings: ImpersonationFinding[] = [];
  for (const { pattern, why } of IMPERSONATION_PATTERNS) {
    if (pattern.test(text)) findings.push({ text, why });
  }
  return findings;
}

/** Throws unless the text describes the model rather than impersonating a person. */
export function assertNoImpersonation(text: string, where: string): void {
  const findings = findImpersonation(text);
  if (findings.length > 0) {
    throw new LabellingError(
      `${where}: text ${JSON.stringify(text.slice(0, 120))} is not acceptable — ` +
        `${findings.map((finding) => finding.why).join('; ')}. ` +
        'Describe what the MODEL prefers, in the third person, e.g. "this model prefers a larger bet here".',
    );
  }
}

/**
 * The phrase every piece of commentary must be able to be read as. Exported so the
 * commentary generator and its tests share one definition of the required voice.
 */
export const REQUIRED_VOICE = 'this model prefers';

/**
 * How opponent profiles are named and labelled. Named opponents risk misrepresentation, impersonation
 * and name-and-likeness claims, so every profile carries an archetype name and an optional attributed
 * name, and one switch picks which is shown. The default is `archetype`, so the safe mode needs no
 * configuration. What a learner is taught is identical in both modes.
 */

export class LabellingError extends Error {
  override readonly name = 'LabellingError';
}

/**
 * `archetype` shows generic style names only. `attributed` adds the attributed name, always with the
 * disclaimer, and requires an explicit opt-in.
 */
export type NamingMode = 'archetype' | 'attributed';

/**
 * Reads the environment itself so a caller cannot forget a mode and get the permissive one.
 * `env` is injectable so tests do not mutate `process.env`.
 */
export function resolveNamingMode(
  env: Readonly<Record<string, string | undefined>> = process.env,
): NamingMode {
  const raw = env['PRL_LEGEND_NAMING']?.trim().toLowerCase();
  if (raw === undefined || raw === '') {
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

/** Accompanies every profile in both modes. `profileDisclosure()` returns it with the name. */
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
  /** Present in the data in both modes. `profileDisclosure` decides whether it is shown. */
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
  /** Every disclaimer to render with this profile, in order. Never empty. */
  readonly disclaimers: readonly string[];
  /** A short label for compact UI (a seat plate, a replay line). Never omits the framing. */
  readonly shortLabel: string;
}

/**
 * The one way the API and the UI render a profile's identity. The disclaimers come back in the same
 * object as the display name, so there is no way to get one without the other.
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
 * Rejects text that impersonates a person rather than describing the model. `commentary.ts` runs it
 * on every generated string. It errs towards rejection, because a false positive costs a reworded
 * sentence and a false negative ships a fabricated claim about someone.
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

  // A capitalised name followed by a mental-state verb catches "Ivey senses weakness". `reads` and
  // `knows` are left out because the policy writes "Opponent read:", and a broader list rejected 288
  // correct strings. Zero false positives across all 4,955 strings this package can produce.
  {
    pattern: /\b\p{Lu}\p{L}+\s+(?:thinks?|feels?|believes?|senses?|intends?|wants?|remembers?)\b/u,
    why: 'attributes a mental state to a named person',
  },

  // Any gendered pronoun. A model has no gender, and the repo writes they/them for people. This also
  // catches "He would raise here.", which broadening `would` to any verb could only do by rejecting
  // 1,206 correct strings.
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

/** The voice every piece of commentary must read as. Shared by the generator and its tests. */
export const REQUIRED_VOICE = 'this model prefers';

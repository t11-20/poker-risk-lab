/**
 * The age gate's configuration and every decision the proxy makes with it.
 * Threshold, scope and jurisdiction are configuration, never a hard-coded legal conclusion, and the
 * shipped state is no gate plus a visible statement that nobody has decided yet.
 * It verifies nothing (a checkbox is a self-declaration) and locks nobody out.
 * A leaf module with no imports, because `src/proxy.ts` and plain `node --test` files both load it.
 */

/** Prefixed first. `__Host-` cannot be set over plain HTTP; see `session-cookie-names.ts`. */
export const AGE_GATE_COOKIE_NAMES = ['__Host-prl_age_check', 'prl_age_check'] as const;

/** The route that renders the gate. Never itself gated, or the redirect would be a loop. */
export const AGE_GATE_PATH = '/age-check';

/** Query parameter carrying where the reader was going, so they are put back afterwards. */
export const AGE_GATE_RETURN_PARAM = 'next';

/** Query parameter carrying the declaration itself. Its value is the threshold declared against. */
export const AGE_GATE_DECLARE_PARAM = 'declare';

/** Query parameter set by the "I am under" control, which records nothing and only changes copy. */
export const AGE_GATE_DECLINED_PARAM = 'declined';

/** The value `AGE_GATE_DECLINED_PARAM` takes. A fixed string, so a stray `?declined=` is ignored. */
export const AGE_GATE_DECLINED_VALUE = 'yes';

/** Where a reader goes when the return path is missing or refused. The home page, never `/play`. */
export const AGE_GATE_DEFAULT_RETURN = '/';

/**
 * 180 days. Re-asking on every browser restart trains readers to click through, and a year outlives
 * the window in which a young reader's answer would change.
 */
export const AGE_GATE_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;

/** A placeholder for counsel's decision, reachable only once `PRL_AGE_GATE=on` is set. */
export const AGE_GATE_DEFAULT_MINIMUM = 18;

/**
 * A configured threshold is clamped into 13 to 25 rather than replaced by the default, because
 * falling back to a lower number would weaken a control the deployer meant to be strict.
 */
export const AGE_GATE_MINIMUM_FLOOR = 13;
export const AGE_GATE_MINIMUM_CEILING = 25;

/** Longest jurisdiction label rendered on a page. Past this it is prose, not a place name. */
export const AGE_GATE_JURISDICTION_MAX_LENGTH = 80;

/** `on` shows the gate; `off` is the shipped state and means the deployer has not decided yet. */
export type AgeGateMode = 'off' | 'on';

/** `play` gates the tables only, the default when on. `site` gates all but the gate and legal pages. */
export type AgeGateScope = 'play' | 'site';

export interface AgeGateConfig {
  readonly mode: AgeGateMode;
  /** True when `PRL_AGE_GATE` was set at all. False means "nobody has decided", not "decided off". */
  readonly configured: boolean;
  readonly minimumAge: number;
  readonly scope: AgeGateScope;
  readonly jurisdiction: string | null;
  /** Rendered on the page rather than logged and forgotten. */
  readonly problems: readonly string[];
}

/** Legal pages stay readable before any declaration. Gating `/age-check` itself would loop. */
const AGE_GATE_ALWAYS_OPEN: readonly string[] = [AGE_GATE_PATH, '/terms', '/privacy', '/responsible-use'];

/** The surfaces `play` scope covers. `/review` is a reader's own history and needs `/play` first. */
const AGE_GATE_PLAY_PREFIXES: readonly string[] = ['/play'];

/** Exact segment matching, never `includes`, so `/playground` does not match `/play`. */
function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * Drops control, bidi and zero-width characters (the set `users_display_name_shape` excludes),
 * then collapses whitespace and truncates.
 */
function cleanLabel(raw: string): string {
  let kept = '';
  for (const char of raw) {
    const code = char.codePointAt(0) ?? 0;
    // Line breaks become a space, so the words either side do not join.
    if (code === 0x09 || code === 0x0a || code === 0x0d) {
      kept += ' ';
      continue;
    }
    if (code < 0x20) continue;
    if (code >= 0x7f && code <= 0x9f) continue;
    if (code >= 0x200b && code <= 0x200f) continue;
    if (code === 0x2028 || code === 0x2029) continue;
    if (code >= 0x202a && code <= 0x202e) continue;
    if (code >= 0x2066 && code <= 0x2069) continue;
    if (code === 0xfeff) continue;
    kept += char;
  }
  const collapsed = kept.replace(/\s+/gu, ' ').trim().slice(0, AGE_GATE_JURISDICTION_MAX_LENGTH);
  return collapsed;
}

/**
 * Off by default, against ADR 0011's safe-default rule, for three reasons. A default threshold would
 * be a legal claim. The unconfigured state is rendered loudly on `/terms`, `/responsible-use` and
 * `/age-check`. A default-on gate would silently drop `/play` from `a11y-audit.mjs` coverage.
 * Browser harnesses need `PRL_AGE_GATE=off` when a deployment switches the gate on.
 *
 * Every unreadable value resolves to the stricter reading and lands in `problems`. Nothing throws,
 * because this runs in the proxy on every request, where a throw is a 500 on every page.
 *
 * @param env injectable so tests never mutate `process.env`
 */
export function readAgeGateConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AgeGateConfig {
  const problems: string[] = [];

  const rawMode = env['PRL_AGE_GATE']?.trim().toLowerCase() ?? '';
  const configured = rawMode !== '';
  let mode: AgeGateMode = 'off';
  if (rawMode === 'on') {
    mode = 'on';
  } else if (configured && rawMode !== 'off') {
    // Shown rather than skipped. The operator's value is not echoed onto the page.
    mode = 'on';
    problems.push(
      'PRL_AGE_GATE is set to something that is neither "on" nor "off", so the gate is being shown. ' +
        'An unreadable setting must never be the reason a gate is skipped.',
    );
  }

  let minimumAge = AGE_GATE_DEFAULT_MINIMUM;
  const rawMinimum = env['PRL_AGE_GATE_MINIMUM_AGE']?.trim() ?? '';
  if (rawMinimum !== '') {
    // A digit shape rather than `Number`, which reads `0x12` as 18 and `1e2` as 100.
    if (!/^\d{1,3}$/u.test(rawMinimum)) {
      problems.push(
        `PRL_AGE_GATE_MINIMUM_AGE is not a whole number, so the threshold fell back to ${String(AGE_GATE_DEFAULT_MINIMUM)}.`,
      );
    } else {
      const parsed = Number(rawMinimum);
      minimumAge = Math.min(Math.max(parsed, AGE_GATE_MINIMUM_FLOOR), AGE_GATE_MINIMUM_CEILING);
      if (minimumAge !== parsed) {
        problems.push(
          `PRL_AGE_GATE_MINIMUM_AGE is outside ${String(AGE_GATE_MINIMUM_FLOOR)} to ${String(AGE_GATE_MINIMUM_CEILING)} and was clamped to ${String(minimumAge)}.`,
        );
      }
    }
  }

  let scope: AgeGateScope = 'play';
  const rawScope = env['PRL_AGE_GATE_SCOPE']?.trim().toLowerCase() ?? '';
  if (rawScope === 'site') {
    scope = 'site';
  } else if (rawScope !== '' && rawScope !== 'play') {
    scope = 'site';
    problems.push(
      'PRL_AGE_GATE_SCOPE is set to something that is neither "play" nor "site", so the wider of the ' +
        'two is in force.',
    );
  }

  const rawJurisdiction = env['PRL_AGE_GATE_JURISDICTION'] ?? '';
  const cleaned = cleanLabel(rawJurisdiction);
  if (rawJurisdiction.trim() !== '' && cleaned === '') {
    problems.push('PRL_AGE_GATE_JURISDICTION contained nothing renderable and is being ignored.');
  }

  return {
    mode,
    configured,
    minimumAge,
    scope,
    jurisdiction: cleaned === '' ? null : cleaned,
    problems,
  };
}

/** True when this path sits behind the gate under the given scope. */
export function pathNeedsAgeGate(pathname: string, scope: AgeGateScope): boolean {
  if (AGE_GATE_ALWAYS_OPEN.some((prefix) => matchesPrefix(pathname, prefix))) return false;
  if (scope === 'site') return true;
  return AGE_GATE_PLAY_PREFIXES.some((prefix) => matchesPrefix(pathname, prefix));
}

/**
 * The cookie's value is the threshold declared against, so raising the threshold re-asks.
 * When both cookie names are present the lower value wins, so an ambiguous declaration re-asks.
 */
export function readDeclaredAge(cookieHeader: string | null): number | null {
  if (cookieHeader === null || cookieHeader === '') return null;
  let lowest: number | null = null;
  for (const pair of cookieHeader.split(';')) {
    const separator = pair.indexOf('=');
    // `<= 0` covers both a missing `=` and a nameless leading `=`.
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    if (!(AGE_GATE_COOKIE_NAMES as readonly string[]).includes(name)) continue;
    const value = pair.slice(separator + 1).trim();
    if (!/^\d{1,3}$/u.test(value)) continue;
    const parsed = Number(value);
    lowest = lowest === null ? parsed : Math.min(lowest, parsed);
  }
  return lowest;
}

/** True when this request already carries a declaration good for the current threshold. */
export function hasAgeDeclaration(cookieHeader: string | null, minimumAge: number): boolean {
  const declared = readDeclaredAge(cookieHeader);
  return declared !== null && declared >= minimumAge;
}

/** The `Set-Cookie` value recording a declaration. `secure` decides the name and the attribute. */
export function ageDeclarationCookie(minimumAge: number, secure: boolean): string {
  const name = secure ? AGE_GATE_COOKIE_NAMES[0] : AGE_GATE_COOKIE_NAMES[1];
  const parts = [
    `${name}=${String(minimumAge)}`,
    // `Path=/` and no `Domain` are required by the `__Host-` prefix and are correct without it.
    'Path=/',
    `Max-Age=${String(AGE_GATE_MAX_AGE_SECONDS)}`,
    // `Lax`, so a reader following a link from another site arrives already past the gate.
    'SameSite=Lax',
    'HttpOnly',
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/** A bookmarked `/age-check?declare=18` stops working when the threshold moves to 21. */
export function declarationValue(minimumAge: number): string {
  return String(minimumAge);
}

/**
 * The open-redirect check on the attacker-controlled `next`. Refuses anything not starting with a
 * single `/`, `//host` and `/\host` (protocol-relative to browsers), control characters, more than
 * 512 characters, and the gate route itself.
 */
export function safeReturnPath(raw: string | null): string {
  if (raw === null || raw === '') return AGE_GATE_DEFAULT_RETURN;
  if (!raw.startsWith('/')) return AGE_GATE_DEFAULT_RETURN;
  if (raw.startsWith('//') || raw.startsWith('/\\')) return AGE_GATE_DEFAULT_RETURN;
  // A code-point walk, because biome refuses a control character inside a regular expression.
  for (const char of raw) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return AGE_GATE_DEFAULT_RETURN;
  }
  if (raw.length > 512) return AGE_GATE_DEFAULT_RETURN;
  const pathname = raw.split('?')[0] ?? '/';
  if (matchesPrefix(pathname, AGE_GATE_PATH)) return AGE_GATE_DEFAULT_RETURN;
  return raw;
}

/** Drops `_rsc`, or the return URL would serve an RSC payload instead of a page (a blank screen). */
export function ageCheckLocation(pathname: string, search: string): string {
  const incoming = new URLSearchParams(search);
  incoming.delete('_rsc');
  const rest = incoming.toString();
  const params = new URLSearchParams();
  params.set(AGE_GATE_RETURN_PARAM, rest === '' ? pathname : `${pathname}?${rest}`);
  return `${AGE_GATE_PATH}?${params.toString()}`;
}

export interface AgeGateRequest {
  readonly pathname: string;
  readonly search: string;
  readonly cookieHeader: string | null;
  /** Passed in, because `isDocumentNavigation` in `guest-bootstrap.ts` owns that judgement. */
  readonly navigation: boolean;
  readonly secure: boolean;
  readonly config: AgeGateConfig;
}

export type AgeGateOutcome =
  | { readonly kind: 'allow' }
  | { readonly kind: 'challenge'; readonly location: string }
  | { readonly kind: 'accepted'; readonly location: string; readonly setCookie: string };

const ALLOW: AgeGateOutcome = { kind: 'allow' };

/**
 * The whole decision as one pure function, cheapest check first.
 * The declaration is a GET so the gate works without JavaScript or a route handler. A forged link can
 * only make a reader declare their own age, and `legal-review-requirements.md` flags that clause.
 */
export function decideAgeGate(request: AgeGateRequest): AgeGateOutcome {
  const { config } = request;
  if (!request.navigation) return ALLOW;

  if (matchesPrefix(request.pathname, AGE_GATE_PATH)) {
    // The gate page renders in every configuration, so only an actual declaration acts here.
    if (config.mode === 'off') return ALLOW;
    const params = new URLSearchParams(request.search);
    if (params.get(AGE_GATE_DECLARE_PARAM) !== declarationValue(config.minimumAge)) return ALLOW;
    return {
      kind: 'accepted',
      location: safeReturnPath(params.get(AGE_GATE_RETURN_PARAM)),
      setCookie: ageDeclarationCookie(config.minimumAge, request.secure),
    };
  }

  if (config.mode === 'off') return ALLOW;
  if (!pathNeedsAgeGate(request.pathname, config.scope)) return ALLOW;
  if (hasAgeDeclaration(request.cookieHeader, config.minimumAge)) return ALLOW;
  return { kind: 'challenge', location: ageCheckLocation(request.pathname, request.search) };
}

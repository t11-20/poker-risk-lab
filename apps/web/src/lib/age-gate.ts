/**
 * The age gate: what it is configured to do, and every decision the proxy makes with it.
 *
 * ## The two defects this exists for, which pull in opposite directions
 *
 * **The first.** Nothing in this product had ever asked how old a reader was, and there was no way
 * for a deployer to make it ask. A deployment that genuinely needed a gate — because of where it
 * was being offered, or who it was being offered to — had to fork the app to get one. A control
 * that can only be added by forking is a control nobody adds.
 *
 * **The second, and it is the reason for every line of restraint below.** The obvious fix is to
 * hard-code eighteen and be done. That is a legal conclusion, drawn for every jurisdiction at once,
 * by a codebase that has no basis for it. `docs/PRODUCT-GUARDRAILS.md` is emphatic that this is not
 * a gambling product — no money, nothing to buy, nothing to win, no cash-out — and whether a free
 * play-money simulator falls under any minimum-age rule at all is a question for a lawyer in each
 * place it is offered, not for this file. Writing `18` here would look like an answer.
 *
 * So: the threshold, the scope and the jurisdiction it is claimed to satisfy are all configuration,
 * and the shipped configuration is **no gate plus a visible, unmissable statement that nobody has
 * decided yet**. See "why the default is off" below, which is the hardest call in this module and
 * the one most worth arguing with.
 *
 * ## What this module deliberately does NOT do
 *
 * It does not verify anything. It cannot. A checkbox is a self-declaration and every honest word on
 * `/age-check` says so — there is no document check, no third-party estimation service, no stored
 * date of birth and no column anywhere in the schema that could hold one. Adding real verification
 * would mean collecting identity documents, which is a far larger privacy exposure than the thing
 * it protects against, and it would need its own threat-model review.
 *
 * It does not lock anyone out. A reader who declares they are under the threshold is shown why the
 * gate exists and where the reading material is; nothing is recorded and they may come back and
 * answer differently. Pretending otherwise would be theatre — a self-declaration with a lockout
 * enforces nothing except an inconvenience on the honest.
 *
 * It does not decide law, name a regulator, or claim compliance with anything.
 *
 * ## Why this is a leaf module
 *
 * Nothing is imported here. `src/proxy.ts` runs in the middleware and has no request scope to
 * borrow from, and `apps/web/test/age-gate.test.ts` is a plain `node --test` file with no Next
 * runtime at all — so anything either of them needs has to be reachable without `next/headers`,
 * without `next/server`, and without a component. `src/lib/session-cookie-names.ts` is the
 * precedent and its header explains the failure this shape prevents: the alternative is the cookie
 * name existing in two places that can disagree, and a disagreement here means a gate that is shown
 * to a reader who already passed it, forever.
 *
 * `isDocumentNavigation` is NOT re-implemented here. `decideAgeGate` takes the answer as a
 * parameter, because `src/lib/guest-bootstrap.ts` already owns that judgement and two copies of
 * "what counts as a navigation" is two things to keep in step.
 *
 * ## What breaks if this is removed
 *
 * A deployer who has been told by counsel that they must gate has no way to comply, and the legal
 * pages that reference the gate start describing something that does not exist.
 */

/**
 * The two names the declaration cookie can have, prefixed first.
 *
 * Same two-naming-regimes problem as the session cookie, and the same answer: `__Host-` is a
 * browser-enforced guarantee (exact host, `Secure`, `Path=/`, no `Domain`) that cannot be used over
 * plain HTTP, so development gets the unprefixed name and a TLS deployment gets the prefixed one.
 * `src/lib/session-cookie-names.ts` carries the full reasoning.
 */
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
 * How long a declaration stands: 180 days.
 *
 * Not a session cookie — re-asking on every browser restart is the nagging that trains a reader to
 * click through without reading, which is the failure mode of every age gate on the internet. Not a
 * year either: a declaration is a statement about a person at a moment, and half a year is long
 * enough to be unobtrusive while still expiring inside the window in which a young reader's answer
 * would change. There is no security property here to preserve, so the number is chosen entirely on
 * how often it is reasonable to ask.
 */
export const AGE_GATE_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;

/**
 * The threshold used when the gate is switched on without one being named.
 *
 * Eighteen, and it is a *placeholder for a decision*, not an assertion that eighteen is correct
 * anywhere. It is reachable only once a deployer has already set `PRL_AGE_GATE=on`, which is the
 * moment somebody is thinking about the question; the pages, and
 * `docs/production/legal-review-requirements.md`, both say in as many words that the number has to
 * come from counsel.
 */
export const AGE_GATE_DEFAULT_MINIMUM = 18;

/**
 * The band a configured threshold has to fall in: 13 to 25.
 *
 * Below 13 a self-declaration is not a meaningful thing to ask a reader for under any regime this
 * product could plausibly meet, and above 25 the value is overwhelmingly likely to be a typo (a
 * mistyped `211` should not silently become a gate nobody can pass). A value outside the band is
 * clamped INTO it rather than replaced by the default, because falling back to a lower number would
 * quietly weaken a control the deployer clearly meant to be strict.
 */
export const AGE_GATE_MINIMUM_FLOOR = 13;
export const AGE_GATE_MINIMUM_CEILING = 25;

/** Longest jurisdiction label rendered on a page. Past this it is prose, not a place name. */
export const AGE_GATE_JURISDICTION_MAX_LENGTH = 80;

/** `on` shows the gate; `off` is the shipped state and means the deployer has not decided yet. */
export type AgeGateMode = 'off' | 'on';

/**
 * Which parts of the product a gate covers.
 *
 * `play` — the simulated tables only. The default when the gate is switched on, because that is the
 * surface any minimum-age rule would plausibly be about, and gating a written lesson on probability
 * behind an age question is not proportionate to anything.
 *
 * `site` — everything except the gate itself and the legal pages. For a deployer told that the
 * whole offering has to sit behind a declaration.
 */
export type AgeGateScope = 'play' | 'site';

export interface AgeGateConfig {
  readonly mode: AgeGateMode;
  /** True when `PRL_AGE_GATE` was set at all. False means "nobody has decided", not "decided off". */
  readonly configured: boolean;
  readonly minimumAge: number;
  readonly scope: AgeGateScope;
  /** The place whose rule the threshold is claimed to satisfy, or null when none was named. */
  readonly jurisdiction: string | null;
  /** Misconfigurations, in plain sentences. Rendered on the page rather than logged and forgotten. */
  readonly problems: readonly string[];
}

/**
 * Paths a gate never covers, whatever the scope.
 *
 * The legal pages are on this list on purpose and it is not a convenience. A reader has to be able
 * to read what a deployment claims about their data, and what it is asking them to agree to,
 * BEFORE they are asked to declare anything — a privacy policy that can only be read by people who
 * have already answered a question about themselves is not a privacy policy. `/age-check` is here
 * for the mechanical reason: gating the gate is an infinite redirect.
 */
const AGE_GATE_ALWAYS_OPEN: readonly string[] = [AGE_GATE_PATH, '/terms', '/privacy', '/responsible-use'];

/** The surfaces `play` scope covers. `/review` is a reader's own history and needs `/play` first. */
const AGE_GATE_PLAY_PREFIXES: readonly string[] = ['/play'];

/**
 * Exact segment matching, never `includes`.
 *
 * `/playground` must not match `/play`, and `/terms-and-conditions` must not be mistaken for the
 * always-open `/terms`. A substring test here would silently open a gated route or gate an open
 * one, and both failures look like the code working. `test/age-gate.test.ts` feeds this the
 * substring cases directly.
 */
function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * Strips what must never reach a rendered page from an operator-supplied label.
 *
 * Control characters, bidi overrides and zero-width characters, then collapsed whitespace, then
 * truncation. The same set `users_display_name_shape` excludes in `db/migrations/0001_initial.sql`,
 * and for the same reason: those are the characters used to make one string look like another. This
 * value comes from a deployment's own environment rather than from a stranger, so the risk is
 * lower — but "our own operator would never" is how unvalidated values reach pages.
 */
function cleanLabel(raw: string): string {
  let kept = '';
  for (const char of raw) {
    const code = char.codePointAt(0) ?? 0;
    // Tab, newline and carriage return become a space rather than vanishing: dropping them would
    // join the words either side of a line break into one.
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
 * Reads the gate's configuration from the live process environment.
 *
 * ## Why the default is OFF, and the argument against it
 *
 * ADR 0011 sets this repository's rule for a switch with a safe side and a permissive one: "the
 * mode you get by not thinking about it should be the safe one", which is why `PRL_LEGEND_NAMING`
 * defaults to archetype names. Applied here that reads as "default the gate on", and it was very
 * nearly the decision. Three things moved it:
 *
 *  1. **There is no safe side to default to.** A gate that is on asserts a threshold; a gate that
 *     is off asserts none. Both are claims, and only one of them is a claim about the law of a
 *     place this code has never heard of. `18` shipped as a default would be read — correctly — as
 *     this project's answer to a question the brief for it says not to answer.
 *  2. **Silence is what makes a default dangerous, and this one is not silent.** `/responsible-use`
 *     and `/terms` both render an unmissable notice while `configured` is false, `/age-check` says
 *     it in the first sentence, and it is the first entry in
 *     `docs/production/legal-review-requirements.md`. The unresolved state is louder than a
 *     resolved-looking wrong one.
 *  3. **A default-on gate degrades a release gate that is in `pnpm run verify`.**
 *     `scripts/a11y-audit.mjs` crawls from `/` and follows links; with `/play` redirecting, the
 *     table screens silently stop being audited and the report still says PASS.
 *     `scripts/keyboard-audit.mjs` drives `/play` directly and would fail outright. Neither script
 *     is editable from here. Shipping a change that quietly shrinks an accessibility gate's
 *     coverage, to install a control nobody had asked for yet, is the worse trade.
 *
 * The honest cost, stated plainly: a deployer who reads nothing ships with no age gate. That is a
 * real risk and it is why the unconfigured state is treated as a launch blocker in the document
 * rather than as a setting with a sensible default. **When the gate IS switched on, the browser
 * harnesses need `PRL_AGE_GATE=off` in their environment or they will audit the interstitial
 * instead of the table.**
 *
 * ## Fail towards the gate, never away from it
 *
 * Every unreadable value resolves to the STRICTER reading: an unrecognised mode shows the gate, an
 * unrecognised scope covers the whole site, an out-of-range threshold is clamped rather than
 * dropped. A misconfiguration must never be the reason a gate is skipped. Each one also lands in
 * `problems`, which the pages render — a control that silently corrected itself is a control nobody
 * fixes.
 *
 * Nothing here throws. `resolveNamingMode` in `@prl/poker-ai` throws on a bad value and is right
 * to: it runs once, at module load, where a throw is a boot failure. This runs inside the proxy on
 * every request, where a throw is a 500 on every page of the site including the pages that would
 * have explained the problem.
 *
 * @param env the environment to read; injectable so tests never mutate `process.env`
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
    // Shown rather than skipped, and the value itself is not echoed back: an operator-supplied
    // string does not need to be reflected onto a page to say that it was not understood.
    mode = 'on';
    problems.push(
      'PRL_AGE_GATE is set to something that is neither "on" nor "off", so the gate is being shown. ' +
        'An unreadable setting must never be the reason a gate is skipped.',
    );
  }

  let minimumAge = AGE_GATE_DEFAULT_MINIMUM;
  const rawMinimum = env['PRL_AGE_GATE_MINIMUM_AGE']?.trim() ?? '';
  if (rawMinimum !== '') {
    // A decimal-digit shape rather than `Number`, which accepts `0x12` as eighteen and `1e2` as a
    // hundred. Neither is a threshold anybody typed on purpose.
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
 * The threshold a declaration cookie records, or null when there is no usable declaration.
 *
 * The cookie's VALUE is the threshold that was declared against, not a flag. That is what makes a
 * raised threshold re-ask: a deployer who moves from 18 to 21 has changed the question, and a
 * cookie saying "I answered the old one" is not an answer to the new one. A boolean cookie would
 * have silently carried every existing reader past the new threshold.
 *
 * When both cookie names are somehow present the LOWER value wins, which is the opposite of the
 * ordering `session-cookie-names.ts` uses and is deliberate: that file is picking a credential and
 * takes the one with the stronger browser guarantee, whereas this is a gate and the conservative
 * answer to an ambiguous declaration is to ask again.
 */
export function readDeclaredAge(cookieHeader: string | null): number | null {
  if (cookieHeader === null || cookieHeader === '') return null;
  let lowest: number | null = null;
  for (const pair of cookieHeader.split(';')) {
    const separator = pair.indexOf('=');
    // `<= 0` covers both "no `=` at all" and a leading `=`, which is a nameless malformed pair.
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
    // `Lax` rather than `Strict`: a reader following a link to this site from anywhere else must
    // arrive already past the gate, or the declaration is worth nothing to them.
    'SameSite=Lax',
    // Nothing in the browser reads this. It exists for the proxy, so script has no business seeing
    // it, and `HttpOnly` removes it from the reach of anything injected onto a page.
    'HttpOnly',
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/**
 * The value the declaration control submits: the threshold, as a string.
 *
 * A bookmarked or shared `/age-check?declare=18` therefore stops working the moment the deployment
 * moves to 21, instead of quietly admitting somebody under the new threshold.
 */
export function declarationValue(minimumAge: number): string {
  return String(minimumAge);
}

/**
 * A return path that is safe to redirect to, or the home page.
 *
 * The `next` parameter is attacker-controlled in the ordinary sense — anyone can send anyone a link
 * — so this is the open-redirect check, not a formality. Refused: anything not starting with a
 * single `/` (absolute URLs, `javascript:`), `//host` and `/\host` (both of which browsers read as
 * protocol-relative and would leave the origin), anything carrying a control character, anything
 * absurdly long, and the gate route itself, which would redirect a reader in a circle.
 */
export function safeReturnPath(raw: string | null): string {
  if (raw === null || raw === '') return AGE_GATE_DEFAULT_RETURN;
  if (!raw.startsWith('/')) return AGE_GATE_DEFAULT_RETURN;
  if (raw.startsWith('//') || raw.startsWith('/\\')) return AGE_GATE_DEFAULT_RETURN;
  // A code-point walk rather than a regex over the control range, because biome refuses a
  // control character inside a regular expression and it is right to: the escape is easy to
  // misread and the loop says what it excludes.
  for (const char of raw) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return AGE_GATE_DEFAULT_RETURN;
  }
  if (raw.length > 512) return AGE_GATE_DEFAULT_RETURN;
  const pathname = raw.split('?')[0] ?? '/';
  if (matchesPrefix(pathname, AGE_GATE_PATH)) return AGE_GATE_DEFAULT_RETURN;
  return raw;
}

/**
 * Where a gated request is sent, carrying where it was going.
 *
 * `_rsc` is dropped. Next appends it to the URL of a router navigation, and a `next` value that
 * still carried it would send the reader back to a URL whose response is an RSC payload rather than
 * a page — a blank screen at the end of an otherwise working gate.
 */
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
  /** The raw query string, leading `?` optional — `URLSearchParams` accepts both. */
  readonly search: string;
  readonly cookieHeader: string | null;
  /**
   * Whether this request is a NAVIGATION as opposed to a prefetch or a subresource.
   *
   * Passed in rather than derived, because `isDocumentNavigation` in `src/lib/guest-bootstrap.ts`
   * already owns that judgement and a second copy would drift. The proxy widens it by one case for
   * this feature: see the comment at its call site for why an in-app router navigation has to be
   * gated when it must not be allowed to mint a guest.
   */
  readonly navigation: boolean;
  /** True on HTTPS, which decides the cookie's name and whether it carries `Secure`. */
  readonly secure: boolean;
  readonly config: AgeGateConfig;
}

export type AgeGateOutcome =
  | { readonly kind: 'allow' }
  | { readonly kind: 'challenge'; readonly location: string }
  | { readonly kind: 'accepted'; readonly location: string; readonly setCookie: string };

const ALLOW: AgeGateOutcome = { kind: 'allow' };

/**
 * The whole decision, as one pure function.
 *
 * Order matters and is checked cheapest-first: a request that is not a navigation is settled by one
 * boolean, and the overwhelming majority of requests never reach the cookie parse.
 *
 * The declaration is accepted on a GET rather than a POST, which is worth being explicit about
 * because it looks like a state-changing GET and in one narrow sense it is. Two reasons it is the
 * right shape here. It keeps the gate working with JavaScript disabled and with no route handler,
 * which matters for a control that stands between a reader and the whole product. And the "forgery"
 * an anti-CSRF token would prevent is a third party causing a reader to declare their own age,
 * which changes nothing a reader could not do themselves by clicking the button — there is no
 * account state, no server record and nothing to escalate. It is recorded as a flagged clause in
 * `docs/production/legal-review-requirements.md` all the same, because "a self-declaration can be
 * set by a link" is a fact about the gate's strength that a reviewer should hear from us.
 */
export function decideAgeGate(request: AgeGateRequest): AgeGateOutcome {
  const { config } = request;
  if (!request.navigation) return ALLOW;

  if (matchesPrefix(request.pathname, AGE_GATE_PATH)) {
    // The gate page itself. It renders in every configuration — including with the gate off, where
    // it explains that this deployment has not been configured — so only an actual declaration
    // does anything here.
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

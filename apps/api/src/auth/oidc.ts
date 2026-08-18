/**
 * An OpenID Connect relying party, written out rather than installed.
 *
 * `openid-client` is a good library and it is deliberately not a dependency here. The whole
 * flow this app needs is authorization code + PKCE + one ID token, and that is a few hundred
 * lines of `node:crypto` and `fetch`. Set against that: this repo's supply-chain policy treats
 * every new package as a release-blocking decision (see `docs/SECURITY.md` and
 * `docs/security/shai-hulud-snapshot-2026-08-17.md`), and an authentication dependency is the
 * single worst place to accept an unreviewed transitive tree. Writing it out also means every
 * check below is *visible*, with the reason it exists next to it, instead of being a
 * configuration flag whose default nobody has read.
 *
 * ## What is implemented
 *
 * - Discovery, validated and cached with a TTL, failing closed on a malformed document.
 * - JWKS, cached, selected by `kid`, with one refetch on an unknown `kid` for key rotation and
 *   a floor between refetches so an unknown `kid` cannot be used as a request amplifier.
 * - PKCE, S256 only. The verifier's *digest* is what gets persisted.
 * - `state` and `nonce` from `randomBytes`, persisted hashed, single use, expiring.
 * - Full ID token verification. Every check has a comment saying what it stops.
 *
 * ## What is deliberately NOT implemented
 *
 * - The implicit and hybrid flows. There is no reason to accept a token in a URL fragment.
 * - `client_secret_jwt` / `private_key_jwt`. Not needed, and each is more attack surface.
 * - The UserInfo endpoint. The ID token already carries everything this app stores.
 * - Refresh tokens. Sessions here are our own cookie; a long-lived provider credential would
 *   be a second thing to keep safe for no benefit.
 * - `email`. Not requested, not read, not stored. Identity is `(iss, sub)` and nothing else:
 *   an email address is mutable, frequently unverified, and reused across providers, so keying
 *   on it means one address change or one unverified claim silently merges two accounts.
 *
 * ## Nothing here logs a secret
 *
 * Every failure carries a `logDetail` that names the *check* that failed, never the value that
 * failed it. No token, code, verifier, state or nonce appears in any string in this file.
 */

import { constants, createPublicKey, verify } from 'node:crypto';
import type { OidcConfig } from '../config.ts';
import { AppError } from '../errors.ts';
// Digests and comparisons come from the repository layer, not from a second copy here.
// `hashOidcSecret` is what `prl.oidc_login_attempts` stores, so the nonce comparison below is
// only valid because it is the *same* function — and `timingSafeEquals` is the house rule for
// comparing two digests, with a long note on why it tolerates a length mismatch.
import { hashOidcSecret, timingSafeEquals } from '../repositories/hashing.ts';
import { generateOidcSecret } from '../repositories/ids.ts';
import { OIDC_ATTEMPT_TTL_SECONDS } from '../repositories/sessions.ts';

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/**
 * The only signature algorithms accepted on an ID token.
 *
 * An allowlist, checked against the token's own `alg` header — which is attacker-controlled
 * until the signature verifies, and is therefore never allowed to *choose* the verification
 * strategy. Both entries are asymmetric, which is the property that matters: see
 * `assertAlgAllowed` for the algorithm-confusion attack this closes.
 */
export const SUPPORTED_ID_TOKEN_ALGS = ['RS256', 'ES256'] as const;
export type SupportedIdTokenAlg = (typeof SUPPORTED_ID_TOKEN_ALGS)[number];

/**
 * Tolerance for clock disagreement between this server and the provider, in seconds.
 *
 * 60 seconds. Every real deployment has some skew, and a token rejected because two machines
 * disagree by two seconds is an outage with no security benefit. Larger would widen the window
 * in which an expired token is still accepted, which is the thing the tolerance costs.
 */
export const CLOCK_SKEW_SECONDS = 60;

/**
 * How old an ID token may be, by its own `iat`.
 *
 * The single-use `nonce` is the real replay defence; this is the cheap backstop that bounds how
 * long a captured token stays interesting at all. Ten minutes matches the login attempt's own
 * TTL, so a token older than the attempt that requested it is refused by both.
 */
export const MAX_ID_TOKEN_AGE_SECONDS = 600;

/**
 * How long a login attempt (state/nonce/verifier) stays usable, in milliseconds.
 *
 * Derived from the repository's constant rather than restated, so the cookie's `Max-Age` and the
 * row's `expires_at` cannot drift apart — a cookie that outlives its row is a confusing failure,
 * and one that dies first is a sign-in that fails for no visible reason.
 */
export const OIDC_ATTEMPT_TTL_MS = OIDC_ATTEMPT_TTL_SECONDS * 1_000;

/** Discovery cache TTL. Long enough to matter, short enough that a real rotation lands. */
const DISCOVERY_TTL_MS = 15 * 60 * 1_000;

/** JWKS cache TTL. */
const JWKS_TTL_MS = 10 * 60 * 1_000;

/**
 * Floor between two JWKS fetches.
 *
 * A JWS header is unauthenticated data, so anyone can post a callback carrying a token whose
 * `kid` matches nothing. Without a floor, each of those becomes an outbound request to the
 * provider's JWKS endpoint, and this server turns into a free amplifier aimed at our own
 * identity provider. With it, a run of unknown `kid`s costs one fetch per 30 seconds.
 */
const JWKS_MIN_REFETCH_MS = 30 * 1_000;

/** Per-request network budget. A provider that has not answered by now is not going to. */
const HTTP_TIMEOUT_MS = 5_000;

/** Response size ceilings. An unbounded read from any host is a memory exhaustion primitive. */
const MAX_DISCOVERY_BYTES = 64 * 1_024;
const MAX_JWKS_BYTES = 256 * 1_024;
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1_024;

/** A JWKS with more keys than this is not a key set, it is a payload. */
const MAX_JWKS_KEYS = 20;

/** Verifier length bounds from RFC 7636 §4.1. `generateOidcSecret()` lands at 43 characters. */
const PKCE_VERIFIER_MIN_LENGTH = 43;
const PKCE_VERIFIER_MAX_LENGTH = 128;

/** The scopes requested. `email` is absent on purpose — see the module header. */
const REQUESTED_SCOPE = 'openid profile';

/**
 * A site-relative path, and nothing that a browser could read as an origin.
 *
 * Mirrors `oidcStartQuerySchema.redirectAfter` in `@prl/contracts` exactly. Kept here as well
 * because a value that has been round-tripped through the database is not a value the schema
 * has vouched for any more, and the redirect is the one place where getting this wrong is a
 * phishing vector rather than a 404.
 */
const SAFE_REDIRECT_PATH = /^\/(?![/\\])[A-Za-z0-9/_\-?=&.]*$/;
const MAX_REDIRECT_PATH_LENGTH = 256;

/** Only base64url, no padding: the character set of a JWS compact serialization part. */
const BASE64URL_PART = /^[A-Za-z0-9_-]+$/;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * "This response does not belong to a login attempt of ours."
 *
 * State, nonce and PKCE failures all land here, because to a client they are the same event:
 * start again. Distinguishing them would tell somebody probing the callback which of the three
 * checks they had beaten.
 *
 * Exported because `routes/auth.ts` raises the same refusal from the other half of the same flow —
 * its cookie, state and PKCE checks run before this module is asked to verify anything — and two
 * copies of "which code does an unverifiable callback get" is one copy too many.
 */
export function stateMismatch(logDetail: string): AppError {
  return new AppError('oidc_state_mismatch', { logDetail });
}

/** "The provider or its token could not be trusted." Everything else lands here. */
function exchangeFailed(logDetail: string, cause?: unknown): AppError {
  return new AppError('oidc_exchange_failed', cause === undefined ? { logDetail } : { logDetail, cause });
}

// ---------------------------------------------------------------------------
// Reading untrusted JSON without `any`
// ---------------------------------------------------------------------------

/**
 * A parsed JSON object, before anything has been believed about it.
 *
 * Typed as `object` rather than `Record<string, unknown>` and read through `Reflect.get`, which
 * is the same pattern (and the same reason) as `fieldOf` in `logging.ts`: narrowing `unknown` to a
 * record type needs either a cast — banned here — or a copy of every property on every parse.
 * Reading one field at a time keeps the loose typing at the boundary instead of letting it spread.
 */
type Json = object;

function asRecord(value: unknown): Json | null {
  // `typeof null === 'object'` and an array is an object, so both are excluded explicitly. A
  // top-level array where an object is expected is the classic way a lenient parser is handed
  // something it will misread.
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value;
}

function field(record: Json, key: string): unknown {
  const value: unknown = Reflect.get(record, key);
  return value;
}

function readString(record: Json, key: string): string | undefined {
  const value = field(record, key);
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function readNumber(record: Json, key: string): number | undefined {
  const value = field(record, key);
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readStringArray(record: Json, key: string): readonly string[] | undefined {
  const value = field(record, key);
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') out.push(entry);
  }
  return out;
}

function parseJsonObject(text: string, what: string): Json {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw exchangeFailed(`${what} was not valid JSON`, error);
  }
  const record = asRecord(parsed);
  if (record === null) throw exchangeFailed(`${what} was not a JSON object`);
  return record;
}

// ---------------------------------------------------------------------------
// Digests, PKCE, state and nonce
// ---------------------------------------------------------------------------

/** The S256 challenge for a verifier: `base64url(sha256(ascii(verifier)))`. */
export function pkceChallengeFor(verifier: string): string {
  return hashOidcSecret(verifier).toString('base64url');
}

/** Everything one login attempt needs. Only the digests of these are ever persisted. */
export interface OidcAttemptSecrets {
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
  readonly codeChallenge: string;
}

/**
 * Fresh secrets for one attempt.
 *
 * Three independent calls to `generateOidcSecret`, never one value used twice: a `state` that
 * doubled as a `nonce` would make the CSRF check and the ID-token replay check the same check.
 * Each is 32 bytes of CSPRNG output — never `Math.random`, because a predictable `state` or
 * `nonce` makes both of those checks decorative.
 *
 * S256 only. RFC 7636 also defines `plain`, for devices that cannot hash, and accepting it means
 * the verifier travels in the authorization request — which defeats the whole point, because
 * anyone who can read that request can then complete the exchange.
 */
export function createAttemptSecrets(): OidcAttemptSecrets {
  const codeVerifier = generateOidcSecret();
  if (codeVerifier.length < PKCE_VERIFIER_MIN_LENGTH || codeVerifier.length > PKCE_VERIFIER_MAX_LENGTH) {
    // Cannot happen at 32 bytes; asserted because a future change to the generator's size that
    // pushed it out of range would otherwise be discovered by a provider rejecting the flow.
    throw new Error('PKCE verifier length is outside the range RFC 7636 allows');
  }
  return {
    state: generateOidcSecret(),
    nonce: generateOidcSecret(),
    codeVerifier,
    codeChallenge: pkceChallengeFor(codeVerifier),
  };
}

// ---------------------------------------------------------------------------
// The cookie that carries the verifier
// ---------------------------------------------------------------------------

/**
 * The two values the browser has to carry across the round trip, packed for one cookie.
 *
 * Why a cookie at all, when the attempt row already exists: the PKCE verifier must be *sent* to
 * the token endpoint in plaintext, and the database holds only its digest, deliberately — a
 * database read must not be enough to complete somebody else's login. So the plaintext lives
 * where only that browser has it. `state` rides along too, giving the callback a double-submit
 * check: a login-CSRF attempt that feeds a victim a callback URL carries the attacker's
 * `state`, and without the matching cookie it fails before any lookup happens.
 *
 * Both halves are base64url, so a single `.` is an unambiguous separator.
 */
export function packAttemptCookie(secrets: {
  readonly state: string;
  readonly codeVerifier: string;
}): string {
  return `${secrets.state}.${secrets.codeVerifier}`;
}

export function unpackAttemptCookie(
  raw: string,
): { readonly state: string; readonly codeVerifier: string } | null {
  const parts = raw.split('.');
  if (parts.length !== 2) return null;
  const [state, codeVerifier] = parts;
  if (state === undefined || codeVerifier === undefined) return null;
  if (!BASE64URL_PART.test(state) || !BASE64URL_PART.test(codeVerifier)) return null;
  if (codeVerifier.length < PKCE_VERIFIER_MIN_LENGTH || codeVerifier.length > PKCE_VERIFIER_MAX_LENGTH) {
    return null;
  }
  return { state, codeVerifier };
}

// ---------------------------------------------------------------------------
// Redirect targets
// ---------------------------------------------------------------------------

/** Whether a stored or submitted `redirectAfter` is a path this server will honour. */
export function isSafeRedirectPath(value: string): boolean {
  return value.length <= MAX_REDIRECT_PATH_LENGTH && SAFE_REDIRECT_PATH.test(value);
}

/**
 * Where to send the browser once sign-in succeeds.
 *
 * The *origin* comes from this server's own allowlist and the *path* from the request. That
 * split is the whole reason `redirectAfter` accepts a path only: if a client could supply an
 * absolute URL, `GET /auth/oidc/start?redirectAfter=https://evil.example` would be an open
 * redirect on an authentication endpoint — the highest-value place to have one, because the
 * victim has just been asked to prove who they are and will believe the next page they see.
 * Reconstructing the URL from a trusted origin plus a validated path means a hostile value can
 * change *where in our app* somebody lands and nothing else.
 *
 * A path that fails validation is not an error worth failing sign-in over; it becomes `/`.
 */
export function safeRedirectTarget(path: string | null, webOrigins: readonly string[]): string {
  const wanted = path !== null && isSafeRedirectPath(path) ? path : '/';
  const origin = webOrigins[0];
  if (origin === undefined) return wanted;
  // `new URL(path, origin)` cannot escape `origin` for a value that matched
  // SAFE_REDIRECT_PATH: it has no scheme (no colon), no backslash, and cannot begin `//`.
  return new URL(wanted, origin).toString();
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * The fields of a discovery document this relying party uses, all validated.
 *
 * The seven required members come from OpenID Connect Discovery 1.0 §3. Absent or malformed
 * means the document is refused outright rather than partially believed: a half-read document
 * is how an endpoint silently falls back to a default that points somewhere else.
 */
export interface DiscoveryDocument {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly jwksUri: string;
  readonly responseTypesSupported: readonly string[];
  readonly subjectTypesSupported: readonly string[];
  readonly idTokenSigningAlgValuesSupported: readonly string[];
  readonly codeChallengeMethodsSupported: readonly string[] | null;
  readonly tokenEndpointAuthMethodsSupported: readonly string[] | null;
}

/**
 * Endpoint URLs must be absolute and https.
 *
 * Loopback over plaintext http is the one exception, and only so a local identity provider can
 * be run during development — the same exception `config.ts` makes for `OIDC_ISSUER`, and the
 * same one `prl.users.oidc_issuer`'s CHECK constraint makes. Anywhere else, http means the
 * authorization code, and on the token endpoint the client secret, cross the network in clear.
 */
function assertHttpsUrl(raw: string, what: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    throw exchangeFailed(`${what} was not an absolute URL`, error);
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !loopback) throw exchangeFailed(`${what} was not https`);
  if (url.username !== '' || url.password !== '') throw exchangeFailed(`${what} carried credentials`);
  return url.toString();
}

/** `<issuer>/.well-known/openid-configuration`, built the way the spec says to build it. */
export function discoveryUrlFor(issuer: string): string {
  const url = new URL(issuer);
  // Appended to the issuer's path, not substituted for it: an issuer may legitimately be
  // `https://host/tenant/1`, and replacing the path would ask the wrong host for the document.
  const base = url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname;
  url.pathname = `${base}/.well-known/openid-configuration`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

/**
 * Validates a parsed discovery document against the configured issuer.
 *
 * The `issuer` comparison is exact string equality, and it is the most important line in this
 * function. A document whose `issuer` differs from the one we configured is either
 * misconfiguration or an attempt to make this server accept tokens minted by somebody else,
 * and there is no version of "close enough" — no trailing-slash tolerance, no case folding, no
 * host-only comparison — that does not also accept a value an attacker chose.
 */
export function validateDiscoveryDocument(document: Json, expectedIssuer: string): DiscoveryDocument {
  const issuer = readString(document, 'issuer');
  if (issuer === undefined) throw exchangeFailed('discovery document had no issuer');
  if (issuer !== expectedIssuer)
    throw exchangeFailed('discovery document issuer did not match configuration');

  const authorizationEndpoint = readString(document, 'authorization_endpoint');
  const tokenEndpoint = readString(document, 'token_endpoint');
  const jwksUri = readString(document, 'jwks_uri');
  if (authorizationEndpoint === undefined) throw exchangeFailed('discovery had no authorization_endpoint');
  if (tokenEndpoint === undefined) throw exchangeFailed('discovery had no token_endpoint');
  if (jwksUri === undefined) throw exchangeFailed('discovery had no jwks_uri');

  const responseTypes = readStringArray(document, 'response_types_supported');
  const subjectTypes = readStringArray(document, 'subject_types_supported');
  const signingAlgs = readStringArray(document, 'id_token_signing_alg_values_supported');
  if (responseTypes === undefined) throw exchangeFailed('discovery had no response_types_supported');
  if (subjectTypes === undefined) throw exchangeFailed('discovery had no subject_types_supported');
  if (signingAlgs === undefined) throw exchangeFailed('discovery had no signing algs');

  // We only ever send `response_type=code`. A provider that does not advertise it cannot
  // complete this flow, and finding that out here is better than at the redirect.
  if (!responseTypes.includes('code')) throw exchangeFailed('provider does not support response_type=code');
  if (!signingAlgs.some((alg) => isSupportedAlg(alg))) {
    throw exchangeFailed('provider signs ID tokens with no algorithm we accept');
  }

  const codeChallengeMethods = readStringArray(document, 'code_challenge_methods_supported') ?? null;
  // Only checked when advertised. Some providers support S256 without listing it, so an absent
  // list is not evidence of absent support; a list that omits S256 *is*.
  if (codeChallengeMethods !== null && !codeChallengeMethods.includes('S256')) {
    throw exchangeFailed('provider does not advertise the S256 PKCE method');
  }

  return {
    issuer,
    authorizationEndpoint: assertHttpsUrl(authorizationEndpoint, 'authorization_endpoint'),
    tokenEndpoint: assertHttpsUrl(tokenEndpoint, 'token_endpoint'),
    jwksUri: assertHttpsUrl(jwksUri, 'jwks_uri'),
    responseTypesSupported: responseTypes,
    subjectTypesSupported: subjectTypes,
    idTokenSigningAlgValuesSupported: signingAlgs,
    codeChallengeMethodsSupported: codeChallengeMethods,
    tokenEndpointAuthMethodsSupported:
      readStringArray(document, 'token_endpoint_auth_methods_supported') ?? null,
  };
}

function isSupportedAlg(alg: string): alg is SupportedIdTokenAlg {
  return SUPPORTED_ID_TOKEN_ALGS.some((candidate) => candidate === alg);
}

// ---------------------------------------------------------------------------
// JWKS
// ---------------------------------------------------------------------------

/**
 * One JSON Web Key, narrowed to the members needed to verify a signature.
 *
 * A `type` alias rather than an `interface` for a mundane but load-bearing reason: only the
 * former gets an implicit index signature, and `crypto.createPublicKey({ key, format: 'jwk' })`
 * wants `JsonWebKey`, which has one. An interface here fails to compile.
 */
export type Jwk = {
  readonly kty: string;
  readonly kid?: string;
  readonly use?: string;
  readonly alg?: string;
  readonly key_ops?: readonly string[];
  readonly n?: string;
  readonly e?: string;
  readonly crv?: string;
  readonly x?: string;
  readonly y?: string;
};

function parseJwk(value: unknown): Jwk | null {
  const record = asRecord(value);
  if (record === null) return null;
  const kty = readString(record, 'kty');
  if (kty === undefined) return null;
  const key: {
    kty: string;
    kid?: string;
    use?: string;
    alg?: string;
    key_ops?: readonly string[];
    n?: string;
    e?: string;
    crv?: string;
    x?: string;
    y?: string;
  } = { kty };
  // Assigned one at a time because `exactOptionalPropertyTypes` means an explicit `undefined`
  // is not the same as an absent member, and `createPublicKey` inspects presence.
  const kid = readString(record, 'kid');
  if (kid !== undefined) key.kid = kid;
  const use = readString(record, 'use');
  if (use !== undefined) key.use = use;
  const alg = readString(record, 'alg');
  if (alg !== undefined) key.alg = alg;
  const keyOps = readStringArray(record, 'key_ops');
  if (keyOps !== undefined) key.key_ops = keyOps;
  for (const field of ['n', 'e', 'crv', 'x', 'y'] as const) {
    const parameter = readString(record, field);
    if (parameter !== undefined) key[field] = parameter;
  }
  return key;
}

/** Parses `{ keys: [...] }`, dropping anything unusable and bounding the count. */
export function parseJwkSet(document: Json): readonly Jwk[] {
  const raw = field(document, 'keys');
  if (!Array.isArray(raw)) throw exchangeFailed('JWKS had no keys array');
  if (raw.length > MAX_JWKS_KEYS) throw exchangeFailed('JWKS carried more keys than we will hold');
  const keys: Jwk[] = [];
  for (const entry of raw) {
    const key = parseJwk(entry);
    if (key !== null) keys.push(key);
  }
  if (keys.length === 0) throw exchangeFailed('JWKS contained no usable keys');
  return keys;
}

/**
 * Whether this key may verify this algorithm.
 *
 * Binding the two is not pedantry. `alg` arrives in the token's own header, so if key selection
 * ignored it, a provider holding both an RSA and an EC key could have either used against the
 * other's `kid`, and a token could nominate whichever pairing the verifier handles most
 * loosely. Every clause below refuses a pairing rather than reinterpreting it.
 */
export function jwkMatchesAlg(jwk: Jwk, alg: SupportedIdTokenAlg): boolean {
  // `use: 'enc'` is an encryption key. Using one to verify signatures is exactly the key-reuse
  // mistake JWK's `use` member exists to prevent.
  if (jwk.use !== undefined && jwk.use !== 'sig') return false;
  if (jwk.key_ops !== undefined && !jwk.key_ops.includes('verify')) return false;
  // A key that names its own algorithm is taken at its word, and a token disagreeing with it
  // is refused.
  if (jwk.alg !== undefined && jwk.alg !== alg) return false;
  if (alg === 'RS256') return jwk.kty === 'RSA' && jwk.n !== undefined && jwk.e !== undefined;
  // ES256 is P-256 and only P-256. `crv` is checked because an EC key on another curve with a
  // sha256 digest is not ES256, and treating it as such is undefined behaviour, not a downgrade
  // anyone has analysed.
  return jwk.kty === 'EC' && jwk.crv === 'P-256' && jwk.x !== undefined && jwk.y !== undefined;
}

/**
 * The key that should verify this token, or `null` when the `kid` is unknown.
 *
 * `null` is the caller's cue to refetch the key set once — that is what key rotation looks like
 * from here — rather than to fail immediately.
 *
 * A token with no `kid` is accepted only when exactly one key could have signed it. With two or
 * more candidates, "try them all" is the tempting answer and the wrong one: it turns every
 * retired key still published in the set into a live signing key.
 */
export function selectJwk(
  keys: readonly Jwk[],
  header: { readonly alg: SupportedIdTokenAlg; readonly kid?: string },
): Jwk | null {
  const usable = keys.filter((key) => jwkMatchesAlg(key, header.alg));
  if (header.kid !== undefined) return usable.find((key) => key.kid === header.kid) ?? null;
  return usable.length === 1 ? (usable[0] ?? null) : null;
}

// ---------------------------------------------------------------------------
// JWS
// ---------------------------------------------------------------------------

export interface JwsHeader {
  readonly alg: string;
  readonly kid?: string;
  readonly typ?: string;
}

export interface ParsedJws {
  readonly header: JwsHeader;
  readonly claims: Json;
  readonly signingInput: Buffer;
  readonly signature: Buffer;
}

/**
 * Splits and decodes a compact JWS, without verifying anything.
 *
 * Everything this returns is untrusted. Nothing downstream may act on a claim until
 * `verifyJwsSignature` has succeeded, which is why the two are separate functions with separate
 * names rather than one `decode()` that returns something that looks authoritative.
 */
export function parseJws(token: string): ParsedJws {
  const parts = token.split('.');
  // Five parts is a JWE: an encrypted token, which this relying party does not accept. Saying
  // so is clearer than "malformed", because it is a configuration mistake, not an attack.
  if (parts.length === 5) throw exchangeFailed('ID token was a JWE; encrypted ID tokens are not accepted');
  if (parts.length !== 3) throw exchangeFailed('ID token was not a three-part compact JWS');
  const [headerPart, claimsPart, signaturePart] = parts;
  if (headerPart === undefined || claimsPart === undefined || signaturePart === undefined) {
    throw exchangeFailed('ID token had a missing segment');
  }
  // Called out separately from the base64url check below because this is what an `alg: none`
  // token actually looks like on the wire — three parts, the third one empty — and "there is no
  // signature" is the accurate reason to refuse it.
  if (signaturePart === '') throw exchangeFailed('ID token carried no signature');
  // Checked before decoding because `Buffer.from(x, 'base64url')` silently skips characters it
  // does not recognise, so a token containing `+`, `/` or `=` would decode to *something* and
  // be treated as valid base64url that it is not.
  for (const part of [headerPart, claimsPart, signaturePart]) {
    if (!BASE64URL_PART.test(part)) throw exchangeFailed('ID token segment was not base64url');
  }

  const header = parseJsonObject(Buffer.from(headerPart, 'base64url').toString('utf8'), 'ID token header');
  const claims = parseJsonObject(Buffer.from(claimsPart, 'base64url').toString('utf8'), 'ID token claims');

  const alg = readString(header, 'alg');
  if (alg === undefined) throw exchangeFailed('ID token header had no alg');
  const parsedHeader: { alg: string; kid?: string; typ?: string } = { alg };
  const kid = readString(header, 'kid');
  if (kid !== undefined) parsedHeader.kid = kid;
  const typ = readString(header, 'typ');
  if (typ !== undefined) parsedHeader.typ = typ;

  return {
    header: parsedHeader,
    claims,
    // ASCII, and the *exact* bytes that were signed. Re-serialising the decoded header and
    // claims would produce different bytes and every signature would fail.
    signingInput: Buffer.from(`${headerPart}.${claimsPart}`, 'ascii'),
    signature: Buffer.from(signaturePart, 'base64url'),
  };
}

/**
 * The algorithm check, which is the one that stops the classic attack.
 *
 * Three refusals, in order of how much damage they prevent:
 *
 * 1. **`alg: 'none'`.** An unsigned token. The signature segment is empty and there is nothing
 *    to verify, so accepting it means accepting whatever claims the caller typed — including
 *    `sub`. Any implementation that reaches its verification step with `none` still allowed has
 *    no authentication at all.
 * 2. **Any symmetric algorithm (`HS256`, `HS384`, `HS512`).** This is algorithm confusion. The
 *    verification key for an asymmetric token is a *public* key, which by definition the
 *    attacker also has. If the token is allowed to say "this is HMAC", a naive verifier will
 *    use that public key as the HMAC secret — and the attacker, holding the same public key,
 *    can compute the MAC. The token verifies. The fix is not to be careful about which key gets
 *    passed where; it is to refuse the family outright, because we never issue or accept a
 *    symmetric ID token.
 * 3. **Anything not on our allowlist, or not advertised by the provider.** `RS512` might be
 *    perfectly sound, but an algorithm nobody chose is an algorithm nobody reviewed, and the
 *    provider's own document is the authority on what it signs with.
 */
export function assertAlgAllowed(alg: string, providerAlgs: readonly string[]): SupportedIdTokenAlg {
  const normalised = alg.trim();
  if (normalised.toLowerCase() === 'none')
    throw exchangeFailed('ID token alg was none; unsigned tokens are refused');
  if (/^HS/i.test(normalised)) {
    throw exchangeFailed('ID token alg was symmetric; refused to avoid algorithm confusion');
  }
  if (!isSupportedAlg(normalised)) throw exchangeFailed('ID token alg is not one this server accepts');
  if (!providerAlgs.includes(normalised)) {
    throw exchangeFailed('ID token alg is not one the provider advertises');
  }
  return normalised;
}

/**
 * Verifies the signature, and only the signature.
 *
 * The ES256 branch needs `dsaEncoding: 'ieee-p1363'`. A JOSE ECDSA signature is the raw
 * `r || s` pair, 64 bytes for P-256, while OpenSSL's default is DER. Verify with the wrong
 * encoding and *every* valid token fails, which is the sort of bug that gets "fixed" by
 * accepting either encoding — and accepting either reintroduces signature malleability.
 *
 * Returns `false` rather than throwing on a malformed key or signature: from a caller's point
 * of view "this did not verify" is one outcome, and branching on how it failed to verify is how
 * an error message becomes an oracle.
 */
export function verifyJwsSignature(jws: ParsedJws, jwk: Jwk, alg: SupportedIdTokenAlg): boolean {
  try {
    // Spread into a fresh object literal so it satisfies `JsonWebKey`'s index signature. This
    // also rejects `kty: 'oct'` at the source: `createPublicKey` throws on a symmetric JWK, so
    // there is no path by which an HMAC key becomes a verification key here.
    const key = createPublicKey({ key: { ...jwk }, format: 'jwk' });
    if (alg === 'RS256') {
      return verify('sha256', jws.signingInput, { key, padding: constants.RSA_PKCS1_PADDING }, jws.signature);
    }
    return verify('sha256', jws.signingInput, { key, dsaEncoding: 'ieee-p1363' }, jws.signature);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

/**
 * What the verified token yields.
 *
 * `(issuer, subject)` is the identity, and it is the *pair*: a subject is only unique within an
 * issuer, so keying on `sub` alone means two providers can collide onto one account. There is
 * deliberately no `email` member — see the module header.
 */
export interface VerifiedIdToken {
  readonly issuer: string;
  readonly subject: string;
  /** A display name candidate, unsanitised. Callers MUST sanitise before storing or echoing. */
  readonly nameHint: string | null;
}

export interface IdTokenExpectation {
  readonly issuer: string;
  readonly clientId: string;
  /**
   * `sha256(nonce)`, not the nonce.
   *
   * The plaintext nonce is never stored — only `prl.oidc_login_attempts.nonce_hash` — so the
   * comparison is digest against digest. Taking a hash here rather than a string is what makes
   * that impossible to get wrong by accident.
   */
  readonly nonceHash: Buffer;
  readonly nowMs: number;
}

/**
 * Every claim check, in one place, each with the attack it closes.
 *
 * Order matters only for the quality of the log line — all of these are fatal — but `nonce` is
 * checked last on purpose, so a token that fails an unconditional check never reports itself as
 * a replay.
 */
export function verifyIdTokenClaims(claims: Json, expect: IdTokenExpectation): VerifiedIdToken {
  const nowSeconds = Math.floor(expect.nowMs / 1_000);

  // `iss` — exact equality. A prefix or suffix comparison here also accepts
  // `https://issuer.example.com.evil.test` and `https://evil.test/?x=https://issuer.example`.
  // Exact equality is the only comparison with no such family of near-misses.
  const issuer = readString(claims, 'iss');
  if (issuer === undefined) throw exchangeFailed('ID token had no iss');
  if (issuer !== expect.issuer) throw exchangeFailed('ID token iss did not match the configured issuer');

  // `sub` — the identity. Bounded to what `prl.users.oidc_subject` accepts, so a provider
  // returning something enormous fails here with a clear reason instead of at the INSERT.
  const subject = readString(claims, 'sub');
  if (subject === undefined) throw exchangeFailed('ID token had no sub');
  if (subject.length > 255) throw exchangeFailed('ID token sub was longer than the schema allows');

  // `aud` — the token must have been minted *for us*. Without this check, a token issued by the
  // same provider to a different, possibly hostile, client application is accepted here: same
  // issuer, valid signature, real user. That is a complete authentication bypass, and it is the
  // reason `aud` is not optional in anybody's spec.
  assertAudience(claims, expect.clientId);

  // `exp` — required, and the skew is *subtracted* from the deadline so a stale token is not
  // accepted for a further minute past its own expiry.
  const exp = readNumber(claims, 'exp');
  if (exp === undefined) throw exchangeFailed('ID token had no exp');
  if (nowSeconds - CLOCK_SKEW_SECONDS >= exp) throw exchangeFailed('ID token has expired');

  // `iat` — required by OIDC Core §2. Two bounds: not meaningfully in the future (a provider
  // whose clock is wrong by an hour would otherwise mint tokens we accept for an hour longer
  // than intended), and not older than `MAX_ID_TOKEN_AGE_SECONDS`, which caps how long a
  // captured token stays interesting even before the nonce check.
  const iat = readNumber(claims, 'iat');
  if (iat === undefined) throw exchangeFailed('ID token had no iat');
  if (iat - CLOCK_SKEW_SECONDS > nowSeconds) throw exchangeFailed('ID token iat is in the future');
  if (nowSeconds - iat > MAX_ID_TOKEN_AGE_SECONDS + CLOCK_SKEW_SECONDS) {
    throw exchangeFailed('ID token is older than this server will accept');
  }

  // `nbf` — optional, and checked when present. A token that is not yet valid must not be
  // treated as valid; skipping this is how a token minted for a future window gets used early.
  const nbf = readNumber(claims, 'nbf');
  if (nbf !== undefined && nbf - CLOCK_SKEW_SECONDS > nowSeconds) {
    throw exchangeFailed('ID token is not valid yet');
  }

  // `nonce` — binds this token to the one authorization request that asked for it. Without it,
  // a token captured from any earlier successful sign-in can be replayed into a fresh callback.
  // Compared as digests, in constant time, because a comparison that short-circuits on the
  // first differing byte leaks the digest one byte at a time.
  const nonce = readString(claims, 'nonce');
  if (nonce === undefined) throw stateMismatch('ID token had no nonce');
  if (!timingSafeEquals(hashOidcSecret(nonce), expect.nonceHash)) {
    throw stateMismatch('ID token nonce did not match the login attempt');
  }

  return { issuer, subject, nameHint: readNameHint(claims) };
}

/**
 * `aud` and `azp`, per OIDC Core §3.1.3.7 rules 3 to 5.
 *
 * `aud` may be a string or an array. When it is an array with more than one entry the token was
 * minted for several clients at once, and the spec requires `azp` to name the one it was
 * *intended* for — otherwise a token legitimately issued to another client that happens to
 * share an audience list would pass.
 */
function assertAudience(claims: Json, clientId: string): void {
  const raw = field(claims, 'aud');
  const audiences = typeof raw === 'string' ? [raw] : (readStringArray(claims, 'aud') ?? []);
  if (audiences.length === 0) throw exchangeFailed('ID token had no aud');
  if (!audiences.includes(clientId)) throw exchangeFailed('ID token aud did not contain our client id');
  if (audiences.length === 1) return;
  const azp = readString(claims, 'azp');
  if (azp === undefined) throw exchangeFailed('ID token had multiple audiences and no azp');
  if (azp !== clientId) throw exchangeFailed('ID token azp was another client');
}

/**
 * A display-name candidate, in order of how much a human would recognise it.
 *
 * Returned raw and marked as such. It is provider-supplied text that a user may well have
 * chosen, so it is sanitised at the point of storage (`sanitiseDisplayName` in
 * `src/routes/auth.ts`) rather than trusted here — and `logging.ts` censors `displayName`
 * everywhere, so it never reaches a log line either way.
 */
function readNameHint(claims: Json): string | null {
  return (
    readString(claims, 'name') ??
    readString(claims, 'preferred_username') ??
    readString(claims, 'given_name') ??
    readString(claims, 'nickname') ??
    null
  );
}

// ---------------------------------------------------------------------------
// The relying party
// ---------------------------------------------------------------------------

export interface AuthorizationRequest {
  readonly state: string;
  readonly nonce: string;
  readonly codeChallenge: string;
}

export interface OidcRelyingParty {
  /** The validated, cached discovery document. */
  readonly discovery: () => Promise<DiscoveryDocument>;
  /** Where to send the browser. */
  readonly authorizationUrl: (request: AuthorizationRequest) => Promise<string>;
  /** Exchanges a code for an ID token. Returns the raw compact JWS, nothing else. */
  readonly exchangeCode: (params: {
    readonly code: string;
    readonly codeVerifier: string;
  }) => Promise<string>;
  /** Verifies an ID token against the provider's keys and this attempt's expectations. */
  readonly verifyIdToken: (
    idToken: string,
    expect: { readonly nonceHash: Buffer },
  ) => Promise<VerifiedIdToken>;
}

export interface RelyingPartyOptions {
  readonly config: OidcConfig;
  /** Injected by the tests so the whole flow runs with no network. Defaults to global `fetch`. */
  readonly fetchImpl?: typeof globalThis.fetch;
  /** Injected by the tests to drive expiry. Defaults to `Date.now`. */
  readonly now?: () => number;
}

interface DiscoveryCache {
  readonly document: DiscoveryDocument;
  readonly expiresAtMs: number;
}

interface JwksCache {
  readonly uri: string;
  readonly keys: readonly Jwk[];
  readonly expiresAtMs: number;
  /**
   * When an unknown-`kid` refetch last happened for this cached set, or `null` if none has.
   * Separate from the TTL so that a genuine rotation is picked up at once while a run of forged
   * `kid`s is not: see `keySet`.
   */
  readonly refetchedAtMs: number | null;
}

/**
 * Builds the relying party.
 *
 * A closure rather than a class, so the two caches are genuinely private — not `private` in the
 * type system only — and there is no `this` to lose.
 *
 * One instance per process, created once by `src/routes/auth.ts`. Creating one per request would
 * make every sign-in fetch discovery and the key set again, which is both slow and rude to the
 * provider.
 */
export function createOidcRelyingParty(options: RelyingPartyOptions): OidcRelyingParty {
  const { config } = options;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? Date.now;

  let discoveryCache: DiscoveryCache | null = null;
  let jwksCache: JwksCache | null = null;

  async function getJson(url: string, maxBytes: number, what: string): Promise<Json> {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
    } catch (error) {
      throw exchangeFailed(`${what} could not be fetched`, error);
    }
    if (!response.ok) throw exchangeFailed(`${what} returned status ${response.status}`);
    // The *final* URL after any redirect. A document fetched over https that redirected to
    // plaintext http was read over the network in clear, whatever the original scheme said.
    assertHttpsUrl(response.url === '' ? url : response.url, `${what} response URL`);
    return parseJsonObject(await readBoundedText(response, maxBytes, what), what);
  }

  async function discovery(): Promise<DiscoveryDocument> {
    const cached = discoveryCache;
    if (cached !== null && now() < cached.expiresAtMs) return cached.document;
    const document = await getJson(discoveryUrlFor(config.issuer), MAX_DISCOVERY_BYTES, 'discovery document');
    const validated = validateDiscoveryDocument(document, config.issuer);
    // Only a *valid* document is cached. Caching a rejected one would turn one bad response
    // into fifteen minutes of failed sign-ins.
    discoveryCache = { document: validated, expiresAtMs: now() + DISCOVERY_TTL_MS };
    return validated;
  }

  async function fetchKeySet(uri: string, at: number, refetchedAtMs: number | null): Promise<readonly Jwk[]> {
    const keys = parseJwkSet(await getJson(uri, MAX_JWKS_BYTES, 'JWKS'));
    jwksCache = { uri, keys, expiresAtMs: at + JWKS_TTL_MS, refetchedAtMs };
    return keys;
  }

  /**
   * The key set, with rotation handled and hammering prevented.
   *
   * Two paths in, and keeping them apart is the whole design:
   *
   * - `refresh: false` is the ordinary read. It serves the cache until the TTL runs out.
   * - `refresh: true` is the caller saying "the `kid` I need is not in what you gave me", which
   *   is exactly what a rotated signing key looks like from here. The *first* such refetch after
   *   any successful fetch is honoured immediately — otherwise a real rotation would leave every
   *   sign-in broken until the TTL happened to lapse — and every one after it inside
   *   `JWKS_MIN_REFETCH_MS` is refused, because a JWS header is unauthenticated data and anyone
   *   can mint a token whose `kid` matches nothing. Without the floor, this server would be a
   *   free request amplifier aimed at our own identity provider.
   *
   * A failed fetch leaves the cache untouched, so the next request tries again rather than
   * inheriting a poisoned entry. That is one outbound attempt per sign-in while the provider is
   * down, which the route's own rate limit already bounds.
   */
  // Not `async`, because three of its four paths answer from the cache with nothing to await.
  function keySet(uri: string, refresh: boolean): Promise<readonly Jwk[]> {
    const at = now();
    const cached = jwksCache !== null && jwksCache.uri === uri ? jwksCache : null;
    if (cached === null) return fetchKeySet(uri, at, null);
    if (!refresh) {
      return at < cached.expiresAtMs ? Promise.resolve(cached.keys) : fetchKeySet(uri, at, null);
    }
    if (cached.refetchedAtMs !== null && at - cached.refetchedAtMs < JWKS_MIN_REFETCH_MS) {
      return Promise.resolve(cached.keys);
    }
    return fetchKeySet(uri, at, at);
  }

  async function authorizationUrl(request: AuthorizationRequest): Promise<string> {
    const document = await discovery();
    const url = new URL(document.authorizationEndpoint);
    // Set one at a time rather than by string concatenation, so every value is percent-encoded
    // by the URL implementation and a value containing `&` cannot inject a parameter.
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', config.clientId);
    // Exactly the registered value, from configuration and never from the request. A
    // request-supplied redirect_uri is how an authorization code gets delivered to somebody
    // else's server.
    url.searchParams.set('redirect_uri', config.redirectUri);
    url.searchParams.set('scope', REQUESTED_SCOPE);
    url.searchParams.set('state', request.state);
    url.searchParams.set('nonce', request.nonce);
    url.searchParams.set('code_challenge', request.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
  }

  async function exchangeCode(params: {
    readonly code: string;
    readonly codeVerifier: string;
  }): Promise<string> {
    const document = await discovery();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri: config.redirectUri,
      // PKCE: the verifier whose *digest* the provider has been holding since the
      // authorization request. Sending it here is what proves this exchange comes from the
      // same client that started the flow, so an intercepted code is useless on its own.
      code_verifier: params.codeVerifier,
    });
    const headers = tokenRequestHeaders(document, config, body);

    let response: Response;
    try {
      response = await fetchImpl(document.tokenEndpoint, {
        method: 'POST',
        headers,
        body: body.toString(),
        // No redirects. This request carries the client secret; a redirect would forward it to
        // whatever host the provider named, and the token endpoint has no legitimate reason to
        // move mid-request.
        redirect: 'error',
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
    } catch (error) {
      throw exchangeFailed('token endpoint could not be reached', error);
    }

    const text = await readBoundedText(response, MAX_TOKEN_RESPONSE_BYTES, 'token response');
    if (!response.ok) {
      // The provider's own error body is not read and not logged. It is attacker-influenceable
      // (an attacker chooses the code that produced it) and it can echo request parameters.
      throw exchangeFailed(`token endpoint returned status ${response.status}`);
    }
    const payload = parseJsonObject(text, 'token response');
    const tokenType = readString(payload, 'token_type');
    if (tokenType !== undefined && tokenType.toLowerCase() !== 'bearer') {
      throw exchangeFailed('token response was not a bearer grant');
    }
    const idToken = readString(payload, 'id_token');
    if (idToken === undefined) throw exchangeFailed('token response carried no id_token');
    return idToken;
  }

  async function verifyIdToken(
    idToken: string,
    expect: { readonly nonceHash: Buffer },
  ): Promise<VerifiedIdToken> {
    const document = await discovery();
    const jws = parseJws(idToken);
    const alg = assertAlgAllowed(jws.header.alg, document.idTokenSigningAlgValuesSupported);
    assertHeaderType(jws.header);

    const header = jws.header.kid === undefined ? { alg } : { alg, kid: jws.header.kid };
    let keys = await keySet(document.jwksUri, false);
    let jwk = selectJwk(keys, header);
    if (jwk === null) {
      // One refetch, for rotation. See `keySet` for why it is at most one.
      keys = await keySet(document.jwksUri, true);
      jwk = selectJwk(keys, header);
    }
    if (jwk === null) throw exchangeFailed('no published key matches the ID token header');
    if (!verifyJwsSignature(jws, jwk, alg)) throw exchangeFailed('ID token signature did not verify');

    return verifyIdTokenClaims(jws.claims, {
      issuer: config.issuer,
      clientId: config.clientId,
      nonceHash: expect.nonceHash,
      nowMs: now(),
    });
  }

  return { discovery, authorizationUrl, exchangeCode, verifyIdToken };
}

/**
 * Client authentication at the token endpoint.
 *
 * `client_secret_basic` when the provider allows it, because it keeps the secret out of the
 * request body — where a proxy or a debug log is more likely to capture it. `client_secret_post`
 * is the documented fallback. Anything else (`private_key_jwt`, `none`) is refused rather than
 * guessed at: a provider that requires an authentication method we do not implement should fail
 * loudly at the exchange, not silently send an unauthenticated request.
 */
function tokenRequestHeaders(
  document: DiscoveryDocument,
  config: OidcConfig,
  body: URLSearchParams,
): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
    // A token response must never be written to a shared cache.
    'cache-control': 'no-store',
  };
  const methods = document.tokenEndpointAuthMethodsSupported;
  // An absent list means the OAuth 2.0 default, which is client_secret_basic. Written as one
  // condition rather than a `useBasic` boolean so the compiler can see that `methods` is
  // non-null below.
  if (methods === null || methods.includes('client_secret_basic')) {
    // RFC 6749 §2.3.1: both halves are form-urlencoded *before* base64, which matters for a
    // secret containing a reserved character.
    const credentials = `${formEncode(config.clientId)}:${formEncode(config.clientSecret)}`;
    headers['authorization'] = `Basic ${Buffer.from(credentials, 'utf8').toString('base64')}`;
    body.set('client_id', config.clientId);
    return headers;
  }
  if (!methods.includes('client_secret_post')) {
    throw exchangeFailed('provider requires a token endpoint auth method this server does not implement');
  }
  body.set('client_id', config.clientId);
  body.set('client_secret', config.clientSecret);
  return headers;
}

function formEncode(value: string): string {
  return encodeURIComponent(value).replace(/%20/g, '+');
}

/**
 * Reads a response body with a hard ceiling.
 *
 * `response.text()` has no limit, so a provider — compromised, or merely misconfigured behind a
 * proxy that streams an error page — could make this process allocate until it dies. Reading
 * chunk by chunk and cancelling means the ceiling is enforced before the memory is committed.
 */
async function readBoundedText(response: Response, maxBytes: number, what: string): Promise<string> {
  const body = response.body;
  if (body === null) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw exchangeFailed(`${what} exceeded ${maxBytes} bytes`);
    }
    chunks.push(chunk.value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * `typ`, when the provider sends one.
 *
 * Optional in JWS, so absence is fine. A `typ` of `at+jwt` is an *access* token, and a provider
 * (or an attacker who obtained one) handing us an access token where an ID token belongs is a
 * token-substitution attempt: access tokens are not audience-restricted to us in the same way
 * and are not required to carry a nonce.
 */
function assertHeaderType(header: JwsHeader): void {
  const typ = header.typ;
  if (typ === undefined) return;
  const normalised = typ.toLowerCase();
  if (normalised !== 'jwt' && normalised !== 'application/jwt') {
    throw exchangeFailed('ID token header typ was not JWT');
  }
}

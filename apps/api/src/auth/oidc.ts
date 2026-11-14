/**
 * An OpenID Connect relying party on `node:crypto` and `fetch`, not `openid-client`, because the
 * supply-chain policy treats every new package as release-blocking (`docs/SECURITY.md`).
 * Authorization code + PKCE (S256 only) + one ID token. No implicit or hybrid flow, no
 * `client_secret_jwt` or `private_key_jwt`, no UserInfo endpoint, no refresh tokens.
 * Identity is `(iss, sub)`. `email` is never requested, because keying on it can merge two accounts.
 * Failures name the check that failed, never the value. No secret appears in any string here.
 */

import { constants, createPublicKey, verify } from 'node:crypto';
import type { OidcConfig } from '../config.ts';
import { AppError } from '../errors.ts';
// `hashOidcSecret` is what `prl.oidc_login_attempts` stores, so the nonce comparison must use it.
import { hashOidcSecret, timingSafeEquals } from '../repositories/hashing.ts';
import { generateOidcSecret } from '../repositories/ids.ts';
import { OIDC_ATTEMPT_TTL_SECONDS } from '../repositories/sessions.ts';

/**
 * An allowlist checked against the token's own `alg`, which never chooses the verification strategy.
 * Both are asymmetric. See `assertAlgAllowed`.
 */
export const SUPPORTED_ID_TOKEN_ALGS = ['RS256', 'ES256'] as const;
export type SupportedIdTokenAlg = (typeof SUPPORTED_ID_TOKEN_ALGS)[number];

/** Clock skew tolerance in seconds. Larger widens the window in which an expired token passes. */
export const CLOCK_SKEW_SECONDS = 60;

/** A backstop to the single-use `nonce`. Matches the login attempt's ten-minute TTL. */
export const MAX_ID_TOKEN_AGE_SECONDS = 600;

/** Derived from the repository constant so the cookie's `Max-Age` and the row's `expires_at` agree. */
export const OIDC_ATTEMPT_TTL_MS = OIDC_ATTEMPT_TTL_SECONDS * 1_000;

/** Discovery cache TTL. Long enough to matter, short enough that a real rotation lands. */
const DISCOVERY_TTL_MS = 15 * 60 * 1_000;

const JWKS_TTL_MS = 10 * 60 * 1_000;

/**
 * Floor between JWKS fetches. A callback with a forged unknown `kid` would otherwise make this server
 * an amplifier against the provider. With it, unknown `kid`s cost one fetch per 30 s.
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

/** `email` is absent on purpose. See the module header. */
const REQUESTED_SCOPE = 'openid profile';

/**
 * Mirrors `oidcStartQuerySchema.redirectAfter` in `@prl/contracts`. Rechecked here because a value
 * round-tripped through the database is no longer vouched for, and this guards against phishing.
 */
const SAFE_REDIRECT_PATH = /^\/(?![/\\])[A-Za-z0-9/_\-?=&.]*$/;
const MAX_REDIRECT_PATH_LENGTH = 256;

/** Base64url with no padding, the character set of a JWS compact serialization part. */
const BASE64URL_PART = /^[A-Za-z0-9_-]+$/;

/** State, nonce and PKCE failures share one code, so a prober cannot tell which check it beat. */
export function stateMismatch(logDetail: string): AppError {
  return new AppError('oidc_state_mismatch', { logDetail });
}

/** "The provider or its token could not be trusted." Everything else lands here. */
function exchangeFailed(logDetail: string, cause?: unknown): AppError {
  return new AppError('oidc_exchange_failed', cause === undefined ? { logDetail } : { logDetail, cause });
}

/**
 * A parsed JSON object, before anything is believed about it. Read one field at a time through
 * `Reflect.get`, as `fieldOf` in `logging.ts` does, because casts are banned.
 */
type Json = object;

function asRecord(value: unknown): Json | null {
  // Arrays and null are objects too. A top-level array is how a lenient parser gets misled.
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
 * Three independent CSPRNG values, so `state` and `nonce` are never the same check. S256 only,
 * because `plain` sends the verifier in the authorization request.
 */
export function createAttemptSecrets(): OidcAttemptSecrets {
  const codeVerifier = generateOidcSecret();
  if (codeVerifier.length < PKCE_VERIFIER_MIN_LENGTH || codeVerifier.length > PKCE_VERIFIER_MAX_LENGTH) {
    // Cannot happen at 32 bytes. Asserted so a generator change fails here, not at the provider.
    throw new Error('PKCE verifier length is outside the range RFC 7636 allows');
  }
  return {
    state: generateOidcSecret(),
    nonce: generateOidcSecret(),
    codeVerifier,
    codeChallenge: pkceChallengeFor(codeVerifier),
  };
}

/**
 * `state` and the plaintext PKCE verifier, packed for one cookie. The database holds only the
 * verifier's digest, so a database read cannot complete somebody's login. `state` in the cookie gives
 * the callback a double-submit check against login CSRF. Both halves are base64url, so `.` separates.
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

/** Whether a stored or submitted `redirectAfter` is a path this server will honour. */
export function isSafeRedirectPath(value: string): boolean {
  return value.length <= MAX_REDIRECT_PATH_LENGTH && SAFE_REDIRECT_PATH.test(value);
}

/**
 * The origin comes from this server's allowlist and only the path from the request, so a hostile
 * value cannot make an open redirect on the sign-in endpoint. An invalid path becomes `/`.
 */
export function safeRedirectTarget(path: string | null, webOrigins: readonly string[]): string {
  const wanted = path !== null && isSafeRedirectPath(path) ? path : '/';
  const origin = webOrigins[0];
  if (origin === undefined) return wanted;
  // `new URL(path, origin)` cannot escape `origin` for a value matching SAFE_REDIRECT_PATH. It has no
  // scheme, no backslash, and cannot begin `//`.
  return new URL(wanted, origin).toString();
}

/**
 * The seven required members are from OpenID Connect Discovery 1.0 §3. A malformed document is
 * refused outright, never partially believed.
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
 * Absolute https only, or the code and client secret cross the network in clear. Loopback http is
 * allowed for a local provider, matching `config.ts` and the `prl.users.oidc_issuer` CHECK.
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
  // Appended to the issuer's path, not substituted for it. An issuer may legitimately be
  // `https://host/tenant/1`, and replacing the path would ask the wrong host for the document.
  const base = url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname;
  url.pathname = `${base}/.well-known/openid-configuration`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

/**
 * The `issuer` match is exact string equality. Any tolerance (trailing slash, case, host-only) also
 * accepts a value an attacker chose.
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

  // We only send `response_type=code`, so fail here rather than at the redirect.
  if (!responseTypes.includes('code')) throw exchangeFailed('provider does not support response_type=code');
  if (!signingAlgs.some((alg) => isSupportedAlg(alg))) {
    throw exchangeFailed('provider signs ID tokens with no algorithm we accept');
  }

  const codeChallengeMethods = readStringArray(document, 'code_challenge_methods_supported') ?? null;
  // Checked only when advertised. Some providers support S256 without listing it.
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

/**
 * A `type`, not an `interface`, because only a type alias gets the implicit index signature that
 * `createPublicKey`'s `JsonWebKey` requires.
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
  // One at a time. Under `exactOptionalPropertyTypes` an explicit `undefined` is not absent, and
  // `createPublicKey` checks presence.
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
 * Binds the key to the algorithm, because `alg` comes from the token and must not pick a looser
 * pairing. Every clause refuses a pairing rather than reinterpreting it.
 */
export function jwkMatchesAlg(jwk: Jwk, alg: SupportedIdTokenAlg): boolean {
  // `use: 'enc'` is an encryption key and must not verify signatures.
  if (jwk.use !== undefined && jwk.use !== 'sig') return false;
  if (jwk.key_ops !== undefined && !jwk.key_ops.includes('verify')) return false;
  if (jwk.alg !== undefined && jwk.alg !== alg) return false;
  if (alg === 'RS256') return jwk.kty === 'RSA' && jwk.n !== undefined && jwk.e !== undefined;
  // ES256 is P-256 only. Another curve with sha256 is not ES256.
  return jwk.kty === 'EC' && jwk.crv === 'P-256' && jwk.x !== undefined && jwk.y !== undefined;
}

/**
 * `null` for an unknown `kid` tells the caller to refetch once, for key rotation. With no `kid`, a
 * token passes only when exactly one key fits, or every retired key would become live.
 */
export function selectJwk(
  keys: readonly Jwk[],
  header: { readonly alg: SupportedIdTokenAlg; readonly kid?: string },
): Jwk | null {
  const usable = keys.filter((key) => jwkMatchesAlg(key, header.alg));
  if (header.kid !== undefined) return usable.find((key) => key.kid === header.kid) ?? null;
  return usable.length === 1 ? (usable[0] ?? null) : null;
}

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
 * Splits and decodes a compact JWS without verifying anything. Nothing may act on a claim until
 * `verifyJwsSignature` succeeds.
 */
export function parseJws(token: string): ParsedJws {
  const parts = token.split('.');
  // Five parts is a JWE, a configuration mistake rather than an attack.
  if (parts.length === 5) throw exchangeFailed('ID token was a JWE; encrypted ID tokens are not accepted');
  if (parts.length !== 3) throw exchangeFailed('ID token was not a three-part compact JWS');
  const [headerPart, claimsPart, signaturePart] = parts;
  if (headerPart === undefined || claimsPart === undefined || signaturePart === undefined) {
    throw exchangeFailed('ID token had a missing segment');
  }
  // This is what an `alg: none` token looks like on the wire.
  if (signaturePart === '') throw exchangeFailed('ID token carried no signature');
  // Checked before decoding, because `Buffer.from(x, 'base64url')` silently skips `+`, `/` and `=`.
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
    // The exact signed bytes. Re-serialising the decoded parts would change them.
    signingInput: Buffer.from(`${headerPart}.${claimsPart}`, 'ascii'),
    signature: Buffer.from(signaturePart, 'base64url'),
  };
}

/**
 * Refuses `none` (an unsigned token), any `HS*` (algorithm confusion, where a verifier uses the public
 * key as the HMAC secret and the attacker, holding that key, forges the MAC), and anything not on our
 * allowlist or not advertised by the provider.
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
 * ES256 needs `dsaEncoding: 'ieee-p1363'`, because JOSE ECDSA is raw `r || s` and OpenSSL defaults to
 * DER. Accepting both would reintroduce signature malleability.
 * Returns `false` rather than throwing, so how a check failed cannot become an oracle.
 */
export function verifyJwsSignature(jws: ParsedJws, jwk: Jwk, alg: SupportedIdTokenAlg): boolean {
  try {
    // A fresh literal satisfies `JsonWebKey`'s index signature. `createPublicKey` throws on
    // `kty: 'oct'`, so no HMAC key can become a verification key.
    const key = createPublicKey({ key: { ...jwk }, format: 'jwk' });
    if (alg === 'RS256') {
      return verify('sha256', jws.signingInput, { key, padding: constants.RSA_PKCS1_PADDING }, jws.signature);
    }
    return verify('sha256', jws.signingInput, { key, dsaEncoding: 'ieee-p1363' }, jws.signature);
  } catch {
    return false;
  }
}

/** The identity is the `(issuer, subject)` pair, because `sub` is unique only within an issuer. */
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
   * `sha256(nonce)`. Only the digest is stored, so taking a hash keeps the comparison digest to digest.
   */
  readonly nonceHash: Buffer;
  readonly nowMs: number;
}

/**
 * Every check is fatal. `nonce` is checked last so a token that fails an unconditional check never
 * logs as a replay.
 */
export function verifyIdTokenClaims(claims: Json, expect: IdTokenExpectation): VerifiedIdToken {
  const nowSeconds = Math.floor(expect.nowMs / 1_000);

  // `iss` by exact equality. A prefix or suffix match would also accept
  // `https://issuer.example.com.evil.test`.
  const issuer = readString(claims, 'iss');
  if (issuer === undefined) throw exchangeFailed('ID token had no iss');
  if (issuer !== expect.issuer) throw exchangeFailed('ID token iss did not match the configured issuer');

  // Bounded to what `prl.users.oidc_subject` accepts, so it fails here rather than at the INSERT.
  const subject = readString(claims, 'sub');
  if (subject === undefined) throw exchangeFailed('ID token had no sub');
  if (subject.length > 255) throw exchangeFailed('ID token sub was longer than the schema allows');

  // Without `aud`, a token the same provider issued to another client would authenticate here.
  assertAudience(claims, expect.clientId);

  // The skew is subtracted, so a stale token gets no extra minute.
  const exp = readNumber(claims, 'exp');
  if (exp === undefined) throw exchangeFailed('ID token had no exp');
  if (nowSeconds - CLOCK_SKEW_SECONDS >= exp) throw exchangeFailed('ID token has expired');

  // Required by OIDC Core §2. Bounded against the future and by `MAX_ID_TOKEN_AGE_SECONDS`.
  const iat = readNumber(claims, 'iat');
  if (iat === undefined) throw exchangeFailed('ID token had no iat');
  if (iat - CLOCK_SKEW_SECONDS > nowSeconds) throw exchangeFailed('ID token iat is in the future');
  if (nowSeconds - iat > MAX_ID_TOKEN_AGE_SECONDS + CLOCK_SKEW_SECONDS) {
    throw exchangeFailed('ID token is older than this server will accept');
  }

  // Optional, and checked when present.
  const nbf = readNumber(claims, 'nbf');
  if (nbf !== undefined && nbf - CLOCK_SKEW_SECONDS > nowSeconds) {
    throw exchangeFailed('ID token is not valid yet');
  }

  // Binds the token to this authorization request, so a captured token cannot be replayed.
  // Compared as digests, in constant time.
  const nonce = readString(claims, 'nonce');
  if (nonce === undefined) throw stateMismatch('ID token had no nonce');
  if (!timingSafeEquals(hashOidcSecret(nonce), expect.nonceHash)) {
    throw stateMismatch('ID token nonce did not match the login attempt');
  }

  return { issuer, subject, nameHint: readNameHint(claims) };
}

/** OIDC Core §3.1.3.7 rules 3 to 5. With several audiences, `azp` must name this client. */
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
 * Returned raw. `sanitiseDisplayName` in `src/routes/auth.ts` sanitises it at storage, and
 * `logging.ts` censors `displayName`.
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

export interface AuthorizationRequest {
  readonly state: string;
  readonly nonce: string;
  readonly codeChallenge: string;
}

export interface OidcRelyingParty {
  readonly discovery: () => Promise<DiscoveryDocument>;
  readonly authorizationUrl: (request: AuthorizationRequest) => Promise<string>;
  /** Exchanges a code for an ID token. Returns the raw compact JWS, nothing else. */
  readonly exchangeCode: (params: {
    readonly code: string;
    readonly codeVerifier: string;
  }) => Promise<string>;
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
  /** When an unknown-`kid` refetch last happened. Separate from the TTL. See `keySet`. */
  readonly refetchedAtMs: number | null;
}

/**
 * A closure, so the caches are truly private. One per process, created by `src/routes/auth.ts`, so
 * every sign-in shares the cached discovery document and key set.
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
    // The final URL after redirects. An https fetch that redirected to http was read in clear.
    assertHttpsUrl(response.url === '' ? url : response.url, `${what} response URL`);
    return parseJsonObject(await readBoundedText(response, maxBytes, what), what);
  }

  async function discovery(): Promise<DiscoveryDocument> {
    const cached = discoveryCache;
    if (cached !== null && now() < cached.expiresAtMs) return cached.document;
    const document = await getJson(discoveryUrlFor(config.issuer), MAX_DISCOVERY_BYTES, 'discovery document');
    const validated = validateDiscoveryDocument(document, config.issuer);
    // Only a valid document is cached, or one bad response would fail sign-ins for fifteen minutes.
    discoveryCache = { document: validated, expiresAtMs: now() + DISCOVERY_TTL_MS };
    return validated;
  }

  async function fetchKeySet(uri: string, at: number, refetchedAtMs: number | null): Promise<readonly Jwk[]> {
    const keys = parseJwkSet(await getJson(uri, MAX_JWKS_BYTES, 'JWKS'));
    jwksCache = { uri, keys, expiresAtMs: at + JWKS_TTL_MS, refetchedAtMs };
    return keys;
  }

  /**
   * `refresh: true` means the needed `kid` is missing, which is what rotation looks like. The first
   * refetch is honoured at once, later ones within `JWKS_MIN_REFETCH_MS` are served from cache. A
   * failed fetch leaves the cache untouched. Not `async`, because three of four paths await nothing.
   */
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
    // `searchParams` percent-encodes, so a value containing `&` cannot inject a parameter.
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', config.clientId);
    // From configuration, never the request, or a code could be delivered to another server.
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
      // PKCE proves this exchange comes from the client that started the flow.
      code_verifier: params.codeVerifier,
    });
    const headers = tokenRequestHeaders(document, config, body);

    let response: Response;
    try {
      response = await fetchImpl(document.tokenEndpoint, {
        method: 'POST',
        headers,
        body: body.toString(),
        // This request carries the client secret, and a redirect would forward it.
        redirect: 'error',
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
    } catch (error) {
      throw exchangeFailed('token endpoint could not be reached', error);
    }

    const text = await readBoundedText(response, MAX_TOKEN_RESPONSE_BYTES, 'token response');
    if (!response.ok) {
      // The provider's error body is attacker-influenceable and can echo parameters. Not read, not
      // logged.
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
 * `client_secret_basic` keeps the secret out of the body. `client_secret_post` is the fallback.
 * Anything else fails loudly at the exchange rather than sending an unauthenticated request.
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
  // An absent list means the OAuth 2.0 default, client_secret_basic.
  if (methods === null || methods.includes('client_secret_basic')) {
    // RFC 6749 §2.3.1. Both halves are form-urlencoded before base64.
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
 * `response.text()` has no limit, so a misbehaving provider could exhaust memory. The ceiling is
 * enforced chunk by chunk, before the memory is committed.
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
 * Optional in JWS. `at+jwt` is an access token, which is not audience-restricted to us or required to
 * carry a nonce, so it is refused.
 */
function assertHeaderType(header: JwsHeader): void {
  const typ = header.typ;
  if (typ === undefined) return;
  const normalised = typ.toLowerCase();
  if (normalised !== 'jwt' && normalised !== 'application/jwt') {
    throw exchangeFailed('ID token header typ was not JWT');
  }
}

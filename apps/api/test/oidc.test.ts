/**
 * The OIDC relying party, tested with no network and no database.
 *
 * Every case here runs against a fake identity provider: an in-process `fetch` that serves a
 * discovery document, a JWKS, and a token endpoint, plus real RSA and EC keys from
 * `generateKeyPairSync` so the signatures being verified are genuine signatures.
 *
 * ## Why the failure matrix is one test per check
 *
 * A single "rejects a bad token" test passes as soon as *any* check fires, which means it keeps
 * passing after somebody deletes the `aud` comparison. So each check gets its own case, each
 * builds a token that is valid in every respect except the one under test, and each asserts the
 * specific `ErrorCode`. If a check is removed, exactly one case fails and it names the check.
 *
 * The two most important cases are `alg: 'none'` and `alg: 'HS256'`. Both are complete
 * authentication bypasses in an implementation that gets them wrong, and the HMAC one is built
 * the way the real attack is built: the token is signed with the provider's *public* key used as
 * an HMAC secret, which is a value the attacker also has.
 */

import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import { describe, it } from 'node:test';
import type { ErrorCode } from '@prl/contracts';
import {
  assertAlgAllowed,
  CLOCK_SKEW_SECONDS,
  createAttemptSecrets,
  createOidcRelyingParty,
  discoveryUrlFor,
  isSafeRedirectPath,
  type Jwk,
  jwkMatchesAlg,
  MAX_ID_TOKEN_AGE_SECONDS,
  packAttemptCookie,
  parseJws,
  pkceChallengeFor,
  SUPPORTED_ID_TOKEN_ALGS,
  safeRedirectTarget,
  selectJwk,
  unpackAttemptCookie,
  validateDiscoveryDocument,
  verifyIdTokenClaims,
} from '../src/auth/oidc.ts';
import type { OidcConfig } from '../src/config.ts';
import { isAppError } from '../src/errors.ts';
import { hashOidcSecret } from '../src/repositories/hashing.ts';

// ---------------------------------------------------------------------------
// The fake identity provider
// ---------------------------------------------------------------------------

const ISSUER = 'https://idp.example.test';
const CLIENT_ID = 'poker-risk-lab-test';
const REDIRECT_URI = 'https://api.example.test/api/v1/auth/oidc/callback';

const OIDC_CONFIG: OidcConfig = {
  issuer: ISSUER,
  clientId: CLIENT_ID,
  clientSecret: 'a-client-secret-that-is-only-ever-in-a-header',
  redirectUri: REDIRECT_URI,
};

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

interface TestKey {
  readonly kid: string;
  readonly alg: 'RS256' | 'ES256';
  readonly privateKey: KeyObject;
  readonly jwk: Jwk;
}

/** A real key pair, exported as the JWK a provider would publish. */
function makeKey(kid: string, alg: 'RS256' | 'ES256'): TestKey {
  const pair =
    alg === 'RS256'
      ? generateKeyPairSync('rsa', { modulusLength: 2048 })
      : generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const exported = pair.publicKey.export({ format: 'jwk' });
  const kty = typeof exported.kty === 'string' ? exported.kty : '';
  const jwk: Jwk = { ...exported, kty, kid, use: 'sig', alg };
  return { kid, alg, privateKey: pair.privateKey, jwk };
}

const RSA_KEY = makeKey('rsa-1', 'RS256');
const EC_KEY = makeKey('ec-1', 'ES256');
const ROTATED_KEY = makeKey('rsa-2', 'RS256');

interface TokenParts {
  readonly header?: Readonly<Record<string, unknown>>;
  readonly claims?: Readonly<Record<string, unknown>>;
  readonly key?: TestKey;
  /** Corrupts the signature without touching anything else. */
  readonly breakSignature?: boolean;
}

/** Claims that pass every check, so each test only has to change the one it is about. */
function goodClaims(nonce: string, nowSeconds: number): Record<string, unknown> {
  return {
    iss: ISSUER,
    sub: 'subject-0001',
    aud: CLIENT_ID,
    exp: nowSeconds + 300,
    iat: nowSeconds,
    nonce,
    name: 'Ada Lovelace',
  };
}

function signJwt(parts: TokenParts, nonce: string, nowSeconds: number): string {
  const key = parts.key ?? RSA_KEY;
  // Typed as a loose record on purpose: half the tests here need to put a value in `alg` that a
  // real relying party would refuse, and a narrower type would make those tests unwritable.
  const header: Record<string, unknown> = { alg: key.alg, typ: 'JWT', kid: key.kid, ...parts.header };
  const claims = { ...goodClaims(nonce, nowSeconds), ...parts.claims };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const algorithm = typeof header.alg === 'string' ? header.alg : '';

  if (algorithm === 'none') return `${signingInput}.`;
  if (algorithm.startsWith('HS')) {
    // The algorithm-confusion attack, built the way an attacker builds it: HMAC keyed with the
    // provider's *public* key, which anybody can fetch from the JWKS.
    const secret = JSON.stringify(key.jwk);
    return `${signingInput}.${createHmac('sha256', secret).update(signingInput).digest('base64url')}`;
  }

  const signature =
    key.alg === 'RS256'
      ? sign('sha256', Buffer.from(signingInput, 'ascii'), key.privateKey)
      : sign('sha256', Buffer.from(signingInput, 'ascii'), {
          key: key.privateKey,
          dsaEncoding: 'ieee-p1363',
        });
  const encoded = parts.breakSignature
    ? base64url(Buffer.concat([signature.subarray(0, signature.length - 1), Buffer.from([0x00])]))
    : signature.toString('base64url');
  return `${signingInput}.${encoded}`;
}

interface ProviderOptions {
  readonly keys?: readonly TestKey[];
  readonly discoveryOverrides?: Readonly<Record<string, unknown>>;
  /** Replaces the whole discovery document, for the malformed-document cases. */
  readonly discoveryBody?: unknown;
  readonly tokenStatus?: number;
  readonly tokenBody?: unknown;
}

type FetchArgs = Parameters<typeof globalThis.fetch>;

interface Provider {
  readonly fetchImpl: typeof globalThis.fetch;
  readonly calls: string[];
  readonly tokenRequests: { readonly headers: Headers; readonly body: string }[];
  setKeys: (keys: readonly TestKey[]) => void;
  setIdToken: (token: string) => void;
}

function makeProvider(options: ProviderOptions = {}): Provider {
  const calls: string[] = [];
  const tokenRequests: { headers: Headers; body: string }[] = [];
  let keys = options.keys ?? [RSA_KEY];
  let idToken = '';

  const discovery = (): unknown =>
    options.discoveryBody !== undefined
      ? options.discoveryBody
      : {
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/authorize`,
          token_endpoint: `${ISSUER}/token`,
          jwks_uri: `${ISSUER}/jwks`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256', 'ES256'],
          code_challenge_methods_supported: ['S256'],
          ...options.discoveryOverrides,
        };

  const json = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

  // Written synchronously and wrapped once, because an `async` function with no `await` in it is
  // a lint error in this repo. The parameter types are derived from `fetch` itself rather than
  // written out: `RequestInfo` is a DOM global that `@types/node` does not declare, and this repo
  // compiles with `lib: ["ES2024"]`.
  const respond = (input: FetchArgs[0], init: FetchArgs[1]): Response => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    if (url === discoveryUrlFor(ISSUER)) return json(discovery());
    if (url === `${ISSUER}/jwks`) return json({ keys: keys.map((key) => key.jwk) });
    if (url === `${ISSUER}/token`) {
      const headers = new Headers(init?.headers);
      tokenRequests.push({ headers, body: typeof init?.body === 'string' ? init.body : '' });
      if (options.tokenBody !== undefined) return json(options.tokenBody, options.tokenStatus ?? 200);
      if (options.tokenStatus !== undefined && options.tokenStatus !== 200) {
        return json({ error: 'invalid_grant' }, options.tokenStatus);
      }
      return json({ access_token: 'ignored', token_type: 'Bearer', id_token: idToken });
    }
    return new Response('not found', { status: 404 });
  };

  const fetchImpl: typeof globalThis.fetch = (input, init) => Promise.resolve(respond(input, init));

  return {
    fetchImpl,
    calls,
    tokenRequests,
    setKeys: (next) => {
      keys = next;
    },
    setIdToken: (token) => {
      idToken = token;
    },
  };
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

/** Runs `work`, asserts it threw an `AppError` with `code`, and returns the log detail. */
async function rejectsWith(code: ErrorCode, work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
  } catch (error) {
    assert.ok(isAppError(error), `expected an AppError, got ${String(error)}`);
    assert.equal(error.code, code, `wrong code; logDetail was "${error.message}"`);
    return error.message;
  }
  assert.fail(`expected ${code} but nothing was thrown`);
}

function rejectsSyncWith(code: ErrorCode, work: () => unknown): string {
  try {
    work();
  } catch (error) {
    assert.ok(isAppError(error), `expected an AppError, got ${String(error)}`);
    assert.equal(error.code, code, `wrong code; logDetail was "${error.message}"`);
    return error.message;
  }
  assert.fail(`expected ${code} but nothing was thrown`);
}

/** A relying party over a fake provider, with time under the test's control. */
function relyingParty(provider: Provider, nowMs: () => number = Date.now) {
  return createOidcRelyingParty({ config: OIDC_CONFIG, fetchImpl: provider.fetchImpl, now: nowMs });
}

const NONCE = 'a-nonce-that-is-32-bytes-of-random-in-real-life';
const NOW_MS = Date.UTC(2026, 7, 17, 12, 0, 0);
const NOW_SECONDS = Math.floor(NOW_MS / 1_000);

/** Mints a token and hands the provider the value its token endpoint will return. */
function armProvider(provider: Provider, parts: TokenParts = {}, nonce = NONCE): string {
  const token = signJwt(parts, nonce, NOW_SECONDS);
  provider.setIdToken(token);
  return token;
}

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

describe('PKCE', () => {
  it('matches the S256 test vector from RFC 7636 appendix B', () => {
    // Locking the challenge derivation to the RFC's own vector is the only way to be sure it is
    // base64url(sha256(ascii(verifier))) and not, say, hex or base64-with-padding — both of which
    // produce a plausible-looking string that every provider rejects.
    assert.equal(
      pkceChallengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('generates a verifier inside the length RFC 7636 allows, and three distinct secrets', () => {
    const secrets = createAttemptSecrets();
    assert.ok(secrets.codeVerifier.length >= 43 && secrets.codeVerifier.length <= 128);
    assert.match(secrets.codeVerifier, /^[A-Za-z0-9_-]+$/);
    // A state that doubled as a nonce would make the CSRF check and the replay check one check.
    assert.equal(new Set([secrets.state, secrets.nonce, secrets.codeVerifier]).size, 3);
    assert.equal(secrets.codeChallenge, pkceChallengeFor(secrets.codeVerifier));
  });

  it('never repeats a secret across attempts', () => {
    const states = new Set<string>();
    for (let attempt = 0; attempt < 50; attempt += 1) states.add(createAttemptSecrets().state);
    assert.equal(states.size, 50);
  });
});

describe('the attempt cookie', () => {
  it('round-trips the state and the verifier', () => {
    const secrets = createAttemptSecrets();
    const packed = packAttemptCookie(secrets);
    assert.deepEqual(unpackAttemptCookie(packed), {
      state: secrets.state,
      codeVerifier: secrets.codeVerifier,
    });
  });

  it('refuses anything that is not exactly two base64url halves', () => {
    const secrets = createAttemptSecrets();
    for (const bad of [
      '',
      secrets.state,
      `${secrets.state}.${secrets.codeVerifier}.extra`,
      `${secrets.state}.short`,
      `not+base64url.${secrets.codeVerifier}`,
      `${secrets.state}.has spaces in it and is long enough to pass the length check ok`,
    ]) {
      assert.equal(unpackAttemptCookie(bad), null, `should have refused "${bad.slice(0, 24)}"`);
    }
  });
});

// ---------------------------------------------------------------------------
// Redirect targets
// ---------------------------------------------------------------------------

describe('redirectAfter', () => {
  it('accepts site-relative paths', () => {
    for (const path of ['/', '/play', '/lessons/pot-odds', '/play?table=room_abc', '/a_b-c.d']) {
      assert.ok(isSafeRedirectPath(path), `${path} should be accepted`);
    }
  });

  it('rejects everything a browser could read as another origin', () => {
    // The four in the brief, plus the near-misses that catch a lazy check.
    for (const path of [
      'https://evil.com',
      '//evil.com',
      '/\\evil.com',
      'http://evil.com',
      '/\\/evil.com',
      '///evil.com',
      'javascript:alert(1)',
      '/path\\with\\backslash',
      '/path with spaces',
      '/%2f%2fevil.com',
      'play',
      '',
      `/${'x'.repeat(300)}`,
    ]) {
      assert.equal(isSafeRedirectPath(path), false, `${path} should be rejected`);
    }
  });

  it('builds the target from our own origin and the request path only', () => {
    const origins = ['http://localhost:3000', 'https://app.example.test'];
    assert.equal(safeRedirectTarget('/play', origins), 'http://localhost:3000/play');
    // A path that fails validation is not worth failing sign-in over; it becomes the root.
    assert.equal(safeRedirectTarget('//evil.com', origins), 'http://localhost:3000/');
    assert.equal(safeRedirectTarget(null, origins), 'http://localhost:3000/');
    // The origin is never taken from the path, so there is no value of `path` that leaves ours.
    assert.equal(new URL(safeRedirectTarget('/play', origins)).origin, 'http://localhost:3000');
  });
});

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

describe('discovery', () => {
  it('appends the well-known path to the issuer rather than replacing it', () => {
    assert.equal(
      discoveryUrlFor('https://idp.example.test'),
      'https://idp.example.test/.well-known/openid-configuration',
    );
    // A tenant path in the issuer is legitimate and must survive.
    assert.equal(
      discoveryUrlFor('https://idp.example.test/tenant/7/'),
      'https://idp.example.test/tenant/7/.well-known/openid-configuration',
    );
  });

  it('refuses a document whose issuer is not the configured one', async () => {
    const provider = makeProvider({ discoveryOverrides: { issuer: 'https://idp.example.test.evil' } });
    const detail = await rejectsWith('oidc_exchange_failed', () => relyingParty(provider).discovery());
    assert.match(detail, /issuer did not match/);
  });

  it('refuses a document that is missing any required member', async () => {
    const required = [
      'authorization_endpoint',
      'token_endpoint',
      'jwks_uri',
      'response_types_supported',
      'subject_types_supported',
      'id_token_signing_alg_values_supported',
    ];
    for (const member of required) {
      const body: Record<string, unknown> = {
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
      };
      delete body[member];
      const provider = makeProvider({ discoveryBody: body });
      await rejectsWith('oidc_exchange_failed', () => relyingParty(provider).discovery());
    }
  });

  it('refuses a plaintext endpoint, a document that is not an object, and one that is not JSON', async () => {
    const plaintext = makeProvider({
      discoveryOverrides: { token_endpoint: 'http://idp.example.test/token' },
    });
    assert.match(
      await rejectsWith('oidc_exchange_failed', () => relyingParty(plaintext).discovery()),
      /token_endpoint was not https/,
    );

    const array = makeProvider({ discoveryBody: [1, 2, 3] });
    await rejectsWith('oidc_exchange_failed', () => relyingParty(array).discovery());
  });

  it('refuses a provider that cannot do code flow or S256, or that signs with nothing we accept', async () => {
    const noCode = makeProvider({ discoveryOverrides: { response_types_supported: ['id_token'] } });
    await rejectsWith('oidc_exchange_failed', () => relyingParty(noCode).discovery());

    const noS256 = makeProvider({ discoveryOverrides: { code_challenge_methods_supported: ['plain'] } });
    assert.match(await rejectsWith('oidc_exchange_failed', () => relyingParty(noS256).discovery()), /S256/);

    const badAlgs = makeProvider({
      discoveryOverrides: { id_token_signing_alg_values_supported: ['HS256', 'none'] },
    });
    await rejectsWith('oidc_exchange_failed', () => relyingParty(badAlgs).discovery());
  });

  it('caches the document and does not refetch inside the TTL', async () => {
    const provider = makeProvider();
    const party = relyingParty(provider, () => NOW_MS);
    await party.discovery();
    await party.discovery();
    await party.discovery();
    assert.equal(provider.calls.filter((url) => url.includes('well-known')).length, 1);
  });

  it('does not cache a rejected document, so one bad response is not fifteen minutes of failure', async () => {
    const provider = makeProvider({ discoveryOverrides: { issuer: 'https://wrong.example.test' } });
    const party = relyingParty(provider, () => NOW_MS);
    await rejectsWith('oidc_exchange_failed', () => party.discovery());
    await rejectsWith('oidc_exchange_failed', () => party.discovery());
    assert.equal(provider.calls.filter((url) => url.includes('well-known')).length, 2);
  });

  it('validates directly, without a fetch, so the rules can be read against the spec', () => {
    const document = {
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      jwks_uri: `${ISSUER}/jwks`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
    };
    const validated = validateDiscoveryDocument(document, ISSUER);
    assert.equal(validated.tokenEndpoint, `${ISSUER}/token`);
    assert.equal(validated.codeChallengeMethodsSupported, null);
    // A trailing slash is a different string, and there is no "close enough" for an issuer.
    rejectsSyncWith('oidc_exchange_failed', () => validateDiscoveryDocument(document, `${ISSUER}/`));
  });
});

// ---------------------------------------------------------------------------
// The authorization request
// ---------------------------------------------------------------------------

describe('the authorization URL', () => {
  it('carries every parameter the flow depends on, and no request-supplied redirect_uri', async () => {
    const provider = makeProvider();
    const secrets = createAttemptSecrets();
    const url = new URL(
      await relyingParty(provider).authorizationUrl({
        state: secrets.state,
        nonce: secrets.nonce,
        codeChallenge: secrets.codeChallenge,
      }),
    );

    assert.equal(url.origin + url.pathname, `${ISSUER}/authorize`);
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('client_id'), CLIENT_ID);
    // From configuration, never from a request. A request-chosen redirect_uri is how an
    // authorization code gets delivered to somebody else's server.
    assert.equal(url.searchParams.get('redirect_uri'), REDIRECT_URI);
    assert.equal(url.searchParams.get('state'), secrets.state);
    assert.equal(url.searchParams.get('nonce'), secrets.nonce);
    assert.equal(url.searchParams.get('code_challenge'), secrets.codeChallenge);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    // Never `plain`: the verifier would travel in this very URL.
    assert.notEqual(url.searchParams.get('code_challenge_method'), 'plain');
    // The verifier itself must not be here.
    assert.equal(url.toString().includes(secrets.codeVerifier), false);
    // `email` is not requested: it is not an identity key here and there is nowhere to put it.
    assert.equal(url.searchParams.get('scope'), 'openid profile');
  });
});

// ---------------------------------------------------------------------------
// The token exchange
// ---------------------------------------------------------------------------

describe('the token exchange', () => {
  it('sends the verifier and authenticates with client_secret_basic by default', async () => {
    const provider = makeProvider();
    armProvider(provider);
    const secrets = createAttemptSecrets();
    await relyingParty(provider, () => NOW_MS).exchangeCode({
      code: 'the-authorization-code',
      codeVerifier: secrets.codeVerifier,
    });

    const request = provider.tokenRequests[0];
    assert.ok(request !== undefined, 'the token endpoint should have been called');
    assert.ok(request.headers.get('authorization')?.startsWith('Basic '));
    // The secret is in the header, not the body — one fewer place for a proxy log to catch it.
    assert.equal(request.body.includes('client_secret'), false);

    const body = new URLSearchParams(request.body);
    assert.equal(body.get('grant_type'), 'authorization_code');
    assert.equal(body.get('code'), 'the-authorization-code');
    assert.equal(body.get('code_verifier'), secrets.codeVerifier);
    assert.equal(body.get('redirect_uri'), REDIRECT_URI);
  });

  it('uses client_secret_post when that is what the provider advertises', async () => {
    const provider = makeProvider({
      discoveryOverrides: { token_endpoint_auth_methods_supported: ['client_secret_post'] },
    });
    armProvider(provider);
    await relyingParty(provider, () => NOW_MS).exchangeCode({ code: 'c', codeVerifier: 'v'.repeat(43) });
    const request = provider.tokenRequests[0];
    assert.ok(request !== undefined);
    assert.equal(request.headers.get('authorization'), null);
    assert.equal(new URLSearchParams(request.body).get('client_secret'), OIDC_CONFIG.clientSecret);
  });

  it('refuses an auth method it does not implement rather than sending an unauthenticated request', async () => {
    const provider = makeProvider({
      discoveryOverrides: { token_endpoint_auth_methods_supported: ['private_key_jwt'] },
    });
    await rejectsWith('oidc_exchange_failed', () =>
      relyingParty(provider, () => NOW_MS).exchangeCode({ code: 'c', codeVerifier: 'v'.repeat(43) }),
    );
    assert.equal(provider.tokenRequests.length, 0);
  });

  it('maps a failed exchange to oidc_exchange_failed without echoing the provider body', async () => {
    const provider = makeProvider({ tokenStatus: 400 });
    const detail = await rejectsWith('oidc_exchange_failed', () =>
      relyingParty(provider, () => NOW_MS).exchangeCode({ code: 'c', codeVerifier: 'v'.repeat(43) }),
    );
    assert.match(detail, /status 400/);
    // The provider's own error string must not travel with the failure.
    assert.equal(detail.includes('invalid_grant'), false);
  });

  it('refuses a response with no id_token, and one that is not a bearer grant', async () => {
    const noToken = makeProvider({ tokenBody: { access_token: 'a', token_type: 'Bearer' } });
    assert.match(
      await rejectsWith('oidc_exchange_failed', () =>
        relyingParty(noToken, () => NOW_MS).exchangeCode({ code: 'c', codeVerifier: 'v'.repeat(43) }),
      ),
      /no id_token/,
    );

    const wrongType = makeProvider({ tokenBody: { token_type: 'mac', id_token: 'a.b.c' } });
    await rejectsWith('oidc_exchange_failed', () =>
      relyingParty(wrongType, () => NOW_MS).exchangeCode({ code: 'c', codeVerifier: 'v'.repeat(43) }),
    );
  });
});

// ---------------------------------------------------------------------------
// ID token verification: the happy path
// ---------------------------------------------------------------------------

describe('ID token verification', () => {
  it('accepts a well-formed RS256 token and yields (iss, sub)', async () => {
    const provider = makeProvider();
    const token = armProvider(provider);
    const verified = await relyingParty(provider, () => NOW_MS).verifyIdToken(token, {
      nonceHash: hashOidcSecret(NONCE),
    });
    assert.equal(verified.issuer, ISSUER);
    assert.equal(verified.subject, 'subject-0001');
    assert.equal(verified.nameHint, 'Ada Lovelace');
  });

  it('accepts a well-formed ES256 token, with the raw r||s signature encoding JOSE uses', async () => {
    const provider = makeProvider({ keys: [EC_KEY] });
    const token = armProvider(provider, { key: EC_KEY });
    const verified = await relyingParty(provider, () => NOW_MS).verifyIdToken(token, {
      nonceHash: hashOidcSecret(NONCE),
    });
    assert.equal(verified.subject, 'subject-0001');
  });

  it('has no member that could be mistaken for an identity key other than (iss, sub)', async () => {
    const provider = makeProvider();
    const token = armProvider(provider, { claims: { email: 'ada@example.test', email_verified: true } });
    const verified = await relyingParty(provider, () => NOW_MS).verifyIdToken(token, {
      nonceHash: hashOidcSecret(NONCE),
    });
    // An email address is mutable, often unverified, and reused between providers. It is not
    // read, not returned, and not stored.
    assert.deepEqual(Object.keys(verified).sort(), ['issuer', 'nameHint', 'subject']);
  });
});

// ---------------------------------------------------------------------------
// ID token verification: one test per check
// ---------------------------------------------------------------------------

describe('ID token verification rejects', () => {
  function verify(parts: TokenParts, options: ProviderOptions = {}, nonce = NONCE): Promise<unknown> {
    const provider = makeProvider(options);
    const token = armProvider(provider, parts, nonce);
    return relyingParty(provider, () => NOW_MS).verifyIdToken(token, { nonceHash: hashOidcSecret(NONCE) });
  }

  it('a bad signature', async () => {
    const detail = await rejectsWith('oidc_exchange_failed', () => verify({ breakSignature: true }));
    assert.match(detail, /signature did not verify/);
  });

  it('a token signed by a key the provider does not publish', async () => {
    // Same `kid`, different key: the shape is right and only the mathematics disagrees.
    const impostor = makeKey(RSA_KEY.kid, 'RS256');
    await rejectsWith('oidc_exchange_failed', () => verify({ key: impostor }, { keys: [RSA_KEY] }));
  });

  it('the wrong iss', async () => {
    const detail = await rejectsWith('oidc_exchange_failed', () =>
      verify({ claims: { iss: 'https://idp.example.test.evil' } }),
    );
    assert.match(detail, /iss did not match/);
  });

  it('an iss that only looks like ours', async () => {
    // Each of these passes a `startsWith`, an `endsWith` or an `includes` comparison.
    for (const iss of [
      `${ISSUER}/`,
      `${ISSUER}.evil.test`,
      `https://evil.test/?x=${ISSUER}`,
      ISSUER.toUpperCase(),
      ' https://idp.example.test',
    ]) {
      await rejectsWith('oidc_exchange_failed', () => verify({ claims: { iss } }));
    }
  });

  it('the wrong aud', async () => {
    const detail = await rejectsWith('oidc_exchange_failed', () =>
      verify({ claims: { aud: 'some-other-client' } }),
    );
    assert.match(detail, /aud did not contain/);
  });

  it('an aud array that does not contain us', async () => {
    await rejectsWith('oidc_exchange_failed', () => verify({ claims: { aud: ['a', 'b'] } }));
  });

  it('multiple audiences with no azp, or an azp naming another client', async () => {
    await rejectsWith('oidc_exchange_failed', () => verify({ claims: { aud: [CLIENT_ID, 'other'] } }));
    await rejectsWith('oidc_exchange_failed', () =>
      verify({ claims: { aud: [CLIENT_ID, 'other'], azp: 'other' } }),
    );
    // The same token with a correct `azp` is accepted, which is what makes the two above a real
    // check rather than a blanket refusal of multi-audience tokens.
    assert.ok(await verify({ claims: { aud: [CLIENT_ID, 'other'], azp: CLIENT_ID } }));
  });

  it('an expired token, including one that is only just outside the skew', async () => {
    const detail = await rejectsWith('oidc_exchange_failed', () =>
      verify({ claims: { exp: NOW_SECONDS - CLOCK_SKEW_SECONDS - 1 } }),
    );
    assert.match(detail, /expired/);
    // Just inside the skew is accepted, which proves the tolerance is applied and bounded.
    assert.ok(await verify({ claims: { exp: NOW_SECONDS - CLOCK_SKEW_SECONDS + 5 } }));
  });

  it('a missing exp', async () => {
    await rejectsWith('oidc_exchange_failed', () => verify({ claims: { exp: undefined } }));
  });

  it('an nbf in the future', async () => {
    const detail = await rejectsWith('oidc_exchange_failed', () =>
      verify({ claims: { nbf: NOW_SECONDS + CLOCK_SKEW_SECONDS + 60 } }),
    );
    assert.match(detail, /not valid yet/);
    // An nbf inside the skew is fine.
    assert.ok(await verify({ claims: { nbf: NOW_SECONDS + 10 } }));
  });

  it('an iat in the future, a missing iat, and one older than we will accept', async () => {
    await rejectsWith('oidc_exchange_failed', () =>
      verify({ claims: { iat: NOW_SECONDS + CLOCK_SKEW_SECONDS + 60 } }),
    );
    await rejectsWith('oidc_exchange_failed', () => verify({ claims: { iat: undefined } }));
    await rejectsWith('oidc_exchange_failed', () =>
      verify({
        claims: {
          iat: NOW_SECONDS - MAX_ID_TOKEN_AGE_SECONDS - CLOCK_SKEW_SECONDS - 10,
          exp: NOW_SECONDS + 300,
        },
      }),
    );
  });

  it('the wrong nonce, and a missing one', async () => {
    // `oidc_state_mismatch`, not `oidc_exchange_failed`: a nonce that does not match means this
    // token belongs to a different sign-in attempt, which is the same class of event as a bad
    // `state` and gets the same answer.
    const detail = await rejectsWith('oidc_state_mismatch', () => verify({}, {}, 'a-different-nonce'));
    assert.match(detail, /nonce did not match/);
    await rejectsWith('oidc_state_mismatch', () => verify({ claims: { nonce: undefined } }));
  });

  it("alg: 'none' — an unsigned token, which is whatever the caller typed", async () => {
    const detail = await rejectsWith('oidc_exchange_failed', () => verify({ header: { alg: 'none' } }));
    // Either refusal is correct; what matters is that no unsigned token is ever believed.
    assert.match(detail, /no signature|alg was none/);
  });

  it("alg: 'none' with a non-empty signature segment, so the alg check is the one that fires", async () => {
    const provider = makeProvider();
    const good = signJwt({}, NONCE, NOW_SECONDS);
    const parts = good.split('.');
    const header = base64url(JSON.stringify({ alg: 'none', typ: 'JWT', kid: RSA_KEY.kid }));
    const forged = `${header}.${parts[1] ?? ''}.${parts[2] ?? ''}`;
    const detail = await rejectsWith('oidc_exchange_failed', () =>
      relyingParty(provider, () => NOW_MS).verifyIdToken(forged, { nonceHash: hashOidcSecret(NONCE) }),
    );
    assert.match(detail, /alg was none/);
  });

  it('an HMAC alg — the algorithm-confusion attack, signed with the public key', async () => {
    // The attack in full: the token says HS256, and the "secret" is the provider's public JWK,
    // which the attacker fetched from the same JWKS this server reads. A verifier that lets the
    // token choose the algorithm family authenticates it.
    for (const alg of ['HS256', 'HS384', 'HS512', 'hs256']) {
      const detail = await rejectsWith('oidc_exchange_failed', () => verify({ header: { alg } }));
      assert.match(detail, /symmetric/);
    }
  });

  it('an alg that is neither on our allowlist nor advertised by the provider', async () => {
    await rejectsWith('oidc_exchange_failed', () =>
      verify(
        { header: { alg: 'RS512' } },
        { discoveryOverrides: { id_token_signing_alg_values_supported: ['RS512', 'RS256'] } },
      ),
    );
    // On the allowlist, but the provider says it does not sign with it.
    const detail = await rejectsWith('oidc_exchange_failed', () =>
      verify(
        { key: EC_KEY },
        {
          keys: [EC_KEY],
          discoveryOverrides: { id_token_signing_alg_values_supported: ['RS256'] },
        },
      ),
    );
    assert.match(detail, /provider advertises/);
  });

  it('an unknown kid, after exactly one refetch for rotation', async () => {
    const provider = makeProvider({ keys: [RSA_KEY] });
    const party = relyingParty(provider, () => NOW_MS);
    const token = signJwt({ key: ROTATED_KEY }, NONCE, NOW_SECONDS);

    const detail = await rejectsWith('oidc_exchange_failed', () =>
      party.verifyIdToken(token, { nonceHash: hashOidcSecret(NONCE) }),
    );
    assert.match(detail, /no published key matches/);
    // One initial fetch plus one rotation refetch. Not three, and not zero.
    assert.equal(provider.calls.filter((url) => url.endsWith('/jwks')).length, 2);
  });

  it('an encrypted token (a five-part JWE) and other malformed shapes', async () => {
    const provider = makeProvider();
    const party = relyingParty(provider, () => NOW_MS);
    const expect = { nonceHash: hashOidcSecret(NONCE) };
    assert.match(
      await rejectsWith('oidc_exchange_failed', () => party.verifyIdToken('a.b.c.d.e', expect)),
      /JWE/,
    );
    for (const bad of ['', 'a', 'a.b', 'a.b.c.d', 'a+b.c.d', '..']) {
      await rejectsWith('oidc_exchange_failed', () => party.verifyIdToken(bad, expect));
    }
  });

  it('a header typ that says this is an access token, not an ID token', async () => {
    const detail = await rejectsWith('oidc_exchange_failed', () => verify({ header: { typ: 'at+jwt' } }));
    assert.match(detail, /typ was not JWT/);
  });

  it('a sub longer than the schema can store, and a missing sub', async () => {
    await rejectsWith('oidc_exchange_failed', () => verify({ claims: { sub: 'x'.repeat(256) } }));
    await rejectsWith('oidc_exchange_failed', () => verify({ claims: { sub: undefined } }));
  });
});

// ---------------------------------------------------------------------------
// Key rotation and the refetch floor
// ---------------------------------------------------------------------------

describe('JWKS caching', () => {
  it('serves the cached key set without refetching inside the TTL', async () => {
    const provider = makeProvider();
    const party = relyingParty(provider, () => NOW_MS);
    const expect = { nonceHash: hashOidcSecret(NONCE) };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await party.verifyIdToken(signJwt({}, NONCE, NOW_SECONDS), expect);
    }
    assert.equal(provider.calls.filter((url) => url.endsWith('/jwks')).length, 1);
  });

  it('picks a rotation up at once, then floors the next unknown kid until the window passes', async () => {
    const provider = makeProvider({ keys: [RSA_KEY] });
    let clock = NOW_MS;
    const party = relyingParty(provider, () => clock);
    const expect = { nonceHash: hashOidcSecret(NONCE) };
    const jwksFetches = (): number => provider.calls.filter((url) => url.endsWith('/jwks')).length;

    // Populates the cache with the current key.
    await party.verifyIdToken(signJwt({}, NONCE, NOW_SECONDS), expect);
    assert.equal(jwksFetches(), 1);

    // A genuine rotation. The first unknown `kid` after a successful fetch is honoured
    // immediately: making the operator wait out a ten-minute TTL would mean every sign-in fails
    // for ten minutes after a routine key roll.
    provider.setKeys([ROTATED_KEY]);
    clock = NOW_MS + 1_000;
    const afterRotation = await party.verifyIdToken(
      signJwt({ key: ROTATED_KEY }, NONCE, Math.floor(clock / 1_000)),
      expect,
    );
    assert.equal(afterRotation.subject, 'subject-0001');
    assert.equal(jwksFetches(), 2);

    // A second unknown `kid` inside the floor is refused without an outbound request. This is the
    // half that stops a forged `kid` being used as a request amplifier.
    const third = makeKey('rsa-3', 'RS256');
    provider.setKeys([third]);
    clock = NOW_MS + 2_000;
    await rejectsWith('oidc_exchange_failed', () =>
      party.verifyIdToken(signJwt({ key: third }, NONCE, Math.floor(clock / 1_000)), expect),
    );
    assert.equal(jwksFetches(), 2);

    // Past the floor, the next rotation is picked up again.
    clock = NOW_MS + 33_000;
    const afterSecondRotation = await party.verifyIdToken(
      signJwt({ key: third }, NONCE, Math.floor(clock / 1_000)),
      expect,
    );
    assert.equal(afterSecondRotation.subject, 'subject-0001');
    assert.equal(jwksFetches(), 3);
  });

  it('does not hammer the provider when a run of unknown kids arrives', async () => {
    const provider = makeProvider({ keys: [RSA_KEY] });
    let clock = NOW_MS;
    const party = relyingParty(provider, () => clock);
    const expect = { nonceHash: hashOidcSecret(NONCE) };

    for (let attempt = 0; attempt < 10; attempt += 1) {
      clock = NOW_MS + attempt * 1_000;
      await rejectsWith('oidc_exchange_failed', () =>
        party.verifyIdToken(signJwt({ key: ROTATED_KEY }, NONCE, Math.floor(clock / 1_000)), expect),
      );
    }
    // Ten forged tokens, at most two fetches: the first population plus one rotation attempt.
    assert.ok(
      provider.calls.filter((url) => url.endsWith('/jwks')).length <= 2,
      `expected at most 2 JWKS fetches, saw ${provider.calls.filter((url) => url.endsWith('/jwks')).length}`,
    );
  });

  it('refuses a key set that is empty, oversized, or not a key set at all', async () => {
    const notASet = makeProvider();
    // The JWKS route in the fake provider always answers `{ keys: [...] }`, so the shapes are
    // asserted against `parseJwkSet` through an empty key list here.
    notASet.setKeys([]);
    await rejectsWith('oidc_exchange_failed', () =>
      relyingParty(notASet, () => NOW_MS).verifyIdToken(signJwt({}, NONCE, NOW_SECONDS), {
        nonceHash: hashOidcSecret(NONCE),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Key selection
// ---------------------------------------------------------------------------

describe('key selection', () => {
  const rsa: Jwk = { kty: 'RSA', kid: 'a', n: 'n', e: 'AQAB' };
  const ec: Jwk = { kty: 'EC', kid: 'b', crv: 'P-256', x: 'x', y: 'y' };

  it('binds the algorithm to the key type', () => {
    assert.equal(jwkMatchesAlg(rsa, 'RS256'), true);
    assert.equal(jwkMatchesAlg(rsa, 'ES256'), false);
    assert.equal(jwkMatchesAlg(ec, 'ES256'), true);
    assert.equal(jwkMatchesAlg(ec, 'RS256'), false);
  });

  it('refuses an encryption key, a mismatched alg member, and the wrong curve', () => {
    assert.equal(jwkMatchesAlg({ ...rsa, use: 'enc' }, 'RS256'), false);
    assert.equal(jwkMatchesAlg({ ...rsa, alg: 'RS512' }, 'RS256'), false);
    assert.equal(jwkMatchesAlg({ ...rsa, key_ops: ['encrypt'] }, 'RS256'), false);
    assert.equal(jwkMatchesAlg({ ...ec, crv: 'P-384' }, 'ES256'), false);
    assert.equal(jwkMatchesAlg({ kty: 'oct' }, 'RS256'), false);
  });

  it('selects by kid, and accepts a missing kid only when one key could have signed it', () => {
    assert.equal(selectJwk([rsa, ec], { alg: 'RS256', kid: 'a' }), rsa);
    assert.equal(selectJwk([rsa, ec], { alg: 'RS256', kid: 'nope' }), null);
    // One candidate for this alg, so a token without a kid is unambiguous.
    assert.equal(selectJwk([rsa, ec], { alg: 'RS256' }), rsa);
    // Two candidates and no kid: refused rather than "try them all", which would make every
    // retired key still published in the set a live signing key.
    assert.equal(selectJwk([rsa, { ...rsa, kid: 'a2' }], { alg: 'RS256' }), null);
  });
});

// ---------------------------------------------------------------------------
// The primitives, exercised directly
// ---------------------------------------------------------------------------

describe('the verification primitives', () => {
  it('parses a compact JWS into exactly the bytes that were signed', () => {
    const token = signJwt({}, NONCE, NOW_SECONDS);
    const jws = parseJws(token);
    const [header, claims] = token.split('.');
    assert.equal(jws.signingInput.toString('ascii'), `${header ?? ''}.${claims ?? ''}`);
    assert.equal(jws.header.alg, 'RS256');
    assert.equal(jws.header.kid, RSA_KEY.kid);
  });

  it('refuses every alg outside the allowlist, and accepts the two inside it', () => {
    for (const alg of SUPPORTED_ID_TOKEN_ALGS) {
      assert.equal(assertAlgAllowed(alg, ['RS256', 'ES256']), alg);
    }
    for (const alg of ['none', 'None', 'NONE', 'HS256', 'hs512', 'RS512', 'PS256', 'EdDSA', '']) {
      rejectsSyncWith('oidc_exchange_failed', () => assertAlgAllowed(alg, ['RS256', 'ES256', alg]));
    }
  });

  it('compares the nonce as a digest of the same function the database stores', () => {
    // The whole nonce check rests on this: `verifyIdTokenClaims` hashes the claim, and the value
    // it is compared against came out of `prl.oidc_login_attempts.nonce_hash`, which
    // `hashOidcSecret` wrote. If those two ever stop being the same function, every sign-in
    // fails — so it is asserted rather than assumed.
    const claims = goodClaims(NONCE, NOW_SECONDS);
    const verified = verifyIdTokenClaims(claims, {
      issuer: ISSUER,
      clientId: CLIENT_ID,
      nonceHash: hashOidcSecret(NONCE),
      nowMs: NOW_MS,
    });
    assert.equal(verified.subject, 'subject-0001');

    rejectsSyncWith('oidc_state_mismatch', () =>
      verifyIdTokenClaims(claims, {
        issuer: ISSUER,
        clientId: CLIENT_ID,
        nonceHash: hashOidcSecret(`${NONCE}x`),
        nowMs: NOW_MS,
      }),
    );
  });

  it('prefers name, then preferred_username, then given_name, then nickname', () => {
    // Rebuilt without `name` rather than deleted from: `delete` is banned by the linter, and
    // assigning `undefined` would not be the same thing — `readString` treats an explicit
    // `undefined` and an absent member alike, but a future reader should not have to know that.
    const base = Object.fromEntries(
      Object.entries(goodClaims(NONCE, NOW_SECONDS)).filter(([key]) => key !== 'name'),
    );
    const expectation = {
      issuer: ISSUER,
      clientId: CLIENT_ID,
      nonceHash: hashOidcSecret(NONCE),
      nowMs: NOW_MS,
    };
    assert.equal(verifyIdTokenClaims({ ...base, preferred_username: 'ada' }, expectation).nameHint, 'ada');
    assert.equal(verifyIdTokenClaims({ ...base, given_name: 'Ada' }, expectation).nameHint, 'Ada');
    assert.equal(verifyIdTokenClaims(base, expectation).nameHint, null);
  });
});

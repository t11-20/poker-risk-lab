/**
 * The origin this deployment is reached at, as opposed to the address this process listens on.
 *
 * ## The defect this exists to close
 *
 * `proxy.ts` mints a guest session by calling the API server-to-server, and it has to send an
 * `Origin` header because the API checks that header against its exact-match `PUBLIC_WEB_ORIGIN`
 * allowlist on every state-changing request. It used to send `request.nextUrl.origin` — the
 * origin of the URL *this process* received.
 *
 * Behind a reverse proxy those are different values, and the difference is not cosmetic.
 * Measured in a production-configured staging stack: with `Host`, `X-Forwarded-Proto` and
 * `X-Forwarded-Host` all set to `localhost:8443`, the web container still sent
 * `origin: https://localhost:3000` — its own listening address — and the API correctly answered
 * `403 cross-origin POST from an origin that is not allowlisted`. Guest bootstrap was therefore
 * broken behind *any* proxy whose public origin differed from the container's, which is every
 * real deployment. It worked on the development stack only by coincidence, because the proxy
 * happens to publish port 3000 and the web container happens to listen on 3000.
 *
 * It could not be fixed at the proxy — no combination of forwarded headers changed the answer —
 * and it could not be worked around by widening the allowlist, because the API refuses a
 * plaintext `http://` entry in production and the port would still have been wrong.
 *
 * ## Order of preference, and why
 *
 * 1. **`PUBLIC_WEB_ORIGIN`**, read from the live process environment. This is authoritative
 *    because it is *the same variable the API builds its allowlist from*: configuring both from
 *    one value is what makes it impossible for the two to disagree. A comma-separated list takes
 *    its first entry, matching the API's own `safeRedirectTarget`, which treats `webOrigins[0]`
 *    as the canonical one.
 * 2. **`x-forwarded-proto` + `x-forwarded-host`**, when no origin is configured. What the proxy
 *    says it was reached at.
 * 3. **The request's own origin**, which is right when there is no proxy at all, and is what the
 *    development stack uses.
 *
 * ## Why trusting a forwarded header here is safe, when the API refuses to trust one
 *
 * The API deliberately does not believe `X-Forwarded-For` unless `TRUST_PROXY` is set, because a
 * forged address moves somebody else's rate-limit bucket. Nothing comparable is available here.
 * The value produced by this module is sent to the API and then **exact-matched against the
 * allowlist**, so a forged `x-forwarded-host` produces an origin the API rejects: the forger
 * loses their own guest session and gains nothing at all. It is the same reasoning
 * `isSecureRequest` in `proxy.ts` sets out for `x-forwarded-proto`, and the same conclusion.
 *
 * ## Why this is a leaf module
 *
 * No `next/headers`, no `next/server`, no environment read at module scope — the functions take
 * what they need. That is what lets a plain `node --test` file exercise the decision without
 * standing up a server, and it follows `lib/session-cookie-names.ts`, which exists for the same
 * reason.
 */

/** The subset of a request's headers this decision needs. `Headers` satisfies it. */
export interface ForwardedHeaders {
  get(name: string): string | null;
}

/**
 * The first value of a possibly-comma-separated forwarded header.
 *
 * A chain of proxies appends, so `x-forwarded-host` can be `public.example, internal.example`.
 * The **first** entry is the one closest to the browser, which is the one that matters here.
 * Taking the last would name whichever hop is nearest to us, which is precisely the internal
 * address this module exists to stop using.
 */
function firstForwardedValue(headers: ForwardedHeaders, name: string): string | null {
  const raw = headers.get(name);
  if (raw === null) return null;
  const first = raw.split(',')[0]?.trim();
  return first === undefined || first === '' ? null : first;
}

/**
 * Normalises a configured or derived origin to `scheme://host[:port]`, or null if it is not one.
 *
 * Mirrors `normaliseOrigin` in the API's `config.ts` rather than importing it — the two live in
 * different packages and the API's version collects problems for a boot report, which is not the
 * shape this needs. The rules it enforces are the ones that matter for an exact match: a
 * trailing slash, a path, credentials, a query or a wildcard all produce a value that matches
 * nothing, and matching nothing is exactly the failure this module was written to stop.
 */
export function normalisePublicOrigin(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  if (url.search !== '' || url.hash !== '') return null;
  if (url.pathname !== '/' && url.pathname !== '') return null;
  if (url.hostname === '' || url.hostname.includes('*') || url.hostname.endsWith('.')) return null;
  return url.origin.toLowerCase();
}

export interface PublicOriginInput {
  /** The process environment. Injected so a test never has to mutate the real one. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly headers: ForwardedHeaders;
  /** `request.nextUrl.origin` — the address this process was reached at. */
  readonly requestOrigin: string;
}

/**
 * The origin to present to the API as this page's own.
 *
 * Always returns something: falling back to the request's own origin keeps the development
 * stack working with no configuration, and a wrong origin fails closed at the API (a refused
 * guest mint, which `bootstrapGuest` already swallows) rather than failing open.
 */
export function publicOriginFor(input: PublicOriginInput): string {
  const configured = input.env['PUBLIC_WEB_ORIGIN'];
  if (configured !== undefined) {
    for (const candidate of configured.split(',')) {
      const normalised = normalisePublicOrigin(candidate.trim());
      // The first USABLE entry, not simply the first entry: a list whose head is malformed
      // should fall through to a sibling that works rather than silently disabling the whole
      // mechanism, which is the failure mode this module is a fix for.
      if (normalised !== null) return normalised;
    }
  }

  const host = firstForwardedValue(input.headers, 'x-forwarded-host');
  if (host !== null) {
    const proto = firstForwardedValue(input.headers, 'x-forwarded-proto') ?? 'https';
    const derived = normalisePublicOrigin(`${proto}://${host}`);
    if (derived !== null) return derived;
  }

  return normalisePublicOrigin(input.requestOrigin) ?? input.requestOrigin;
}

/**
 * The origin this deployment is reached at, as opposed to the address this process listens on.
 * The guest mint sends it as `Origin`, and the API exact-matches it against `PUBLIC_WEB_ORIGIN`.
 * Sending the container's own address was a 403 behind every real proxy (measured on staging).
 * Preference: `PUBLIC_WEB_ORIGIN`, the variable the API's allowlist is built from, then
 * `x-forwarded-proto` + `x-forwarded-host`, then the request's own origin.
 * Trusting forwarded headers is safe here, because a forged host only gets the forger's mint refused.
 * A leaf module with no `next/*` import and no module-scope env read, so `node --test` drives it.
 */

/** The subset of a request's headers this decision needs. `Headers` satisfies it. */
export interface ForwardedHeaders {
  get(name: string): string | null;
}

/** The first entry, closest to the browser. The last would name the internal hop. */
function firstForwardedValue(headers: ForwardedHeaders, name: string): string | null {
  const raw = headers.get(name);
  if (raw === null) return null;
  const first = raw.split(',')[0]?.trim();
  return first === undefined || first === '' ? null : first;
}

/**
 * `scheme://host[:port]`, or null. Mirrors `normaliseOrigin` in the API's `config.ts`. A trailing
 * slash, path, credentials, query or wildcard would match nothing.
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
  /** `request.nextUrl.origin`, the address this process was reached at. */
  readonly requestOrigin: string;
}

/** Always returns an origin. A wrong one fails closed, as a refused mint that `bootstrapGuest` swallows. */
export function publicOriginFor(input: PublicOriginInput): string {
  const configured = input.env['PUBLIC_WEB_ORIGIN'];
  if (configured !== undefined) {
    for (const candidate of configured.split(',')) {
      const normalised = normalisePublicOrigin(candidate.trim());
      // The first USABLE entry, so a malformed head does not disable the whole mechanism.
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

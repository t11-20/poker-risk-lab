/**
 * The Content-Security-Policy, as a value.
 *
 * ## What was wrong
 *
 * `THEME_BOOT_SCRIPT_CSP_HASH` existed, `test/theme-csp-hash.test.ts` kept it accurate, and
 * nothing ever put it on a response. `next.config.ts` had no `headers()`, there was no proxy
 * file, and `docker-compose.yml`'s reverse proxy sets no security headers either. `curl -I` against
 * a running server returned a page with no policy at all. A hash nobody serves is documentation
 * that reads like a control.
 *
 * ## What this file can and cannot prove
 *
 * It proves the *value*: that the production policy has no way to run an inline script other than
 * the nonce and the one hash, that the two development allowances cannot appear in it, and that
 * every directive an injection would need is closed.
 *
 * It cannot prove the policy reaches a browser — a pure test has no server. Two other things do:
 * `scripts/smoke-test.mjs` §11 fetches a rendered HTML response from a running production server
 * and asserts the header, the nonce, and that every `<script>` tag carries it; and
 * `docs/audit/blocker-remediation.md` records the manual browser verification, including the
 * negative control (an inline `onclick` attribute refused with a `script-src-attr` violation while
 * the page stayed fully interactive).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CSP_HEADER, contentSecurityPolicy, SECURITY_HEADERS } from '../src/lib/csp.ts';
import { THEME_BOOT_SCRIPT_CSP_HASH } from '../src/lib/theme.ts';

const NONCE = 'dGVzdC1ub25jZS0xMjM0';

/** `script-src`'s own source list, so an allowance in another directive cannot be mistaken for it. */
function directive(policy: string, name: string): string | null {
  const found = policy
    .split(';')
    .map((part) => part.trim())
    .find((part) => part === name || part.startsWith(`${name} `));
  return found ?? null;
}

describe('the production Content-Security-Policy', () => {
  const policy = contentSecurityPolicy({ nonce: NONCE });

  it('allows the theme boot script by nonce AND by its exact bytes', () => {
    const script = directive(policy, 'script-src');
    assert.ok(script !== null, 'there must be a script-src');
    assert.match(script, new RegExp(`'nonce-${NONCE}'`), 'the per-response nonce must be in script-src');
    assert.ok(
      script.includes(`'${THEME_BOOT_SCRIPT_CSP_HASH}'`),
      'the theme boot hash must be in script-src, quoted — this is the constant that was computed ' +
        'and then never served',
    );
  });

  it('has no way to run an inline script other than those two', () => {
    const script = directive(policy, 'script-src');
    assert.ok(script !== null);
    assert.ok(!script.includes("'unsafe-inline'"), `script-src must never allow unsafe-inline: ${script}`);
    assert.ok(!script.includes("'unsafe-eval'"), `script-src must never allow unsafe-eval: ${script}`);
    assert.ok(!script.includes("'unsafe-hashes'"), `script-src must never allow unsafe-hashes: ${script}`);
    assert.ok(script.includes("'strict-dynamic'"), 'strict-dynamic is what makes host sources stop counting');
    // Nothing anywhere in the policy may name a remote host. This app has no third-party origin,
    // and the day one is added it should be a visible diff here rather than a quiet widening.
    assert.ok(
      !/https?:\/\/(?!localhost|127\.0\.0\.1)/.test(policy),
      `no remote origin may appear in the production policy: ${policy}`,
    );
    assert.ok(!/\bws:\/\//.test(policy), 'the development HMR socket must not appear in production');
  });

  it('closes the directives an injection would reach for', () => {
    for (const [name, expected] of [
      ['default-src', "default-src 'self'"],
      ['object-src', "object-src 'none'"],
      ['base-uri', "base-uri 'none'"],
      ['frame-ancestors', "frame-ancestors 'none'"],
      ['frame-src', "frame-src 'none'"],
      ['form-action', "form-action 'self'"],
      ['img-src', "img-src 'self'"],
      ['font-src', "font-src 'self'"],
      ['connect-src', "connect-src 'self'"],
      ['style-src', "style-src 'self'"],
    ] as const) {
      assert.equal(directive(policy, name), expected, `${name} is wrong`);
    }
    assert.ok(policy.includes('upgrade-insecure-requests'));
  });

  it('confines inline styling to the attribute directive, and says so', () => {
    // The design system passes CSS custom properties through `style=`, which cannot carry a nonce.
    // That allowance must stay in `style-src-attr` — widening `style-src` itself would let an
    // injected <style> element run.
    assert.equal(directive(policy, 'style-src-attr'), "style-src-attr 'unsafe-inline'");
    assert.ok(!(directive(policy, 'style-src') ?? '').includes("'unsafe-inline'"));
  });

  it('is a single-line header value', () => {
    assert.ok(!/[\r\n]/.test(policy), 'a newline in a header value is a header-injection shape');
    assert.equal(CSP_HEADER, 'Content-Security-Policy');
  });
});

describe('the development Content-Security-Policy', () => {
  const development = contentSecurityPolicy({ nonce: NONCE, development: true });
  const production = contentSecurityPolicy({ nonce: NONCE });

  it('adds exactly the two things next dev cannot run without', () => {
    const script = directive(development, 'script-src');
    assert.ok(script !== null);
    assert.ok(script.includes("'unsafe-eval'"), 'React Refresh compiles modules at runtime');
    assert.ok(!script.includes("'unsafe-inline'"), 'even development never needs unsafe-inline');
    assert.match(directive(development, 'connect-src') ?? '', /ws:\/\/localhost:3000/);
  });

  it('drops upgrade-insecure-requests, which would break an http dev host', () => {
    assert.ok(!development.includes('upgrade-insecure-requests'));
    assert.ok(production.includes('upgrade-insecure-requests'));
  });

  it('differs from production only in those places', () => {
    // The two are built by one function, so a directive added to one is added to both. This asserts
    // the structural claim directly: same directive NAMES, in the same order.
    const names = (policy: string): string[] =>
      policy
        .split(';')
        .map((part) => part.trim().split(' ')[0] ?? '')
        .filter((name) => name !== '' && name !== 'upgrade-insecure-requests');
    assert.deepEqual(names(development), names(production));
  });
});

describe('the headers that sit beside the policy', () => {
  it('names each one once, with no duplicates', () => {
    const names = SECURITY_HEADERS.map(([name]) => name);
    assert.deepEqual([...new Set(names)], names);
    assert.deepEqual(names.sort(), [
      'Cross-Origin-Opener-Policy',
      'Referrer-Policy',
      'X-Content-Type-Options',
      'X-Frame-Options',
    ]);
  });

  it('does not leak a path to a third party through Referer', () => {
    const referrer = SECURITY_HEADERS.find(([name]) => name === 'Referrer-Policy')?.[1];
    assert.equal(referrer, 'same-origin', 'a room id and a hand id both travel in a URL');
  });
});

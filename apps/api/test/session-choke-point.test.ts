/**
 * The claim every authorisation decision in this API rests on: one cookie-to-identity path.
 *
 * ## Why this file exists
 *
 * `apps/api/src/auth/session.ts` opens by stating it:
 *
 *   > This module is the only place that turns the `prl_session` cookie into an identity, and the
 *   > only place that mints or destroys one. Everything else reads `request.session`.
 *
 * That was **prose**. Nothing read the source, and the property is load-bearing in a way few others
 * here are: `resolveSession` is where the signature is checked before the value is touched, where a
 * forged cookie is refused without a query, and where expiry and revocation are enforced — by
 * `findValidByToken`'s `expires_at > now()` and `revoked_at is null`, which live in the SQL and
 * nowhere else. A second path that resolved a token by any other route would be a second set of
 * rules, and the one it skipped would be whichever the author did not know about.
 *
 * This is not hypothetical in this codebase. The socket used to authenticate **once, at upgrade**,
 * and never again — so a connection outlived a sign-out, an account deletion and both TTLs. That
 * bug was a second identity path that did not carry the first one's rules. It was fixed; nothing
 * stops the next one.
 *
 * ## What it asserts
 *
 * The shape the claim implies, at three levels:
 *
 *   * `repositories/sessions.ts` defines `findValidByToken` and exactly one place in `src/` calls
 *     it — the store binding in `routes/auth.ts`;
 *   * exactly one place calls the bound `store.findValidByToken(…)` — `resolveSession`;
 *   * nothing outside `auth/session.ts` and `plugins/security.ts` reads the session cookie at all.
 *
 * `plugins/security.ts` is the one legitimate reader and is exempted deliberately rather than by
 * accident, so the exemption is narrow and its reason is recorded: it never resolves an identity.
 * `rateLimitKeyFor` unsigns the cookie to derive a limiter BUCKET and returns a hash, never a user;
 * the `onSend` hook reads only whether the cookie is PRESENT, to decide `cache-control`. Both were
 * read to confirm that before this exemption was written.
 *
 * A structural read, because the defect is a call site that exists and no request exercises —
 * nothing that runs the code can see a second door that this deployment's tests never open.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** Every `.ts` under `src/`, as `{ path, text }` with comments stripped. */
function sources(): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith('.ts')) continue;
      // Comments are stripped because this repository argues at length, in prose, about the very
      // identifiers being counted — `ws/hub.ts` and `repositories/rooms.ts` both discuss
      // `findValidByToken` without calling it. A parser that reads those finds the call sites it
      // hoped to find, which is a mistake made more than once on this branch.
      const text = readFileSync(full, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//gu, '')
        .replace(/^\s*\/\/.*$/gmu, '');
      out.push({ path: relative(SRC, full), text });
    }
  };
  walk(SRC);
  return out;
}

const FILES = sources();

/** Files containing `needle`, by path. */
const filesWith = (needle: string): string[] =>
  FILES.filter((file) => file.text.includes(needle))
    .map((file) => file.path)
    .sort();

describe('there is one cookie-to-identity path', () => {
  it('read a real set of source files, so a clean result is not an empty scan', () => {
    assert.ok(FILES.length >= 40, `walked ${FILES.length} source file(s); the walk has broken`);
    assert.ok(
      FILES.some((file) => file.path === join('auth', 'session.ts')),
      'auth/session.ts was not among the files walked; every assertion below would be vacuous',
    );
  });

  it('exactly one place calls the repository lookup (REGRESSION)', () => {
    // `sessionsRepository.findValidByToken(sql, token)` is the SQL that enforces expiry and
    // revocation. A second caller is a second place those rules can be got wrong.
    const callers = filesWith('sessionsRepository.findValidByToken(');
    assert.deepEqual(
      callers,
      [join('routes', 'auth.ts')],
      'the repository session lookup is called somewhere new. That call is a second cookie-to-' +
        'identity path, and whichever of expiry, revocation or signature-before-query it does not ' +
        `carry is the one that will be missing: ${callers.join(', ')}`,
    );
  });

  it('exactly one place resolves the bound store lookup (REGRESSION)', () => {
    const callers = filesWith('.findValidByToken(');
    assert.deepEqual(
      callers,
      // Two, not three: `repositories/sessions.ts` DEFINES `findValidByToken` and never calls a
      // bound one, so it does not carry the `.` this matches on. That distinction is the point —
      // the definition is the SQL, and what is being counted here is who invokes it.
      [join('auth', 'session.ts'), join('routes', 'auth.ts')],
      'something other than resolveSession, the store binding and the repository itself now ' +
        `resolves a session token: ${callers.join(', ')}`,
    );
  });

  it('nothing outside the auth module and the security plugin reads the session cookie', () => {
    // The socket is the case worth naming: `ws/hub.ts` deliberately reads `request.session`, which
    // the hook has already resolved, rather than the cookie. Reading the cookie there would be the
    // authenticate-once bug returning in a new shape.
    const readers = filesWith('sessionCookieName(');
    assert.deepEqual(
      readers,
      [join('auth', 'session.ts'), join('plugins', 'security.ts')],
      'a module outside auth/session.ts and plugins/security.ts now reads the session cookie. ' +
        'Everything else must read `request.session`, which the hook has already decided: ' +
        `${readers.join(', ')}`,
    );
  });

  it('the security plugin still only KEYS and CHECKS PRESENCE, never resolves', () => {
    // The exemption above is only safe while this stays true, so it is asserted rather than
    // trusted. `plugins/security.ts` may unsign the cookie — `rateLimitKeyFor` does — but it must
    // never turn the result into a user.
    const security = FILES.find((file) => file.path === join('plugins', 'security.ts'));
    assert.ok(security !== undefined);
    assert.ok(
      !security.text.includes('findValidByToken'),
      'plugins/security.ts now resolves a session token. It is exempted from the cookie-reader ' +
        'check ONLY because it derives a rate-limit bucket and a cache header and never an ' +
        'identity; resolving one there makes that exemption a hole.',
    );
  });

  it('NEGATIVE CONTROL — a second identity path in any of the three shapes is caught', () => {
    const withSecondCaller = [
      ...FILES,
      { path: 'ws/hub.ts', text: 'await sessionsRepository.findValidByToken(sql, t)' },
    ];
    assert.deepEqual(
      withSecondCaller
        .filter((f) => f.text.includes('sessionsRepository.findValidByToken('))
        .map((f) => f.path),
      [join('routes', 'auth.ts'), 'ws/hub.ts'],
      'a second repository caller was not detected',
    );

    const withSecondReader = [
      ...FILES,
      { path: 'routes/rooms.ts', text: 'rawCookie(request, sessionCookieName(config))' },
    ];
    assert.ok(
      withSecondReader.filter((f) => f.text.includes('sessionCookieName(')).length === 3,
      'a second cookie reader was not detected',
    );

    // And the parser must not be fooled by prose, which is how this check would go quiet: several
    // files discuss `findValidByToken` in comments without calling it.
    const commentary = readFileSync(join(SRC, 'ws', 'hub.ts'), 'utf8');
    assert.ok(
      commentary.includes('findValidByToken'),
      'ws/hub.ts no longer mentions findValidByToken; this control is stale',
    );
    assert.ok(
      !FILES.find((file) => file.path === join('ws', 'hub.ts'))?.text.includes('findValidByToken'),
      'the comment stripper failed: ws/hub.ts discusses findValidByToken and does not call it',
    );
  });
});

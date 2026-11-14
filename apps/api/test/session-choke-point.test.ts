/**
 * One cookie-to-identity path, asserted from source. Expiry and revocation live only in
 * `findValidByToken`'s SQL, so a second path would be a second set of rules. A socket that
 * authenticated only at upgrade would outlive sign-out. `plugins/security.ts` is the one exempt
 * cookie reader, because it derives a limiter bucket and checks presence but never resolves a user.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** Comments stripped. */
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
      // `ws/hub.ts` and `repositories/rooms.ts` discuss `findValidByToken` in prose without calling it.
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
      // `repositories/sessions.ts` defines it and calls no bound one, so it lacks the `.` matched here.
      [join('auth', 'session.ts'), join('routes', 'auth.ts')],
      'something other than resolveSession, the store binding and the repository itself now ' +
        `resolves a session token: ${callers.join(', ')}`,
    );
  });

  it('nothing outside the auth module and the security plugin reads the session cookie', () => {
    // `ws/hub.ts` reads `request.session`. Reading the cookie there would authenticate only at upgrade.
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
    // The exemption is only safe while this holds.
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

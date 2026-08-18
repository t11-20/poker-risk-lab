/**
 * The recorded CSP hash for the app's one inline script must equal the script's actual bytes.
 *
 * ## What went wrong, and why a test rather than a corrected number
 *
 * `THEME_BOOT_SCRIPT` is the single inline script this app ships: it applies the reader's stored
 * theme before first paint so that somebody whose system is dark and whose choice is light does not
 * watch the page flash. An inline script needs `script-src` to allow it, and the value that allows
 * it used to live in a prose comment beside the script. The script was then edited and the digits
 * were not, and nothing in the repository could notice — the recorded hash was reviewable but not
 * verifiable. An operator who copied it would have shipped a policy that blocks the one script
 * whose whole job is to prevent the flash, and the page would look fine on every server-side check.
 *
 * Correcting the digits would fix the value and leave the mechanism. This file is the mechanism.
 *
 * ## The independent ground truth
 *
 * The digest is computed here with `node:crypto` over the exported string, and compared against the
 * exported constant. Nothing in `src/lib/theme.ts` participates in producing the expected value:
 * the module supplies the input and the claim, and the platform's own SHA-256 supplies the answer.
 * That independence is the property that matters. A test that called a helper in `theme.ts` to
 * derive the hash would agree with the constant by construction and would have caught nothing —
 * which is precisely the failure mode being closed here.
 *
 * UTF-8 is stated explicitly on the `update` call because it is the encoding a browser hashes the
 * script's bytes in, not merely Node's default.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  BOOT_ATTRIBUTE,
  BOOT_SESSION_KEY,
  BOOT_SKIP,
  THEME_ATTRIBUTE,
  THEME_BOOT_SCRIPT,
  THEME_BOOT_SCRIPT_CSP_HASH,
  THEME_STORAGE_KEY,
} from '../src/lib/theme.ts';

test('the recorded CSP hash matches the exact bytes of THEME_BOOT_SCRIPT', () => {
  const digest = createHash('sha256').update(THEME_BOOT_SCRIPT, 'utf8').digest('base64');

  assert.equal(
    THEME_BOOT_SCRIPT_CSP_HASH,
    `sha256-${digest}`,
    'THEME_BOOT_SCRIPT_CSP_HASH is stale. THEME_BOOT_SCRIPT was edited without regenerating it, ' +
      'so any operator following it ships a CSP that blocks the theme-boot script and reintroduces ' +
      `the flash it exists to prevent. Record the recomputed value: sha256-${digest}`,
  );
});

test('THEME_BOOT_SCRIPT_CSP_HASH is a well-formed script-src source expression', () => {
  // A 32-byte digest is 43 base64 characters plus one '=' of padding. Checking the shape as well as
  // the value means a hand-edit that truncates or mangles the token fails here with a clear reason
  // rather than as an inequality that looks like ordinary drift.
  const match = /^sha256-([A-Za-z0-9+/]{43}=)$/.exec(THEME_BOOT_SCRIPT_CSP_HASH);
  assert.ok(
    match !== null,
    `expected a bare 'sha256-<base64>' token, got ${JSON.stringify(THEME_BOOT_SCRIPT_CSP_HASH)}`,
  );

  const encoded = match[1];
  assert.ok(encoded !== undefined, 'the capture group is present whenever the pattern matched');
  assert.equal(
    Buffer.from(encoded, 'base64').byteLength,
    32,
    'a SHA-256 digest is 32 bytes; a different length means the algorithm label and the payload ' +
      'disagree, which a browser rejects outright',
  );

  // The quotes in `script-src 'sha256-…'` are header syntax and belong to whatever assembles the
  // header. Baking them into the value would double them up at the call site and would break the
  // digest comparison above for a reason unrelated to the script.
  assert.ok(
    !THEME_BOOT_SCRIPT_CSP_HASH.includes("'"),
    'the constant must not carry its own quotes; the code emitting the header adds them',
  );
});

test('THEME_BOOT_SCRIPT stays hashable: fixed bytes, its own keys, no closing-tag sequence', () => {
  // A hash is only meaningful for a script whose bytes are fixed at build time. These are the two
  // properties `src/lib/theme.ts` documents as making that true, asserted rather than asserted-in-
  // prose: the script must read the module's own exported keys (so a rename cannot leave the script
  // pointing at a stale one while the hash still matches), and it must not contain a sequence that
  // would let the HTML parser end the element early.
  for (const constant of [THEME_STORAGE_KEY, BOOT_SESSION_KEY, THEME_ATTRIBUTE, BOOT_ATTRIBUTE, BOOT_SKIP]) {
    assert.ok(
      THEME_BOOT_SCRIPT.includes(constant),
      `THEME_BOOT_SCRIPT must interpolate ${JSON.stringify(constant)} from this module rather than ` +
        'repeat it as a literal, so that renaming the constant cannot leave the script reading a ' +
        'key nothing else writes',
    );
  }

  assert.ok(
    !THEME_BOOT_SCRIPT.toLowerCase().includes('</script'),
    'an inline script containing </script would be terminated early by the HTML parser',
  );
});

/**
 * The recorded CSP hash must equal the inline script's bytes. The digest is computed with `node:crypto`,
 * because a helper shared with `theme.ts` would agree by construction. UTF-8 is what a browser hashes.
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
  // A 32-byte digest is 43 base64 characters plus one '=', so a mangled token fails with a clear reason.
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

  // The quotes in `script-src 'sha256-…'` are header syntax and belong to whatever assembles the header.
  assert.ok(
    !THEME_BOOT_SCRIPT_CSP_HASH.includes("'"),
    'the constant must not carry its own quotes; the code emitting the header adds them',
  );
});

test('THEME_BOOT_SCRIPT stays hashable: fixed bytes, its own keys, no closing-tag sequence', () => {
  // The hash is only meaningful for fixed bytes. The script reads this module's exported keys, and must
  // not contain a sequence that ends the element early.
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

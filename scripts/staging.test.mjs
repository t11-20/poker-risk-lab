import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('staging refreshes nginx after certificate renewal without rebuilding app images', async () => {
  const source = await readFile(new URL('./staging.mjs', import.meta.url), 'utf8');

  assert.match(
    source,
    /const proxyRefresh = compose\(\['up', '-d', '--force-recreate', 'proxy'\]\)/,
    'staging up must recreate the TLS proxy after init renews its bind-mounted certificate',
  );
  assert.match(
    source,
    /Recreate only the proxy so the API\/web containers and\n\s+\/\/ their exact image digests are untouched/,
    'the refresh must remain scoped to the proxy rather than rebuilding or restarting app images',
  );
});

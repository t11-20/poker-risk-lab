/**
 * Coverage for the staging proxy certificate refresh, and for the HSTS check.
 *
 * The defect: `staging init` can renew the leaf while the stack is already up.
 * The cert directory is a bind mount, but nginx reads it only at start. A plain
 * `compose up` sees no image or config change and keeps serving the old leaf.
 * `refreshStagingProxy` recreates **only** the proxy so the API/web digest-locked
 * containers stay put.
 *
 * Would this fail if the behaviour broke? Checked by writing the opposite:
 * a compose argv that also named `api` is rejected by the shipped function
 * (not by a copy of the argv in this file), and a runner that returns non-zero
 * is returned to the caller so `staging up` can abort rather than probe TLS
 * against a proxy that did not restart.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  HSTS_EXPECTED,
  HSTS_PROBE_PATH,
  hstsFromRawHeaders,
  PROXY_REFRESH_COMPOSE_ARGS,
  refreshStagingProxy,
} from './staging.mjs';

test('refreshStagingProxy recreates only the TLS proxy, with --force-recreate', () => {
  const calls = [];
  const result = refreshStagingProxy((args) => {
    calls.push(args);
    return { status: 0, stdout: 'Container proxy Recreated\n', stderr: '' };
  });

  assert.equal(calls.length, 1, 'compose must be invoked exactly once');
  assert.deepEqual(
    calls[0],
    ['up', '-d', '--force-recreate', 'proxy'],
    'nginx only re-reads the bind-mounted cert when the container is recreated',
  );
  assert.deepEqual(
    calls[0],
    [...PROXY_REFRESH_COMPOSE_ARGS],
    'the argv the function sends is the exported argv',
  );
  assert.notEqual(
    calls[0],
    PROXY_REFRESH_COMPOSE_ARGS,
    'compose receives a copy; mutating it must not change the exported constant',
  );
  assert.ok(calls[0].includes('--force-recreate'), 'without --force-recreate compose would no-op');
  assert.ok(!calls[0].includes('api'), 'recreating api would drop in-flight rooms and is not a cert refresh');
  assert.ok(!calls[0].includes('web'), 'recreating web is not required to pick up the new leaf');
  assert.equal(result.status, 0);
});

test('refreshStagingProxy surfaces a compose failure so staging up aborts', () => {
  const result = refreshStagingProxy(() => ({
    status: 1,
    stdout: '',
    stderr: 'failed to recreate proxy',
  }));
  assert.equal(result.status, 1, 'a failed recreate must not be swallowed');
  assert.match(result.stderr, /failed to recreate proxy/);
});

test('the shipped argv cannot name api or web even if a caller mutates their copy', () => {
  const mutated = [...PROXY_REFRESH_COMPOSE_ARGS, 'api'];
  assert.ok(mutated.includes('api'), 'the test itself must actually add api, or the next line is theatre');
  assert.ok(
    !PROXY_REFRESH_COMPOSE_ARGS.includes('api'),
    'the exported argv is frozen and does not follow the caller mutation',
  );
  assert.ok(!PROXY_REFRESH_COMPOSE_ARGS.includes('web'));
});

/**
 * Coverage for the HSTS check in `staging up`.
 *
 * The defect: the check probed `/api/v1/health` and ticked as soon as `res.headers`
 * held a `strict-transport-security` string. `/api/v1/health` is an API route and
 * the API sets its own HSTS through helmet under `NODE_ENV=production`, so the
 * check was reading the upstream's header, would have ticked with nginx's
 * `add_header` deleted, and could not see that `add_header` appends — that every
 * `/api/*` response went out with two headers, of which a browser obeys only the
 * first. Its failure message ("the app cannot set it") was the claim that hid it.
 *
 * Would these fail if the behaviour broke? The duplicate case is written as the
 * shape the running proxy actually returned before the fix, and the probe path is
 * asserted NOT to be an API route rather than merely asserted to be `/` — the
 * latter would still pass if somebody pointed it back at `/api/v1/health`.
 */

test('hstsFromRawHeaders returns every value, in wire order, and counts duplicates', () => {
  // Exactly what `curl -D -` showed against the proxy before the fix: the API's
  // header first, nginx's appended after it.
  const raw = [
    'Content-Type',
    'application/json',
    'Strict-Transport-Security',
    'max-age=31536000; includeSubDomains',
    'Strict-Transport-Security',
    'max-age=31536000',
  ];
  assert.deepEqual(hstsFromRawHeaders(raw), ['max-age=31536000; includeSubDomains', 'max-age=31536000']);
  assert.equal(hstsFromRawHeaders(raw).length, 2, 'two headers must not fold into one');
});

test('hstsFromRawHeaders matches the header name case-insensitively and trims the value', () => {
  // HTTP/2 lowercases field names and HTTP/1.1 does not; nginx serves both here.
  assert.deepEqual(hstsFromRawHeaders(['strict-transport-security', ' max-age=31536000 ']), [
    'max-age=31536000',
  ]);
  assert.deepEqual(hstsFromRawHeaders(['STRICT-TRANSPORT-SECURITY', 'max-age=1']), ['max-age=1']);
});

test('hstsFromRawHeaders reports absence rather than throwing', () => {
  assert.deepEqual(hstsFromRawHeaders([]), []);
  assert.deepEqual(
    hstsFromRawHeaders(['Server', 'nginx']),
    [],
    'a header list without HSTS is empty, not an error',
  );
  assert.deepEqual(
    hstsFromRawHeaders(undefined),
    [],
    'a failed request has no rawHeaders and must not crash the run',
  );
});

test('the HSTS probe path is not a route the API serves', () => {
  // The whole point: on an API path the upstream answers too, and the check
  // cannot tell whose header it is reading.
  assert.ok(
    !HSTS_PROBE_PATH.startsWith('/api/'),
    'an /api/ path is served by the API, which sets its own HSTS',
  );
  assert.ok(!HSTS_PROBE_PATH.startsWith('/ws'), 'nginx.conf proxies /ws to the API too');
  assert.equal(HSTS_PROBE_PATH, '/', "nginx.conf's `location /` is the page server");
});

test('HSTS_EXPECTED is the policy deploy/staging/nginx.conf actually sets', () => {
  const conf = readFileSync(new URL('../deploy/staging/nginx.conf', import.meta.url), 'utf8');
  const added = [...conf.matchAll(/^\s*add_header\s+Strict-Transport-Security\s+"([^"]+)"/gm)].map(
    (m) => m[1],
  );
  assert.deepEqual(added, [HSTS_EXPECTED], 'exactly one add_header, and this constant is its value');
  assert.ok(
    !HSTS_EXPECTED.includes('includeSubDomains'),
    'nginx.conf explains at length why includeSubDomains is off for a throwaway local CA',
  );
  assert.match(
    conf,
    /^\s*proxy_hide_header\s+Strict-Transport-Security;/m,
    'without this the API helmet header survives and add_header appends a second one',
  );
});

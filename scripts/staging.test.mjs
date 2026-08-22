/**
 * Coverage for the staging proxy certificate refresh.
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
import { test } from 'node:test';
import { PROXY_REFRESH_COMPOSE_ARGS, refreshStagingProxy } from './staging.mjs';

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

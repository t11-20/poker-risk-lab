/**
 * Tests for the staging proxy certificate refresh and served-certificate check, the HSTS check, the
 * registry leg and the manifest-matches-checkout refusal.
 *
 * `refreshStagingProxy` recreates only the proxy, because nginx reads the renewed leaf only at start
 * and the digest-locked API and web containers must stay put.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  DIGEST,
  LOCAL_DIGEST_REFERENCE,
  parsePushDigest,
  parseRegistryHost,
  REGISTRY_DIGEST_REFERENCE,
  registryRepoDigests,
  tieManifestToLocalDigest,
} from './registry-digest.mjs';
import {
  CERT_WARN_DAYS,
  deploymentPlan,
  failingFindings,
  HSTS_EXPECTED,
  HSTS_PROBE_PATH,
  hstsFromRawHeaders,
  manifestMatchesCheckout,
  PROXY_REFRESH_COMPOSE_ARGS,
  RELEASE_RECORD_PATHS,
  refreshStagingProxy,
  servedCertificateVerdict,
  statusTlsFindings,
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
    ['up', '-d', '--no-deps', '--force-recreate', 'proxy'],
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
  assert.ok(
    calls[0].includes('--no-deps'),
    'without --no-deps `up proxy` also recreates api and web when their environment changed',
  );
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

// The HSTS check once probed `/api/v1/health`, where the API sets its own header, so it passed with
// nginx's `add_header` deleted and missed that every `/api/*` response carried two headers.

test('hstsFromRawHeaders returns every value, in wire order, and counts duplicates', () => {
  // What `curl -D -` showed against the proxy before the fix.
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
  // HTTP/2 lowercases field names and HTTP/1.1 does not. nginx serves both here.
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

// Registry leg. Each case is a shape measured against a real `registry:2` on 2026-08-25. A
// manifest whose registry block did not verify must still produce `pull_policy: never`.

test('parsePushDigest reads the digest docker push reported, not the one beside it', () => {
  // Verbatim from pushing prl-api to 127.0.0.1:5001.
  const single = [
    '9c7ca5504a19: Pushed',
    'probe: digest: sha256:7d3f6c23454db65db856376e838d1c3a6917a207226877d1759f7a7a142cac17 size: 856',
  ].join('\n');
  assert.equal(
    parsePushDigest(single),
    'sha256:7d3f6c23454db65db856376e838d1c3a6917a207226877d1759f7a7a142cac17',
  );

  // The trailing Info line holds two bare digests that name the local index, not what the registry stored.
  const multi = [
    't1: digest: sha256:fa647fc1e5d5df7d8d923fb6332aab8e78783f8fca1a1394efb4011f68f5a793 size: 1917',
    ' Info -> Not all multiplatform-content is present and only the available single-platform image ' +
      'was pushed',
    '        sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373 -> ' +
      'sha256:fa647fc1e5d5df7d8d923fb6332aab8e78783f8fca1a1394efb4011f68f5a793',
  ].join('\n');
  assert.equal(
    parsePushDigest(multi),
    'sha256:fa647fc1e5d5df7d8d923fb6332aab8e78783f8fca1a1394efb4011f68f5a793',
    'the labelled digest is the registry’s answer; the bare ones are commentary',
  );
});

test('parsePushDigest returns null rather than guessing when there is no digest line', () => {
  assert.equal(parsePushDigest('The push refers to repository [127.0.0.1:5001/prl-api]\ndenied'), null);
  assert.equal(parsePushDigest(''), null);
  assert.equal(parsePushDigest(undefined), null);
  assert.equal(
    parsePushDigest('digest: sha256:not-hex-and-too-short'),
    null,
    'a malformed digest is not a digest, and a caller must fail rather than record it',
  );
});

test('registryRepoDigests reports every digest for one repository, so a disagreement is visible', () => {
  // After a multi-platform push, RepoDigests named the local index digest, which the registry never held.
  const repoDigests = [
    '127.0.0.1:5099/probe@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373',
    'registry@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373',
  ];
  assert.deepEqual(registryRepoDigests(repoDigests, '127.0.0.1:5099', 'probe'), [
    'sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373',
  ]);
  assert.deepEqual(
    registryRepoDigests(repoDigests, '127.0.0.1:5099', 'other'),
    [],
    'a different repository in the same registry must not be read as this one',
  );
  assert.deepEqual(registryRepoDigests(undefined, '127.0.0.1:5001', 'prl-api'), []);
});

test('tieManifestToLocalDigest hashes the bytes rather than comparing two reported digests', () => {
  const bytes = Buffer.from('{"schemaVersion":2,"mediaType":"application/vnd.oci.image.index.v1+json"}');
  // Pinned, not recomputed, so a shared hashing mistake cannot pass.
  const digest = 'sha256:d3e326ca75320da61d7a0abbbb4c24ac2719a2f2fea6029d645ef7a607027c58';
  const tied = tieManifestToLocalDigest(bytes, digest);
  assert.equal(tied.how, 'manifest-digest');
  assert.equal(tied.manifestDigest, digest);

  const other = tieManifestToLocalDigest(bytes, `sha256:${'0'.repeat(64)}`);
  assert.ok('problem' in other, 'bytes that hash to something else are not the artefact');
  assert.match(other.problem, /is not the artefact that was built here/);
});

test('tieManifestToLocalDigest accepts the classic image store, where the local id is the config blob', () => {
  const configDigest = `sha256:${'ab'.repeat(32)}`;
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 2, config: { digest: configDigest } }));
  const tied = tieManifestToLocalDigest(bytes, configDigest);
  assert.equal(
    tied.how,
    'config-digest',
    'on a graphdriver store --iidfile is the config digest, and the manifest names it',
  );
  assert.equal(tied.configDigest, configDigest);
});

test('a registry reference and a local reference are different shapes on purpose', () => {
  const local = 'prl-api@sha256:7d3f6c23454db65db856376e838d1c3a6917a207226877d1759f7a7a142cac17';
  const remote =
    '127.0.0.1:5001/prl-api@sha256:7d3f6c23454db65db856376e838d1c3a6917a207226877d1759f7a7a142cac17';
  assert.ok(LOCAL_DIGEST_REFERENCE.test(local));
  assert.ok(REGISTRY_DIGEST_REFERENCE.test(remote));
  assert.ok(
    !REGISTRY_DIGEST_REFERENCE.test(local),
    'a bare name is not fetchable, and must never be read as a registry reference',
  );
  assert.ok(
    !REGISTRY_DIGEST_REFERENCE.test('127.0.0.1:5001/prl-api:091d67ac39ce'),
    'a tag is a pointer; only a digest reference may be deployed',
  );
  assert.ok(DIGEST.test('sha256:7d3f6c23454db65db856376e838d1c3a6917a207226877d1759f7a7a142cac17'));
});

test('parseRegistryHost tells loopback from everything else, because that decides http vs https', () => {
  assert.equal(parseRegistryHost('127.0.0.1:5001').loopback, true);
  assert.equal(parseRegistryHost('localhost:5001').port, 5001);
  assert.equal(
    parseRegistryHost('registry.example.com:443').loopback,
    false,
    'a non-loopback registry may not be spoken to over plain http',
  );
  assert.ok('problem' in parseRegistryHost('127.0.0.1:5001/prl-api'), 'a repository is not a host');
  assert.ok('problem' in parseRegistryHost(''));
});

// `deploymentPlan` decides `pull_policy`. `always` against a registry that cannot answer costs the
// whole stack, so the negative controls matter most.
const planFixture = () => ({
  images: {
    api: {
      digest: `sha256:${'1'.repeat(64)}`,
      reference: `prl-api@sha256:${'1'.repeat(64)}`,
      registry: {
        host: '127.0.0.1:5001',
        repository: 'prl-api',
        digest: `sha256:${'1'.repeat(64)}`,
        reference: `127.0.0.1:5001/prl-api@sha256:${'1'.repeat(64)}`,
      },
    },
    web: {
      digest: `sha256:${'2'.repeat(64)}`,
      reference: `prl-web@sha256:${'2'.repeat(64)}`,
      registry: {
        host: '127.0.0.1:5001',
        repository: 'prl-web',
        digest: `sha256:${'2'.repeat(64)}`,
        reference: `127.0.0.1:5001/prl-web@sha256:${'2'.repeat(64)}`,
      },
    },
  },
});

test('deploymentPlan deploys the registry references, pull_policy always, when both verify', () => {
  const plan = deploymentPlan(planFixture(), { api: true, web: true });
  assert.equal(plan.pullPolicy, 'always');
  assert.equal(plan.registryBacked, true);
  assert.equal(plan.degraded, false);
  assert.equal(plan.references.api, `127.0.0.1:5001/prl-api@sha256:${'1'.repeat(64)}`);
  assert.equal(plan.references.web, `127.0.0.1:5001/prl-web@sha256:${'2'.repeat(64)}`);
});

test('deploymentPlan falls back to the local digests when the registry does not verify', () => {
  const plan = deploymentPlan(planFixture(), { api: true, web: false });
  assert.equal(plan.pullPolicy, 'never', 'pulling a digest the registry cannot serve fails the whole up');
  assert.equal(plan.references.api, `prl-api@sha256:${'1'.repeat(64)}`, 'both services move together');
  assert.equal(plan.references.web, `prl-web@sha256:${'2'.repeat(64)}`);
  assert.equal(plan.degraded, true, 'the manifest promised something that is not currently true');
});

test('deploymentPlan is exactly the old behaviour on a machine that never had a registry', () => {
  const manifest = planFixture();
  manifest.images.api.registry = undefined;
  manifest.images.web.registry = undefined;
  const plan = deploymentPlan(manifest, { api: null, web: null });
  assert.equal(plan.pullPolicy, 'never');
  assert.equal(plan.registryBacked, false);
  assert.equal(
    plan.degraded,
    false,
    'no registry reference was claimed, so nothing is degraded — this is the common case and it ' +
      'must not print a warning',
  );
  assert.equal(plan.references.api, `prl-api@sha256:${'1'.repeat(64)}`);
});

test('the staging compose file takes its pull policy from PRL_PULL_POLICY and defaults to never', () => {
  const compose = readFileSync(new URL('../docker-compose.staging.yml', import.meta.url), 'utf8');
  const policies = [...compose.matchAll(/^\s*pull_policy:\s*(\S+)\s*$/gm)].map((m) => m[1]);
  assert.equal(
    policies.length,
    2,
    'both application services carry a pull policy, and this test must have found both of them',
  );
  for (const policy of policies) {
    // A pattern, because a `${…}` string literal trips lint and the formatter undoes the escaped form.
    assert.match(
      policy,
      /^\$\{PRL_PULL_POLICY:-never\}$/,
      'one variable for both services — a mixed stack cannot be described by one policy',
    );
  }
  assert.ok(
    !/^\s*pull_policy:\s*always\s*$/m.test(compose),
    'a hard-coded always would pull from Docker Hub for a repository that belongs to somebody else',
  );
  // An .env.staging written before this variable existed gets the safe default.
  assert.match(compose, /\$\{PRL_PULL_POLICY:-never\}/);
  // Compose refuses any pull_policy outside its enum at `up`.
  for (const verified of [true, false]) {
    const { pullPolicy } = deploymentPlan(planFixture(), { api: verified, web: verified });
    assert.ok(
      ['always', 'never'].includes(pullPolicy),
      `deploymentPlan produced ${pullPolicy}, which compose would reject`,
    );
  }
});

// A gitignored manifest from 0b01f90ce510 sat in the checkout 161 commits behind main, with a new
// migration, and `staging up` would have deployed it.

const HEAD = 'a'.repeat(40);
const OLD = '0b01f90ce510759ccc253692a11b179787e9e0db';
const cleanCheckout = (overrides = {}) => ({
  headSha: HEAD,
  behind: 0,
  ahead: 0,
  changedPaths: [],
  ...overrides,
});

test('manifestMatchesCheckout accepts a clean manifest built from HEAD on an unedited checkout', () => {
  assert.deepEqual(manifestMatchesCheckout({ sha: HEAD, dirty: false }, cleanCheckout()), { ok: true });
});

test('manifestMatchesCheckout refuses a manifest from another commit, with the arithmetic', () => {
  const result = manifestMatchesCheckout(
    { sha: OLD, dirty: false },
    cleanCheckout({ behind: 161, ahead: 0 }),
  );
  assert.ok('problem' in result, 'the 2026-11-11 shape: a clean manifest 161 commits stale');
  assert.match(result.problem, /0b01f90ce510/, 'names the commit the images are');
  assert.match(result.problem, /aaaaaaaaaaaa/, 'names the commit the checkout is');
  assert.match(result.problem, /161 commit\(s\) past it/, 'says how far apart they are');
  assert.match(result.problem, /pnpm run release:artifacts/, 'says how to fix it');
});

test('manifestMatchesCheckout refuses a commit it cannot count, and says it cannot', () => {
  const result = manifestMatchesCheckout(
    { sha: OLD, dirty: false },
    cleanCheckout({ behind: null, ahead: null }),
  );
  assert.ok('problem' in result);
  assert.match(result.problem, /not in this clone's history/);
});

test('manifestMatchesCheckout refuses a branch the checkout has diverged from, naming both sides', () => {
  const result = manifestMatchesCheckout({ sha: OLD, dirty: false }, cleanCheckout({ behind: 3, ahead: 2 }));
  assert.ok('problem' in result);
  assert.match(result.problem, /3 commit\(s\) past it and it is 2 commit\(s\) HEAD does not have/);
});

test('manifestMatchesCheckout refuses a manifest that names no commit', () => {
  for (const commit of [null, undefined, {}, { sha: null }, { sha: '' }]) {
    const result = manifestMatchesCheckout(commit, cleanCheckout());
    assert.ok('problem' in result, `${JSON.stringify(commit)} cannot be shown to describe HEAD`);
  }
});

test('manifestMatchesCheckout refuses when git cannot say what HEAD is', () => {
  const result = manifestMatchesCheckout({ sha: HEAD, dirty: false }, cleanCheckout({ headSha: null }));
  assert.ok('problem' in result, 'an unknown HEAD is not a match, it is the absence of a check');
});

test('manifestMatchesCheckout refuses a clean manifest once files have been edited', () => {
  const result = manifestMatchesCheckout(
    { sha: HEAD, dirty: false },
    cleanCheckout({ changedPaths: ['apps/api/src/config.ts', 'README.md'] }),
  );
  assert.ok('problem' in result, 'the edits postdate the build, so the images do not contain them');
  assert.match(
    result.problem,
    /2 file\(s\) are uncommitted since \(apps\/api\/src\/config\.ts, README\.md\)/,
  );
});

test('manifestMatchesCheckout refuses a clean manifest beside an untracked migration (REGRESSION)', () => {
  // Untracked files count, or a new uncommitted migration reaches staging under older images.
  const result = manifestMatchesCheckout(
    { sha: HEAD, dirty: false },
    cleanCheckout({ changedPaths: ['db/migrations/0008_new.sql'] }),
  );
  assert.ok('problem' in result, 'an uncommitted migration is a change the images do not contain');
  assert.match(result.problem, /db\/migrations\/0008_new\.sql/);
});

test('manifestMatchesCheckout refuses a clean manifest when git status gave no answer (REGRESSION)', () => {
  // An unknown change count is refused.
  const result = manifestMatchesCheckout({ sha: HEAD, dirty: false }, cleanCheckout({ changedPaths: null }));
  assert.ok('problem' in result, 'unknown is not clean');
  assert.match(result.problem, /`git status` gave no answer/);
});

test('manifestMatchesCheckout accepts HEAD past the build by release records alone (REGRESSION)', () => {
  // Committing the signature record moves HEAD one commit past the build, and that must still deploy.
  const signed = cleanCheckout({
    headSha: HEAD,
    behind: 1,
    ahead: 0,
    committedSince: ['deploy/staging/release-signatures.json'],
  });
  assert.deepEqual(manifestMatchesCheckout({ sha: OLD, dirty: false }, signed), { ok: true });
  const both = cleanCheckout({ behind: 2, ahead: 0, committedSince: [...RELEASE_RECORD_PATHS] });
  assert.deepEqual(manifestMatchesCheckout({ sha: OLD, dirty: false }, both), { ok: true });
});

test('manifestMatchesCheckout still refuses a HEAD past the build by anything else', () => {
  const cases = [
    [
      'a code change beside the record',
      { committedSince: ['deploy/staging/release-signatures.json', 'apps/api/src/app.ts'] },
    ],
    ['a migration', { committedSince: ['db/migrations/0009_next.sql'] }],
    ['a diff git would not produce', { committedSince: null }],
    ['an empty diff', { committedSince: [] }],
    ['a diverged branch', { ahead: 1, committedSince: ['deploy/staging/release-signatures.json'] }],
    [
      'a count git would not produce',
      { behind: null, committedSince: ['deploy/staging/release-signatures.json'] },
    ],
  ];
  for (const [name, overrides] of cases) {
    const result = manifestMatchesCheckout(
      { sha: OLD, dirty: false },
      cleanCheckout({ behind: 1, ahead: 0, ...overrides }),
    );
    assert.ok('problem' in result, `${name} is refused`);
  }
});

test('a DIRTY manifest gets no release-record exception (REGRESSION)', () => {
  // A build with an uncommitted edit, reverted before the record commit, still carries the edit.
  for (const dirty of [true, null, undefined]) {
    const result = manifestMatchesCheckout(
      { sha: OLD, dirty },
      cleanCheckout({ behind: 1, ahead: 0, committedSince: ['deploy/staging/release-signatures.json'] }),
    );
    assert.ok('problem' in result, `dirty: ${String(dirty)} deploys only from the commit it was built on`);
  }
});

test('release records past the build still have to be committed', () => {
  const result = manifestMatchesCheckout(
    { sha: OLD, dirty: false },
    cleanCheckout({
      behind: 1,
      ahead: 0,
      committedSince: ['deploy/staging/release-signatures.json'],
      changedPaths: ['apps/web/src/app/page.tsx'],
    }),
  );
  assert.ok('problem' in result, 'an uncommitted edit is still refused on top of a release-record commit');
});

test('the checkout probe counts untracked files and leaves out only release-images/', () => {
  const source = readFileSync(new URL('./staging.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('function probeCheckout(');
  assert.ok(start > 0, 'probeCheckout must exist for this check to mean anything');
  const body = source.slice(start, source.indexOf('\n}\n', start));
  assert.match(body, /'--untracked-files=all'/, 'untracked files are counted');
  assert.doesNotMatch(body, /untracked-files=no/, 'and not switched off');
  assert.match(
    body,
    /':\(exclude\)release-images'/,
    'the release workflow image tarballs are the one exception',
  );
});

test('manifestMatchesCheckout still lets a dirty build of HEAD be rehearsed', () => {
  assert.deepEqual(
    manifestMatchesCheckout(
      { sha: HEAD, dirty: true },
      cleanCheckout({ changedPaths: ['a', 'b', 'c', 'd'] }),
    ),
    { ok: true },
  );
});

test('staging up asks manifestMatchesCheckout before it touches the registry or .env.staging', () => {
  const source = readFileSync(new URL('./staging.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('async function commandUp(');
  assert.ok(start > 0, 'commandUp must exist for this ordering check to mean anything');
  const body = source.slice(start, source.indexOf('\n}\n', start));
  const read = body.indexOf('readManifest(');
  const check = body.indexOf('manifestMatchesCheckout(');
  const registry = body.indexOf('verifyRegistryCopies(');
  const write = body.indexOf('writeEnvFile(');
  assert.ok(read > 0 && registry > 0 && write > 0, 'the landmarks this test orders against are present');
  assert.ok(check > read, 'commandUp calls manifestMatchesCheckout after reading the manifest');
  assert.ok(check < registry && check < write, 'and refuses before the network or the env file');
});

const CERT_NOW = Date.parse('2026-11-14T00:00:00Z');
const PREVIOUS_LEAF = { fingerprint256: 'AA:01', validTo: 'Nov 20 18:55:01 2026 GMT' };
const RENEWED_LEAF = { fingerprint256: 'BB:02', validTo: 'Feb 11 02:43:48 2027 GMT' };
const served = (cert, authorized = true, authorizationError = null) => ({
  ...cert,
  authorized,
  authorizationError,
});
const levels = (findings) => findings.map((f) => `${f.level}: ${f.line}`);

test('a proxy still serving the previous leaf and CA after init is two failures, not a warning', () => {
  const findings = servedCertificateVerdict({
    served: served(PREVIOUS_LEAF, false, 'SELF_SIGNED_CERT_IN_CHAIN'),
    disk: RENEWED_LEAF,
    now: CERT_NOW,
  });
  assert.deepEqual(levels(findings), [
    'cross: the proxy serves a different certificate from deploy/staging/tls/staging-cert.pem',
    'cross: the served chain does not verify against deploy/staging/tls/staging-ca.pem',
    'bang: the served certificate expires in 6 day(s)',
  ]);
  assert.match(findings[0].detail, /staging refresh-tls/, 'the failure names the command that fixes it');
  assert.doesNotMatch(
    findings[2].detail,
    /staging init/,
    'the leaf is already renewed; init again would mint a third CA',
  );
});

test('the served certificate, not the file, decides the expiry warning', () => {
  const findings = servedCertificateVerdict({
    served: served(PREVIOUS_LEAF),
    disk: PREVIOUS_LEAF,
    now: CERT_NOW,
  });
  assert.deepEqual(levels(findings), ['bang: the served certificate expires in 6 day(s)']);
  assert.ok(6 < CERT_WARN_DAYS, 'six days must sit inside the warning window for this case to mean anything');
});

test('the certificate on disk, served and verified, is one tick', () => {
  const findings = servedCertificateVerdict({
    served: served(RENEWED_LEAF),
    disk: RENEWED_LEAF,
    now: CERT_NOW,
  });
  assert.deepEqual(levels(findings), ['tick: the proxy serves the certificate on disk']);
  assert.match(findings[0].detail, /89 day\(s\)/);
});

test('an expired served certificate fails even when it matches the file', () => {
  const findings = servedCertificateVerdict({
    served: served(PREVIOUS_LEAF),
    disk: PREVIOUS_LEAF,
    now: Date.parse('2026-11-22T00:00:00Z'),
  });
  assert.deepEqual(levels(findings), ['cross: the served certificate expired 2 day(s) ago']);
});

test('no handshake is a failure, never a silent pass', () => {
  const findings = servedCertificateVerdict({
    served: { problem: 'connect ECONNREFUSED' },
    disk: RENEWED_LEAF,
    now: CERT_NOW,
  });
  assert.deepEqual(levels(findings), ['cross: could not read the certificate the proxy serves']);
});

const STAGING_ORIGIN = { origin: 'https://localhost:8443', hostname: 'localhost', port: '8443' };
const neverCalled = () => {
  throw new Error('no handshake may be attempted here');
};

test('an unusable origin with the proxy running is a failure, not a skipped check', async () => {
  const findings = await statusTlsFindings({
    proxyRunning: true,
    origin: { problem: '"http://localhost:8443" must be https' },
    handshake: neverCalled,
    disk: RENEWED_LEAF,
    now: CERT_NOW,
  });
  assert.deepEqual(failingFindings(findings), [
    'PRL_STAGING_PUBLIC_ORIGIN is unusable, so the served certificate was not checked — "http://localhost:8443" must be https',
  ]);
});

test('no running proxy means no TLS finding and no handshake', async () => {
  const findings = await statusTlsFindings({
    proxyRunning: false,
    origin: STAGING_ORIGIN,
    handshake: neverCalled,
    disk: RENEWED_LEAF,
    now: CERT_NOW,
  });
  assert.equal(findings, null);
  assert.deepEqual(failingFindings(findings), []);
});

test('the JSON path fails on the same findings the printed path fails on', async () => {
  const findings = await statusTlsFindings({
    proxyRunning: true,
    origin: STAGING_ORIGIN,
    handshake: async () => served(PREVIOUS_LEAF, false, 'SELF_SIGNED_CERT_IN_CHAIN'),
    disk: RENEWED_LEAF,
    now: CERT_NOW,
  });
  const failures = failingFindings(findings);
  assert.equal(failures.length, 2, 'the stale leaf and the unverifiable chain each fail the command');
  assert.ok(
    findings.some((f) => f.level === 'bang'),
    'the expiry warning is present',
  );
  assert.ok(
    failures.every((line) => !line.includes('expires in')),
    'a warning never fails the command, in either output mode',
  );
});

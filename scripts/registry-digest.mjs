/**
 * The registry half of "build once, promote the same bytes".
 *
 * `scripts/release-artifacts.mjs` builds an image and records the digest
 * BuildKit's exporter assigned in the LOCAL image store. That is a content
 * address and it is honest, but it names bytes that exist on one machine, which
 * is why "cannot be promoted across machines" sat in
 * `docs/production/final-readiness-report.md` as an open residual. This module is
 * what turns that local digest into a fetchable one: it pushes to a registry,
 * reads back the digest the REGISTRY assigned, and then proves — rather than
 * asserts — that the two name the same artefact.
 *
 * It is a library. `release-artifacts.mjs` uses it on the push side,
 * `staging.mjs` on the verify-and-promote side, and `staging.test.mjs` drives the
 * pure functions with the exact outputs that were measured against a real
 * `registry:2`.
 *
 * ## Why the digest is fetched over HTTP here rather than asked of docker
 *
 * `docker image inspect --format '{{.RepoDigests}}'` is the obvious way to learn
 * what a push produced, and it can be wrong. Measured, 2026-08-25, pushing the
 * multi-architecture `registry:2` image to a local registry:
 *
 *     $ docker push 127.0.0.1:5099/probe:t1
 *     t1: digest: sha256:fa647fc1e5d5…f5a793 size: 1917
 *      Info -> Not all multiplatform-content is present and only the available
 *              single-platform image was pushed
 *     $ docker image inspect 127.0.0.1:5099/probe:t1 --format '{{json .RepoDigests}}'
 *     ["127.0.0.1:5099/probe@sha256:a3d8aaa63ed8…415373", …]
 *
 * The registry holds `fa647fc1…`; `RepoDigests` reports `a3d8aaa6…`, the digest of
 * the local multi-platform index, which that registry has never seen. A pipeline
 * that recorded the inspect value would have written a reference that resolves to
 * nothing on the machine it was promoted to — the exact failure a registry digest
 * is supposed to remove. So the push output is the authority, `RepoDigests` is
 * cross-checked against it, and a disagreement is a failure rather than a pick.
 *
 * And because "the registry said so" is still somebody's word, `fetchManifest`
 * pulls the manifest bytes back and the caller hashes them: a registry digest is
 * defined as the sha256 of exactly those bytes, so recomputing it locally is a
 * check nobody has to trust.
 *
 * ## What this cannot do
 *
 * Signatures. This module does not sign, verify or attest anything — that is
 * `scripts/image-signing.mjs` and `scripts/supply-chain/image-provenance.mjs`, added
 * 2026-08-25, and this paragraph used to say cosign was not installed at all.
 * What a push here buys, on its own, is CONTENT IDENTITY across a push/pull
 * boundary — the property that another machine asking for `repo@sha256:X` gets
 * those bytes or an error, never different bytes. Who built them, on what, from
 * which source, and whether anybody vouches for them are provenance questions,
 * and they need a signing tool in CI. Nothing here should be read as claiming
 * otherwise.
 */

import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

/** An OCI content digest. */
export const DIGEST = /^sha256:[0-9a-f]{64}$/;

/**
 * A local, registry-less digest reference: `prl-api@sha256:…`. This is what
 * `release-artifacts.mjs` has always recorded and what a machine with no registry
 * still deploys.
 */
export const LOCAL_DIGEST_REFERENCE = /^[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$/;

/**
 * A registry digest reference: `127.0.0.1:5001/prl-api@sha256:…`.
 *
 * Written as its own pattern rather than by loosening `LOCAL_DIGEST_REFERENCE`,
 * because the two mean different things downstream: one is `pull_policy: never`
 * and the other is `pull_policy: always`, and a regex that accepted both would
 * make that decision unreadable. The host part allows a port; the path part is
 * the usual lowercase repository grammar.
 */
export const REGISTRY_DIGEST_REFERENCE =
  /^[a-z0-9][a-z0-9.-]*(?::[0-9]{1,5})?\/[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$/;

/**
 * Where `--push` pushes unless told otherwise, and the port
 * `deploy/registry/docker-compose.registry.yml` publishes.
 *
 * 5001 rather than the conventional 5000 because macOS AirPlay Receiver holds
 * 5000 (`lsof -nP -iTCP:5000 -sTCP:LISTEN` → ControlCenter), and a registry
 * published there fails a push with somebody else's 403.
 */
export const DEFAULT_REGISTRY = '127.0.0.1:5001';

/** Hostnames docker itself treats as insecure-by-default, so plain HTTP works. */
function isLoopbackHostname(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

/**
 * Splits `host[:port]` and says whether it is loopback.
 *
 * `loopback` is not decoration: it decides whether this module talks HTTP or
 * HTTPS, and it is the same rule docker applies when deciding whether a registry
 * may be plain HTTP. A non-loopback registry over plain HTTP is a registry
 * anybody on the path can rewrite, and neither docker nor this module will do it.
 */
export function parseRegistryHost(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return { problem: 'the registry host is empty' };
  const host = raw.trim();
  if (host.includes('/')) {
    return { problem: `"${host}" is a host, not a repository — drop everything from the first "/"` };
  }
  const match = /^([A-Za-z0-9._-]+|\[[0-9a-fA-F:]+\])(?::([0-9]{1,5}))?$/.exec(host);
  if (match === null) return { problem: `"${host}" is not a host[:port]` };
  const hostname = (match[1] ?? '').replace(/^\[|\]$/g, '');
  const port = match[2] === undefined ? null : Number(match[2]);
  if (port !== null && (port < 1 || port > 65535)) return { problem: `port ${port} is not a port` };
  return { host, hostname, port, loopback: isLoopbackHostname(hostname) };
}

/** `127.0.0.1:5001/prl-api@sha256:…` — what compose and `docker pull` take. */
export function registryReference(host, repository, digest) {
  return `${host}/${repository}@${digest}`;
}

/** `127.0.0.1:5001/prl-api:091d67ac39ce` — a name a human can type; never the identity. */
export function registryTagReference(host, repository, tag) {
  return `${host}/${repository}:${tag}`;
}

/**
 * The digest `docker push` reported, from its own output.
 *
 * The line is `<tag>: digest: sha256:<64 hex> size: <n>`, printed once per pushed
 * reference. The LAST one is taken: a multi-platform push prints an additional
 * informational line containing two bare digests and no `digest:` label, and
 * taking the last labelled value is what keeps the two apart. Returning null
 * rather than guessing is deliberate — the caller fails loudly, because a push
 * whose digest could not be read is a push whose result nobody knows.
 */
export function parsePushDigest(output) {
  const matches = [...String(output ?? '').matchAll(/\bdigest:\s*(sha256:[0-9a-f]{64})\b/g)];
  const last = matches.at(-1);
  return last === undefined ? null : (last[1] ?? null);
}

/**
 * Every digest `RepoDigests` carries for one host/repository.
 *
 * Returns a list, not a value, because the answer being anything other than
 * exactly one digest is itself information the caller must act on — see the
 * module header for the measured case where it names a digest the registry does
 * not hold.
 */
export function registryRepoDigests(repoDigests, host, repository) {
  const prefix = `${host}/${repository}@`;
  const list = Array.isArray(repoDigests) ? repoDigests : [];
  return list
    .filter((entry) => typeof entry === 'string' && entry.startsWith(prefix))
    .map((entry) => entry.slice(prefix.length))
    .filter((digest) => DIGEST.test(digest));
}

/** The sha256 of some bytes, in `sha256:…` form. */
export function digestOf(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/**
 * Ties manifest bytes fetched from a registry to the digest the local build
 * recorded — the check that makes "the registry has the same artefact" a
 * measurement rather than a claim.
 *
 * There are two ways for it to hold, and which one applies depends on the local
 * image store rather than on anything about the artefact:
 *
 *   * **containerd image store** (what this project's machines run, and what
 *     `RepoDigests` on a never-pushed image reveals): `--iidfile` and
 *     `docker image inspect '{{.Id}}'` report the digest of the image's MANIFEST.
 *     The registry stores those same bytes, so `sha256(manifest) === localDigest`.
 *   * **classic graph driver store**: the local id is the digest of the image
 *     CONFIG blob instead. The registry manifest names that blob in
 *     `.config.digest`, so the tie is `manifest.config.digest === localDigest`.
 *
 * Both are content addresses and either is proof. What is NOT proof — and what an
 * earlier sketch of this function did — is comparing the local digest to the
 * digest the registry reported and calling equality "verified": that compares two
 * numbers docker printed, and never touches the bytes either one names.
 */
export function tieManifestToLocalDigest(bytes, localDigest) {
  if (!DIGEST.test(String(localDigest))) return { problem: `${String(localDigest)} is not a digest` };
  const manifestDigest = digestOf(bytes);
  if (manifestDigest === localDigest) {
    return { how: 'manifest-digest', manifestDigest, configDigest: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch (err) {
    return { problem: `the registry manifest is not JSON: ${err.message}`, manifestDigest };
  }
  const configDigest = typeof parsed?.config?.digest === 'string' ? parsed.config.digest : null;
  if (configDigest !== null && configDigest === localDigest) {
    return { how: 'config-digest', manifestDigest, configDigest };
  }
  return {
    problem:
      'the manifest the registry serves neither hashes to the local digest nor names it as its config ' +
      `blob. registry manifest ${manifestDigest}, its config ${
        configDigest ?? '(none — this is an ' + 'index, so the push converted a multi-platform image)'
      }, local build ${localDigest}. The ` +
      'artefact in the registry is not the artefact that was built here.',
    manifestDigest,
    configDigest,
  };
}

/** Every media type a v2 registry may answer a manifest request with. */
const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

/**
 * GETs `/v2/<repository>/manifests/<reference>` and returns the RAW bytes.
 *
 * Raw, not parsed, and that is the entire point: the caller hashes them. Parsing
 * and re-serialising would change the bytes and destroy the only property being
 * checked. `node:http` rather than `fetch` for the same reason — this needs the
 * body exactly as it arrived, and a status code even when the body is an error.
 *
 * No credentials are sent. A registry that answers 401 is reported as such rather
 * than retried with a token flow this module does not implement; the caller then
 * downgrades the independent verification to "not performed" and says so, which
 * is the honest outcome and not a pass.
 */
export function fetchManifest({ host, repository, reference, timeoutMs = 10_000 }) {
  const parsed = parseRegistryHost(host);
  if ('problem' in parsed) return Promise.resolve({ status: 0, bytes: null, error: parsed.problem });
  const requestFn = parsed.loopback ? httpRequest : httpsRequest;
  const port = parsed.port ?? (parsed.loopback ? 5000 : 443);
  const path = `/v2/${repository}/manifests/${reference}`;
  return new Promise((resolveCall) => {
    const req = requestFn(
      {
        method: 'GET',
        host: parsed.hostname,
        port,
        path,
        headers: { accept: MANIFEST_ACCEPT },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const bytes = Buffer.concat(chunks);
          resolveCall({
            status: res.statusCode ?? 0,
            bytes,
            digest: digestOf(bytes),
            // The registry's own opinion of the digest. Recorded for a reader and
            // never trusted: `digest` above is computed from the bytes.
            reportedDigest: String(res.headers['docker-content-digest'] ?? '') || null,
            contentType: String(res.headers['content-type'] ?? '') || null,
            error: null,
          });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`no answer from ${host} within ${timeoutMs}ms`)));
    req.on('error', (err) => resolveCall({ status: 0, bytes: null, digest: null, error: err.message }));
    req.end();
  });
}

/**
 * The whole verification, in one call: does `host/repository@digest` exist in the
 * registry, do its bytes hash to that digest, and do they tie to `localDigest`?
 *
 * `localDigest` is optional because the two callers know different things.
 * `release-artifacts.mjs` has just built the image and can tie the manifest to
 * it; `staging.mjs promote` may be running on a machine that never had the image
 * at all, where the answerable question is only "does the registry still serve
 * these exact bytes under this exact digest".
 */
export async function verifyRegistryDigest({ host, repository, digest, localDigest = null }) {
  if (!DIGEST.test(String(digest))) return { ok: false, problem: `${String(digest)} is not a digest` };
  const answer = await fetchManifest({ host, repository, reference: digest });
  if (answer.error !== null && answer.status === 0) {
    return {
      ok: false,
      status: 0,
      problem:
        `${host} did not answer for ${repository}@${digest}: ${answer.error}. Start the registry with ` +
        '`docker compose -f deploy/registry/docker-compose.registry.yml up -d`.',
    };
  }
  if (answer.status === 401 || answer.status === 403) {
    return {
      ok: false,
      status: answer.status,
      unauthenticated: true,
      problem:
        `${host} answered ${answer.status} for ${repository}@${digest}. This check sends no ` +
        'credentials and deliberately implements no token flow, so it cannot verify a registry that ' +
        'requires authentication; the push digest and the pull-back are what stand in that case.',
    };
  }
  if (answer.status !== 200) {
    return {
      ok: false,
      status: answer.status,
      problem:
        `${host} answered ${answer.status} for ${repository}@${digest} — the registry does not hold ` +
        'that digest. A reference nobody can resolve is worse than no reference: it promises a ' +
        'cross-machine pull that will fail on the machine that needs it.',
    };
  }
  if (answer.digest !== digest) {
    return {
      ok: false,
      status: 200,
      problem:
        `${host} served bytes under ${digest} that hash to ${answer.digest}. A registry is defined by ` +
        'this not happening; treat the registry, or what is in front of it, as compromised.',
    };
  }
  if (localDigest === null) {
    return { ok: true, status: 200, digest, manifestDigest: answer.digest, tie: null };
  }
  const tie = tieManifestToLocalDigest(answer.bytes, localDigest);
  if ('problem' in tie) return { ok: false, status: 200, problem: tie.problem };
  return { ok: true, status: 200, digest, manifestDigest: answer.digest, tie: tie.how };
}

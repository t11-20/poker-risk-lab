/**
 * The registry half of "build once, promote the same bytes". Pushes an image, reads the digest the
 * registry assigned, and proves it names the same artefact as the local build by hashing the fetched
 * manifest bytes. It gives content identity across a push/pull, not provenance or signatures.
 * Used by `release-artifacts.mjs` (push) and `staging.mjs` (verify and promote).
 *
 * `docker image inspect '{{.RepoDigests}}'` can be wrong. A measured multi-platform push
 * printed `sha256:fa647fc1…` while `RepoDigests` named `a3d8aaa6…`, an index the registry never saw.
 * So the push output is the authority, and `RepoDigests` must agree with it.
 */

import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

export const DIGEST = /^sha256:[0-9a-f]{64}$/;

export const LOCAL_DIGEST_REFERENCE = /^[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$/;

// A separate pattern because the two mean different things downstream, `pull_policy: never` for the
// local one and `pull_policy: always` for this one.
export const REGISTRY_DIGEST_REFERENCE =
  /^[a-z0-9][a-z0-9.-]*(?::[0-9]{1,5})?\/[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$/;

// 5001 rather than 5000, because macOS AirPlay Receiver holds 5000 and answers a push with a 403.
export const DEFAULT_REGISTRY = '127.0.0.1:5001';

function isLoopbackHostname(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

// `loopback` decides HTTP or HTTPS, the same rule docker applies. Plain HTTP to a non-loopback
// registry lets anyone on the path rewrite it.
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

export function registryReference(host, repository, digest) {
  return `${host}/${repository}@${digest}`;
}

// A name a human can type, never the identity.
export function registryTagReference(host, repository, tag) {
  return `${host}/${repository}:${tag}`;
}

// The line is `<tag>: digest: sha256:<64 hex> size: <n>`. The last labelled one is taken, because a
// multi-platform push adds a line with two unlabelled digests. Null means the caller fails.
export function parsePushDigest(output) {
  const matches = [...String(output ?? '').matchAll(/\bdigest:\s*(sha256:[0-9a-f]{64})\b/g)];
  const last = matches.at(-1);
  return last === undefined ? null : (last[1] ?? null);
}

// A list, because anything other than exactly one digest is a failure the caller must report.
export function registryRepoDigests(repoDigests, host, repository) {
  const prefix = `${host}/${repository}@`;
  const list = Array.isArray(repoDigests) ? repoDigests : [];
  return list
    .filter((entry) => typeof entry === 'string' && entry.startsWith(prefix))
    .map((entry) => entry.slice(prefix.length))
    .filter((digest) => DIGEST.test(digest));
}

export function digestOf(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/**
 * Ties fetched manifest bytes to the local build digest. With the containerd image store the local
 * digest is the manifest's sha256. With the classic store it is the config blob, named in
 * `.config.digest`. Comparing two digests docker printed is not proof, because neither touches the bytes.
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

const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

/**
 * GETs `/v2/<repository>/manifests/<reference>` and returns the raw bytes, which the caller hashes.
 * `node:http` rather than `fetch`, to get the body exactly as it arrived. No credentials are sent;
 * a 401 is reported, and the caller records the verification as not performed.
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
            // Recorded for a reader, never trusted. `digest` is computed from the bytes.
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

// `localDigest` is optional because `staging.mjs promote` may run where the image was never built.
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

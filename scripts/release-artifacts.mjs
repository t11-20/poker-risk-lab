#!/usr/bin/env node
/**
 * Builds the two release images once and records their content digests (`pnpm run release:artifacts`);
 * `--help` lists the options. This is the only place an image is built.
 * The local digest is BuildKit's content address, the same as `--iidfile` and `{{.Id}}`. `--push`
 * also records the registry digest and proves both name the same bytes (see `registry-digest.mjs`).
 * Nothing here signs. That is `pnpm run release:sign`, which holds the private key.
 *
 * Refusing to rebuild a commit with a valid manifest exits 0. The release path chains
 * `release:artifacts && security:containers && staging up`, and exit 1 there would teach `--force`.
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_REGISTRY,
  parsePushDigest,
  parseRegistryHost,
  registryReference,
  registryRepoDigests,
  registryTagReference,
  verifyRegistryDigest,
} from './registry-digest.mjs';
import { MUST_BE_IGNORED, NEVER_TRACKED } from './supply-chain/secret-scan.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const NO_COLOR = process.env.NO_COLOR !== undefined || !process.stdout.isTTY;
const paint = (code, s) => (NO_COLOR ? s : `\u001b[${code}m${s}\u001b[0m`);
const dim = (s) => paint('2', s);
const bold = (s) => paint('1', s);
const red = (s) => paint('31', s);
const green = (s) => paint('32', s);
const yellow = (s) => paint('33', s);

// Module scope so `pushAll` can reach `tick` and `cross`. `failures` decides the exit code and
// whether a manifest is written.
const failures = [];
const tick = (line, detail) => {
  console.log(`${green('  ✓')} ${line}`);
  if (detail) console.log(dim(`      ${detail}`));
};
const cross = (line, detail) => {
  failures.push(detail === undefined ? line : `${line} — ${detail}`);
  console.log(`${red('  ✗')} ${line}`);
  if (detail) console.log(dim(`      ${detail}`));
};
const bang = (line, detail) => {
  console.log(`${yellow('  !')} ${line}`);
  if (detail) console.log(dim(`      ${detail}`));
};

const DEFAULTS = {
  manifest: 'deploy/staging/release-manifest.json',
  // A tag is not the identity, but untagged `<none>` images fill a disk unnoticed.
  tag: '<git short sha>',
  // Loopback, because the registry has no authentication and no TLS.
  registry: DEFAULT_REGISTRY,
};

const ARTEFACTS = [
  { service: 'api', dockerfile: 'Dockerfile.api', repository: 'prl-api' },
  { service: 'web', dockerfile: 'Dockerfile.web', repository: 'prl-web' },
];

export const MANIFEST_SCHEMA = 'prl.release-artifacts.v1';

const HELP = `
${bold('pnpm run release:artifacts')} — build both images once, record their digests

  Options:
    --tag <label>      human-readable tag for both images  (default ${DEFAULTS.tag})
    --manifest <path>  where to write the manifest         (default ${DEFAULTS.manifest})
    --push             push both artefacts and record the registry digest too
    --registry <host>  where --push pushes                 (default ${DEFAULTS.registry})
    --force            rebuild even though a valid manifest for this commit exists
    --no-cache         pass --no-cache to docker build
    --verbose          stream the build output instead of buffering it
    --json             print the manifest to stdout as well as writing it
    -h, --help         this text

  The manifest is the contract. \`pnpm run staging up\`, \`pnpm run staging promote\`
  and \`pnpm run security:containers\` all read it and none of them can build an
  image, so the digest that reaches production is the digest staging tested.

  Without --push the digests are local to this machine and the stack deploys them
  with \`pull_policy: never\`, exactly as before. With --push each artefact also
  gets a registry digest, verified by re-fetching the manifest from the registry
  and by pulling the image back by digest, and the staging stack then deploys the
  registry reference with \`pull_policy: always\`. Start the registry first:

      docker compose -f deploy/registry/docker-compose.registry.yml up -d

  Exit codes: 0 built and verified, 0 refused to rebuild an already-valid manifest
  (pass --force to rebuild anyway), 1 a failed build or a failed artefact check.
`;

function parseArgs(argv) {
  const options = {
    tag: null,
    manifest: DEFAULTS.manifest,
    push: false,
    registry: DEFAULTS.registry,
    force: false,
    noCache: false,
    verbose: false,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    // `pnpm run release:artifacts -- --force` forwards the `--` itself.
    if (arg === '--') continue;
    switch (arg) {
      case '-h':
      case '--help':
        options.help = true;
        break;
      case '--tag':
        options.tag = next();
        break;
      case '--manifest':
        options.manifest = next();
        break;
      case '--push':
        options.push = true;
        break;
      case '--registry':
        options.registry = next();
        break;
      case '--force':
        options.force = true;
        break;
      case '--no-cache':
        options.noCache = true;
        break;
      case '--verbose':
        options.verbose = true;
        break;
      case '--json':
        options.json = true;
        break;
      default:
        throw new Error(`unknown option ${arg} (try --help)`);
    }
  }
  if (options.tag !== null && !/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/.test(options.tag)) {
    throw new Error(
      `--tag "${options.tag}" is not a valid Docker tag: start with a letter, digit or underscore, ` +
        'then letters, digits, dots, dashes and underscores, at most 128 characters',
    );
  }
  // Parsed even without --push, so a typo fails before two builds.
  const registry = parseRegistryHost(options.registry);
  if ('problem' in registry) throw new Error(`--registry ${registry.problem}`);
  if (options.push && !registry.loopback) {
    // This script sends no credentials and talks plain HTTP, so a remote registry would fail late.
    throw new Error(
      `--registry ${registry.host} is not a loopback address. --push is written for the local ` +
        'registry in deploy/registry/docker-compose.registry.yml: it sends no credentials, and docker ' +
        'itself only treats localhost and 127.0.0.1 as insecure-by-default. Pushing to a real registry ' +
        'needs authentication and TLS, which belongs in CI with a signing step beside it.',
    );
  }
  return options;
}

// 64 MiB, because a web image build log passes Node's 1 MiB default.
function run(command, args, { cwd = REPO_ROOT, stream = false, env = process.env } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: stream ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: result.status === null ? 1 : result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error ?? null,
  };
}

function capture(command, args) {
  const result = run(command, args);
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

// `dirty` is recorded rather than refused. `release.yml` builds from a clean checkout.
function gitProvenance() {
  const sha = capture('git', ['rev-parse', 'HEAD']);
  if (sha === null) return { sha: null, shortSha: null, branch: null, dirty: null };
  const porcelain = capture('git', ['status', '--porcelain']);
  return {
    sha,
    shortSha: sha.slice(0, 12),
    branch: capture('git', ['rev-parse', '--abbrev-ref', 'HEAD']),
    // `null` (git present but the status call failed) is not the same as `false`.
    dirty: porcelain === null ? null : porcelain !== '',
  };
}

function dockerVersion() {
  const version = capture('docker', ['version', '--format', '{{.Server.Version}}']);
  if (version === null) {
    throw new Error(
      'docker is not available, or its daemon is not running. This script builds the release ' +
        'artefacts; it cannot proceed without one, and it will not pretend to.',
    );
  }
  return version;
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;

// Three readings of the digest from three daemon code paths must agree, or `--iidfile` no longer
// names the artefact on this Docker version.
function inspectImage(reference, iidDigest) {
  const raw = capture('docker', [
    'image',
    'inspect',
    reference,
    '--format',
    // WorkingDir is read so `probeRoot` derives the probe root from the image.
    '{{.Id}}\t{{.Size}}\t{{.Created}}\t{{.Config.User}}\t{{.Config.WorkingDir}}\t{{json .RepoDigests}}',
  ]);
  if (raw === null) throw new Error(`docker image inspect ${reference} failed after a successful build`);
  const [id, size, created, user, workingDir, repoDigestsJson] = raw.split('\t');
  if (id === undefined || !DIGEST.test(id)) {
    throw new Error(`docker reported an unusable image id for ${reference}: ${String(id)}`);
  }
  if (id !== iidDigest) {
    throw new Error(
      `the digest from --iidfile (${iidDigest}) and the one from docker image inspect (${id}) disagree ` +
        'for ' +
        reference +
        '. This pipeline treats the iidfile value as the artefact identity; a disagreement means that ' +
        'is no longer true on this Docker version and every downstream comparison would be meaningless.',
    );
  }
  let repoDigests = [];
  try {
    const parsed = JSON.parse(repoDigestsJson ?? 'null');
    if (Array.isArray(parsed)) repoDigests = parsed.filter((entry) => typeof entry === 'string');
  } catch {
    // RepoDigests is recorded for a human. The two digest readings above are what count.
    repoDigests = [];
  }
  return {
    digest: id,
    sizeBytes: Number(size),
    createdAt: created ?? null,
    user: user === undefined || user === '' ? null : user,
    workingDir: workingDir ?? '',
    repoDigests,
  };
}

// The probe runs `node -e` in the image, because node is the one binary both images are sure to have.
//
// Credential shapes are derived from `secret-scan.mjs`. A probe that matched only `.md` and `^\.env`
// passed an image carrying `cosign.key`, `signing.env`, a TLS key and `metrics-token`.
// `MUST_BE_IGNORED` gives the basenames, `NEVER_TRACKED` the shapes, and any `*.env` is added because
// an image should carry no environment file.
const CREDENTIAL_PATTERNS = [
  ...NEVER_TRACKED.map((rule) => rule.pattern.source),
  // Any `*.env`, so `backup.env` and `signing.env` match.
  '\\.env$',
];

// The basenames too, so a shapeless rename of `metrics-token` still fires.
const CREDENTIAL_BASENAMES = [
  ...new Set(MUST_BE_IGNORED.map((entry) => entry.path.split('/').pop()).filter((name) => name)),
];

// An empty detector list would report every image clean, so refuse at module load.
if (CREDENTIAL_PATTERNS.length < 4 || CREDENTIAL_BASENAMES.length < 4) {
  throw new Error(
    `the credential detectors derived from secret-scan.mjs collapsed to ${CREDENTIAL_PATTERNS.length} ` +
      `pattern(s) and ${CREDENTIAL_BASENAMES.length} basename(s). A probe with no detectors reports ` +
      'every image clean; refusing to run one',
  );
}

export const filesystemProbe = (root) => `
const fs = require('node:fs');
const path = require('node:path');
const root = ${JSON.stringify(root)};
// Credential detectors, interpolated from scripts/supply-chain/secret-scan.mjs — see
// CREDENTIAL_PATTERNS above for the six secret-bearing paths the hand-written test missed.
const credentialPatterns = ${JSON.stringify(CREDENTIAL_PATTERNS)}.map((source) => new RegExp(source));
const credentialNames = new Set(${JSON.stringify(CREDENTIAL_BASENAMES)});
// \`examined\` is the load-bearing field, and \`unreadable\` records why a directory produced
// none. See \`probeRoot\` and \`checkArtefact\`: the walk used to swallow a missing directory and
// report an empty \`hits\`, which is indistinguishable from a clean image.
const hits = { root, exists: false, examined: 0, unreadable: [], markdown: [], dotenv: [], credentials: [] };
const walk = (dir, depth) => {
  if (depth > 12) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (err) { hits.unreadable.push(dir + ': ' + err.code); return; }
  for (const entry of entries) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full, depth + 1); continue; }
    if (!entry.isFile()) continue;
    hits.examined += 1;
    if (/\\.md$/i.test(entry.name)) hits.markdown.push(full);
    if (/^\\.env/.test(entry.name)) { hits.dotenv.push(full); continue; }
    // Matched against the WHOLE path, not the basename: the NEVER_TRACKED shapes are anchored
    // with (^|/) and a basename-only test would silently drop that anchor.
    if (credentialNames.has(entry.name) || credentialPatterns.some((re) => re.test(full))) {
      hits.credentials.push(full);
    }
  }
};
try { hits.exists = fs.statSync(root).isDirectory(); }
catch (err) { hits.unreadable.push(root + ': ' + err.code); }
if (hits.exists) walk(root, 0);
process.stdout.write(JSON.stringify(hits));
`;

// The top-level ancestor of the image's WorkingDir. `Dockerfile.web` ends on `WORKDIR /app/apps/web`
// while the tree it must not carry is at `/app`.
export function probeRoot(workingDir) {
  if (typeof workingDir !== 'string') return null;
  const trimmed = workingDir.trim();
  if (!trimmed.startsWith('/')) return null;
  const [first] = trimmed
    .slice(1)
    .split('/')
    .filter((segment) => segment !== '');
  return first === undefined ? null : `/${first}`;
}

// Separate from `checkArtefact` so it can be tested without Docker. Examining zero files is a failure,
// because an empty result looks exactly like a clean image.
export function filesystemProblems(hits, workingDir) {
  const problems = [];
  const root = hits?.root ?? '(unknown)';
  if (hits?.exists !== true) {
    problems.push(
      `the image has no ${root} directory (its WorkingDir is ${workingDir || '(unset)'}), so the ` +
        'markdown and .env probe examined nothing — this check cannot pass by finding nothing to look at',
    );
    return problems;
  }
  if (!(hits.examined > 0)) {
    const why = hits.unreadable?.join('; ') || 'the directory is empty';
    problems.push(
      `the filesystem probe examined 0 files under ${root} (${why}). A release image with no files ` +
        'under its application root is not an image; the previous version of this check read that ' +
        'as a clean pass',
    );
    return problems;
  }
  if (hits.markdown.length > 0) {
    problems.push(
      `${hits.markdown.length} markdown file(s) in the image: ${hits.markdown.slice(0, 5).join(', ')}` +
        `${hits.markdown.length > 5 ? ', …' : ''} — see .dockerignore's header; this is how ` +
        'AGENTS.md and CLAUDE.md were published',
    );
  }
  if (hits.dotenv.length > 0) {
    problems.push(`environment file(s) in the image: ${hits.dotenv.join(', ')} — these carry credentials`);
  }
  // Credential material other than `.env`, derived from `secret-scan.mjs`.
  if (!Array.isArray(hits.credentials)) {
    // A missing bucket is refused rather than read as empty.
    problems.push(
      'the filesystem probe returned no `credentials` list, so nothing looked for key material. ' +
        'An absent result is not a clean one — see CREDENTIAL_PATTERNS',
    );
  } else if (hits.credentials.length > 0) {
    problems.push(
      `credential material in the image: ${hits.credentials.slice(0, 5).join(', ')}` +
        `${hits.credentials.length > 5 ? ', …' : ''} (${hits.credentials.length} file(s)) — these are ` +
        'the paths scripts/supply-chain/secret-scan.mjs calls credential-bearing; a key in a layer is ' +
        'published to everybody who pulls the image, and rotating it is the only remedy',
    );
  }
  return problems;
}

/**
 * Checks the built artefact, not the Dockerfile: runs as `node`, no repository markdown outside
 * node_modules, no `.env*`, and no credential material. A `.dockerignore` `*.md` anchored to the root
 * lets `apps/web/AGENTS.md` through. Dependency READMEs under node_modules are skipped.
 */
function checkArtefact(reference, meta, note) {
  const problems = [];
  if (meta.user !== 'node') {
    problems.push(
      `runs as '${meta.user ?? 'root'}', expected 'node' — a container that ships as root undoes ` +
        'the least-privilege posture the rest of the stack is built on',
    );
  }

  const root = probeRoot(meta.workingDir);
  if (root === null) {
    problems.push(
      `docker image inspect reports WorkingDir ${JSON.stringify(meta.workingDir ?? null)}, which is ` +
        'not an absolute path. There is no directory to probe for markdown and .env files, and this ' +
        'check will not report a pass it did not earn',
    );
    return problems;
  }

  const probe = run('docker', [
    'run',
    '--rm',
    '--entrypoint',
    'node',
    reference,
    '-e',
    filesystemProbe(root),
  ]);
  if (probe.status !== 0) {
    problems.push(`could not inspect the image filesystem: ${probe.stderr.trim() || 'no output'}`);
    return problems;
  }
  let hits;
  try {
    hits = JSON.parse(probe.stdout);
  } catch {
    problems.push(`the filesystem probe returned something that is not JSON: ${probe.stdout.slice(0, 200)}`);
    return problems;
  }
  problems.push(...filesystemProblems(hits, meta.workingDir));
  if (problems.length === 0) {
    note(
      `no markdown, no .env and no credential material among ${hits.examined} files under ${root} ` +
        `outside node_modules (${CREDENTIAL_BASENAMES.length} named path(s) and ` +
        `${CREDENTIAL_PATTERNS.length} shape(s) from secret-scan.mjs); runs as ${meta.user}`,
    );
  }
  return problems;
}

/**
 * Pushes one artefact and proves the registry copy: the push output gives the digest, RepoDigests
 * agrees, the registry serves bytes that hash to it and tie to the local build, and the image pulls
 * back by digest after every local reference is removed. On the building machine the pull reuses
 * local layers, so it proves the reference resolves, not transfer. `deploy/registry/README.md` shows
 * a cold-store transfer.
 */
async function pushArtefact(image, registry) {
  const separator = image.tag.lastIndexOf(':');
  const tagLabel = separator === -1 ? 'latest' : image.tag.slice(separator + 1);
  const registryTag = registryTagReference(registry.host, image.repository, tagLabel);

  // Tagged from the digest reference, because a concurrent build could move the local tag.
  const tagged = run('docker', ['tag', image.reference, registryTag]);
  if (tagged.status !== 0) {
    return { problem: `docker tag ${image.reference} ${registryTag} failed: ${tagged.stderr.trim()}` };
  }

  const push = run('docker', ['push', registryTag]);
  const pushOutput = `${push.stdout}\n${push.stderr}`;
  if (push.status !== 0) {
    return {
      problem:
        `docker push ${registryTag} failed: ${push.stderr.trim() || push.stdout.trim()}\n      Is the ` +
        'registry up? `docker compose -f deploy/registry/docker-compose.registry.yml up -d`',
    };
  }
  const pushedDigest = parsePushDigest(pushOutput);
  if (pushedDigest === null) {
    return {
      problem:
        `docker push ${registryTag} succeeded but printed no "digest: sha256:…" line, so the registry ` +
        `digest is unknown. Output was: ${pushOutput.trim().slice(-400)}`,
    };
  }

  const raw = capture('docker', ['image', 'inspect', registryTag, '--format', '{{json .RepoDigests}}']);
  let repoDigests = [];
  try {
    const parsed = JSON.parse(raw ?? 'null');
    if (Array.isArray(parsed)) repoDigests = parsed;
  } catch {
    repoDigests = [];
  }
  const reported = registryRepoDigests(repoDigests, registry.host, image.repository);
  if (reported.length > 0 && !reported.includes(pushedDigest)) {
    return {
      problem:
        `the push returned ${pushedDigest} but docker image inspect reports ${reported.join(', ')} for ` +
        `${registry.host}/${image.repository}. That is the multi-platform conversion case: docker ` +
        'pushed a single-platform manifest and kept naming the local index, so the two digests describe ' +
        'different artefacts. Recording either one would produce a reference that resolves to something ' +
        'other than what was tested here.',
    };
  }

  const verified = await verifyRegistryDigest({
    host: registry.host,
    repository: image.repository,
    digest: pushedDigest,
    localDigest: image.digest,
  });
  if (!verified.ok) return { problem: verified.problem };

  const reference = registryReference(registry.host, image.repository, pushedDigest);
  // Untags only, so the pull must resolve through the registry. `prl-api:<tag>` and running
  // containers are untouched.
  const untagged = [registryTag, reference].map((ref) => run('docker', ['rmi', ref]).status === 0);
  const pull = run('docker', ['pull', reference]);
  if (pull.status !== 0) {
    return { problem: `docker pull ${reference} failed: ${pull.stderr.trim() || pull.stdout.trim()}` };
  }
  const pulledId = capture('docker', ['image', 'inspect', reference, '--format', '{{.Id}}']);
  if (pulledId !== image.digest) {
    return {
      problem:
        `pulling ${reference} back produced image ${String(pulledId)}, and the build recorded ` +
        `${image.digest}. The registry is serving something other than the artefact that was built ` +
        'and checked here; nothing downstream may use either value until that is understood.',
    };
  }

  return {
    registry: {
      host: registry.host,
      repository: image.repository,
      tag: registryTag,
      digest: pushedDigest,
      reference,
      tiedBy: verified.tie,
      pulledBackId: pulledId,
      pushedAt: new Date().toISOString(),
    },
    detail:
      `${pushedDigest}\n      registry manifest re-fetched and re-hashed here (${verified.tie}); ` +
      `${untagged.filter(Boolean).length} local reference(s) to it removed, then pulled back by ` +
      `digest and the image that came back is ${pulledId.slice(0, 19)}…`,
  };
}

// A manifest whose digests no longer resolve describes pruned images and does not prevent a rebuild.
function existingManifestFor(path, commitSha) {
  if (!existsSync(path)) return null;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  if (manifest?.schema !== MANIFEST_SCHEMA) return null;
  if (commitSha === null || manifest?.commit?.sha !== commitSha) return null;
  if (manifest?.commit?.dirty !== false) return null;
  for (const { service } of ARTEFACTS) {
    const reference = manifest?.images?.[service]?.reference;
    if (typeof reference !== 'string') return null;
    if (capture('docker', ['image', 'inspect', reference, '--format', '{{.Id}}']) === null) return null;
  }
  return manifest;
}

// Two strings, because a pushed and an unpushed manifest record different kinds of digest.
function digestKindFor(images) {
  const everyServicePushed = ARTEFACTS.every(({ service }) => images[service]?.registry != null);
  if (!everyServicePushed) {
    return (
      'local BuildKit image-store manifest digest (--iidfile). Content-addressed and stable, but ' +
      'local to the machine that built it: nothing was pushed, so no other machine can resolve it. ' +
      'Re-run with --push against a registry to add a fetchable digest.'
    );
  }
  return (
    'two content addresses for one artefact: the local BuildKit image-store manifest digest ' +
    '(--iidfile), and the manifest digest the registry returned on push — which was re-fetched from ' +
    'the registry, re-hashed here, and pulled back by digest. images.<service>.registry.reference ' +
    'resolves to exactly these bytes on any machine that can reach the registry. Neither digest is ' +
    'signed BY THIS SCRIPT: signing is `pnpm run release:sign`, which records what it signed in ' +
    'deploy/staging/release-signatures.json. Until that has run this is content identity across a ' +
    'push/pull boundary and not provenance.'
  );
}

// A service that could not be pushed is a `cross`, so no half-promotable manifest is written.
async function pushAll(images, registry) {
  console.log(bold(`\nPush → ${registry.host}`));
  for (const { service } of ARTEFACTS) {
    const image = images[service];
    if (image === undefined) continue;
    const result = await pushArtefact(image, registry);
    if ('problem' in result) {
      cross(`${service}: no registry digest was recorded`, result.problem);
      continue;
    }
    image.registry = result.registry;
    tick(`${service} pushed to ${result.registry.tag}`, result.detail);
  }
}

// The command line lives in `main()` so importing the module does not build and push images.
async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(red(`release:artifacts — ${err.message}`));
    process.exit(1);
  }

  if (options.help) {
    console.log(HELP);
    process.exit(0);
  }

  console.log(bold('\nRelease artefacts'));

  let server;
  try {
    server = dockerVersion();
  } catch (err) {
    console.error(red(`  ✗ ${err.message}\n`));
    process.exit(1);
  }

  const git = gitProvenance();
  const tag = options.tag ?? `${git.shortSha ?? 'local'}${git.dirty === true ? '-dirty' : ''}`;
  const manifestPath = resolve(REPO_ROOT, options.manifest);
  // parseArgs has already refused anything unusable, so this cannot carry a problem.
  const registry = parseRegistryHost(options.registry);

  console.log(dim(`  docker   ${server}`));
  console.log(dim(`  commit   ${git.sha ?? '(not a git checkout)'}${git.dirty === true ? ' (dirty)' : ''}`));
  console.log(dim(`  tag      ${tag}`));
  console.log(dim(`  manifest ${options.manifest}`));
  console.log(dim(`  registry ${options.push ? registry.host : 'none (--push not given)'}\n`));

  if (git.dirty === true) {
    bang(
      'the working tree is dirty',
      'the manifest records this. `pnpm run staging promote` refuses a dirty manifest, because a ' +
        'commit sha that does not describe the bytes that were built is not provenance.',
    );
  }

  if (!options.force) {
    const existing = existingManifestFor(manifestPath, git.sha);
    if (existing !== null) {
      console.log(bold('\nAlready built'));
      for (const { service } of ARTEFACTS) {
        console.log(`  ${green('✓')} ${service}  ${dim(existing.images[service].reference)}`);
      }
      // `--push` on an already-built commit pushes what exists rather than building again.
      if (options.push) {
        await pushAll(existing.images, registry);
        if (failures.length === 0) {
          existing.digestKind = digestKindFor(existing.images);
          existing.pushedAt = new Date().toISOString();
          writeFileSync(manifestPath, `${JSON.stringify(existing, null, 2)}\n`);
          tick(`manifest updated with the registry digests (${options.manifest})`);
          if (options.json) console.log(JSON.stringify(existing, null, 2));
          console.log(green(bold('\nPASS — the existing artefacts are now fetchable by registry digest.\n')));
          process.exit(0);
        }
        console.log(red(bold(`\nFAIL — ${failures.length} problem(s), the manifest was left untouched:`)));
        for (const failure of failures) console.log(red(`    - ${failure}`));
        console.log('');
        process.exit(1);
      }
      console.log(
        dim(
          '\n  A valid manifest for this exact commit already exists and both images are still present.\n' +
            '  Building again would produce a different artefact from the same source, which is the\n' +
            '  thing this script exists to prevent. Pass --force if that is genuinely what you want.\n' +
            '  (--push publishes these existing artefacts without rebuilding them.)\n',
        ),
      );
      process.exit(0);
    }
  }

  const scratch = mkdtempSync(join(tmpdir(), 'prl-release-'));
  const images = {};

  try {
    for (const artefact of ARTEFACTS) {
      const reference = `${artefact.repository}:${tag}`;
      const iidFile = join(scratch, `${artefact.service}.iid`);
      const args = ['build', '--file', artefact.dockerfile, '--tag', reference, '--iidfile', iidFile];
      if (options.noCache) args.push('--no-cache');
      args.push('.');

      console.log(bold(`▸ ${artefact.service}  ${dim(artefact.dockerfile)}`));
      const startedAt = Date.now();
      const build = run('docker', args, { stream: options.verbose });
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      if (build.status !== 0) {
        cross(`docker build failed for ${artefact.service} after ${elapsed}s`);
        if (!options.verbose) {
          // Buffered so a successful build prints three lines and a failed one prints the log.
          console.error(build.stdout);
          console.error(build.stderr);
        }
        break;
      }

      const iidDigest = readFileSync(iidFile, 'utf8').trim();
      if (!DIGEST.test(iidDigest)) {
        cross(`--iidfile produced something that is not a digest for ${artefact.service}`, iidDigest);
        break;
      }
      const meta = inspectImage(reference, iidDigest);
      tick(`built ${reference} in ${elapsed}s`, `${iidDigest}  (${(meta.sizeBytes / 1e6).toFixed(0)} MB)`);

      const problems = checkArtefact(reference, meta, (detail) => console.log(dim(`      ${detail}`)));
      for (const problem of problems) cross(`${artefact.service}: ${problem}`);

      images[artefact.service] = {
        service: artefact.service,
        dockerfile: artefact.dockerfile,
        repository: artefact.repository,
        tag: reference,
        digest: meta.digest,
        reference: `${artefact.repository}@${meta.digest}`,
        sizeBytes: meta.sizeBytes,
        createdAt: meta.createdAt,
        user: meta.user,
        repoDigests: meta.repoDigests,
      };
    }
  } catch (err) {
    cross('the build was abandoned', err?.message ?? String(err));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  const built = Object.keys(images).length;

  // Only after every artefact check passed.
  if (options.push && built === ARTEFACTS.length && failures.length === 0) {
    await pushAll(images, registry);
  }

  if (built === ARTEFACTS.length && failures.length === 0) {
    const manifest = {
      schema: MANIFEST_SCHEMA,
      builtAt: new Date().toISOString(),
      commit: git,
      toolchain: { node: process.version, dockerServer: server },
      digestKind: digestKindFor(images),
      images,
    };
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    tick(`manifest written to ${options.manifest}`);
    if (options.json) console.log(JSON.stringify(manifest, null, 2));
  }

  console.log(bold('\nSummary'));
  console.log(`  images built     ${built}/${ARTEFACTS.length}`);
  console.log(
    `  artefact checks  ${failures.length === 0 ? green('all passed') : red(`${failures.length} failed`)}`,
  );
  for (const { service } of ARTEFACTS) {
    const image = images[service];
    console.log(`  ${service.padEnd(16)} ${image ? dim(image.reference) : red('not built')}`);
    if (image?.registry != null) console.log(`  ${''.padEnd(16)} ${dim(image.registry.reference)}`);
  }

  if (built !== ARTEFACTS.length || failures.length > 0) {
    console.log(red(bold('\nFAIL — no manifest was written.')));
    console.log(
      dim(
        '  Downstream steps read the manifest, so a partial build cannot be deployed by accident.\n' +
          '  Fix the failure above and run this again.\n',
      ),
    );
    process.exit(1);
  }

  console.log(green(bold('\nPASS — both images built once and recorded.')));
  console.log(
    dim(
      '\n  These digests are the ONLY artefacts that should reach staging or production.\n' +
        '  Next: `pnpm run security:containers`, then `pnpm run staging up`.\n' +
        '  Caveat: this proves the images assemble and are shaped correctly. It proves nothing\n' +
        '  about whether they serve a hand — that is the staging smoke test — and nothing about\n' +
        '  known vulnerabilities in them, which is the container scan.\n',
    ),
  );
  if (options.push) {
    console.log(
      dim(
        '  Both artefacts are also in the registry, and each registry digest was re-fetched,\n' +
          '  re-hashed here and pulled back by digest. Another machine that can reach the registry\n' +
          '  can obtain exactly these bytes; a digest pull cannot return different ones.\n' +
          '  What that is NOT: a signature. Nothing HERE signs, attests or notarises anything, so\n' +
          '  what this script alone proves is content identity. Sign them next:\n\n' +
          '      pnpm run release:sign && pnpm run security:image-provenance\n\n' +
          '  and read deploy/signing/README.md for what a locally-held key does and does not\n' +
          '  establish: it is possession of a key, not the identity of a builder.\n',
      ),
    );
  } else {
    console.log(
      dim(
        '  These digests are local to this machine: nothing was pushed, so no other machine can\n' +
          '  resolve them. `--push` adds a registry digest — see deploy/registry/README.md.\n',
      ),
    );
  }
}

// realpath on both sides, because pnpm reaches the checkout through symlinks. An unresolvable path
// is "not us", so the failure is a script that does nothing rather than an unattended build.
function startedFromCommandLine() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (startedFromCommandLine()) await main();

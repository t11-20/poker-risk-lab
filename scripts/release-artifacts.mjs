#!/usr/bin/env node
/**
 * Builds the two release images ONCE and records their content digests.
 *
 * Invoked by `pnpm run release:artifacts`.
 *
 * ## The defect this exists for
 *
 * "Build once, deploy the same artefact everywhere" is the property that makes a
 * staging rehearsal mean anything, and nothing in this repository held it.
 * `docker-compose.yml` has `build:` sections, so `docker compose up --build`
 * produces a fresh image every time; ci.yml's `containers` job builds two more
 * that nothing else ever sees; and a deployment would have built a third pair.
 * Three builds of the same commit are three different images — the base image
 * moves, the registry serves a rebuilt transitive dependency, a lockfile install
 * lands on a different mirror — so "we tested this in staging" was a statement
 * about a build, not about the bytes that would run.
 *
 * This script is the single place an image is produced. It builds each Dockerfile
 * exactly once, records the digest BuildKit assigned, checks a handful of
 * properties of the artefact itself, and writes a machine-readable manifest.
 * `scripts/staging.mjs`, `scripts/supply-chain/container-scan.mjs` and
 * `.github/workflows/release.yml` all consume that manifest and none of them can
 * build anything. Re-running this script against a commit whose manifest is
 * already valid REFUSES rather than rebuilding, so building twice is an explicit
 * act with a flag on it (`--force`).
 *
 * ## What "digest" means here, precisely, because it is easy to overclaim
 *
 * By default nothing is pushed. The digest recorded is the one BuildKit's image
 * exporter assigns to the manifest it wrote into the local containerd image
 * store — the same value `--iidfile` emits, the same value
 * `docker image inspect --format '{{.Id}}'` reports, and the same value that
 * appears in `RepoDigests` as `prl-api@sha256:...`. It is a content address: two
 * builds that produce different bytes cannot share it, and
 * `image: prl-api@sha256:...` in a compose file resolves to exactly that image or
 * to nothing.
 *
 * What that value is NOT, on its own, is fetchable. It names bytes that exist on
 * one machine, which is why "the release images are identified only by a local
 * BuildKit digest, so they cannot be promoted across machines" sat in
 * `docs/production/final-readiness-report.md` as an open residual.
 *
 * `--push` closes that. It tags and pushes both artefacts to a registry
 * (`deploy/registry/docker-compose.registry.yml` runs one on loopback), records
 * the digest the REGISTRY returned alongside the local one, and then proves the
 * two name the same artefact instead of asserting it: the manifest bytes are
 * re-fetched from the registry over HTTP and re-hashed here, and the image is
 * pulled back BY DIGEST after every local reference to it has been removed. See
 * `scripts/registry-digest.mjs` for why `docker image inspect {{.RepoDigests}}`
 * is cross-checked rather than believed — it has been measured reporting a digest
 * the registry does not hold.
 *
 * What NEITHER digest is, is signed. No registry "vouches" for an artefact in the
 * sense people mean when they say that: a registry is content-addressed storage,
 * so what a push buys is content identity across a push/pull boundary — another
 * machine asking for `repo@sha256:X` gets those bytes or an error, never
 * different bytes. Who built them, from what source, on what machine, and whether
 * anybody stands behind them is provenance, and it needs a signing tool. That is
 * `pnpm run release:sign`, a SEPARATE command on purpose: it holds the private key
 * and this script must never learn to. Nothing in this file signs anything, so a
 * manifest written here describes UNSIGNED artefacts until that command has run and
 * `pnpm run security:image-provenance` has verified the result.
 * `pnpm run staging promote` states exactly that split rather than implying more.
 *
 * ## What this does NOT prove
 *
 * That the images work. It builds them, checks four properties of their
 * filesystem and metadata, and stops. Whether the API serves a hand correctly is
 * `pnpm run staging up`'s job (it runs the smoke test against the running stack),
 * and whether the images carry known CVEs is `pnpm run security:containers`.
 *
 * Usage:
 *     node scripts/release-artifacts.mjs [--tag <label>] [--manifest <path>]
 *                                        [--push] [--registry <host:port>]
 *                                        [--force] [--no-cache] [--verbose] [--json]
 *
 * Exit codes: 0 both images built and every artefact check passed; 1 a build that
 * failed or an artefact check that did not pass. 0 for --help.
 *
 * Refusing to rebuild a commit that already has a valid manifest also exits 0, and
 * this paragraph used to claim it exited 1. The CODE is right and the sentence was
 * wrong, so the sentence was fixed: the refusal means "the artefacts you asked for
 * already exist and are still resolvable", which is the desired end state, not a
 * failure. It has to be 0 because the release path chains — `pnpm run
 * release:artifacts && pnpm run security:containers && pnpm run staging up` — and
 * an exit 1 there would stop a release for having already built what it needed,
 * teaching everybody to pass --force by reflex and destroying the build-once
 * property this whole script exists to hold. Do not "fix" it the other way.
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

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const NO_COLOR = process.env.NO_COLOR !== undefined || !process.stdout.isTTY;
const paint = (code, s) => (NO_COLOR ? s : `\u001b[${code}m${s}\u001b[0m`);
const dim = (s) => paint('2', s);
const bold = (s) => paint('1', s);
const red = (s) => paint('31', s);
const green = (s) => paint('32', s);
const yellow = (s) => paint('33', s);

// --- output ---------------------------------------------------------------

/**
 * The run's reporter, and the list of everything that went wrong.
 *
 * Module scope rather than local to `main()` for one concrete reason: `pushAll`
 * reports through `tick` and `cross`, and it is defined up here because the
 * registry work is a section of its own. Declaring these inside `main()` would
 * put them out of that function's reach.
 *
 * `failures` is the verdict rather than decoration — `cross` appends to it, and
 * both the exit code and the decision to write a manifest are read off its
 * length. A reporter that only printed would let a failed artefact check
 * publish an image.
 */
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

// --- options --------------------------------------------------------------

const DEFAULTS = {
  /** Where the manifest is written. Everything downstream reads this path. */
  manifest: 'deploy/staging/release-manifest.json',
  /**
   * The human-readable tag. A tag is not the identity — the digest is — but an
   * image with no tag at all is a name nobody can type, and `docker images` full
   * of `<none>` entries is how a machine runs out of disk without anyone noticing.
   */
  tag: '<git short sha>',
  /**
   * Where `--push` pushes. Loopback, because the registry
   * `deploy/registry/docker-compose.registry.yml` runs has no authentication and
   * no TLS; see that file for why the port is 5001 rather than 5000.
   */
  registry: DEFAULT_REGISTRY,
};

/** The two artefacts. Order matters only for the output; both are always built. */
const ARTEFACTS = [
  { service: 'api', dockerfile: 'Dockerfile.api', repository: 'prl-api' },
  { service: 'web', dockerfile: 'Dockerfile.web', repository: 'prl-web' },
];

/** The schema string downstream consumers check before trusting the shape. */
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
  // Parsed even when --push was not passed: a typo in --registry that is only
  // noticed after two builds have completed is a typo that costs four minutes.
  const registry = parseRegistryHost(options.registry);
  if ('problem' in registry) throw new Error(`--registry ${registry.problem}`);
  if (options.push && !registry.loopback) {
    // docker will refuse plain HTTP to a non-loopback host anyway, and this
    // script sends no credentials, so a remote registry would fail late and
    // obscurely. Saying so here is not a policy about remote registries; it is a
    // statement about what this script has been proven to do.
    throw new Error(
      `--registry ${registry.host} is not a loopback address. --push is written for the local ` +
        'registry in deploy/registry/docker-compose.registry.yml: it sends no credentials, and docker ' +
        'itself only treats localhost and 127.0.0.1 as insecure-by-default. Pushing to a real registry ' +
        'needs authentication and TLS, which belongs in CI with a signing step beside it.',
    );
  }
  return options;
}

// --- running things -------------------------------------------------------

/**
 * Runs a command and returns its result rather than throwing.
 *
 * `maxBuffer` is 64 MiB because a `docker build` of the web image with BuildKit's
 * plain progress output is comfortably past Node's 1 MiB default, and the failure
 * mode of hitting it is a truncated log on the one run where the log matters.
 */
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

/** Trimmed stdout of a command expected to succeed, or null if it did not. */
function capture(command, args) {
  const result = run(command, args);
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

// --- git and toolchain ----------------------------------------------------

/**
 * What commit this artefact was built from, and whether the tree was clean.
 *
 * `dirty` is recorded rather than refused. A developer rehearsing staging on an
 * uncommitted change is the normal case and blocking it would just teach people to
 * pass a flag; but a manifest that does not say the tree was dirty is a manifest
 * that claims a commit it cannot substantiate. `release.yml` builds from a clean
 * checkout, so a dirty manifest never reaches the promotion path there.
 */
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

// --- the digest -----------------------------------------------------------

const DIGEST = /^sha256:[0-9a-f]{64}$/;

/**
 * Everything known about a built image.
 *
 * Three independent readings of the digest are taken and compared, because they
 * come from three different code paths in the daemon and a disagreement between
 * them means the assumption this whole pipeline rests on — that `--iidfile` names
 * the artefact — has stopped holding on this Docker version. Better a loud
 * failure here than a promotion comparing two values that mean different things.
 */
function inspectImage(reference, iidDigest) {
  const raw = capture('docker', [
    'image',
    'inspect',
    reference,
    '--format',
    // WorkingDir is read here rather than assumed by the filesystem probe. See `probeRoot`: the
    // probe used to walk a hard-coded `/app`, which is a guess about the artefact rather than a
    // reading of it, and a wrong guess made the probe examine nothing and pass.
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
    // A daemon that cannot render RepoDigests as JSON is not a failure worth
    // stopping a release for: the field is recorded for a human reading the
    // manifest, and the two digest readings above are the load-bearing part.
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

// --- artefact checks ------------------------------------------------------

/**
 * A short walk of the image's own filesystem, run inside the image.
 *
 * Written as `node -e` rather than `find`, because node is the one binary both
 * images are guaranteed to have — they are Node images, and everything else in
 * the runtime stage is whatever the base happens to include. That base has
 * already changed once (bookworm-slim → alpine3.24, 2026-08-25, taking the OS
 * package count from 88 to 18 and with it every `find` a Debian layout implied),
 * which is the argument for depending on node and nothing else.
 */
const filesystemProbe = (root) => `
const fs = require('node:fs');
const path = require('node:path');
const root = ${JSON.stringify(root)};
// \`examined\` is the load-bearing field, and \`unreadable\` records why a directory produced
// none. See \`probeRoot\` and \`checkArtefact\`: the walk used to swallow a missing directory and
// report an empty \`hits\`, which is indistinguishable from a clean image.
const hits = { root, exists: false, examined: 0, unreadable: [], markdown: [], dotenv: [] };
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
    if (/^\\.env/.test(entry.name)) hits.dotenv.push(full);
  }
};
try { hits.exists = fs.statSync(root).isDirectory(); }
catch (err) { hits.unreadable.push(root + ': ' + err.code); }
if (hits.exists) walk(root, 0);
process.stdout.write(JSON.stringify(hits));
`;

/**
 * Where in the image the probe starts, derived from the image's own metadata.
 *
 * `/app` used to be written into the probe as a literal, which is the second half of the defect
 * above: a literal path is a guess, and a guess that stops being true produces a walk of nothing
 * and — before the `examined` count existed — a clean pass. `docker image inspect` reports the
 * directory the image actually uses, so a Dockerfile that moves to `/srv` moves the probe with
 * it rather than silently disabling it.
 *
 * The TOP-LEVEL ancestor of the working directory is returned, not the working directory itself,
 * and that is deliberate rather than sloppy. `Dockerfile.web`'s runtime stage ends on
 * `WORKDIR /app/apps/web` while the repository tree it must not carry is copied to `/app`; a
 * probe rooted at the literal working directory would examine one subtree and never look at its
 * siblings, which is a narrower check than the one that caught `apps/web/AGENTS.md`. Taking the
 * first path segment keeps the blast radius the images were actually built with, while still
 * being read from the artefact rather than assumed.
 */
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

/**
 * The problems a probe result implies, separated from `checkArtefact` so it can be reasoned
 * about — and asserted about — without a Docker daemon.
 *
 * ## The defect this exists for
 *
 * The probe walked a hard-coded `/app` and its `readdirSync` sat inside `try { … } catch {
 * return; }`. An image whose content had moved, or whose runtime stage never received the
 * application at all, produced `{ markdown: [], dotenv: [] }` — byte-for-byte the same result as
 * a clean image — and the release passed. This is the check that exists because `AGENTS.md` and
 * `CLAUDE.md` shipped inside the published web image once already, and a check that cannot fail
 * is not a check.
 *
 * So the probe counts what it examined, and examining nothing is a failure. "Zero files under
 * the application root" is not a state any working release image can be in.
 */
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
  return problems;
}

/**
 * The properties a release image must have, checked against the built artefact
 * rather than against the Dockerfile that was supposed to produce it.
 *
 * Each of the three is a defect that actually shipped or is one edit away from
 * shipping:
 *
 *   * **Runs as `node`.** ci.yml already asserts this; it is repeated here so the
 *     release path does not depend on a CI job that a deployment does not run.
 *   * **No repository markdown outside node_modules** — and the probe must have
 *     LOOKED. The walk is rooted at the top of the image's own declared working
 *     directory (`probeRoot`) and reports how many files it examined; examining
 *     none is a failure. The previous version hard-coded `/app` and swallowed a
 *     missing directory, so an image whose content had moved returned an empty
 *     hit list, which is byte-for-byte what a clean image returns, and the release
 *     passed. The defect this bullet is really about: `.dockerignore` anchored
 *     `*.md` to the context root, so it matched README.md and nothing deeper, and
 *     `apps/web/AGENTS.md` and `apps/web/CLAUDE.md` — this repository's
 *     instructions to coding agents — shipped inside the published web image.
 *     Proven by `docker run prl-web:… find /app -name '*.md'` before the fix. The
 *     ignore rule and two Dockerfile prunes are the fix; this is what stops it
 *     coming back silently.
 *   * **No `.env*` anywhere.** Same class of bug, one that has not happened yet:
 *     `.env` in .dockerignore was root-anchored too, so `apps/api/.env` would have
 *     entered the context and been copied wholesale into the web image.
 *
 * Dependency READMEs under node_modules are skipped, not because they are
 * desirable but because removing them would mean rewriting a third-party tree
 * inside the image, which trades a cosmetic problem for a real one.
 */
function checkArtefact(reference, meta, note) {
  const problems = [];
  if (meta.user !== 'node') {
    problems.push(
      `runs as '${meta.user ?? 'root'}', expected 'node' — a container that ships as root undoes ` +
        'the least-privilege posture the rest of the stack is built on',
    );
  }

  // Read from the artefact, never written here as a literal: a probe rooted at a path this
  // script assumed rather than measured walks nothing the day the Dockerfile changes, and
  // walking nothing used to be a pass.
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
      `no markdown and no .env among ${hits.examined} files under ${root} outside node_modules; ` +
        `runs as ${meta.user}`,
    );
  }
  return problems;
}

// --- the registry ---------------------------------------------------------

/**
 * Pushes one built artefact and returns everything that can be PROVEN about the
 * copy the registry now holds.
 *
 * ## Why this is four checks and not one
 *
 * The blocker being closed is "these images are identified only by a local
 * BuildKit digest, so they cannot be promoted across machines". The fix is not
 * "we ran docker push"; it is a reference another machine can resolve to these
 * exact bytes. Every step below is one way that claim could be false, and each is
 * measured rather than assumed:
 *
 *   1. **The push reported a digest.** Read from the push output, which is the
 *      registry's answer, and not from `docker image inspect` — see
 *      `scripts/registry-digest.mjs` for the measured case where `RepoDigests`
 *      names a digest the registry has never held.
 *   2. **`RepoDigests` agrees with it.** Two readings of the same fact from two
 *      code paths; a disagreement means the push converted the artefact (the
 *      multi-platform case), and the local digest and the registry digest would
 *      then describe different things.
 *   3. **The registry serves bytes that hash to that digest, and those bytes tie
 *      back to the local build.** Done over HTTP, in this process, by hashing
 *      what came back. This is the step that makes the whole thing a measurement:
 *      everything else is docker's word for it.
 *   4. **The image pulls back BY DIGEST after every local reference to it is
 *      removed**, and the image that arrives has the identity the build recorded.
 *
 * ## What step 4 does and does not show on the building machine
 *
 * The layers are already in this machine's content store, so the pull resolves
 * without transferring them and it would be dishonest to call it proof of
 * transfer. What it proves is that the reference RESOLVES: the registry answers
 * for that digest, docker accepts the manifest as matching it, and the image that
 * comes out carries the identity the build recorded. Step 3 is what establishes
 * that the bytes are really in the registry and hash to the digest. The two
 * together are the cross-machine property — a digest pull cannot return different
 * bytes, because a registry that returned different bytes would be returning
 * bytes whose hash is not the digest that was asked for, which step 3 checks by
 * doing the hashing here. `deploy/registry/README.md` carries the cold-store
 * demonstration, on a throwaway image, where the transfer genuinely happens.
 */
async function pushArtefact(image, registry) {
  const separator = image.tag.lastIndexOf(':');
  const tagLabel = separator === -1 ? 'latest' : image.tag.slice(separator + 1);
  const registryTag = registryTagReference(registry.host, image.repository, tagLabel);

  // Tagged from the DIGEST reference, never from the local tag: the tag is a
  // pointer that a concurrent build could have moved between the build and here,
  // and the whole point is that the bytes pushed are the bytes verified.
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
  // Both local references to the registry copy are removed so the pull below has
  // to go through the registry to resolve the digest. These are untags — the
  // image is still tagged `prl-api:<tag>`, and a container running it is
  // untouched — so this cannot delete the artefact out from under the stack.
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
      // How the registry's manifest was tied to the local build — see
      // `tieManifestToLocalDigest`. Recorded so a reader of the manifest knows
      // which check ran rather than having to infer it from the image store.
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

// --- the manifest ---------------------------------------------------------

/**
 * Reads an existing manifest and decides whether it still describes THIS commit's
 * artefacts.
 *
 * "Still" is doing real work: a manifest whose digests no longer resolve is a
 * manifest describing images somebody has since pruned, and treating that as a
 * reason not to rebuild would leave the operator with a stack that cannot start
 * and a script that told them everything was fine.
 */
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

/**
 * What kind of digest the manifest is recording, stated inside the artefact so
 * that nobody reading it has to find this file to learn what they are looking at.
 *
 * Two strings, because there are two genuinely different situations and a single
 * hedged sentence covering both would be a sentence that overclaims in one of
 * them. This field has been wrong in exactly that way before: it said "not
 * registry-attested: nothing is pushed" for every manifest, which stopped being
 * true the moment `--push` existed.
 */
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

/**
 * Pushes every artefact and hangs the proven registry facts off the manifest
 * entries. A service that could not be pushed is a `cross`, so no manifest is
 * written: a manifest carrying a registry reference for one image and not the
 * other is a manifest whose reader has to guess which half is promotable.
 */
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

// --- run ------------------------------------------------------------------

/**
 * Everything the command line does, in a function.
 *
 * ## The defect this exists for
 *
 * This block used to sit at module scope, so `import` RAN it. That made the file
 * impossible to test — `scripts/release-artifacts.test.mjs` did not exist because
 * merely importing the module to reach `probeRoot` and `filesystemProblems` would
 * `docker build` both images, push them if `--push` were in this process's argv,
 * and overwrite `deploy/staging/release-manifest.json`. It was found the hard way:
 * a one-line import written to check the filesystem probe kicked off a real image
 * build against a machine with a staging stack running on it.
 *
 * `apps/api/scripts/migrate.mjs`, `scripts/backup.mjs` and
 * `scripts/reliability-drills.mjs` all carry the same guard for the same reason.
 * The most expensive and least reversible script in the repository was the one
 * without it.
 */
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
      // `--push` on an already-built commit pushes what is there rather than
      // refusing, and that is the whole point of the refusal: publishing an
      // artefact must never be a reason to build a second one. Re-pushing an
      // artefact already in the registry is a no-op on the wire and re-runs every
      // verification, which is what makes this safe to type twice.
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
          // Buffered until now precisely so that a successful build is three lines
          // and a failed one is the whole log.
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
        // What a compose file and `docker run` take. The tag is beside it for a
        // human; this is the identity.
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

  // Only after every artefact check has passed. Pushing an image that failed a
  // check would put it one `docker pull` away from any machine on the network,
  // which is the opposite of what a gate is for.
  if (options.push && built === ARTEFACTS.length && failures.length === 0) {
    await pushAll(images, registry);
  }

  if (built === ARTEFACTS.length && failures.length === 0) {
    const manifest = {
      schema: MANIFEST_SCHEMA,
      builtAt: new Date().toISOString(),
      commit: git,
      toolchain: { node: process.version, dockerServer: server },
      // Stated in the artefact itself so that nobody reading the manifest has to
      // find this file to learn what kind of digest they are looking at.
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

/**
 * True when this file was started from the command line rather than imported.
 *
 * realpath on both sides, matching `scripts/reliability-drills.mjs`, so a checkout
 * reached through a symlink still recognises itself — `pnpm`'s workspace layout is
 * a farm of them. A path that cannot be resolved is treated as "not us": the cost
 * of being wrong in that direction is a script that does nothing, and the cost of
 * being wrong in the other is an unattended `docker build`.
 */
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

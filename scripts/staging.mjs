#!/usr/bin/env node
/**
 * Brings up, verifies and gates promotion of the staging stack.
 *
 * Invoked by `pnpm run staging <command>`.
 *
 * ## The defect this exists for
 *
 * There was no way to run this application the way it ships. `docker-compose.yml`
 * is a development stack and says so: plaintext on loopback,
 * `NODE_ENV=development`, dev credentials in plain sight, and `build:` sections
 * that make a new image every time. So every production-only behaviour — the
 * `Secure`, `__Host-`-prefixed session cookie; the config refusals that fire only
 * when `NODE_ENV=production`; TLS termination; `TRUST_PROXY` and the rate-limit
 * bucketing that depends on it; the WebSocket upgrade through a real proxy — was
 * first exercised in production, by users.
 *
 * This script is the rehearsal. It runs the artefacts
 * `pnpm run release:artifacts` built, by digest, against a production-shaped
 * stack, then proves four things that only a running deployment can prove:
 *
 *   1. the containers docker actually started are running the manifest's digests
 *      and nothing else;
 *   2. the https origin serves, and its certificate chain verifies against the
 *      local CA rather than being waved through;
 *   3. the proxy OVERWRITES `X-Forwarded-For` rather than appending to it, which
 *      is the single assumption that makes `TRUST_PROXY=true` safe;
 *   4. the smoke test passes end to end over TLS, including a real WebSocket
 *      upgrade and a hand played to completion.
 *
 * ## `promote` is a verifier, not a deployer
 *
 * There is no container registry and no deployment target in this project today.
 * `promote` therefore checks the one thing that can be checked here — that the
 * digest about to go to production is byte-for-byte the digest staging tested,
 * and that staging's verification actually passed — and then says so and stops.
 * It does not push, it does not deploy, and it does not pretend to. When a
 * registry and a target exist, the deploy step goes AFTER this check and consumes
 * its output; the check itself does not change.
 *
 * ## What this does NOT prove
 *
 * Capacity, of anything. One replica on one machine with a database on the same
 * kernel is not a load test; `scripts/load-test.mjs` says the same about itself.
 * It does not rehearse a deploy identity either: migrations here run as the
 * cluster owner, the way `.github/workflows/ci.yml` does, because this stack
 * creates its own throwaway cluster on every bring-up. A real deployment migrates
 * as `prl_deployer` (docs/RUNBOOK.md §5, §11.3). The RUNTIME identity IS
 * rehearsed — the API connects as `prl_api`, a member of `prl_app` and nothing
 * else — and that is the one whose missing GRANT would otherwise surface in
 * production.
 *
 * Usage:
 *     node scripts/staging.mjs init      [--rotate] [--origin https://localhost:8443]
 *     node scripts/staging.mjs up        [--manifest <path>] [--no-smoke]
 *     node scripts/staging.mjs status    [--json]
 *     node scripts/staging.mjs smoke
 *     node scripts/staging.mjs logs      [--service <name>] [--tail <n>]
 *     node scripts/staging.mjs down      [--volumes]
 *     node scripts/staging.mjs promote   [--manifest <path>] [--json]
 *
 * Exit codes: 0 the command succeeded, 1 anything else (including a refused
 * promotion). 0 for --help.
 */

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const NO_COLOR = process.env.NO_COLOR !== undefined || !process.stdout.isTTY;
const paint = (code, s) => (NO_COLOR ? s : `\u001b[${code}m${s}\u001b[0m`);
const dim = (s) => paint('2', s);
const bold = (s) => paint('1', s);
const red = (s) => paint('31', s);
const green = (s) => paint('32', s);
const yellow = (s) => paint('33', s);

// --- layout ---------------------------------------------------------------

const STAGING_DIR = join(REPO_ROOT, 'deploy', 'staging');
const TLS_DIR = join(STAGING_DIR, 'tls');
const ENV_FILE = join(STAGING_DIR, '.env.staging');
const COMPOSE_FILE = join(REPO_ROOT, 'docker-compose.staging.yml');
const ATTESTATION_FILE = join(STAGING_DIR, 'staging-verified.json');

const CA_CERT = join(TLS_DIR, 'staging-ca.pem');
const CA_KEY = join(TLS_DIR, 'staging-ca-key.pem');
const LEAF_CERT = join(TLS_DIR, 'staging-cert.pem');
const LEAF_KEY = join(TLS_DIR, 'staging-key.pem');
const CHAIN = join(TLS_DIR, 'staging-chain.pem');

const DEFAULTS = {
  manifest: 'deploy/staging/release-manifest.json',
  origin: 'https://localhost:8443',
  tail: 200,
};

/** The schema `release-artifacts.mjs` writes. A manifest of any other shape is refused. */
const MANIFEST_SCHEMA = 'prl.release-artifacts.v1';
/** The schema this script writes into the attestation, and `promote` reads back. */
const ATTESTATION_SCHEMA = 'prl.staging-verified.v1';

/** A deployable image reference: a name with a content digest and no tag doing the work. */
const DIGEST_REFERENCE = /^[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$/;

/**
 * How long the local CA and its leaf are good for.
 *
 * 90 days rather than ten years. A staging certificate that never expires is a
 * staging certificate somebody eventually copies somewhere it matters, and an
 * expiry is the cheapest way to make `staging init` a thing that gets re-run.
 */
const CERT_DAYS = 90;

const HELP = `
${bold('pnpm run staging')} — the production-shaped rehearsal stack

  Commands:
    init       generate the local CA, the leaf certificate and the secrets
    up         bring the stack up on the manifest's digests, then verify it
    status     what is running, and whether it matches the manifest
    smoke      run the smoke test against the running stack
    logs       tail the stack's logs
    down       stop the stack
    promote    verify a digest is the one staging tested (does NOT deploy)

  Options:
    --manifest <path>  release manifest to read   (default ${DEFAULTS.manifest})
    --origin <url>     public https origin, init only  (default ${DEFAULTS.origin})
    --rotate           init only: regenerate secrets that already exist
    --no-smoke         up only: skip the smoke test (the stack is then UNVERIFIED)
    --volumes          down only: destroy the database volume as well
    --service <name>   logs only: one service instead of all
    --tail <n>         logs only: how many lines            (default ${DEFAULTS.tail})
    --json             status/promote: machine-readable output
    -h, --help         this text

  The first run is:

      pnpm run staging init
      pnpm run release:artifacts
      pnpm run staging up

  Secrets live in deploy/staging/.env.staging and certificate material in
  deploy/staging/tls/. Both are gitignored and dockerignored; neither is ever
  baked into an image.

  Exit codes: 0 success, 1 failure or a refused promotion.
`;

// --- options --------------------------------------------------------------

const COMMANDS = ['init', 'up', 'status', 'smoke', 'logs', 'down', 'promote'];

function parseArgs(argv) {
  const options = {
    command: null,
    manifest: DEFAULTS.manifest,
    origin: DEFAULTS.origin,
    rotate: false,
    smoke: true,
    volumes: false,
    service: null,
    tail: DEFAULTS.tail,
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
    // `pnpm run staging -- up` forwards the `--` itself.
    if (arg === '--') continue;
    if (!arg.startsWith('-')) {
      if (options.command !== null)
        throw new Error(`only one command at a time, got "${arg}" after "${options.command}"`);
      if (!COMMANDS.includes(arg)) throw new Error(`unknown command ${arg} (one of ${COMMANDS.join(', ')})`);
      options.command = arg;
      continue;
    }
    switch (arg) {
      case '-h':
      case '--help':
        options.help = true;
        break;
      case '--manifest':
        options.manifest = next();
        break;
      case '--origin':
        options.origin = next();
        break;
      case '--rotate':
        options.rotate = true;
        break;
      case '--no-smoke':
        options.smoke = false;
        break;
      case '--volumes':
        options.volumes = true;
        break;
      case '--service':
        options.service = next();
        break;
      case '--tail':
        options.tail = Number(next());
        break;
      case '--json':
        options.json = true;
        break;
      default:
        throw new Error(`unknown option ${arg} (try --help)`);
    }
  }
  if (!Number.isInteger(options.tail) || options.tail < 1) {
    throw new Error('--tail must be a positive whole number of lines');
  }
  const originCheck = parseHttpsOrigin(options.origin);
  if ('problem' in originCheck) throw new Error(`--origin ${originCheck.problem}`);
  return options;
}

/**
 * Parses the public origin and refuses anything the API would refuse.
 *
 * `config.ts` rejects a plaintext `PUBLIC_WEB_ORIGIN` in production, rejects a
 * path, and matches origins exactly. Catching those here means the operator is
 * told which variable is wrong instead of watching every WebSocket close 4406.
 */
function parseHttpsOrigin(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { problem: `"${raw}" is not a URL` };
  }
  if (url.protocol !== 'https:') {
    return { problem: `"${raw}" must be https — the API refuses a plaintext origin in production` };
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    return { problem: `"${raw}" must be a bare origin with no path (drop "${url.pathname}")` };
  }
  return { origin: url.origin, hostname: url.hostname, port: url.port === '' ? '443' : url.port };
}

// --- output ---------------------------------------------------------------

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
const section = (name) => console.log(bold(`\n${name}`));

// --- processes ------------------------------------------------------------

function run(command, args, { stream = false, input, env = process.env, cwd = REPO_ROOT } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...(input === undefined ? {} : { input }),
    stdio: stream
      ? ['ignore', 'inherit', 'inherit']
      : [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  return {
    status: result.status === null ? 1 : result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function capture(command, args) {
  const result = run(command, args);
  return result.status === 0 ? result.stdout.trim() : null;
}

/**
 * Every compose invocation, with the environment file attached.
 *
 * Compose interpolation is file-wide, so `ps` and `down` need the same variables
 * `up` does — see the header of docker-compose.staging.yml. Attaching the file
 * here rather than at each call site is what makes `pnpm run staging down` work
 * when a bare `docker compose -f docker-compose.staging.yml down` would refuse
 * with "required variable PRL_API_IMAGE is missing".
 */
function compose(args, options = {}) {
  return run('docker', ['compose', '--env-file', ENV_FILE, '-f', COMPOSE_FILE, ...args], options);
}

// --- the environment file -------------------------------------------------

/**
 * Reads `KEY=value` lines. Deliberately not a dotenv implementation: no quoting,
 * no interpolation, no `export` prefix, because this file is written by this
 * script and read by compose, and both of those agree on the simple form. A value
 * that needed quoting would be a value that should not be here.
 */
function readEnvFile() {
  if (!existsSync(ENV_FILE)) return new Map();
  const entries = new Map();
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const trimmedLine = line.trim();
    if (trimmedLine === '' || trimmedLine.startsWith('#')) continue;
    const eq = trimmedLine.indexOf('=');
    if (eq <= 0) continue;
    entries.set(trimmedLine.slice(0, eq), trimmedLine.slice(eq + 1));
  }
  return entries;
}

function writeEnvFile(entries) {
  const header = [
    '# Staging environment. GENERATED by `pnpm run staging init` and updated by',
    '# `pnpm run staging up`; gitignored by deploy/staging/.gitignore and kept out',
    '# of every image layer by .dockerignore.',
    '#',
    '# Every variable in docker-compose.staging.yml is required and none has a',
    '# default, so this file has to exist before any compose command against that',
    '# file will run. That is deliberate: a defaulted secret is a secret in a public',
    '# repository that works.',
    '#',
    '# PRL_API_IMAGE and PRL_WEB_IMAGE are rewritten from the release manifest on',
    '# every `staging up`. Editing them by hand defeats the point of the manifest.',
    '',
  ].join('\n');
  const body = [...entries].map(([key, value]) => `${key}=${value}`).join('\n');
  mkdirSync(STAGING_DIR, { recursive: true });
  writeFileSync(ENV_FILE, `${header}${body}\n`, { mode: 0o600 });
}

/**
 * A generated secret, in hex.
 *
 * Hex and not base64url, and the reason is not aesthetic. `config.ts` refuses any
 * secret containing "change", "example", "placeholder", "insecure", "password",
 * "secret", "default", "todo", "xxxx", "test" or "dev-only", and it applies that
 * rule to METRICS_TOKEN in every environment, not just production. The hex
 * alphabet cannot spell any of those words — every one of them needs a letter
 * outside a-f — so a hex secret can never be rejected as a placeholder, while a
 * random base64url string can be, rarely, and only on somebody else's machine.
 *
 * 32 bytes is 64 hex characters, comfortably past the 32-character floor, and the
 * distinct-character check (12 minimum) is satisfied by any realistic draw; it is
 * asserted rather than assumed below.
 */
function generateSecret() {
  for (let attempt = 0; attempt < 8; attempt++) {
    const value = randomBytes(32).toString('hex');
    if (new Set(value).size >= 12) return value;
  }
  throw new Error('could not generate a secret with enough distinct characters, which should be impossible');
}

// --- TLS ------------------------------------------------------------------

function opensslAvailable() {
  return capture('openssl', ['version']) !== null;
}

/**
 * Generates a local CA and a leaf certificate for the staging origin.
 *
 * ## Why a generated CA rather than the proxy's own
 *
 * Caddy would mint this itself with `tls internal` and no host tooling at all.
 * It cannot be used here — see the header of deploy/staging/nginx.conf for the
 * measured reason (its binary carries `cap_net_bind_service`, and Linux refuses
 * to exec such a file under `cap_drop: ALL`). So the certificate is generated
 * here instead, into a directory that is gitignored and dockerignored, and the
 * smoke test is pointed at the CA through `NODE_EXTRA_CA_CERTS` so that the chain
 * is actually VERIFIED rather than skipped. A rehearsal that disables certificate
 * verification has not rehearsed TLS.
 *
 * ## RSA, not an elliptic curve
 *
 * P-256 would be smaller and faster. RSA-2048 is what every OpenSSL and LibreSSL
 * in the wild spells the same way, and this runs on developer machines and on CI
 * runners. A key generated in 200 ms once every 90 days is not worth a
 * portability question.
 *
 * ## The leaf key's permissions
 *
 * 0644, and that deserves a sentence rather than a shrug. nginx runs as uid 101
 * inside the container and reads the key through a bind mount; on Linux a
 * 0600 file owned by the host user is unreadable to it, and the container fails
 * to start with a message about a missing key rather than a permissions problem.
 * This is a throwaway certificate for a loopback origin, regenerated by
 * `staging init`, in a directory git will not accept. A real deployment injects
 * its key through the platform's secret mechanism and never through a bind mount;
 * that is the shape to copy, not this one.
 */
function generateTls(origin) {
  const scratch = mkdtempSync(join(tmpdir(), 'prl-tls-'));
  try {
    mkdirSync(TLS_DIR, { recursive: true });
    const caSubject = '/CN=Poker Risk Lab staging local CA/O=Poker Risk Lab (staging, not for production)';
    const ca = run('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-sha256',
      '-days',
      String(CERT_DAYS),
      '-nodes',
      '-keyout',
      CA_KEY,
      '-out',
      CA_CERT,
      '-subj',
      caSubject,
      // pathlen:0 — this CA may sign leaves and may not sign another CA. A local
      // CA that can mint intermediates is a local CA that can mint anything.
      '-addext',
      'basicConstraints=critical,CA:TRUE,pathlen:0',
      '-addext',
      'keyUsage=critical,keyCertSign,cRLSign',
    ]);
    if (ca.status !== 0) return { problem: `openssl could not create the CA: ${ca.stderr.trim()}` };

    const csr = join(scratch, 'leaf.csr');
    const key = run('openssl', [
      'req',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      LEAF_KEY,
      '-out',
      csr,
      '-subj',
      `/CN=${origin.hostname}`,
    ]);
    if (key.status !== 0) return { problem: `openssl could not create the leaf key: ${key.stderr.trim()}` };

    // The SANs are what a browser and Node actually check; the CN is legacy and
    // is ignored by both. 127.0.0.1 is listed as an IP SAN because a reader who
    // types the address rather than the name is not a different user.
    const sans = [`DNS:${origin.hostname}`];
    if (origin.hostname !== 'localhost') sans.push('DNS:localhost');
    sans.push('IP:127.0.0.1');
    const extFile = join(scratch, 'leaf.ext');
    writeFileSync(
      extFile,
      [
        `subjectAltName=${sans.join(',')}`,
        'basicConstraints=critical,CA:FALSE',
        'keyUsage=critical,digitalSignature,keyEncipherment',
        'extendedKeyUsage=serverAuth',
        '',
      ].join('\n'),
    );

    const sign = run('openssl', [
      'x509',
      '-req',
      '-in',
      csr,
      '-CA',
      CA_CERT,
      '-CAkey',
      CA_KEY,
      '-CAcreateserial',
      '-days',
      String(CERT_DAYS),
      '-sha256',
      '-out',
      LEAF_CERT,
      '-extfile',
      extFile,
    ]);
    if (sign.status !== 0) return { problem: `openssl could not sign the leaf: ${sign.stderr.trim()}` };

    // Leaf first, then the CA: the order a TLS server must present a chain in.
    writeFileSync(CHAIN, `${readFileSync(LEAF_CERT, 'utf8')}${readFileSync(CA_CERT, 'utf8')}`);
    chmodSync(CA_KEY, 0o600);
    chmodSync(LEAF_KEY, 0o644);
    chmodSync(CHAIN, 0o644);

    // Verified here rather than trusted: a chain that does not verify would show
    // up much later as an opaque UNABLE_TO_VERIFY_LEAF_SIGNATURE from the smoke
    // test, three layers away from the thing that is actually wrong.
    const verify = run('openssl', ['verify', '-CAfile', CA_CERT, LEAF_CERT]);
    if (verify.status !== 0) {
      return {
        problem: `the generated chain does not verify: ${verify.stdout.trim()} ${verify.stderr.trim()}`,
      };
    }
    return { sans };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Days until the leaf expires, or null if that cannot be read. */
function certificateDaysRemaining() {
  if (!existsSync(LEAF_CERT)) return null;
  const raw = capture('openssl', ['x509', '-in', LEAF_CERT, '-noout', '-enddate']);
  if (raw === null) return null;
  const value = raw.split('=')[1];
  if (value === undefined) return null;
  const expiry = Date.parse(value);
  if (Number.isNaN(expiry)) return null;
  return Math.floor((expiry - Date.now()) / 86_400_000);
}

// --- HTTPS against the local CA ------------------------------------------

/**
 * One request to the staging origin, trusting the local CA and nothing else.
 *
 * `node:https` rather than `fetch`, because the certificate authority has to be
 * supplied per request: `NODE_EXTRA_CA_CERTS` is read once at process start and
 * this process starts before the CA exists on a first run. Trusting exactly the
 * generated CA — rather than disabling verification — is what makes the TLS check
 * a check.
 */
function httpsCall(origin, path, { method = 'GET', headers = {}, body } = {}) {
  const url = new URL(path, origin.origin);
  return new Promise((resolveCall) => {
    const req = httpsRequest(
      {
        method,
        host: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: body === undefined ? headers : { ...headers, 'content-length': Buffer.byteLength(body) },
        ca: readFileSync(CA_CERT),
        // The certificate is issued for `origin.hostname`; asking for it by any
        // other name should fail, and does.
        servername: url.hostname,
        timeout: 15_000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text === '' ? null : JSON.parse(text);
          } catch {
            json = null;
          }
          resolveCall({ status: res.statusCode ?? 0, headers: res.headers, text, json, error: null });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (err) => resolveCall({ status: 0, headers: {}, text: '', json: null, error: err }));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- compose state --------------------------------------------------------

const SERVICES = ['postgres', 'api', 'web', 'proxy'];

/** Container id, state, health and running image digest for one service. */
function serviceState(name) {
  const id = capture('docker', ['compose', '--env-file', ENV_FILE, '-f', COMPOSE_FILE, 'ps', '-q', name]);
  if (id === null || id === '') return { name, id: null, state: 'absent', health: 'none', image: null };
  const raw = capture('docker', [
    'inspect',
    id,
    '--format',
    '{{.State.Status}}\t{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}\t{{.Image}}',
  ]);
  if (raw === null) return { name, id, state: 'unknown', health: 'none', image: null };
  const [state, health, image] = raw.split('\t');
  return { name, id, state: state ?? 'unknown', health: health ?? 'none', image: image ?? null };
}

/**
 * Waits until every named service is running and (where it has one) healthy.
 *
 * A service that has exited is reported immediately rather than waited out: a
 * container that is never coming back is not a slow container, and the eight
 * minutes spent discovering that is eight minutes nobody spends reading its log.
 */
async function waitForHealthy(names, timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let last = '';
  for (;;) {
    const states = names.map(serviceState);
    const bad = states.find((s) => s.state === 'exited' || s.state === 'dead');
    if (bad !== undefined) return { ok: false, states, reason: `${bad.name} ${bad.state}` };
    const pending = states.filter(
      (s) => s.state !== 'running' || (s.health !== 'none' && s.health !== 'healthy'),
    );
    if (pending.length === 0) return { ok: true, states, reason: null };
    const summary = pending.map((s) => `${s.name}:${s.state}/${s.health}`).join(' ');
    if (summary !== last) {
      console.log(dim(`      waiting — ${summary}`));
      last = summary;
    }
    if (Date.now() > deadline) {
      return { ok: false, states, reason: `timed out after ${timeoutSeconds}s waiting for ${summary}` };
    }
    await sleep(2_000);
  }
}

// --- the manifest ---------------------------------------------------------

function readManifest(path) {
  const full = resolve(REPO_ROOT, path);
  if (!existsSync(full)) {
    return {
      problem:
        `no release manifest at ${path}. Build the artefacts first:\n      pnpm run release:artifacts\n` +
        '      This stack deploys by digest and cannot build anything, which is the point.',
    };
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(full, 'utf8'));
  } catch (err) {
    return { problem: `${path} is not valid JSON: ${err.message}` };
  }
  if (manifest?.schema !== MANIFEST_SCHEMA) {
    return { problem: `${path} is not a ${MANIFEST_SCHEMA} manifest (got ${String(manifest?.schema)})` };
  }
  for (const service of ['api', 'web']) {
    const reference = manifest?.images?.[service]?.reference;
    if (typeof reference !== 'string' || !DIGEST_REFERENCE.test(reference)) {
      return {
        problem:
          `${path} does not give service "${service}" a digest reference. Got ${String(reference)}. ` +
          'Staging deploys by digest and refuses a tag: a tag is a pointer, and the whole ' +
          'build-once-promote-the-same-bytes chain depends on this being content-addressed.',
      };
    }
  }
  return { manifest };
}

// --- commands -------------------------------------------------------------

function commandInit(options) {
  section('staging init');
  if (!opensslAvailable()) {
    cross(
      'openssl is not on PATH',
      'the staging origin is https and its certificate is generated here. Install openssl, or ' +
        'supply deploy/staging/tls/staging-chain.pem and staging-key.pem yourself.',
    );
    return;
  }

  const origin = parseHttpsOrigin(options.origin);
  const entries = readEnvFile();
  const setIfAbsent = (key, value) => {
    if (options.rotate || !entries.has(key)) {
      entries.set(key, value);
      return true;
    }
    return false;
  };

  // Non-secret settings. Rewritten on every init so that `--origin` takes effect.
  entries.set('PRL_STAGING_PUBLIC_ORIGIN', origin.origin);
  entries.set('PRL_STAGING_HTTPS_PORT', origin.port);
  // Not 5432: the development stack publishes that one, and staging exists to be
  // compared against the development stack, which means both have to run at once.
  if (!entries.has('PRL_STAGING_DB_PORT')) entries.set('PRL_STAGING_DB_PORT', '55432');
  if (!entries.has('PRL_STAGING_DB_NAME')) entries.set('PRL_STAGING_DB_NAME', 'poker_risk_lab_staging');
  if (!entries.has('PRL_STAGING_DB_SUPERUSER')) entries.set('PRL_STAGING_DB_SUPERUSER', 'prl_staging_owner');
  // The runtime identity, and the name matters: RUNBOOK §5 calls it prl_api and
  // development should rehearse the deployment's shape rather than a parallel one.
  if (!entries.has('PRL_STAGING_API_DB_USER')) entries.set('PRL_STAGING_API_DB_USER', 'prl_api');
  if (!entries.has('PRL_STAGING_LOG_LEVEL')) entries.set('PRL_STAGING_LOG_LEVEL', 'info');
  // Placeholders until `staging up` reads the manifest. Written so that compose
  // commands do not fail on a missing variable before the first build.
  if (!entries.has('PRL_API_IMAGE')) entries.set('PRL_API_IMAGE', 'prl-api@sha256:0'.padEnd(23, '0'));
  if (!entries.has('PRL_WEB_IMAGE')) entries.set('PRL_WEB_IMAGE', 'prl-web@sha256:0'.padEnd(23, '0'));

  const generated = [];
  for (const key of [
    'PRL_STAGING_DB_SUPERUSER_PASSWORD',
    'PRL_STAGING_API_DB_PASSWORD',
    'PRL_STAGING_SESSION_COOKIE_SECRET',
    'PRL_STAGING_METRICS_TOKEN',
  ]) {
    if (setIfAbsent(key, generateSecret())) generated.push(key);
  }
  writeEnvFile(entries);
  tick(
    'wrote deploy/staging/.env.staging (mode 0600)',
    generated.length === 0
      ? 'every secret already existed and was left alone; pass --rotate to replace them'
      : `generated ${generated.length} secret(s): ${generated.join(', ')}`,
  );

  const tls = generateTls(origin);
  if ('problem' in tls) {
    cross('certificate generation failed', tls.problem);
    return;
  }
  tick(
    `generated a local CA and a leaf for ${origin.origin}`,
    `valid ${CERT_DAYS} days, SANs ${tls.sans.join(', ')}, chain verified against the CA`,
  );
  console.log(
    dim(
      '\n  Nothing generated here is committed: deploy/staging/.gitignore covers tls/ and\n' +
        '  .env.staging, and .dockerignore keeps the whole deploy/ directory out of every\n' +
        '  image build context.\n\n' +
        '  Next: pnpm run release:artifacts, then pnpm run staging up\n',
    ),
  );
}

/**
 * Creates the login identities the way a deployment does.
 *
 * `db/seeds/0002_dev_login_roles.sql` does this for development with a password
 * from version control, and refuses to run when `NODE_ENV=production` — which is
 * exactly right, and is why staging cannot use it. So the same shape is applied
 * here with a generated password, through psql inside the postgres container.
 *
 * The SQL arrives on stdin and the superuser password never leaves the container,
 * so neither credential appears in any process's argv on the host.
 */
function provisionRoles(entries) {
  const apiUser = entries.get('PRL_STAGING_API_DB_USER');
  const apiPassword = entries.get('PRL_STAGING_API_DB_PASSWORD');
  const sql = `
\\set ON_ERROR_STOP on
DO $prl$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = '${apiUser}') THEN
    EXECUTE format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', '${apiUser}', '${apiPassword}');
  ELSE
    EXECUTE format('ALTER ROLE %I PASSWORD %L', '${apiUser}', '${apiPassword}');
  END IF;
  IF NOT pg_catalog.pg_has_role('${apiUser}', 'prl_app', 'MEMBER') THEN
    EXECUTE format('GRANT prl_app TO %I', '${apiUser}');
  END IF;
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), '${apiUser}');
END
$prl$;

DO $prl$
BEGIN
  IF NOT pg_catalog.has_schema_privilege('${apiUser}', 'prl', 'USAGE') THEN
    RAISE EXCEPTION 'the runtime identity has no USAGE on schema prl: its membership in prl_app is missing';
  END IF;
  IF pg_catalog.has_schema_privilege('${apiUser}', 'prl', 'CREATE') THEN
    RAISE EXCEPTION 'the runtime identity holds CREATE on schema prl, which is more than the request path needs';
  END IF;
END
$prl$;
`;
  return run(
    'docker',
    [
      'compose',
      '--env-file',
      ENV_FILE,
      '-f',
      COMPOSE_FILE,
      'exec',
      '-T',
      'postgres',
      'sh',
      '-c',
      'PGPASSWORD="$POSTGRES_PASSWORD" psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" ' +
        '--set ON_ERROR_STOP=1 --quiet --file -',
    ],
    { input: sql },
  );
}

/**
 * Proves the proxy overwrites `X-Forwarded-For` instead of appending to it.
 *
 * ## Why this needs proving at all
 *
 * The API runs with `TRUST_PROXY=true` here, which means Fastify takes
 * `request.ip` from the leftmost `X-Forwarded-For` value. Guest creation is rate
 * limited on that address (`clientKeyedRateLimit`, ten per minute) precisely
 * because the endpoint hands out a fresh session cookie and a session-keyed limit
 * would never accumulate. So if the proxy used `$proxy_add_x_forwarded_for` — the
 * spelling most nginx configurations on the internet use — a client could send
 * its own `X-Forwarded-For`, land in a fresh bucket on every request, and create
 * guests without limit. The header comment in the nginx config asserts this is
 * handled; a comment is not a control.
 *
 * ## The experiment
 *
 * Send more than the limit's worth of guest creations through the proxy, each
 * with a DIFFERENT forged `X-Forwarded-For`. If the forged header were believed,
 * every request would be its own bucket and none would ever be refused. Observing
 * a 429 therefore proves the forged values were discarded.
 *
 * It runs AFTER the smoke test, which has already exhausted the real bucket for
 * this client. That makes the proof strictly stronger: with the genuine bucket
 * known to be empty, a success from a forged address could ONLY have come from
 * bucket-hopping.
 *
 * The 403 case is not a hole: CSRF is a `preHandler` and the rate limit is an
 * `onRequest` hook, so a refused request is counted before it is rejected — which
 * is why a token is fetched first anyway, so that the requests are legitimate in
 * every respect except the header under test.
 */
async function proveForwardedForIsOverwritten(origin) {
  const seed = await httpsCall(origin, '/api/v1/auth/session', { headers: { accept: 'application/json' } });
  if (seed.status !== 200) {
    cross('X-Forwarded-For proof could not start', `GET /auth/session answered ${seed.status}`);
    return;
  }
  const cookies = (seed.headers['set-cookie'] ?? [])
    .map((raw) => raw.split(';')[0])
    .filter((pair) => typeof pair === 'string' && pair.includes('='));
  const csrf = typeof seed.json?.csrfToken === 'string' ? seed.json.csrfToken : '';
  if (csrf === '' || cookies.length === 0) {
    cross('X-Forwarded-For proof could not start', 'no CSRF token or cookie from GET /auth/session');
    return;
  }

  const attempts = 24;
  let refused = 0;
  let acceptedFromForgedAddress = null;
  for (let i = 0; i < attempts; i++) {
    // TEST-NET-3 (203.0.113.0/24, RFC 5737). Documentation addresses, so nothing
    // here can be mistaken for a real client if it turns up in a log.
    const forged = `203.0.113.${(i % 250) + 1}`;
    const response = await httpsCall(origin, '/api/v1/auth/guest', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        origin: origin.origin,
        cookie: cookies.join('; '),
        'x-csrf-token': csrf,
        'x-forwarded-for': forged,
      },
      body: JSON.stringify({ displayName: `Xff${i}` }),
    });
    if (response.status === 429) refused += 1;
    else if (response.status === 200 || response.status === 201) acceptedFromForgedAddress = forged;
  }

  if (refused === 0) {
    cross(
      'the proxy did NOT overwrite X-Forwarded-For',
      `${attempts} guest creations with ${attempts} different forged client addresses were all accepted ` +
        `(last: ${acceptedFromForgedAddress ?? 'unknown'}). With TRUST_PROXY=true the API believes the ` +
        'leftmost X-Forwarded-For, so a client is choosing its own rate-limit bucket. Fix the ' +
        'proxy_set_header X-Forwarded-For line in deploy/staging/nginx.conf: it must be $remote_addr, ' +
        'never $proxy_add_x_forwarded_for.',
    );
    return;
  }
  tick(
    'the proxy overwrites X-Forwarded-For rather than appending to it',
    `${refused}/${attempts} guest creations from distinct forged client addresses were rate limited, ` +
      'so the forged header did not choose a bucket',
  );
}

async function commandUp(options) {
  section('staging up');

  if (!existsSync(ENV_FILE) || !existsSync(CHAIN)) {
    cross(
      'staging has not been initialised',
      'run `pnpm run staging init` first — it generates the local CA, the leaf certificate and the ' +
        'secrets, none of which are committed.',
    );
    return;
  }
  const remaining = certificateDaysRemaining();
  if (remaining !== null && remaining < 0) {
    cross(`the staging certificate expired ${-remaining} day(s) ago`, 'run `pnpm run staging init` again');
    return;
  }
  if (remaining !== null && remaining < 14) {
    bang(`the staging certificate expires in ${remaining} day(s)`, 'run `pnpm run staging init` to renew it');
  }

  const read = readManifest(options.manifest);
  if ('problem' in read) {
    cross('no usable release manifest', read.problem);
    return;
  }
  const manifest = read.manifest;
  const entries = readEnvFile();
  entries.set('PRL_API_IMAGE', manifest.images.api.reference);
  entries.set('PRL_WEB_IMAGE', manifest.images.web.reference);
  writeEnvFile(entries);
  tick(
    'deploying the manifest digests',
    `api ${manifest.images.api.digest}\n      web ${manifest.images.web.digest}\n      built ` +
      `${manifest.builtAt} from ${manifest.commit?.sha ?? 'an unknown commit'}` +
      `${manifest.commit?.dirty === true ? ' (DIRTY WORKING TREE)' : ''}`,
  );

  const origin = parseHttpsOrigin(entries.get('PRL_STAGING_PUBLIC_ORIGIN') ?? DEFAULTS.origin);
  if ('problem' in origin) {
    cross('PRL_STAGING_PUBLIC_ORIGIN is unusable', origin.problem);
    return;
  }
  if (origin.port !== entries.get('PRL_STAGING_HTTPS_PORT')) {
    cross(
      'PRL_STAGING_PUBLIC_ORIGIN and PRL_STAGING_HTTPS_PORT disagree',
      `the origin says port ${origin.port}, the published port is ${entries.get('PRL_STAGING_HTTPS_PORT')}. ` +
        'The API matches the origin EXACTLY on CSRF and on every socket upgrade, so a mismatch here ' +
        'presents as "every WebSocket closes 4406" rather than as a configuration error. ' +
        'Re-run `pnpm run staging init --origin <url>`.',
    );
    return;
  }

  // The database first and on its own: migrations run from the host against it
  // before the API is allowed to connect (RUNBOOK §11.3 — the serving image does
  // not ship apps/api/scripts, so it cannot migrate and must not be able to).
  const dbUp = compose(['up', '-d', 'postgres']);
  if (dbUp.status !== 0) {
    cross('could not start postgres', dbUp.stderr.trim() || dbUp.stdout.trim());
    return;
  }
  const dbHealthy = await waitForHealthy(['postgres'], 120);
  if (!dbHealthy.ok) {
    cross('postgres never became healthy', dbHealthy.reason ?? 'unknown');
    console.log(compose(['logs', '--tail', '50', 'postgres']).stdout);
    return;
  }
  tick('postgres is healthy');

  const migrationUrl =
    `postgres://${encodeURIComponent(entries.get('PRL_STAGING_DB_SUPERUSER') ?? '')}:` +
    `${encodeURIComponent(entries.get('PRL_STAGING_DB_SUPERUSER_PASSWORD') ?? '')}` +
    `@127.0.0.1:${entries.get('PRL_STAGING_DB_PORT')}/${entries.get('PRL_STAGING_DB_NAME')}`;
  const migrateEnv = { ...process.env, DATABASE_MIGRATION_URL: migrationUrl, NODE_ENV: 'production' };

  for (const [label, args] of [
    ['roles', ['apps/api/scripts/migrate.mjs', 'roles']],
    ['migrations', ['apps/api/scripts/migrate.mjs', 'up']],
  ]) {
    const result = run(process.execPath, args, { env: migrateEnv });
    if (result.status !== 0) {
      cross(`applying ${label} failed`, `${result.stdout.trim()}\n      ${result.stderr.trim()}`);
      return;
    }
    tick(`${label} applied`);
  }

  const roles = provisionRoles(entries);
  if (roles.status !== 0) {
    cross('could not create the runtime login identity', roles.stderr.trim() || roles.stdout.trim());
    return;
  }
  tick(
    `the API's login identity exists and is bounded`,
    `${entries.get('PRL_STAGING_API_DB_USER')} is a member of prl_app, has USAGE on schema prl and no CREATE`,
  );

  const up = compose(['up', '-d', '--remove-orphans']);
  if (up.status !== 0) {
    cross('could not start the stack', up.stderr.trim() || up.stdout.trim());
    return;
  }

  // `staging init` can renew the certificate while this stack is already up. The
  // certificate directory is a bind mount, but nginx reads the certificate only
  // when it starts; an ordinary `compose up` sees no image/config change and keeps
  // serving the old leaf. Recreate only the proxy so the API/web containers and
  // their exact image digests are untouched, while every `staging up` actually
  // tests the certificate generated for this run.
  const proxyRefresh = compose(['up', '-d', '--force-recreate', 'proxy']);
  if (proxyRefresh.status !== 0) {
    cross('could not reload the TLS proxy', proxyRefresh.stderr.trim() || proxyRefresh.stdout.trim());
    return;
  }
  const healthy = await waitForHealthy(SERVICES, 180);
  if (!healthy.ok) {
    cross('the stack never became healthy', healthy.reason ?? 'unknown');
    for (const service of SERVICES) {
      console.log(bold(`\n--- ${service} ---`));
      console.log(compose(['logs', '--tail', '40', service]).stdout);
    }
    return;
  }
  tick('every service is running and healthy', 'api reports both /api/v1/health and /api/v1/ready');

  // The identity check. Everything above could be true of a stack running some
  // other build; this is the line that says it is running THIS one.
  let digestsMatch = true;
  for (const service of ['api', 'web']) {
    const state = serviceState(service);
    const expected = manifest.images[service].digest;
    if (state.image !== expected) {
      digestsMatch = false;
      cross(
        `the running ${service} container is not the manifest's artefact`,
        `manifest ${expected}\n      running  ${state.image ?? 'unknown'}`,
      );
    }
  }
  if (digestsMatch) {
    tick('both running containers are the manifest digests', 'verified from docker inspect, not from a tag');
  }

  // Readiness through the proxy, over TLS, verified against the local CA.
  let readyStatus = 0;
  for (let attempt = 0; attempt < 30; attempt++) {
    const probe = await httpsCall(origin, '/api/v1/ready');
    readyStatus = probe.status;
    if (probe.status === 200) break;
    if (probe.error !== null && attempt === 0) console.log(dim(`      waiting — ${probe.error.message}`));
    await sleep(2_000);
  }
  if (readyStatus === 200) {
    tick(`${origin.origin}/api/v1/ready answers 200 over TLS`, 'the chain verified against the local CA');
  } else {
    cross(`${origin.origin}/api/v1/ready did not answer 200`, `last status ${readyStatus}`);
  }

  const hsts = (await httpsCall(origin, '/api/v1/health')).headers['strict-transport-security'];
  if (typeof hsts === 'string') tick('the proxy sets Strict-Transport-Security', hsts);
  else cross('no Strict-Transport-Security header', 'the app cannot set it; only the TLS terminator knows');

  let smokePassed = null;
  if (options.smoke) {
    section('smoke test (through the staging origin, over TLS)');
    const smoke = run(process.execPath, ['scripts/smoke-test.mjs', '--origin', origin.origin, '--strict'], {
      stream: true,
      env: {
        ...process.env,
        PRL_WEB_ORIGIN: origin.origin,
        // Read once at process start, which is why the polls above use
        // node:https with an explicit `ca` instead. The smoke test is a fresh
        // process, so the variable works there and the whole run — including the
        // wss:// upgrade — verifies the chain properly.
        NODE_EXTRA_CA_CERTS: CA_CERT,
      },
    });
    smokePassed = smoke.status === 0;
    if (smokePassed) tick('the smoke test passed against the staging origin');
    else cross('the smoke test failed against the staging origin', `exit ${smoke.status}`);

    section('proxy behaviour');
    await proveForwardedForIsOverwritten(origin);
  } else {
    bang(
      'the smoke test was skipped (--no-smoke)',
      'this stack is UNVERIFIED. `pnpm run staging promote` will refuse a digest that no verified ' +
        'run attested to, which is what that flag costs.',
    );
  }

  if (failures.length === 0 && smokePassed === true) {
    const attestation = {
      schema: ATTESTATION_SCHEMA,
      verifiedAt: new Date().toISOString(),
      origin: origin.origin,
      commit: manifest.commit ?? null,
      images: {
        api: { digest: manifest.images.api.digest, reference: manifest.images.api.reference },
        web: { digest: manifest.images.web.digest, reference: manifest.images.web.reference },
      },
      checks: {
        runningDigestsMatchManifest: true,
        tlsChainVerified: true,
        forwardedForOverwritten: true,
        smokeTestStrict: true,
      },
    };
    writeFileSync(ATTESTATION_FILE, `${JSON.stringify(attestation, null, 2)}\n`);
    tick('wrote deploy/staging/staging-verified.json', '`pnpm run staging promote` reads this');
  }
}

function commandStatus(options) {
  const states = SERVICES.map(serviceState);
  const read = existsSync(resolve(REPO_ROOT, options.manifest)) ? readManifest(options.manifest) : null;
  const manifest = read !== null && !('problem' in read) ? read.manifest : null;

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          services: states,
          manifest: manifest === null ? null : { commit: manifest.commit, images: manifest.images },
          attestation: existsSync(ATTESTATION_FILE)
            ? JSON.parse(readFileSync(ATTESTATION_FILE, 'utf8'))
            : null,
        },
        null,
        2,
      ),
    );
    return;
  }

  section('staging status');
  for (const state of states) {
    const label = `${state.name.padEnd(9)} ${state.state}${state.health === 'none' ? '' : `/${state.health}`}`;
    if (state.state === 'running' && (state.health === 'healthy' || state.health === 'none')) tick(label);
    else if (state.state === 'absent') console.log(`${dim('  ○')} ${label}`);
    else bang(label);
    if (state.image !== null) console.log(dim(`      ${state.image}`));
  }
  if (manifest !== null) {
    for (const service of ['api', 'web']) {
      const running = states.find((s) => s.name === service)?.image ?? null;
      const expected = manifest.images[service].digest;
      if (running === null) continue;
      if (running === expected) tick(`${service} matches the manifest`);
      else cross(`${service} does NOT match the manifest`, `manifest ${expected}\n      running  ${running}`);
    }
  }
  console.log(
    dim(
      `\n  attestation  ${existsSync(ATTESTATION_FILE) ? 'present' : 'absent — nothing has been verified'}\n`,
    ),
  );
}

/**
 * Refuses to let a digest reach production unless staging tested that exact digest.
 *
 * This is the whole reason the manifest and the attestation exist as separate
 * files. The manifest says "these are the artefacts for this commit". The
 * attestation says "a staging run brought THOSE UP and everything passed". A
 * promotion is only meaningful when the two agree, so this compares them and
 * prints both digests whenever they do not — because "the digests differ" without
 * the digests is a message that sends somebody to the wrong file.
 */
function commandPromote(options) {
  section('staging promote');

  const read = readManifest(options.manifest);
  if ('problem' in read) {
    cross('no usable release manifest to promote', read.problem);
    return;
  }
  const manifest = read.manifest;

  if (!existsSync(ATTESTATION_FILE)) {
    cross(
      'nothing has been verified in staging',
      'deploy/staging/staging-verified.json does not exist. `pnpm run staging up` writes it only when ' +
        'every check AND the strict smoke test passed, so its absence means no digest has earned a ' +
        'promotion. This is refused rather than warned about.',
    );
    return;
  }
  let attestation;
  try {
    attestation = JSON.parse(readFileSync(ATTESTATION_FILE, 'utf8'));
  } catch (err) {
    cross('the staging attestation is unreadable', err.message);
    return;
  }
  if (attestation?.schema !== ATTESTATION_SCHEMA) {
    cross('the staging attestation has an unexpected schema', String(attestation?.schema));
    return;
  }

  let identical = true;
  for (const service of ['api', 'web']) {
    const candidate = manifest.images[service].digest;
    const tested = attestation.images?.[service]?.digest ?? null;
    if (candidate === tested) {
      tick(`${service} is byte-identical to the digest staging tested`, candidate);
      continue;
    }
    identical = false;
    cross(
      `${service} is NOT the digest staging tested`,
      `about to promote  ${candidate}\n      staging tested    ${tested ?? '(nothing)'}`,
    );
  }

  if (manifest.commit?.dirty === true) {
    cross(
      'the manifest was built from a dirty working tree',
      'the commit sha it records does not describe the bytes that were built, so nothing downstream ' +
        'could reproduce or audit this artefact. Commit, rebuild, re-verify.',
    );
    identical = false;
  }
  if (
    manifest.commit?.sha != null &&
    attestation.commit?.sha != null &&
    manifest.commit.sha !== attestation.commit.sha
  ) {
    // The digests could still match — the same bytes can come from two commits if
    // nothing in the build context changed — so this is reported beside the digest
    // comparison rather than instead of it.
    bang(
      'the manifest and the attestation name different commits',
      `manifest ${manifest.commit.sha}\n      staging  ${attestation.commit.sha}\n      ` +
        'The digests are what promotion turns on, and they are compared above; this is worth knowing ' +
        'because it means the same artefact was produced from two different trees.',
    );
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          promotable: identical && failures.length === 0,
          verifiedAt: attestation.verifiedAt,
          images: manifest.images,
          tested: attestation.images,
        },
        null,
        2,
      ),
    );
  }

  if (identical && failures.length === 0) {
    console.log(
      dim(
        `\n  Verified in staging at ${attestation.verifiedAt} against ${attestation.origin}.\n` +
          '\n  This command VERIFIES; it does not deploy. There is no registry and no production\n' +
          '  target in this repository, so there is nothing here that could push these bytes\n' +
          '  anywhere. When there is, the deploy step goes after this check and consumes these\n' +
          '  digests; this check does not change.\n' +
          '\n  Note also what the digest is: a local BuildKit image-store digest. It is content-\n' +
          '  addressed and cannot be two different images, but nothing signed it and no registry\n' +
          '  vouches for it. Cross-machine promotion needs a registry digest as well.\n',
      ),
    );
  }
}

// --- run ------------------------------------------------------------------

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error(red(`staging — ${err.message}`));
  process.exit(1);
}

if (options.help || options.command === null) {
  console.log(HELP);
  process.exit(options.command === null && !options.help ? 1 : 0);
}

if (capture('docker', ['version', '--format', '{{.Server.Version}}']) === null) {
  console.error(red('\n  ✗ docker is not available, or its daemon is not running.\n'));
  process.exit(1);
}

if (options.command !== 'init' && !existsSync(ENV_FILE)) {
  console.error(
    red('\n  ✗ deploy/staging/.env.staging does not exist.') +
      dim('\n      Every variable in docker-compose.staging.yml is required and none has a default,\n') +
      dim('      so no compose command against it will run without this file. Create it with:\n\n') +
      dim('          pnpm run staging init\n'),
  );
  process.exit(1);
}

switch (options.command) {
  case 'init':
    commandInit(options);
    break;
  case 'up':
    await commandUp(options);
    break;
  case 'status':
    commandStatus(options);
    break;
  case 'smoke': {
    const entries = readEnvFile();
    const origin = parseHttpsOrigin(entries.get('PRL_STAGING_PUBLIC_ORIGIN') ?? DEFAULTS.origin);
    if ('problem' in origin) {
      cross('PRL_STAGING_PUBLIC_ORIGIN is unusable', origin.problem);
      break;
    }
    const smoke = run(process.execPath, ['scripts/smoke-test.mjs', '--origin', origin.origin, '--strict'], {
      stream: true,
      env: { ...process.env, PRL_WEB_ORIGIN: origin.origin, NODE_EXTRA_CA_CERTS: CA_CERT },
    });
    if (smoke.status !== 0) cross('the smoke test failed', `exit ${smoke.status}`);
    else tick('the smoke test passed');
    break;
  }
  case 'logs': {
    const args = ['logs', '--tail', String(options.tail)];
    if (options.service !== null) args.push(options.service);
    compose(args, { stream: true });
    break;
  }
  case 'down': {
    const args = ['down', '--remove-orphans'];
    if (options.volumes) args.push('--volumes');
    const result = compose(args, { stream: true });
    if (result.status !== 0) cross('docker compose down failed', `exit ${result.status}`);
    else {
      tick(options.volumes ? 'the stack is down and its database volume is destroyed' : 'the stack is down');
      // The attestation describes a stack that no longer exists. Leaving it in
      // place would let `promote` vouch for something nobody can look at any more.
      if (existsSync(ATTESTATION_FILE)) {
        rmSync(ATTESTATION_FILE);
        console.log(
          dim('      removed deploy/staging/staging-verified.json — it attested to a running stack'),
        );
      }
    }
    break;
  }
  case 'promote':
    commandPromote(options);
    break;
  default:
    // Unreachable: parseArgs rejects anything outside COMMANDS. Present so the
    // switch is total rather than relying on that from a distance.
    console.error(red(`staging — unhandled command ${options.command}`));
    process.exit(1);
}

if (failures.length > 0) {
  console.log(red(bold(`\nFAIL — ${failures.length} problem(s):`)));
  for (const failure of failures) console.log(red(`    - ${failure}`));
  console.log('');
  process.exit(1);
}
console.log(green(bold(`\nstaging ${options.command}: OK\n`)));

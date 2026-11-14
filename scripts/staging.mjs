#!/usr/bin/env node
/**
 * Brings up, verifies and gates promotion of the staging stack (`pnpm run staging <command>`).
 *
 * It runs the digests `pnpm run release:artifacts` built against a production-shaped stack and
 * proves the running containers match the manifest, the TLS chain verifies against the local CA,
 * the proxy overwrites `X-Forwarded-For`, and the smoke test passes over TLS. `promote` verifies and
 * deploys nothing. It also runs `alert-preflight.mjs`, because rehearsal `PRL_ALERT_*` defaults pass
 * `alerts:verify` and page nobody. Nothing here signs or checks a signature (see `release:sign`).
 * Migrations run as the cluster owner, and the API connects as `prl_api`.
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
 * Exit codes: 0 success or --help, 1 anything else (including a refused promotion).
 */

import { spawnSync } from 'node:child_process';
import { randomBytes, X509Certificate } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { connect as tlsConnect } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { DIGEST, REGISTRY_DIGEST_REFERENCE, verifyRegistryDigest } from './registry-digest.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const NO_COLOR = process.env.NO_COLOR !== undefined || !process.stdout.isTTY;
const paint = (code, s) => (NO_COLOR ? s : `\u001b[${code}m${s}\u001b[0m`);
const dim = (s) => paint('2', s);
const bold = (s) => paint('1', s);
const red = (s) => paint('31', s);
const green = (s) => paint('32', s);
const yellow = (s) => paint('33', s);

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

const MANIFEST_SCHEMA = 'prl.release-artifacts.v1';
const ATTESTATION_SCHEMA = 'prl.staging-verified.v1';

const DIGEST_REFERENCE = /^[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$/;

const RELEASE_SERVICES = ['api', 'web'];

// 90 days, so a staging certificate cannot be copied somewhere it matters for ever.
const CERT_DAYS = 90;

const HELP = `
${bold('pnpm run staging')} — the production-shaped rehearsal stack

  Commands:
    init       generate the local CA, the leaf certificate and the secrets
    up         bring the stack up on the manifest's digests, then verify it
    status     what is running, whether it matches the manifest, and whether the
               proxy serves the certificate on disk
    refresh-tls  recreate ONLY the proxy so it serves the certificate on disk,
                 then check the handshake (run it after \`init\` renews the leaf)
    smoke      run the smoke test against the running stack
    logs       tail the stack's logs
    down       stop the stack
    promote    verify a digest is the one staging tested, and that this deployment
               has a real paging destination (does NOT deploy)

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

  If the manifest carries registry references — \`pnpm run release:artifacts --push\`
  writes them — \`up\` verifies each digest against the registry and then deploys
  the registry reference with \`pull_policy: always\`, and \`promote\` reports the
  artefacts as promotable across machines. With no registry references, or with a
  registry that does not answer, everything falls back to the local digests and
  \`pull_policy: never\`, which is the behaviour this stack has always had.

  \`promote\` also runs \`pnpm run alerts:preflight\`, which refuses a paging
  destination that is a placeholder, malformed, missing a credential or routed to a
  receiver with nothing in it. Run it on its own first — it needs no stack:

      pnpm run alerts:preflight
      pnpm run alerts:preflight -- --handshake   # also prove the relay accepts the credentials

  Exit codes: 0 success, 1 failure or a refused promotion.
`;

const COMMANDS = ['init', 'up', 'status', 'refresh-tls', 'smoke', 'logs', 'down', 'promote'];

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

// Mirrors `config.ts`'s origin refusals so the operator learns which variable is wrong.
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

// Compose interpolation is file-wide, so `ps` and `down` need the same env file as `up`.
function compose(args, options = {}) {
  return run('docker', ['compose', '--env-file', ENV_FILE, '-f', COMPOSE_FILE, ...args], options);
}

// The HSTS probe uses a path the API does not serve. On `/api/v1/health` the API set its own header,
// nginx's `add_header` appended a second, and the check passed with nginx's line deleted.
// HSTS_EXPECTED must match the `add_header` line in `deploy/staging/nginx.conf`.
export const HSTS_PROBE_PATH = '/';
export const HSTS_EXPECTED = 'max-age=31536000';

// `res.headers` folds duplicates into one string, so the raw list is the only way to count them.
export function hstsFromRawHeaders(rawHeaders) {
  const values = [];
  const list = Array.isArray(rawHeaders) ? rawHeaders : [];
  for (let i = 0; i + 1 < list.length; i += 2) {
    if (String(list[i]).toLowerCase() === 'strict-transport-security')
      values.push(String(list[i + 1]).trim());
  }
  return values;
}

// nginx reads the bind-mounted certificate only at start, so a renewed leaf needs the proxy recreated.
// Only the proxy: the API and web containers stay pinned by digest.
export const PROXY_REFRESH_COMPOSE_ARGS = Object.freeze(['up', '-d', '--force-recreate', 'proxy']);

export function refreshStagingProxy(runCompose) {
  if (typeof runCompose !== 'function') {
    throw new Error('refreshStagingProxy requires the compose runner this file uses in production');
  }
  const args = [...PROXY_REFRESH_COMPOSE_ARGS];
  const services = args.filter((arg) => !arg.startsWith('-'));
  // Naming `api` or `web` would recreate the artefacts `staging up` just pinned by digest.
  if (!args.includes('--force-recreate') || services[0] !== 'up' || services.slice(1).join() !== 'proxy') {
    throw new Error(`proxy refresh must be \`up -d --force-recreate proxy\`; got ${JSON.stringify(args)}`);
  }
  return runCompose(args);
}

// A renewed leaf on disk proves nothing about the handshake: `init` writes new files while a running
// proxy keeps serving the old ones, so the check compares what the origin presents on a handshake.
export const CERT_WARN_DAYS = 14;

export function servedCertificateVerdict({ served, disk, now }) {
  const days = (validTo) => Math.floor((Date.parse(validTo) - now) / 86_400_000);
  if ('problem' in served) {
    return [{ level: 'cross', line: 'could not read the certificate the proxy serves', detail: served.problem }];
  }
  const servedExpiry = `expires ${served.validTo} (${days(served.validTo)} day(s))`;
  const findings = [];
  if (disk === null) {
    findings.push({ level: 'bang', line: 'no deploy/staging/tls/staging-cert.pem to compare with', detail: servedExpiry });
  } else if (served.fingerprint256 !== disk.fingerprint256) {
    findings.push({
      level: 'cross',
      line: 'the proxy serves a different certificate from deploy/staging/tls/staging-cert.pem',
      detail:
        `served  ${servedExpiry}\n      on disk expires ${disk.validTo} (${days(disk.validTo)} day(s))\n` +
        '      `pnpm run staging refresh-tls` loads the one on disk; it recreates only the proxy',
    });
  }
  if (!served.authorized) {
    findings.push({
      level: 'cross',
      line: 'the served chain does not verify against deploy/staging/tls/staging-ca.pem',
      detail: `${served.authorizationError ?? 'unknown error'}: the smoke test and anything trusting that CA will refuse it`,
    });
  }
  const remaining = days(served.validTo);
  const renewedOnDisk =
    disk !== null && disk.fingerprint256 !== served.fingerprint256 && days(disk.validTo) >= CERT_WARN_DAYS;
  const fix = renewedOnDisk
    ? 'the one on disk is already renewed; `pnpm run staging refresh-tls` loads it'
    : 'renew with `pnpm run staging init`, then `pnpm run staging refresh-tls`';
  if (remaining < 0) {
    findings.push({ level: 'cross', line: `the served certificate expired ${-remaining} day(s) ago`, detail: fix });
  } else if (remaining < CERT_WARN_DAYS) {
    findings.push({ level: 'bang', line: `the served certificate expires in ${remaining} day(s)`, detail: fix });
  }
  if (findings.length === 0) {
    findings.push({ level: 'tick', line: 'the proxy serves the certificate on disk', detail: servedExpiry });
  }
  return findings;
}

function diskCertificate() {
  if (!existsSync(LEAF_CERT)) return null;
  const cert = new X509Certificate(readFileSync(LEAF_CERT));
  return { fingerprint256: cert.fingerprint256, validTo: cert.validTo };
}

// Verification is reported rather than enforced, so a mismatch can be described instead of only refused.
function servedCertificate(origin, timeoutMs = 5_000) {
  return new Promise((resolveServed) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveServed(value);
    };
    const socket = tlsConnect(
      {
        host: '127.0.0.1',
        port: Number(origin.port),
        servername: origin.hostname,
        ca: existsSync(CA_CERT) ? readFileSync(CA_CERT) : undefined,
        rejectUnauthorized: false,
      },
      () => {
        const peer = socket.getPeerCertificate();
        settle({
          fingerprint256: peer.fingerprint256,
          validTo: peer.valid_to,
          authorized: socket.authorized,
          authorizationError: socket.authorizationError ? String(socket.authorizationError) : null,
        });
      },
    );
    socket.setTimeout(timeoutMs, () => settle({ problem: `no TLS handshake within ${timeoutMs}ms` }));
    socket.on('error', (err) => settle({ problem: err.message }));
  });
}

function reportFindings(findings) {
  const print = { tick, bang, cross };
  for (const finding of findings) print[finding.level](finding.line, finding.detail);
}

function stagingOrigin() {
  return parseHttpsOrigin(readEnvFile().get('PRL_STAGING_PUBLIC_ORIGIN') ?? DEFAULTS.origin);
}

// Plain `KEY=value` lines with no quoting or interpolation, the form compose and this script share.
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
    '# default — bar PRL_PULL_POLICY, which is not a secret and whose default is the',
    '# safe value — so this file has to exist before any compose command against that',
    '# file will run. That is deliberate: a defaulted secret is a secret in a public',
    '# repository that works.',
    '#',
    '# PRL_API_IMAGE, PRL_WEB_IMAGE and PRL_PULL_POLICY are rewritten from the release',
    '# manifest on every `staging up`: the images are the local digests, or the registry',
    '# ones with pull_policy `always` where the manifest carries verified registry',
    '# references. Editing them by hand defeats the point of the manifest.',
    '',
  ].join('\n');
  const body = [...entries].map(([key, value]) => `${key}=${value}`).join('\n');
  mkdirSync(STAGING_DIR, { recursive: true });
  writeFileSync(ENV_FILE, `${header}${body}\n`, { mode: 0o600 });
}

// Hex, because the hex alphabet cannot spell any placeholder word `config.ts` refuses ("change",
// "test", "dev-only" and the rest), while random base64url occasionally can.
function generateSecret() {
  for (let attempt = 0; attempt < 8; attempt++) {
    const value = randomBytes(32).toString('hex');
    if (new Set(value).size >= 12) return value;
  }
  throw new Error('could not generate a secret with enough distinct characters, which should be impossible');
}

function opensslAvailable() {
  return capture('openssl', ['version']) !== null;
}

// Caddy's `tls internal` cannot run under `cap_drop: ALL` (see deploy/staging/nginx.conf), so the CA
// is generated here and the smoke test verifies the chain through NODE_EXTRA_CA_CERTS.
// The leaf key is 0644 because nginx runs as uid 101 and cannot read a host user's 0600 file.
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
      // pathlen:0, so this CA cannot sign another CA.
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

    // Browsers and Node check the SANs and ignore the CN.
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

    // Leaf first, then the CA, the order a TLS server presents a chain in.
    writeFileSync(CHAIN, `${readFileSync(LEAF_CERT, 'utf8')}${readFileSync(CA_CERT, 'utf8')}`);
    chmodSync(CA_KEY, 0o600);
    chmodSync(LEAF_KEY, 0o644);
    chmodSync(CHAIN, 0o644);

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

// `node:https` with an explicit `ca`, because NODE_EXTRA_CA_CERTS is read at process start, before
// a first run has made the CA. `rawHeaders` is returned because Node folds duplicate HSTS headers.
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
          resolveCall({
            status: res.statusCode ?? 0,
            headers: res.headers,
            rawHeaders: res.rawHeaders,
            text,
            json,
            error: null,
          });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (err) =>
      resolveCall({ status: 0, headers: {}, rawHeaders: [], text: '', json: null, error: err }),
    );
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SERVICES = ['postgres', 'api', 'web', 'proxy'];

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

// An exited service is reported at once rather than waited out.
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
  for (const service of RELEASE_SERVICES) {
    const reference = manifest?.images?.[service]?.reference;
    if (typeof reference !== 'string' || !DIGEST_REFERENCE.test(reference)) {
      return {
        problem:
          `${path} does not give service "${service}" a digest reference. Got ${String(reference)}. ` +
          'Staging deploys by digest and refuses a tag: a tag is a pointer, and the whole ' +
          'build-once-promote-the-same-bytes chain depends on this being content-addressed.',
      };
    }
    const registry = manifest?.images?.[service]?.registry;
    if (registry === undefined || registry === null) continue;
    // A malformed registry block is refused, not ignored, or the local digest would deploy silently.
    if (
      typeof registry.reference !== 'string' ||
      !REGISTRY_DIGEST_REFERENCE.test(registry.reference) ||
      typeof registry.digest !== 'string' ||
      !DIGEST.test(registry.digest) ||
      typeof registry.host !== 'string' ||
      typeof registry.repository !== 'string'
    ) {
      return {
        problem:
          `${path} gives service "${service}" a registry block this script cannot read: ` +
          `${JSON.stringify(registry)}. It must carry host, repository, digest and a ` +
          '`host[:port]/repository@sha256:<64 hex>` reference, all of which ' +
          '`pnpm run release:artifacts --push` writes together.',
      };
    }
  }
  return { manifest };
}

/**
 * Whether the manifest was built from the checkout `staging up` is running in.
 *
 * The manifest is gitignored, and on 2026-11-11 one 161 commits behind main would have deployed
 * three-month-old images under this checkout's migrations. Refused: a different commit, no commit,
 * a clean manifest over uncommitted or untracked changes, and a checkout git cannot report on. A
 * `dirty: true` manifest is only warned about, because `promote` is where dirty is refused.
 *
 * `changedPaths` excludes `release-images/`, where the release workflow loads image tarballs. A
 * clean manifest may sit behind HEAD by commits that touch only RELEASE_RECORD_PATHS, which are in
 * no image. A dirty one may not, because its images hold edits no commit records.
 *
 * `behind` and `ahead` are `git rev-list --count` in each direction, and any field is `null` when git
 * gave no answer.
 */
export function manifestMatchesCheckout(manifestCommit, checkout) {
  const rebuild = 'Rebuild for this commit, then run this again:\n      pnpm run release:artifacts';
  const built = manifestCommit?.sha ?? null;
  if (checkout.headSha === null) {
    return {
      problem:
        '`git rev-parse HEAD` gave no answer, so nothing can show the manifest describes this checkout. ' +
        'staging deploys from a git checkout; run it from one.',
    };
  }
  if (typeof built !== 'string' || built === '') {
    return {
      problem:
        'the manifest records no commit, so nothing can show its images were built from HEAD ' +
        `(${checkout.headSha.slice(0, 12)}). ${rebuild}`,
    };
  }
  if (built !== checkout.headSha && !(manifestCommit?.dirty === false && onlyReleaseRecordsSince(checkout))) {
    const distance =
      checkout.behind === null
        ? `${built.slice(0, 12)} is not in this clone's history, so the distance cannot be counted`
        : `HEAD is ${checkout.behind} commit(s) past it` +
          (checkout.ahead !== null && checkout.ahead > 0
            ? ` and it is ${checkout.ahead} commit(s) HEAD does not have`
            : '');
    return {
      problem:
        `the manifest was built from ${built.slice(0, 12)}, and HEAD is ${checkout.headSha.slice(0, 12)}: ` +
        `${distance}. The images would be that commit's code, migrated and smoke-tested by this ` +
        `one's. ${rebuild}`,
    };
  }
  if (manifestCommit?.dirty === false) {
    if (checkout.changedPaths === null) {
      return {
        problem:
          '`git status` gave no answer, so nothing can show this checkout is still the clean ' +
          `${built.slice(0, 12)} the images were built from. Run it from a working git checkout.`,
      };
    }
    if (checkout.changedPaths.length > 0) {
      const shown = checkout.changedPaths.slice(0, 3).join(', ');
      const more = checkout.changedPaths.length > 3 ? `, and ${checkout.changedPaths.length - 3} more` : '';
      return {
        problem:
          `the manifest was built from a clean ${built.slice(0, 12)}, and ${checkout.changedPaths.length} ` +
          `file(s) are uncommitted since (${shown}${more}), so the images do not contain them. Commit ` +
          `or remove them. ${rebuild}`,
      };
    }
  }
  return { ok: true };
}

// Exact paths. A new entry claims somebody checked the file is in no image and read by no deploy step.
export const RELEASE_RECORD_PATHS = Object.freeze([
  'deploy/staging/release-signatures.json',
  'docs/production/final-readiness-report.md',
]);

function onlyReleaseRecordsSince(checkout) {
  if (checkout.behind === null || checkout.behind < 1 || checkout.ahead !== 0) return false;
  const since = checkout.committedSince;
  if (!Array.isArray(since) || since.length === 0) return false;
  return since.every((path) => RELEASE_RECORD_PATHS.includes(path));
}

function countOf(output) {
  if (output === null) return null;
  const number = Number(output);
  return Number.isInteger(number) ? number : null;
}

function probeCheckout(builtSha) {
  const headSha = capture('git', ['rev-parse', 'HEAD']);
  // Only a full sha is handed to rev-list: anything else in a hand-edited manifest could be an option.
  const known = typeof builtSha === 'string' && /^[0-9a-f]{40}$/.test(builtSha);
  const porcelain = capture('git', [
    'status',
    '--porcelain',
    '--untracked-files=all',
    '--',
    '.',
    ':(exclude)release-images',
  ]);
  const behind = known ? countOf(capture('git', ['rev-list', '--count', `${builtSha}..HEAD`])) : null;
  const ahead = known ? countOf(capture('git', ['rev-list', '--count', `HEAD..${builtSha}`])) : null;
  const diff =
    known && behind !== null && behind > 0 && ahead === 0
      ? capture('git', ['diff', '--name-only', '--no-renames', builtSha, 'HEAD'])
      : null;
  return {
    headSha,
    behind,
    ahead,
    committedSince: diff === null ? null : diff.split('\n').filter((line) => line !== ''),
    changedPaths:
      porcelain === null
        ? null
        : porcelain
            .split('\n')
            .filter((line) => line !== '')
            .map((line) => line.slice(3)),
  };
}

/**
 * Which reference each service is deployed by, and the resulting `pull_policy`.
 *
 * No registry block deploys the local digest with `never`. A verified registry block deploys the
 * registry reference with `always`, which is safe because a digest pull returns those bytes or fails.
 * An unverified block falls back to the local digest and the caller reports it. Both services move
 * together, since `--push` writes both blocks or neither.
 */
export function deploymentPlan(manifest, verified) {
  const images = manifest?.images ?? {};
  const declared = RELEASE_SERVICES.filter((service) => images[service]?.registry != null);
  const usable = RELEASE_SERVICES.filter((service) => verified[service] === true);
  const registryBacked = declared.length === RELEASE_SERVICES.length && usable.length === declared.length;
  const references = {};
  for (const service of RELEASE_SERVICES) {
    references[service] = registryBacked ? images[service].registry.reference : images[service].reference;
  }
  return {
    references,
    pullPolicy: registryBacked ? 'always' : 'never',
    registryBacked,
    degraded: declared.length > 0 && !registryBacked,
  };
}

// A registry may have been wiped since the reference was recorded, and `always` against a missing
// digest fails the stack. The served manifest bytes are re-hashed here, not trusted.
async function verifyRegistryCopies(manifest, report) {
  const verified = {};
  for (const service of RELEASE_SERVICES) {
    const registry = manifest.images?.[service]?.registry ?? null;
    if (registry === null) {
      verified[service] = null;
      continue;
    }
    const result = await verifyRegistryDigest({
      host: registry.host,
      repository: registry.repository,
      digest: registry.digest,
      localDigest: manifest.images[service].digest,
    });
    verified[service] = result.ok === true;
    report(service, registry, result);
  }
  return verified;
}

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

  entries.set('PRL_STAGING_PUBLIC_ORIGIN', origin.origin);
  entries.set('PRL_STAGING_HTTPS_PORT', origin.port);
  // Not 5432, so staging can run beside the development stack.
  if (!entries.has('PRL_STAGING_DB_PORT')) entries.set('PRL_STAGING_DB_PORT', '55432');
  if (!entries.has('PRL_STAGING_DB_NAME')) entries.set('PRL_STAGING_DB_NAME', 'poker_risk_lab_staging');
  if (!entries.has('PRL_STAGING_DB_SUPERUSER')) entries.set('PRL_STAGING_DB_SUPERUSER', 'prl_staging_owner');
  // RUNBOOK §5 names the runtime identity prl_api.
  if (!entries.has('PRL_STAGING_API_DB_USER')) entries.set('PRL_STAGING_API_DB_USER', 'prl_api');
  if (!entries.has('PRL_STAGING_LOG_LEVEL')) entries.set('PRL_STAGING_LOG_LEVEL', 'info');
  // Placeholders so compose commands work before the first build.
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
  if (serviceState('proxy').state === 'running') {
    bang(
      'the running proxy still serves the previous certificate and CA',
      '`pnpm run staging refresh-tls` loads the new ones and recreates only the proxy.\n' +
        '      The CA is new too: re-import deploy/staging/tls/staging-ca.pem wherever the old one was trusted.',
    );
  }
}

// `db/seeds/0002_dev_login_roles.sql` refuses NODE_ENV=production, so the same roles get a generated
// password here. The SQL goes on stdin, so no credential appears in a host argv.
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
 * Under `TRUST_PROXY=true` the guest-creation limit (ten per minute) keys on the leftmost value, so
 * `$proxy_add_x_forwarded_for` would let each forged header land in a fresh bucket. More requests
 * than the limit, each with a different forged value, must still produce a 429. It runs after the
 * smoke test has emptied the real bucket. The rate limit runs `onRequest`, before CSRF.
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
    // TEST-NET-3 documentation addresses (RFC 5737).
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
  // Before the registry probe and any write to .env.staging, so a refusal touches nothing.
  const matches = manifestMatchesCheckout(manifest.commit, probeCheckout(manifest.commit?.sha));
  if ('problem' in matches) {
    cross('the release manifest is not this checkout', matches.problem);
    return;
  }

  const registryVerified = await verifyRegistryCopies(manifest, (service, registry, result) => {
    if (result.ok === true) {
      tick(
        `${service}: ${registry.host} serves ${registry.repository}@${registry.digest.slice(0, 19)}…`,
        'its manifest was fetched and re-hashed here, and it ties to the artefact this manifest ' +
          `describes (${result.tie})`,
      );
      return;
    }
    bang(`${service}: the registry copy could not be verified`, result.problem);
  });
  const plan = deploymentPlan(manifest, registryVerified);

  const entries = readEnvFile();
  entries.set('PRL_API_IMAGE', plan.references.api);
  entries.set('PRL_WEB_IMAGE', plan.references.web);
  entries.set('PRL_PULL_POLICY', plan.pullPolicy);
  writeEnvFile(entries);
  tick(
    plan.registryBacked ? 'deploying the registry digests' : 'deploying the manifest digests',
    `api ${plan.references.api}\n      web ${plan.references.web}\n      pull_policy ` +
      `${plan.pullPolicy}\n      built ${manifest.builtAt} from ` +
      `${manifest.commit?.sha ?? 'an unknown commit'}` +
      `${manifest.commit?.dirty === true ? ' (DIRTY WORKING TREE)' : ''}`,
  );
  if (plan.degraded) {
    bang(
      'the manifest carries registry references but the stack is deploying the local digests',
      'the bytes are identical — these are the same content addresses — so the rehearsal is still ' +
        'valid, but nothing here has demonstrated that another machine could fetch them. Start the ' +
        'registry (`docker compose -f deploy/registry/docker-compose.registry.yml up -d`) and re-run ' +
        'this, or re-push with `pnpm run release:artifacts -- --push`.',
    );
  }

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

  // The database first, so migrations run from the host before the API connects. The serving image
  // does not ship apps/api/scripts (RUNBOOK §11.3).
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

  const proxyRefresh = refreshStagingProxy(compose);
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

  // The expected value is the local digest even after a registry pull, because `--push` records a
  // registry block only when pulling it back produced exactly this image id.
  let digestsMatch = true;
  for (const service of RELEASE_SERVICES) {
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
    tick(
      'both running containers are the manifest digests',
      plan.registryBacked
        ? 'verified from docker inspect, not from a tag — and these containers were PULLED from ' +
            `${manifest.images.api.registry.host} by digest, so the identity survived a push/pull boundary`
        : 'verified from docker inspect, not from a tag',
    );
  }

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

  const hstsValues = hstsFromRawHeaders((await httpsCall(origin, HSTS_PROBE_PATH)).rawHeaders);
  if (hstsValues.length === 1 && hstsValues[0] === HSTS_EXPECTED) {
    tick(
      `the proxy is the only source of Strict-Transport-Security on ${HSTS_PROBE_PATH}`,
      `exactly one header, ${HSTS_EXPECTED}`,
    );
  } else if (hstsValues.length === 0) {
    cross(
      `no Strict-Transport-Security header on ${HSTS_PROBE_PATH}`,
      'only the TLS terminator knows there is TLS, so nginx.conf is the only place this can come from',
    );
  } else if (hstsValues.length > 1) {
    cross(
      `${hstsValues.length} Strict-Transport-Security headers on ${HSTS_PROBE_PATH}`,
      `a UA obeys only the first (RFC 6797 §8.1): ${hstsValues.join(' | ')}\n` +
        '      nginx add_header appends; proxy_hide_header must drop the upstream copy',
    );
  } else {
    cross(
      `Strict-Transport-Security on ${HSTS_PROBE_PATH} is not the configured policy`,
      `expected ${HSTS_EXPECTED}, got ${hstsValues[0]}`,
    );
  }

  let smokePassed = null;
  if (options.smoke) {
    section('smoke test (through the staging origin, over TLS)');
    const smoke = run(
      process.execPath,
      [
        'scripts/smoke-test.mjs',
        '--origin',
        origin.origin,
        '--strict',
        // Staging runs `PRL_ENROLMENT_REQUIRED=enforced`, so the smoke run must prove the seat guard
        // (see `sectionEnrolment`).
        '--expect-enrolment',
        'enforced',
      ],
      {
        stream: true,
        env: {
          ...process.env,
          PRL_WEB_ORIGIN: origin.origin,
          // prl_app holds SELECT only on the enrolment tables, so the smoke run needs the migrating
          // identity to write an enrolment via `apps/api/scripts/enrolments.mjs`. Never on a command line.
          DATABASE_MIGRATION_URL: migrationUrl,
          NODE_EXTRA_CA_CERTS: CA_CERT,
        },
      },
    );
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
        api: {
          digest: manifest.images.api.digest,
          reference: manifest.images.api.reference,
          // `promote` compares this. An attestation silent on the registry cannot justify a cross-machine
          // promotion.
          registry: plan.registryBacked ? manifest.images.api.registry : null,
        },
        web: {
          digest: manifest.images.web.digest,
          reference: manifest.images.web.reference,
          registry: plan.registryBacked ? manifest.images.web.registry : null,
        },
      },
      checks: {
        runningDigestsMatchManifest: true,
        tlsChainVerified: true,
        forwardedForOverwritten: true,
        smokeTestStrict: true,
        // The digests were fetched back and re-hashed, and the containers started from those references.
        deployedFromRegistryByDigest: plan.registryBacked,
      },
    };
    writeFileSync(ATTESTATION_FILE, `${JSON.stringify(attestation, null, 2)}\n`);
    tick('wrote deploy/staging/staging-verified.json', '`pnpm run staging promote` reads this');
  }
}

async function commandStatus(options) {
  const states = SERVICES.map(serviceState);
  const read = existsSync(resolve(REPO_ROOT, options.manifest)) ? readManifest(options.manifest) : null;
  const manifest = read !== null && !('problem' in read) ? read.manifest : null;
  const origin = stagingOrigin();
  const proxyRunning = states.find((s) => s.name === 'proxy')?.state === 'running';
  // One loopback handshake with a timeout, so `status` still cannot hang.
  const tlsFindings =
    proxyRunning && !('problem' in origin)
      ? servedCertificateVerdict({ served: await servedCertificate(origin), disk: diskCertificate(), now: Date.now() })
      : null;

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          services: states,
          manifest: manifest === null ? null : { commit: manifest.commit, images: manifest.images },
          attestation: existsSync(ATTESTATION_FILE)
            ? JSON.parse(readFileSync(ATTESTATION_FILE, 'utf8'))
            : null,
          tls: tlsFindings,
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
    for (const service of RELEASE_SERVICES) {
      const running = states.find((s) => s.name === service)?.image ?? null;
      const expected = manifest.images[service].digest;
      if (running === null) continue;
      if (running === expected) {
        // No network call, so `status` cannot hang when something is wrong.
        const registry = manifest.images[service].registry ?? null;
        tick(
          `${service} matches the manifest`,
          registry === null ? undefined : `also published as ${registry.reference} (not re-checked here)`,
        );
      } else {
        cross(`${service} does NOT match the manifest`, `manifest ${expected}\n      running  ${running}`);
      }
    }
  }
  if (tlsFindings !== null) reportFindings(tlsFindings);
  console.log(
    dim(
      `\n  attestation  ${existsSync(ATTESTATION_FILE) ? 'present' : 'absent — nothing has been verified'}\n`,
    ),
  );
}

// The renewal step `init` cannot take: it writes new files, and nginx loads them when the proxy starts.
async function commandRefreshTls() {
  section('staging refresh-tls');
  const origin = stagingOrigin();
  if ('problem' in origin) {
    cross('PRL_STAGING_PUBLIC_ORIGIN is unusable', origin.problem);
    return;
  }
  const disk = diskCertificate();
  if (disk === null) {
    cross('there is no certificate on disk to load', 'run `pnpm run staging init` first');
    return;
  }
  if (serviceState('proxy').state !== 'running') {
    cross('the proxy is not running', '`pnpm run staging up` starts it, and it reads the certificate on disk');
    return;
  }
  console.log(dim('  recreating the proxy container only; api, web and postgres keep running'));
  const result = refreshStagingProxy(compose);
  if (result.status !== 0) {
    cross('could not recreate the TLS proxy', result.stderr.trim() || result.stdout.trim());
    return;
  }
  const healthy = await waitForHealthy(['proxy'], 60);
  if (!healthy.ok) {
    cross('the proxy never became healthy', healthy.reason ?? 'unknown');
    return;
  }
  reportFindings(servedCertificateVerdict({ served: await servedCertificate(origin), disk, now: Date.now() }));
}

// Refuses a promotion unless the attestation's digests equal the manifest's, printing both when they
// differ. Where the artefacts were pushed, the registry must still serve those exact bytes.
async function commandPromote(options) {
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
  for (const service of RELEASE_SERVICES) {
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

  const registryVerified = await verifyRegistryCopies(manifest, (service, registry, result) => {
    if (result.ok !== true) {
      cross(`${service}: the registry no longer serves the digest this manifest promotes`, result.problem);
      return;
    }
    const attested = attestation.images?.[service]?.registry?.digest ?? null;
    if (attested !== null && attested !== registry.digest) {
      cross(
        `${service}: staging deployed a different registry digest`,
        `about to promote  ${registry.digest}\n      staging deployed  ${attested}`,
      );
      return;
    }
    tick(
      `${service} is fetchable: ${registry.reference}`,
      'the registry answered for that digest and the manifest it returned was re-hashed here' +
        (attested === null
          ? '. The attestation records no registry reference, so the staging run that verified this ' +
            'artefact deployed the local copy; the digests above are what tie the two together'
          : ', and it is the reference the verified staging run deployed'),
    );
  });
  const promotableAcrossMachines = RELEASE_SERVICES.every((service) => registryVerified[service] === true);

  // A subprocess, so the preflight owns its exit code and its report. `--json --out` is not passed,
  // so the operator sees the reasons.
  section('the paging destinations');
  const preflight = run(process.execPath, ['scripts/alert-preflight.mjs'], { stream: true });
  if (preflight.status !== 0) {
    cross(
      'the alerting preflight refuses this configuration',
      'the reasons are printed above. A release cannot be promoted with a paging destination ' +
        'that is a placeholder, malformed, missing a credential, or routed to a receiver with ' +
        'nothing in it — every one of those is an alert that fires, routes correctly and reaches ' +
        'nobody, and nothing in band can report it. Set the PRL_ALERT_* variables and run ' +
        '`pnpm run alerts:preflight` until it passes.',
    );
    identical = false;
  } else {
    tick(
      'the alerting preflight accepts this configuration',
      'every routed receiver has a real, well-formed, non-placeholder destination and both ' +
        'severity tiers resolve. Whether the handshake against the relay was run is in the ' +
        'preflight output above; a skipped handshake means the credentials are still unproven.',
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
    // The same bytes can come from two commits, so this is reported beside the digest comparison.
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
          // A manifest with no registry reference is promotable only on this machine.
          promotableAcrossMachines: promotableAcrossMachines && identical && failures.length === 0,
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
    const registryNote = promotableAcrossMachines
      ? '\n  Cross-machine promotion is available for these artefacts. Each one has a registry\n' +
        '  digest that was verified above by fetching the manifest and re-hashing it here, so\n' +
        '  another machine can run\n\n' +
        `      docker pull ${manifest.images.api.registry.reference}\n\n` +
        '  and get these exact bytes. A digest pull cannot return different ones: the reference\n' +
        '  IS the hash of the manifest, so bytes that differ resolve to a different reference\n' +
        '  and the pull fails instead of succeeding with something else.\n' +
        '\n  What that does NOT establish, precisely:\n' +
        '    * PROVENANCE. Nothing records who built these images, on what machine, from which\n' +
        '      source tree, or with which toolchain — beyond what this repository wrote into the\n' +
        '      manifest itself, which is this repository vouching for this repository.\n' +
        '    * A SIGNATURE — not from this command. THIS command does not verify one. The\n' +
        '      digests are signed, by `pnpm run release:sign`, and checked by\n' +
        '      `pnpm run security:image-provenance` against the committed public key. Run that\n' +
        '      before promoting; a signature nobody checked is a file. And note what even a\n' +
        '      passing check does not buy: the key is a long-lived file on this machine with no\n' +
        '      transparency log behind it, so it proves possession of a key and not the identity\n' +
        '      of a builder. That still needs keyless/OIDC signing in CI.\n' +
        '    * A THIRD PARTY. The registry is a container on this host. It is content-addressed\n' +
        '      storage and it is not a notary: it can prove two parties hold the same bytes, and\n' +
        '      it cannot prove where those bytes came from.\n'
      : '\n  Cross-machine promotion is NOT available for these artefacts: the manifest names only\n' +
        '  local BuildKit image-store digests, which are content-addressed and stable but exist\n' +
        '  on this machine alone. To make them fetchable:\n\n' +
        '      docker compose -f deploy/registry/docker-compose.registry.yml up -d\n' +
        '      pnpm run release:artifacts -- --push\n\n' +
        '  That records a registry digest beside each local one and this command then verifies\n' +
        '  it. Signing is a separate step again — `pnpm run release:sign`, then\n' +
        '  `pnpm run security:image-provenance` to check it.\n';
    console.log(
      dim(
        `\n  Verified in staging at ${attestation.verifiedAt} against ${attestation.origin}.\n` +
          '\n  This command VERIFIES; it does not deploy. There is no production target in this\n' +
          '  repository, so there is nothing here that could roll these bytes out anywhere. When\n' +
          '  there is, the deploy step goes after this check and consumes these digests; this\n' +
          '  check does not change.\n' +
          registryNote,
      ),
    );
  }
}

// realpath on both sides, so a checkout reached through a symlink still matches.
function startedFromCommandLine() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

async function main() {
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
      await commandStatus(options);
      break;
    case 'refresh-tls':
      await commandRefreshTls();
      break;
    case 'smoke': {
      const entries = readEnvFile();
      const origin = parseHttpsOrigin(entries.get('PRL_STAGING_PUBLIC_ORIGIN') ?? DEFAULTS.origin);
      if ('problem' in origin) {
        cross('PRL_STAGING_PUBLIC_ORIGIN is unusable', origin.problem);
        break;
      }
      // The same two arguments `commandUp` passes, so `staging smoke` is not a weaker gate.
      const smokeMigrationUrl =
        `postgres://${encodeURIComponent(entries.get('PRL_STAGING_DB_SUPERUSER') ?? '')}:` +
        `${encodeURIComponent(entries.get('PRL_STAGING_DB_SUPERUSER_PASSWORD') ?? '')}` +
        `@127.0.0.1:${entries.get('PRL_STAGING_DB_PORT')}/${entries.get('PRL_STAGING_DB_NAME')}`;
      const smoke = run(
        process.execPath,
        ['scripts/smoke-test.mjs', '--origin', origin.origin, '--strict', '--expect-enrolment', 'enforced'],
        {
          stream: true,
          env: {
            ...process.env,
            PRL_WEB_ORIGIN: origin.origin,
            NODE_EXTRA_CA_CERTS: CA_CERT,
            DATABASE_MIGRATION_URL: smokeMigrationUrl,
          },
        },
      );
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
        tick(
          options.volumes ? 'the stack is down and its database volume is destroyed' : 'the stack is down',
        );
        // The attestation describes a stack that no longer exists.
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
      await commandPromote(options);
      break;
    default:
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
}

if (startedFromCommandLine()) await main();

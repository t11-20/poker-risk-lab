#!/usr/bin/env node
/**
 * Gate: no shipped config may write a secret to a log, and no container log may be
 * unbounded.
 *
 * Two rules, one gate, because they are the two halves of the same defect (D2 in
 * docs/production/legal-register.md) and they fail in the same file. The first is
 * about WHAT is written; the second is about HOW MUCH.
 *
 * ## The incident this exists to prevent, and the one it is closing
 *
 * Both shipped nginx configurations used the stock `combined` format:
 *
 *     deploy/staging/nginx.conf   access_log /dev/stdout combined;
 *     docker-compose.yml          access_log /dev/stdout combined;
 *
 * `combined` logs `"$request"`, which is the request line VERBATIM — method, URI
 * *including the query string*, protocol. `/api/v1/auth/oidc/callback` is routed
 * by `location /api/` in both files, and an OIDC provider returns to that path as
 * `?code=<authorization code>&state=<state>`. So every sign-in wrote an OAuth
 * authorization code — a bearer credential that can be exchanged for a session —
 * to the proxy log in the clear. Measured, before the fix, against a throwaway
 * container running that exact config:
 *
 *     172.22.0.1 - - [25/Aug/2026:07:50:49 +0000] "GET /api/v1/auth/oidc/callback
 *     ?code=SENTINELCODE123&state=SENTINELSTATE456 HTTP/1.1" 502 157 "-" "curl/8.7.1"
 *
 * That is D2 / E2 in docs/production/legal-register.md. The reason it needs a gate
 * rather than a fixed config is that the API one hop downstream ALREADY prevents
 * this — `queryKeysOf` in apps/api/src/logging.ts logs query parameter names and
 * never values, `clientKeyFor` in apps/api/src/plugins/request-context.ts stores
 * an HMAC rather than an address — and the proxy silently undid both of them for
 * however long it shipped. Nothing failed. Nothing went red. A control that the
 * layer in front of it can undo, with no test that notices, is not a control, and
 * `access_log ... combined;` is one line and the most-copied line on the internet.
 *
 * ## What this gate refuses, and why each one
 *
 *  1. Any `access_log` naming a stock format (`combined`, `main`) — the defect
 *     verbatim.
 *  2. Any `log_format` mentioning a variable that can carry caller-controlled
 *     content or personal data: `$request` and `$request_uri` (the query string),
 *     `$args`/`$query_string` (the query string on its own), `$http_referer`
 *     (somebody else's URL, carrying somebody else's token), `$http_cookie` and
 *     `$http_authorization` (credentials outright), `$remote_addr` and
 *     `$http_user_agent` (raw personal data the API deliberately stores only as a
 *     digest). This is the check that stops the defect coming back in a NEW
 *     spelling rather than the old one.
 *  3. An `error_log` level looser than `crit`. This is the half of the fix that is
 *     easy to lose: `ngx_http_log_error` stamps `request: "<full request line>"`
 *     onto its own messages at any level, in a shape no `log_format` controls, so
 *     fixing the access log alone leaves the credential in the error log. The
 *     level is the only lever nginx offers. Everything nginx emits with a request
 *     line in normal operation is `[error]` or quieter.
 *  4. A missing `location = /api/v1/auth/oidc/callback` with `error_log /dev/null`.
 *     `crit` is a reduction, not a proof — a genuine `[crit]` such as `open()
 *     failed (13: Permission denied) while reading upstream` still carries the
 *     request line — and on the one path where a query-string value is a
 *     credential by construction, a reduction is not enough.
 *  5. That block routing somewhere other than `location /api/`. It exists ONLY to
 *     narrow the error log, so if it ever routes differently it has silently
 *     become a routing change nobody reviewed. Two blocks carrying the same
 *     traffic are two blocks that can drift.
 *  6. `proxy_intercept_errors` absent or `on`. On, an upstream 4xx/5xx is handled
 *     by nginx's own `error_page`, which is an internal redirect: a second pass
 *     with a rewritten `$uri` and another opportunity to log a request that
 *     already has a line.
 *  7. **Any** service, in **any** of the three compose files, with no `logging:`
 *     cap — not just the proxy. The other half of D2 is not privacy at all.
 *     Docker's default `json-file` driver is UNBOUNDED without `max-size`, and
 *     logrotate is not an option here because the daemon owns those files (see
 *     docker-compose.yml's header). An uncapped container log fills the Docker
 *     host's disk; a full host disk stops Postgres extending a relation or writing
 *     WAL; and the learner-visible symptom is data loss. That is a
 *     data-availability incident reached entirely through a logging setting, and
 *     `read_only: true` does not help at all, because the log is written outside
 *     the container.
 *
 *     The proxy was never the worst of it. The API writes a structured JSON line
 *     per request and per WebSocket event, and Postgres becomes the loudest
 *     service in the stack the moment somebody sets `log_min_duration_statement`
 *     to chase a slow query and forgets.
 *  8. A service capped differently in two files that both define it, and a
 *     `max-size`/`max-file` value Docker would refuse. Both are ways for a cap to
 *     look applied and not be.
 *
 * ## Everything, discovered — never a list of today's names
 *
 * The nginx configs are listed (there are exactly two, and finding only one must
 * be a failure). The compose SERVICES are enumerated from the files, because the
 * service that matters is the one added next month: it will arrive with no
 * `logging:` block, and a gate that only knew today's names would wave it through
 * in silence. That silence is precisely how `access_log ... combined;` shipped for
 * as long as it did.
 *
 * Exemptions are explicit and named — see `EXEMPT_SERVICES`, which is empty and
 * documents what would justify an entry. A service must never leave this gate's
 * scope by being quietly absent from a list.
 *
 * The negative controls live in log-policy.test.mjs: every rule above is asserted
 * to FAIL against mutations of the real shipped text.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Gate, REPO_ROOT, runGate } from './lib.mjs';

/** The path the OIDC provider redirects to, carrying `?code=…&state=…`. */
export const OIDC_CALLBACK_PATH = '/api/v1/auth/oidc/callback';

/** The one format name a shipped `access_log` may use. */
export const REQUIRED_FORMAT = 'prl_privacy';

/**
 * Error-log levels at or above `crit`. nginx's levels, loosest first, are
 * debug info notice warn error crit alert emerg; every message class nginx emits
 * WITH a request line during normal operation is `error` or quieter.
 */
export const STRICT_ERROR_LEVELS = new Set(['crit', 'alert', 'emerg']);

/**
 * Variables no shipped `log_format` may name.
 *
 * Split by reason so a failure says which rule was broken rather than only which
 * token matched. `$request` is matched with a right-hand boundary so it does not
 * also catch `$request_method`, `$request_time`, `$request_length` or
 * `$request_id` — all four of which are safe and all four of which the current
 * format uses.
 */
export const FORBIDDEN_LOG_VARIABLES = [
  { name: 'request', why: 'the request line verbatim — this is the OIDC authorization code (D2)' },
  { name: 'request_uri', why: 'the URI with its query string — same leak, different spelling' },
  { name: 'args', why: 'the query string on its own' },
  { name: 'query_string', why: 'the query string on its own' },
  { name: 'request_body', why: 'the request body, which carries credentials on every sign-in route' },
  { name: 'http_referer', why: "somebody else's URL, which can carry somebody else's token" },
  { name: 'http_cookie', why: 'the session cookie — a credential outright' },
  { name: 'http_authorization', why: 'a credential outright' },
  { name: 'http_x_forwarded_for', why: 'a raw client address, caller-controlled at that' },
  { name: 'remote_addr', why: 'a raw client address; the API stores only an HMAC of one' },
  { name: 'binary_remote_addr', why: 'a raw client address in another encoding' },
  { name: 'remote_user', why: 'an identifier from an Authorization header' },
  { name: 'http_user_agent', why: 'a full user agent is a fingerprint; the API stores only a digest' },
];

/** Stock nginx format names. Naming one is the defect verbatim. */
export const STOCK_FORMATS = new Set(['combined', 'main']);

/**
 * Strip `#` comments from nginx configuration text.
 *
 * This gate reads files whose comments discuss `$request`, `combined` and the
 * exact leaking log line at length — deliberately, because that is where the
 * reasoning belongs. Without this the gate would fail on its own documentation,
 * and the obvious "fix" would be to delete the explanation. Quotes are tracked so
 * a `#` inside a string is left alone.
 */
export function stripNginxComments(text) {
  const out = [];
  for (const line of text.split('\n')) {
    let quote = null;
    let cut = line.length;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quote !== null) {
        if (ch === '\\') i += 1;
        else if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '#') {
        cut = i;
        break;
      }
    }
    out.push(line.slice(0, cut));
  }
  return out.join('\n');
}

/** Strip whole-line `#` comments from YAML, for the same reason. */
export function stripYamlComments(text) {
  return text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

/**
 * The inline nginx config `docker-compose.yml` passes in `PRL_PROXY_NGINX_CONF`.
 *
 * Read from the raw compose text rather than from `docker compose config`, so the
 * gate needs no docker daemon and audits what is COMMITTED. Compose's `$$` escape
 * for a literal `$` is undone, because `$$request` in the file is `$request` in
 * the container and a rule that missed that would be trivially bypassed.
 *
 * @returns {string | null} the config, or null if the variable is not there.
 */
export function inlineNginxConfigFrom(composeText) {
  const lines = composeText.split('\n');
  const start = lines.findIndex((line) => /^\s*PRL_PROXY_NGINX_CONF:\s*\|/.test(line));
  if (start === -1) return null;
  const first = lines[start + 1] ?? '';
  const indent = (first.match(/^ */) ?? [''])[0].length;
  if (indent === 0) return null;
  const body = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() !== '' && (line.match(/^ */) ?? [''])[0].length < indent) break;
    body.push(line.slice(indent));
  }
  return body.join('\n').replace(/\$\$/g, '$');
}

/**
 * The text between the brace at `open` and its match.
 *
 * Brace counting is enough here because nginx's own parser is brace-counting and
 * this runs on comment-stripped text, so the only braces left are structural.
 */
function blockAt(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return null;
}

/** The body of the first `location <match>` block, or null. */
export function locationBody(text, match) {
  const pattern = new RegExp(`location\\s+${match.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\s*\\{`);
  const found = pattern.exec(text);
  return found === null ? null : blockAt(text, found.index + found[0].length - 1);
}

/** The upstream a location proxies to: the value of its `set $... "<upstream>"`. */
export function upstreamOf(body) {
  const set = /set\s+\$\w+\s+"([^"]+)"\s*;/.exec(body ?? '');
  return set === null ? null : set[1];
}

/**
 * Audit one nginx configuration.
 *
 * @returns {{message: string, detail: string}[]} empty when the config is clean.
 */
export function nginxFindings(rawText, label) {
  const text = stripNginxComments(rawText);
  const findings = [];
  const fail = (message, detail) => findings.push({ message: `${label}: ${message}`, detail });

  // 1 + the positive control: every access_log must name prl_privacy.
  const accessLogs = [...text.matchAll(/access_log\s+([^\s;]+)\s*([^\s;]*)\s*;/g)];
  if (accessLogs.length === 0) {
    fail('no access_log at all', 'a proxy that records nothing cannot answer "one caller or a thousand"');
  }
  for (const [, target, format] of accessLogs) {
    if (target === 'off') continue;
    if (STOCK_FORMATS.has(format)) {
      fail(
        `access_log uses the stock format \`${format}\``,
        '`combined` logs "$request" — the request line including ?code=<OAuth authorization code>. ' +
          'This is D2 verbatim. Use the prl_privacy format.',
      );
    } else if (format !== REQUIRED_FORMAT) {
      fail(
        `access_log names \`${format || '(the default, which is combined)'}\` rather than \`${REQUIRED_FORMAT}\``,
        'every shipped access_log must use the reviewed format, or this gate cannot say what it logs',
      );
    }
  }

  // 2. No log_format may name a variable that can carry a secret.
  const formats = [...text.matchAll(/log_format\s+(\w+)([\s\S]*?);/g)];
  if (formats.length === 0) fail('no log_format is defined', `expected one named ${REQUIRED_FORMAT}`);
  if (!formats.some(([, name]) => name === REQUIRED_FORMAT)) {
    fail(`no \`log_format ${REQUIRED_FORMAT}\``, 'the reviewed format is the one the access_log must name');
  }
  for (const [, name, body] of formats) {
    for (const variable of FORBIDDEN_LOG_VARIABLES) {
      // Right-hand boundary: `$request` must not also match `$request_method`,
      // `$request_time`, `$request_length` or `$request_id`, all of which are safe.
      if (new RegExp(`\\$\\{?${variable.name}\\}?(?![A-Za-z0-9_])`).test(body)) {
        fail(`log_format ${name} logs $${variable.name}`, variable.why);
      }
    }
  }

  // 3. The error log carries the request line at any level; the level is the lever.
  const errorLogs = [...text.matchAll(/error_log\s+([^\s;]+)\s*([^\s;]*)\s*;/g)];
  if (errorLogs.length === 0) {
    fail(
      'no error_log directive',
      'nginx defaults to logs/error.log at `error`, which logs the request line',
    );
  }
  for (const [, target, level] of errorLogs) {
    if (STRICT_ERROR_LEVELS.has(level)) continue;
    fail(
      `error_log ${target} is at \`${level || 'the default, error'}\``,
      'ngx_http_log_error appends `request: "<full request line>"` to its messages at any level, and no ' +
        'log_format controls that shape. Every class nginx emits with a request line in normal operation ' +
        `is \`error\` or quieter, so the level must be one of: ${[...STRICT_ERROR_LEVELS].join(', ')}.`,
    );
  }

  // 4 + 5. The one path where a query-string value is a credential by construction.
  const callback = locationBody(text, `= ${OIDC_CALLBACK_PATH}`);
  if (callback === null) {
    fail(
      `no \`location = ${OIDC_CALLBACK_PATH}\``,
      'crit still permits a genuine [crit] carrying the request line (a full tmpfs, `open() failed while ' +
        'reading upstream`). On the callback that residual is not acceptable: it needs its own block with ' +
        'error_log /dev/null.',
    );
  } else {
    const nulled = /error_log\s+\/dev\/null\s*([^\s;]*)\s*;/.exec(callback);
    if (nulled === null) {
      fail(
        `location = ${OIDC_CALLBACK_PATH} does not send its error log to /dev/null`,
        'that is the only reason the block exists',
      );
    } else if (nulled[1] !== '' && !STRICT_ERROR_LEVELS.has(nulled[1])) {
      fail(
        `location = ${OIDC_CALLBACK_PATH} sets error_log /dev/null at \`${nulled[1]}\``,
        'the level must not be loosened even against /dev/null, or a later edit that repoints the target leaks',
      );
    }
    const apiBody = locationBody(text, '/api/');
    const here = upstreamOf(callback);
    const api = upstreamOf(apiBody);
    if (api === null || here === null) {
      fail(
        `could not read the upstream of ${here === null ? `location = ${OIDC_CALLBACK_PATH}` : 'location /api/'}`,
        'both must set their upstream as `set $var "<host:port>";` so this gate can compare them',
      );
    } else if (here !== api) {
      fail(
        `location = ${OIDC_CALLBACK_PATH} routes to ${here}, but location /api/ routes to ${api}`,
        'the callback block exists only to narrow the error log. A different upstream means it has become ' +
          'an unreviewed routing change.',
      );
    }
  }

  // 6. proxy_intercept_errors on = an internal redirect = a second chance to log.
  const intercept = /proxy_intercept_errors\s+(\w+)\s*;/.exec(text);
  if (intercept === null) {
    fail(
      'proxy_intercept_errors is not stated',
      'it defaults to off, which is correct, but it must be written down: turning it on makes an upstream ' +
        "4xx/5xx an internal redirect through nginx's own error_page, which re-enters the request with a " +
        'rewritten $uri and another opportunity to log it.',
    );
  } else if (intercept[1] !== 'off') {
    fail(`proxy_intercept_errors is ${intercept[1]}`, 'it must be off — see above');
  }

  return findings;
}

/**
 * Every service defined in a compose file, with its body.
 *
 * Enumerated from the text rather than from a hand-maintained list, which is the
 * whole point: this gate has to fail for a service that does not exist yet. A
 * service added next month arrives with no `logging:` block, and if the gate only
 * knew the names of today's services it would pass it in silence — which is
 * exactly how the proxy shipped with `combined` for as long as it did.
 *
 * Two-space keys under `services:`, four-space bodies. That is the shape of all
 * three compose files in this repository and `docker compose config -q` is what
 * validates the YAML itself; re-implementing a YAML parser here to be general
 * about indentation would be more code and more ways to be wrong.
 *
 * @returns {{name: string, body: string}[]}
 */
export function composeServices(rawText) {
  const lines = stripYamlComments(rawText).split('\n');
  const start = lines.findIndex((line) => /^services:\s*$/.test(line));
  if (start === -1) return [];
  const services = [];
  let current = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    // A non-indented, non-blank line ends the services block (`volumes:` etc.).
    if (line.trim() !== '' && !/^\s/.test(line)) break;
    const head = /^ {2}([A-Za-z0-9][A-Za-z0-9._-]*):\s*$/.exec(line);
    if (head !== null) {
      current = { name: head[1], body: [] };
      services.push(current);
    } else if (current !== null) {
      current.body.push(line);
    }
  }
  return services.map((service) => ({ name: service.name, body: service.body.join('\n') }));
}

/**
 * The declared cap on one service's container log.
 *
 * @returns {{driver: string | null, maxSize: string | null, maxFile: string | null} | null}
 *   null when the service declares no `logging:` block at all.
 */
export function logCapOf(serviceBody) {
  if (!/^ {4}logging:\s*$/m.test(serviceBody)) return null;
  const driver = /^ {6}driver:\s*(\S+)\s*$/m.exec(serviceBody);
  const maxSize = /^ {8}max-size:\s*'([^']+)'\s*$/m.exec(serviceBody);
  const maxFile = /^ {8}max-file:\s*'([^']+)'\s*$/m.exec(serviceBody);
  return {
    driver: driver === null ? null : driver[1],
    maxSize: maxSize === null ? null : maxSize[1],
    maxFile: maxFile === null ? null : maxFile[1],
  };
}

/**
 * Services this gate deliberately does not require a cap on.
 *
 * **It is empty, and that is a finding rather than an oversight.** Every service
 * in all three compose files is a long-running container whose stdout the Docker
 * daemon collects, so every one of them can fill the host disk and every one of
 * them is capped. Nothing here qualifies for an exemption today.
 *
 * The map exists so that the first service that does qualify has to say so out
 * loud, keyed `<compose file>:<service>`, with a reason a reviewer can disagree
 * with — rather than being dropped from a list of names and never noticed. The
 * only shapes that would plausibly earn an entry are a one-shot `restart: no`
 * container that runs for seconds and exits, or a service that already ships its
 * logs elsewhere through a non-json-file driver. "It is quiet" is NOT a reason:
 * `web` and `postgres` are both quiet, both capped, and the comments beside their
 * caps say exactly why quiet and bounded are different properties.
 *
 * @type {Map<string, string>}
 */
export const EXEMPT_SERVICES = new Map();

/**
 * Audit every service in one compose file for a bounded container log.
 *
 * @returns {{findings: {message: string, detail: string}[], caps: Map<string, object>}}
 */
export function composeLoggingFindings(rawText, label) {
  const findings = [];
  const caps = new Map();
  const fail = (message, detail) => findings.push({ message: `${label}: ${message}`, detail });

  const services = composeServices(rawText);
  if (services.length === 0) {
    fail(
      'no services could be read out of this file',
      'a gate that parses nothing reports success on everything; this is the failure mode D2 came from',
    );
    return { findings, caps };
  }

  for (const { name, body } of services) {
    const exemption = EXEMPT_SERVICES.get(`${label}:${name}`);
    if (exemption !== undefined) continue;
    const cap = logCapOf(body);
    if (cap === null) {
      fail(
        `service \`${name}\` has no \`logging:\` block`,
        "Docker's default json-file driver is UNBOUNDED without max-size, and there is no logrotate in " +
          'deploy/ (nor could there usefully be: the daemon owns these files). An uncapped container log ' +
          'fills the Docker host disk, and a full host disk stops Postgres writing — a data-availability ' +
          'incident reached through a logging setting. If this service is genuinely exempt, add it to ' +
          'EXEMPT_SERVICES with a reason; do not delete it from a list.',
      );
      continue;
    }
    if (cap.driver !== 'json-file') {
      fail(
        `service \`${name}\` logs through \`${cap.driver ?? '(no driver named)'}\` rather than json-file`,
        'max-size/max-file are json-file options and are silently ignored by other drivers, so the cap ' +
          'beside them would look applied and do nothing. `none` is worse: it discards the log entirely, ' +
          'and a log with nothing in it is not a win. Either name json-file or take the exemption ' +
          'explicitly in EXEMPT_SERVICES.',
      );
      continue;
    }
    for (const [option, value] of [
      ['max-size', cap.maxSize],
      ['max-file', cap.maxFile],
    ]) {
      if (value === null) {
        fail(
          `service \`${name}\` has a logging: block with no ${option}`,
          'both are required: max-size alone rotates forever, max-file alone never rotates. Either way the ' +
            'log is still unbounded and the block only looks like a cap.',
        );
      }
    }
    if (cap.maxSize !== null && !/^\d+[kmg]$/.test(cap.maxSize)) {
      fail(
        `service \`${name}\` has max-size '${cap.maxSize}', which Docker will not accept`,
        'json-file wants a number and a unit suffix, e.g. 10m. An unparseable value is a startup failure, ' +
          'not a smaller cap.',
      );
    }
    if (cap.maxFile !== null && !/^[1-9]\d*$/.test(cap.maxFile)) {
      fail(
        `service \`${name}\` has max-file '${cap.maxFile}', which is not a positive integer`,
        'same reason',
      );
    }
    caps.set(name, cap);
  }

  return { findings, caps };
}

/**
 * Where a shipped nginx config lives.
 *
 * Listed rather than discovered, and the gate fails if one is missing: the whole
 * point of D2 is that these two files drift, so "I found one and it was fine" must
 * never be a pass.
 */
export const NGINX_SOURCES = [
  { file: 'deploy/staging/nginx.conf', read: (text) => text },
  { file: 'docker-compose.yml', read: inlineNginxConfigFrom },
];

/**
 * Every compose file in the repository. All three, not just the two that ship a
 * proxy: the disk-exhaustion half of D2 is about every container, and the
 * observability stack is the one most likely to be left running and forgotten.
 */
export const COMPOSE_SOURCES = [
  'docker-compose.yml',
  'docker-compose.staging.yml',
  'docker-compose.observability.yml',
];

/**
 * Services whose caps must be identical wherever they appear.
 *
 * `docker-compose.yml` and `docker-compose.staging.yml` define the same four
 * services, and D2 exists because those two files drifted: one of them was fixed
 * and the other was not, for as long as nobody diffed them. A per-service cap that
 * is 20m×5 in one file and 10m×3 in the other is the same drift in a new place, so
 * a service appearing in more than one file must carry the same numbers in each.
 * A deployment that genuinely wants different sizes should change both and say why.
 */
export function crossFileCapFindings(capsByFile) {
  const findings = [];
  const seen = new Map();
  for (const [file, caps] of capsByFile) {
    for (const [service, cap] of caps) {
      const previous = seen.get(service);
      const shape = `${cap.maxSize} x ${cap.maxFile}`;
      if (previous === undefined) {
        seen.set(service, { file, shape });
      } else if (previous.shape !== shape) {
        findings.push({
          message: `service \`${service}\` is capped ${previous.shape} in ${previous.file} but ${shape} in ${file}`,
          detail:
            'D2 happened because these files drifted and a fix in one was not a fix. Keep a shared service ' +
            'identical in every file that defines it, or change both deliberately.',
        });
      }
    }
  }
  return findings;
}

const gate = new Gate('log policy');

export function runLogPolicyGate(root = REPO_ROOT, target = gate) {
  for (const source of NGINX_SOURCES) {
    const path = join(root, source.file);
    if (!existsSync(path)) {
      target.fail(`${source.file} is missing`, 'a shipped proxy config disappeared; this gate checks both');
      continue;
    }
    const config = source.read(readFileSync(path, 'utf8'));
    if (config === null || config.trim() === '') {
      target.fail(
        `${source.file} contains no nginx configuration`,
        'the inline config moved or was renamed; a gate that finds nothing must not pass',
      );
      continue;
    }
    const findings = nginxFindings(config, source.file);
    for (const finding of findings) target.fail(finding.message, finding.detail);
    if (findings.length === 0) target.note(`${source.file} — access log and error log both sanitised`);
  }

  const capsByFile = new Map();
  for (const file of COMPOSE_SOURCES) {
    const path = join(root, file);
    if (!existsSync(path)) {
      target.fail(`${file} is missing`, 'a shipped compose file disappeared; this gate checks all three');
      continue;
    }
    const { findings, caps } = composeLoggingFindings(readFileSync(path, 'utf8'), file);
    for (const finding of findings) target.fail(finding.message, finding.detail);
    capsByFile.set(file, caps);
    if (findings.length === 0) {
      const shapes = [...caps].map(([name, cap]) => `${name} ${cap.maxSize}x${cap.maxFile}`).join(', ');
      target.note(`${file} — ${caps.size} service(s) capped: ${shapes}`);
    }
  }
  for (const finding of crossFileCapFindings(capsByFile)) target.fail(finding.message, finding.detail);

  for (const [key, reason] of EXEMPT_SERVICES) target.note(`exempt: ${key} — ${reason}`);

  return target;
}

if (import.meta.main) {
  await runGate(gate, () => runLogPolicyGate());
}

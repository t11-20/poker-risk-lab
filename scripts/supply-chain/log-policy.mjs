#!/usr/bin/env node
/**
 * Gate: no shipped config may write a secret to a log, and no container log may be unbounded
 * (D2 in docs/production/legal-register.md).
 *
 * nginx's `combined` format logs `$request` verbatim, so every OIDC sign-in would write
 * `?code=<authorization code>` to the proxy log, undoing the API's own query-key-only logging.
 *
 * A `log_format` may name only variables on a reviewed allowlist. A thirteen-name denylist was
 * defeated five ways in a real container: `$arg_code`, a `;` inside a quoted format, a laundering
 * `map`, open families like `$sent_http_location`, and configs outside the two files it read.
 *
 * Refused:
 *  1. An `access_log` not naming `prl_privacy`, including a bare one (which is `combined`).
 *  2. A `log_format` variable not on ALLOWED_LOG_VARIABLES, a derived variable whose `map` no longer
 *     reduces its source, or `escape=none` (`$uri` is percent-decoded and can forge a line).
 *  3. An `error_log` looser than `crit`, including via `nginx -g`, because nginx appends the request
 *     line to its own error messages at any level.
 *  4. No `location = /api/v1/auth/oidc/callback` with `error_log /dev/null`, since a real `[crit]`
 *     still carries the request line.
 *  5. That block routing anywhere other than `location /api/`.
 *  6. `proxy_intercept_errors` absent, or `on` anywhere, since `error_page` is a second logging pass.
 *  7. `include`, which this gate cannot follow, and an `nginx -c` path not in
 *     REVIEWED_NGINX_CONFIG_PATHS.
 *  8. Any service in any compose file without a `logging:` cap. Docker's json-file driver is
 *     unbounded without `max-size`, and a full host disk stops Postgres writing.
 *  9. A service capped differently in two files, or a `max-size`/`max-file` Docker would refuse.
 *
 * The two shipped nginx configs are listed and must both exist. Everything else (inline block
 * scalars, `nginx -g`/`-c` arguments, compose services) is discovered, so a new service or config
 * cannot slip past by being absent from a list. Negative controls are in log-policy.test.mjs.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Gate, REPO_ROOT, runGate } from './lib.mjs';

/** The path the OIDC provider redirects to, carrying `?code=…&state=…`. */
export const OIDC_CALLBACK_PATH = '/api/v1/auth/oidc/callback';

/** The one format name a shipped `access_log` may use. */
export const REQUIRED_FORMAT = 'prl_privacy';

/**
 * Error-log levels at or above `crit`. Every class nginx emits with a request line in normal
 * operation is `error` or quieter.
 */
export const STRICT_ERROR_LEVELS = new Set(['crit', 'alert', 'emerg']);

/** `none` is refused because `$uri` is percent-decoded, so `/a%0a<forged line>` writes two lines. */
export const ALLOWED_ESCAPES = new Set(['default', 'json']);

/**
 * Every variable a shipped `log_format` may name, and why it is safe. This list is the gate. To add
 * one, say whether a caller can choose its bytes and whether it is personal data. `$uri` is allowed
 * as the reviewed D2 fix (path, never query string) and `escape=default` neutralises its bytes.
 * `$remote_addr` is not, because the API stores only an HMAC of it.
 *
 * @type {Map<string, string>}
 */
export const ALLOWED_LOG_VARIABLES = new Map([
  // When.
  ['time_iso8601', 'the time nginx wrote the line'],
  ['time_local', 'the same, in the stock format'],
  ['msec', 'the same, as a unix timestamp'],
  ['uri', 'the normalised path, with the query string already stripped — this is the D2 fix'],
  ['is_args', '"?" or the empty string: whether there was a query string, never its content'],
  ['request_method', 'a method token; `escape=default` neutralises a hostile one'],
  ['server_protocol', 'HTTP/1.1 or HTTP/2.0'],
  ['scheme', 'http or https'],
  // How it went.
  ['status', 'a response status code'],
  ['body_bytes_sent', 'a byte count'],
  ['bytes_sent', 'a byte count'],
  ['request_length', 'a byte count — NOT the request, which is $request'],
  ['request_time', 'a duration'],
  ['request_completion', '"OK" or the empty string'],
  ['pipe', '"p" or "."'],
  ['connection', "nginx's own connection serial number"],
  ['connection_requests', 'how many requests have used that connection'],
  ['request_id', "nginx's own generated id — not anything a caller sent"],
  ['server_name', 'the matched server_name directive, not the Host header'],
  ['server_port', 'the port this server is listening on'],
  ['hostname', "the container's own hostname"],
  ['ssl_protocol', 'the negotiated TLS version'],
  ['ssl_cipher', 'the negotiated cipher suite'],
  // Upstream diagnostics replaced the error log when its level went to `crit`.
  ['upstream_addr', 'the upstream this proxy chose'],
  ['upstream_status', "the upstream's status code"],
  ['upstream_response_time', 'a duration'],
  ['upstream_connect_time', 'a duration'],
  ['upstream_header_time', 'a duration'],
  ['upstream_bytes_received', 'a byte count'],
  ['upstream_bytes_sent', 'a byte count'],
  ['upstream_cache_status', 'HIT/MISS/BYPASS'],
  [
    'upstream_http_x_request_id',
    "the API's OWN request id, read back off its response header — named one variable at a " +
      'time and NOT as an $upstream_http_* family, because the family is as open as $http_*',
  ],
]);

/**
 * Variables a `map` computes, and the variable each is reviewed to reduce. A derived variable is
 * accepted only if exactly one map defines it, that map reads the named source, and every value it
 * returns is a named capture that cannot match any character. `map $request_uri $x { default
 * "$request_uri"; }` would otherwise leak the full query string.
 *
 * @type {Map<string, {from: string, why: string}>}
 */
export const REVIEWED_DERIVED_VARIABLES = new Map([
  [
    'prl_client_net',
    {
      from: 'remote_addr',
      why:
        'the client address truncated to its /24 or /48 — reduction, not anonymisation, and the ' +
        'unmatched case degrades to `ip6` so the failure mode is "log less"',
    },
  ],
  [
    'prl_ua_class',
    {
      from: 'http_user_agent',
      why:
        'the user agent collapsed to browser/tool/bot/none — the API keeps only a digest of the ' +
        'full string, and this layer keeps less',
    },
  ],
]);

/**
 * Variables whose incident is already written down. The allowlist refuses these anyway; this list
 * only supplies a specific failure sentence.
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
 * The `-c` paths a shipped `nginx` command line may name, and what fills each. Any other path is a
 * config this gate never read.
 *
 * @type {Map<string, string>}
 */
export const REVIEWED_NGINX_CONFIG_PATHS = new Map([
  [
    '/etc/nginx/nginx.conf',
    'docker-compose.staging.yml mounts deploy/staging/nginx.conf here read-only, and this gate audits it',
  ],
  [
    '/tmp/nginx.conf',
    "docker-compose.yml's proxy writes PRL_PROXY_NGINX_CONF here at start, and this gate audits that",
  ],
]);

/**
 * Strip `#` comments from nginx config, so the configs' own explanations of `$request` and
 * `combined` do not fail the gate. A `#` inside quotes is kept.
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

/** Strip whole-line `#` comments from YAML. */
export function stripYamlComments(text) {
  return text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

/**
 * Read nginx config as tokens, the way nginx does. `;`, `{` and `}` terminate only outside quotes;
 * a quote-blind regex ends a `log_format` at a `;` inside a string and hides `$http_cookie`.
 * A quoted empty string is still a token (a `map` key can be `''`). Backslash escapes are kept, so
 * a regex's `\.` stays `\.`.
 *
 * @param {string} text nginx configuration, comments already stripped
 * @returns {{name: string, args: string[], id: number|null, parent: number|null}[]}
 *   every directive in source order; `id` is set on block directives (`server {`,
 *   `map … {`) and `parent` is the id of the block a directive sits in.
 */
export function nginxDirectives(text) {
  const directives = [];
  const stack = [];
  let tokens = [];
  let token = '';
  let quoted = false;
  let quote = null;
  let nextId = 0;
  const flush = () => {
    if (token !== '' || quoted) tokens.push(token);
    token = '';
    quoted = false;
  };
  const emit = (isBlock) => {
    if (tokens.length === 0) return null;
    if (isBlock) nextId += 1;
    const directive = {
      name: tokens[0],
      args: tokens.slice(1),
      id: isBlock ? nextId : null,
      parent: stack.length === 0 ? null : stack[stack.length - 1],
    };
    directives.push(directive);
    tokens = [];
    return directive;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote !== null) {
      if (ch === '\\' && i + 1 < text.length) {
        token += ch + text[i + 1];
        i += 1;
      } else if (ch === quote) quote = null;
      else token += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      quoted = true;
      continue;
    }
    if (ch === ';') {
      flush();
      emit(false);
      continue;
    }
    if (ch === '{') {
      flush();
      const opened = emit(true);
      stack.push(opened === null ? null : opened.id);
      continue;
    }
    if (ch === '}') {
      flush();
      tokens = [];
      stack.pop();
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      continue;
    }
    token += ch;
  }
  return directives;
}

/** `$name` and `${name}`, in order, from any fragment of configuration. */
export function variablesIn(text) {
  return [...String(text).matchAll(/\$\{([A-Za-z0-9_]+)\}|\$([A-Za-z0-9_]+)/g)].map(
    (found) => found[1] ?? found[2],
  );
}

const bareName = (token) => token.replace(/^\$\{?/, '').replace(/\}$/, '');

/**
 * Every `map`, keyed by the variable it defines. Two maps defining one variable is a finding,
 * because nginx takes the last and a reviewer reads the first.
 *
 * @returns {Map<string, {source: string, entries: {key: string, value: string}[]}[]>}
 */
export function nginxMaps(directives) {
  const maps = new Map();
  for (const directive of directives) {
    if (directive.name !== 'map' || directive.id === null || directive.args.length < 2) continue;
    const target = bareName(directive.args[directive.args.length - 1]);
    const entries = directives
      .filter((entry) => entry.parent === directive.id)
      .map((entry) => ({ key: entry.name, value: entry.args.join(' ') }));
    const defined = maps.get(target) ?? [];
    defined.push({ source: bareName(directive.args[0]), entries });
    maps.set(target, defined);
  }
  return maps;
}

/** What is wrong with the `map` behind a reviewed derived variable, or null. */
export function derivedVariableProblem(name, reviewed, maps) {
  const defined = maps.get(name) ?? [];
  if (defined.length === 0) return `no \`map\` in this configuration defines $${name}`;
  if (defined.length > 1) {
    return `$${name} is defined by ${defined.length} maps — nginx takes the last, a reviewer reads the first`;
  }
  const [only] = defined;
  if (only.source !== reviewed.from) {
    return `the map that defines $${name} reads $${only.source}, but it was reviewed as a reduction of $${reviewed.from}`;
  }
  for (const entry of only.entries) {
    const captures = new Set([...entry.key.matchAll(/\(\?<([A-Za-z0-9_]+)>/g)].map((found) => found[1]));
    for (const used of variablesIn(entry.value)) {
      if (!captures.has(used)) {
        return `the map that defines $${name} returns $${used}, which is not a named capture of \`${entry.key}\``;
      }
    }
    for (const [, pattern] of entry.key.matchAll(/\(\?<[A-Za-z0-9_]+>((?:[^()\\]|\\.)*)\)/g)) {
      if (/(?:^|[^\\])\./.test(pattern)) {
        return `the map that defines $${name} captures \`${pattern}\`, which can match any character — a capture that matches everything returns everything`;
      }
    }
  }
  return null;
}

/**
 * The inline nginx config `docker-compose.yml` passes in `PRL_PROXY_NGINX_CONF`, read from the
 * committed text so no docker daemon is needed.
 *
 * @returns {string | null} the config, or null if the variable is not there.
 */
export function inlineNginxConfigFrom(composeText) {
  const found = blockScalarsIn(composeText).find((scalar) => scalar.key === 'PRL_PROXY_NGINX_CONF');
  return found === undefined ? null : found.text;
}

/**
 * Every `KEY: |` block scalar in a compose file, with compose's `$$` undone, since `$$request` in
 * the file is `$request` in the container.
 *
 * @returns {{key: string, text: string}[]}
 */
export function blockScalarsIn(composeText) {
  const lines = composeText.split('\n');
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const head = /^(\s*)([A-Za-z_][A-Za-z0-9_.-]*):\s*\|[-+]?\s*$/.exec(lines[i]);
    if (head === null) continue;
    const first = lines[i + 1] ?? '';
    const indent = (first.match(/^ */) ?? [''])[0].length;
    if (indent <= head[1].length) continue;
    const body = [];
    for (let scan = i + 1; scan < lines.length; scan++) {
      const line = lines[scan];
      if (line.trim() !== '' && (line.match(/^ */) ?? [''])[0].length < indent) break;
      body.push(line.slice(indent));
    }
    found.push({ key: head[2], text: body.join('\n').replace(/\$\$/g, '$') });
  }
  return found;
}

/** Does this text look like nginx configuration rather than a shell script or a certificate? */
export function looksLikeNginx(text) {
  return /(^|\n)\s*(?:log_format|access_log|error_log|worker_connections|server\s*\{|http\s*\{|location\s)/.test(
    text,
  );
}

/**
 * Every `nginx` command line in a compose file, in shell and exec-array form. `nginx -g` sets
 * directives beside a reviewed config; measured, `-g 'error_log /dev/stderr info;'` on the shipped
 * staging config logged the full request line with the query string.
 *
 * @returns {{configPaths: string[], globals: string[]}}
 */
export function nginxInvocationsIn(composeText) {
  const configPaths = new Set();
  const globals = new Set();
  for (const line of stripYamlComments(composeText).split('\n')) {
    // From the `nginx` word onwards, so the shell's `sh -c` is not read as nginx's `-c`.
    const at = line.search(/\bnginx\b/);
    if (at === -1) continue;
    const tail = line.slice(at);
    for (const found of tail.matchAll(/(?:^|[\s'"[,])-c['"]?\s*,?\s*['"]?([^'"\s,\]]+)/g)) {
      configPaths.add(found[1]);
    }
    for (const found of tail.matchAll(/(?:^|[\s'"[,])-g['"]?\s*,?\s*(['"])([^'"]*)\1/g)) {
      globals.add(found[2]);
    }
  }
  return { configPaths: [...configPaths], globals: [...globals] };
}

/** The text between the brace at `open` and its match. Quote-aware, for braces in `map` regexes. */
function blockAt(text, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (quote !== null) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
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
 * Audit one nginx configuration. `complete: false` is for a fragment such as `nginx -g`
 * directives, where rules about what must be present do not apply.
 *
 * @returns {{message: string, detail: string}[]} empty when the config is clean.
 */
export function nginxFindings(rawText, label, { complete = true } = {}) {
  const text = stripNginxComments(rawText);
  const directives = nginxDirectives(text);
  const maps = nginxMaps(directives);
  const findings = [];
  const fail = (message, detail) => findings.push({ message: `${label}: ${message}`, detail });

  // 7. An included file is not committed here, so this gate cannot read it.
  for (const directive of directives.filter((entry) => entry.name === 'include')) {
    fail(
      `include ${directive.args.join(' ')}`,
      'this gate audits what is committed, and an included file is not committed here — so every rule ' +
        'below stops at the `include`. The reviewed configuration is one file; if something genuinely ' +
        'has to be included, it has to be a file this gate reads, listed like the others.',
    );
  }

  // 1 + the positive control: every access_log must name prl_privacy.
  const accessLogs = directives.filter((entry) => entry.name === 'access_log');
  if (complete && accessLogs.length === 0) {
    fail('no access_log at all', 'a proxy that records nothing cannot answer "one caller or a thousand"');
  }
  for (const directive of accessLogs) {
    const target = directive.args[0] ?? '';
    if (target === 'off') continue;
    // An access_log with only parameters has no format, which is `combined`.
    const second = directive.args[1] ?? '';
    const format = /^(?:buffer=|gzip|flush=|if=)/.test(second) ? '' : second;
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

  // 2. Every variable in every log_format must be on the reviewed allowlist.
  const formats = directives.filter((entry) => entry.name === 'log_format');
  if (complete && formats.length === 0) {
    fail('no log_format is defined', `expected one named ${REQUIRED_FORMAT}`);
  }
  if (complete && !formats.some((entry) => entry.args[0] === REQUIRED_FORMAT)) {
    fail(`no \`log_format ${REQUIRED_FORMAT}\``, 'the reviewed format is the one the access_log must name');
  }
  for (const directive of formats) {
    const [name, ...rest] = directive.args;
    const escaping = rest.find((argument) => argument.startsWith('escape='));
    if (escaping !== undefined && !ALLOWED_ESCAPES.has(escaping.slice('escape='.length))) {
      fail(
        `log_format ${name} sets ${escaping}`,
        '`$uri` reaches a log format percent-DECODED, so with escaping off a request for a path ' +
          'containing %0a writes a second log line that says whatever the caller wanted. Use ' +
          `escape=${[...ALLOWED_ESCAPES].join(' or escape=')}.`,
      );
    }
    const body = rest.filter((argument) => !argument.startsWith('escape=')).join('');
    const seen = new Set();
    for (const variable of variablesIn(body)) {
      if (seen.has(variable)) continue;
      seen.add(variable);
      if (ALLOWED_LOG_VARIABLES.has(variable)) continue;
      const reviewed = REVIEWED_DERIVED_VARIABLES.get(variable);
      if (reviewed !== undefined) {
        const problem = derivedVariableProblem(variable, reviewed, maps);
        if (problem === null) continue;
        fail(
          `log_format ${name} logs $${variable}, and the map behind it is not the reviewed one`,
          `${problem}. $${variable} is only safe to log because ${reviewed.why}; the name is not the ` +
            'redaction, the map is.',
        );
        continue;
      }
      const known = FORBIDDEN_LOG_VARIABLES.find((entry) => entry.name === variable);
      if (known !== undefined) {
        fail(`log_format ${name} logs $${variable}`, known.why);
        continue;
      }
      const laundered = maps.get(variable);
      fail(
        `log_format ${name} logs $${variable}, which is not on the reviewed allowlist`,
        (laundered === undefined
          ? ''
          : `It is computed by \`map $${laundered[0].source} $${variable}\`, so what it logs is whatever ` +
            `$${laundered[0].source} contains after that map. `) +
          'This gate allows a log format to name only variables somebody has reviewed and written a ' +
          'reason for (ALLOWED_LOG_VARIABLES) — because a denylist over nginx’s open $arg_*, ' +
          '$http_*, $sent_http_* and $upstream_http_* families is a list of the leaks somebody already ' +
          'thought of, and $arg_code reached a container access log past exactly such a list. If this ' +
          'variable cannot carry caller-controlled content or personal data, add it there with the ' +
          'clause that says so.',
      );
    }
  }

  // 3. The error log carries the request line at any level; the level is the lever.
  const errorLogs = directives.filter((entry) => entry.name === 'error_log');
  if (complete && errorLogs.length === 0) {
    fail(
      'no error_log directive',
      'nginx defaults to logs/error.log at `error`, which logs the request line',
    );
  }
  for (const directive of errorLogs) {
    const [target, level = ''] = directive.args;
    if (STRICT_ERROR_LEVELS.has(level)) continue;
    fail(
      `error_log ${target} is at \`${level || 'the default, error'}\``,
      'ngx_http_log_error appends `request: "<full request line>"` to its messages at any level, and no ' +
        'log_format controls that shape. Every class nginx emits with a request line in normal operation ' +
        `is \`error\` or quieter, so the level must be one of: ${[...STRICT_ERROR_LEVELS].join(', ')}.`,
    );
  }

  // 6. Every occurrence, since a `location` can turn back on what `server` turned off.
  const intercepts = directives.filter((entry) => entry.name === 'proxy_intercept_errors');
  if (complete && intercepts.length === 0) {
    fail(
      'proxy_intercept_errors is not stated',
      'it defaults to off, which is correct, but it must be written down: turning it on makes an upstream ' +
        "4xx/5xx an internal redirect through nginx's own error_page, which re-enters the request with a " +
        'rewritten $uri and another opportunity to log it.',
    );
  }
  for (const directive of intercepts) {
    if (directive.args[0] === 'off') continue;
    fail(`proxy_intercept_errors is ${directive.args[0]}`, 'it must be off, everywhere — see above');
  }

  if (!complete) return findings;

  // 4 + 5. The one path where a query-string value is a credential by construction.
  const callback = locationBody(text, `= ${OIDC_CALLBACK_PATH}`);
  if (callback === null) {
    fail(
      `no \`location = ${OIDC_CALLBACK_PATH}\``,
      'crit still permits a genuine [crit] carrying the request line (a full tmpfs, `open() failed while ' +
        'reading upstream`). On the callback that residual is not acceptable: it needs its own block with ' +
        'error_log /dev/null.',
    );
    return findings;
  }
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

  return findings;
}

/**
 * Every service in a compose file, enumerated from the text so a service added later is checked.
 * Assumes two-space keys and four-space bodies, the shape of all three compose files here.
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
 * Services exempt from a log cap, keyed `<compose file>:<service>`. Empty, because every service
 * here is long-running and capped. A one-shot container or a non-json-file shipping driver might
 * qualify. "It is quiet" does not.
 *
 * @type {Map<string, string>}
 */
export const EXEMPT_SERVICES = new Map();

/**
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

/** The two shipped nginx configs, listed so a missing one fails. Others are discovered. */
export const NGINX_SOURCES = [
  { file: 'deploy/staging/nginx.conf', read: (text) => text },
  { file: 'docker-compose.yml', read: inlineNginxConfigFrom },
];

/** All three compose files. The disk-exhaustion half of D2 is about every container. */
export const COMPOSE_SOURCES = [
  'docker-compose.yml',
  'docker-compose.staging.yml',
  'docker-compose.observability.yml',
];

/**
 * Every nginx config a compose file carries. `inline` block scalars are audited wherever they are,
 * and `nginx -g` globals are audited as fragments.
 *
 * @returns {{label: string, text: string, kind: 'inline'|'global', complete: boolean}[]}
 */
export function discoveredNginxConfigs(file, composeText) {
  const found = [];
  for (const scalar of blockScalarsIn(composeText)) {
    if (!looksLikeNginx(scalar.text)) continue;
    found.push({
      label: `${file}:${scalar.key}`,
      text: scalar.text,
      kind: 'inline',
      complete: /(^|\n)\s*(?:http|server)\s*\{/.test(stripNginxComments(scalar.text)),
    });
  }
  for (const global of nginxInvocationsIn(composeText).globals) {
    found.push({ label: `${file}: nginx -g '${global}'`, text: global, kind: 'global', complete: false });
  }
  return found;
}

/**
 * A service in more than one compose file must carry the same cap in each, since D2 came from
 * these files drifting.
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
  const audited = new Set();

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
    audited.add(config.trim());
    const findings = nginxFindings(config, source.file);
    for (const finding of findings) target.fail(finding.message, finding.detail);
    if (findings.length === 0) target.note(`${source.file} — access log and error log both sanitised`);
  }

  const capsByFile = new Map();
  let discoveredInline = 0;
  let discoveredInvocations = 0;
  for (const file of COMPOSE_SOURCES) {
    const path = join(root, file);
    if (!existsSync(path)) {
      target.fail(`${file} is missing`, 'a shipped compose file disappeared; this gate checks all three');
      continue;
    }
    const raw = readFileSync(path, 'utf8');

    for (const found of discoveredNginxConfigs(file, raw)) {
      if (found.kind === 'inline') discoveredInline += 1;
      else discoveredInvocations += 1;
      if (audited.has(found.text.trim())) continue;
      audited.add(found.text.trim());
      const findings = nginxFindings(found.text, found.label, { complete: found.complete });
      for (const finding of findings) target.fail(finding.message, finding.detail);
      if (findings.length === 0) target.note(`${found.label} — audited, nothing logged that must not be`);
    }
    for (const configPath of nginxInvocationsIn(raw).configPaths) {
      if (REVIEWED_NGINX_CONFIG_PATHS.has(configPath)) continue;
      target.fail(
        `${file}: nginx -c ${configPath} names a configuration this gate has never read`,
        'add it to REVIEWED_NGINX_CONFIG_PATHS with a sentence saying what puts a file there and which ' +
          'audited source it comes from. A config path nobody can account for is a config nobody reviewed.',
      );
    }

    const { findings, caps } = composeLoggingFindings(raw, file);
    for (const finding of findings) target.fail(finding.message, finding.detail);
    capsByFile.set(file, caps);
    if (findings.length === 0) {
      const shapes = [...caps].map(([name, cap]) => `${name} ${cap.maxSize}x${cap.maxFile}`).join(', ');
      target.note(`${file} — ${caps.size} service(s) capped: ${shapes}`);
    }
  }
  for (const finding of crossFileCapFindings(capsByFile)) target.fail(finding.message, finding.detail);

  // A sweep of nothing is not a pass, and discovery has no list to fall back on.
  if (discoveredInline === 0) {
    target.fail(
      'no inline nginx configuration was discovered in any compose file',
      'docker-compose.yml carries one in a block scalar. Finding none means the discovery this gate ' +
        'depends on has stopped discovering, which is indistinguishable from a clean sweep.',
    );
  }
  if (discoveredInvocations === 0) {
    target.fail(
      'no `nginx -g` command line was discovered in any compose file',
      'both proxies are started by one. Finding none means the scan that reads what is supplied BESIDE ' +
        'the config file has stopped reading, and that is where an error_log level can be reintroduced ' +
        'without touching a reviewed file.',
    );
  }
  target.note(
    `discovered ${discoveredInline} inline nginx config(s) and ${discoveredInvocations} nginx command line(s)`,
  );

  for (const [key, reason] of EXEMPT_SERVICES) target.note(`exempt: ${key} — ${reason}`);

  return target;
}

if (import.meta.main) {
  await runGate(gate, () => runLogPolicyGate());
}

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
 * ## Why this is an ALLOWLIST, and the review that made it one
 *
 * The first version of this gate was a DENYLIST: thirteen variable names no
 * `log_format` could mention, matched with a right-hand word boundary. An
 * adversarial review defeated it five ways, every one of them measured against a
 * real `nginxinc/nginx-unprivileged` container with this gate printing
 * `✓ log policy — pass` and exiting 0:
 *
 *   1. `$arg_code`. `$args` was banned; `$arg_code` is a different variable with the
 *      same contents, one parameter at a time. Measured in the container's access
 *      log: `code=SENTINELCODE123`. That is the exact string this format exists to
 *      keep off disk.
 *   2. One `;` inside the quoted format string. The old matcher was
 *      `/log_format\s+(\w+)([\s\S]*?);/g` — lazy, and blind to quotes — so
 *      `log_format prl_privacy escape=default 'boundary;' '$request' ' $http_cookie';`
 *      read as a format whose whole body was `boundary`. nginx read it as a format
 *      that logs the request line and the session cookie, and that is what the
 *      container wrote:
 *      `boundary;GET /api/v1/auth/oidc/callback?code=SENTINELCODE123&… prl_session=SENTINELCOOKIE789`
 *   3. A `map`. `map $request_uri $prl_path_detail { default "$request_uri"; }` and
 *      then `$prl_path_detail` in the format. The gate read `log_format` bodies and
 *      nothing else, so the laundering step was invisible.
 *   4. `$sent_http_location`, `$http_x_forwarded_uri`, `$http_x_original_uri`,
 *      `$arg_state`, `$request_body_file`. `$http_<anything>` is an open class with
 *      five names denied. Measured: a 302 back to the callback put the code in the
 *      access log through `$sent_http_location`.
 *   5. Reach. `include` was never resolved or flagged; the nginx sources were a
 *      fixed list of two, so a config inlined into `docker-compose.staging.yml` was
 *      invisible; `nginx -g 'error_log /dev/stderr info;'` on a service's entrypoint
 *      was unread (measured: the request line, query string and all, back in the
 *      error log of a container running the SHIPPED, reviewed config); and
 *      `proxy_intercept_errors` was read with `.exec()`, so only the first one in a
 *      file was checked.
 *
 * The lesson is not that five more names belong on the list. nginx has hundreds of
 * variables and four open-ended families (`$arg_*`, `$http_*`, `$sent_http_*`,
 * `$upstream_http_*`), and any denylist over an open set is a list of the leaks
 * somebody has already thought of. So the rule is inverted: **a `log_format` is
 * refused unless every variable in it is on a reviewed allowlist.** A variable
 * nobody has reviewed fails the build instead of reaching a log, and the cost of
 * being wrong moves from "a credential is on disk and nothing is red" to "somebody
 * adds a line to ALLOWED_LOG_VARIABLES and says why".
 *
 * The denylist is kept, but demoted: it no longer decides anything, it only supplies
 * the specific sentence for the thirteen names whose incident is already written
 * down. Everything else is refused with the allowlist's own reason.
 *
 * ## What this gate refuses, and why each one
 *
 *  1. Any `access_log` naming a stock format (`combined`, `main`), or naming
 *     anything other than the reviewed `prl_privacy` — the defect verbatim, and the
 *     defect spelled as an omission (a bare `access_log /dev/stdout;` IS `combined`).
 *  2. Any `log_format` naming a variable that is not on ALLOWED_LOG_VARIABLES, or a
 *     variable on REVIEWED_DERIVED_VARIABLES whose `map` no longer reduces what it
 *     was reviewed for reducing. `escape=none` is refused too: `$uri` is
 *     percent-DECODED, so unescaped it can carry a newline and forge a log line.
 *  3. An `error_log` level looser than `crit`, at any nesting level, including one
 *     supplied on the command line with `nginx -g`. This is the half of the fix that
 *     is easy to lose: `ngx_http_log_error` stamps `request: "<full request line>"`
 *     onto its own messages at any level, in a shape no `log_format` controls, so
 *     fixing the access log alone leaves the credential in the error log. The level
 *     is the only lever nginx offers.
 *  4. A missing `location = /api/v1/auth/oidc/callback` with `error_log /dev/null`.
 *     `crit` is a reduction, not a proof — a genuine `[crit]` such as `open()
 *     failed (13: Permission denied) while reading upstream` still carries the
 *     request line — and on the one path where a query-string value is a
 *     credential by construction, a reduction is not enough.
 *  5. That block routing somewhere other than `location /api/`. It exists ONLY to
 *     narrow the error log, so if it ever routes differently it has silently
 *     become a routing change nobody reviewed. Two blocks carrying the same
 *     traffic are two blocks that can drift.
 *  6. `proxy_intercept_errors` absent, or `on` ANYWHERE in the file. On, an upstream
 *     4xx/5xx is handled by nginx's own `error_page`, which is an internal redirect:
 *     a second pass with a rewritten `$uri` and another opportunity to log a request
 *     that already has a line.
 *  7. `include`, anywhere. This gate cannot follow one — the file it names does not
 *     exist until the image is built — and an `include` is a hole exactly the size
 *     of the file behind it. `nginx -c` naming a path this repository cannot account
 *     for is refused for the same reason, against REVIEWED_NGINX_CONFIG_PATHS.
 *  8. **Any** service, in **any** of the three compose files, with no `logging:`
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
 *  9. A service capped differently in two files that both define it, and a
 *     `max-size`/`max-file` value Docker would refuse. Both are ways for a cap to
 *     look applied and not be.
 *
 * ## Everything, discovered — never a list of today's names
 *
 * Two shipped nginx configs are LISTED and must both be found, because the whole of
 * D2 is that those two files drift and "I found one and it was fine" must never be a
 * pass. Everything else is DISCOVERED, because bypass 5 was reach rather than rules:
 * every `KEY: |` block scalar in every compose file that looks like nginx
 * configuration is audited wherever it sits, and every `nginx` command line in those
 * files has its `-g` global directives audited as configuration and its `-c` path
 * checked against the reviewed set.
 *
 * The compose SERVICES are enumerated from the files for the same reason: the
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
 * to FAIL against mutations of the real shipped text, and all five defeated
 * bypasses above are pinned there as fixtures.
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
 * `escape=` values a shipped `log_format` may use.
 *
 * `none` is the one that matters. `$uri` is percent-DECODED by the time a format
 * sees it, so with escaping off a request for `/a%0a<forged line>` writes two lines
 * into the access log and the second one is whatever the caller wanted it to say.
 */
export const ALLOWED_ESCAPES = new Set(['default', 'json']);

/**
 * **Every variable a shipped `log_format` may name, and why it is safe.**
 *
 * This list is the gate. A variable that is not on it fails the build — not because
 * it is known to leak, but because nobody has said it does not. That is the whole
 * inversion: `$arg_code` reached a container's access log with an OAuth
 * authorization code in it while this gate printed a green tick, and it did so
 * because a denylist can only ever hold the leaks somebody already imagined. nginx
 * has four open-ended variable families (`$arg_*`, `$http_*`, `$sent_http_*`,
 * `$upstream_http_*`); no list of forbidden names can cover an open set, and a list
 * of PERMITTED names does not have to.
 *
 * Adding an entry is cheap and is meant to be: write the name and one clause saying
 * what it can and cannot contain. Two questions decide it — can a caller put bytes
 * of their choosing in it, and is it personal data? `$uri` is here despite being
 * caller-controlled because it is the reviewed compromise D2 was fixed with (the
 * path, never the query string) and because `escape=default` neutralises its bytes.
 * `$remote_addr` is not here despite being neither, because it is personal data the
 * API deliberately stores only as an HMAC.
 *
 * @type {Map<string, string>}
 */
export const ALLOWED_LOG_VARIABLES = new Map([
  // When.
  ['time_iso8601', 'the time nginx wrote the line'],
  ['time_local', 'the same, in the stock format'],
  ['msec', 'the same, as a unix timestamp'],
  // What was asked for, reduced. `$uri` is the path with the query string ALREADY
  // GONE — that removal is the fix for D2 — and `$is_args` says only whether there
  // was a query string, never what was in it.
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
  // Which server answered. None of these is caller-controlled: `$server_name` is
  // the matched `server_name` directive, not the Host header.
  ['server_name', 'the matched server_name directive, not the Host header'],
  ['server_port', 'the port this server is listening on'],
  ['hostname', "the container's own hostname"],
  ['ssl_protocol', 'the negotiated TLS version'],
  ['ssl_cipher', 'the negotiated cipher suite'],
  // Where it went, and what came back. Upstream diagnostics are what replaced the
  // error log when its level went to `crit`; every one of them is generated by
  // nginx or by our own API, never by a caller.
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
 * Variables a `map` computes, and the variable each one is reviewed to REDUCE.
 *
 * These are the redactions themselves: `$prl_client_net` is `$remote_addr` truncated
 * to a network, `$prl_ua_class` is `$http_user_agent` collapsed to one of five
 * words. Both read a source that is forbidden in a log format and both are legal in
 * one, which is exactly the shape a laundering bypass wears — `map $request_uri
 * $prl_path_detail { default "$request_uri"; }` is four words away from the real
 * thing and put the full query string into a container's access log with this gate
 * green.
 *
 * So a derived variable is accepted only against the map it was reviewed with:
 * exactly one map defines it, that map reads the source named here, and every `$…`
 * the map RETURNS is a named capture from the same rule's own regex — never the
 * source variable passed through. A capture whose pattern can match any character is
 * refused too, because `"~^(?<all>.*)$" "$all"` is the identity function wearing a
 * redaction's clothes.
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
 * Variables whose specific incident is already written down.
 *
 * **This list no longer decides anything.** The allowlist above refuses every
 * variable that is not on it, these thirteen included; what this adds is the
 * sentence. A failure that says "logs $http_cookie — the session cookie, a
 * credential outright" is read; one that says "not on the reviewed allowlist" is
 * argued with. Both are refusals.
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
 * The `-c` paths a shipped `nginx` command line may name, and what fills each.
 *
 * An allowlist for the same reason the variables are one: `nginx -c /some/other.conf`
 * runs a configuration this gate has never read, and there is no way to tell from
 * here whether it is the reviewed file or a copy of the pre-fix one. A new path has
 * to arrive with a sentence saying what puts it there.
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
 * Read an nginx configuration the way nginx reads it: as tokens, not as lines.
 *
 * Written because a regex could not. The old gate found log formats with
 * `/log_format\s+(\w+)([\s\S]*?);/g`, which is lazy and quote-unaware, so a single
 * `;` inside the first quoted fragment of a format ended the match three arguments
 * early and hid `$request` and `$http_cookie` from the rule that exists to find
 * them. That was not a bug in the regex. nginx's configuration is a token stream
 * where `;`, `{` and `}` are terminators OUTSIDE quotes and ordinary characters
 * INSIDE them, and nothing that does not track quotes can agree with it about where
 * a directive ends.
 *
 * Quotes are stripped from the token, and a quoted empty string still produces a
 * token — `map $http_upgrade $connection_upgrade { default upgrade; '' close; }`
 * has an entry whose key is the empty string, and dropping it would lose the rule
 * that matters. Backslash escapes are kept as written, because the tokens this gate
 * inspects most closely are regexes and `\.` must not silently become `.`.
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
 * Every `map` in a configuration, keyed by the variable it DEFINES.
 *
 * Keyed by the target rather than listed, because the question this gate asks is
 * always "where did the value in `$prl_client_net` come from" — and because a
 * variable defined by two maps is itself a finding: nginx takes the last one and a
 * reviewer reads the first.
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

/**
 * What is wrong with the `map` behind a reviewed derived variable, or null.
 *
 * See REVIEWED_DERIVED_VARIABLES for why this is checked at all. The short version:
 * `$prl_client_net` is only a redaction for as long as the map behind it truncates
 * an address, and nothing about the NAME says it still does.
 */
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
  const found = blockScalarsIn(composeText).find((scalar) => scalar.key === 'PRL_PROXY_NGINX_CONF');
  return found === undefined ? null : found.text;
}

/**
 * Every `KEY: |` block scalar in a compose file, with compose's `$$` undone.
 *
 * Generalised out of `inlineNginxConfigFrom` because the fixed two-element source
 * list was bypass 5: an nginx configuration inlined into `docker-compose.staging.yml`
 * under any name at all was invisible to this gate, and the one that was measured
 * shipped `error_log /dev/stderr info;` and a format logging `$request $http_cookie`.
 * A block scalar is where an nginx config hides in a compose file, so all of them
 * are read and the ones that look like configuration are audited.
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
 * Every `nginx` command line in a compose file, and what it puts on it.
 *
 * `nginx -g '<directives>'` prepends directives to the MAIN configuration context —
 * which means a service's `entrypoint:` can set the error-log level of a
 * configuration this gate has already read and approved. Measured against a
 * throwaway container running the SHIPPED `deploy/staging/nginx.conf` with
 * `-g 'daemon off; error_log /dev/stderr info;'`:
 *
 *     2026/08/25 17:25:07 [error] 29#29: *3 connect() failed (111: Connection refused)
 *     while connecting to upstream, client: 172.17.0.1, server: _, request:
 *     "GET /api/v1/session?code=SENTINELCODE123&state=SENTINELSTATE456 HTTP/1.1"
 *
 * The same run with `-g 'daemon off;'` alone logged the sentinel zero times. The
 * config was never edited; the level was supplied beside it, in a file this gate
 * read for something else entirely.
 *
 * Both spellings are matched, because compose has two: the shell form
 * `nginx -c /tmp/nginx.conf -g 'daemon off;'` and the exec-array form
 * `['nginx', '-c', '/etc/nginx/nginx.conf', '-g', 'daemon off;']`.
 *
 * @returns {{configPaths: string[], globals: string[]}}
 */
export function nginxInvocationsIn(composeText) {
  const configPaths = new Set();
  const globals = new Set();
  for (const line of stripYamlComments(composeText).split('\n')) {
    // From the `nginx` word onwards, never the whole line: the development stack
    // starts its proxy with `sh -c "exec nginx -c /tmp/nginx.conf …"`, and a scan of
    // the whole line reads the SHELL's `-c` as nginx's and reports `exec` as a
    // configuration file. A gate whose failures are nonsense gets switched off.
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

/**
 * The text between the brace at `open` and its match.
 *
 * Quote-aware, because a brace inside a `map` regex (`"~*(bot){2}"`) is a character
 * and not a block, and a brace counter that disagreed with nginx about that would
 * hand the callback-block rules the wrong text.
 */
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
 * Audit one nginx configuration, or one fragment of one.
 *
 * `complete` distinguishes a whole server configuration from a fragment such as the
 * directives on an `nginx -g` command line. Every rule about what a directive SAYS
 * applies to both; the rules about what must be PRESENT (an access log, the reviewed
 * format, the callback block) apply only to a configuration that serves traffic,
 * because "this `-g 'daemon off;'` has no OIDC callback block" is a finding about
 * nothing.
 *
 * @returns {{message: string, detail: string}[]} empty when the config is clean.
 */
export function nginxFindings(rawText, label, { complete = true } = {}) {
  const text = stripNginxComments(rawText);
  const directives = nginxDirectives(text);
  const maps = nginxMaps(directives);
  const findings = [];
  const fail = (message, detail) => findings.push({ message: `${label}: ${message}`, detail });

  // 7. An include is a hole the size of the file behind it, and this gate cannot
  // open that file: it does not exist until the image is built.
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
    // `buffer=`, `gzip`, `flush=` and `if=` are parameters, not a format name; an
    // access_log with only those has no format, which IS `combined`.
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

  // 6. proxy_intercept_errors on = an internal redirect = a second chance to log.
  // Every occurrence, not the first: a `location` block can turn back on what the
  // `server` block turned off, and reading only the first said nothing about it.
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
 * Every service defined in a compose file, with its body.
 *
 * Enumerated from the text rather than from a hand-maintained list, which is the
 * whole point: this gate has to fail for a service that does not exist yet. A
 * service added next month arrives with no `logging:` block, and if the gate only
 * knew the names of today's services it would pass it in silence — which is
 * exactly how `access_log ... combined;` shipped for as long as it did.
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
 * never be a pass. Everything BEYOND these two is discovered — see
 * `discoveredNginxConfigs`, which exists because a fixed list of two was bypass 5.
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
 * Every nginx configuration a compose file carries, found rather than listed.
 *
 * Three kinds, and each of them was a way past the old gate:
 *
 *   * `inline` — a `KEY: |` block scalar whose text looks like nginx configuration,
 *     under ANY key, in ANY of the compose files. The old gate read one variable in
 *     one file by name.
 *   * `global` — the directives on an `nginx -g '…'` command line, audited as a
 *     FRAGMENT: what it says is checked, what it omits is not.
 *   * `configPath` — the `-c` argument, which is not audited but must be a path
 *     REVIEWED_NGINX_CONFIG_PATHS accounts for, because a configuration this gate
 *     has never read is not a configuration this gate can vouch for.
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
  /** Configurations already audited, by text, so discovery does not report them twice. */
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

    // Everything nginx in this file, whether or not anybody told this gate about it.
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

  // A sweep of nothing is not a pass, and discovery is the half of this gate with
  // nothing listed to fall back on. If the inline config is renamed out of reach, or
  // the proxy stops being started by an `nginx` command line this can read, the
  // right answer is a failure and not a quieter report.
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

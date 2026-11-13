#!/usr/bin/env node
/**
 * Tests for the `log policy` gate. Run with `node --test scripts/supply-chain/log-policy.test.mjs`.
 *
 * D2 had two halves: `combined` logging the OIDC authorization code, and no compose service having a
 * `logging:` cap. Every rule gets a positive control on the real files and a negative control that
 * mutates the real text in memory back towards the pre-fix shape. The one hand-written fixture is
 * the verbatim pre-fix `http` block. The five bypasses a review measured against a real container
 * are pinned below as mutations, each with the line the container wrote.
 *
 * Mutation checks run against the gate: emptying `STOCK_FORMATS` failed 26 tests, returning only the
 * first compose service failed 5, disabling the `json-file` driver check failed 3, and an
 * unconditional `EXEMPT_SERVICES` skip failed 26.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Gate } from './lib.mjs';
import {
  ALLOWED_LOG_VARIABLES,
  COMPOSE_SOURCES,
  composeLoggingFindings,
  composeServices,
  crossFileCapFindings,
  derivedVariableProblem,
  discoveredNginxConfigs,
  EXEMPT_SERVICES,
  FORBIDDEN_LOG_VARIABLES,
  inlineNginxConfigFrom,
  locationBody,
  logCapOf,
  nginxDirectives,
  nginxFindings,
  nginxInvocationsIn,
  nginxMaps,
  OIDC_CALLBACK_PATH,
  REVIEWED_DERIVED_VARIABLES,
  REVIEWED_NGINX_CONFIG_PATHS,
  runLogPolicyGate,
  stripNginxComments,
  upstreamOf,
  variablesIn,
} from './log-policy.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const GATE = join(HERE, 'log-policy.mjs');

const STAGING_CONF = readFileSync(join(REPO_ROOT, 'deploy/staging/nginx.conf'), 'utf8');
const DEV_COMPOSE = readFileSync(join(REPO_ROOT, 'docker-compose.yml'), 'utf8');
const STAGING_COMPOSE = readFileSync(join(REPO_ROOT, 'docker-compose.staging.yml'), 'utf8');
const OBSERVABILITY_COMPOSE = readFileSync(join(REPO_ROOT, 'docker-compose.observability.yml'), 'utf8');
const DEV_CONF = inlineNginxConfigFrom(DEV_COMPOSE);

const COMPOSE_FILES = [
  ['docker-compose.yml', DEV_COMPOSE],
  ['docker-compose.staging.yml', STAGING_COMPOSE],
  ['docker-compose.observability.yml', OBSERVABILITY_COMPOSE],
];

const SHIPPED = [
  ['deploy/staging/nginx.conf', STAGING_CONF],
  ['docker-compose.yml (inline)', DEV_CONF],
];

function complainsAbout(findings, fragment) {
  return findings.some((finding) => finding.message.includes(fragment));
}

/**
 * Return `compose` with one service's `logging:` block deleted, from the raw text, so the failure is
 * shown on something that could really be committed.
 */
function withoutCapFor(compose, service) {
  const lines = compose.split('\n');
  const start = lines.indexOf(`  ${service}:`);
  assert.notEqual(start, -1, `service ${service} not found in the raw compose text`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() !== '' && !/^\s{3}/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const before = lines.slice(0, start);
  const body = lines.slice(start, end);
  const after = lines.slice(end);
  const at = body.indexOf('    logging:');
  assert.notEqual(at, -1, `service ${service} has no logging: block to remove`);
  let stop = at + 1;
  while (stop < body.length && /^ {6,8}\S/.test(body[stop])) stop += 1;
  return [...before, ...body.slice(0, at), ...body.slice(stop), ...after].join('\n');
}

/**
 * The defect lines of `deploy/staging/nginx.conf` at commit 5e3cbbc, copied verbatim. TLS, timeout
 * and header config the gate does not read is dropped.
 */
const PRE_FIX_CONFIG = `
pid /tmp/nginx.pid;
error_log /dev/stderr warn;

events {
  worker_connections 1024;
}

http {
  access_log /dev/stdout combined;
  server {
    listen 8443 ssl;
    location /api/ {
      set $upstream_api "api:3001";
      proxy_pass http://$upstream_api$request_uri;
    }
  }
}
`;

describe('positive control: the shipped configuration passes', () => {
  it('the gate exits 0 against the real repository', () => {
    const run = spawnSync(process.execPath, [GATE], { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.equal(run.status, 0, `gate failed against the shipped files:\n${run.stdout}${run.stderr}`);
  });

  for (const [label, config] of SHIPPED) {
    it(`${label} has no findings`, () => {
      assert.deepEqual(nginxFindings(config, label), []);
    });
  }

  for (const [label, compose] of COMPOSE_FILES) {
    it(`${label}: every service is capped`, () => {
      const { findings } = composeLoggingFindings(compose, label);
      assert.deepEqual(findings, []);
    });
  }

  it('the services this gate found are the services that are actually there', () => {
    // Expected names are written by hand, not read through `composeServices`, so a parser that
    // stops parsing fails here.
    const expected = {
      'docker-compose.yml': ['postgres', 'api', 'web', 'proxy'],
      'docker-compose.staging.yml': ['postgres', 'api', 'web', 'proxy'],
      // `blackbox` was added by somebody else and this list went red until a person agreed.
      'docker-compose.observability.yml': ['prometheus', 'blackbox', 'alertmanager'],
    };
    for (const [label, compose] of COMPOSE_FILES) {
      assert.deepEqual(
        composeServices(compose).map((service) => service.name),
        expected[label],
        `${label}: discovered services do not match the file`,
      );
    }
  });

  it('a service shared between two files carries the same cap in both', () => {
    const capsByFile = new Map(
      COMPOSE_FILES.map(([label, compose]) => [label, composeLoggingFindings(compose, label).caps]),
    );
    assert.deepEqual(crossFileCapFindings(capsByFile), []);
  });

  it('every exemption is named and reasoned, and there are none today', () => {
    for (const [key, reason] of EXEMPT_SERVICES) {
      assert.match(key, /^[^:]+:[^:]+$/, `exemption key ${key} is not <compose file>:<service>`);
      assert.ok(String(reason).length > 30, `exemption ${key} has no real reason`);
    }
    assert.equal(EXEMPT_SERVICES.size, 0, 'an exemption was added — was it argued in the map comment?');
  });

  it('the gate covers all three compose files', () => {
    assert.deepEqual(
      COMPOSE_SOURCES,
      COMPOSE_FILES.map(([label]) => label),
    );
  });

  it('the inline config is actually found in docker-compose.yml', () => {
    // If PRL_PROXY_NGINX_CONF is renamed, every nginx rule silently stops running.
    assert.ok(DEV_CONF?.includes('access_log'), 'no inline nginx config extracted');
  });

  it('compose $$ escapes are undone before the config is judged', () => {
    assert.ok(DEV_COMPOSE.includes('$$uri'), 'the compose file no longer uses $$ escaping');
    assert.ok(!DEV_CONF.includes('$$'), 'inlineNginxConfigFrom left compose escapes in place');
  });
});

describe('negative control: the pre-fix configuration is refused', () => {
  const findings = nginxFindings(PRE_FIX_CONFIG, 'pre-fix');

  it('refuses the stock `combined` format — the defect verbatim', () => {
    assert.ok(complainsAbout(findings, 'stock format `combined`'), JSON.stringify(findings, null, 2));
  });

  it('refuses an error_log looser than crit', () => {
    assert.ok(complainsAbout(findings, 'error_log /dev/stderr is at `warn`'));
  });

  it('refuses a config with no OIDC callback block', () => {
    assert.ok(complainsAbout(findings, `no \`location = ${OIDC_CALLBACK_PATH}\``));
  });

  it('refuses a config that does not state proxy_intercept_errors', () => {
    assert.ok(complainsAbout(findings, 'proxy_intercept_errors is not stated'));
  });

  it('refuses a config with no reviewed log_format at all', () => {
    assert.ok(complainsAbout(findings, 'no log_format is defined'));
  });
});

describe('negative control: each rule, against the real shipped text', () => {
  for (const [label, config] of SHIPPED) {
    it(`${label}: reverting the access_log to combined fails`, () => {
      const broken = config.replace(/access_log (\S+) prl_privacy;/, 'access_log $1 combined;');
      assert.notEqual(broken, config, 'the mutation did not apply — this test is no longer testing anything');
      assert.ok(complainsAbout(nginxFindings(broken, label), 'stock format `combined`'));
    });

    it(`${label}: putting $request back into the log_format fails`, () => {
      const broken = config.replace('"$request_method $uri$is_args"', '"$request"');
      assert.notEqual(broken, config, 'the mutation did not apply');
      assert.ok(complainsAbout(nginxFindings(broken, label), 'logs $request'));
    });

    it(`${label}: logging the raw address or user agent fails`, () => {
      // Mutate the log_format, not the map that defines `$prl_client_net`, which must stay legal.
      for (const [safe, raw] of [
        ['$prl_client_net $prl_ua_class', '$remote_addr $prl_ua_class'],
        ['$prl_client_net $prl_ua_class', '$prl_client_net $http_user_agent'],
      ]) {
        const broken = config.replace(safe, raw);
        assert.notEqual(broken, config, `the ${raw} mutation did not apply`);
        const wanted = raw.includes('$remote_addr') ? 'logs $remote_addr' : 'logs $http_user_agent';
        assert.ok(complainsAbout(nginxFindings(broken, label), wanted), `${raw} was accepted`);
      }
    });

    it(`${label}: loosening the error_log level fails`, () => {
      const broken = config.replace('error_log /dev/stderr crit;', 'error_log /dev/stderr warn;');
      assert.notEqual(broken, config, 'the mutation did not apply');
      assert.ok(complainsAbout(nginxFindings(broken, label), 'is at `warn`'));
    });

    it(`${label}: deleting the callback block's /dev/null error log fails`, () => {
      const broken = config.replace('      error_log /dev/null crit;\n', '');
      assert.notEqual(broken, config, 'the mutation did not apply');
      assert.ok(complainsAbout(nginxFindings(broken, label), 'does not send its error log to /dev/null'));
    });

    it(`${label}: drifting the callback block's upstream fails`, () => {
      const body = locationBody(stripNginxComments(config), `= ${OIDC_CALLBACK_PATH}`);
      const upstream = upstreamOf(body);
      assert.ok(upstream, 'the callback block has no readable upstream');
      const broken = config.replace(body, body.replace(upstream, 'somewhere-else:9999'));
      assert.notEqual(broken, config, 'the mutation did not apply');
      assert.ok(complainsAbout(nginxFindings(broken, label), 'but location /api/ routes to'));
    });

    it(`${label}: turning proxy_intercept_errors on fails`, () => {
      const broken = config.replace('proxy_intercept_errors off;', 'proxy_intercept_errors on;');
      assert.notEqual(broken, config, 'the mutation did not apply');
      assert.ok(complainsAbout(nginxFindings(broken, label), 'proxy_intercept_errors is on'));
    });
  }

  for (const [label, compose] of COMPOSE_FILES) {
    // Every service, one at a time. Removing only the first cap would pass with the rest uncapped.
    for (const { name } of composeServices(compose)) {
      it(`${label}: removing \`${name}\`'s log cap fails`, () => {
        const broken = withoutCapFor(compose, name);
        assert.notEqual(broken, compose, `the ${name} mutation did not apply`);
        const { findings } = composeLoggingFindings(broken, label);
        assert.ok(
          complainsAbout(findings, `service \`${name}\` has no \`logging:\` block`),
          `${name} was accepted uncapped: ${JSON.stringify(findings)}`,
        );
      });
    }

    it(`${label}: dropping max-size from a cap fails`, () => {
      const broken = compose.replace(/^ {8}max-size: '[^']+'\n/m, '');
      assert.notEqual(broken, compose, 'the mutation did not apply');
      assert.ok(complainsAbout(composeLoggingFindings(broken, label).findings, 'no max-size'));
    });

    it(`${label}: dropping max-file from a cap fails`, () => {
      const broken = compose.replace(/^ {8}max-file: '[^']+'\n/m, '');
      assert.notEqual(broken, compose, 'the mutation did not apply');
      assert.ok(complainsAbout(composeLoggingFindings(broken, label).findings, 'no max-file'));
    });

    it(`${label}: switching a service to the \`none\` driver fails`, () => {
      // `driver: none` bounds the disk and destroys the log.
      const broken = compose.replace(/^ {6}driver: json-file$/m, '      driver: none');
      assert.notEqual(broken, compose, 'the mutation did not apply');
      assert.ok(complainsAbout(composeLoggingFindings(broken, label).findings, 'rather than json-file'));
    });

    it(`${label}: a max-size Docker would refuse fails`, () => {
      const broken = compose.replace(/^ {8}max-size: '[^']+'$/m, "        max-size: 'lots'");
      assert.notEqual(broken, compose, 'the mutation did not apply');
      assert.ok(
        complainsAbout(composeLoggingFindings(broken, label).findings, 'which Docker will not accept'),
      );
    });

    it(`${label}: a service with no logging: block at all is caught wherever it sits`, () => {
      // The "added next month" case: a name the gate has never seen.
      const broken = `${compose.trimEnd()}\n`.replace(
        /^volumes:$/m,
        '  newcomer:\n    image: example:1@sha256:0\n    restart: unless-stopped\n\nvolumes:',
      );
      const withService = broken === compose ? `${compose}\n  newcomer:\n    image: example:1\n` : broken;
      assert.ok(
        complainsAbout(
          composeLoggingFindings(withService, label).findings,
          'service `newcomer` has no `logging:` block',
        ),
        'a service the gate had never seen arrived uncapped and was accepted',
      );
    });
  }

  it('a service capped differently in two files fails', () => {
    const drifted = STAGING_COMPOSE.replace(/^ {8}max-size: '20m'$/m, "        max-size: '5m'");
    assert.notEqual(drifted, STAGING_COMPOSE, 'the mutation did not apply');
    const capsByFile = new Map([
      ['docker-compose.yml', composeLoggingFindings(DEV_COMPOSE, 'docker-compose.yml').caps],
      ['docker-compose.staging.yml', composeLoggingFindings(drifted, 'docker-compose.staging.yml').caps],
    ]);
    assert.ok(complainsAbout(crossFileCapFindings(capsByFile), 'service `api` is capped'));
  });
});

describe('the gate reads configuration, not prose', () => {
  it('accepts the safe $request_* variables the shipped format uses', () => {
    // A substring match on `$request` would reject the very format it enforces.
    const config = `
      log_format ok escape=default '$request_method $uri $request_time $request_length $request_id';
      access_log /dev/stdout prl_privacy;
      error_log /dev/stderr crit;
      proxy_intercept_errors off;
      location = ${OIDC_CALLBACK_PATH} { error_log /dev/null crit; set $u "api:3001"; proxy_pass http://$u; }
      location /api/ { set $u "api:3001"; proxy_pass http://$u; }
    `;
    const findings = nginxFindings(config, 'safe-variables');
    assert.ok(!complainsAbout(findings, 'logs $request'), JSON.stringify(findings, null, 2));
  });

  it('does not trip on its own documentation', () => {
    // The shipped configs explain the leak in comments. A gate that read comments would fail on
    // them, so both sources are asserted to still carry that prose.
    for (const [label, source] of [
      ['deploy/staging/nginx.conf', STAGING_CONF],
      ['docker-compose.yml', DEV_COMPOSE],
    ]) {
      assert.ok(source.includes('combined'), `${label} no longer explains what combined did`);
      assert.ok(source.includes('$request"'), `${label} no longer names the variable that leaked`);
    }
    for (const [label, config] of SHIPPED) {
      assert.deepEqual(nginxFindings(config, label), [], `${label} tripped on its own comments`);
    }
  });

  it('reads a cap out of a service body, and distinguishes absent from malformed', () => {
    // `logCapOf` returns null only for a missing block, so "no logging: block" and "no max-file"
    // are reported as different mistakes.
    assert.equal(logCapOf('    image: x\n    restart: unless-stopped\n'), null);
    assert.deepEqual(logCapOf("    logging:\n      driver: json-file\n        max-size: '10m'\n"), {
      driver: 'json-file',
      maxSize: '10m',
      maxFile: null,
    });
    assert.deepEqual(
      logCapOf(
        "    logging:\n      driver: json-file\n      options:\n        max-size: '20m'\n        max-file: '5'\n",
      ),
      { driver: 'json-file', maxSize: '20m', maxFile: '5' },
    );
  });

  it('strips a comment but not a # inside a quoted string', () => {
    assert.equal(stripNginxComments('access_log x; # combined was here'), 'access_log x; ');
    assert.equal(stripNginxComments('map $a $b { "~*bot#1" "bot"; }'), 'map $a $b { "~*bot#1" "bot"; }');
  });

  it('an access_log with no format at all is refused', () => {
    // Bare `access_log /dev/stdout;` is nginx's default, `combined`.
    const findings = nginxFindings('access_log /dev/stdout;\nerror_log /dev/stderr crit;', 'bare');
    assert.ok(complainsAbout(findings, 'rather than `prl_privacy`'), JSON.stringify(findings, null, 2));
  });

  it('a gate that finds no config must not pass', () => {
    assert.equal(inlineNginxConfigFrom('services:\n  proxy:\n    image: nginx\n'), null);
    const run = spawnSync(process.execPath, [GATE], { cwd: '/', encoding: 'utf8' });
    assert.equal(run.status, 0, 'the gate resolves its own repo root, so cwd must not change the verdict');
  });
});

const GATE_INPUTS = [
  'deploy/staging/nginx.conf',
  'docker-compose.yml',
  'docker-compose.staging.yml',
  'docker-compose.observability.yml',
];

/**
 * Run the real gate against a throwaway copy of the repo. Three of the five bypasses defeated reach,
 * not a rule, so calling `nginxFindings` directly would hand the rule text the real run never saw.
 */
function gateVerdictFor(mutate) {
  const root = mkdtempSync(join(tmpdir(), 'prl-log-policy-'));
  mkdirSync(join(root, 'deploy/staging'), { recursive: true });
  for (const file of GATE_INPUTS) cpSync(join(REPO_ROOT, file), join(root, file));
  const read = (file) => readFileSync(join(root, file), 'utf8');
  const write = (file, text) => {
    assert.notEqual(text, read(file), `the mutation of ${file} did not apply`);
    writeFileSync(join(root, file), text);
  };
  mutate({ read, write });
  const gate = runLogPolicyGate(root, new Gate('log policy'));
  return {
    failures: gate.failures,
    complains: (fragment) => gate.failures.some((failure) => failure.message.includes(fragment)),
    text: JSON.stringify(gate.failures, null, 2),
  };
}

describe('positive control: an unmutated copy of the repo still passes', () => {
  it('the gate finds nothing to complain about', () => {
    // The control for every test below, so a broken harness cannot pass them.
    const verdict = gateVerdictFor(() => {
      // Deliberately mutates nothing.
    });
    assert.deepEqual(verdict.failures, [], verdict.text);
  });
});

describe('negative control: the five measured bypasses', () => {
  it('1. $arg_code — a denied $args and an allowed $arg_code are the same string', () => {
    // Measured before the fix, in a real nginxinc/nginx-unprivileged container:
    //
    //   2026-08-25T17:23:19+00:00 172.17.0.0/24 tool "GET /api/v1/auth/oidc/callback?"
    //   code=SENTINELCODE123 502 157 rt=30.007 up=- us=- urt=- rid=-
    const verdict = gateVerdictFor(({ read, write }) =>
      write(
        'deploy/staging/nginx.conf',
        read('deploy/staging/nginx.conf').replace(
          '"$request_method $uri$is_args" ',
          '"$request_method $uri$is_args" code=$arg_code ',
        ),
      ),
    );
    assert.ok(verdict.complains('logs $arg_code, which is not on the reviewed allowlist'), verdict.text);
  });

  it('2. a `;` inside the quoted format string hid the rest of the format', () => {
    // Measured, the container wrote the request line and the session cookie:
    //
    //   boundary;GET /api/v1/auth/oidc/callback?code=SENTINELCODE123&state=SENTINELSTATE456
    //   HTTP/1.1 prl_session=SENTINELCOOKIE789
    const verdict = gateVerdictFor(({ read, write }) =>
      write(
        'deploy/staging/nginx.conf',
        read('deploy/staging/nginx.conf').replace(
          '    \'$time_iso8601 $prl_client_net $prl_ua_class "$request_method $uri$is_args" \'',
          "    'boundary;' '$request' ' $http_cookie' ",
        ),
      ),
    );
    assert.ok(verdict.complains('logs $request'), verdict.text);
    assert.ok(verdict.complains('logs $http_cookie'), verdict.text);
  });

  it('3. a map launders $request_uri into an innocent-looking name', () => {
    // Measured, the full query string reached the access log through an innocent-looking name.
    const verdict = gateVerdictFor(({ read, write }) => {
      const original = read('deploy/staging/nginx.conf');
      write(
        'deploy/staging/nginx.conf',
        original
          .replace(
            '  # See the header for why every field here is the field it is.',
            '  map $request_uri $prl_path_detail {\n    default "$request_uri";\n  }\n\n' +
              '  # See the header for why every field here is the field it is.',
          )
          .replace('"$request_method $uri$is_args" ', '"$request_method $prl_path_detail" '),
      );
    });
    assert.ok(verdict.complains('logs $prl_path_detail'), verdict.text);
    // The failure must say it is laundered, or the quick fix is to allowlist the name.
    assert.ok(
      verdict.failures.some((failure) => (failure.detail ?? '').includes('map $request_uri')),
      verdict.text,
    );
  });

  it('4. $sent_http_location and the rest of an open class', () => {
    // Measured, a 302 back to the callback put the code in the access log:
    //
    //   … 302 145 … loc=http://127.0.0.1:8080/signed-in?code=SENTINELCODE123&state=…
    //   xfu=/cb?code=SENTINELCODE123 bf=-
    const leaky = [
      'sent_http_location',
      'http_x_forwarded_uri',
      'http_x_original_uri',
      'arg_state',
      'request_body_file',
    ];
    const verdict = gateVerdictFor(({ read, write }) =>
      write(
        'deploy/staging/nginx.conf',
        read('deploy/staging/nginx.conf').replace(
          "rid=$upstream_http_x_request_id';",
          `rid=$upstream_http_x_request_id '\n    '${leaky.map((name) => `$${name}`).join(' ')}';`,
        ),
      ),
    );
    for (const name of leaky) {
      assert.ok(verdict.complains(`logs $${name}`), `$${name} was accepted:\n${verdict.text}`);
    }
  });

  it('5a. `include` pulls in a file this gate cannot read', () => {
    const verdict = gateVerdictFor(({ read, write }) =>
      write(
        'deploy/staging/nginx.conf',
        read('deploy/staging/nginx.conf').replace(
          '  access_log /dev/stdout prl_privacy;',
          '  include /etc/nginx/extra/*.conf;\n  access_log /dev/stdout prl_privacy;',
        ),
      ),
    );
    assert.ok(verdict.complains('include /etc/nginx/extra/*.conf'), verdict.text);
  });

  it('5b. an nginx config inlined into a compose file the gate did not list', () => {
    const verdict = gateVerdictFor(({ read, write }) =>
      write(
        'docker-compose.staging.yml',
        read('docker-compose.staging.yml').replace(
          '  proxy:\n',
          '  proxy:\n    environment:\n      PRL_PROXY_ALT_CONF: |\n' +
            '        error_log /dev/stderr info;\n' +
            '        http {\n' +
            "          log_format leaky escape=default '$$request $$http_cookie';\n" +
            '          access_log /dev/stdout leaky;\n' +
            '        }\n',
        ),
      ),
    );
    assert.ok(verdict.complains('docker-compose.staging.yml:PRL_PROXY_ALT_CONF'), verdict.text);
    assert.ok(verdict.complains('logs $request'), verdict.text);
    assert.ok(verdict.complains('is at `info`'), verdict.text);
  });

  it("5c. `nginx -g 'error_log … info;'` beside a config the gate approved", () => {
    // The reviewed file is untouched. Measured with the shipped staging config:
    //
    //   2026/08/25 17:25:07 [error] 29#29: *3 connect() failed … request:
    //   "GET /api/v1/session?code=SENTINELCODE123&state=SENTINELSTATE456 HTTP/1.1"
    //
    // The same container with `-g 'daemon off;'` logged the sentinel zero times.
    const verdict = gateVerdictFor(({ read, write }) =>
      write(
        'docker-compose.staging.yml',
        read('docker-compose.staging.yml').replace(
          "'-g', 'daemon off;'",
          "'-g', 'daemon off; error_log /dev/stderr info;'",
        ),
      ),
    );
    assert.ok(verdict.complains("nginx -g 'daemon off; error_log /dev/stderr info;'"), verdict.text);
    assert.ok(verdict.complains('is at `info`'), verdict.text);
  });

  it('5d. a second proxy_intercept_errors, turned on where the first is off', () => {
    // `.exec()` once read only the first match.
    const verdict = gateVerdictFor(({ read, write }) =>
      write(
        'deploy/staging/nginx.conf',
        read('deploy/staging/nginx.conf').replace(
          '    location /api/ {\n',
          '    location /api/ {\n      proxy_intercept_errors on;\n',
        ),
      ),
    );
    assert.ok(verdict.complains('proxy_intercept_errors is on'), verdict.text);
  });

  it('5e. `nginx -c` naming a config nothing in this repository accounts for', () => {
    const verdict = gateVerdictFor(({ read, write }) =>
      write(
        'docker-compose.staging.yml',
        read('docker-compose.staging.yml').replace(
          "'-c', '/etc/nginx/nginx.conf'",
          "'-c', '/etc/nginx/other.conf'",
        ),
      ),
    );
    assert.ok(verdict.complains('nginx -c /etc/nginx/other.conf'), verdict.text);
  });
});

describe('the allowlist, and why it is one', () => {
  const around = (format, extra = '') => `
    ${extra}
    ${format}
    access_log /dev/stdout prl_privacy;
    error_log /dev/stderr crit;
    proxy_intercept_errors off;
    location = ${OIDC_CALLBACK_PATH} { error_log /dev/null crit; set $u "api:3001"; proxy_pass http://$u; }
    location /api/ { set $u "api:3001"; proxy_pass http://$u; }
  `;

  it('refuses a variable nobody has reviewed, without knowing anything about it', () => {
    // Refused only because nobody wrote down that it is safe.
    const findings = nginxFindings(around("log_format prl_privacy '$prl_something_new';"), 'unknown');
    assert.ok(complainsAbout(findings, 'logs $prl_something_new, which is not on the reviewed allowlist'));
  });

  it('accepts every variable the shipped format uses, and each has a written reason', () => {
    for (const [name, why] of ALLOWED_LOG_VARIABLES) {
      assert.match(name, /^[a-z][a-z0-9_]*$/, `${name} is not a bare variable name`);
      assert.ok(String(why).length > 8, `$${name} is on the allowlist with no reason beside it`);
    }
    for (const name of ['uri', 'is_args', 'request_method', 'status', 'upstream_http_x_request_id']) {
      assert.ok(ALLOWED_LOG_VARIABLES.has(name), `$${name} is in the shipped format and not allowed`);
    }
  });

  it('allows no variable that the incident list forbids', () => {
    // A name on both lists would let the allowlist win silently.
    for (const { name } of FORBIDDEN_LOG_VARIABLES) {
      assert.ok(!ALLOWED_LOG_VARIABLES.has(name), `$${name} is both allowed and forbidden`);
      assert.ok(!REVIEWED_DERIVED_VARIABLES.has(name), `$${name} is both derived and forbidden`);
    }
  });

  it('still says WHY for the thirteen names whose incident is written down', () => {
    const findings = nginxFindings(around("log_format prl_privacy '$http_cookie';"), 'known');
    const cookie = findings.find((finding) => finding.message.includes('logs $http_cookie'));
    assert.ok(cookie, JSON.stringify(findings, null, 2));
    assert.match(cookie.detail, /credential outright/);
  });

  it('accepts the safe $request_* variables the shipped format uses', () => {
    // Pins the four allowlist entries the shipped format needs.
    const findings = nginxFindings(
      around(
        "log_format prl_privacy escape=default '$request_method $uri $request_time $request_length $request_id';",
      ),
      'safe-variables',
    );
    assert.deepEqual(findings, [], JSON.stringify(findings, null, 2));
  });

  it('refuses escape=none, which turns a decoded $uri into a log-line forger', () => {
    const findings = nginxFindings(around("log_format prl_privacy escape=none '$uri';"), 'escape');
    assert.ok(complainsAbout(findings, 'sets escape=none'), JSON.stringify(findings, null, 2));
  });

  it('every reviewed derived variable is really derived, in both shipped configs', () => {
    for (const [label, config] of SHIPPED) {
      const maps = nginxMaps(nginxDirectives(stripNginxComments(config)));
      for (const [name, reviewed] of REVIEWED_DERIVED_VARIABLES) {
        assert.equal(derivedVariableProblem(name, reviewed, maps), null, `${label}: $${name}`);
      }
    }
  });

  it('refuses a redaction whose map has stopped redacting', () => {
    const maps = (text) => nginxMaps(nginxDirectives(stripNginxComments(text)));
    const reviewed = REVIEWED_DERIVED_VARIABLES.get('prl_client_net');
    assert.match(
      derivedVariableProblem(
        'prl_client_net',
        reviewed,
        maps('map $request_uri $prl_client_net { default "-"; }'),
      ),
      /reads \$request_uri/,
    );
    assert.match(
      derivedVariableProblem(
        'prl_client_net',
        reviewed,
        maps('map $remote_addr $prl_client_net { default "$remote_addr"; }'),
      ),
      /returns \$remote_addr, which is not a named capture/,
    );
    assert.match(
      derivedVariableProblem(
        'prl_client_net',
        reviewed,
        maps('map $remote_addr $prl_client_net { "~^(?<all>.*)$" "$all"; }'),
      ),
      /can match any character/,
    );
    assert.match(derivedVariableProblem('prl_client_net', reviewed, maps('')), /no `map`.*defines/);
  });
});

describe('reading configuration the way nginx reads it', () => {
  it('a `;` inside quotes does not end a directive', () => {
    const [directive] = nginxDirectives(`log_format x 'a;b' '$request';`);
    assert.equal(directive.name, 'log_format');
    assert.deepEqual(directive.args, ['x', 'a;b', '$request']);
  });

  it('a `{` inside quotes does not open a block', () => {
    const directives = nginxDirectives(
      'map $a $b { "~*(bot){2}" "bot"; }\naccess_log /dev/stdout prl_privacy;',
    );
    assert.ok(directives.some((entry) => entry.name === 'access_log'));
  });

  it('keeps a quoted empty string, because a map rule turns on it', () => {
    const maps = nginxMaps(
      nginxDirectives(`map $http_upgrade $connection_upgrade { default upgrade; '' close; }`),
    );
    assert.deepEqual(maps.get('connection_upgrade')[0].entries, [
      { key: 'default', value: 'upgrade' },
      { key: '', value: 'close' },
    ]);
  });

  it('finds directives at every nesting level, including inside location {}', () => {
    const directives = nginxDirectives('http { server { location /a { error_log /dev/null crit; } } }');
    assert.ok(directives.some((entry) => entry.name === 'error_log' && entry.args[1] === 'crit'));
  });

  it('reads both spellings of an nginx command line out of a compose file', () => {
    const found = nginxInvocationsIn(
      '    command: sh -c "exec nginx -c /tmp/nginx.conf -g \'daemon off;\'"\n' +
        "    entrypoint: ['nginx', '-c', '/etc/nginx/nginx.conf', '-g', 'daemon off; error_log /dev/stderr info;']\n",
    );
    assert.deepEqual(found.configPaths, ['/tmp/nginx.conf', '/etc/nginx/nginx.conf']);
    assert.deepEqual(found.globals, ['daemon off;', 'daemon off; error_log /dev/stderr info;']);
  });

  it('every -c path the shipped compose files name is one somebody accounted for', () => {
    let seen = 0;
    for (const [, compose] of COMPOSE_FILES) {
      for (const path of nginxInvocationsIn(compose).configPaths) {
        seen += 1;
        assert.ok(REVIEWED_NGINX_CONFIG_PATHS.has(path), `${path} is not in REVIEWED_NGINX_CONFIG_PATHS`);
      }
    }
    assert.ok(seen >= 2, `only ${seen} nginx -c path(s) found — the scan has stopped scanning`);
  });

  it('discovers the inline config and the command line without being told either name', () => {
    // Both must be found by discovery alone.
    const found = discoveredNginxConfigs('docker-compose.yml', DEV_COMPOSE);
    assert.ok(
      found.some((entry) => entry.kind === 'inline' && entry.complete && entry.text.includes('log_format')),
      'the inline nginx config was not discovered',
    );
    assert.ok(
      found.some((entry) => entry.kind === 'global' && entry.text.includes('daemon off')),
      'the nginx -g command line was not discovered',
    );
  });

  it('does not mistake a block scalar of something else for nginx configuration', () => {
    const found = discoveredNginxConfigs(
      'fixture.yml',
      'services:\n  x:\n    environment:\n      SCRIPT: |\n        set -e\n        echo hello\n',
    );
    assert.deepEqual(found, []);
  });

  it('the braced spelling of a variable is the same variable', () => {
    // Built by concatenation because Biome refuses `${` in a plain string.
    const braced = `$${'{args}'}`;
    assert.deepEqual(variablesIn(`$uri$is_args ${braced} $request_method`), [
      'uri',
      'is_args',
      'args',
      'request_method',
    ]);
  });
});

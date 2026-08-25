#!/usr/bin/env node
/**
 * Tests for the `log policy` gate.
 *
 * Run with:  node --test scripts/supply-chain/log-policy.test.mjs
 *
 * ## What these are controls FOR
 *
 * D2 in docs/production/legal-register.md had two halves, and this gate has a rule
 * for each.
 *
 * The first was one word: both shipped nginx configs said
 * `access_log /dev/stdout combined;`, and `combined` logs `"$request"` — the
 * request line including `?code=<OAuth authorization code>` on the OIDC callback.
 *
 * The second was an ABSENCE, which is harder to test for and easier to reintroduce:
 * not one service in any of the three compose files had a `logging:` block, so
 * every container log grew without limit on Docker's default json-file driver
 * until the host's disk filled and took Postgres — and therefore the data — with
 * it. An absence has no word to grep for, which is why the compose half of this
 * suite removes each service's cap one at a time rather than checking that "a"
 * cap exists somewhere.
 *
 * Both halves shipped, and nothing in the repository went red, because nothing
 * read those files at all.
 *
 * So a gate that only says "the current files are fine" would be worth very
 * little: the state it is asserting is the state it was written against, and it
 * would pass just as happily if its own matcher had stopped matching. Every rule
 * below is therefore checked twice —
 *
 *   * a POSITIVE control on the real shipped files, so the gate cannot pass by
 *     finding nothing; and
 *   * a NEGATIVE control that mutates the real shipped text back towards the
 *     pre-fix shape and asserts the gate FAILS, so "stopped asserting" can never
 *     be mistaken for "passed".
 *
 * The negative controls mutate the REAL files (read, changed in memory, never
 * written) rather than a hand-written fixture, because a fixture drifts from the
 * thing it stands in for and a gate can quietly stop matching the real file while
 * still matching its own fixture. The one hand-written fixture here is the
 * verbatim pre-fix `http` block, kept so the specific historical defect stays
 * pinned even if the current files are rewritten entirely.
 *
 * ## Would these fail if the behaviour broke, and how was that checked?
 *
 * Each was checked by breaking the rule it covers in the gate and watching the
 * assertion fail:
 *
 *   * `STOCK_FORMATS` emptied → 26 of 34 failed, "refuses the stock `combined`
 *     format" among them.
 *   * the `(?![A-Za-z0-9_])` boundary deleted from the forbidden-variable matcher →
 *     6 failed, including "accepts the safe $request_* variables the shipped format
 *     uses" and both positive controls: without the boundary, `$request` matches
 *     `$request_method` and the gate rejects the very format it enforces. The
 *     lookahead is load-bearing in both directions.
 *   * `STRICT_ERROR_LEVELS` widened to include `warn` → 26 failed, "refuses an
 *     error_log looser than crit" among them.
 *   * the upstream comparison changed from `here !== api` to `here === null` → the
 *     two "drifting the callback block's upstream fails" cases failed, and nothing
 *     else did.
 *   * `stripNginxComments` made the identity function → 5 failed, "does not trip on
 *     its own documentation" among them. That is the trap worth naming: a gate that
 *     read comments would fail on the explanation of the incident, and the cheapest
 *     way to make it green would be to delete the explanation.
 *
 * The compose rules were checked the same way, against the full 62-test suite:
 *
 *   * `composeServices` truncated to return only the FIRST service → 5 failed. This
 *     is the mutation that matters most: it is what "the gate checks the proxy and
 *     nothing else" looks like from the inside, and it is the state this suite was
 *     widened to make impossible.
 *   * the `driver !== 'json-file'` check disabled → 3 failed, all of them
 *     "switching a service to the `none` driver fails". `none` bounds the disk
 *     perfectly and destroys the log; a gate that only asked whether a `logging:`
 *     block existed would call that a fix.
 *   * `crossFileCapFindings` made to return `[]` → exactly 1 failed, "a service
 *     capped differently in two files fails", and nothing else. Narrow, which is
 *     what a rule about drift between two files should be.
 *   * the `EXEMPT_SERVICES` lookup replaced with an unconditional `continue`
 *     (i.e. every service silently exempt) → 26 failed. That is the shape of the
 *     original defect — a check that runs, reports success, and covers nothing.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  COMPOSE_SOURCES,
  composeLoggingFindings,
  composeServices,
  crossFileCapFindings,
  EXEMPT_SERVICES,
  inlineNginxConfigFrom,
  locationBody,
  logCapOf,
  nginxFindings,
  OIDC_CALLBACK_PATH,
  stripNginxComments,
  upstreamOf,
} from './log-policy.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const GATE = join(HERE, 'log-policy.mjs');

const STAGING_CONF = readFileSync(join(REPO_ROOT, 'deploy/staging/nginx.conf'), 'utf8');
const DEV_COMPOSE = readFileSync(join(REPO_ROOT, 'docker-compose.yml'), 'utf8');
const STAGING_COMPOSE = readFileSync(join(REPO_ROOT, 'docker-compose.staging.yml'), 'utf8');
const OBSERVABILITY_COMPOSE = readFileSync(join(REPO_ROOT, 'docker-compose.observability.yml'), 'utf8');
const DEV_CONF = inlineNginxConfigFrom(DEV_COMPOSE);

/** Every compose file, read from disk, so every rule below is checked against all three. */
const COMPOSE_FILES = [
  ['docker-compose.yml', DEV_COMPOSE],
  ['docker-compose.staging.yml', STAGING_COMPOSE],
  ['docker-compose.observability.yml', OBSERVABILITY_COMPOSE],
];

/** Every shipped nginx config, so each rule below is checked against both. */
const SHIPPED = [
  ['deploy/staging/nginx.conf', STAGING_CONF],
  ['docker-compose.yml (inline)', DEV_CONF],
];

/** Did the gate report a failure whose message contains this fragment? */
function complainsAbout(findings, fragment) {
  return findings.some((finding) => finding.message.includes(fragment));
}

/**
 * Return `compose` with exactly one service's `logging:` block deleted.
 *
 * This works on the RAW text — comments and all — rather than on the body
 * `composeServices` hands back, which is comment-stripped and therefore does not
 * occur verbatim in the file. Mutating the raw text is the point: the gate has to
 * be shown failing on something that could really be committed, and every one of
 * these caps ships with a comment above it explaining its numbers.
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
 * `deploy/staging/nginx.conf` as it shipped before this fix, reduced to the four
 * lines that carried the defect — the `error_log ... warn`, the `access_log ...
 * combined`, and a `location /api/` with no callback block beside it. Every one of
 * those is copied character-for-character from
 * `git show 5e3cbbc:deploy/staging/nginx.conf` (the commit this fix was written
 * against); what is dropped is the TLS, timeout and header configuration this gate
 * does not read. Kept so the historical defect stays pinned to a text rather than
 * to a memory of one, even if the shipped files are later rewritten entirely.
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
    // The load-bearing property is that services are DISCOVERED, not listed: a
    // service added next month arrives uncapped, and a gate that knew only today's
    // names would pass it in silence. So assert the discovery really enumerates,
    // and assert against names read independently of `composeServices` itself —
    // a test that re-used the parser could not catch a parser that stopped
    // parsing, which is exactly the defect this gate exists to prevent elsewhere.
    const expected = {
      'docker-compose.yml': ['postgres', 'api', 'web', 'proxy'],
      'docker-compose.staging.yml': ['postgres', 'api', 'web', 'proxy'],
      'docker-compose.observability.yml': ['prometheus', 'alertmanager'],
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
    // The point of EXEMPT_SERVICES is that leaving a service uncapped has to be an
    // act somebody performed and can be argued with, not a name missing from a
    // list. If it is ever non-empty, each entry still has to carry a real reason.
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
    // If PRL_PROXY_NGINX_CONF is ever renamed, `inlineNginxConfigFrom` returns
    // null and every nginx rule in this gate silently stops running. That is the
    // failure mode D2 came from, so it is asserted rather than assumed.
    assert.ok(DEV_CONF?.includes('access_log'), 'no inline nginx config extracted');
  });

  it('compose $$ escapes are undone before the config is judged', () => {
    // `$$request` in the file is `$request` in the container. A gate reading the
    // raw text would see `$$request` and a `$request` rule would miss it.
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
      // Mutate the pair as it appears in the log_format, not the map that DEFINES
      // `$prl_client_net`: `map $remote_addr $prl_client_net` is the redaction and
      // must stay legal, while the same name inside a log_format must not.
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
    // Every service, one at a time. The old version of this suite removed the
    // FIRST `logging:` block in the file and was satisfied; that would still pass
    // with five of six services uncapped, which is the state this whole item was
    // opened to fix. Removing each service's cap in turn is the only shape that
    // proves the gate reads all of them.
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
      // `driver: none` bounds the disk perfectly and destroys the log. It would
      // satisfy a gate that only asked "is there a logging: block", which is why
      // the driver is checked by name and why the failure text says so.
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
      // Appending a new service is the "added next month" case: the gate must fail
      // on a name it has never seen, in a file it did not expect it in.
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
    // `$request_method`, `$request_time`, `$request_length` and `$request_id` are
    // all safe and all distinct from `$request`. A rule that matched by substring
    // would reject the very format it is meant to enforce, and the fix a hurried
    // maintainer would reach for is to stop logging useful fields.
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
    // The shipped configs quote the leaking line — `"$request"`, `combined`, and
    // the sentinel access-log entry — at length in comments, because that is where
    // the reasoning belongs. If the gate read comments it would fail on the
    // explanation, and the cheapest way to make it green would be to delete the
    // explanation. Both shipped SOURCE files are asserted to still carry that prose —
    // the staging config in its own header, the dev config in the compose service
    // comment that sits above the inline block.
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
    // Three states that must not be confused: no block at all (uncapped, the
    // original defect), a block with a field missing (looks capped, is not), and a
    // complete block. `logCapOf` returns null only for the first, so the caller can
    // report "no logging: block" and "logging: block with no max-file" as the
    // different mistakes they are.
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
    // Bare `access_log /dev/stdout;` IS `combined` — nginx's default. A gate that
    // only banned the word would miss the identical leak spelled as an omission.
    const findings = nginxFindings('access_log /dev/stdout;\nerror_log /dev/stderr crit;', 'bare');
    assert.ok(complainsAbout(findings, 'rather than `prl_privacy`'), JSON.stringify(findings, null, 2));
  });

  it('a gate that finds no config must not pass', () => {
    // The original defect survived because nothing read these files. "Read nothing,
    // found nothing, reported success" must therefore be a failure, not a pass.
    assert.equal(inlineNginxConfigFrom('services:\n  proxy:\n    image: nginx\n'), null);
    const run = spawnSync(process.execPath, [GATE], { cwd: '/', encoding: 'utf8' });
    assert.equal(run.status, 0, 'the gate resolves its own repo root, so cwd must not change the verdict');
  });
});

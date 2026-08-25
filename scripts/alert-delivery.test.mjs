#!/usr/bin/env node
/**
 * Tests for the parsers behind `pnpm run alerts:verify`.
 *
 * Run with:  node --test scripts/alert-delivery.test.mjs
 *
 * The verification itself needs a running staging stack, a Prometheus, an
 * Alertmanager and about four minutes, so it is not a unit test and does not
 * pretend to be. What IS testable here is everything the checks are built on:
 * three small parsers that read the rules file and the document, and whose
 * failures are silent in the worst way — a parser that returns fewer alerts than
 * exist makes every check pass by looking at less.
 *
 * ## The defect these were written against
 *
 * `expressionsInRulesFile` recognised a folded block scalar (`expr: >-`) with a
 * negative lookahead. The lookahead backtracked over the space after `expr:`, so
 * seven rules — every multi-line expression in the file — were recorded as the
 * literal string ` >-` and sent to Prometheus, which answered 400 to all seven.
 * The check caught it on its first real run, which is the argument for having
 * check 4 at all; this file is the argument for not needing a container to find
 * it next time.
 *
 * The last two cases are the ones that matter most: a parser that finds NOTHING
 * must not read as agreement. Two empty sets are identical, and a check built on
 * that comparison would report "the two sets are identical — 0 alerts" and pass.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  alertsInDocument,
  alertsInRulesFile,
  expressionsInRulesFile,
  seriesReferencedBy,
} from './alert-delivery.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RULES = readFileSync(join(REPO_ROOT, 'deploy', 'staging', 'observability', 'alert-rules.yml'), 'utf8');
const DOC = readFileSync(join(REPO_ROOT, 'docs', 'production', 'alerts.md'), 'utf8');

describe('alertsInRulesFile', () => {
  it('reads the name, the severity and the runbook of each rule', () => {
    const parsed = alertsInRulesFile(
      [
        'groups:',
        '  - name: availability',
        '    rules:',
        '      - alert: ApiDown',
        '        expr: up == 0',
        '        for: 2m',
        '        labels:',
        '          severity: page',
        '        annotations:',
        '          runbook: docs/production/runbooks/api-unhealthy.md',
        '      - alert: ArchiveFailing',
        '        expr: rate(x[5m]) > 0',
        '        labels:',
        '          severity: ticket',
        '        annotations:',
        '          runbook: docs/production/runbooks/db-saturation.md',
      ].join('\n'),
    );
    assert.deepEqual([...parsed.keys()], ['ApiDown', 'ArchiveFailing']);
    assert.equal(parsed.get('ApiDown').severity, 'page');
    assert.equal(parsed.get('ArchiveFailing').runbook, 'docs/production/runbooks/db-saturation.md');
  });
});

describe('expressionsInRulesFile', () => {
  it('reads an inline expression', () => {
    const parsed = expressionsInRulesFile(
      ['      - alert: A', '        expr: prl_readiness_state == 0'].join('\n'),
    );
    assert.equal(parsed.get('A'), 'prl_readiness_state == 0');
  });

  it('joins a folded block scalar into one expression (REGRESSION)', () => {
    // The bug: this returned ' >-' — the block indicator itself — for every rule
    // written this way, and Prometheus answered 400 to all of them.
    const parsed = expressionsInRulesFile(
      [
        '      - alert: HttpErrorRateHigh',
        '        expr: >-',
        '          sum(rate(prl_http_requests_total{status="5xx"}[5m]))',
        '            / sum(rate(prl_http_requests_total[5m])) > 0.02',
        '        for: 5m',
      ].join('\n'),
    );
    assert.equal(
      parsed.get('HttpErrorRateHigh'),
      'sum(rate(prl_http_requests_total{status="5xx"}[5m])) / sum(rate(prl_http_requests_total[5m])) > 0.02',
    );
  });

  it('stops the folded body at the next key rather than swallowing it', () => {
    const parsed = expressionsInRulesFile(
      [
        '      - alert: A',
        '        expr: >-',
        '          up == 0',
        '        for: 2m',
        '        labels:',
      ].join('\n'),
    );
    assert.equal(parsed.get('A'), 'up == 0');
  });

  it('finds an expression for every rule in the real file', () => {
    const declared = alertsInRulesFile(RULES);
    const expressions = expressionsInRulesFile(RULES);
    assert.ok(declared.size >= 20, `only ${declared.size} rules parsed out of the real file`);
    assert.deepEqual(
      [...declared.keys()].filter((name) => !expressions.has(name)),
      [],
    );
    for (const [name, expression] of expressions) {
      assert.ok(expression.length > 5, `${name} parsed to a suspiciously short expression: ${expression}`);
      assert.ok(!/^[>|][-+]?$/.test(expression), `${name} parsed to a block indicator`);
    }
  });
});

describe('the parsers are scoped to the rule they belong to', () => {
  /**
   * Three sibling bugs of the folded-scalar one above, all found by adversarially fuzzing the
   * parsers rather than by a container. Each makes a parser return something WRONG rather than
   * nothing, which is worse: the checks built on it then pass against text nobody deployed.
   */

  it("does not let a `- record:` rule steal the previous alert's expression (REGRESSION)", () => {
    // `current` was never cleared, so any `expr:` not preceded by a recognised `- alert:` line
    // overwrote the last alert's. A recording rule is an ordinary thing to add to a rules file,
    // and the map size stayed the same, so even a count assertion would not have noticed.
    const parsed = expressionsInRulesFile(
      [
        '      - alert: A',
        '        expr: prl_a > 1',
        '      - record: job:prl_x:rate5m',
        '        expr: sum(rate(prl_nonexistent_total[5m]))',
      ].join('\n'),
    );
    assert.equal(parsed.get('A'), 'prl_a > 1');
    assert.equal(parsed.size, 1, 'the recording rule must not appear as an alert');
  });

  it('does not read an expr-shaped line inside an annotation as the expression (REGRESSION)', () => {
    // `alerts.md`'s prose quotes PromQL, and annotations quote `alerts.md`.
    const parsed = expressionsInRulesFile(
      [
        '      - alert: A',
        '        expr: prl_a > 1',
        '        annotations:',
        '          description: |',
        '            expr: prl_bogus > 999',
      ].join('\n'),
    );
    assert.equal(parsed.get('A'), 'prl_a > 1');
  });

  it('does not read a severity inside an annotation as the label (REGRESSION)', () => {
    // This one defeats the two-tier routing assertion the whole script exists to make.
    const parsed = alertsInRulesFile(
      [
        '      - alert: A',
        '        expr: prl_a > 1',
        '        labels:',
        '          severity: ticket',
        '        annotations:',
        '          description: |',
        '            severity: page is what this would be if it paged.',
      ].join('\n'),
    );
    assert.equal(parsed.get('A').severity, 'ticket');
  });

  it('keeps a folded expression whole across a blank line (REGRESSION)', () => {
    // A blank line inside `>-` is a paragraph break, not a terminator. Breaking on it truncated
    // the expression to its numerator — still valid PromQL, so the evaluation check passed and
    // the threshold the alert is about was never seen by anything.
    const parsed = expressionsInRulesFile(
      [
        '      - alert: A',
        '        expr: >-',
        '          sum(rate(prl_http_requests_total{status="5xx"}[5m]))',
        '',
        '            / sum(rate(prl_http_requests_total[5m])) > 0.02',
        '        for: 5m',
      ].join('\n'),
    );
    assert.match(parsed.get('A'), /> 0\.02$/);
  });

  it('strips surrounding quotes, which Prometheus would otherwise evaluate as a string', () => {
    // `query="prl_a > 1"` parses as a string literal and answers `status: success`, so the
    // evaluation check went green for a rule that was never evaluated.
    const parsed = expressionsInRulesFile(['      - alert: A', '        expr: "prl_a > 1"'].join('\n'));
    assert.equal(parsed.get('A'), 'prl_a > 1');
  });
});

describe('seriesReferencedBy', () => {
  it('resolves histogram series back to the metric family', () => {
    const found = seriesReferencedBy(
      'histogram_quantile(0.99, sum by (le) (rate(prl_http_request_duration_seconds_bucket[5m]))) > 1',
    );
    assert.deepEqual([...found], ['prl_http_request_duration_seconds']);
  });

  it('ignores PromQL functions and label values', () => {
    const found = seriesReferencedBy(
      'absent(up{job="prl-api"}) or max_over_time(up{job="prl-api"}[2m]) == 0',
    );
    assert.deepEqual([...found], []);
  });
});

describe('the document and the rules describe the same alerts', () => {
  // This is check 2 of `alerts:verify`, run here without a container, because the
  // way these two drift is somebody editing one of them — and that happens in a
  // pull request, not during a release rehearsal.
  it('agrees on every name and every severity', () => {
    const documented = alertsInDocument(DOC);
    const declared = alertsInRulesFile(RULES);
    assert.ok(documented.size >= 20, `only ${documented.size} alerts parsed out of alerts.md`);
    assert.deepEqual(
      [...documented.keys()].sort(),
      [...declared.keys()].sort(),
      'docs/production/alerts.md and deploy/staging/observability/alert-rules.yml disagree',
    );
    for (const [name, severity] of documented) {
      assert.equal(declared.get(name).severity, severity, `${name}: the two files disagree on severity`);
    }
  });

  it('every runbook the rules name exists', () => {
    for (const [name, rule] of alertsInRulesFile(RULES)) {
      assert.ok(rule.runbook !== null, `${name} names no runbook`);
      assert.ok(
        readFileSync(join(REPO_ROOT, rule.runbook), 'utf8').length > 0,
        `${name}: ${rule.runbook} is empty`,
      );
    }
  });
});

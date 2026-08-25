#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Unit tests for the alerting rules, run against a real Prometheus rule engine.
#
#     pnpm run alerts:unit          # or: bash deploy/staging/observability/rule-tests/run.sh
#
# ## Why this exists
#
# `pnpm run alerts:verify` proves a great deal about these rules — that they load,
# that they agree with `docs/production/alerts.md`, that every series they name
# appears in a live scrape, and that two of them are delivered end to end. It does
# not prove that a rule can FIRE for the failure it is named after, and an
# adversarial review found twelve rules where it could not. Two zero-tolerance
# rules had a `for:` as long as their own range window, which is a condition that
# cannot be satisfied. One compared a gauge against a constant the gauge could not
# reach on a small host. One fired on six healthy tables. One paged on a clock
# wobble with no restart behind it. Every one of those loads cleanly, evaluates
# without error, and agrees with the document.
#
# So each rule this file covers is asserted in BOTH directions: it fires for the
# failure it names, and it stays silent for the healthy shape it must not fire on.
# That is the only difference between an alert and a decoration.
#
# ## Why a container, and why this digest
#
# `promtool` is Prometheus' own rule engine, so a test here is evaluated by the
# same code that will evaluate the rule in the deployment. The digest is the one
# `docker-compose.observability.yml` pins for the Prometheus that actually loads
# `alert-rules.yml` — testing against a different build would be testing a
# different engine. Nothing is started: this runs one throwaway container that
# reads two files and exits, and it touches no part of the staging stack.
#
# ## Reading a failure
#
# promtool reports the alert name, the evaluation time, and the alerts it expected
# against the ones it got. `alertstate` is `pending` while a `for:` is counting and
# `firing` after it elapses, and the difference between those two is where most of
# the defects above lived.
# ---------------------------------------------------------------------------
set -euo pipefail

PROMETHEUS_IMAGE='prom/prometheus:v3.7.3@sha256:49214755b6153f90a597adcbff0252cc61069f8ab69ce8411285cd4a560e8038'

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
observability="$(dirname "$here")"

# The glob is expanded HERE and passed as basenames, because expanding it in the
# container's working directory would expand it in this shell's instead — which is
# wherever the script was invoked from, and is not this directory.
#
# A sweep of nothing is not a pass: an empty list would make promtool exit 0 having
# checked no rule at all, which is the exact failure this suite exists to catch, one
# level up.
cases=()
for case_file in "$here"/*.test.yml; do
  [ -e "$case_file" ] || continue
  cases+=("$(basename "$case_file")")
done
if [ "${#cases[@]}" -eq 0 ]; then
  echo "no *.test.yml files in $here — nothing was checked" >&2
  exit 1
fi
echo "promtool test rules: ${#cases[@]} file(s) against ../alert-rules.yml"

# Mounted at the parent, so `rule_files: [../alert-rules.yml]` resolves to the file
# the deployment loads rather than to a copy that can drift away from it.
docker run --rm \
  -v "$observability":/observability:ro \
  -w /observability/rule-tests \
  --entrypoint promtool \
  "$PROMETHEUS_IMAGE" \
  test rules "$@" "${cases[@]}"

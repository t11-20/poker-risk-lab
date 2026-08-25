# Deployment

How a commit becomes a running production deployment: what runs, in what order, what each step proves, and — stated as plainly as the rest — which steps **cannot execute in this repository today** and therefore fail loudly rather than pretending.

[`architecture.md`](architecture.md) §7 states the property this whole document serves: **build once, deploy by digest, promote the same digest.** [`staging.md`](staging.md) describes the environment stage 5 uses. [`rollback.md`](rollback.md) describes the reverse. `docs/RUNBOOK.md` §11 holds the deployment constraints that predate this pipeline and still bind it.

---

## 1. The pipeline

```
commit
  │
  ├─ 1  supply-chain gates, lint, typecheck        .github/workflows/release.yml: gates
  ├─ 2  full test suite against a real database                                 : tests
  ├─ 3  BUILD ONCE — both images, digests recorded                              : build
  ├─ 4  container CVE scan of those exact images                                : container-scan
  ├─ 5  staging deploy on those digests + smoke/E2E                             : staging
  ├─ 6  promotion check: same digest, byte for byte                             : promote
  ├─ 7  production deploy                                        NOT WIRED      : production
  ├─ 8  post-deploy verification                                 NOT WIRED      : post-deploy
  └─ 9  rollback plan, printed with this release's digests                      : rollback-plan
```

Triggered by a `v*` tag, so a release is a deliberate act with a name and never a side effect of a push to a branch. `workflow_dispatch` runs it on demand with `dry_run` defaulting to **true**, so somebody who clicks Run without reading gets a full build, scan and staging verification and no promotion. Concurrency is `cancel-in-progress: false`: unlike CI, an in-flight release must not be cancelled, because a half-finished deploy is worse than a queued one.

Top-level permissions are `contents: read` and nothing more. No job needs a token today. When a registry appears, the push job — and only the push job — gets `packages: write`, or better `id-token: write` for OIDC-federated credentials, which stores no long-lived secret in the repository at all.

### What executes today, and what does not

| Stage | Executes on a runner today? |
| --- | --- |
| 1 gates, 2 tests, 3 build, 4 scan, 5 staging, 6 promotion check, 9 rollback plan | **yes** |
| 7 production deploy | **no** — `NOT WIRED` |
| 8 post-deploy verification | **no** — `NOT WIRED` |

Stages 7 and 8 are guarded by `if: ${{ vars.PRODUCTION_DEPLOY_TARGET != '' }}` and `vars.PRODUCTION_ORIGIN != ''`, repository variables that do not exist. Unset, the jobs are skipped and the release ends after the promotion check, which is the honest end of this pipeline. **Set, with no implementation behind them, the jobs fail** — deliberately:

```
PRODUCTION_DEPLOY_TARGET is set to '…', but this workflow has no deployment
implementation. See the header of this job for the four things that must exist
first, in order. Failing rather than pretending.
```

A pipeline whose deploy step is a green tick over an `echo` is worse than no pipeline: it is a rehearsal that teaches everyone the deploy works.

---

## 2. Build once. This is the whole architecture.

Before `scripts/release-artifacts.mjs` existed, nothing in this repository held "build once, deploy the same artefact everywhere". `docker-compose.yml` has `build:` sections, so `up --build` produces a fresh image every time; `ci.yml`'s `containers` job builds two more that nothing else ever sees; and a deployment would have built a third pair. **Three builds of the same commit are three different images** — the base image moves, a registry serves a rebuilt transitive dependency, a lockfile install lands on a different mirror — so "we tested this in staging" was a statement about a build, not about the bytes that would run.

`release-artifacts.mjs` is the single place an image is produced. It builds each Dockerfile exactly once with `--iidfile`, records the digest BuildKit assigned, checks properties of the artefact itself, and writes `deploy/staging/release-manifest.json`. Everything downstream reads that manifest and **none of them can build anything**:

```
  release-artifacts.mjs          staging.mjs up                staging.mjs promote
  ─────────────────────          ──────────────                ───────────────────
  docker build  x2               reads the manifest            reads the manifest
       │                              │                             │
       ▼                              ▼                             ▼
  release-manifest.json ───────▶ deploys BY DIGEST ────▶ staging-verified.json
   (api + web digests)           verifies what is                   │
                                 actually running                   ▼
                                                          refuses anything that
                                                          is not that digest
```

Re-running the build against a commit whose manifest is still valid **refuses** rather than rebuilding, so building twice is an explicit act with `--force` on it. "Still valid" does real work: a manifest whose digests no longer resolve describes images somebody has since pruned, and treating that as a reason not to rebuild would leave an operator with a stack that cannot start and a script that said everything was fine.

### What `release-artifacts.mjs` checks about the artefact itself

Three properties, checked against the built image rather than against the Dockerfile that was supposed to produce it. Each is a defect that shipped or is one edit away from shipping:

| Check | Why |
| --- | --- |
| `Config.User` is `node` | a container that ships as root undoes the least-privilege posture the rest of the stack is built on |
| no `*.md` under `/app` outside `node_modules` | `.dockerignore` anchored `*.md` to the context root, so it matched `README.md` and nothing deeper — and `apps/web/AGENTS.md` and `apps/web/CLAUDE.md`, this repository's instructions to coding agents, **shipped inside the published web image** |
| no `.env*` anywhere under `/app` | the same class of bug one directory deeper: `.env` in `.dockerignore` was root-anchored too, so `apps/api/.env` would have entered the context |

The markdown leak was proven, not inferred:

```bash
docker run --rm --entrypoint sh prl-web:before-fix -c 'find /app -name "*.md" ...'
```

printed the agent instruction files before the fix and prints **0** after it. The fix is `**/*.md` and `**/.env*` in `.dockerignore` plus a prune in each Dockerfile; this check is what stops it coming back silently.

Three independent readings of the digest are taken and compared — `--iidfile`, `docker image inspect --format '{{.Id}}'`, and `RepoDigests` — because they come from different code paths in the daemon, and a disagreement means the assumption this pipeline rests on has stopped holding on this Docker version. A loud failure there beats a promotion comparing two values that mean different things.

### What "digest" means here, precisely

There is no container registry in this project and nothing is pushed. The digest is the one BuildKit's exporter assigns in the local image store. It is content-addressed: two builds producing different bytes cannot share it, and `image: prl-api@sha256:…` in a compose file resolves to exactly that image or to nothing.

It is **not** registry-attested. Nobody signed it and no registry vouches for it, and it exists only on the machine that built it. The manifest says so in its own `digestKind` field:

> local BuildKit image-store manifest digest (--iidfile). Content-addressed and stable, but not registry-attested: nothing is pushed, so no registry vouches for it.

`staging promote` repeats it in its output rather than implying more. When this project gains a registry, the push step records the registry digest **alongside** this one and promotion compares that; the check itself does not change.

### The runner-to-runner problem, handled honestly

GitHub gives each job a fresh machine, so the images built in `build` do not exist in `staging` or `container-scan`. With a registry the answer is a push and a digest pull. Without one, `build` saves them with `docker save` of the **digest** reference and the later jobs `docker load` them — and `scripts/staging.mjs` then re-verifies that the loaded images carry the manifest's digests. A tarball that arrived corrupted or truncated fails the identity check rather than being deployed. `docker save`/`load` preserves the digest; the staging job proves it did rather than assuming it.

---

## 3. Stage 1 — gates

`pnpm run security:audit` runs **eleven** gates, each in its own child process so one crashing gate cannot prevent the others reporting: policy in effect, source encoding hygiene, denied packages, dependency shapes, Shai-Hulud IOC sweep, **committed credentials**, CI + container pinning, integrity + release age, OSV vulnerabilities, SBOM generation, and container image CVEs. Then lint, `build:packages`, typecheck. (This paragraph said "ten gates" and its list omitted the secret scan; the count and the order are the `GATES` array in `scripts/supply-chain/audit.mjs`.)

The install is `pnpm install --frozen-lockfile --ignore-scripts`: this job installs a dependency graph in order to decide whether it is safe, so it must not run that graph's install-time hooks first.

**The container-image gate has a scope the others do not.** Every other gate reads the repository and can run on any checkout at any time; `container-scan.mjs` reads the two Docker *images*, which do not exist until stage 3. So at stage 1 it reports **not applicable**, and the audit's summary says in as many words that this run did not cover container images. That is not a skipped scan — stage 4 runs it against the real artefacts as a mandatory step of its own, visible by name. Three states are kept distinct rather than collapsed into a tick:

| State | Exit |
| --- | --- |
| artefacts present, gate runs, nothing blocking | 0 |
| no artefacts on this machine — reported `not applicable`, and the summary says the audit did not cover images | 0 |
| `--skip-containers` with artefacts present — an explicit refusal to run a gate that could have run | **2**, printing `1 network gate(s) skipped — NOT a valid release audit.` |

Measured 2026-08-22: `node scripts/supply-chain/audit.mjs` exit **0**, all gates pass including the container gate; `--skip-containers` exit **2** with that message. There were ten gates that day; the secret scan has since made it eleven.

Pinning is enforced, not requested. Re-measured 2026-08-25: `node scripts/supply-chain/ci-pinning.mjs` exit **0** over **3 workflows, 46 action references, 2 Dockerfiles with 2 external base images and 3 compose files with 8 image references** — all digest-pinned. (The compose figures read "2 compose files with 6 image references"; the observability overlay added a third file and two more pinned images.) Every `uses:` is a full 40-character commit SHA with the version in a trailing comment, and every `runs-on` names an explicit runner version. The gate also refuses any workflow file not declared in its `EXPECTED_WORKFLOWS`, so adding a workflow is a two-file diff.

`--freshness` is a **report, not a gate**: it exits 0 whatever it finds, and its job is to make a base image that has been rebuilt upstream — usually for a security patch — visible in the release log, so refreshing a pinned digest is a decision somebody makes rather than one nobody knows is available. Measured 2026-08-22: exit 0, all three pinned tags re-resolved against `registry-1.docker.io` — `postgres:16-bookworm`, `node:24.18.0-bookworm-slim` and `nginxinc/nginx-unprivileged:1.29.8-alpine` all still resolve to the digests beside them. **drifted 0.** That capture names the application base this project no longer uses: the runtime base moved to `node:24.18.0-alpine3.24` afterwards, so the next `--freshness` run reports a different set of three.

---

## 4. Stage 2 — tests

The full suite against a real `postgres:16-bookworm` service container, pinned by the same digest staging and the development stack use.

The job's default `DATABASE_URL` names a **login role that is only a member of `prl_app`**, not the migrating identity. That is the point: a missing `GRANT` fails the release rather than the deployment. Migrations and `db:verify` run under `DATABASE_URL_ADMIN`; the tests run as the runtime identity.

---

## 5. Stage 4 — the container CVE scan

Ten supply-chain gates examine the npm dependency graph and the repository in forensic detail, and until this one existed **nothing looked inside the artefact that actually ships**. The images carry a Node runtime and an OS package set, none of which appears in `pnpm-lock.yaml`. A CVE in zlib or perl-base was, as far as this repository's release audit was concerned, not a thing that could exist.

That gate is also what moved the base image. On Debian bookworm-slim it reported 60 unfixed findings across the two images — 52 HIGH and 8 CRITICAL, 14 distinct CVEs, every one of them from the base's 88 OS packages and none from this project's code. None of them blocked, because the policy is not to block on a finding with no upstream fix; the scanner's own header says the right answer to a growing number is a different base image. The base is now `node:24.18.0-alpine3.24` with 18 OS packages, and the same scan reports **0 findings, blocking or otherwise**, with `--include-unfixed` agreeing.

`trivy` is installed at an exact pinned version and **verified against its published checksum** — a scanner installed from a moving `latest` is a moving dependency in the job that decides whether the release is safe.

**What blocks:** a finding at or above the severity floor (default `HIGH`, meaning HIGH and CRITICAL) **and** with an upstream fix available. A finding with no available fix is reported in its own section, counted, and does not block. That trade is deliberate and it has a cost: the only remediation for something Debian has marked `will_not_fix` is to stop using Debian, so blocking on it makes the gate permanently red, and a permanently red gate is a gate somebody turns off — which costs the fixable findings too. `--include-unfixed` makes them block, for a deployment that has somewhere else to go. **The unfixable count is printed in the summary and in the JSON so it cannot be lost, and the right response to a growing number is a different base image, not a bigger allowlist.**

**What refuses.** A scanner that exits 0 when it did not run is worse than no scanner, so each of these is a failure and never a skip: trivy missing; trivy unable to reach its vulnerability database; trivy not identifying the image's OS (it looked at something, but not at an OS package set, so "no OS findings" means nothing); no images to scan.

Measured 2026-08-22: `node scripts/supply-chain/container-scan.mjs` exit **0**. trivy 0.72.0, severity floor HIGH. api and web: **30 findings each at or above HIGH, all 30 with no available fix; 0 blocking, 0 allowed.**

The comparison that shows the gate works: against the **pre-fix** web image the same command exited **1** with **8 blocking findings** — `brace-expansion`, `ip-address`, `tar`, `undici` — all under `/usr/local/lib/node_modules/npm`, all with fixes available upstream, and none reachable from anything the image runs. Both Dockerfiles now delete npm and corepack from the runtime stage, so the fixed image no longer ships them (`command -v npm` prints `npm: absent`). Deleting a package manager nothing uses removed every actionable finding. The structural argument stands on its own: a package manager in a production container is a downloader and an arbitrary-code executor sitting next to the application, in an image that runs with a read-only root filesystem precisely because we want neither.

---

## 6. Stage 5 — staging, and stage 6 — promotion

Stage 5 is the release's evidence. It brings the whole stack up on the manifest's digests, migrates, and runs the eight verifications listed in [`staging.md`](staging.md) §6 — including the assertion that the **running** containers carry the manifest's digests, TLS chain verification, the `X-Forwarded-For` overwrite proof, and `smoke-test.mjs --strict` over https with a real WebSocket and a hand played to completion. The staging job then uploads `staging-verified.json` with `if-no-files-found: error`, so a run that did not earn an attestation cannot quietly continue, and tears the stack down with `--volumes` in an `always()` step.

### Why production must consume the exact digest staging tested

A rebuild between staging and production means production runs an artefact nothing tested. Not "an equivalent artefact" — a different one, produced from the same source by a build that resolved its inputs at a different moment.

`staging promote` enforces it by comparing two separate files that say two different things:

- **the manifest** says *these are the artefacts for this commit*;
- **the attestation** says *a staging run brought THOSE up and everything passed*.

A promotion is meaningful only when the two agree. On a mismatch it prints **both digests**, because "the digests differ" without the digests is a message that sends somebody to the wrong file. It also refuses a manifest built from a **dirty working tree**: a commit sha that does not describe the bytes that were built is not provenance, and nothing downstream could reproduce or audit that artefact.

Measured 2026-08-22:

```
$ node scripts/staging.mjs promote
  ✗ nothing has been verified in staging
      deploy/staging/staging-verified.json does not exist. `pnpm run staging up` writes it only
      when every check AND the strict smoke test passed, so its absence means no digest has
      earned a promotion. This is refused rather than warned about.                     → exit 1
```

and, with a synthetic attestation naming a different api digest, it printed both values —

```
  ✗ api is NOT the digest staging tested
      about to promote  sha256:65299822…
      staging tested    sha256:0000…
```

— and separately flagged the dirty working tree.

**`promote` is a verifier, not a deployer.** It checks the one thing that can be checked here and then says so and stops. It does not push, it does not deploy, and it does not pretend to. When a registry and a target exist, the deploy step goes *after* this check and consumes its output.

### The approval gate

"Controlled promotion" means GitHub's `environment:` with required reviewers, and it is deliberately GitHub's rather than a bespoke one — an approval mechanism nobody can audit is not an approval mechanism. The `environment:` block on the `promote` job is **commented out** rather than present-and-unconfigured, because an `environment:` naming one that does not exist is created implicitly with **no protection rules**: it would look like an approval gate in the workflow file and be one nowhere else. Uncomment it once a `production` environment with required reviewers exists.

---

## 7. Stage 7 — production. What has to exist first.

In this order, because each depends on the one before:

1. **A registry, and a push step in `build` that records the REGISTRY digest alongside the local one.** Cross-machine promotion needs a digest a registry vouches for.
2. **Credentials**, ideally OIDC-federated so this repository stores no long-lived secret. `permissions: id-token: write` on that job alone.
3. **A migration step that runs from OUTSIDE the serving container**, at this commit, as `prl_deployer` — **before** the application rolls. See §8.
4. **A rollout that respects `deploy: replicas: 1`** (ADR 0001, `docs/RUNBOOK.md` §11.1) or implements genuine room affinity. Two API processes serving one room deal two different hands and nothing detects it. Cookie-based stickiness is not enough: the key is the *room*, not the *session*, and two players in one room are two sessions that must land on one process.

And one rule that is not negotiable and is therefore a rule rather than a step: **this pipeline never auto-runs a destructive database change.** See §9.

Stage 8, post-deploy verification, is the same smoke test that cleared the release, run against the production origin — the point being that the check which cleared the release is the check that confirms it landed:

```bash
PRL_WEB_ORIGIN=https://<origin> node scripts/smoke-test.mjs --origin https://<origin> --strict
```

It would also assert the readiness probe, that `/metrics` is **not** reachable from the public origin, and that the deployed digest matches the promoted one. **A failure there is a rollback trigger, not a retry** — [`rollback.md`](rollback.md).

---

## 8. Migrations in a deployment

Three properties, all of them load-bearing.

**They run from outside the serving container.** `Dockerfile.api` deliberately omits `apps/api/scripts/`, so the image that serves traffic *cannot* change the schema. That is a decision about not giving a serving process schema-change rights, and it means the pipeline needs somewhere else to run them from (`docs/RUNBOOK.md` §11.3): a CI job on the release commit, a one-shot job or container built from the repository at the same commit, or an operator on a bastion from a checkout at that commit.

**They run as the migrating identity, not the runtime one.** `prl_migrator` owns schema `prl`; `prl_app` holds exactly the table-level rights the request path needs; `prl_api` is a login role that is a member of `prl_app` and holds no privilege of its own. `permission denied` during a migration means it is being run with the runtime credential. Staging rehearses the *runtime* identity — it creates `prl_api` with a generated password and asserts it has `USAGE` on schema `prl` and **not** `CREATE` — but not the deploy identity; see [`staging.md`](staging.md) §7.

**They run before the new version starts, and they are roll-forward only.** Order: migrate, then roll the API. The runner takes a PostgreSQL **session advisory lock** on a single connection (its pool is capped at `max: 1`, because `pg_advisory_lock` is session-scoped and a lock taken on one connection while the migration runs on another is a lock that only looks like it works), so two concurrent deploys cannot both migrate. Applied migrations are **checksummed and immutable**, contents and filename: a file that has already run and no longer hashes to what the ledger says aborts the run rather than reapplying. Out-of-order files abort too — two branches that each add `0007` merge cleanly in git and diverge in the database.

There is no `down`. `migrate.mjs down` is a first-class command that **refuses**, so a deploy pipeline asking for a rollback gets the policy rather than `Unknown command "down"` — which reads like a version skew and sends the operator after the wrong problem. Full reasoning in [`rollback.md`](rollback.md) §4 and `docs/RUNBOOK.md` §11.3.

---

## 9. The two-release rule

Roll-forward-only is safe **exactly as long as migrations are additive**. So a destructive change is two releases:

1. ship the **additive half** — add the new column, backfill it, start writing both;
2. roll the application onto it, confirm it;
3. ship the **removal** in a later release, in a file that declares itself irreversible.

`migrate.mjs up` enforces the first half. It scans every *pending* file — with comments stripped and quoted values blanked, so prose about a `DROP` is not mistaken for one, while dollar-quoted `DO $$ … $$` bodies are treated as code because that is where a real `DROP` hides — and **aborts, applying nothing**, if any of them contains a `DROP TABLE/SCHEMA/DATABASE/SEQUENCE/TYPE/DOMAIN/VIEW`, an `ALTER … DROP COLUMN`/`DROP CONSTRAINT`, a `TRUNCATE`, a `DELETE FROM`, or a `RENAME … TO`, unless the file carries a marker with a real reason after it:

```sql
-- prl:irreversible: the invite_code column has been unused since 0014 and the values are
-- not recoverable; restoring them means restoring a backup.
```

A bare marker is not enough — the regex requires non-empty text on the marker's own line, because the point of the gate is to make somebody write down what cannot be undone, and a marker with no sentence after it is a checkbox rather than a decision. The whole pending set is refused together, not just the offending file: applying half a set leaves a schema that matches no release.

The list is deliberately narrow. `DROP INDEX`, `REVOKE` and `ALTER … SET DEFAULT` are absent because a following migration really can restore them, and a gate that fires on ordinary DDL is a gate that gets a blanket marker pasted into every file.

**A migration that skips the additive-first step cannot be rolled back around.** That is the reason for the rule, not a side effect of it: the previous application cannot run against that schema, so the release has no application-level rollback and the only reversal is a restore. That should be a decision made *before* the release, not a discovery during the incident. `db/migrations/0003_bot_seat_recovery.sql` is this repository's own worked example — see [`rollback.md`](rollback.md) §5.

---

## 10. Doing it locally, end to end

The same commands the workflow runs, in the same order:

```bash
pnpm run verify                      # every gate, on the release commit
pnpm run staging init                # once per machine, or after 90 days
pnpm run release:artifacts           # BUILD ONCE — the only place an image is made
pnpm run security:containers         # trivy against those exact digests
pnpm run staging up                  # deploy the digests, migrate, verify, smoke
pnpm run staging status              # confirm what is running matches the manifest
pnpm run staging promote             # refuses anything staging did not test
pnpm run staging down --volumes
```

One caveat on the first line: `pnpm run verify` runs `security:audit`, whose container gate reports **not applicable** when no images exist yet. A green `verify` at commit time therefore says nothing about image CVEs. That is what `pnpm run security:containers` after `release:artifacts` is for, and why the release workflow runs it as a step of its own rather than relying on the audit.

---

## 11. Evidence, and what is still outstanding

Everything below was measured on 2026-08-22. Nothing else here is claimed as verified.

| Command | Exit | Result |
| --- | --- | --- |
| `node scripts/release-artifacts.mjs --force` | 0 | built `prl-api` (83 MB) and `prl-web` (171 MB) once each; digests recorded to the manifest |
| `node scripts/supply-chain/ci-pinning.mjs` | 0 | *re-run 2026-08-25:* 3 workflows, 46 action references, 2 Dockerfiles / 2 external base images, **3 compose files / 8 image references** — all digest-pinned. (The row read 2 compose files / 6 images, from the 2026-08-22 run) |
| `node scripts/supply-chain/ci-pinning.mjs --freshness` | 0 | all 3 pinned tags re-resolved against the registry, drifted 0 |
| `node scripts/supply-chain/container-scan.mjs` | 0 | trivy 0.72.0, floor HIGH; api and web 30 findings each, all unfixable; 0 blocking, 0 allowed |
| the same, against the **pre-fix** web image | 1 | 8 blocking findings under `/usr/local/lib/node_modules/npm` |
| `node scripts/supply-chain/audit.mjs` | 0 | all gates pass, container gate included — 10 of them on that date, 11 now that the secret scan is in the array |
| `node scripts/supply-chain/audit.mjs --skip-containers` | 2 | `1 network gate(s) skipped — NOT a valid release audit.` |
| `node scripts/staging.mjs up` | 1 | stack verified; the smoke test then found two application defects (53 passed, 2 failed). No attestation written — correct behaviour |
| `node scripts/staging.mjs status` | 0 | both images match the manifest; `attestation absent — nothing has been verified` |
| `node scripts/staging.mjs promote` | 1 | `nothing has been verified in staging`; with a synthetic mismatched attestation it printed both digests and flagged the dirty tree |
| `node scripts/staging.mjs down --volumes` | 0 | stack, network and volume removed; the development postgres container untouched |

The two defects that `staging up` found — Monte Carlo equity throwing under `NODE_ENV=production`, and guest bootstrap being refused behind any reverse proxy — are described in [`staging.md`](staging.md) §8. **Both are now fixed.**

**`staging up` has since been re-run, and the success path is no longer unexercised.** This paragraph used to say the opposite — that no green attestation existed and no promotion had completed end to end — and it was true only until the two defects were fixed. `deploy/staging/staging-verified.json` now records a green run at `2026-08-22T18:55:36Z` against commit `b292b2ac234c` with `dirty: false`, all four checks true: running digests match the manifest, the TLS chain verified, the proxy overwrote `X-Forwarded-For`, and the strict smoke test passed (61 checks). `staging promote` on that run reported promotable and byte-identical. The evidence is in [`staging-verification.md`](staging-verification.md).

**What is genuinely still outstanding** is narrower than "unexercised": the digests in that attestation are from the **local BuildKit store and are not registry-attested**, so what has been proven is that this machine deployed and verified the images it built, not that a registry can hand the same digests to somewhere else. There is still no registry, no deploy target and no bot account in this repository, so stages 7 and 8 have never run anywhere.

---

## 12. Before you deploy

`docs/RUNBOOK.md` §11.7 is the checklist and it is binding. The items this document adds to it:

- [ ] the digest going to production is the digest `staging promote` accepted, and the attestation is from **this** release's staging run
- [ ] `pnpm run security:containers` exited 0 against **these** digests, not against a rebuild
- [ ] the unfixable-CVE count was read, not just the exit code
- [ ] migrations for this release are additive, or a destructive one carries `-- prl:irreversible: <reason>` and somebody decided that deliberately
- [ ] the migration step runs from outside the serving container, at this commit, as `prl_deployer`
- [ ] the previous release's `release-manifest` artifact is retrievable — **that artifact is the rollback target**, which is why its retention is 90 days
- [ ] the orchestrator's termination grace is **above** `SHUTDOWN_GRACE_MS`, never equal to it
- [ ] one replica, or room affinity tested with two players in one room
- [ ] **if this deployment serves a class**: `COHORT_SIZE` declares how many learners sign in
      together from one address, `COHORT_ENTRY` names which doors they use, and the API booted —
      it refuses to start when the sign-in limits cannot serve the declaration. RUNBOOK §7.1 has
      the arithmetic. Every sign-in limit is keyed on the client address (it has to be: those
      routes issue the session a session-keyed limit would let the caller rotate), so a campus
      NAT is one caller. Getting this wrong is not found in a log; it is found by thirty students
      at once, and it was measured at 15 of 30 refused before the check existed
- [ ] `RATE_LIMIT_OIDC_FAILURE_MAX` was **not** raised alongside `RATE_LIMIT_OIDC_MAX`. The
      ceiling is sized for the cohort and that budget is sized for the abuse; raising them
      together hands a script the classroom's headroom and the boot check will refuse it

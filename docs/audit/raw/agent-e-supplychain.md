# Reviewer E — Supply Chain — independent release audit

**Repo:** `/Users/terence/Projects/exploration-sites/poker-risk-lab`
**Audited:** 2026-08-18
**Environment:** Node v24.18.0, pnpm 11.10.0, darwin arm64, network **available** (registry.npmjs.org and api.osv.dev both reachable — no gate had to be marked UNVERIFIED for lack of network).
**Scope:** the final resolved dependency graph (162 third-party package versions), the on-disk installed tree (104 package versions), the lockfile, all 9 workspace manifests, every script in `scripts/supply-chain/`, both GitHub workflows, both Dockerfiles and `docker-compose.yml`.

**Method note.** Nothing below is graded on the existence of a file. Every PASS is backed by a command I ran. For every gate I additionally built a sandbox (copies of the gate under `/private/tmp/.../agentE/sbx*`, `REPO_ROOT` derived from the copy's own location, so the real repo was never mutated) and fed it hostile input to establish that the gate *can* fail. Four gates turned out to contain checks that cannot fail against real input. `pnpm install` was never run at the repo root; `docs/sbom/*` was regenerated because the brief required it (those files are `.gitignore`d build artefacts, and `poker-risk-lab.cdx.json` regenerated **byte-identical**).

---

## Summary table

| ID | Requirement | Status |
| --- | --- | --- |
| SUP-001 | Exact version pins in every package.json (no `^`/`~`) | **PASS** |
| SUP-002 | `packageManager` pinned with integrity hash; engines constraints | **PASS** |
| SUP-003 | `ignoreScripts` in effect; policy in workspace yaml not `.npmrc`; `.npmrc` gate works | **PASS** |
| SUP-004 | Empty build allowlist; no installed package can run an install script | **PASS** |
| SUP-005 | `minimumReleaseAge` (7-day cooldown) configured **and** effective | **PASS** |
| SUP-006 | Denied package families adequate and enforced against the resolved graph | **PARTIAL** |
| SUP-007 | Mini Shai-Hulud IOC scan is meaningful, not theatre | **PARTIAL** |
| SUP-008 | No git/tarball deps, no `npx`/`dlx`, no `file:`/`link:` outside the repo | **PASS** |
| SUP-009 | SBOM generated, complete, valid CycloneDX 1.6 | **PASS** |
| SUP-010 | OSV / vulnerability scan run; real advisory results | **PASS** |
| SUP-011 | Every third-party CI action pinned to a full 40-char commit SHA | **PASS** |
| SUP-012 | CI `permissions:` least-privilege; no `pull_request_target`; no secret exposure | **PASS** |
| SUP-013 | Container dependencies: base images digest-pinned, scripts disabled in image build | **PASS** |
| SUP-014 | `pnpm run security:audit` runs all 8 gates and blocks on failure | **PASS** |
| SUP-015 | Gate quality: lockfile non-registry-resolution patterns can actually fire | **FAIL** |
| SUP-016 | Gate quality: install-hook / on-disk / IOC-store checks are not vacuous | **FAIL** |
| SUP-017 | Gate quality: no dependency name is exempt from analysis | **FAIL** |
| SUP-018 | Gate quality: `--offline` audit cannot report success | **PARTIAL** |
| SUP-019 | Gate quality: claimed self-tests exist; CI/container pinning is gated | **PARTIAL** |

---

### SUP-001 Exact version pins in every package.json

- **Requirement (exact):** No `^`, `~`, `x`, `*`, `>=`, `latest` or other floating range appears in any dependency specifier in any workspace manifest (root, `apps/*`, `packages/*`). Only exact `x.y.z` versions and `workspace:` protocol specifiers.
- **Status:** **PASS**
- **Implementation location:** enforced by `scripts/supply-chain/dep-shapes.mjs:31` (`EXACT_VERSION`) and `:114-136`; policy declared in `pnpm-workspace.yaml:44-46` (`saveExact: true`, `savePrefix: ''`).
- **Runtime evidence:** I parsed all 9 manifests myself rather than trusting the gate:

```
### package.json  (name=poker-risk-lab version=0.1.0)
  ok  devDependencies.@biomejs/biome = "2.5.7"
  ok  devDependencies.@types/node = "24.13.3"
  ok  devDependencies.axe-core = "4.13.0"
  ok  devDependencies.typescript = "7.0.2"
### apps/api/package.json  (name=@prl/api version=0.1.0)
  ok  dependencies.@fastify/cookie = "11.1.2"
  ...
### packages/ui/package.json  (name=@prl/ui version=0.1.0)
  ok  peerDependencies.react = "19.2.8"
  ok  peerDependencies.react-dom = "19.2.8"

TOTAL dep specs=51  non-exact=0
```

  All 9 projects are actually enumerated by the gate (it reads `workspaceProjects` from `pnpm list -r`):

```
$ pnpm list -r --depth Infinity --json   # project list
  poker-risk-lab   /Users/.../poker-risk-lab
  @prl/api         /Users/.../apps/api
  @prl/web         /Users/.../apps/web
  @prl/content, @prl/contracts, @prl/poker-ai, @prl/poker-engine, @prl/poker-math, @prl/ui
```

  Mutation test — the gate genuinely rejects ranges (sandbox `sbx2`, manifest rewritten to `"fastify": "^5.11.3"`, `"left-pad": "~1.3.0"`, `"evil": "git+https://…"`):

```
  ✗ non-exact version range in @prl/api → dependencies.fastify: "^5.11.3"
  ✗ non-exact version range in @prl/api → dependencies.left-pad: "~1.3.0"
  ✗ non-exact version range in @prl/api → dependencies.evil: "git+https://github.com/attacker/evil.git"
  ✗ dependency-shapes — 6 failure(s)     EXIT=1
```

- **Test covering it:** `scripts/supply-chain/dep-shapes.mjs:114-136` is the check; there is **no** unit test for it in the repo (`scripts/supply-chain/` contains only `policy-check.test.mjs`). My sandbox mutation above is the only executed negative control.
- **Test result:** my mutation test: gate exits 1 as required. Real repo: 51/51 specs exact, 0 violations.
- **Reviewer notes:** Clean. `peerDependencies` are also pinned exactly, which is unusual but consistent. One residual: an exact spec is still checked only for *shape*, so `"@prl/foo": "1.0.0"` (a bare exact version for a first-party name) passes — see SUP-017.
- **Missing work:** none for this requirement.

---

### SUP-002 packageManager pin with integrity hash; engines

- **Requirement (exact):** Root `package.json` pins `packageManager` to an exact pnpm version **with** a Corepack-verifiable integrity hash, and declares `engines` constraints that are enforced.
- **Status:** **PASS**
- **Implementation location:** `package.json:8-12`; gate at `scripts/supply-chain/policy-check.mjs:236-249`; `engineStrict: true` at `pnpm-workspace.yaml:41`.
- **Runtime evidence:** The pin is `pnpm@11.10.0+sha256.620b6605ea4f62fc56a6d0a98733f479071d0321e03e486b522c7e9a74617431`. I did not take the gate's word that the hash is well-formed — I downloaded the actual tarball and computed it:

```
$ curl -s https://registry.npmjs.org/pnpm/11.10.0 | ...
version: 11.10.0
tarball: https://registry.npmjs.org/pnpm/-/pnpm-11.10.0.tgz
$ curl -o pnpm-11.10.0.tgz https://registry.npmjs.org/pnpm/-/pnpm-11.10.0.tgz
-rw-r--r--  4619264 pnpm-11.10.0.tgz
$ shasum -a 256 pnpm-11.10.0.tgz
620b6605ea4f62fc56a6d0a98733f479071d0321e03e486b522c7e9a74617431
   packageManager pin claims: sha256.620b6605ea4f62fc56a6d0a98733f479071d0321e03e486b522c7e9a74617431
```

  Exact match. Engines and toolchain:

```
$ node --version ; cat .node-version
v24.18.0
24.18.0
engines (root): {"node":">=24.18.0 <25","pnpm":">=11.10.0 <12"}
$ pnpm config get engineStrict → true (see SUP-003 output)
$ pnpm --version → 11.10.0
```

- **Test covering it:** `scripts/supply-chain/policy-check.test.mjs:159-177` asserts the gate keeps asserting the policy keys; nothing tests the `packageManager` hash branch.
- **Test result:** `node --test scripts/supply-chain/policy-check.test.mjs` → 7 pass / 0 fail.
- **Reviewer notes:** The pin is genuinely correct, not just well-shaped — this is the strongest single control in the repo, because Corepack refuses a mismatched download. `engines` is only on the root manifest; sub-packages inherit nothing, but they are never installed standalone so this is not a defect. Note the gate only regex-checks hash *form* (`policy-check.mjs:242`); a wrong-but-well-formed hash would pass the gate and fail later in Corepack — that fails in the safe direction.
- **Missing work:** none.

---

### SUP-003 ignoreScripts in effect; policy not inert in .npmrc

- **Requirement (exact):** Lifecycle scripts are disabled repo-wide; the policy lives in `pnpm-workspace.yaml` (because pnpm 11 reads only auth+registry settings from `.npmrc`); pnpm's *effective* configuration actually reports the policy; and the gate that fails when a policy key appears in `.npmrc` really works.
- **Status:** **PASS**
- **Implementation location:** `pnpm-workspace.yaml:20-22` and `:38-42`; gate `scripts/supply-chain/policy-check.mjs:52-93` (effective config) and `:219-234` (`.npmrc` inertness).
- **Runtime evidence:** `.npmrc` read directly — it contains **only** registry settings, exactly as required:

```
$ cat .npmrc
# pnpm 11 reads ONLY auth + registry settings from .npmrc.
# All policy settings live in pnpm-workspace.yaml — see the comment there.
registry=https://registry.npmjs.org/
# Never let a scoped install silently fall back to a different registry.
@prl:registry=https://registry.npmjs.org/
$ find . -name .npmrc -not -path "./node_modules/*"   →  ./.npmrc   (only one)
```

  pnpm's **effective** config, queried from a plain bash shell (not a pnpm child, so no self-suppression):

```
$ pnpm config list
{
  "autoInstallPeers": false,
  "dangerouslyAllowAllBuilds": false,
  "engineStrict": true,
  "hoistPattern": [],
  "ignoreScripts": true,
  "minimumReleaseAge": 10080,
  "minimumReleaseAgeExclude": [],
  "nodeLinker": "isolated",
  "onlyBuiltDependencies": [],
  "packageManagerStrict": true,
  "preferFrozenLockfile": true,
  "publicHoistPattern": [],
  "registry": "https://registry.npmjs.org/",
  "saveExact": true,
  "strictPeerDependencies": true,
  "verifyDepsBeforeRun": "error",
  "verifyStoreIntegrity": true
}
```

  Independent proof the `.npmrc` gate fires (my own sandbox, not the repo's test — `sbx`, `.npmrc` given two policy keys):

```
$ node scripts/supply-chain/policy-check.mjs
  ✗ policy setting "ignore-scripts" found in .npmrc (line 2) where pnpm 11 ignores it
  ✗ policy setting "minimum-release-age" found in .npmrc (line 3) where pnpm 11 ignores it
  ✗ policy-in-effect — 2 failure(s)      EXIT=1
```

- **Test covering it:** `scripts/supply-chain/policy-check.test.mjs:90-177` — seven cases including three genuine negative controls (env override, key deleted from workspace yaml, key moved to `.npmrc`).
- **Test result:** `node --test scripts/supply-chain/policy-check.test.mjs` → **tests 7, pass 7, fail 0** (2.4 s).
- **Reviewer notes:** This is the best-engineered gate in the repo and the only one with real negative-control tests. The `pnpm_config_verify_deps_before_run` self-suppression handling (`policy-check.mjs:131-162`) is narrow and correct, and the tests prove the sanitisation does not blunt genuine overrides. `verifyDepsBeforeRun: error` is demonstrably live — the audit ran through `pnpm run` without complaint and `node_modules/.pnpm-workspace-state-v1.json` carries `lastValidatedTimestamp`, i.e. the installed tree matches the lockfile. Two small gaps, neither release-blocking: `INERT_IN_NPMRC` omits `minimum-release-age-exclude`, `resolution-mode`, `prefer-frozen-lockfile`, `hoist-pattern`, `public-hoist-pattern`, `save-prefix`; and only the root `.npmrc` is examined (a per-package `apps/web/.npmrc` would be missed — none exists today, verified above).
- **Missing work:** widen `INERT_IN_NPMRC`; walk for `.npmrc` in every workspace directory rather than only the root.

---

### SUP-004 Empty build allowlist; no installed package can run an install script

- **Requirement (exact):** `onlyBuiltDependencies` is empty and `dangerouslyAllowAllBuilds` is false, so no package is permitted to build; and **no** package in the tree declares a `preinstall`/`install`/`postinstall` script that could have run.
- **Status:** **PASS**
- **Implementation location:** `pnpm-workspace.yaml:21-22`; gate `scripts/supply-chain/dep-shapes.mjs:89-112`; `lib.mjs:229-267` (`installedManifests`).
- **Runtime evidence:** Effective config (above) shows `onlyBuiltDependencies: []` and `dangerouslyAllowAllBuilds: false`. pnpm's own state file corroborates that nothing is queued to build:

```
$ cat node_modules/.modules.yaml | head
  "pendingBuilds": [],
  "hoistedDependencies": {},
  "nodeLinker": "isolated",
```

  I then scanned the installed tree myself rather than relying on the gate:

```
INSTALLED STORE package versions: 104
source-hook   @swc/helpers@0.5.15  {"prepack":"zx ./scripts/build.js"}
source-hook   cookie@1.1.1  {"prepare":"ts-scripts install"}
source-hook   cookie@2.0.1  {"prepare":"ts-scripts install"}
source-hook   ip-address@10.5.0  {"prepare":"git config core.hooksPath hooks || true","prepack":"npm run docs && npm run build"}
source-hook   pino-abstract-transport@3.0.0  {"prepare":"husky install"}
source-hook   postgres@3.4.9  {"prepare":"npm run build"}
source-hook   ret@0.5.0  {"prepare":"tsc"}
install-hook pkgs=0  source-hook pkgs=7
```

  Zero install hooks on disk. The on-disk tree is only 104 of the 162 resolved versions (58 are platform-specific optionals pnpm skipped on darwin-arm64), so I closed the gap by fetching each skipped package's manifest from the registry:

```
checked 58 packages NOT installed on this platform
  (@img/sharp-linux-*, @next/swc-linux-*, @biomejs/cli-linux-*, @typescript/typescript-*, …)
with install hooks: 0
errors: 0
```

  **162 / 162 resolved package versions carry no `preinstall`, `install` or `postinstall` script.** The 7 `prepare`/`prepack` hooks are source-time only and are never executed for registry tarball installs.

  The gate does fire on a real install hook (sandbox `sbx2`):

```
  ✗ install-time lifecycle hook declared by badpkg@1.0.0
      postinstall: node -e "require('https')"
```

- **Test covering it:** NONE (no test file exercises `dep-shapes.mjs`).
- **Test result:** not executed by the repo; my sandbox mutation exits 1 correctly.
- **Reviewer notes:** The *fact* is fully verified — the fact is clean across the whole graph, including the Linux binaries that will be installed in the container. The *gate* is not: it can only see packages installed for the current platform (see SUP-016). Belt-and-braces is present anyway — `ignoreScripts: true` means even a hook that appeared could not execute during install.
- **Missing work:** none for the requirement; gate coverage in SUP-016.

---

### SUP-005 minimumReleaseAge (7-day cooldown), configured and effective

- **Requirement (exact):** A registry cooldown of at least 7 days is configured, is reported by pnpm's effective config, and is independently re-verified against real publish timestamps for every resolved version.
- **Status:** **PASS**
- **Implementation location:** `pnpm-workspace.yaml:26-27`; asserted at `policy-check.mjs:68-77`; independently re-checked against the registry at `provenance.mjs:57-65` and `:133-148`.
- **Runtime evidence:** Effective config reports `"minimumReleaseAge": 10080` and `"minimumReleaseAgeExclude": []` (no package can skip the cooldown). The provenance gate re-derived it and checked all 162 versions live:

```
▸ integrity + release age
  · lockfile records 162 package versions
  · querying the registry for 162 package versions (concurrency 8)
  · provenance report written to docs/sbom/provenance-report.json (65/162 have an npm attestation)
  ✓ integrity-and-release-age — pass
```

  From the regenerated report — the ten youngest versions, all comfortably past the 7-day cooldown:

```
minReleaseAgeMin=10080   packageCount=162   withAttestation=65
   8.27d  ip-address@10.5.0
   9.88d  @fastify/ajv-compiler@4.0.6
   9.90d  @fastify/csrf@8.1.0
   9.90d  baseline-browser-mapping@2.11.13
  10.22d  fastify@5.11.3
  10.81d  nanoid@3.3.18
  10.92d  ws@8.21.3
  11.14d  caniuse-lite@1.0.30001809
  12.81d  axe-core@4.13.0
  13.95d  @biomejs/biome@2.5.7
packages < 14 days old: 19 ; < 30 days old: 42 ; null publishedAt: 0
```

  Mutation test — the age branch genuinely fails (sandbox `sbx5`, cooldown raised to 200 000 minutes ≈ 139 d):

```
  ✗ semver@7.8.5 is younger than the release-age cooldown (59.7d old, cooldown 139d)
  ✗ fastify@5.11.3 is younger than the release-age cooldown (10.2d old, cooldown 139d)
  ✗ caniuse-lite@1.0.30001809 is younger than the release-age cooldown (11.1d old, cooldown 139d)
```

- **Test covering it:** `policy-check.test.mjs:120-133` covers the *policy* side (env override of `minimumReleaseAge` is caught). Nothing tests `provenance.mjs`.
- **Test result:** 7/7 policy tests pass; my provenance mutation exits 1 correctly.
- **Reviewer notes:** Genuinely enforced twice over, and the second enforcement is independent of pnpm — a lockfile produced on a machine with the setting disabled would still fail here. Worth flagging for the release decision, not as a defect: the graph sits close to the boundary. 19 of 162 versions are under 14 days old and the youngest is 8.3 days, so this lockfile was refreshed against very fresh upstream releases. That is inside policy but it means the 7-day reporting window has only just elapsed for a fifth of the tree.
- **Missing work:** none.

---

### SUP-006 Denied package families: adequacy and enforcement

- **Requirement (exact):** A deny-list of campaign-implicated package families exists, is adequate to the threat, and is actually enforced against the final resolved graph (not merely declared).
- **Status:** **PARTIAL**
- **Implementation location:** `scripts/supply-chain/denied-packages.mjs:14-38` (10 exact names, 2 scopes); enforced by `scripts/supply-chain/deny-list.mjs:21-41`.
- **Runtime evidence:** Enforcement is real. Real run:

```
▸ denied packages
  · resolved graph: 162 third-party package versions
  · installed store: 104 package versions on disk
  ✓ deny-list — pass
```

  Mutation test (sandbox `sbx2`, graph seeded with `keyv@5.6.0` and `@antv/g2@5.0.0`):

```
  ✗ denied package in resolved graph: keyv@5.6.0
      reason: guardrail: Shai-Hulud caching family (CSA AD-2026-009)
  ✗ denied package in resolved graph: @antv/g2@5.0.0
      reason: Mini Shai-Hulud: 400+ compromised scoped packages
  ✗ denied package on disk: keyv@5.6.0
  ✗ unparseable package.json in the installed store
  ✗ deny-list — 4 failure(s)      EXIT=1
```

  Adequacy, however, is thin. I cross-checked the 163 distinct package names in the resolved graph against both the repo's own list and a broader set of families named in the real campaigns:

```
distinct package names in resolved graph: 163
MATCHES against known-compromised exact names: NONE
MATCHES against known-compromised scopes:     NONE
repo deny-list names present in graph: NONE (deny-list never fires for this graph)
```

- **Test covering it:** NONE.
- **Test result:** not executed by the repo; my mutation test exits 1 correctly.
- **Reviewer notes:** Two separate judgements.
  1. **The graph is clean.** No package in the resolved set belongs to any family I know to have been hit in the Shai-Hulud waves (`@ctrl/*`, `ngx-*`, `angulartics2`, `@crowdstrike/*`, `@asyncapi/*`, `@ensdomains/*`, `posthog-*`, `postman-*`, `@zapier/*`, `sha.js`, `chalk`/`debug`/`ansi-styles` cluster, `@nativescript-community/*`, `@operato/*`, …). The tree is a mainstream Fastify + Next/React + pino + sharp + biome stack. This is a good outcome and it is mostly a consequence of dependency minimisation, not of the deny-list.
  2. **The deny-list is not doing the work it appears to do.** It contains 10 names and 2 scopes against a campaign the repo's own snapshot describes as ~1,300 compromised package *versions* across 500+ packages. It is name-granular with no version granularity, it is a static hand-maintained file with no feed, and — most tellingly — **not one of its 12 entries can ever appear in this graph**, so for this repository the gate is a permanent no-op. It also under-covers the repo's own cited sources: `docs/security/shai-hulud-snapshot-2026-08-17.md` cites Snyk on **TanStack** and Expel/Arctic Wolf on **Mistral AI** and **OpenSearch** ecosystems, yet `@tanstack/`, `@mistralai/` and `@opensearch-project/` are absent from `DENIED_SCOPES`. The controls that would actually stop a compromised version of a package this repo *does* use are the cooldown, the frozen lockfile, `ignoreScripts` and the OSV scan — not this list.
- **Missing work:** add the scopes the repo's own snapshot names (`@tanstack/`, `@mistralai/`, `@opensearch-project/`); state plainly in `denied-packages.mjs` that the list is a name-level guardrail and not campaign coverage, so nobody mistakes a green gate for "checked against the campaign"; consider a version-granular feed.

---

### SUP-007 Mini Shai-Hulud IOC scan — meaningful or theatre?

- **Requirement (exact):** The IOC sweep looks for the campaign's real indicators across the working tree and the installed store, and can actually detect them.
- **Status:** **PARTIAL**
- **Implementation location:** `scripts/supply-chain/ioc-scan.mjs`; definitions at `denied-packages.mjs:48-74` (4 artefact paths, 9 string markers, 2 SHA-256 hashes).
- **Runtime evidence:** Real run — the sweep is not trivial in size:

```
▸ Shai-Hulud IOC sweep
  · swept 10488 files (124.1 MiB) for 9 string markers, 2 hashes, 4 artefact paths
  ✓ ioc-sweep — pass
```

  Detection works for content markers (sandbox `sbx3`, IOCs planted in the tree *and* inside a package in the store):

```
  ✗ IOC string in src/marker.js               "Shai-Hulud[:] Here We Go Again"
  ✗ IOC string in src/payload.js              "t.m-kosche[.]com"
  ✗ IOC string in src/payload.js              "api/public/otel/v1[/]traces"
  ✗ IOC string in src/payload.js              "__DAEMONIZED[=]1"
  ✗ IOC string in node_modules/.pnpm/victim@1.0.0/node_modules/victim/install.sh   "bun run [.]claude/"
```

> The five marker strings above are reproduced **defanged** (`[.]`, `[:]`, `[=]`, `[/]` inserted). Verbatim
> markers in this file would themselves trip `ioc-scan.mjs` — this report lives inside the tree the gate
> sweeps, and it is not on the gate's self-exclusion list. Undo the brackets to compare against
> `denied-packages.mjs:55-68`.

```
  ✗ Mini Shai-Hulud persistence artefact present: .claude/setup.mjs
  ✗ ioc-sweep — 6 failure(s)      EXIT=1
```

  But three artefacts I planted in that same run were **not** reported:
  * `node_modules/.pnpm/victim@1.0.0/node_modules/victim/cat.py` — missed
  * `node_modules/.pnpm/victim@1.0.0/node_modules/victim/.claude/setup.mjs` — missed

  Cause: `ioc-scan.mjs:154-161` builds its roots as `node_modules/.pnpm/<name>@<ver>/` and joins the IOC path onto that. In pnpm's isolated store that directory contains **nothing but a `node_modules` directory** — package files live one level deeper. Proven:

```
$ ls -d node_modules/.pnpm/fastify@5.11.3/*
  node_modules/.pnpm/fastify@5.11.3/node_modules
$ ls node_modules/.pnpm/fastify@5.11.3/package.json
  ls: No such file or directory
$ ls node_modules/.pnpm/fastify@5.11.3/node_modules/fastify/package.json
  node_modules/.pnpm/fastify@5.11.3/node_modules/fastify/package.json     ← real package root
```

  And when I planted the artefact at the level the gate actually inspects, it fired — confirming the level is the bug, not the logic:

```
$ printf 'import os\n' > node_modules/.pnpm/victim2@1.0.0/cat.py
  ✗ Mini Shai-Hulud persistence artefact present: node_modules/.pnpm/victim2@1.0.0/cat.py
```

  Separately (sandbox `sbx6`) I planted the three artefacts the repo's own documents name:

```
planted: .github/workflows/codeql.yml, .vscode/tasks.json, .claude/settings.json
  ! path matching a campaign IOC exists: .github/workflows/codeql.yml
  ✓ ioc-sweep — pass (2 warning(s))      EXIT=0
```

  `.vscode/tasks.json` and `.claude/settings.json` were not detected at all, and the injected `codeql.yml` produced a warning that does not block the release.

- **Test covering it:** NONE.
- **Test result:** not executed by the repo; my mutation tests above.
- **Reviewer notes:** Not theatre — the string/hash sweep is real, covers 10 488 files including the whole installed store, and demonstrably fires. But it has four holes, two of them self-contradicting the repo's own documentation:
  1. **The artefact-path sweep over `node_modules` is vacuous.** It checks a directory level that pnpm never populates. A dependency that ships `.claude/setup.mjs` or `cat.py` inside its tarball — the exact scenario the gate's header describes — is invisible to it. Only the content scan would catch it, and only if the file happens to contain one of 9 known strings.
  2. **`.vscode/tasks.json` is not in `IOC_PATHS`** even though `ioc-scan.mjs:7-9` says in its own header that the campaign "writes `.claude/setup.mjs` and `.vscode/tasks.json` into repositories so that opening the project in an agent or editor re-runs the payload". `.claude/settings.json`, named in the snapshot §3, is likewise absent.
  3. **An injected `.github/workflows/codeql.yml` only warns.** This repo has exactly two workflows and no CodeQL; a third workflow appearing is not ambiguous here and should block.
  4. Two smaller blind spots: three first-party files are excluded from the string scan entirely (`ioc-scan.mjs:96-100`), and files over 8 MiB are skipped (`:55`, `:111`). Today the only >8 MiB files are 4 native binaries (`biome`, `next-swc.darwin-arm64.node`, `libvips-cpp.dylib`, `tsc`), so nothing is currently missed, but a large bundled JS payload would evade.
- **Missing work:** join IOC paths onto `<store>/<dir>/node_modules/<pkg>/` (and the scoped `@scope/pkg` variant); add `.vscode/tasks.json` and `.claude/settings.json` to `IOC_PATHS`; make an unexpected workflow file a failure in this repo rather than a warning; add the `python-requests/2.31.0` user-agent and the `0xa31de` shuffle key to `IOC_STRINGS`.

---

### SUP-008 No git/tarball deps, no npx/dlx, no file:/link: outside the repo

- **Requirement (exact):** Every dependency resolves from `registry.npmjs.org`; no git, remote-tarball, CDN or `file:` acquisition; no `npx`/`pnpm dlx`/`bunx` anywhere; no `link:`/`file:` pointing outside the repository.
- **Status:** **PASS** (the fact is verified; the gate that is supposed to prove it is broken — see SUP-015)
- **Implementation location:** `dep-shapes.mjs:50-87`; `ALLOWED_RESOLUTION_HOSTS` at `denied-packages.mjs:46`.
- **Runtime evidence:** I verified the resolved graph directly rather than through the gate. All 162 third-party versions resolve to `registry.npmjs.org`:

```
RESOLVED THIRD-PARTY PACKAGE VERSIONS: 166 entries (162 after store-link decoding)
  … every line: resolved=registry.npmjs.org
```

  Lockfile:

```
$ grep -oE "https?://[^ '\"]+" pnpm-lock.yaml | sort -u
  (no output — the lockfile contains no URLs at all)
$ grep -nE "type: (git|directory)|repo:|commit:|tarball:" pnpm-lock.yaml
  (no output)
$ grep -nE "^\s+version: (link|file):" pnpm-lock.yaml
  45:  version: link:../../packages/content
  …  all 20 link: entries are relative paths INSIDE the repo (packages/*)
```

  No remote-execution shortcuts anywhere in first-party files:

```
$ grep -rnE "\b(npx|pnpm dlx|pnpx|bunx|yarn dlx)\b" --include='*.json' --include='*.mjs' --include='*.ts' \
    --include='*.yml' --include='Dockerfile*' . | grep -v node_modules
  (no output)
$ grep -rn '"file:\|"link:' --include='package.json' . | grep -v node_modules
  (no output)
```

- **Test covering it:** NONE.
- **Test result:** not executed by the repo.
- **Reviewer notes:** The state of the repo is correct and I am confident in it. The *enforcement* is not what it appears — the six lockfile patterns cannot match real pnpm output (SUP-015). The surviving real enforcement for this requirement is `dep-shapes.mjs:68-87`, which fails any package whose `resolved` URL is absent or off-registry; that check is exercised and does work (`✗ disallowed resolution host for sneaky@1.0.0: evil.cdn.example.com`, `✗ package with no registry resolution: nores@1.0.0`). It is a plausible backstop for a `directory:` dependency, but I could not prove that end-to-end without running an install.
- **Missing work:** see SUP-015.

---

### SUP-009 SBOM — generated, complete, valid CycloneDX

- **Requirement (exact):** `pnpm run security:sbom` produces a valid CycloneDX 1.6 SBOM containing the real, complete, transitive component list — verified by regenerating and diffing against the actual installed tree.
- **Status:** **PASS**
- **Implementation location:** `scripts/supply-chain/sbom.mjs`; output `docs/sbom/poker-risk-lab.cdx.json`.
- **Runtime evidence:** Regenerated (via `security:audit`, which runs the same gate):

```
▸ SBOM generation
  · wrote 170 components and 171 dependency records
  · graph fingerprint 9e1ff9caf04966d2… → docs/sbom/poker-risk-lab.cdx.json
  ✓ sbom — pass
$ diff <pre-existing> <regenerated>
IDENTICAL: poker-risk-lab.cdx.json          ← byte-identical, deterministic
```

  Structure:

```
bomFormat=CycloneDX specVersion=1.6 serial=urn:uuid:9e1ff9ca-f049-46d2-8399-6c83f7eb7204 version=1
components=170  dependencies=171
workspace components=8 ; third-party components=162
with hashes=162 ; without hashes=(none) ; with externalReferences=162
components missing required fields=0 ; duplicate bom-refs=[] ; dangling dependsOn refs=0
```

  **Completeness — diffed against the actual installed tree and the lockfile:**

```
on-disk packages: 104
SBOM components: 170
ON DISK BUT MISSING FROM SBOM (0):
IN SBOM BUT NOT ON DISK (58)            ← the platform-skipped optionals; correct to include
lockfile packages: section entries: 162
IN LOCKFILE BUT MISSING FROM SBOM (0):
```

  **Validity — checked against the real CycloneDX 1.6 schema** (fetched from cyclonedx.org):

```
top-level required=["bomFormat","specVersion"]        → both present
UNKNOWN top-level keys in our bom: []                 (bom additionalProperties=false)
UNKNOWN component keys: (none)                        (component additionalProperties=false)
UNKNOWN metadata keys: (none) ; UNKNOWN dependency keys: (none)
bad hash alg=0  bad hash content=0                    (all SHA-512, all match ^[a-fA-F0-9]{128}$)
serialNumber pattern ok=true
```

- **Test covering it:** **NONE.** `sbom.mjs:9` claims "The output here is validated against the CycloneDX 1.6 JSON schema shape in `scripts/supply-chain/sbom.test.mjs`" — that file **does not exist** (`ls scripts/supply-chain/*test*` returns only `policy-check.test.mjs`). See SUP-019.
- **Test result:** not executed (no such test). My schema check above is the only validation that has been run.
- **Reviewer notes:** The artefact itself is good: complete against both the lockfile and the disk, deterministic, correctly `purl`-encoded (`pkg:npm/%40biomejs/biome@2.5.7` matches the purl npm spec), every component carries a real SRI-derived SHA-512 and a distribution URL, and the dependency graph has no dangling refs. Three quality gaps: (a) every component is `scope: "required"` including dev-only ones — CycloneDX has `optional`/`excluded` for exactly this, and the dev/prod split is relegated to a `prl:dev` property; (b) no `licenses` on any component, which makes the SBOM unusable for the license-compliance purpose SBOMs are most often consumed for; (c) the 8 `@prl/*` workspace components carry no hash and no external reference, so the first-party half of the SBOM asserts nothing verifiable. Also note `.gitignore:` line `docs/sbom/*.json` — the SBOM is **not committed**, so the "post-hoc incident response" purpose depends entirely on CI artefact retention (30 days on CI, 90 on the scheduled workflow).
- **Missing work:** write the `sbom.test.mjs` that the source claims exists, or delete the claim; set `scope: optional` for dev components; add `licenses`.

---

### SUP-010 OSV / vulnerability scan

- **Requirement (exact):** Run the vulnerability scan against the final resolved graph and report any real advisory hits. Mark UNVERIFIED if the network is unavailable.
- **Status:** **PASS** (network was available; this is a real result, not a skip)
- **Implementation location:** `scripts/supply-chain/osv-scan.mjs`; allowlist `scripts/supply-chain/osv-allowlist.json` (empty).
- **Runtime evidence:** Network confirmed first:

```
$ curl -o /dev/null -w "%{http_code}" https://registry.npmjs.org/fastify        → 200
$ curl -X POST … https://api.osv.dev/v1/querybatch                              → 200
```

  Real run against the real graph:

```
▸ OSV vulnerabilities
  · querying OSV.dev for 162 package versions
  · no advisories matched any resolved version
  · osv report written to docs/sbom/osv-report.json (0 finding(s))
  ✓ osv-vulnerability-scan — pass
$ cat docs/sbom/osv-report.json
{ "source": "https://api.osv.dev/v1/querybatch", "packagesQueried": 162, "findings": [] }
```

  Second, independent opinion from a different data source:

```
$ pnpm audit --json
{"advisories":{},"metadata":{"vulnerabilities":{"info":0,"low":0,"moderate":0,"high":0,"critical":0},
 "dependencies":89,"devDependencies":35,"optionalDependencies":66,"totalDependencies":162}}
$ pnpm audit
No known vulnerabilities found
```

  Proof the zero is a real negative and not a broken query (sandbox `sbx4`, graph seeded with known-vulnerable versions, hitting the live OSV API):

```
  ✗ GHSA-35jh-r3h4-6jhm affects lodash@4.17.15 [prod] severity=HIGH — Command Injection in lodash
  ✗ GHSA-p6mc-m468-83gw affects lodash@4.17.15 [prod] severity=HIGH — Prototype Pollution in lodash
  ✗ GHSA-r5fr-rjxr-66jc affects lodash@4.17.15 [prod] severity=HIGH — Code Injection via _.template
  ✗ GHSA-xvch-5gv4-984h affects minimist@1.2.0 [dev] severity=CRITICAL — Prototype Pollution
  … 8 findings total
  ✗ osv-vulnerability-scan — 8 failure(s)      EXIT=1
```

- **Test covering it:** NONE.
- **Test result:** not executed by the repo; my live-API mutation test exits 1 correctly.
- **Reviewer notes:** **Zero advisories against 162 resolved versions, confirmed by two independent sources.** The gate is well built: it fails closed if OSV returns a mismatched result count (`osv-scan.mjs:63-69`), the allowlist is empty and every future entry must carry an expiry that the gate itself enforces, and there is no flag to disable it. Dev dependencies fail the build the same as prod. This is the strongest real result in the audit.
- **Missing work:** none.

---

### SUP-011 CI action SHA pins

- **Requirement (exact):** Every third-party GitHub Action in `.github/workflows/*.yml` is pinned to a full 40-character commit SHA, not a tag or branch.
- **Status:** **PASS**
- **Implementation location:** `.github/workflows/ci.yml` (20 `uses:`), `.github/workflows/supply-chain.yml` (3 `uses:`).
- **Runtime evidence:** All 23 parsed and checked:

```
### ci.yml — 20 uses:            all SHA-PINNED
### supply-chain.yml — 3 uses:   all SHA-PINNED
   actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
   actions/setup-node@820762786026740c76f36085b0efc47a31fe5020
   actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a
```

  I did not stop at the format — I resolved each claimed tag against the real upstream repository:

```
$ git ls-remote --tags https://github.com/actions/checkout | grep refs/tags/v7.0.1
3d3c42e5aac5ba805825da76410c181273ba90b1  refs/tags/v7.0.1        ← matches the pin
$ git ls-remote --tags https://github.com/actions/setup-node | grep refs/tags/v7.0.0
820762786026740c76f36085b0efc47a31fe5020  refs/tags/v7.0.0        ← matches
$ git ls-remote --tags https://github.com/actions/upload-artifact | grep refs/tags/v7.0.1
043fb46d1a93c77aae656e7c1c64a875d1fc6a0a  refs/tags/v7.0.1        ← matches
```

- **Test covering it:** NONE. No supply-chain gate reads `.github/workflows/` at all — see SUP-019.
- **Test result:** not executed by the repo; my verification above.
- **Reviewer notes:** Fully correct, and the version comments are accurate rather than aspirational — all three SHAs are the genuine commits the named tags dereference to. Container images used by CI services are digest-pinned too (`postgres:16-bookworm@sha256:60f4761b…`). The only caveat is that nothing *enforces* this: it is a convention held by a header comment, and a future `uses: actions/cache@v4` would sail through all 8 gates.
- **Missing work:** add a gate that fails on any `uses:` without a 40-hex SHA (cheap, ~10 lines).

---

### SUP-012 CI permissions and secret exposure

- **Requirement (exact):** Least-privilege `permissions:` blocks; no unnecessary write scopes; no `pull_request_target` misuse; no secrets reachable from untrusted code paths.
- **Status:** **PASS**
- **Implementation location:** `.github/workflows/ci.yml:63-64`, `.github/workflows/supply-chain.yml:51-52`.
- **Runtime evidence:**

```
### ci.yml
  permissions blocks: 1          (workflow-level: contents: read)
  pull_request_target: false
  secrets. references: 0
  GITHUB_TOKEN references: 0
  write scopes: []
  image: lines: postgres:16-bookworm@sha256:60f4761b…  (×3, all digest-pinned)
### supply-chain.yml
  permissions blocks: 1          (contents: read)
  pull_request_target: false ; secrets: 0 ; GITHUB_TOKEN: 0 ; write scopes: []
```

  Every `actions/checkout` step also sets `persist-credentials: false`, so no credential is left in `.git/config` for later steps to reach.

- **Test covering it:** NONE.
- **Test result:** not executed by the repo.
- **Reviewer notes:** Genuinely least-privilege — a single workflow-level `contents: read`, no job widens it, no `id-token`, no `packages`, no `pull_request_target`, and **zero** references to `secrets.*` or `GITHUB_TOKEN` in either file. The trigger is `pull_request`, not `pull_request_target`, so a fork PR runs with a read-only token and never sees repository secrets. The three hardcoded values that look like secrets (`POSTGRES_PASSWORD: postgres`, `SESSION_COOKIE_SECRET: ci-only-not-a-secret-32-chars-xx`) are ephemeral service-container credentials on a per-job private network, correctly *not* stored as secrets. `actions/cache` is deliberately absent, removing a well-known cross-ref poisoning vector. I have no finding here.
- **Missing work:** none.

---

### SUP-013 Container dependencies

- **Requirement (exact):** `Dockerfile.api`, `Dockerfile.web` and `docker-compose.yml` pin base images by digest rather than floating tag; what gets installed at build time is controlled; install scripts are disabled in the image build too.
- **Status:** **PASS**
- **Implementation location:** `Dockerfile.api:107,138,158`; `Dockerfile.web:78,94,106`; `docker-compose.yml:118,350`.
- **Runtime evidence:** Both Dockerfiles use the same digest-pinned base, and both installs disable scripts explicitly:

```
Dockerfile.api:107  FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS base
Dockerfile.api:138  RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter "@prl/api..."
Dockerfile.api:158  RUN pnpm install --frozen-lockfile --ignore-scripts --filter "@prl/api..."
Dockerfile.web:78   FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7… AS base
Dockerfile.web:94   RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter "@prl/web..."
docker-compose.yml:118  image: postgres:16-bookworm@sha256:60f4761b9035e0b8d5218f701a8c3382f641bf12b1604822574cf5be3baeb537
docker-compose.yml:350  image: nginxinc/nginx-unprivileged:1.29.8-alpine@sha256:0c79d56aee561a1d81c63f00eee5fb5fe29279560cdc55e91425133104c7fbe6
```

  I resolved all three digests against the live registries rather than trusting the comments:

```
node:24.18.0-bookworm-slim         docker-content-digest: sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d  ✓ match
postgres:16-bookworm               docker-content-digest: sha256:60f4761b9035e0b8d5218f701a8c3382f641bf12b1604822574cf5be3baeb537  ✓ match
nginxinc/nginx-unprivileged:1.29.8-alpine  docker-content-digest: sha256:0c79d56aee561a1d81c63f00eee5fb5fe29279560cdc55e91425133104c7fbe6  ✓ match
```

  Nothing is fetched at build time except the dependency graph and Corepack's pnpm:

```
$ grep -nE "apt-get|apk |curl|wget|npm i|npm install|yarn |bun |pip " Dockerfile.api Dockerfile.web
  (only comments and the `pnpm install --ignore-scripts` lines; no package-manager or shell installer invocations)
$ cat .dockerignore
**/node_modules   **/dist   **/.next   **/coverage   **/*.tsbuildinfo   .git   .env   .env.*   docs   *.md
```

  Runtime hardening: `USER node`, `read_only: true`, `cap_drop`, `security_opt` on the app services in compose; the healthcheck uses `node -e` rather than adding curl to the image.

- **Test covering it:** NONE.
- **Test result:** not executed by the repo.
- **Reviewer notes:** This is done properly and the digests are real, not decorative. Two observations rather than defects. (a) **CI never builds either Dockerfile** — `grep -n docker .github/workflows/*.yml` returns nothing, so the container build path (including its `--frozen-lockfile` install of the *Linux* dependency set) is never exercised by any automated check; the release artefact is the one thing CI does not build. (b) `.dockerignore` does not exclude `.npmrc`, so the file is copied into the build context by `COPY . .`; harmless today because it holds no credentials, but it is the file where a credential would end up.
- **Missing work:** add a Docker build job to CI; add `.npmrc` to `.dockerignore`.

---

### SUP-014 `pnpm run security:audit` — all 8 gates, real output

- **Requirement (exact):** The release gate runs all 8 supply-chain gates, aggregates them, and exits non-zero if any fails.
- **Status:** **PASS**
- **Implementation location:** `scripts/supply-chain/audit.mjs:19-28` (gate list), `:57-73` (aggregation).
- **Runtime evidence:** Full unedited run:

```
$ pnpm run security:audit
Poker Risk Lab — supply-chain audit
  8 gates

▸ policy in effect
  · ignored pnpm's own re-entrancy suppression: pnpm_config_verify_deps_before_run (shadowing verifyDepsBeforeRun)
  · 12 policy settings asserted against pnpm's effective config
  · packageManager pinned with integrity hash (pnpm@11.10.0)
  ✓ policy-in-effect — pass
▸ source encoding hygiene
  · checked 391 first-party source files for encoding and hidden-character defects
  · scanned 193 source files across 8 src/ trees for Math.random
  ✓ repo-hygiene — pass
▸ denied packages
  · resolved graph: 162 third-party package versions
  · installed store: 104 package versions on disk
  ✓ deny-list — pass
▸ dependency shapes
  · lockfileVersion 9.0
  · 7 package(s) declare source-time hooks (prepare/prepack).
  ✓ dependency-shapes — pass
▸ Shai-Hulud IOC sweep
  · swept 10488 files (124.1 MiB) for 9 string markers, 2 hashes, 4 artefact paths
  ✓ ioc-sweep — pass
▸ integrity + release age
  · lockfile records 162 package versions
  · querying the registry for 162 package versions (concurrency 8)
  · provenance report written to docs/sbom/provenance-report.json (65/162 have an npm attestation)
  ✓ integrity-and-release-age — pass
▸ OSV vulnerabilities
  · querying OSV.dev for 162 package versions
  · no advisories matched any resolved version
  ✓ osv-vulnerability-scan — pass
▸ SBOM generation
  · wrote 170 components and 171 dependency records
  ✓ sbom — pass

Summary
  ✓ pass  policy in effect / source encoding hygiene / denied packages / dependency shapes
  ✓ pass  Shai-Hulud IOC sweep / integrity + release age / OSV vulnerabilities / SBOM generation

All supply-chain gates passed.
EXIT=0
```

- **Test covering it:** `policy-check.test.mjs` covers one of the eight gates. The other seven have no test.
- **Test result:** 8/8 gates pass; exit 0. `pnpm run test:scripts` (`node --test 'scripts/**/*.test.mjs'`) executes exactly one file.
- **Reviewer notes:** The harness itself is sound: each gate runs as its own child process so one crash cannot mask another, `runGate` (`lib.mjs:79-93`) catches exceptions and sets exit 1 (fails closed), and exit 0 requires all eight. Waivers are refused by design. The run is genuine and reproducible. **What I do not accept is the implied conclusion.** Four of the eight gates contain checks that cannot fail against realistic input (SUP-015 to SUP-018), so "all 8 gates passed" overstates what has been verified. The individual findings follow.
- **Missing work:** see below.

---

### SUP-015 Gate quality — the lockfile non-registry-resolution patterns are dead code

- **Requirement (exact):** `dep-shapes.mjs`'s first check must fail a lockfile that acquires a dependency from git, a remote tarball, a CDN or a local directory.
- **Status:** **FAIL**
- **Implementation location:** `scripts/supply-chain/dep-shapes.mjs:50-66` (`forbiddenLockPatterns`).
- **Runtime evidence:** Four of the six patterns are anchored to the start of a line (`/^\s*tarball:/`, `/^\s*repo:/`, `/^\s*commit:/`, `/^\s*type:\s*(git|directory)\s*$/`). pnpm writes `resolution:` as an **inline flow mapping on one line**, so none of them can ever match. I planted a git dependency and a directory dependency in the exact format pnpm 9/10/11 emits:

```
  outside@file:../../../evil:
    resolution: {directory: ../../../evil, type: directory}

  gitdep@github.com/attacker/evil:
    resolution: {commit: aaaaaaaa…, repo: github.com/attacker/evil, type: git}
```

  Result — **every one of the six patterns misses**:

```
NO MATCH remote tarball resolution  (0)
NO MATCH git repository resolution  (0)
NO MATCH git commit resolution  (0)
NO MATCH non-registry resolution type  (0)
NO MATCH git protocol dependency  (0)
NO MATCH off-registry tarball URL  (0)
anchored-pattern hits against a real pnpm-format poisoned lockfile: 0
```

  The two non-anchored patterns miss for a different reason: a pnpm git resolution is recorded as `repo: github.com/attacker/evil` with **no `git+ssh://` scheme**, and a directory resolution has no URL at all.

  My earlier positive test (`✗ git protocol dependency in pnpm-lock.yaml`) fired only because I had written the entry in a *synthetic* format (`git+ssh://…`, `https://….tgz`) that pnpm does not actually produce. Against the real format, the check is inert.

- **Test covering it:** NONE.
- **Test result:** 0 of 6 patterns match real pnpm-format git/directory resolutions.
- **Reviewer notes:** This is a gate that reads as protective and cannot fail. It is the check the repo's own threat model points at for "Pattern B — poisoned Git dependency" (`docs/security/shai-hulud-snapshot-2026-08-17.md` §2 and §5, "No Git/tarball/remote deps → `dep-shapes.mjs`"). There is a partial backstop: check #2 (`dep-shapes.mjs:68-87`) fails any package whose `pnpm list` entry has no `resolved` URL, which a git or directory dependency would plausibly trip. But that is a second-order consequence, it is not the check the documentation cites, and I could not confirm it end-to-end without running an install. Severity **P1**: the primary defence against the campaign's documented delivery Pattern B is not functioning.
- **Missing work:** match against the inline `resolution: {…}` body rather than line-anchored keys — e.g. parse each `resolution: {(.+)}` and reject any that contains `type: git`, `type: directory`, `repo:`, `commit:`, or a `tarball:` whose host is not `registry.npmjs.org`. Add a fixture test with a real pnpm-format git entry so the pattern cannot silently rot again.

---

### SUP-016 Gate quality — install-hook, on-disk deny and IOC-store checks are vacuous when the store is absent or platform-partial

- **Requirement (exact):** The checks that read the installed tree must not report success while examining nothing.
- **Status:** **FAIL**
- **Implementation location:** `dep-shapes.mjs:89-112`; `deny-list.mjs:32-41`; `ioc-scan.mjs:137-145`; `lib.mjs:229-233` (`installedManifests` returns an empty Map when the store is missing).
- **Runtime evidence:** I built a fresh-checkout sandbox — all manifests, the lockfile and the workspace config, **no `node_modules`** — and ran the three offline gates that read the store:

```
node_modules present? NO
===== deny-list (NO node_modules) =====
  · resolved graph: 162 third-party package versions
  · installed store: 0 package versions on disk        ← silently zero
  ✓ deny-list — pass                    EXIT=0
===== dep-shapes (NO node_modules) =====
  · lockfileVersion 9.0
  ✓ dependency-shapes — pass            EXIT=0         ← lifecycle-hook scan examined 0 packages, no note, no warning
===== ioc-scan (NO node_modules) =====
  ! node_modules/.pnpm not present — the installed store was not swept
  ✓ ioc-sweep — pass (1 warning(s))     EXIT=0         ← warning only; not release-blocking
```

  The install-time lifecycle-hook check — the single check aimed at the campaign's Pattern A delivery — **reports a clean pass having inspected zero packages, with no output at all to say so.**

  Even with a fully installed tree the coverage is partial. pnpm skips platform-inapplicable optional dependencies, and the gate can only see what is on disk:

```
$ node_modules/.modules.yaml → "skipped": 58 entries
  @img/sharp-linux-x64@0.35.3, @next/swc-linux-x64-gnu@16.3.0, @biomejs/cli-linux-x64@2.5.7,
  @typescript/typescript-linux-x64@7.0.2, … (58 total)
resolved graph 162  −  installed store 104  =  58 never scanned for lifecycle hooks (36%)
```

  On macOS that silently excludes every Linux binary — precisely the set that *is* installed in the release container. (On the Ubuntu CI runner the excluded set is the darwin/win one instead, so the ship platform is covered there.) I closed the gap manually by fetching all 58 manifests from the registry: **0 install hooks**, so the current tree is clean — but the gate did not establish that.

  Contrast with `repo-hygiene.mjs:236-238`, which does exactly the right thing (`if (scanned < 40) gate.fail('the Math.random scan matched only ' + scanned + ' files', 'a scan of nothing proves nothing')`). The principle is understood in the codebase and applied to one gate out of eight.

- **Test covering it:** NONE.
- **Test result:** all three gates exit 0 against an empty store.
- **Reviewer notes:** In the CI pipeline this is mitigated — both workflows run `pnpm install --frozen-lockfile` before `security:audit`, so the store exists. But the gate is documented and used as a local pre-release check, `deps:quarantine` invokes the offline audit on a machine that may not have installed yet, and the failure mode is completely silent. A gate whose green light means "I found nothing" and "I looked at nothing" indistinguishably is not a gate. Severity **P1**.
- **Missing work:** assert a floor in each store-reading check (`installedManifests().size` must be within a sane ratio of `resolvedGraph().packages.size`, or at minimum non-zero); promote `ioc-scan`'s missing-store warning to a failure; for platform-skipped packages, fall back to fetching the manifest from the registry (the provenance gate already queries every one of them, so the data is one field away) or record explicitly which versions were not inspected.

---

### SUP-017 Gate quality — `@prl/*` names are exempt from every dependency check

- **Requirement (exact):** No dependency should be excluded from analysis on the basis of its name alone.
- **Status:** **FAIL**
- **Implementation location:** `scripts/supply-chain/lib.mjs:171-172`:

```js
const isWorkspaceLink = name.startsWith('@prl/');
if (!isWorkspaceLink) {
  // …everything below — deny-list, resolution host, integrity, release age, OSV, SBOM component…
}
```

- **Runtime evidence:** Any package whose name begins `@prl/` is dropped from `resolvedGraph().packages` and therefore never reaches the deny-list, the resolution-host check, the integrity/release-age check, the OSV query, or the third-party half of the SBOM. The scope is **unclaimed on the public registry**, and `.npmrc` points it at the public registry:

```
$ curl -o /dev/null -w "%{http_code}" https://registry.npmjs.org/@prl%2Fpoker-engine   → 404
  @prl/api → 404 ; @prl/ui → 404 ; @prl/contracts → 404      (scope is unregistered — anyone may claim it)
$ grep -n "@prl" .npmrc
5:@prl:registry=https://registry.npmjs.org/                  ← public registry, not a private one
$ pnpm config get link-workspace-packages
undefined                                                    ← pnpm ≥10 defaults this to false
```

  With `link-workspace-packages` unset (pnpm's default is `false` in v10+), a specifier that is **not** `workspace:` resolves from the registry. And nothing objects to such a specifier:

```
$ node -e 'const EXACT=/^\d+\.\d+\.\d+…/; EXACT.test("1.0.0")'
  "1.0.0" passes EXACT_VERSION: true -> no gate objection
```

  So `"@prl/anything": "1.0.0"` in a manifest would be fetched from the public npm registry and would be invisible to all eight gates. In the SBOM the eight `@prl/*` entries are already unverifiable:

```
@prl components in SBOM: 8; with hashes: 0; with externalReferences: 0
```

  Today every first-party edge is correctly `workspace:*` (verified in SUP-001: 21 of 51 specifiers, all `workspace:*`), so the hole is not currently open.

- **Test covering it:** NONE.
- **Test result:** not applicable — this is a static exemption, confirmed by reading and by the registry 404s.
- **Reviewer notes:** The exemption is written to skip *workspace links*, but it is keyed on the **name**, not on whether the resolution is actually a workspace link. That is a name-based trust decision in a repository whose entire premise is that names are exactly what an attacker controls — this is the classic dependency-confusion shape, with the added twist that the audit tooling would also stay silent. It needs one mistaken specifier (`"1.0.0"` instead of `"workspace:*"`) to become live, and no gate would flag that mistake. Severity **P1** for the blind spot; the exploitation precondition is a maintainer error, which is why it is not P0.
- **Missing work:** key the exemption on the resolution being a genuine workspace link (`node.version.startsWith('link:')` **and** the realpath resolving inside the repo), not on the name prefix; register the `@prl` scope on npm, or point `@prl:registry` at a registry that cannot serve a third party's package; add a gate assertion that every `@prl/*` specifier in every manifest uses the `workspace:` protocol.

---

### SUP-018 Gate quality — `--offline` audit reports success

- **Requirement (exact):** An audit that did not run its network gates must not report success.
- **Status:** **PARTIAL**
- **Implementation location:** `scripts/supply-chain/audit.mjs:36-40` and `:67-70`.
- **Runtime evidence:**

```
$ node scripts/supply-chain/audit.mjs --offline
  ○ skipped  integrity + release age
  ○ skipped  OSV vulnerabilities
  ✓ pass  (the other six)
2 network gate(s) skipped — NOT a valid release audit.
OFFLINE EXIT=0
```

  The message is honest; the exit code is not. `quarantine.mjs:188-205` consumes this exit code (`process.exit(gates.status === 0 ? 0 : 1)`), so `pnpm run deps:quarantine` reports success after verifying a brand-new lockfile with 6 of 8 gates — and, on a machine that has not installed yet, three of those six are additionally vacuous per SUP-016.
- **Test covering it:** NONE.
- **Test result:** exit 0 with 2 of 8 gates unrun.
- **Reviewer notes:** Neither CI workflow uses `--offline`, so this is not currently a release bypass. It is a footgun waiting for someone to wire the offline mode into a pre-commit hook or a firewalled runner and read the exit code. Severity **P2**. Separately: `deps:quarantine` copies the newly resolved lockfile **back over `pnpm-lock.yaml` before** telling the operator to review the diff (`quarantine.mjs:176-183`) — the review it recommends is of a change already applied. (I did not run it, for that reason.)
- **Missing work:** exit non-zero (or require an explicit `--i-know-this-is-not-a-release-audit`) when any gate was skipped; have `deps:quarantine` write to `pnpm-lock.yaml.new` and leave the swap to the operator.

---

### SUP-019 Gate quality — claimed self-test absent; CI and container pinning ungated

- **Requirement (exact):** Claims made in the gate sources about their own verification are true, and the pinning rules the repo relies on are enforced by something.
- **Status:** **PARTIAL**
- **Implementation location:** `scripts/supply-chain/sbom.mjs:9`; `scripts/supply-chain/audit.mjs:19-28`.
- **Runtime evidence:**

```
$ ls scripts/supply-chain/ | grep -i test
policy-check.test.mjs                    ← the only test file in the directory
```

  `sbom.mjs:9` states: *"The output here is validated against the CycloneDX 1.6 JSON schema shape in `scripts/supply-chain/sbom.test.mjs`."* That file does not exist, and `pnpm run test:scripts` (`node --test 'scripts/**/*.test.mjs'`) therefore executes exactly one file. Coverage across the eight gates: 1 tested, 7 untested.

  Neither the 8-gate audit nor any other script reads `.github/workflows/` or the Dockerfiles:

```
$ grep -rn "workflows\|Dockerfile" scripts/supply-chain/*.mjs
  (no matches)
```

  So SUP-011 (action SHA pinning) and SUP-013 (base-image digest pinning) — both currently correct — are held by convention and header comments only.

- **Test covering it:** N/A.
- **Test result:** 1 of 8 gates has a test.
- **Reviewer notes:** The single existing test file is genuinely excellent (real negative controls, sandboxed, proves the gate can fail). The problem is that it stands alone: I had to build the negative controls for the other seven gates myself, and doing so is exactly how I found SUP-015 through SUP-017. The false claim in `sbom.mjs:9` matters beyond tidiness — it is the kind of statement a reviewer would take at face value and stop checking. Severity **P2**.
- **Missing work:** delete or fulfil the `sbom.test.mjs` claim; add fixture-based tests for `dep-shapes`, `deny-list` and `ioc-scan` (my sandboxes under `/private/tmp/.../agentE/sbx*` are directly reusable as fixtures); add a ninth gate that checks workflow `uses:` SHA pinning and Dockerfile `FROM` digest pinning.

---

## Counts

| Status | Count |
| --- | --- |
| PASS | 12 |
| FAIL | 3 |
| PARTIAL | 4 |
| UNVERIFIED | 0 |
| N/A | 0 |
| **Total** | **19** |

No requirement was UNVERIFIED: the network was available, so both network-backed gates produced real results rather than skips.

---

## Severity-classified issues

### P0 — security/correctness/release catastrophe
*None.* The dependency graph itself is clean: 162 resolved versions, zero known-compromised packages, zero OSV advisories (confirmed independently by `pnpm audit`), zero install-time lifecycle scripts anywhere in the graph, every acquisition from `registry.npmjs.org`, every version past the 7-day cooldown, every lockfile integrity hash matching what the registry serves today, no IOC hits across 10 488 files. The `packageManager` hash, all three container image digests and all three CI action SHAs verify against upstream. **On the facts, this dependency graph is safe to ship.**

### P1 — required control broken or missing
1. **`dep-shapes.mjs:50-66` — the git/tarball/directory lockfile check cannot fail.** All six patterns miss a git or directory resolution written in the format pnpm actually emits (proven: 0/6 matches). This is the control the threat model names against the campaign's documented delivery Pattern B.
2. **`dep-shapes.mjs:89-112`, `deny-list.mjs:32-41`, `ioc-scan.mjs:137-145` — the store-reading checks pass while inspecting nothing.** With no `node_modules`, the install-time lifecycle-hook scan (the control against delivery Pattern A) reports a clean pass over zero packages with no note or warning; the IOC store sweep warns but does not block. With a store present, 58 of 162 versions (36%) are still never inspected because pnpm skips platform-inapplicable optionals.
3. **`lib.mjs:171` — every `@prl/*` name is exempt from all dependency analysis,** while the `@prl` scope is unregistered on npm and `.npmrc` maps it to the public registry. A single `"@prl/x": "1.0.0"` specifier would pull a stranger's package from the public registry with no deny-list, host, integrity, release-age, OSV or SBOM coverage.
4. **`ioc-scan.mjs:154-161` — the persistence-artefact sweep over `node_modules` checks a directory level pnpm never populates** (`<store>/<pkg>@<ver>/` instead of `<store>/<pkg>@<ver>/node_modules/<pkg>/`), so a dependency shipping `.claude/setup.mjs` or `cat.py` is not detected by path — the exact scenario the gate's own header gives as its reason to exist.

### P2 — significant quality gap
5. **`denied-packages.mjs` under-covers the repo's own snapshot.** `@tanstack/`, `@mistralai/` and `@opensearch-project/` are named in the sources cited by `docs/security/shai-hulud-snapshot-2026-08-17.md` but absent from `DENIED_SCOPES`. The list is name-granular against a campaign of ~1,300 *versions*, and not one of its 12 entries can occur in this graph — the gate is a permanent no-op here.
6. **`ioc-scan.mjs` misses artefacts its own documentation names.** `.vscode/tasks.json` (named verbatim in the file header) and `.claude/settings.json` (snapshot §3) are not in `IOC_PATHS`. An injected `.github/workflows/codeql.yml` produces a non-blocking warning in a repo that has exactly two known workflows.
7. **`audit.mjs --offline` exits 0** with 2 of 8 gates unrun; `deps:quarantine` consumes that exit code, and it overwrites `pnpm-lock.yaml` *before* asking the operator to review the diff.
8. **`sbom.mjs:9` claims a `sbom.test.mjs` that does not exist.** 7 of 8 gates have no test at all; `pnpm run test:scripts` runs one file.
9. **No gate enforces CI action SHA pinning or Dockerfile base-image digest pinning.** Both are currently correct, and both are held only by header comments; a `uses: actions/cache@v4` added tomorrow passes all 8 gates.
10. **CI never builds either Dockerfile.** The release artefact — and its `--frozen-lockfile` install of the Linux dependency set — is the one thing no automated check exercises.

### P3 — polish
11. SBOM marks every component `scope: "required"` including dev-only ones, and carries no `licenses`; the 8 `@prl/*` components have no hash and no external reference.
12. `docs/sbom/*.json` is `.gitignore`d, so the SBOM's stated incident-response purpose depends entirely on CI artefact retention (30 days on CI, 90 on the scheduled workflow).
13. `policy-check.mjs`'s `INERT_IN_NPMRC` omits several policy keys (`minimum-release-age-exclude`, `resolution-mode`, `prefer-frozen-lockfile`, `hoist-pattern`, `public-hoist-pattern`, `save-prefix`), and only the root `.npmrc` is examined — a per-package `.npmrc` would not be caught.
14. `ioc-scan.mjs` skips files over 8 MiB and excludes three first-party files from the string scan entirely. Nothing is missed today (the only >8 MiB files are 4 native binaries), but a large bundled JS payload would evade.
15. **`ioc-scan.mjs`'s self-exclusion list is a hardcoded set of three paths, so the gate cannot coexist with any new document about the campaign.** Writing this report into the tree turned the gate red (`✗ 5 failures`, all in my own file) until I defanged the markers. Any future incident write-up, runbook or post-mortem that quotes a marker verbatim breaks the release gate — which trains people to defang evidence or to add paths to a deny-list of the scanner's own making. Better: exclude by an explicit `prl-ioc-allow` marker in the file, or restrict the string scan to executable/config extensions rather than including `.md`.
16. `.dockerignore` does not exclude `.npmrc` from the build context.
17. 19 of 162 versions are under 14 days old (youngest 8.3 d against a 7-day cooldown). Within policy; worth a conscious release decision rather than a silent one.

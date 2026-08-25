# Rollback verification

**Images SHA:** `68394b3df5dc51f45fa7409a3541c224861dad49`

> **Re-rehearsed 2026-08-25 on the current candidate.** Candidate `/ready` 200 → `compose stop api`
> → nginx **504** on the TLS origin → previous digest pair (`b292b2a`, the Debian build) serving 200
> → candidate restored, 200 with workers. The sequence below is the original capture and its shape
> is unchanged; the digests are now
> api `sha256:bbfd0269b879…` / web `sha256:7c2c1ce9ff1c…`.

**Previous images SHA:** `b292b2ac234cb586f253ad42ec0ef4d949fa332b`
**Capture:** `{SCRATCH}/rollback.log` (host SHA at run time `53faed7`, docs-only vs the image SHA).

`{SCRATCH}`:
`/var/folders/7s/l9fr0tyd4wn9vp8qhg9yv7g80000gn/T/grok-goal-843cf6607006/implementer`

---

## Digests

| Role | API | Web |
| --- | --- | --- |
| Candidate | `sha256:3854174f36184bb14cf2bf0b6912fbc199a804b230c392111c0a58943d92e36f` | `sha256:2bc457c546bf3b8edd379c610199b18f0c1b06ebc61bdb83183755df31a8bd88` |
| Previous (`4a17e3cec3a6`) | `sha256:9a8457e8ae427d64b7cd2aa4da65f2a978cc55ad347d1842c6822e8beba72abe` | `sha256:34ba79323e2e0be06a7f935351401a3cc6ae8b9b1561e371d1cfa05263dccbb2` |

---

## Sequence

1. Candidate running. TLS `/ready` 200, database and workers ok.
2. `compose stop api`. Origin `/api/v1/ready` → nginx **504 Gateway Time-out**.
3. Env pointed at the previous pair; `compose up -d --no-deps api web`. Previous api image confirmed `sha256:9a8457e8…`. `/ready` 200.
4. Env restored to the candidate pair. Recreated containers. `/ready` 200 with workers. `docker inspect`: candidate api and web digests. `staging status`: both match the manifest.

Local BuildKit rollback only. Not a registry pull. Migrations remain roll-forward (`failed-migration` drill).

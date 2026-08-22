# Rollback verification

**Candidate SHA:** `4a17e3cec3a6418be34ee7b3efd69cbfe84446b2`.
**Capture:** `{SCRATCH}/rollback.log`.
**Staging origin:** `https://localhost:8443`, chain verified against the local CA.

`{SCRATCH}`:
`/var/folders/7s/l9fr0tyd4wn9vp8qhg9yv7g80000gn/T/grok-goal-843cf6607006/implementer`

There is no `staging rollback` command. The rehearsal is: deploy by digest, simulate failure, deploy the previous local digest, then restore the candidate digest. All of that happened on this machine’s BuildKit store. **It is not a cross-machine, registry-attested rollback.**

---

## Digests

| Role | API | Web |
| --- | --- | --- |
| Candidate (`4a17e3cec3a6`) | `sha256:9a8457e8ae427d64b7cd2aa4da65f2a978cc55ad347d1842c6822e8beba72abe` | `sha256:34ba79323e2e0be06a7f935351401a3cc6ae8b9b1561e371d1cfa05263dccbb2` |
| Previous (`1e49f878f7df`, dirty) | `sha256:65299822f90c7ef247044cd0462ac54fef250386ea114bfdec4dcc1d6401d4ab` | `sha256:301dc58757d7c24a5f922ac9a36390f04d548bc5244c5f14f5ec3b31205d64ff` |

---

## Sequence that actually ran

1. **Candidate running.** `staging status` healthy. `GET /api/v1/ready` over TLS: 200, `database` and `workers` both ok.
2. **Simulated failure.** `docker compose … stop api`. Origin `/api/v1/ready` → nginx **504 Gateway Time-out**. Postgres, proxy and web stayed up.
3. **Previous digest.** `PRL_API_IMAGE` / `PRL_WEB_IMAGE` pointed at the `1e49f878f7df` pair; `compose up -d --no-deps api web`. Both containers recreated. API became healthy. `/ready` 200 with `{"status":"ready","checks":{"database":{"ok":true}}}` — that older image does **not** gate `/ready` on workers. `docker inspect` showed the previous digests.
4. **Restore candidate.** Images rewritten back to the `4a17e3cec3a6` pair; compose recreated api/web. `/ready` 200 with `database` **and** `workers` ok. `docker inspect`:
   - api=`sha256:9a8457e8ae427d64b7cd2aa4da65f2a978cc55ad347d1842c6822e8beba72abe`
   - web=`sha256:34ba79323e2e0be06a7f935351401a3cc6ae8b9b1561e371d1cfa05263dccbb2`
5. **`staging status`:** both running containers match the candidate manifest. Attestation still present.

---

## What this proves

- The staging stack can move **from candidate → previous local digest → candidate** without rebuilding.
- A dead API is visible through the TLS origin (504), not as a false 200.
- After restore, `/ready` is actually ready, including workers, on the candidate image.

## What this does not prove

- Registry pull of a previous tag on another machine.
- Schema compatibility of an arbitrarily old image against a database this candidate has migrated (the previous image booted on this cluster; that is one data point, not a general rollback of migrations — this project is roll-forward only, see the `failed-migration` drill).
- A signed, promoted production rollback.

`pnpm run staging promote` after this rehearsal still reported the candidate digests as the ones staging tested. Promote does not deploy.

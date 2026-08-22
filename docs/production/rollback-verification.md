# Rollback verification

This was a non-destructive local staging rehearsal. It changed containers only and did not drop,
truncate, reset, or modify the database/volume.

Candidate pair:

- API `sha256:9a8457e8ae427d64b7cd2aa4da65f2a978cc55ad347d1842c6822e8beba72abe`
- Web `sha256:34ba79323e2e0be06a7f935351401a3cc6ae8b9b1561e371d1cfa05263dccbb2`

Previous local pair (older dirty development image, not a signed production release):

- API `sha256:65299822f90c7ef247044cd0462ac54fef250386ea114bfdec4dcc1d6401d4ab`
- Web `sha256:301dc58757d7c24a5f922ac9a36390f04d548bc5244c5f14f5ec3b31205d64ff`

## Sequence actually run

1. Candidate API/web were running and TLS `/api/v1/ready` returned 200 with database/workers ready.
2. `docker compose ... stop api` made the same readiness probe fail.
3. `up -d --no-deps` with the previous API/web digests recreated those containers; readiness returned
   200 with the database check.
4. The candidate pair was restored with the same no-build command; readiness returned 200 with both
   database and workers checks.
5. `docker inspect` showed the candidate pair exactly after restoration.

No migration, volume removal, or image rebuild occurred during this rehearsal.

## Limits

Database rollback is roll-forward-only; an irreversible schema/data change requires a restore plan,
not a pretend down migration. This proves local digest transition only. It does not prove a registry
pull, signed previous production release, external secret/config rollback, or cross-machine RTO.
The final candidate must first get a same-SHA artifact manifest and a real previous release digest.

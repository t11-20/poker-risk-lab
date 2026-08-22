# `deploy/backup/` — scheduling the backups

These files make `pnpm run backup` happen on its own. The procedure they run, the retention
policy they enforce and the evidence from a real restore are in
[`docs/production/backup-restore.md`](../../docs/production/backup-restore.md); the recovery
decision tree is in
[`docs/production/disaster-recovery.md`](../../docs/production/disaster-recovery.md).

| File | What it is |
| --- | --- |
| `prl-backup.service` | one-shot unit: `backup.mjs create` |
| `prl-backup.timer` | nightly at 02:30 UTC, with catch-up |
| `prl-backup-verify.service` | one-shot unit: `verify --all`, then `verify --deep`, then `prune --apply` |
| `prl-backup-verify.timer` | Sunday 04:00 UTC, with catch-up |
| `backup.env.example` | the environment the units read — key, destination, database identity |
| `crontab.example` | the fallback for hosts without systemd, and what it costs |

## Why systemd timers, and not the other three options

This repository ships a `docker-compose.yml` whose own header says it is a developer's
machine, and `docs/RUNBOOK.md` §11 describes production as a proxy, one API replica, a web
replica and PostgreSQL. So "the deployment shape" is a Linux host (or a small set of them)
running containers behind a proxy — not a Kubernetes cluster with a `CronJob` object, and not
a platform with a managed scheduler.

**A compose sidecar was the obvious candidate and it was rejected, for three reasons.**

1. **Nothing in the stack can schedule.** Neither `postgres:16-bookworm` nor the API image
   contains cron or a timer. A compose "backup" service would therefore have to be a
   container running a sleep loop, and a sleep loop has no catch-up: restart the stack at
   02:29 and that night's backup never happens, silently. That is the exact failure the
   `Persistent=true` in `prl-backup.timer` exists to prevent.
2. **It would need either a new base image or the Docker socket.** The script needs Node 24
   *and* the PostgreSQL 16 client tools. No image in this stack has both, so a sidecar means
   either building a third image — a new base image in the supply chain, to be pinned by
   digest, scanned and kept current, for one cron job — or mounting `/var/run/docker.sock`
   so the sidecar can `docker exec` into the database container. The socket is
   root-equivalent on the host. Neither is worth it.
3. **The destination must outlive the compose project.** `docker compose down -v` removes
   named volumes. A backup volume inside the compose project is a backup that a routine
   teardown deletes along with the database it was protecting.

**Kubernetes `CronJob`** is the right answer *if* you are on Kubernetes, and nothing here
stops you: the container would run `node scripts/backup.mjs create` with the same environment
and a PVC (or object storage) at `PRL_BACKUP_DIR`. This repository has no Kubernetes
manifests, so shipping one would be shipping a guess.

**Plain cron** is the fallback, in `crontab.example`, with the four things it cannot do
written down next to it.

## Install

```bash
# 1. The backup identity and its privileges (see backup.env.example for why each is needed).
sudo useradd --system --home-dir /var/backups/poker-risk-lab --shell /usr/sbin/nologin prl-backup
sudo install -d -o prl-backup -g prl-backup -m 0700 /var/backups/poker-risk-lab

psql "$ADMIN_URL" <<'SQL'
CREATE ROLE prl_backup LOGIN PASSWORD 'from-your-secret-manager';
GRANT pg_read_all_data TO prl_backup;   -- read every table, and pg_authid for the globals
ALTER ROLE prl_backup CREATEDB;         -- scratch database for `verify --deep`
GRANT prl_migrator TO prl_backup;       -- so a restore can assign ownership (RUNBOOK §11.4)
SQL

# 2. The key. Generate it, put it in the env file, and escrow a copy somewhere else.
node scripts/backup.mjs keygen

sudo install -d -o root -g root -m 0700 /etc/poker-risk-lab
sudo install -o root -g root -m 0600 deploy/backup/backup.env.example \
  /etc/poker-risk-lab/backup.env
sudo "$EDITOR" /etc/poker-risk-lab/backup.env

# 3. The units.
sudo install -o root -g root -m 0644 deploy/backup/prl-backup.service \
  deploy/backup/prl-backup.timer \
  deploy/backup/prl-backup-verify.service \
  deploy/backup/prl-backup-verify.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now prl-backup.timer prl-backup-verify.timer

# 4. Prove it works NOW, rather than finding out at 02:30.
sudo systemctl start prl-backup.service
journalctl -u prl-backup.service --no-pager -n 40
sudo -u prl-backup env $(sudo cat /etc/poker-risk-lab/backup.env | grep -v '^#' | xargs) \
  node /opt/poker-risk-lab/scripts/backup.mjs verify --deep
```

The units assume the checkout is at `/opt/poker-risk-lab`. If it is somewhere else, change
`WorkingDirectory=` in both `.service` files; there is no other path baked in.

## Checking on it

```bash
systemctl list-timers 'prl-backup*'     # next and last run of each timer
journalctl -u prl-backup.service -n 50  # what the last backup actually printed
node scripts/backup.mjs list            # the archives, their retention class, their integrity
```

`list` marks an archive "good" when its manifest signature verifies and every file it names
is present at the recorded size. That is not the same as restorable — `verify --deep` is what
proves that, and the weekly timer is what makes it happen without being asked.

## The one thing to set up that is not in this directory

**An alert on failure.** Both `.service` files carry a commented-out `OnFailure=` line. Until
something is wired to it, a backup that has been failing for six weeks is indistinguishable
from one that has been succeeding, because both are silent. Point it at whatever this
deployment already uses to page a human; the units are the wrong place to invent one.

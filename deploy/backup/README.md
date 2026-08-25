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
| `crontab.example` | the fallback for hosts without systemd, and what it costs — installed to `/etc/cron.d/`, running as root |

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

**Plain cron** is the fallback, in `crontab.example`, with the seven things it cannot do
written down next to it. The first of the seven is specific to this deployment and is worth
knowing before you choose it: see [The cron fallback runs as root](#the-cron-fallback-runs-as-root)
below.

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

## The cron fallback runs as root

Only for a host with no systemd. Steps 1 and 2 of the install above are unchanged — the same
`prl-backup` account, the same 0700 destination, the same **0600 root-owned**
`/etc/poker-risk-lab/backup.env`. Step 3 becomes:

```bash
sudo install -o root -g root -m 0644 deploy/backup/crontab.example /etc/cron.d/prl-backup

# 4. Prove it works NOW, exactly as cron will run it — as root, sourcing the env as root.
sudo flock --nonblock /var/lock/prl-backup.lock sh -c \
  'set -a; . /etc/poker-risk-lab/backup.env; set +a; cd /opt/poker-risk-lab &&
   runuser -u prl-backup -- node scripts/backup.mjs create'
```

**This documentation used to be wrong, and the correction is the point of this section.**
`crontab.example` said to install with `crontab -u prl-backup`, and its cron lines source
`/etc/poker-risk-lab/backup.env` — the file this README, `backup.env.example` and
`prl-backup.service` all describe as 0600 and root-owned in a 0700 root-owned directory. As
`prl-backup` that `.` fails with EACCES, the `&&` chain never reaches `node`, and cron's
output goes to a mail spool that on most hosts goes nowhere. The documented fallback could
not run a single backup, and would not have said so.

The systemd path has no such problem because systemd reads `EnvironmentFile=` as root and
*then* drops to `User=prl-backup`. Cron has no equivalent step, so the fallback does it by
hand: **the cron entry runs as root**, sources the env file as root, and drops to
`prl-backup` with `runuser` for the backup process itself.

What that costs, stated rather than buried: `cron`, `flock`, `sh` and the read of the secret
all run as root under the fallback, so a compromise of `/etc/cron.d/prl-backup` or of that
wrapper is root on the host, not just the backup account. `node`, `pg_dump` and everything
that touches an archive still run as `prl-backup`. The alternative — relaxing `backup.env` to
0640 `root:prl-backup` and scheduling as `prl-backup` — moves the encryption key and the
database password into the unprivileged account's blast radius, which is the exact thing the
0600 mode exists to prevent. Either is defensible; neither is as good as the timer, and that
asymmetry is why the timer is the supported path.

## Checking on it

```bash
systemctl list-timers 'prl-backup*'     # next and last run of each timer
journalctl -u prl-backup.service -n 50  # what the last backup actually printed
node scripts/backup.mjs list            # the archives, their retention class, their integrity
```

Under the cron fallback the first two have no equivalent — that is item two and item three of
the seven. `sudo tail -50 /var/log/prl-backup.log` is all there is for "what the last run
printed", there is no "next run", and a run that never happened leaves nothing at all. `list`
works the same either way and is the only one of the three that answers the question that
actually matters.

`list` marks an archive "good" when its manifest signature verifies and every file it names
is present at the recorded size. That is not the same as restorable — `verify --deep` is what
proves that, and the weekly timer is what makes it happen without being asked.

## The one thing to set up that is not in this directory

**An alert on failure.** Both `.service` files carry a commented-out `OnFailure=` line. Until
something is wired to it, a backup that has been failing for six weeks is indistinguishable
from one that has been succeeding, because both are silent. Point it at whatever this
deployment already uses to page a human; the units are the wrong place to invent one.

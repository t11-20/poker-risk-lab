# Legal register — the decisions counsel has to make, and the facts each one rests on

**Status:** Launch blocker, OPEN · **This document closes nothing** · **Drafted:** 2026-08-25 ·
**Revised:** 2026-08-25 (enrolment)
**Branch:** `production-hardening-2` · **Page text revision under review:** `0.2-draft`
(`apps/web/src/lib/legal-config.ts`, `LEGAL_REVISION`)

This is input to a lawyer. It contains no legal advice, asserts compliance with no regime, and
answers none of its own questions. An engineer may not close an entry in it.

It exists because [`final-readiness-report.md`](final-readiness-report.md) residual 5 records the
legal register as an open launch blocker, and because the product changed in a way the existing
documents did not describe: **students are about to be onboarded onto courses.**

> ## Correction, 2026-08-25 — this document's own framing was wrong
>
> The paragraph above used to read *"a fee is about to be charged, and students are about to be
> onboarded"*, and every entry below was written under that premise. **That premise was an
> assumption, not a finding.** `db/migrations/0006_cohort_enrolments.sql` landed on 2026-08-25 and
> records who holds a place in a course, on whose authority, against an opaque external
> `reference` — and **it records nothing about money, because it cannot** (`:25-30`). The grant
> happens out of band. A scholarship cohort, an employer-funded class and a paid course produce
> byte-identical rows, and the `reference` may literally be the word `scholarship` (`:32-37`).
>
> So **"a fee is charged" is not a fact about this system and this register may not assert it.** The
> fact is that entitlement is now recorded and the *basis* for it is deliberately outside this
> software. Where an entry below asks a question premised on a fee, the question is still worth
> asking — a deployment that charges is plainly one of the cases — but it must be asked for the free
> case too, and L10 and L11 now say so explicitly. An engineer who assumed the fee and wrote it into
> the terms would have made the same class of error this document exists to prevent, in the other
> direction.

## How this relates to `legal-review-requirements.md`

[`legal-review-requirements.md`](legal-review-requirements.md) is **mechanically coupled** to the
product: `apps/web/test/legal-pages.test.ts` fails if a clause is in `COUNSEL_CLAUSES`
(`apps/web/src/lib/legal-config.ts`, `COUNSEL_CLAUSES`) and not named in that file, and the pages fail if they
render a clause the register does not assign them. **Do not delete it and do not fold it into this
one.** It is the machine-checked list of markers on the pages.

This document is the other half: the facts underneath each decision, verified against the code and
cited to file and line, plus the four decisions that onboarding students onto courses adds. Entries
L1–L9 correspond to that file's entries 1–9 by name. **L10 and L11 now correspond to its entries 10
and 11** — they were added on 2026-08-25 with the `/terms` rewrite, so they are marked on the page,
in `COUNSEL_CLAUSES` and in the review document, and the three are held in step by the test. **L12
and L13 still have no marker on any page, which remains a finding** (§7, E14).

**Every factual claim below was read out of the working tree on 2026-08-25 and cited. Where a stated
fact and the code disagreed, the disagreement is recorded in §4 rather than smoothed over.**

**Provenance caveat, because it matters for a document of this kind.** The tree was *not* frozen
while this was written: unrelated work landed during the review, including
`db/migrations/0005_room_ownership.sql` (§2.8, D5) and `apps/api/test/cohort-sign-in-limits.test.ts`
(§1). Every line number here was read after those landed and re-verified at the end, but a register
is only as current as the schema underneath it. **Re-check §2 against `db/migrations/` before this
is sent to counsel.** `apps/web/test/legal-pages.test.ts` will refuse a new table that `/privacy`
does not account for, which is the mechanism that makes "re-check" a gate and not a good intention.
**It has now refused twice** — `prl.room_ownership` (D5), then `prl.cohorts` and `prl.enrolments`
(§2.9).

**The caveat applied again, harder, later on 2026-08-25.** `db/migrations/0006_cohort_enrolments.sql`
and the API code that reads it landed *during* this revision, and the API-side files were moved in
and out of the working tree while it was being written. Every claim below about
`db/migrations/0006_cohort_enrolments.sql` was read from that file and is stable — a migration cannot
be edited once applied (`apps/api/scripts/migrate.mjs` records a sha256 and aborts on a mismatch).
**Claims about `apps/api/src/repositories/users.ts` are flagged where they appear and each carries
the command that re-checks it.** Nothing here should be taken as current about that file without
running the check beside it.

---

## 1. The fact that changes everything, stated first

**There is no payment code in this repository. None. Not disabled — absent.**

Verified by exhaustive search: no payment SDK in any `package.json`; no route resembling checkout,
billing, purchase, deposit, withdrawal or cash-out in the complete route inventory
(`apps/api/src/routes/`); no `balance`, `currency`, `price`, `amount`, `payout` or `prize` column
anywhere in `db/migrations/`; and exactly two `fetch()` call sites in the whole application
(`apps/web/src/lib/api.ts:397`, `apps/web/src/lib/guest-bootstrap.ts:251`), both same-origin. The
only outbound connection the application can make is to an OIDC identity provider
(`apps/api/src/auth/oidc.ts`). `.env.example:21` states it in as many words: *"There is no payment
provider, no wallet and no cash-out, so there is nothing here to configure for any of those."*

The schema says the same at `db/migrations/0001_initial.sql:4-9`: *"there is deliberately no
balance, currency, price, purchase, payout, prize or transfer column anywhere in the schema, and no
table that could serve as a ledger of value."*

**Two consequences, and they pull in opposite directions.**

The first is good, and it is the single most important fact for counsel: **the play-money property
is intact and the fee does not touch it.** A course fee buys access to teaching material. It is not
a stake, it does not become units, units cannot be bought, units cannot be transferred between
accounts (there is no endpoint and no column), units reset for free and unconditionally
(`apps/api/src/routes/auth.ts:633`, deliberately not rate-limited beyond the global limiter), and
nothing converts a unit into anything. `docs/PRODUCT-GUARDRAILS.md:14-19` forbids "purchases,
deposits, top-ups or subscriptions **tied to units**" — a course fee is not tied to units, so it
does not cross that guardrail. The distinction counsel needs is therefore clean and defensible:
**money buys lessons; money never buys, becomes, or is redeemed for anything at a poker table.**

The second was a defect and is now half closed. **Because there is no code that takes money,
whatever is exchanged for a place in a course is exchanged somewhere this system cannot see.** When
this was first written the consequence was total: no enrolment record, no entitlement, no record
that anybody had been admitted to anything, and a shipped `/terms` telling every reader the service
was free.

`db/migrations/0006_cohort_enrolments.sql` (§2.9) closed the first half. **There is now a durable
record of entitlement** — who holds a place, in which cohort, on whose authority, against an opaque
external `reference`, until when, and whether it was withdrawn and why. What is still absent, and
absent on purpose, is anything about money: no refund mechanism, no receipt, no amount, no way for
this system to know what — if anything — was exchanged.

**Read that carefully, because it is the distinction the rest of this document now turns on.** An
enrolment record does **not** establish that a fee was paid. `0006:32-37` is explicit that the
`reference` may be a purchase-order number, a row in a finance system nobody here can read, a
registry entry, **or the literal word `scholarship`**, and that this schema "does not know, and must
never learn, which of those it is". So the correct statement of the position is: *money buys
lessons where a deployment charges for them; this software records only that somebody was admitted,
and never by whom or for what.*

`/terms` no longer says the service is free — see §4 D1, now fixed — and the question at
`apps/web/src/lib/legal-config.ts` that was premised on it has had the premise withdrawn rather than
answered (L8).

Cohort onboarding is not hypothetical: `apps/api/test/cohort-sign-in-limits.test.ts` opens *"A
paying cohort's first five minutes. Thirty students on one campus, office or VPN egress address open
the app together and sign in."* Note in passing that the word *paying* in that test's own prose is
an assumption of the same kind this document had to correct in itself — the rate limiter neither
knows nor cares.

---

## 2. Data inventory, from the schema and the code

One row per field that holds anything about a person. Every "why" is the reason visible in the code,
not an intent. Columns holding only bot configuration, table settings or engine state are omitted
and named at the end.

### 2.1 `prl.users` — the account (`db/migrations/0001_initial.sql:229`)

| Field | What it is | Why held | Where it comes from |
|---|---|---|---|
| `id` | `usr_` + 8–64 random chars (`:230-231`, domain at `:136`) | Primary key; self-describing so a room id cannot be passed to a user lookup (`:17-26`) | Server-generated |
| `kind` | `guest` \| `oidc` (`:232-233`) | Decides whether an OIDC identity is required (`:264-267`) | Server |
| `display_name` | 2–24 chars, trimmed (`:234-238`) | Shown at a table | Learner-chosen, or generated |
| `oidc_issuer` | https URL, 8–255 chars (`:241-250`) | Half of the federated identity | **The identity provider** |
| `oidc_subject` | ≤255 chars (`:252-255`) | The other half | **The identity provider** |
| `last_seen_at` | timestamptz (`:256`) | Feeds the abandoned-guest sweep — implemented 2026-08-25, §4 D4 | Server |
| `created_at`, `updated_at` | timestamptz (`:257-258`) | Ordering, trigger at `:884` | Server |

**There is no email column, no password column and no date-of-birth column.** Not blank ones — no
such columns exist, which is checkable against the `CREATE TABLE` above. The OIDC module is explicit
that email is *"Not requested, not read, not stored"* (`apps/api/src/auth/oidc.ts:29-31`), because
keying on a mutable, often-unverified address silently merges accounts.

**What the identity provider actually sends, versus what is kept.** The requested scope is
`openid profile` (`apps/api/src/auth/oidc.ts:124`). `profile` is a standard OIDC scope that entitles
a provider to return `name`, `family_name`, `given_name`, `middle_name`, `nickname`,
`preferred_username`, `profile`, `picture`, `website`, `gender`, `birthdate`, `zoneinfo`, `locale`
and `updated_at`. This application reads exactly four of them, in order, as a display-name candidate
— `name`, `preferred_username`, `given_name`, `nickname` (`apps/api/src/auth/oidc.ts:818-823`) — and
persists only `iss` and `sub`. The rest arrive inside the ID token, transit the API process, and are
discarded. **They are received, briefly held in memory, and not stored.** Counsel should be told
that plainly rather than shown "we store issuer and subject" alone; see §7 E4 for the minimisation
fix.

### 2.2 `prl.sessions` — one signed-in browser (`:284`)

| Field | What it is | Why held |
|---|---|---|
| `user_id` | FK → `users`, **ON DELETE CASCADE** (`:287-288`) | Whose session |
| `token_hash` | SHA-256 of the token, 32 bytes (`:289`, domain `:141`) | Lookup. The token itself is never stored, so reading this table cannot sign anyone in (`:303-305`) |
| `expires_at`, `revoked_at` | timestamptz (`:290-291`) | Validity |
| `user_agent_hash` | **keyed** HMAC-SHA-256, nullable (`:292`) | Showing a learner their own sessions (`:307-308`) |
| `ip_hash` | **keyed** HMAC-SHA-256, nullable (`:293`) | Same, and rate limiting (`:305-306`) |

The raw address and raw user agent are never written to the database. **A keyed digest is
pseudonymisation, not anonymisation**: anyone holding the secret can confirm a guessed address
(`apps/api/src/plugins/request-context.ts:25-27` says so in the code). Counsel should assume the
weaker property. **§4 D2 used to say that the reverse proxy in front of this application undid all
of it — it wrote the raw address and the full user agent to a log. That is fixed: the proxy now
logs an IPv4 client as its /24 and an IPv6 client as its /48, and the user agent as one of
`browser`/`tool`/`bot`/`none`. Read D2 anyway, because a /24 is reduction and not anonymisation,
and it is a weaker property than the keyed digest this section describes.**

### 2.3 `prl.oidc_login_attempts` — an in-flight sign-in (`:328`)

`state_hash`, `nonce_hash`, `pkce_verifier_hash` (`:331-333`), all digests — storing the verifier
would let a database read complete somebody else's login (`:284-286` of the header comment);
`redirect_after`, constrained to a local path so a stored redirect cannot become an open redirect
(`:340-347`); `expires_at`, `consumed_at` (`:349-350`). Single use is enforced by the consuming
`UPDATE`, not by trust (header at `:315-321`).

### 2.4 `prl.rooms` / `prl.room_members` — private tables (`:376`, `:441`)

Room: `name`, `owner_user_id` (**SET NULL** since `db/migrations/0004_account_deletion.sql:162-164`),
`invite_code_hash` (the code is shown once and never stored, `:425-427`), blinds, stacks, timer,
`visibility` **constrained to the single value `invite_only`** (`:403-404`) so public matchmaking
requires a migration, `status`, `closed_at`.

Member: `user_id` (**CASCADE** since `0004_account_deletion.sql:183-185`), `seat`, `stack`,
`joined_at`, `left_at`, plus bot-only `is_bot`, `bot_profile`, and `bot_difficulty` / `bot_seed`
(`db/migrations/0003_bot_seat_recovery.sql:125,130`). `stack` is a count of practice units, not a
balance (`0001_initial.sql:420-421`).

### 2.5 `prl.hands` / `prl.hand_seats` / `prl.hand_actions` — the permanent record (`:498`, `:640`, `:691`)

The sensitive field is `hand_seats.hole_cards` (`:654`), and its read rule is the strictest in the
schema: it *"MUST only ever be SELECTed for the owning user, or for any user once `showed_down` is
true"* (`:671-677`). That is enforced in SQL at `apps/api/src/repositories/hands.ts:764-767`, and a
NULL viewer matches no seat. `hand_seats.user_id` is **SET NULL** (`:649-650`).

**There is deliberately no column for the deck and none for the commitment salts** (`:477-479`), so a
database read cannot expose the undealt cards of a live hand or the unshown hole cards of a finished
one. Only the Merkle root is stored, and `reveal` is constrained never to be complete and never to
prove more than the 17 cards that can legitimately become public (`:574-610`).

### 2.6 Behavioural records

`prl.lesson_progress` (`:761`) — which lessons opened and finished. `prl.quiz_attempts` (`:794`) —
one row per answered question with the learner's own submission; **no score, streak or pass column
exists** (`:781-783`). `prl.scenario_attempts` (`:822`) — one decision each, `matched_expected`
nullable because many spots make no claim about a correct action (`:840-841`).

### 2.7 `prl.audit_log` — security events (`:852`)

`user_id` (**SET NULL**, `:855-856`), `event`, `detail`, `created_at`. `detail` is policed by
`audit_log_detail_has_no_forbidden_keys` (`:868-874`), which refuses a top-level key named `token`,
`ip`, `ipAddress`, `userAgent`, `inviteCode`, `deck`, `salt`, `salts`, `holeCards` and six others.
The constraint tests key **existence** and cannot see inside nested objects, so the real control is
the boundary redactor at `apps/api/src/repositories/audit.ts:213-231`, which **removes** forbidden
keys at every depth and records the dropped names under `_redacted` — an array value, invisible to
the `?|` operator, which is why it does not itself trip the constraint (`audit.ts:118-139`).

In practice `detail` carries almost nothing: the four call sites write `{ refusal, origin? }`
(`apps/api/src/ws/hub.ts:275-284`), `{ route }` (`apps/api/src/plugins/security.ts:830-836`), or
nothing at all (`apps/api/src/routes/auth.ts:456,487,713`). The rate-limit key is deliberately not
recorded (`security.ts:823-825`).

### 2.8 `prl.room_ownership` — holds nothing about a person (`db/migrations/0005_room_ownership.sql:127`)

One lease row per room naming which **API process** is authoritative for it (`:159-166`), plus a
fence counter and two timestamps. The identifier names a process, not a person, and there is no
column that could hold an account id. Listed because the inventory must account for every table, and
because saying "nothing" is a fact somebody checked rather than a table somebody forgot. Added to
`/privacy` by this change — see §4 D5.

### 2.9 `prl.cohorts` and `prl.enrolments` — entitlement, and on whose authority

Added by `db/migrations/0006_cohort_enrolments.sql` on 2026-08-25, after the first draft of this
document. `apps/web/test/legal-pages.test.ts` failed on both tables, which is the coupling working
for the second time (D5 was the first). Every line below was read out of that file.

**`prl.cohorts` (`:215-243`) holds nothing about any person.** `key` (a typed handle, 3–64 chars,
`^[a-z0-9]+(-[a-z0-9]+)*$`, `:222-226`), `name` (2–120 chars, trimmed, `:228-232`), `starts_at`,
nullable `ends_at`, `created_at`. There is no account column and none that could hold one. The
table's own `COMMENT` says it: *"Holds nothing about any person and nothing about what anything
cost"* (`:245-247`).

**`prl.enrolments` (`:262-322`) — one person's place in one cohort.**

| Field | What it is | Why held | Where it comes from |
|---|---|---|---|
| `id` | `enr_` + random (`:263-264`) | Primary key | Server |
| `cohort_id` | FK → `cohorts`, **ON DELETE RESTRICT** (`:266-267`) | Which class. RESTRICT so a cohort with enrolments cannot be removed and take the record of everybody in it (`:54-61`) | Operator |
| `user_id` | FK → `users`, **ON DELETE CASCADE** (`:269-270`) | Whose place | Operator |
| `granted_at` | timestamptz (`:272`) | When the entitlement was created | Server |
| `granted_by` | text, 2–128, trimmed (`:277-281`) | **On whose authority.** Free text and deliberately not a foreign key: there is no instructor table and no admin role in this product (`:330-332`) | **Typed by an operator** |
| `reference` | text, 1–200, trimmed, **NOT NULL** (`:285-289`) | An **opaque external identifier** — a purchase-order number, a row id in a finance system nobody here can read, a registry entry, or the word `scholarship`. Never parsed here (`:32-37`, `:333-335`) | **Typed by an operator** |
| `starts_at` / `expires_at` | timestamptz, expiry nullable (`:291-292`) | The person's window. NULL expiry is not "forever" — the cohort's `ends_at` still bounds it (`:336-338`) | Operator |
| `revoked_at` / `revoked_by` / `revoked_reason` | all-or-nothing triple (`:294-321`) | Withdrawal, with its authority and its reason. A `CHECK` refuses a partial revocation, so a withdrawal nobody can account for cannot be recorded at all (`:313-319`) | Operator |

**The fact counsel most needs from this section: there is no amount, currency, price or receipt
column here or anywhere in the schema, and this system therefore cannot say whether a place was
paid for** (`:25-30`; `0001_initial.sql:4-9` is unchanged and still true). Entitlement is the
intersection of the enrolment's window and the cohort's (`:83-99`), so a cohort that has ended
entitles nobody however its enrolments are written.

**Reach.** `prl_app` — the request path — is granted **`SELECT` and nothing else** on both tables
(`:387-388`), the narrowest verb set in the schema. There is no privileged HTTP surface: enrolment
happens through `apps/api/scripts/enrolments.mjs` connecting as the migrating identity, which no
request handler can reach (`:143-162`). An injection that reaches the runtime role can read who is
enrolled and cannot enrol anybody, extend its own access, or erase a revocation.

**History, and what survives an erasure.** Every grant, supersession and revocation writes an
append-only `prl.audit_log` row in the **same transaction** as the change
(`apps/api/src/repositories/enrolments.ts:504,516,570`), and a grant's `detail` carries the external
`reference` (`:516-523`). `user_id` on the enrolment is CASCADE, so `POST /me/delete` removes the
enrolment row; `audit_log.user_id` is SET NULL (`0001_initial.sql:855-856`), so what remains is a
detached row saying that on a date, on somebody's authority, against that reference, a place was
granted and later ended. **Counsel should be told both halves plainly:** the erasure is real, and the
external reference an operator typed outlives it in a table nothing ever sweeps. `/privacy` §2 and
§6 now say so.

### 2.10 Who can read it

| Identity | Reach | Cited |
|---|---|---|
| `prl_app` (the request path) | Narrowest verb set per table. **No DELETE on `rooms`, `room_members`, `hands`, `hand_seats`, `hand_actions`, `quiz_attempts`, `scenario_attempts`, `audit_log`.** No CREATE, TRUNCATE, REFERENCES, TRIGGER or ownership | `0001_initial.sql:937-953`, matrix at `:914-931` |
| `prl_api` | The login role the API connects as. Holds **no privilege of its own** — everything is inherited from membership in `prl_app` | `db/seeds/0002_dev_login_roles.sql:69-74,97-99` |
| `prl_migrator` | Owns the schema and alters it. Migrations run from outside the serving container | `0001_initial.sql:98`, `docs/production/security.md:171` |
| **`prl_backup`** | **`pg_read_all_data` — every row of every table, including `hand_seats.hole_cards`** — plus `CREATEDB` and membership of `prl_migrator` | `deploy/backup/README.md:61-64` |
| Cluster superuser | Everything | `docker-compose.yml:130` |

**`prl_backup` is the widest reader in the system and `docs/production/security.md:164-170` does not
list it** — that section says "Three roles" and shows a table with two rows, neither of which is the
one that can read every hole card ever dealt. See §4 D3.

### 2.11 Where it is copied to

* **Backups.** `pg_dump` as `prl_backup`, encrypted, nightly at 02:30 UTC
  (`deploy/backup/prl-backup.timer:18`), verified and pruned Sundays at 04:00
  (`deploy/backup/prl-backup-verify.timer:13`). Retention is grandfather-father-son: **7 daily, 4
  weekly, 6 monthly** (`scripts/backup.mjs:188-190`), with an override that **the newest good backup
  is never deleted whatever the policy says** (`scripts/backup.mjs:1238-1247`). So a row can persist
  in an archive for **up to roughly six months**, and indefinitely if backup creation stops.
* **Application log.** stdout, JSON lines. Per request: a server-generated request id, method, path
  with the query string stripped, query parameter **names only**, the route pattern, the status, and
  a truncated keyed HMAC of the address called `clientKey`
  (`apps/api/src/logging.ts:263-269,409-411,280`). Three overlapping redaction layers
  (`logging.ts:8-23`): a serializer allowlist, a recursive key-name scrub (`:164-229`), and 47
  redact paths (`:336-383`). **This layer is well built, and the layer in front of it now matches
  rather than bypasses it — see §4 D2.**
* **Proxy access log.** stdout, one line per request. Timestamp, the client's /24 (or /48), a user
  agent *class*, method and **`$uri` — the path with the query string already removed** — status,
  bytes, request time, upstream address/status/time, and the API's own request id read back off its
  response header so a proxy line joins to an application line. No query string, no raw address, no
  user agent, no referer, no cookie (`deploy/staging/nginx.conf`, `docker-compose.yml`). The proxy
  **error** log is at level `crit`, and the OIDC callback has its own location sending the error log
  to `/dev/null`; both are there because nginx stamps the full request line onto error-log messages
  itself, at any level, in a shape no `log_format` controls. See §4 D2 for what this replaced.
* **Metrics.** Enumerated in full: **no label anywhere is or could be a user id, session id, room
  id, hand id, IP or display name.** The only request-derived label is the Fastify route *pattern*
  or the fixed string `unmatched` (`apps/api/src/observability/metrics.ts:174-177`), the file states
  the rule at `:16-20`, and cardinality is hard-capped at 256 series per metric with an overflow
  bucket (`apps/api/src/observability/registry.ts:54,174-193`). Prometheus retention is 2 hours
  (`docker-compose.observability.yml:78`). **This claim holds.**
* **Hand history.** Permanent, by design and by grant. See §5.
* **The identity provider.** Learns that a given subject signed in here, and when.

#### How long a container log is kept — and why there is no logrotate

Asked plainly, because it was an open item nobody was going to close.

Every service in `docker-compose.yml`, `docker-compose.staging.yml` and
`docker-compose.observability.yml` now declares a `logging:` block — `json-file` with a `max-size`
and a `max-file`, sized per service with the reasoning written beside each one and the canonical
argument in `docker-compose.yml`'s header. api 20m × 5, proxy 10m × 5, postgres / web / prometheus /
alertmanager 10m × 3; 210 MiB per application stack, 60 MiB for the observability overlay.

**Is logrotate still needed? No, and adding it would be a defect.** These files are owned and held
open by the Docker daemon, not by the processes in the containers. logrotate renames or truncates
files it manages; rename one of these and the daemon keeps writing to an unlinked inode — the log
silently stops appearing in `docker logs` while still consuming the disk — and `copytruncate` races
the daemon's own writes. `max-size`/`max-file` **is** the rotation, applied by the component that
owns the file. There is nothing for logrotate to add.

**Is `max-size` × `max-file` therefore sufficient? For the disk, yes. For retention, no, and the two
must not be confused.** A size cap bounds HOW MUCH is kept; it says nothing about HOW LONG. At ten
requests a minute a 100 MiB api log holds months of history; under load it holds an afternoon. So:

* The **disk-exhaustion** risk — an unbounded log filling the Docker host, stopping Postgres writing
  and costing data — **is closed.** That was the second half of D2.
* The **retention** question is **not closed and cannot be closed by a size cap.** If an answer to
  L7 is "operational logs are kept for N days", nothing in this deployment implements it and no
  value of `max-size` can. Implementing it needs either a log driver that ships to a store with a
  time-based policy, or a periodic sweep — a real engineering item, listed at §7 E12.

Recording a size cap as though it were a retention period would be exactly the kind of claim this
document exists to avoid, so it is written down as two separate answers.
* **The SMTP smarthost**, if alerting is configured. Carries alert content and the on-call
  addresses, not learner data (`deploy/staging/observability/alertmanager.template.yml:104-114,146-163`).

### 2.12 Retention actually implemented

| Category | Stated | **Implemented** | Cited |
|---|---|---|---|
| Session, idle window | 14 days | 14 days, **sliding** — refreshed at the halfway point | `sessions.ts:41`, `auth/session.ts:83`, `sessions.ts:251-272` |
| Session, **absolute** | *was not stated at all* | **60 days from `created_at`**, hard ceiling | `apps/api/src/auth/session.ts:75` |
| Revoked session row | 1 day after revocation | Eligible at +24 h, deleted at the next 6-hourly tick → **24–30 h** | `sessions.ts:67,350-368` |
| Sign-in attempt | 10 minutes | Unusable at 10 min; **row removed at the next tick → up to ~6 h 10 min** | `sessions.ts:50,501-511` |
| Sweep cadence | every 6 hours | 6 h, batch 1 000, ≤100 passes/kind/sweep, **not env-overridable**, first tick **60 s after boot** (`FIRST_SWEEP_DELAY_MS = 60_000`), then every 6 h | `apps/api/src/maintenance/retention-sweep.ts`; `apps/api/src/server.ts` |
| Everything else | until you delete your account | **Correct — no sweep exists for any other table** | `apps/api/src/maintenance/retention-sweep.ts` |
| Abandoned guest accounts | *not stated anywhere* | **60 days unseen, and only if provably dead** — no live session, no membership, no hand seat, no room **and no enrolment** (five clauses, not the four this row used to list). Implemented 2026-08-25; the period is DERIVED from the session ceiling, not chosen | §4 D4, `apps/api/src/maintenance/retention-sweep.ts` |
| Backups | *was not stated at all* | **Up to ~6 months**, newest good one never pruned | `scripts/backup.mjs:188-190,1238-1247` |
| Container logs (all services) | *not stated at all* | **Size-capped, not time-limited.** Every service in all three compose files: api 20m×5, proxy 10m×5, the rest 10m×3. That bounds the disk; it is **not** a retention period, and none is implemented | §2.11, §4 D2, §7 E12 |
| `prl.audit_log` | until you delete your account | Correct — but rows survive deletion with `user_id` NULL, and nothing ever removes them | `0001_initial.sql:855-856,953` |
| `prl.enrolments` / `prl.cohorts` | until you delete your account | **No sweep exists and none is planned.** An expired or revoked enrolment is kept deliberately — a withdrawal an operator cannot evidence is worth nothing. Account deletion removes the enrolment by CASCADE; the audit rows about it survive detached | §2.9, `0006:269-270`, `retention-sweep.ts` |

---

## 3. Erasure and export

### 3.1 What deletion does, exactly

`POST /me/delete` (`apps/api/src/routes/auth.ts:683-719`) → `deleteAccount`
(`apps/api/src/repositories/users.ts:417`). It requires a confirmation phrase in the body
(`:687`), authorises only on the caller's own session — there is no user id in the path or body, so
the route cannot be aimed at somebody else (`:671-673`) — and refuses a pool handle, insisting on a
transaction (`users.ts:418-422`).

**REMOVED** — `prl.sessions`, `prl.lesson_progress`, `prl.quiz_attempts`, `prl.scenario_attempts`,
`prl.room_members` (every seat, live or long departed), and since 2026-08-25 `prl.enrolments` —
every place held, live, expired or revoked, by `ON DELETE CASCADE` (`0006:269-270`). The reasoning
is 0004's own, applied unchanged: an enrolment is one person's record and nobody else's, and one
naming an account that no longer exists entitles nobody (`0006:168-193`).

> **Re-check before this is sent to counsel.** The referential action above is in the migration and
> is stable. Whether `accountFootprint` — the self-verification described next — *counts* the
> enrolment table is a separate question in `apps/api/src/repositories/users.ts`, and that file was
> being edited by other work while this section was written; it was read both with and without a
> ninth count. Deletion removes the row either way, because the CASCADE does it; what is at stake is
> only whether a half-erasure would be caught. Count the `count(*) from prl.` subqueries in
> `accountFootprint` — eight means `prl.enrolments` sits outside the check.

**DETACHED to NULL** — `prl.hand_seats.user_id`, `prl.audit_log.user_id`,
`prl.rooms.owner_user_id`. Rooms the learner created are **closed first, in the same transaction**
(`users.ts:441-447`), because a room whose owner is gone can never be closed by anyone
(`0004_account_deletion.sql:166-170`).

**KEPT IN FULL** — every hand: actions, board, commitment root, reveal proofs. A hand is a shared
record; four other people were in it (`0004_account_deletion.sql:30-32`).

**It verifies itself.** `accountFootprint` counts the tables naming the learner before and again
after, inside the same transaction, and throws if anything survives — so a schema that half-erased
an account rolls back rather than reporting a deletion that did not happen
(`users.ts:352-369,482-494`). This is
unusually strong and worth telling counsel: the erasure is not a promise, it is checked.

Almost none of the work is in TypeScript. **All nine** foreign keys referencing `prl.users` act by
themselves — six CASCADE, three SET NULL — and
PostgreSQL executes a referential action with the **constraint owner's** privileges — which is how
the erasure removes rows from tables `prl_app` holds no DELETE on, without ever granting it
(`users.ts:391-403`). The audit row for the deletion is written with `user_id` NULL from the start,
so the log never briefly points at an account that asked to stop existing
(`apps/api/src/routes/auth.ts:707-713`).

### 3.2 What deletion does NOT reach

1. **Hand history.** Retained in full. Not merely policy: `prl_app` holds **no DELETE privilege at
   all** on `prl.hands`, `prl.hand_seats` or `prl.hand_actions` (`0001_initial.sql:945-950`).
2. **The departed learner's hole cards.** They remain in `hand_seats.hole_cards` with `user_id`
   NULL. No API viewer can read them (the SQL requires `showed_down` or a matching viewer, and NULL
   matches nobody — `apps/api/src/repositories/hands.ts:764-767,730`), but `prl_backup`,
   `prl_migrator` and the superuser can, and they are in every backup.
3. **Backups.** Not touched, not rewritten, not rewritable. Up to ~6 months.
4. **The application log.** Lines are keyed-HMAC only, but they are not deleted.
5. **The proxy access log.** No longer contains the raw IP or the full user agent — a /24 and a
   user-agent class. Still not deleted on request, and a /24 plus a timestamp is not nothing; it is
   now bounded at 10 MiB × 5 files rather than growing forever. See §4 D2.
6. **Metrics.** Nothing to reach — no identifiers exist there.
7. **`prl.audit_log` rows.** Detached, never removed.
8. **The identity provider.** Outside this system entirely.
9. **The audit rows written when a place in a course was granted and withdrawn.** Detached, never
   removed, and a grant's `detail` carries the external `reference` an operator typed
   (`apps/api/src/repositories/enrolments.ts:516-523`). So after an erasure the operator can still
   see that on a date, on an authority, against that reference, a place was granted and later ended
   — with nobody named. Deliberate and defensible; also a thing a reader must be told, and
   `/privacy` §2 and §6 now tell them.

### 3.3 There is no data-export path, and for a paying user that is a gap

The complete route inventory contains no export endpoint. The closest thing is
`GET /me/progress` (`apps/api/src/routes/progress.ts:97`), which returns progress only — not the
account row, not sessions, not memberships, not hand history in a portable form, not audit entries.
The word "portability" appears in this repository exactly twice, both times inside a question for
counsel (`apps/web/src/lib/legal-config.ts`, `data-controller-and-rights`;
`legal-review-requirements.md` entry 6).

Stated plainly: **a paying student who asks for a copy of their data can be given one only by an
operator running SQL by hand.** Whether that is required is L4/L6; that it does not exist is fact.
Scoped fix at §7 E1.

---

## 4. Defects found

Ordered by how much they matter. D1, D2 and D4 were found by this review.

### D1 — The shipped terms told a reader with a place in a course that the service is free

**Fixed, and no legal question was answered doing it.**

`/terms` §7 read: *"This service is provided free of charge and with no promise that it will be
available, that your data will survive, or that any particular feature will continue to exist. It
may be taken down, reset or changed at any time by whoever runs it."*

**The clause was load-bearing on being free.** Every promise it withheld was withheld on the basis
of the first six words. Reasonable to somebody who paid nothing; indefensible to somebody who paid
for a course. And the obvious repair — swapping "free of charge" for "for a fee" — would have been
worse than the contradiction, because it leaves a document promising a paying student nothing at all
and looking deliberate about it. It would also have asserted the fee, which §1's correction shows
this system cannot establish.

`apps/web/test/legal-pages.test.ts` fired on `prl.enrolments` when 0006 landed, which is what it was
built for.

**What was done, 2026-08-25.** The clause was split along the line between what the software *is*
and what the operator *owes*, and only the first half was written by engineers.

* **`/terms` §7 — "What access to this costs, and what the software records about it"** — factual,
  and every sentence checkable against `db/migrations/0006_cohort_enrolments.sql`: that this software
  cannot take money and cannot tell whether a reader paid; that no column in its database can hold an
  amount, a currency or a price; what an enrolment record contains; that a withdrawal is written down
  rather than erased; that a place ends when the cohort's own period ends; and — the sentence the
  whole rewrite turns on — that **an enrolment record is not evidence that money changed hands**,
  because a scholarship group, a class of employees and a paid course produce identical rows and the
  `reference` may be the word `scholarship`.
* **`/terms` §8 — "Availability"** — keeps the technical half of the old clause, which was always
  true and is a description of how the thing is built rather than a term somebody chose, and then
  says outright that it does **not** settle whether the operator may exercise any of it without
  owing the reader something.
* **Two new entries in `COUNSEL_CLAUSES`** carry the commercial halves to a lawyer instead of
  asserting them: `enrolment-and-fees` on §7 (L10) and `refunds-and-cancellation` on §8 (L11). Both
  are rendered on the page with `COUNSEL_MARKER` and both are entries 10 and 11 of
  `legal-review-requirements.md`, so the three cannot drift.
* **The premise inside `liability-and-warranty` was withdrawn, not answered** — see L8.
* `LEGAL_REVISION` moved to `0.2-draft` and `LEGAL_DRAFTED_ON` to 2026-08-25, because §12 of the
  terms promises a reader that the revision changes when the text does and that line is the whole of
  the notification mechanism this product has.

**Nothing here closes L10 or L11.** What closed is a false sentence shipping to a reader. The
replacement states facts and marks the decisions; it does not make them.

`/privacy` was also wrong in the same direction and is fixed: it now carries `prl.cohorts` and
`prl.enrolments` in the inventory, says what an enrolment holds, that nothing sweeps it, that
account deletion removes it, and that the audit rows about it survive detached (§2.9, §3).

### D2 — The reverse proxy logged raw IP addresses, full user agents and OIDC authorization codes — **fixed**

Both shipped nginx configurations used the stock `combined` format:

* `deploy/staging/nginx.conf:128` — `access_log /dev/stdout combined;`
* `docker-compose.yml:423` — `access_log /dev/stdout combined;`

`combined` is `$remote_addr - $remote_user [$time_local] "$request" $status $body_bytes_sent
"$http_referer" "$http_user_agent"`. So every request produced a line carrying the **raw client IP**,
the **full user agent**, the **complete request line including the query string**, and the referer.

The API goes to real trouble to prevent exactly this. `queryKeysOf`
(`apps/api/src/logging.ts:139-153`) exists so that query **names** are logged and values are not,
specifically so an OIDC authorization code never enters a log; `clientKeyFor`
(`apps/api/src/plugins/request-context.ts:96-102`) exists so that an address is a keyed HMAC and not
an address. **Both controls were bypassed one hop upstream.** `/api/v1/auth/oidc/callback`
(`apps/api/src/routes/auth.ts:681`, prefix `apps/api/src/app.ts:65`) is proxied through
`location /api/`, so the authorization `code` and `state` landed in the access log in the clear.

#### It was measured, not inferred

A throwaway nginx container (its own compose project, its own ports, no contact with any running
stack) was given each config verbatim and sent
`GET /api/v1/auth/oidc/callback?code=SENTINELCODE123&state=SENTINELSTATE456`. With the **old**
configs the sentinel appeared in **both** logs, on **both** files:

```
access log  172.22.0.1 - - [25/Aug/2026:07:50:49 +0000] "GET /api/v1/auth/oidc/callback?
            code=SENTINELCODE123&state=SENTINELSTATE456 HTTP/2.0" 502 150 "-" "curl/8.7.1"
error  log  2026/08/25 07:50:49 [error] 7#7: *3 api could not be resolved (3: Host not found),
            client: 172.22.0.1, server: _, request: "GET /api/v1/auth/oidc/callback?code=
            SENTINELCODE123&state=SENTINELSTATE456 HTTP/2.0", host: "127.0.0.1:18443"
```

The **error log** line is the half that is easy to miss and impossible to fix with `log_format`:
`ngx_http_log_error` appends `request: "<full request line>"` to its own messages, at any level, in
a shape no directive in the file controls. A fix that changed only the access log would have tested
clean and changed nothing.

#### What was changed

* A `log_format prl_privacy` in both files, using **`$uri`** — the path with the query string
  already gone — and never `$request` or `$request_uri`. `$is_args` records *whether* there was a
  query string, which is as near as nginx core gets to the API's `queryKeysOf` compromise.
* The client address is **truncated**, not dropped and not raw: `/24` for IPv4, `/48` for IPv6, and
  an address whose shape cannot be truncated confidently (a compressed IPv6 literal) logs as `ip6`
  and nothing more. It is not dropped because when the API is the thing that is down, this log is
  the only place that can answer "one caller or a thousand". **Be as honest about this as
  `request-context.ts` is about its own hash: a /24 is reduction, not anonymisation, and it is a
  weaker property than the keyed HMAC the API stores.** nginx has no HMAC.
* The user agent is **classed** (`browser`/`tool`/`bot`/`none`), not logged. `$http_referer` is gone
  outright: a Referer is somebody else's URL and can carry somebody else's token.
* Upstream diagnostics (`$upstream_addr`, `$upstream_status`, `$upstream_response_time`) replace
  what the error log used to give an operator, and `$upstream_http_x_request_id` — the API's **own**
  request id, read back off its response — joins a proxy line to an application line without the
  proxy forging or trusting a correlation id (`requestIdHeader: false`: the API refuses an inbound
  one).
* `error_log` is at **`crit`** in both files. That removes every message class nginx emits with a
  request line during normal operation; `[emerg]`/`[alert]` still print, so a bind or config failure
  is still loud. `crit` is a reduction and **not a proof** — a genuine `[crit]` such as `open()
  failed (13: Permission denied) while reading upstream` would still carry the request line — so the
  one path where a query-string value is a credential *by construction* has its own
  `location = /api/v1/auth/oidc/callback` with `error_log /dev/null crit;`.
* `proxy_intercept_errors off` is now stated rather than assumed: on, an upstream 4xx/5xx becomes an
  internal redirect through nginx's own `error_page`, which re-enters the request with a rewritten
  `$uri` and another opportunity to log it.
* A `logging:` block on **every service in all three compose files** — not only the proxy, which
  was never the worst of it. There was no `logging:` block anywhere in the repository before this,
  so there was no existing shape to match. The sizes are per service with the reason beside each
  and the canonical argument in `docker-compose.yml`'s header: api 20m × 5 (highest-volume writer,
  and the log an incident is reconstructed from), proxy 10m × 5, postgres / web / prometheus /
  alertmanager 10m × 3. Postgres is the interesting one — near-silent today because this stack sets
  no `log_min_duration_statement`, and two orders of magnitude louder the afternoon somebody sets
  one to chase a slow query and forgets. See §2.11 for why there is no logrotate and why a size cap
  is not a retention period.

Re-run against the same throwaway container, the same request produced, on both configs:

```
access log  2026-08-25T07:54:18+00:00 172.22.0.0/24 tool "GET /api/v1/auth/oidc/callback?"
            502 150 rt=0.006 up=- us=- urt=- rid=-
error  log  (empty)
```

`0` lines matching the sentinels in the access log and `0` in the error log, on both files, and
`nginx -t` clean on both. With a working upstream the same line reads `… up=172.22.0.2:3001 us=200
urt=0.001 rid=<the API's request id>`, so the diagnostic value is real rather than asserted.

#### What is still open

The disk-exhaustion half is closed. **What a size cap cannot do is implement a retention period**,
and this document must not let one be mistaken for the other — §2.11 says so at length and §7 E12
carries the remaining item.

#### The gate

`scripts/supply-chain/log-policy.mjs` (`pnpm run security:logs`, and a gate inside
`pnpm run security:audit`) reads both nginx configs and all three compose files, and fails on any
of: a stock access-log format, an `access_log` with no format at all (which *is* `combined`), a
`log_format` naming a variable that can carry a secret or an address, an `error_log` level looser
than `crit`, a missing or drifted OIDC callback block, `proxy_intercept_errors` unstated or on,
**any service in any compose file with no log cap**, a cap that names a driver other than
`json-file` (including `none`, which bounds the disk by destroying the log), a `max-size` Docker
would refuse, and a service capped differently in two files that both define it.

Two properties of it are load-bearing and were checked by breaking them. Compose **services are
enumerated from the files, never listed by name** — the service that matters is the one added next
month, which will arrive with no `logging:` block, and a gate that knew only today's names would
pass it in silence. And exemptions are **explicit**: `EXEMPT_SERVICES` is empty, documents what
would justify an entry, and is asserted empty by a test, so a service can never leave the gate's
scope by quietly disappearing from a list. Every rule has a negative control that mutates the real
shipped text — including one per service, removing each cap in turn — so a revert cannot be green.

`/privacy` §4 described only the application log and would have read, to a regulator or a student,
as a promise the whole system does not keep. **The page was fixed** (see §6) and the configuration
now matches what it says.

### D3 — `security.md` omits the widest reader in the system

`docs/production/security.md:164-170` says *"Three roles, and the separation is the control"* and
then prints a table with **two** rows. Neither is `prl_backup`, which holds `pg_read_all_data` —
every row of every table, including `hand_seats.hole_cards` — plus `CREATEDB` and membership of
`prl_migrator` (`deploy/backup/README.md:61-64`). A least-privilege section that omits the broadest
privilege is worse than one that says nothing. E3.

### D4 — The guest sweep was documented in four places and implemented in none — **now implemented**

**The finding, as it stood.** `db/migrations/0001_initial.sql:916` justifies granting `prl_app`
DELETE on `prl.users` partly for a *"guest sweep"*; `0004_account_deletion.sql:94` quotes it;
`0002_indexes_and_constraints.sql:51-55` builds an index **specifically for it** (*"Guest reaping:
which guest accounts have not been seen since <cutoff>?"*); and `apps/api/src/auth/session.ts`
documents `touchLastSeen` as *"Keeps an active learner out of the guest-account sweep."*

`touchLastSeen` was implemented and called. **Nothing consumed it.** The sweep removed
`prl.sessions` and `prl.oidc_login_attempts` and nothing else. So abandoned guest accounts —
created automatically for every visitor who opens a lesson, with a display name and whatever
progress they made — were retained indefinitely, and a DELETE privilege had been widened for a
sweep that did not exist.

**What was done, 2026-08-25.** The sweep is implemented in
`apps/api/src/maintenance/retention-sweep.ts` and runs on the existing six-hourly schedule, against
the index that was built for it. Three things about it matter to this document.

*It erases through the same path as `POST /me/delete`.* Candidates go through `deleteAccount`
(§3.1), one transaction each — so the policy in `db/migrations/0004_account_deletion.sql` exists in
one place, and every erasure carries the same self-verification: the nine tables naming the learner
are counted before and after inside the transaction, and anything left behind rolls the erasure back
rather than committing a partial one. An unattended timer is exactly where that check earns its
cost.

*"Abandoned" is read from the database, not from a clock.* The sweep never removes an account that
holds a live session, a room membership, a seat in any hand, or a room of its own — **at any age**.
The predicate is re-evaluated inside the deleting transaction under `FOR UPDATE`, which conflicts
with the `FOR KEY SHARE` any INSERT referencing that row must take, so an account cannot become live
between being chosen and being erased. Deleting a learner mid-hand would be a far worse defect than
retaining a dead row, and the guard is a lock rather than an argument about timestamps. Note in
particular what this leaves alone: a guest who ever sat at a table keeps their account, because
erasing one would blank a name in a hand four other people played — and whether hand history may be
deleted rather than detached is L5's question, not an unattended timer's.

**The period, and the finding inside the finding. None of the four places states one.** They agree
on the mechanism and on the column and are silent on the number — the index comment writes it as the
placeholder `<cutoff>`, and this register's own E5 said only "the cutoff is L5". There was therefore
no specification to implement, and L5 is open. So the number is **derived rather than chosen**: a
guest account has no email, no password and no federated identity — there is no column that could
hold one — so its only credential is a session cookie and there is no recovery path of any kind. A
session cannot outlive `SESSION_ABSOLUTE_TTL_SECONDS` (60 days) from creation, a ceiling `/privacy`
§5 already publishes. **Sixty days unseen is therefore the smallest period after which every cookie
that could ever have reached the account is dead and no new one can be minted for it.** Shorter
would delete accounts whose owners could still return, which is L5's decision to make; longer keeps
rows that are provably unreachable, which is the defect. It is written as the constant rather than
as a literal, and a test fails if the two ever disagree.

**This was recorded as a live inaccuracy on `/privacy`, and it is CLOSED — corrected 2026-08-26.**
The entry used to say that §5 still promised "until you delete your account" with no sixty-day
exception. `apps/web/src/app/privacy/page.tsx` now reads "…is kept until you delete your account,
**with one exception described next**", and states the sixty-day guest rule and the five conditions
under it; `apps/web/test/legal-pages.test.ts` fails the build if that sentence goes. E11 below is
done. Left here rather than deleted because a register that quietly drops an entry gives counsel no
way to tell a resolved question from one nobody asked.

**Observability.** `prl_retention_rows_deleted_total{kind}` counts what went, primed at zero. The
harder half is that a sweep which silently stops running is invisible: "removed nothing" and "did
not run" are the same flat counter, which is the shape L5 calls the one where "nothing fails, data
simply persists". So the sweep also exports `prl_retention_sweep_age_seconds`, alerted on by
`RetentionSweepStalled` with `runbooks/retention-sweep-stalled.md`.

**The four documentation sites were not edited, and that is deliberate.** Three of them are inside
applied migrations, and `apps/api/scripts/migrate.mjs` records a sha256 of every file it applies and
**aborts on a mismatch** — so editing a comment in `0001`, `0002` or `0004` would stop migrations on
every deployment that has already run them. It is also unnecessary: none of the four was wrong. They
described a sweep that did not exist yet, and they are now simply true. The two TypeScript sites
(`auth/session.ts`, `repositories/users.ts`) were extended to name the consumer, which a migration
comment cannot do.

### D5 — `prl.room_ownership` was not in the inventory

`db/migrations/0005_room_ownership.sql` landed during this review and
`apps/web/test/legal-pages.test.ts` correctly failed: every table in `db/migrations` must be accounted for on
`/privacy`. **Fixed** — the
table holds no personal data and now says so. This is the coupling test working exactly as intended.

### D6 — Retention periods on `/privacy` disagreed with the code

The page said *"A session lasts fourteen days from when it was issued."* Fourteen days
(`sessions.ts:41`) is the **idle** window; `extendExpiry` slides it forward on every visit past the
halfway point (`sessions.ts:251-272`, `auth/session.ts:83`), bounded by `SESSION_ABSOLUTE_TTL_SECONDS`
= **60 days from `created_at`** (`auth/session.ts:75`). A learner visiting weekly held one session
row for **more than four times** as long as the page claimed, and the ceiling appeared nowhere. Two
smaller errors sat beside it: a sign-in attempt row was described as existing for ten minutes when
ten minutes is when it stops *working* and the sweep is what removes it (up to ~6 h later), and §6
described deletion without mentioning backups. **All fixed, and now mechanically coupled** — see §6.

### D7 — Minor: guardrail-forbidden wording on `/record`

`docs/PRODUCT-GUARDRAILS.md:27` forbids the word "balance" on user-facing surfaces.
`apps/web/src/app/record/page.tsx:82` reads *"Resetting them puts your balance back to the starting
amount"*. The very next paragraph says the net figure is *"a sum over those hands rather than a
balance"*, so the intent is plainly benign — but the banned word is doing exactly the job the
guardrail bans it for, on the page about resetting units. Not a payment path. Copy fix, E7.

### D8 — Minor: identifiers in log lines that no redaction rule matches

Three keys reach log lines and match neither `SENSITIVE_KEY_PATTERN` nor `EXPLICIT_SENSITIVE_KEYS`:
`users: stuck` — an array of **account ids** (`apps/api/src/rooms/registry.ts:492-497`, consumed at
`apps/api/src/routes/index.ts:104`); `rateLimitKey` — a session- or address-derived HMAC
(`apps/api/src/plugins/security.ts:818`); and caller-supplied poker notation that can reach a line
verbatim as `err.message`, because `err` is a serialized key the recursive scrub steps over
(`apps/api/src/workers/pool.ts:655-657`, `logging.ts:222-224,318`; messages from
`packages/poker-math/src/ranges.ts:297,318`). Room ids, hand ids and seat indices are logged by
design and are pseudonymous but joinable. E6.

### D9 — The abandoned-guest sweep and a live entitlement — **checked; the clause is there**

**Recorded as a check rather than a defect, because the timing matters and a register that says
"found a bug" about a state nobody shipped is not worth having.**

The sweep erases a guest account sixty days after it was last seen, *provided the account is provably
dead*. "Provably dead" is `abandonedGuestPredicate` in `apps/api/src/repositories/users.ts`. When
0006 landed it read: no live session, no `prl.room_members` row, no `prl.hand_seats` row, no owned
room — **four facts, none of them an enrolment.** `prl.enrolments.user_id` is `ON DELETE CASCADE`
(`0006:269-270`), so an account taken by the sweep takes its enrolments with it.

**Why that would have been the worst thing in this document.** The sequence is ordinary, and 0006
anticipates its first half itself: `starts_at` "exists so that a class can be enrolled in advance of
the day it opens" (`:72-73`). Enrol a January cohort for a course opening in April; a student who was
given a guest account by visiting once and did not come back is erased in March, three weeks before
their course begins, along with the record that they were admitted to it. `granted_by` and
`reference` survive in `prl.audit_log` with `user_id` NULL, so the *operator's* history is intact —
and the entitlement is gone and cannot be reconstructed, because nothing left names the person. The
derivation that justifies sixty days ("every credential that could reach this account is already
dead", D4) is sound about the *account* and says nothing about whether a third party's record of it
may be destroyed.

**Verified 2026-08-25, after the enrolment work settled:** the clause is present.

```
$ grep -c "not exists (select 1 from prl" apps/api/src/repositories/users.ts
4
    and not exists (select 1 from prl.enrolments  e where e.user_id = u.id)
```

`accountFootprint` also counts the enrolment table, so the erasure's self-verification covers it
(nine `count(*) from prl.` subqueries, not eight).

**One thing for counsel, and it is not closed by the clause being there.** The predicate is the
**broad** form — *any* enrolment protects the account, including one revoked two years ago. That is
the safe direction (keeping a row nobody needs costs a row; erasing a student before their course
costs the student), and whether it is the *right* direction is **L5's question, not an engineer's**:
an account whose only enrolment was revoked long ago is arguably as dead as one that never had one,
and narrowing the clause to unrevoked-and-unexpired is a retention decision, not a tidy-up.

**And the page had to learn it, which is now mechanical.** `/privacy` §5 listed the four things that
protect an account from the sweep and would have gone on listing four. It now names the fifth, and
`legal-pages.test.ts` **enumerates the tables `abandonedGuestPredicate` consults and requires a
sentence on the page for each one** — counted, never named, because the failure mode is a clause
being *added* and the page not following, and a test that knew today's four would have passed over
the fifth in silence. Demonstrated by deleting the sentence from the page: *"/privacy must say that
prl.enrolments protects an account"*. E13, done.

### D10 — `/privacy` §4 described a leak that had already been fixed — **fixed**

The page said the reverse proxy "writes a conventional access log: one line per request carrying
your *raw* IP address, your *full* User-Agent string, the complete request line including anything
in the query string, and the page you came from", and that a federated sign-in's parameters were in
it. That was true of `combined` and it is **not true of what ships**: both configurations were
rewritten in the same commit as the paragraph (`deploy/staging/nginx.conf:237-266`,
`docker-compose.yml:591-626`) — `$uri` rather than `$request`, the client address mapped to a /24 or
a /48, the user agent reduced to a class, no `$http_referer`, `error_log crit`, and `/dev/null` on
the OIDC callback. D2 above records the measurement.

This document said "**The page was fixed** (see §6)" and §6 said the paragraph had been *added*.
Both were true of the paragraph and neither noticed that the paragraph then described the old
configuration. So the register asserted a fix that its own page text contradicted, which is the
failure mode a register is supposed to make impossible.

Overstating an exposure sounds harmless. It is not: a policy that describes a worse system than the
one running teaches its reader that it was not written from the code, and the next error — in the
other direction — inherits that credence. §4 now describes `prl_privacy`, and says in as many words
that a network prefix is *reduction* and not anonymisation, which is a weaker property than the
keyed HMAC the application stores.

---

## 5. The register

Each entry: **(a)** the question · **(b)** the verified facts it rests on · **(c)** what the code
does today · **(d)** what changes for each plausible answer · **(e)** blast radius of getting it
wrong.

### L1 · `operator-identity` — who operates this deployment

**(a)** Which legal entity operates this instance, where is it established, and what identification
and contact details must appear on these pages for that entity in each place it serves readers?
**With a fee being charged, does that entity also have to identify itself as the seller, and does
that change the required details?**

**(b)** The software is open source and runnable by anyone. Pages render `PRL_LEGAL_OPERATOR` and
`PRL_LEGAL_CONTACT` from the server environment, never from a build-time constant, so one image
serves every deployer (`apps/web/src/lib/legal-config.ts`, `readLegalDeployment`). Unset renders a
visible
"not supplied by this deployment" marker rather than a plausible default (`:19-21`).

**(c)** Unset. Both variables are commented placeholders in `.env.example:411-412`. Every reader
today sees the gap marker.

**(d)** Any answer is two environment variables plus a redeploy. If counsel requires a registered
number, address or VAT identifier, that is either more variables or a rewritten `<dl>` block in
the `prl-legal__meta` block on `/terms` and on `/privacy`.

**(e)** Low if answered, total if not: a paid course sold by a party who does not identify itself is
the failure mode that makes every other clause unenforceable and every contact obligation unmet.

### L2 · `age-threshold` — the minimum age, and whether one is needed

**(a)** Is a minimum age required for a play-money poker simulator in each place this is offered?
If so, what is it, and is an **unverified self-declaration** sufficient? **Does charging a fee, or
onboarding students who may be minors, change the answer?**

**(b)** — verified against `apps/web/src/lib/age-gate.ts`:

* **The gate ships OFF.** `PRL_AGE_GATE` is `off` in `.env.example:386`; unset means "nobody has
  decided", which the pages render as an unmissable notice (`age-gate.ts:141-142,212-239`).
* Threshold 13–25, default 18, **clamped into range rather than replaced** so a typo cannot weaken
  a control (`:107,118-119,286-292`). Every unreadable value resolves to the **stricter** reading —
  an unrecognised mode shows the gate, an unrecognised scope covers the whole site (`:241-247`).
* **It verifies nothing and stores no date of birth. There is no column in the schema that could
  hold one** (`:25-29`). The declaration is a cookie whose **value is the threshold declared
  against**, not a flag — so raising 18 to 21 re-asks, where a boolean would have carried every
  existing reader past the new number (`:334-338`). It lasts **180 days** (`:96`).
* A reader who declares under-age is **not locked out and not recorded** (`:31-34`).
* **`/terms`, `/privacy`, `/responsible-use` and `/age-check` are never gated at any scope**
  (`:154-160`) — a privacy policy readable only by people who already answered a question about
  themselves is not a privacy policy.
* **The scope named `play` covers `/play` and nothing else** (`:163`). It does **not** cover
  `/lab` (the Scenario Lab — simulated poker decisions), `/review` or `/legends`. Counsel should
  know this: "the simulated tables only" is accurate about `/play` and does not describe every
  surface on which a reader makes a poker decision. `site` scope covers everything but the four
  paths above.
* `test:age-gate` is release gate eleven of fourteen (`package.json`, `verify` script) and is the
  only check that exercises the gate switched **on**. It found a real defect: with the gate on,
  clicking "Play" in the header went straight to the tables every time, because the proxy decided
  in-app navigation by reading a header Next deletes before middleware runs
  (`legal-review-requirements.md:298-312`). Fixed.

**(c)** No gate. Pages say nobody has decided.

**(d)** *No gate required* → leave as shipped; the notice stays honest. *A threshold* → set three or
four variables; note the browser harnesses need `PRL_AGE_GATE=off` in their environment or they
audit the interstitial (`age-gate.ts:237-239`). *Self-declaration insufficient* → this is not a
configuration change. It means collecting identity documents, which is a far larger privacy exposure
than the thing it protects against and needs its own threat-model review (`:25-29`). *Gate must
cover every poker surface* → widen `AGE_GATE_PLAY_PREFIXES` at `age-gate.ts:163` or choose `site`.

**(e)** High. This is the entry most likely to be read as an assertion about law by a deployer who
reads nothing else, which is why the shipped default asserts nothing.

### L3 · `play-money-classification` — is this regulated anywhere

**(a)** Does a product with no stake, no purchase of play, no prize and no cash-out fall within any
gambling, lottery, skill-gaming or advertising regime where it is offered? **Does charging for the
surrounding course change that analysis?**

**(b)** Every fact is enforced mechanically, not by convention:

* No payment path exists at all — §1, with the search that establishes it.
* **No column anywhere in the schema could hold a balance of money**
  (`db/migrations/0001_initial.sql:4-9`), and no endpoint transfers a unit between accounts.
* Units are free and resettable unconditionally, never penalised, no cooldown
  (`apps/api/src/routes/auth.ts:628-637`).
* Tables are invite-only, enforced by a `CHECK` with a single allowed value
  (`0001_initial.sql:403-404`), so there is no public lobby and no matchmaking between strangers;
  turning it on requires a migration.
* No advertising, no affiliate or referral link, no gambling operator anywhere. The CSP has no host
  for a third party (`apps/web/src/lib/csp.ts:79,136`).
* Content is policed by an automated phrase blocklist that fails the build on "real money",
  "cash out", "withdraw", "deposit", a currency symbol or a daily-bonus/streak framing
  (`packages/content/test/scenarios.test.ts:259-274`), and the UI cannot render a bare number
  without the word "units" (`packages/ui/src/format.ts:180-198`).
* The product refuses the mechanics that make gambling products what they are: no score, no streak,
  no leaderboard, no daily reward — and **no column any of them could be stored in**
  (`0001_initial.sql:781-783`, `docs/PRODUCT-GUARDRAILS.md:37-58`).

**(c)** All of the above is true today and is checked by tests that would fail if it stopped being.

**(d)** *Outside every regime* → nothing changes. *Inside one somewhere* → this is not a code change
first; it is a decision about where the deployment is offered. *A fee makes it a regulated sale of a
gambling-adjacent service* → a commercial decision about what the fee buys, not an engineering one.

**(e)** The highest of any entry. `docs/THREAT-MODEL.md:408` records that the absence of financial
motive is what lets collusion and bot-farming be rated low severity — so a change here invalidates
security ratings as well as legal ones.

### L4 · `data-controller-and-rights` — controller, lawful basis, rights

**(a)** Who is the controller of everything in §2, on what lawful basis is each category processed,
and which statutory rights — access, rectification, erasure, **portability**, objection — must be
offered to whom? **Does taking a fee change the basis for any category from whatever it is today?**

**(b)** §2 is the inventory and it is checked against the schema by
`apps/web/test/legal-pages.test.ts`, which fails if a migration adds a table `/privacy` does not
account for — it fired during this review (D5). Note in particular: an account is created for a
visitor **automatically**, on opening a lesson, without being asked for anything
(`apps/web/src/app/privacy/page.tsx` §1). Rectification of a display name exists (rename). **Access
and portability do not exist as a product feature at all** — §3.3.

**(c)** Erasure: implemented and self-verifying. Rectification: partial. Access/portability: absent.
Objection: no mechanism.

**(d)** *Portability required* → E1, a scoped export endpoint. *Rectification beyond a display name*
→ nothing else is learner-editable. *A basis requiring consent for any category* → there is no
consent mechanism anywhere in this product and adding one is real work.

**(e)** High and rising: a paying student is far likelier to exercise a right than an anonymous
visitor, and the operator currently has no tool but manual SQL.

### L5 · `retention-and-deletion` — the periods, and what erasure must remove

**(a)** How long may each category be kept, and does erasure require hand history to be **deleted**
rather than **detached**? **How long may backups keep an erased learner's rows?** **How long may the
proxy access log keep raw addresses?**

**(b)** The full implemented picture is §2.12 — including that the page **understated** the session
period until this change (D6), that **abandoned guest accounts are now erased after sixty days unseen** (D4), that
**backups hold erased rows for up to ~6 months** and that **the proxy log has no retention at all**
(D2). Deleting hand history is not a policy toggle: `prl_app` holds **no DELETE privilege** on
`prl.hands`, `prl.hand_seats` or `prl.hand_actions` (`0001_initial.sql:945-950`), and the grant is
withheld on purpose — `prl.hands` cascades from `prl.rooms` and `prl.hand_actions` is append-only
("a role that can edit the audit log has no audit log", `:930-931`).

**(c)** Sessions and sign-in attempts are swept every 6 h. Nothing else is ever swept. Erasure
detaches hand history and keeps it.

**(d)** *Detachment is sufficient* → nothing changes. *Hand history must be deleted* → a migration,
a change to the least-privilege grants, **and a decision about the other four players in each
hand**, whose history it also is (`0004_account_deletion.sql:30-32`). *Guest accounts must expire* →
done (E5), on a period DERIVED from the session ceiling because no document states one;
answering L5 with a different number changes one constant. *Backups must not outlive erasure* → the honest options are shortening
the policy at `scripts/backup.mjs:188-190` or a documented re-erasure step after a restore; an
archive cannot be edited without destroying the property that makes it trustworthy.

**(e)** High. This is where a wrong answer is invisible: nothing fails, data simply persists.

### L6 · `international-transfer` — where it sits and who can reach it

**(a)** In which country do the database and backups run, who administers them, and what mechanism
or disclosure does that require? **Who administers the backup host, given the role it holds?**

**(b)** The application makes **no outbound connection** other than to its own database and, if
configured, an OIDC provider — no analytics, no error reporting, no CDN, no remote font; the CSP has
no host for any of them (`apps/web/src/lib/csp.ts:79,136`). Reach is the table at §2.10, and
**`prl_backup` holds `pg_read_all_data`** (`deploy/backup/README.md:62`). `PRL_LEGAL_HOSTING_REGION`
is what the page displays.

**(c)** Unset (`.env.example:414`).

**(d)** One variable, plus whatever the answer requires of the hosting arrangement itself.

**(e)** Moderate, and it depends entirely on where students are.

### L7 · `governing-law` — law and forum

**(a)** Which law governs, which forum hears a dispute, and does that choice survive against a
consumer resident elsewhere? **A fee makes every student a consumer with a contract, so this stops
being theoretical.**

**(b)** The page displays `PRL_LEGAL_GOVERNING_LAW` and nothing else. **There is no arbitration
clause, no class-action waiver and no forum selection in the shipped text**, because writing one
would be the conclusion this process exists to refuse (`legal-review-requirements.md:104-106`).

**(c)** Unset. `/terms` §11 is a bare marker and nothing else.

**(d)** Real prose, replacing the marker and removing the clause from `COUNSEL_CLAUSES` — the two
are coupled, so neither can be done alone (`legal-review-requirements.md:26-30`).

**(e)** High once money changes hands.

### L8 · `liability-and-warranty` — disclaimer and limitation

**(a)** What may this deployment lawfully disclaim and limit? **The premise has been withdrawn, not
answered.** The question in the code used to end "…and that the software is offered free of charge".
That premise is not one this software can establish any more (§1), so it was removed rather than
replaced with the opposite: **counsel must answer for a deployment that charges and one that does
not, because the code cannot distinguish them.**

**(b)** Shipped text says only that the software is provided as it is and the authors make no
warranty; **no cap, no exclusion list, no indemnity** (`/terms` §9). The `LICENSE` covers the
software, not the service a deployer offers. `/terms` §8 still disclaims availability *and data
survival* — but no longer *on the basis that the service is free*, and it now says outright that
whether the operator may exercise any of it without owing the reader something is not settled there.

**(c)** Minimal disclaimer, premise withdrawn, no limitation of liability at all. The clause a
lawyer has to replace is one paragraph and one `CounselFlag`, both in **§9 (Liability)** — this read
"§8" until 2026-08-26, and §8 is Availability, which carries a different clause (L11).

**(d)** Any answer is prose replacing that paragraph, plus removing `liability-and-warranty` from
`COUNSEL_CLAUSES`. **Done, 2026-08-25:** the free-of-charge premise is out of the question text
(`apps/web/src/lib/legal-config.ts`, `liability-and-warranty`), with the reason recorded beside it.

**(e)** High. A broad exclusion drafted against consumers who paid is the classic unenforceable
clause, and "your data may not survive" reads very differently to someone holding a receipt.

### L9 · `ai-legend-naming` — name, image and likeness

**(a)** May this deployment display the attributed names in `packages/poker-ai`, on what permission?
**Does selling a course that features them change the permission needed?**

**(b)** Profiles are sixteen-axis numeric trait vectors, not simulations of real people, built from
publicly discussed general tendencies and not from anyone's hand histories. Educational content is
**byte-identical** in both naming modes — only identity fields change. `assertNoImpersonation()`
runs over every learner-facing string at load and over every generated commentary string, and
`ModelReasoning` has no field capable of holding a mental state. Disclaimers are structured data:
there is no code path producing a profile card without them. Some subjects are dead, which changes
nothing. (`legal-review-requirements.md` entry 9, `ai-legend-naming` — this cited `:238-259`, which is
entry 10, `enrolment-and-fees`; `docs/AI-LEGENDS.md`.)

**(c)** **`PRL_LEGEND_NAMING` is unset and must stay unset** until this is answered in writing.
Unset resolves to `archetype` — generic style names only — and ADR 0011 makes the safe mode the
default precisely so a deployer who never reads this cannot ship attributed names by accident
(`.env.example:431`).

**(d)** *No* → leave unset for ever. *Yes, with permission* → one variable, and the further
attributed-mode disclaimer already exists.

**(e)** High, and commercial use raises it: a fee turns "an educational project displays a name" into
"a paid product features a name".

### L10 · `enrolment-and-fees` — what an enrolment is, and what was sold

**NOW MARKED ON `/terms` §7.**

*Renamed from `paid-course-terms`. The old slug asserted the fee, which §1's correction shows this
system cannot establish; the entry number is unchanged so an answer can still cite "L10".*
`enrolment-and-fees` is now a live clause id in `COUNSEL_CLAUSES`, rendered on `/terms` §7 with
`COUNSEL_MARKER`, and entry 10 of `legal-review-requirements.md`. **The finding that it had no page
marker is closed. The question is not.**

**(a)** What exactly does a student get, and what — if anything — has the operator sold? Which
contract terms and pre-contract disclosures must be presented **before** any sale, on which page and
by whom? Do terms displayed here bind a purchase completed somewhere this software cannot see? And
**does the answer differ for a cohort enrolled for nothing**, since the record is identical?

**(b)** — all verified against `db/migrations/0006_cohort_enrolments.sql` (§2.9):

* **There is still no code that takes money**, and `apps/web/test/legal-pages.test.ts` fails the
  build on a dependency, a table name or a source file that changes that — in every posture the page
  can be in. Recording entitlement did not widen that detector by one word.
* **An enrolment records THAT somebody is entitled and WHO SAID SO**, never what anything cost. The
  `reference` is opaque and may be the word `scholarship` (`:32-37`, `:333-335`).
* Entitlement is the intersection of the enrolment's window and the cohort's (`:83-99`), so a cohort
  that has ended entitles nobody however its enrolments are written.
* **There is no privileged HTTP surface.** `prl_app` holds `SELECT` and nothing else on both tables
  (`:387-388`); enrolment is an operator command connecting as the migrating identity
  (`apps/api/scripts/enrolments.mjs`), unreachable from any handler (`:143-162`).
* **Nothing is gated on entitlement yet.** Every account is still created automatically for any
  visitor, and no route consults `prl.enrolments` to decide what a reader may see. An enrolled
  reader and an unenrolled one currently get the same product.
* **Acceptance of terms is not recorded anywhere**, and there is no column that could hold it.

**(c)** `/terms` §7 states the facts above and hands this question to counsel. It asserts no
commercial term.

**(d)** *Fee collected entirely off-platform, access ungated* → §7's wording already fits; counsel
must decide whether terms shown here bind a purchase made elsewhere and what must be disclosed
before it. *Access must be gated on entitlement* → the read now exists and is indexed for a request
path (`0006:358-373`); the work is the gating decision, the routes, and what an ungated reader is
shown. *Acceptance must be recorded* → a new column or table, a new inventory entry, a new retention
period. *Pre-contract disclosures must appear on a page this application serves* → new page, and it
must be reachable without an account, like the other three.

**(e)** Very high. Answering wrongly in the "ungated" direction is cheap to fix; answering wrongly in
the "gated" direction means building an entitlement-enforcing subsystem into a product whose central
guarantee is that skill here converts into nothing.

### L11 · `refunds-and-cancellation` — refunds, cancellation and interruption

**NOW MARKED ON `/terms` §8.**

Now a live clause id in `COUNSEL_CLAUSES`, rendered on `/terms` §8, entry 11 of
`legal-review-requirements.md`. **The missing-marker finding is closed; the question is open.**

**(a)** What refund, cancellation and cooling-off rights must be offered where a place is sold? Does
a cooling-off right survive a student starting the course? Must the policy be shown before purchase,
and where, given the purchase happens off-platform? **What does the operator owe a reader whose
access ends because the deployment was taken down, reset or changed** — which `/terms` §8 reserves
the right to do? And **what should deleting an account do to a place that has not expired?**

**(b)**

* The word "refund" still appears nowhere in the application. No amount, no order, no receipt,
  nothing that could record money going back. **Revoking an enrolment ends access and returns
  nothing.**
* **Revocation is a record, not an erasure.** `revoked_at`, `revoked_by` and `revoked_reason` are
  written into the row and the row stays; a `CHECK` refuses a partial revocation, so a withdrawal
  with no stated reason cannot be recorded at all (`0006:294-321`, `:339-342`). A re-grant after a
  revocation works, because the unique index is partial on `revoked_at IS NULL` (`:354-356`).
* **`POST /me/delete` destroys the enrolment.** CASCADE (`0006:269-270`), no notion of an outstanding
  entitlement to preserve, void or refund, and the deletion is irreversible and immediate (§3.1).
  That is a deliberate decision (`0006:168-193`) and one counsel may need to overturn — the audit
  rows survive, so the *operator's* record does, but the *student's* entitlement does not.
* **`/terms` §8 no longer rests on the service being free.** It states the technical facts and says
  that whether the operator may exercise them without owing the reader something is not settled
  there. Replacing that paragraph with real prose is what closes this entry.
* **Nothing in this software can be told that a refund happened**, so any refund policy is enforced
  by an operator running a revocation by hand.

**(c)** No refund concept at any layer. Access can be withdrawn; nothing can be returned.

**(d)** *Statutory cooling-off applies* → the policy must be presented before purchase, which is off
this platform, and §8 must be reconciled with it. *Refunds revoke access* → the mechanism exists
(`revoke`); what does not exist is any link between a refund event and this system. *Deletion must
not destroy an unexpired entitlement* → a change to `0004`'s referential action and to
`deleteAccount`, and a decision about what an entitlement naming nobody would mean.

**(e)** High and immediate: the first thing a dissatisfied student looks for and the first thing a
consumer regulator asks for.

### L12 · `sub-processors` — who else touches the data — **NEW**

**(a)** Which third parties process student data on the operator's behalf, what must be disclosed
about each, and which need a written processing agreement?

**(b)** Verified, exhaustively:

| Party | Present? | What it gets | Cited |
|---|---|---|---|
| **OIDC identity provider** | Only if configured | That a subject signed in here and when. Receives no learner content. **Scope requested is `openid profile`, which entitles it to return more claims than are used** | `apps/api/src/auth/oidc.ts:124,818-823` |
| **Hosting / infrastructure** | Always | Everything, including backups and the proxy access log — which since D2 was fixed carries a /24 rather than a raw IP, and no query strings | §2.10, §2.11, D2 |
| **SMTP smarthost** | Only if alerting configured | Alert content and on-call addresses; **no learner data** | `deploy/staging/observability/alertmanager.template.yml:104-114,146-163` |
| **Container registry** | Optional | Images. No personal data | `deploy/registry/` |
| **Whoever the operator collects from, if anybody** | **Unknown — outside this system entirely** | Whatever the operator gives them. **This application sends nothing and receives nothing**; the only trace is the opaque `reference` an operator typed into an enrolment, which is meaningful in some other system and never parsed here (`0006:32-37`) | §1, §2.9 |
| **The system that `reference` points into** | Only where an operator uses one | Nothing — the join runs the other way. Somebody holding both this database and that one can link a person to a record there, and only the operator knows what "there" is | §2.9 |
| Analytics, error reporting, CDN, remote fonts, advertising | **None. Not disabled — absent** | — | CSP has no host for any: `apps/web/src/lib/csp.ts:79,136` |

**(c)** Nothing is disclosed as a sub-processor anywhere; `/privacy` §7 says "by default, nobody"
and names the identity provider as the only outbound connection. Since 2026-08-25 it also carries a
paragraph saying that an enrolment's `reference` "is meaningful in some system outside this one",
that this application never contacts that system, and that only the operator can say what it is.
Still accurate about the application and still silent about hosting.

**(d)** *Disclosure list required* → a new `/privacy` section, and the list depends on operator
choices this repository cannot know. *Processing agreements required* → commercial work outside the
code. *Provider must be minimised* → E4.

**(e)** Moderate, and it is the entry most likely to be forgotten because most of its answers are
not in this repository.

### L13 · `accessibility-and-record-keeping` — **NEW**

**(a)** Two questions that share an entry because both turn on the service being paid and
educational. **First:** does an accessibility standard bind this as a paid educational service, and
may the operator make any accessibility claim before certification exists? **Second:** what records
must be kept about a paying student — enrolment, attendance, assessment, completion — and for how
long, and does any of that conflict with the erasure in §3?

**(b) Accessibility.** `docs/PRODUCT-GUARDRAILS.md:119` states **WCAG 2.2 AA "treated as a
functional requirement rather than a polish item"** — a binding internal commitment. **Two** automated
gates run in `verify` and each is a *necessary condition only*: `test:a11y` (static rules over
server-rendered HTML) and `test:ax` (the computed accessibility tree, including that no hidden card's
accessible name states a rank or suit). A third, `test:keyboard` (real Chrome, focus order, traps, a
whole hand folded from the keyboard), exists and is **not** in `verify`, `test` or `test:all` — it is
run by hand against a running production build, so no release is gated on it. This entry counted it
as a release gate until 2026-08-26, which overstated the evidence behind the accessibility
commitment by exactly one gate. **None of the three involves a screen reader.**
`docs/production/accessibility-certification.md:5-9` is unambiguous: *"BLOCKED — UNVERIFIED. Nothing
in this repository has ever heard this application read aloud, and no gate in it can."* It is
residual 1 of `final-readiness-report.md` and the only item standing between the release and a PASS.
`pnpm run certify:screen-reader` records what a person heard and stamps the commit, so `--check`
calls it stale the moment `HEAD` moves.

**(b) Record-keeping.** What exists: `prl.lesson_progress` (opened, finished, last viewed),
`prl.quiz_attempts` (one row per answer, **no score, no pass mark, no aggregate — and no column any
of them could go in**, `0001_initial.sql:781-783`), `prl.scenario_attempts`. What does **not**
exist: enrolment, attendance, assessment outcome, completion certificate, grade, or any record that
a person is a student rather than a visitor. The refusal to store a score is a deliberate product
guardrail (`docs/PRODUCT-GUARDRAILS.md:53-55`), not an oversight — and it is directly in tension
with any obligation to evidence completion.

**(c)** WCAG 2.2 AA is claimed internally, three necessary-condition gates pass, screen-reader
certification is UNVERIFIED, and **no accessibility claim is made on any user-facing page** — which
is currently the honest position. No student records beyond the three behavioural tables.

**(d)** *A standard binds* → certification must complete before launch, and it needs a person with
VoiceOver or NVDA for about half an hour, not a code change. *A claim may be published* → only after
certification; publishing "accessible" to paying students on the strength of a green `test:ax` would
be a false representation, and the certification document says in as many words not to record a PASS
on that basis. *Completion records required* → this is the sharpest conflict in the document: it
means adding the aggregate a binding guardrail forbids, and both the guardrail and the schema would
have to change deliberately. *Records must outlive erasure* → directly contradicts §3.1, which
deletes every quiz attempt.

**(e)** High in both halves. Publishing an accessibility claim that has never been verified is a
representation to paying customers; being unable to evidence that a student completed a course they
paid for is a different failure with the same root — **nobody has decided what this product is
supposed to remember about a student.**

---

## 6. What this review changed

Code and prose only; **no legal question was answered and no blocker was closed.**

### The 2026-08-25 revision, after `db/migrations/0006_cohort_enrolments.sql`

* **`apps/web/src/app/terms/page.tsx`** — §7 rewritten and split in two. The old §7 ("This service
  is provided free of charge…") is gone; §7 now states, from the migration, what an enrolment record
  holds and that it implies nothing about money, and §8 keeps the technical availability facts and
  says outright that they do not settle what the operator owes. Sections 8–11 renumbered to 9–12.
  The full argument is in D1 and in the file's own header.
* **`apps/web/src/lib/legal-config.ts`** — two new clauses, `enrolment-and-fees` and
  `refunds-and-cancellation`; the free-of-charge premise removed from `liability-and-warranty`'s
  question with the reason recorded beside it; `LEGAL_REVISION` → `0.2-draft`, `LEGAL_DRAFTED_ON` →
  2026-08-25.
* **`apps/web/src/app/privacy/page.tsx`** — `prl.cohorts` and `prl.enrolments` added to the
  inventory; §2's `prl.audit_log` entry now says that enrolment events are written there and that a
  grant's detail carries the external reference; §5 says nothing sweeps an enrolment and that
  expiring is not deleting; §6 says deletion removes the enrolment and detaches the audit rows about
  it; §7 says the reference points into a system this application never contacts. **And §4 was
  corrected**, having described a proxy log leak that had already been fixed — D10.
* **`docs/production/legal-review-requirements.md`** — entries 10 and 11 added with the facts from
  0006; entry 5's free-of-charge premise withdrawn; `/terms` section numbers in entries 3, 4 and 5
  updated for the renumbering.
* **`apps/web/test/legal-pages.test.ts`** — the payment tripwire rebuilt. See below.
* **`apps/web/test/honesty-claims.test.ts`** — the assertion that `/terms` still makes the honest
  version of the availability claim was keyed to a label ending "on a service that is free". It now
  reads the page's prose with comments stripped and asserts **three** things rather than one: the
  no-availability sentence, the sentence saying the technical disclaimer does not settle the
  commercial question, and the sentence saying an enrolment is not evidence of a fee. The second and
  third are the ones somebody tidying the clause would delete first, because they read like hedges.

### What the tripwire became, and why it is conditional rather than exempted

The group in `legal-pages.test.ts` fired on `prl.enrolments`, correctly. It was **not** weakened, and
no exemption was added for the table. Instead:

* **`/terms` may take one of exactly two postures**, and the test reads the page to decide which:
  *free-of-charge*, or *enrolment-aware* (four named disclosure sentences present, the free-of-charge
  claim absent, and both new counsel clauses flagged). A page carrying some of that and not the rest
  fails — the half-rewrite is the dangerous state, because a page that says an enrolment exists and
  drops the sentence saying it implies nothing about money reads as a confirmation that readers were
  charged.
* **Table names are split into two lists.** Money words (`payment`, `purchase`, `order`, `invoice`,
  `price`, `charge`, `ledger`…) fail **unconditionally, in every posture**. Entitlement words
  (`enrolment`, `cohort`, `entitlement`…) fail **unless `/terms` is completely enrolment-aware**.
  Recording an entitlement and taking money are different facts, and the second detector was not
  widened by one word to accommodate the first.
* **It runs in both directions.** A `/terms` rewritten to describe an enrolment record that no
  migration creates is a false factual claim on a legal page, and fails here too.

Why this shape and not an allowlist entry: **an exemption is a claim about a table, evaluated once,
by whoever added it. The property that matters is that two files agree, and it has to be
re-evaluated on every run.** Under the conditional shape the table is permitted only for as long as
the page keeps saying the honest thing about it — delete a disclosure paragraph or drop one counsel
flag and the migration detector starts firing again on a table that has not changed. An exemption
cannot do that, because it does not know what the page says.

**Two detector bugs were found by negative controls while doing this**, both the same bug in
different clothes:

1. `\binvoice` does not match `course_invoices` — `_` is a word character, so there is no boundary
   inside a snake_case identifier, and every table in this schema is snake_case. The fix is a
   `splitTableName` that splits on `_` and `.` as well as case transitions. This is the exact
   sibling of the `createCheckoutSession` miss the original group was built around.
2. The posture reader read the page's own **header comment** — which quotes the clause it replaced —
   as a live claim, and reported the page as taking both positions at once. A detector keyed to a
   sentence cannot tell a claim from a quotation of one, so the reader now strips block comments
   before deciding what the page says. Without that, the only way to document the change honestly
   would have been to stop quoting the sentence being changed.

**Every detector was demonstrated firing on a real violation**, not only on synthetic strings: a
`@stripe/stripe-js` dependency added to `apps/web/package.json`; a `prl.course_payments` table in a
throwaway migration file (which the snake_case fix is what catches); a `createCheckoutSession()` call
in a throwaway source file; `/terms` reverted to the old free-of-charge clause; and — the property
an exemption could never have — `/terms` left honest in prose with **one counsel flag deleted**, at
which point the migration detector re-fires on a table nobody touched. All five were reverted.

### The earlier passes, retained

* **`apps/web/src/app/privacy/page.tsx`** — corrected the session retention period (14-day *idle*
  window plus the **60-day absolute ceiling**, which appeared nowhere); corrected the sign-in-attempt
  entry to distinguish "stops working" from "is removed"; added the sweep-latency gap and the fact
  that the first sweep is at T+6 h, not boot — **wrong since the one-shot landed; it is T+60 s, and
  this line is left with its correction rather than deleted**; added a §6 paragraph stating that **deletion does not
  reach backups** and how long the shipped policy keeps them; narrowed the `prl.sessions` "never
  written anywhere" claim to "never written to the database"; added the `prl.room_ownership`
  inventory entry.
* **`apps/web/test/legal-pages.test.ts`** — a group that **reads the four retention constants out of
  the API source** and fails if `/privacy` and the code disagree again, plus four negative controls.

`pnpm --filter @prl/web test` **388/388** · `biome check` clean on every file touched.

---

## 7. Counsel sign-off only, versus still needs engineering

### Purely counsel — no engineering dependency remains

| Entry | Why it is ready |
|---|---|
| **L1** operator identity | Two variables exist and render; unset shows a visible gap |
| **L3** play-money classification | Every fact is enforced in schema or tests and was re-verified in §1 |
| **L6** international transfer | Facts established; one variable |
| **L7** governing law | Awaiting prose only |
| **L9** legend naming | Safe default shipped and locked; awaiting written permission |
| **L12** sub-processors | List established (§5 L12); disclosure is a drafting decision. **Still has no marker on any page** — E14 |

### Counsel decides, then engineering acts

| Entry | The engineering that an answer triggers |
|---|---|
| **L2** age threshold | Config only — **unless** counsel says self-declaration is insufficient (identity documents, new threat model) or that `/lab` and `/review` must be gated (E8) |
| **L4** rights | Portability → **E1** |
| **L5** retention | Deleting hand history → migration + grants + a decision about other players. Guest expiry → **E5, done** on a derived period; a different answer is one constant. Backup window → policy change |
| **L8** liability | Prose only. **The question has been re-asked without the free-of-charge premise (done)**; what remains is replacing the paragraph in `/terms` §9 |
| **L10** enrolment and fees | **Marked on `/terms` §7 (done)**, and the record it describes exists. Ungated → prose. Gated on entitlement → the read exists and is indexed (`0006:358-373`); the work is the gating decision and the routes |
| **L11** refunds and cancellation | **Marked on `/terms` §8 (done)**. Ungated → prose. Revocation → the mechanism exists; the missing link is between a refund event and this system. Deletion must not destroy a live entitlement → a change to 0004's referential action |
| **L13** accessibility & records | Certification needs a person, not code (**E10**). Completion records need a guardrail change and a migration |

### Engineering work items, open now

Independent of any legal answer, with file paths.

* **E1 · No data-export path.** Add `GET /me/export` returning the account row, memberships, lesson
  progress, quiz and scenario attempts, and hand history filtered by the existing entitlement rule
  (`apps/api/src/repositories/hands.ts:764-767` — never another seat's unshown hole cards).
  New route in `apps/api/src/routes/progress.ts` or a sibling; must be rate-limited like
  `/me/delete` (`apps/api/src/routes/auth.ts:686`). §3.3.
* **E2 · Proxy access log leaks raw IP, user agent and OIDC codes.** ***Done, except the part
  written below.*** Both configs now use a `log_format prl_privacy` built on `$uri`, a truncated
  client network and a user-agent class; the `error_log` is at `crit` in both, with
  `error_log /dev/null` on a dedicated `location = /api/v1/auth/oidc/callback`; the sentinel leak
  was demonstrated present before and absent after, in the access log **and** the error log, on both
  files; and `scripts/supply-chain/log-policy.mjs` is the gate that keeps it that way. The
  detail and the measured before/after are in D2.

  Every service in **all three** compose files now carries a `logging:` cap, sized per service with
  the reasoning beside it, and the gate enumerates services rather than knowing their names so a
  service added later cannot arrive uncapped. **Closed**, with one thing carried forward that was
  always a different question: a size cap is not a retention period. That is E12, not this. D2.
* **E3 · `security.md` role table is wrong.** `docs/production/security.md:164-170` says "Three
  roles" over a two-row table and omits `prl_backup` (`pg_read_all_data`). Add the row, say what it
  can read, and reconcile the count. D3.
* **E4 · OIDC scope is wider than needed.** `apps/api/src/auth/oidc.ts:124` requests
  `openid profile`. Only four name-shaped claims are read (`:818-823`). Consider `openid` alone plus
  a generated display name the learner can change — the rename path already exists. §2.1, L12.
* **E5 · Guest sweep is documented but unimplemented. — DONE, 2026-08-25.** Implemented against
  the index built for it (`db/migrations/0002_indexes_and_constraints.sql:51-55`) and scheduled from
  `apps/api/src/maintenance/retention-sweep.ts`, erasing through `deleteAccount` so that the policy
  in `0004_account_deletion.sql` exists once. Never removes an account with a live session, a
  membership, a hand seat, a room **or an enrolment**, at any age — five clauses in the predicate,
  and this sentence listed four until 2026-08-26. **The cutoff was L5 and L5 is still open**, so the
  period is derived rather than chosen: sixty days unseen, being the session absolute ceiling and
  therefore the point at which no cookie can reach the account any more. If counsel answers L5 with
  a different period, one constant changes. D4.
* **E6 · Identifiers in log lines with no redaction rule.** Add `users` and `rateLimitKey` to
  `EXPLICIT_SENSITIVE_KEYS` (`apps/api/src/logging.ts:74-84`) or rename the keys at
  `apps/api/src/rooms/registry.ts:495` and `apps/api/src/plugins/security.ts:818`. Decide whether
  `err.message` should be truncated or allowlisted where it can carry caller input
  (`apps/api/src/workers/pool.ts:655-657`). D8.
* **E7 · Guardrail-forbidden word.** `apps/web/src/app/record/page.tsx:82` says "balance", which
  `docs/PRODUCT-GUARDRAILS.md:27` forbids. One-word copy fix; consider a lint rule, since the
  guardrail is otherwise enforced only by review. D7.
* **E8 · Age-gate `play` scope covers only `/play`.** `apps/web/src/lib/age-gate.ts:163`. `/lab`,
  `/review` and `/legends` are ungated at that scope. Either widen the list or document the choice
  where a deployer reads it. Blocked on L2. **The register text should not describe `play` as "the
  simulated tables" without this caveat.**
* **E9 · `/terms` says the service is free. — DONE, 2026-08-25.** The clause was split rather than
  reworded: §7 states what an enrolment record is and that it implies nothing about money, §8 keeps
  the technical availability facts and says outright that they do not settle what the operator owes,
  and both commercial halves went to `COUNSEL_CLAUSES` as `enrolment-and-fees` and
  `refunds-and-cancellation`. The premise inside `legal-config.ts` was withdrawn, not answered. **No
  legal question was answered and L10/L11 are still open** — what closed is a false sentence shipping
  to a reader. D1, §6.
* **E13 · `/privacy` §5 did not list the fifth thing that protects a guest account. — DONE,
  2026-08-25.** The page named a live session, a seat at a table, a place in a room and a room of its
  own; a place in a class protects an account too. The sentence is there, and the drift is now
  mechanical rather than remembered: the test enumerates the tables `abandonedGuestPredicate`
  consults and demands a sentence on the page for each, so a sixth clause fails the build with the
  table named. D9.
* **E14 · L12 and L13 have no marker on any page.** L10 and L11 acquired one on 2026-08-25 and the
  mechanism worked; the same is not true of sub-processors or of record-keeping. Sub-processors is a
  `/privacy` §7 clause and would be a fourth clause on that page — the register is deliberately short
  (`legal-config.ts` says why), so this is a judgement about whether the disclosure belongs inline or
  as prose, not an oversight to close by reflex. §5 L12, L13.
* **E11 · `/privacy` §5 no longer describes guest retention correctly.** *(Created by the E5
  work, and the only inaccuracy it introduced.)* The page says everything other than sessions and
  sign-in attempts is "kept until you delete your account". Since 2026-08-25 an abandoned guest
  account — no live session, no membership, no hand seat, no room, no enrolment — is erased sixty days after it
  was last seen. The paragraph at `apps/web/src/app/privacy/page.tsx` §5 must say so, and §6's
  description of what deletion removes now has a second way to be triggered. Deliberately not done
  in the same change: `apps/web/` was held by other work in this session. This is a statement of
  fact, not a decision — the fact is in D4. D4.
* **E10 · Screen-reader certification.** Not a code defect and not blocked on anything but a
  person: `pnpm run certify:screen-reader`, about half an hour, VoiceOver or NVDA.
  `docs/production/accessibility-certification.md`. L13.
* **E12 · Container logs have a size cap and no retention period.** Split out of E2, because they
  are different questions and closing one was being read as closing both. Every container log is now
  bounded in SIZE (§2.11); nothing bounds it in TIME. A 100 MiB api log holds months at ten requests
  a minute and an afternoon under load, so "operational logs are kept for N days" is not a claim
  this deployment can make. logrotate is **not** the fix and must not be added — the Docker daemon
  owns these files, and renaming one out from under it leaves the daemon writing to an unlinked
  inode (§2.11). The fix is either a log driver that ships to a store with a time-based policy, or a
  periodic sweep of the daemon's log directory that is honest about racing the daemon. Blocked on
  L7 for the number, **not** blocked for the mechanism: the mechanism can be built before anyone
  decides what N is. §2.11, §2.12, D2.

---

## 8. What this document deliberately does not do

It does not answer any question above, name a jurisdiction, assert compliance with any regime, claim
any part of this product is or is not regulated, or state that the legal blocker is closed. **It is
not closed.** Every entry is written as a question so that an answer is a thing somebody can be
shown to have given, with a date on it, by somebody qualified in each place this deployment will be
offered.

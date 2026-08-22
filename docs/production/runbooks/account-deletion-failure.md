# Account deletion failure

A learner asked to delete their account and the request did not complete, completed partially, or completed and left data behind.

This is a **privacy obligation**, not a feature request. Treat a failed erasure as an open commitment, not as a closed ticket, and do not tell a learner it succeeded until you have checked.

---

## What deletion is supposed to do

Stated here because the runbook is unusable without it, and because "did it work?" is only answerable against a written policy. The full reasoning is in the header of `db/migrations/0004_account_deletion.sql`.

| Outcome | What |
| --- | --- |
| **Deleted** | `sessions`, `lesson_progress`, `quiz_attempts`, `scenario_attempts`, `room_members` (every seat, live or departed), and the `users` row itself |
| **Anonymised** | `hand_seats.user_id`, `audit_log.user_id`, `rooms.owner_user_id` — all set to null. The seat, the hand and the room survive; they stop naming anybody |
| **Retained** | every hand in full, including hands the departing learner played |
| **Also done** | every room the learner owned is **closed** in the same transaction |

The retention is the part that surprises people, so it must be stated to the learner *before* they confirm — and it is, in the deletion UI and in the route's doc comment. A hand is a shared record: other people were in it, it is in their history, and deleting it would edit theirs.

Rooms are closed on detachment because a room can now exist with no owner and nothing in the product can transfer ownership. An ownerless open table could otherwise be joined, re-opened after a restart, or left waiting for an owner who no longer exists to close it.

## Symptoms

- The deletion request returns 5xx, or times out.
- It returns success and the learner can still sign in.
- It returns success and their progress or history still shows their identity.
- A `23503` foreign-key violation appears in the logs.
- A learner reports, some time later, that their data is still there.

## Detection

There is no alert for this and there should not be: the operation is rare, so any rate-based rule would be noise. Detection is a learner report, a 5xx on the route, or a periodic audit.

```bash
# Did the route fail? It has its own contract error codes.
kubectl logs <pod> --since=24h | grep -E '"routePattern":"/api/v1/me/delete"' | grep -v '"statusCode":200'

# Was the erasure recorded? It writes an audit event.
psql "$DATABASE_URL" -c "select event, created_at from prl.audit_log where event = 'auth.account.deleted' order by created_at desc limit 20"
```

Note the shape of that second query: `audit_log.user_id` is nulled by the deletion, so the row survives as evidence that an erasure happened without naming who it was. That is the design, and it means the audit log tells you *that* and *when*, never *who*. Correlate with the request id from the learner's report.

## Immediate containment

**Establish whether it partially applied.** The deletion runs as a single transaction, so the intended states are "nothing happened" or "all of it happened". A partial state means the transaction boundary was broken and that is the finding, not the symptom.

```sql
-- Does the user still exist?
select id, kind, created_at from prl.users where id = '<user id>';

-- If it is gone, is anything still pointing at it? All of these must be empty.
select 'sessions',           count(*) from prl.sessions           where user_id = '<user id>'
union all select 'lessons',   count(*) from prl.lesson_progress    where user_id = '<user id>'
union all select 'quizzes',   count(*) from prl.quiz_attempts      where user_id = '<user id>'
union all select 'scenarios', count(*) from prl.scenario_attempts  where user_id = '<user id>'
union all select 'members',   count(*) from prl.room_members       where user_id = '<user id>'
union all select 'seats',     count(*) from prl.hand_seats         where user_id = '<user id>'
union all select 'rooms',     count(*) from prl.rooms              where owner_user_id = '<user id>'
union all select 'audit',     count(*) from prl.audit_log          where user_id = '<user id>';
```

**Revoke the session regardless.** Whatever else failed, the learner asked to leave and must not remain signed in:

```sql
delete from prl.sessions where user_id = '<user id>';
```

**Do not** retry blindly in a loop. If the cause is a constraint, a retry hits the same constraint and adds noise to the log.

**Do not** hand-delete rows to "finish the job" before you understand why the transaction failed. Deleting a `users` row by hand while a referencing row still exists either fails or, worse, succeeds against a referential action nobody expected — and you will have destroyed the evidence for why the code path did not work.

## Diagnosis

### `23503` — foreign-key violation

This is the failure the migration exists to prevent, so seeing it means either the migration is not applied here or a **new** referencing table was added without being considered:

```bash
node --env-file-if-exists=.env apps/api/scripts/migrate.mjs status
node --env-file-if-exists=.env apps/api/scripts/verify-schema.mjs
```

```sql
-- Every foreign key that references prl.users, and its delete action.
-- confdeltype: a = NO ACTION, r = RESTRICT, c = CASCADE, n = SET NULL, d = SET DEFAULT
select conrelid::regclass as referencing_table, conname, confdeltype
  from pg_constraint
 where confrelid = 'prl.users'::regclass
 order by 1;
```

Anything showing `r` or `a` other than by deliberate design is the blocker. A new table added since the migration is the realistic cause, and the fix is a forward migration plus an extension of the deletion function — **and** a test, because the reason this was ever broken is that nothing asserted it.

### `permission denied`

The runtime role's grants are deliberately narrow, and the narrowness is a security property rather than an oversight. In particular, `prl_app` is **not** granted `DELETE` on `prl.rooms` on purpose: rooms cascade to hands, hands cascade to `hand_actions`, and that table is append-only by design — "a role that can edit the audit log has no audit log". Granting `DELETE` on rooms would hand the request path a route to empty it.

So a `permission denied` here is not something to fix by widening a grant. It means the deletion is attempting an operation the policy says it must not perform. Check `db/roles/0001_privilege_roles.sql` and the deletion function against each other.

### Timeout

The deletion touches several tables in one transaction and is bounded by `DATABASE_STATEMENT_TIMEOUT_MS`. A learner with a very large history could exceed it. Check for a cancelled statement in the logs and for lock waits — see [db-saturation.md](db-saturation.md). If this is real, the fix is batching inside the transaction, not a longer timeout for everybody.

### Succeeded but data remains

The transaction committed and something was missed. Run the inventory query above, table by table. Then ask the question that matters more: **is the deletion function's table list complete?** A table added later and not added to the function will pass every existing test and silently retain data forever. Compare the function against `pg_constraint` output rather than against memory.

## Recovery

1. **Complete the erasure**, using the same transaction the code path uses — re-run the operation once the cause is fixed, rather than hand-deleting rows. The code path is the thing that must work.
2. **If it must be done by hand**, do it in one transaction, in the order the migration documents, and record exactly what you ran in the incident notes.
3. **Confirm no unrelated learner was affected.** This is the one destructive operation in the product, so a botched manual recovery is capable of deleting somebody else's data. Check a second, untouched account explicitly — do not assume.
4. **Fix the root cause**: the missing referential action, the missing table in the deletion function, the missing grant reasoning, the timeout.
5. **Add the case to the test suite.** `apps/api/test/account-deletion.test.ts` already asserts that a learner who created *and* joined a room can be deleted, that every table is empty afterwards, that hands survive with the seat anonymised, and that an unrelated user is untouched. Extend it with whatever this incident found — the failure mode that reached production is by definition the one no test covered.
6. **Tell the learner honestly** what happened and when it completed. A quiet fix after a failed erasure is worse than the failure.

## Verification

```bash
# 1. The user is gone and nothing references them. Every count must be 0.
psql "$DATABASE_URL" -f /tmp/deletion-inventory.sql

# 2. Hands the learner played still exist, with the seat anonymised. This is the
#    check that proves the policy was followed rather than over-applied.
psql "$DATABASE_URL" -c "select h.id, count(*) filter (where s.user_id is null) as anonymised_seats
                           from prl.hands h join prl.hand_seats s on s.hand_id = h.id
                          where h.id = '<a hand they played>' group by h.id"

# 3. Rooms they owned are detached AND closed.
psql "$DATABASE_URL" -c "select id, owner_user_id, status, visibility from prl.rooms where id in (...)"

# 4. An unrelated learner is completely untouched.
psql "$DATABASE_URL" -c "select count(*) from prl.lesson_progress where user_id = '<other user>'"

# 5. The schema is still what the application expects.
node --env-file-if-exists=.env apps/api/scripts/verify-schema.mjs

# 6. The code path works for a fresh account, end to end.
node --test apps/api/test/account-deletion.test.ts
pnpm run test:smoke --strict
```

Step 4 is the one people skip and the one that matters most: an erasure that also removed somebody else's data is a far worse incident than the one you started with.

## Escalation

Escalate when:

- Data remains after a deletion the learner was told succeeded. That is an unmet privacy commitment with a clock on it, and it needs an owner who is not the on-call engineer.
- Any unrelated learner's data was affected.
- The cause is a table nobody added to the deletion path. Ask immediately how many other accounts were "deleted" while that table was being missed — the answer is usually all of them.
- Deletion is failing for a whole class of learner rather than one. Everyone in that class is currently unable to leave.
- Recovery would need a restore. Note carefully that restoring a backup **reinstates deleted accounts**, which directly conflicts with an erasure obligation: the archive was taken while the account still existed, so restoring it brings the account back. That conflict is a decision for a data owner and not for an on-call engineer — the two options are to restore and then re-run the erasure against the restored data, or to accept the data loss the restore was meant to repair. Whichever is chosen, the erasure must be re-run and re-verified afterwards, because the restored rows have not been through the deletion path. See [`backup-restore.md`](backup-restore.md) and [`../backup-restore.md`](../backup-restore.md).

Related: `db/migrations/0004_account_deletion.sql`, the privacy policy page, [`../security.md`](../security.md) §10.

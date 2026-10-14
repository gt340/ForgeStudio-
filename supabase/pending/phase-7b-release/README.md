# ForgeStudio Phase 7B - production execution scripts (NOT EXECUTED; each step needs separate Commander authorization)

Production execution MUST use `psql` through the Supabase session pooler (host `aws-0-eu-west-1.pooler.supabase.com`, port 5432, user `postgres.<project-ref>`, `sslmode=require`),
running each file as the `postgres` role (non-superuser) with `psql -X -v ON_ERROR_STOP=1 -f <file>` (no `--single-transaction`; the scripts contain their own `begin; ... commit;`).
The password is entered at a hidden prompt (`read -rsp` into `PGPASSWORD`) and is never placed on a command line, in a file, or in chat. No other execution route is verified.
Every changing script is ONE transaction: preflight assertions -> (snapshot) -> change -> post-assertions. A failed
assertion raises an exception and PostgreSQL rolls the whole transaction back: nothing changes. `set local lock_timeout = '5s'`
makes it fail fast instead of waiting behind another session.

| Step | File | Type | Expected |
|---|---|---|---|
| -1 | (backup, before anything else) | recovery copy, taken by the Commander locally | Runbook DRAFT: [`docs/PHASE-7B-BACKUP-RUNBOOK.md`](../../../docs/PHASE-7B-BACKUP-RUNBOOK.md); its commands stay labeled UNTESTED until the CI test `tests/integration/pg17-backup-validation.test.ts` (disposable `postgres:17.6`, synthetic data) has passed, and even then it does not authorize production execution or prove the session-pooler transport. **Production changes remain blocked until the backup/restore validation and all required checks pass and the Commander confirms a verified backup.** Do not run Step 1 without a Commander-confirmed backup. A dump of `public` is a Phase 7B rollback aid, NOT a disaster-recovery backup: Supabase's `db dump` excludes `auth` (so `auth.users`), `storage` and extension schemas, the Free plan has no managed backups or PITR, and role passwords are not recoverable. |
| 0 | 01_preflight_readonly.sql | read-only SELECT | every row PASS (INFO rows saved) |
| 1 | 02_change1_least_privilege.sql | CHANGE 1 (atomic) | returns without error |
| 2 | 03_verify_change1_readonly.sql | read-only SELECT | every row PASS; monitor shows exactly the 2 SECDEF rows |
| 2b | 04_verify_behavior_readonly.sql | read-only (always ends in an exception) | `RESULT: anon_denied=5/5 auth_rls_filtered=5/5 owner_sees_own_rows=true` |
| 3 | 06_change2_rls_auto_enable.sql | CHANGE 2 (atomic; separate authorization) | returns without error |
| 4 | 07_verify_change2_readonly.sql | read-only SELECT | every row PASS; monitor ZERO violation rows |
| R1 | 05_rollback_change1.sql | rollback of Change 1 (atomic) | returns without error |
| R2 | 08_rollback_change2.sql | rollback of Change 2 (atomic) | returns without error |

What the atomic scripts assert (PostgreSQL 17 ACL text, order-independent exact set comparison):
- role postgres, not superuser, server major 17; exactly 5 tables in `public`, all owned by postgres, RLS on
- exact table ACLs and the default ACL of postgres in public, before and after (letter `m` = MAINTAIN)
- 19 policies and the md5 fingerprint `0e857fa80e4bec97dd561ac6e5415905` of their definitions, before and after
- row counts of the 5 tables and every table's RLS flag identical before/after (captured inside the same transaction)
- effective privileges via has_table_privilege (no TRUNCATE/TRIGGER/REFERENCES/MAINTAIN for anon/authenticated, no anon access, authenticated keeps the DML the app needs)
- Change 2 preflight (change-order gate): the exact post-Change-1 table ACLs and default table ACL are in place; the table ACLs and default ACL are identical before and after Change 2 (snapshot comparison)
- Change 2: function owner/security-definer/search_path, event trigger `ensure_rls` enabled and bound to the function, proacl exactly `{postgres=X/postgres}` afterwards, anon/authenticated/service_role/PUBLIC cannot execute, owner can, and a probe table created in the same transaction gets RLS automatically (then dropped; net zero)

Do not run Change 2 before Change 1 is verified. Do not run anything while preflight shows a FAIL row.

**Mandatory verification gate between Change 1 and Change 2.** After Change 1 (step 1) run 03 and 04, read their output, and obtain a separate
Commander authorization before step 3. Every row of 03 must be PASS (the monitor showing exactly the 2 SECDEF rows) and 04 must report
`anon_denied=5/5 auth_rls_filtered=5/5 owner_sees_own_rows=true`. Script 06 enforces part of this in code: its preflight requires the EXACT
post-Change-1 ACLs (the five table ACLs and the default table ACL of postgres in public, the same values 02 asserts in its POSTCHECK) and aborts with
`PREFLIGHT: Change 1 is not in place` before any change if the state is the original baseline, a partially applied or partly reverted Change 1, or
over-revoked. That check proves the ACL end state only. It does NOT prove that 03 and 04 were run or that you read them: that stays a manual gate.
Re-run 01 immediately before step 1 and keep its output; compare the INFO row counts with 03/07 afterwards.
## Validation status

- PostgreSQL 16 replica (local, MAINTAIN letter stripped for that run only): 23/23 scenarios passed.
- PostgreSQL 17.6 CI gate `tests/integration/pg17-release-scripts.test.ts`: runs these eight files EXACTLY as committed (real PG17 version guard 170000..179999,
  real MAINTAIN letter `m`) against a disposable `postgres:17.6` container: preflight, drift rejection, POSTCHECK rollback, Change 1/2 apply and verify,
  repeat-run refusal, both rollbacks, re-apply, lock_timeout, and the Change 2 change-order gate (rejects baseline, partial, drifted, over-revoked and rolled-back states; the table ACLs are unchanged by Change 2). Results are emitted as `pg17-scripts-A/B` annotations on the CI run.
- NOT VERIFIED (cannot be tested in CI): the real production execution path (psql through the session pooler, role switching). The Supabase MCP `execute_sql` / `apply_migration` routes are NOT a verified execution route and must not be used for production.
  CI delivers each file as one simple-query string via `psql -c`, which proves the SQL, not that transport. In particular it is not proven how any wrapper (MCP `apply_migration`, the Management API, the SQL editor) treats the explicit `begin; ... commit;` inside the text, which is why `psql` file execution is required. The first production run
  must therefore start with the read-only preflight and be followed by the read-only verify scripts.
- These files live in `supabase/pending/` and are never applied automatically.

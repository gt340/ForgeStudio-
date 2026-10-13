# Phase 7B — merge safety, supabase_admin control, production change plan

Status: **PLAN ONLY. Nothing in this document has been executed on production.** Every production step below needs
the Commander's explicit authorization. Evidence gathered 2026-10-11 (read-only queries and documentation).

Commander decision 2026-10-11: **Option A chosen.** The least-privilege migration now lives in
`supabase/pending/20261010120000_least_privilege_public_tables.sql` (not in `supabase/migrations/`). It is applied to
production manually, only after explicit authorization; afterwards it is moved into `supabase/migrations/` under the
version recorded in production history.

## 1. Merge safety (Decision 1)

| Question | Evidence | Conclusion |
|---|---|---|
| Does merging apply `supabase/migrations/*` to production? | Production migration history (`list_migrations`) holds 4 versions. The 5 migration files first reached `main` in the Phase 7A merge (commit `64f4713`, 2026-10-10 00:10Z). `20261007060000_grant_update_forgestudio_projects.sql` is in `main` but is **absent** from production history after that merge. Its header says "Applied to production on 2026-10-07", i.e. applied by hand. | A merge has **not** applied migrations before. Migrations are applied manually (MCP / SQL editor), and the history version numbers were aligned by hand in 7A. |
| Any workflow that could run a migration? | `main` has one workflow, `.github/workflows/ci.yml` (typecheck, lint, test, build). No `supabase db push`, no secrets use, no deploy step. | No GitHub Actions path. |
| Supabase GitHub integration / branching? | Branch list holds only the default branch. No Supabase preview branch or Supabase check run appeared on PR #3 although it contains a new migration file. No `supabase/config.toml` in the repo. | Behavioural evidence says the integration is **not** active. The setting itself lives in the Supabase dashboard (Settings > Integrations) and cannot be read through the connectors, so this is **not proven**. |
| Does Vercel run migrations? | `package.json` scripts: `build` = `next build`; no postinstall/migrate hooks; no `vercel.json`. | No. |
| What does a merge to `main` do? | Vercel Git integration: each of the last four `main` commits (`9de122c`, `13ad720`, `965b900`, `64f4713`) produced a `target: production` deployment automatically. | **Merging PR #3 deploys the application to production automatically.** Treat merge = production deploy. |

Supabase documentation (Branching / production checklist) states that with the GitHub integration's "Deploy to production"
enabled, changes merged to `main` are applied to production automatically. Hence the residual risk is only "integration
enabled but silently failing/unobserved", which the evidence above argues against but cannot exclude.

**Safe alternatives (Commander chose A on 2026-10-11 and it is now in the branch):**

- **A (CHOSEN, DONE in the branch; zero-dependency):** before merge, move the migration out of `supabase/migrations/` to
  `supabase/pending/20261010120000_least_privilege_public_tables.sql` (update the 3 references: the CI gate test, the
  header comments and the docs). Nothing under `supabase/migrations/` can then ever be picked up by an integration. After
  the Commander authorizes and the migration is applied manually, a follow-up commit moves it into `supabase/migrations/`
  under the version actually recorded in production.
- **B (not chosen):** the Commander confirms in the Supabase dashboard that the GitHub integration is not connected or that
  "Deploy to production" is off, then merge unchanged.

App code compatibility: the merged application code works identically before and after the database migration (the
delete route and every other route use the signed-in user's session; nothing needs the removed privileges), so merge and
migration can happen in either order.

## 2. Control for supabase_admin default privileges (Decision 2) — NOT resolved, monitored

Facts verified on production (read-only):

- `supabase_admin` is a superuser; `postgres` (the role migrations run as) is not, and is **not a member** of
  `supabase_admin` (`pg_has_role('postgres','supabase_admin','member')` = false).
- `supabase_admin` has default privileges in schema `public` for tables: `postgres, anon, authenticated, service_role = arwdDxtm`.
  They apply only to tables **created by supabase_admin**. Today all 5 public tables are owned by `postgres`.
- `ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin` run as `postgres` fails with 42501 (reproduced on PostgreSQL 17.6).
  We do not try to work around this.
- A table created by `supabase_admin` in `public` also keeps RLS **off**: the `ensure_rls` event trigger runs as `postgres`
  and cannot alter a table it does not own (reproduced on PG17).

Can Supabase support change it? Unknown: nothing public says they will change `supabase_admin`'s defaults for a single project.
Supabase documents a different mechanism: the platform default is moving to **revoke** automatic grants, and customers
opt in with `ALTER DEFAULT PRIVILEGES FOR ROLE postgres ...` (the role we already use). The `supabase_admin` defaults are
platform-managed and may be re-applied by platform upgrades, so even a support-made change must not be treated as permanent.
Recommended request to support (a question, not an action): "Can the default privileges of `supabase_admin` in schema
`public` be restricted for this project, and will that survive upgrades? If not, which of your processes create tables as
`supabase_admin` in `public`?" Treat the issue as **open** until a monitor run proves otherwise.

**Monitoring:** `supabase/monitoring/public_privilege_monitor.sql` (read-only, expected zero rows) flags, for every table
in `public`: prohibited privileges (TRUNCATE/TRIGGER/REFERENCES/MAINTAIN) for anon/authenticated, any anon table access,
RLS disabled, owner other than `postgres`, dangerous defaults for future `postgres`-created tables, and SECURITY DEFINER
functions executable by anon/authenticated. Run it after every schema change and at least weekly (read-only; run it with psql like the other scripts. The Supabase MCP / SQL editor transport is unverified). Validated on a PostgreSQL replica: before the changes it flags the known findings; after
the changes it returns zero rows; a table created by `supabase_admin` produces 12 violation rows.
Production baseline today (before any change): ANON_TABLE_ACCESS 14, FUTURE_TABLE_DEFAULT 8, PROHIBITED_PRIVILEGE 40,
SECDEF_FUNCTION_EXECUTABLE 2 (= `rls_auto_enable()` for anon and authenticated). 0 RLS_DISABLED, 0 NON_POSTGRES_OWNER.

**Response if a violation row appears** (as `postgres`, only on the offending object, then re-run the monitor):

| Row | Safe response |
|---|---|
| `NON_POSTGRES_OWNER` / `PROHIBITED_PRIVILEGE` / `ANON_TABLE_ACCESS` on a new table `public.T` | `revoke all on table public.T from anon; revoke truncate, trigger, references, maintain on table public.T from authenticated;` (works when postgres can alter the table; if it is owned by `supabase_admin` and the revoke fails with 42501, do **not** bypass it: restrict exposure instead by removing the table from the API (move it to a non-exposed schema via support) and open a support ticket). |
| `RLS_DISABLED` on `public.T` | `alter table public.T enable row level security;` then create owner-only policies before granting anything. If 42501 (owned by supabase_admin) escalate to support. |
| `SECDEF_FUNCTION_EXECUTABLE` | `revoke execute on function <signature> from public, anon, authenticated;` |
| `FUTURE_TABLE_DEFAULT` | re-run step 4 of the migration. |

Optional hardening (separate decision, not part of this change): Supabase's own guidance also revokes default
`EXECUTE` on future functions (`alter default privileges for role postgres in schema public revoke execute on functions from anon, authenticated, service_role, public`).

## 3. Production change plan (Decision 3) — approved in principle, NOT authorized

### 3.1 Exact SQL

**Change 1 — least-privilege migration** (file `supabase/pending/20261010120000_least_privilege_public_tables.sql`; same statements as the version the PostgreSQL 17.6 CI gate tested at head `8ecaec8`, plus a header comment marking it pending):

```sql
revoke all privileges on table
  public.forgestudio_projects, public.forgestudio_project_versions, public.integrations,
  public.seo_settings, public.env_vars
from anon;

revoke truncate, trigger, references, maintain on table
  public.forgestudio_projects, public.forgestudio_project_versions, public.integrations,
  public.seo_settings, public.env_vars
from authenticated;

grant select, insert, update, delete on table public.forgestudio_projects     to authenticated;
grant select, insert, delete         on table public.forgestudio_project_versions to authenticated;
grant select, insert, update, delete on table public.integrations             to authenticated;
grant select, insert, update, delete on table public.seo_settings             to authenticated;
grant select, insert, update, delete on table public.env_vars                 to authenticated;

alter default privileges for role postgres in schema public
  revoke truncate, references, trigger, maintain on tables from anon, authenticated;
```

**Change 2 — `rls_auto_enable()` EXECUTE revocation** (separate migration `revoke_execute_rls_auto_enable`, applied after Change 1 is verified):

```sql
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
```

Neither statement touches RLS, policies, data, `postgres` or `service_role` privileges. Execution role: `postgres` (non-superuser), verified.

### 3.2 Production preflight (read-only; abort if any expectation fails)

```sql
-- P1 context
select current_user, current_setting('server_version') as v,
       (select rolsuper from pg_roles where rolname = current_user) as is_super;      -- postgres | 17.6 | false
-- P2 exact ACL snapshot = the recovery artifact: SAVE THIS OUTPUT
select c.relname, c.relacl::text from pg_class c
where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' order by 1;
select pg_get_userbyid(defaclrole), defaclobjtype, defaclacl::text from pg_default_acl
where defaclnamespace = 'public'::regnamespace order by 1, 2;
select p.oid::regprocedure::text, coalesce(p.proacl::text, 'NULL') from pg_proc p
where p.proname = 'rls_auto_enable';                                                   -- NULL (implicit PUBLIC execute)
-- P3 RLS intact before: 5 tables relrowsecurity = true, 19 policies
select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r';
select count(*) from pg_policies where schemaname = 'public';                          -- 19
-- P4 data baseline (must be identical after)
select (select count(*) from public.forgestudio_projects) p, (select count(*) from public.forgestudio_project_versions) v,
       (select count(*) from public.integrations) i, (select count(*) from public.seo_settings) s, (select count(*) from public.env_vars) e;
-- P5 quiet database
select count(*) from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and state <> 'idle';  -- 0 (was 0 on 2026-10-11)
-- P6 monitor baseline: public_privilege_monitor.sql  -> 64 rows (14 + 8 + 40 + 2), 0 RLS_DISABLED, 0 NON_POSTGRES_OWNER
-- P7 migration history: no row named least_privilege_public_tables
select version, name from supabase_migrations.schema_migrations order by 1;
```

Production values recorded 2026-10-11 (P2): `forgestudio_projects {postgres=arwdDxtm/postgres,anon=arDxtm/postgres,authenticated=arwdDxtm/postgres,service_role=Dxtm/postgres}`,
`forgestudio_project_versions {postgres=arwdDxtm/postgres,anon=Dxtm/postgres,authenticated=ardDxtm/postgres,service_role=Dxtm/postgres}`,
`integrations`, `seo_settings`, `env_vars` `{postgres=arwdDxtm/postgres,anon=arwdDxtm/postgres,authenticated=arwdDxtm/postgres,service_role=Dxtm/postgres}` (env_vars identical),
default ACL (postgres, public, tables) `{postgres=arwdDxtm/postgres,anon=Dxtm/postgres,authenticated=Dxtm/postgres,service_role=Dxtm/postgres}`.
Re-take P2 immediately before executing; use that fresh output for the comparison.

### 3.3 Backup / recovery plan (privilege changes)

- The change is metadata only: no row is read, written or deleted; a data restore is **not** the right recovery tool
  (it would discard newer data). Recovery = the tested rollback file + the saved P2 snapshot.
- **Plan verified 2026-10-11: the organization ("Trust God Company") is on the Free plan.** Supabase documents automatic
  daily backups for Pro, Team and Enterprise only (PITR is a paid add-on on those plans); for Free projects it recommends
  regular exports with `supabase db dump` and off-site copies. **So this project has no managed backup to restore from.**
- Because the change is metadata only, the saved P2 ACL snapshot plus the tested rollback is the correct and sufficient
  recovery artifact. Before executing: save P2 output (and optionally take a `supabase db dump` with the Supabase CLI on a
  machine that has the database password: this cannot be done from the assistant's workspace).
- Data is small (preflight counts: 6 projects, 0 versions, 9 integrations, 3 SEO rows, 0 env vars) and none of it is touched.
- The migration runs as one transaction (a failed statement changes nothing). Use `set local lock_timeout = '5s'` so it
  fails fast instead of queueing behind another session.

### 3.4 Execution procedure (when authorized)

**Execution route (approved): `psql` through the Supabase session pooler, run by the Commander.** Each file runs with
`psql -X -v ON_ERROR_STOP=1 -f <file>` (no `--single-transaction`; the scripts contain their own `begin; ... commit;`), as the `postgres`
role, with the password typed at a hidden prompt (never on a command line, in a file or in chat). Details: `supabase/pending/phase-7b-release/README.md`.
The Supabase MCP `apply_migration` / `execute_sql` routes, the Management API, the SQL editor and `supabase db push` are NOT verified for
these scripts (their transaction handling is undocumented, and `apply_migration` records its own history row) and must not be used for production.
Nothing in this section has been executed; every step below needs its own Commander authorization.

0. Backup (Step -1): a Commander-confirmed recovery copy. The backup runbook is blocked until the commands and coverage are validated against a
   disposable PostgreSQL 17. A `public` dump is a rollback aid only, not a disaster-recovery backup (it excludes `auth`, `storage` and extension schemas).
1. Run `01_preflight_readonly.sql` (P1-P7); save the output; stop on any FAIL row.
2. Change 1: `psql -f 02_change1_least_privilege.sql` (one atomic transaction with `lock_timeout = '5s'`).
3. Run `03_verify_change1_readonly.sql` and `04_verify_behavior_readonly.sql` (3.5). On any failure run the rollback (3.6) immediately.
4. Only after a separate Commander authorization: Change 2, `psql -f 06_change2_rls_auto_enable.sql`. Its preflight refuses to run unless the exact
   post-Change-1 ACLs are present (change-order gate), but that gate does not replace step 3. Then run `07_verify_change2_readonly.sql`.
5. The psql route writes no row to `supabase_migrations.schema_migrations`, and the migration file stays in `supabase/pending/`. Moving it to
   `supabase/migrations/` and reconciling the migration history are a separate follow-up that needs its own authorization.

### 3.5 Verification queries (after each change; all read-only)

```sql
-- V1 monitor: expected ZERO rows after Change 1 + Change 2 (after Change 1 alone: only the 2 SECDEF rows)
--     run supabase/monitoring/public_privilege_monitor.sql
-- V2 exact ACLs after Change 1 (expected; PG17 strings)
select relname, relacl::text from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' order by 1;
--   env_vars / forgestudio_projects / integrations / seo_settings:
--        {postgres=arwdDxtm/postgres,authenticated=arwd/postgres,service_role=Dxtm/postgres}
--   forgestudio_project_versions: {postgres=arwdDxtm/postgres,authenticated=ard/postgres,service_role=Dxtm/postgres}
--   default ACL (postgres, public, r): {postgres=arwdDxtm/postgres,service_role=Dxtm/postgres}
-- V3 RLS and policies untouched
select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r';   -- all true
select count(*) from pg_policies where schemaname = 'public';                                                 -- 19
-- V4 data untouched: repeat P4, values must equal the preflight
-- V5 behaviour as the roles (read-only; the transaction changes nothing)
begin;
  set local role anon;           select count(*) from public.forgestudio_projects;   -- ERROR 42501 expected
rollback;
begin;
  set local role authenticated;  select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000000', true);
  select count(*) from public.forgestudio_projects;                                 -- 0 (no such user), no error
  truncate table public.forgestudio_projects;                                        -- ERROR 42501 expected (nothing is truncated)
rollback;
-- V6 after Change 2
select has_function_privilege('anon', 'public.rls_auto_enable()', 'execute'),
       has_function_privilege('authenticated', 'public.rls_auto_enable()', 'execute'),
       has_function_privilege('postgres', 'public.rls_auto_enable()', 'execute');   -- false, false, true
select evtname, evtenabled from pg_event_trigger where evtname = 'ensure_rls';       -- ensure_rls | O
-- V7 Supabase security advisor: the two rls_auto_enable lints disappear; leaked-password lint remains (separate change)
```

Application check without touching real data: sign in as an existing user in the production app and open the project list
(read) — that exercises the `authenticated` SELECT path; creating or deleting projects is **not** part of verification.

### 3.6 Rollback (tested)

- Change 1: apply `supabase/rollbacks/20261010120000_least_privilege_public_tables.rollback.sql`. Tested on PostgreSQL 17.6:
  table ACLs and default ACLs identical to the pre-migration snapshot (CI gate F, true). Re-run V2-style comparison against the saved P2.
- Change 2: `grant execute on function public.rls_auto_enable() to public;` Tested on PostgreSQL 17.6: effective privileges
  return to the baseline (anon/authenticated/public execute = true). The stored `proacl` text becomes
  `{postgres=X/postgres,=X/postgres}` instead of NULL, which is functionally identical.
- A rollback re-opens TRUNCATE / anon access; use it only to recover from a verified break.

### 3.7 Application functionality and RLS intact (evidence)

- App database access is limited to the 5 tables through the signed-in user's Supabase client (no `service_role`, no RPC);
  the only anon-role path is the Google OAuth callback, which already fails and is deliberately not modified in this phase.
- PostgreSQL 17.6 CI (head `8ecaec8`): after the migration owner insert/update/select/delete work, a second user sees and
  changes 0 rows, anonymous access gets 42501, TRUNCATE gets 42501, project deletion cascades its versions, and the real
  delete route returns 401 / 404 / 200 as designed. Exported-ZIP build also passes.

## 4. Leaked-password protection (separate dashboard change; not executed)

- Dashboard setting (Authentication > Providers > Email). Supabase documents it as **available on the Pro plan and above**.
  **The organization is on the Free plan (verified 2026-10-11), so this setting cannot be enabled without upgrading to Pro**
  (a billing decision for the Commander). The advisor lint `auth_leaked_password_protection` therefore stays open on Free.
  Free-plan mitigation within the app: raise the sign-up minimum length (currently 6) in a later code change.
- The app uses email + password (`app/signup/page.tsx` -> `signUp`, `app/login/page.tsx` -> `signInWithPassword`).
- Compatibility: existing users keep signing in (the documented `WeakPasswordError` applies to strength rules, not to
  already-stored passwords being blocked). New sign-ups and password changes with a leaked password are rejected. The
  sign-up page already displays `error.message`, so the user sees Supabase's reason. The sign-up form currently enforces
  only `minLength={6}`; consider raising it to 8+ in a later change.
- Verification plan: (1) record the advisor lint before; (2) enable; (3) attempt sign-up with a known-leaked password
  (e.g. `password123`) on a disposable address and expect a rejection with a weak/pwned message; (4) sign in with an
  existing account and confirm success; (5) re-run the security advisor and confirm `auth_leaked_password_protection`
  has cleared; (6) rollback = turn the setting off.

## 5. Production preflight run (read-only), 2026-10-11 ~12:40 UTC — NOTHING CHANGED

| Check | Result | Expectation |
|---|---|---|
| P1 context | `postgres`, server_version 17.6, not superuser; project ACTIVE_HEALTHY, engine 17 (17.6.1.147), eu-west-1 | match |
| P2 table ACLs | identical to the values in section 3.2 (all 5 tables) | match |
| P2 default ACL (postgres, public, tables) | `{postgres=arwdDxtm/postgres,anon=Dxtm/postgres,authenticated=Dxtm/postgres,service_role=Dxtm/postgres}` | match |
| P2 `rls_auto_enable()` | `proacl` NULL, owner postgres | match |
| Event triggers | `ensure_rls` enabled (`O`, owner postgres); platform triggers owned by `supabase_admin` | n/a |
| P3 RLS / policies | all 5 tables `relrowsecurity = true`; 19 policies | match |
| P4 data counts | projects 6, versions 0, integrations 9, seo_settings 3, env_vars 0 | recorded baseline |
| P5 active sessions | 0 | 0 |
| P6 monitor | ANON_TABLE_ACCESS 14, FUTURE_TABLE_DEFAULT 8, PROHIBITED_PRIVILEGE 40, SECDEF_FUNCTION_EXECUTABLE 2 (= 64) | baseline |
| P7 migration history | 4 versions, no `least_privilege_public_tables` | none |
| Security advisor | 3 WARN: `rls_auto_enable` executable by anon, by authenticated; leaked password protection disabled | baseline |

Preflight values must be re-taken immediately before execution (state can drift).

## 6. Draft support inquiry about `supabase_admin` default privileges — NOT SUBMITTED

Subject: Restricting default table privileges of `supabase_admin` in schema `public` (project nbjihppxarjomgrbbhfh)

> Hello Supabase support,
>
> Project `nbjihppxarjomgrbbhfh` (ForgeStudio, PostgreSQL 17.6, Free plan). Our least-privilege hardening can change the
> default privileges of objects created by `postgres` in schema `public`, but `pg_default_acl` also holds an entry for
> `supabase_admin` that grants `arwdDxtm` on future tables to `postgres`, `anon`, `authenticated` and `service_role`.
> `postgres` is not a member of `supabase_admin`, so `ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public`
> fails with 42501 for us, and we are not trying to work around that.
>
> Questions:
> 1. Can the `supabase_admin` default privileges in schema `public` be restricted (revoking `anon`/`authenticated`
>    TRUNCATE, TRIGGER, REFERENCES, MAINTAIN and anon access) for this project, and would that survive platform upgrades?
> 2. Which platform processes or extensions create tables as `supabase_admin` in `public`? (None exist today: all five
>    public tables are owned by `postgres`.)
> 3. Tables created by `supabase_admin` do not get RLS auto-enabled by the `ensure_rls` event trigger (it runs as
>    `postgres`). Is that expected, and is there a supported way to enforce RLS for them?
> 4. Is there a supported project-level setting that stops automatic grants to `anon`/`authenticated` on new tables?
>
> We are monitoring `public` with a read-only privilege check in the meantime. Thank you.

Do not include keys, passwords or user data. Submit only after the Commander authorizes submission.

# Phase 7B — security findings (documented, NOT changed)

## 1. `public.rls_auto_enable()` — SECURITY DEFINER event-trigger function

**What it is.** `public.rls_auto_enable()` (owner `postgres`, `SECURITY DEFINER`, `search_path = pg_catalog`,
returns `event_trigger`) is wired to the event trigger `ensure_rls` (`ddl_command_end`). After every
`CREATE TABLE` / `CREATE TABLE AS` / `SELECT INTO` in schema `public` it runs
`ALTER TABLE ... ENABLE ROW LEVEL SECURITY`, so a new table can never be created with RLS off. This is a useful
safety net and **must keep working**.

**EXECUTE privileges (audited 2026-10-10).** `proacl` is `NULL`, i.e. the default: `PUBLIC` (and therefore `anon`
and `authenticated`) may EXECUTE it. Supabase's security advisor reports this as
`anon_security_definer_function_executable` and `authenticated_security_definer_function_executable` (WARN),
because it is reachable by name through `/rest/v1/rpc/rls_auto_enable`.

**Actual exposure.** Low. An event-trigger function cannot be called as an ordinary function — PostgreSQL refuses
with `trigger functions can only be called as triggers`. Verified on a local PostgreSQL 16 replica (the production
function itself was deliberately NOT invoked). It is still a pointless public entry on a SECURITY DEFINER function
and clutters the advisor.

**Recommended remediation (not applied).**

```sql
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
```

Local evidence (PostgreSQL 16): after this REVOKE the event trigger still fires and a table created by an ordinary
role still gets RLS enabled automatically, and `has_function_privilege('anon', ..., 'EXECUTE')` is false.

**Before applying in production** (impact not yet verified there): (a) repeat the check in a rolled-back
transaction / Supabase branch — create a throw-away table as `postgres` and confirm `relrowsecurity = true`;
(b) confirm the function is not managed by Supabase in a way that re-grants EXECUTE on upgrade (if it is, the
advisor warning is expected and can be accepted); (c) rollback is
`grant execute on function public.rls_auto_enable() to public;`.

## 2. Leaked-password protection is disabled (Supabase Auth)

Supabase Auth can reject passwords found in the HaveIBeenPwned database. It is currently **disabled**
(advisor `auth_leaked_password_protection`, WARN). This is a dashboard/Auth setting
(Authentication → Sign In / Providers → Password security), not a migration; no MCP tool changes it and it was
**not** changed. Recommendation: enable it. Impact: sign-ups / password changes using a known-breached password
are rejected with a clear error; existing users and sessions are unaffected. Rollback: switch it off again.

## 3. Related finding — Google OAuth callback uses the anonymous role

`app/api/auth/google/callback/route.ts` builds a module-level Supabase client with the anon key and inserts into
`integrations` with no session and no `user_id`. With owner-only RLS and `user_id NOT NULL` this insert cannot
succeed today (it already fails and redirects to `?google=error`), so the Phase 7B grant tightening changes the
error code (RLS/not-null → `42501 permission denied`) but not the outcome. The route should be rewritten like the
GitHub/Slack callbacks (signed-in session + `user_id` + CSRF state) when Google Business is revisited; it is out of
scope for Phase 7B and was left untouched.

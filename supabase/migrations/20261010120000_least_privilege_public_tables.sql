-- Phase 7B-B: least-privilege table grants for the app's public tables.
--
-- WHY: Supabase's default privileges (plus earlier broad GRANTs) gave `anon` and `authenticated` TRUNCATE,
-- TRIGGER, REFERENCES and MAINTAIN on every table, and gave `anon` full read/write on integrations
-- (OAuth tokens), seo_settings and env_vars. TRUNCATE is NOT subject to row level security, and `anon`
-- never needs table access because every RLS policy is `auth.uid() = user_id` and every route requires login.
--
-- WHAT THIS CHANGES (and nothing else):
--   * anon:          ALL privileges removed on the 5 app tables.
--   * authenticated: TRUNCATE, TRIGGER, REFERENCES, MAINTAIN removed; the DML it already had is kept/re-asserted
--                    (select/insert/update/delete as listed below, exactly what the app's routes use).
--   * default privileges for objects created by `postgres` in schema public no longer hand
--     TRUNCATE/TRIGGER/REFERENCES/MAINTAIN to anon/authenticated on future tables.
-- RLS is NOT touched: policies stay, RLS stays enabled on every table.
-- service_role and postgres privileges are NOT touched.
-- Rollback: supabase/rollbacks/20261010120000_least_privilege_public_tables.rollback.sql

-- 1) anonymous role: no table access at all
revoke all privileges on table
  public.forgestudio_projects,
  public.forgestudio_project_versions,
  public.integrations,
  public.seo_settings,
  public.env_vars
from anon;

-- 2) signed-in role: drop the dangerous / unneeded privileges
revoke truncate, trigger, references, maintain on table
  public.forgestudio_projects,
  public.forgestudio_project_versions,
  public.integrations,
  public.seo_settings,
  public.env_vars
from authenticated;

-- 3) signed-in role: re-assert exactly the DML the app needs (idempotent; RLS still limits it to the owner's rows)
grant select, insert, update, delete on table public.forgestudio_projects     to authenticated;
grant select, insert, delete         on table public.forgestudio_project_versions to authenticated;
grant select, insert, update, delete on table public.integrations             to authenticated;
grant select, insert, update, delete on table public.seo_settings             to authenticated;
grant select, insert, update, delete on table public.env_vars                 to authenticated;

-- 4) future tables created by postgres (what migrations run as) must not inherit the dangerous privileges.
--    Each new table now needs an explicit GRANT for the roles that should use it.
alter default privileges for role postgres in schema public
  revoke truncate, references, trigger, maintain on tables from anon, authenticated;

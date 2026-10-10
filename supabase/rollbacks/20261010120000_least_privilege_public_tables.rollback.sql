-- Rollback for 20261010120000_least_privilege_public_tables.sql
-- Restores the EXACT table privileges (grantor postgres) that existed before Phase 7B-B, as audited on 2026-10-10,
-- and the previous default privileges. NOT in supabase/migrations on purpose: it must never be applied automatically.
-- Restoring these re-opens TRUNCATE/TRIGGER/REFERENCES/MAINTAIN and anon access; use only to recover from a break.

-- anon (before)
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.env_vars                      to anon;
grant maintain, references, trigger, truncate                                  on table public.forgestudio_project_versions to anon;
grant insert, maintain, references, select, trigger, truncate                  on table public.forgestudio_projects         to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.integrations                  to anon;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.seo_settings                  to anon;

-- authenticated (before)
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.env_vars                      to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate         on table public.forgestudio_project_versions to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.forgestudio_projects         to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.integrations                  to authenticated;
grant delete, insert, maintain, references, select, trigger, truncate, update on table public.seo_settings                  to authenticated;

-- default privileges (before): postgres-created tables in public granted anon/authenticated (and service_role) Dxtm
alter default privileges for role postgres in schema public
  grant truncate, references, trigger, maintain on tables to anon, authenticated;

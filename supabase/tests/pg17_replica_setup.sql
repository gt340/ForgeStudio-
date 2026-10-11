-- Phase 7B release gates: DISPOSABLE REPLICA of the production database shape, for a throw-away PostgreSQL 17 container.
-- Run as the container's bootstrap superuser (supabase_admin) against database `app`. Never run against production.
--
-- It copies what the audit measured on production (2026-10-11, PostgreSQL 17.6):
--   * roles: supabase_admin = superuser; postgres = NOT superuser (createrole, createdb, bypassrls), NOT a member of
--     supabase_admin; anon / authenticated / service_role; authenticator. postgres has admin on the API roles.
--   * schema public: owner pg_database_owner, USAGE for the API roles, no CREATE for anon/authenticated.
--   * default privileges: postgres in public (tables): anon/authenticated/service_role = Dxtm;
--     supabase_admin in public (tables): postgres/anon/authenticated/service_role = arwdDxtm.
--   * the five app tables with the same columns, FKs, unique key, owner-only RLS policies and the exact table ACLs.
--   * public.rls_auto_enable() (SECURITY DEFINER, search_path pg_catalog, owner postgres, no explicit ACL) and the
--     `ensure_rls` event trigger. Deviation: PostgreSQL only lets a superuser own an event trigger, so here the trigger
--     is owned by supabase_admin (on production it reports postgres). The function itself is owned by postgres.

\set ON_ERROR_STOP on

-- ---------- roles
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create role authenticator login noinherit password 'authpw';
grant anon, authenticated, service_role to authenticator;
-- (role `postgres` and database `app` owned by it are created by the runner before this file, like on production)
grant anon, authenticated, service_role, authenticator to postgres with admin option;

-- ---------- auth schema stand-in (only what the app tables and policies need)
create schema auth;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;
grant usage on schema auth to anon, authenticated, service_role, postgres;
grant execute on function auth.uid() to anon, authenticated, service_role, postgres;
grant select on auth.users to postgres;
grant references on auth.users to postgres;

-- ---------- default privileges exactly as audited
alter default privileges for role supabase_admin in schema public
  grant all on tables to postgres, anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant truncate, references, trigger, maintain on tables to anon, authenticated, service_role;

-- public schema as on production: owner pg_database_owner, USAGE for the API roles
grant usage on schema public to postgres, anon, authenticated, service_role;

-- ---------- tables (owner postgres), same shape as production
set role postgres;

create table public.forgestudio_projects (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  prompt text, code text, preview_url text, sandbox_id text,
  user_id uuid not null references auth.users(id),
  github_owner text, github_repo text, github_repo_id bigint, github_default_branch text, github_repo_url text,
  github_last_commit_sha text, github_synced_at timestamptz,
  vercel_project_id text, vercel_project_name text, vercel_deployment_id text, vercel_deployment_url text,
  vercel_production_url text, vercel_last_status text, vercel_deployed_at timestamptz
);
create table public.forgestudio_project_versions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.forgestudio_projects(id) on delete cascade,
  user_id uuid not null references auth.users(id),
  version_number integer not null,
  code text not null, preview_url text, description text,
  created_at timestamptz not null default now()
);
create table public.integrations (
  id uuid primary key default gen_random_uuid(),
  provider text not null, status text not null default 'connected',
  created_at timestamptz default now(),
  access_token text, refresh_token text,
  user_id uuid not null references auth.users(id),
  github_login text, vercel_user_id text, vercel_team_id text,
  unique (user_id, provider)
);
create table public.seo_settings (
  id uuid primary key default gen_random_uuid(),
  meta_title text, meta_description text, og_image_url text, favicon_url text,
  created_at timestamptz default now(),
  user_id uuid not null references auth.users(id)
);
create table public.env_vars (
  id uuid primary key default gen_random_uuid(),
  key text not null, value text not null, environment text not null default 'production',
  created_at timestamptz default now(),
  user_id uuid not null references auth.users(id)
);

-- RLS: owner-only policies (roles = public) exactly as on production; versions has no UPDATE policy
alter table public.forgestudio_projects enable row level security;
alter table public.forgestudio_project_versions enable row level security;
alter table public.integrations enable row level security;
alter table public.seo_settings enable row level security;
alter table public.env_vars enable row level security;

do $$
declare t text;
begin
  foreach t in array array['forgestudio_projects','forgestudio_project_versions','integrations','seo_settings','env_vars'] loop
    execute format('create policy "Owner select" on public.%I for select using (auth.uid() = user_id)', t);
    execute format('create policy "Owner insert" on public.%I for insert with check (auth.uid() = user_id)', t);
    execute format('create policy "Owner delete" on public.%I for delete using (auth.uid() = user_id)', t);
    if t <> 'forgestudio_project_versions' then
      execute format('create policy "Owner update" on public.%I for update using (auth.uid() = user_id) with check (auth.uid() = user_id)', t);
    end if;
  end loop;
end $$;

-- exact production table ACLs (start from nothing, then grant the audited privilege lists)
revoke all on table public.forgestudio_projects, public.forgestudio_project_versions, public.integrations,
  public.seo_settings, public.env_vars from anon, authenticated, service_role;

-- env_vars / integrations / seo_settings: anon arwdDxtm, authenticated arwdDxtm, service_role Dxtm
grant select, insert, update, delete, truncate, references, trigger, maintain
  on public.env_vars, public.integrations, public.seo_settings to anon;
grant select, insert, update, delete, truncate, references, trigger, maintain
  on public.env_vars, public.integrations, public.seo_settings to authenticated;
grant truncate, references, trigger, maintain
  on public.env_vars, public.integrations, public.seo_settings to service_role;
-- forgestudio_projects: anon arDxtm (insert, select, Dxtm), authenticated arwdDxtm, service_role Dxtm
grant insert, select, truncate, references, trigger, maintain on public.forgestudio_projects to anon;
grant select, insert, update, delete, truncate, references, trigger, maintain on public.forgestudio_projects to authenticated;
grant truncate, references, trigger, maintain on public.forgestudio_projects to service_role;
-- forgestudio_project_versions: anon Dxtm, authenticated ardDxtm (insert, select, delete, Dxtm), service_role Dxtm
grant truncate, references, trigger, maintain on public.forgestudio_project_versions to anon;
grant insert, select, delete, truncate, references, trigger, maintain on public.forgestudio_project_versions to authenticated;
grant truncate, references, trigger, maintain on public.forgestudio_project_versions to service_role;

-- ---------- rls_auto_enable() + event trigger, definition copied from production
create function public.rls_auto_enable()
 returns event_trigger
 language plpgsql
 security definer
 set search_path to 'pg_catalog'
as $function$
declare
  cmd record;
begin
  for cmd in
    select *
    from pg_event_trigger_ddl_commands()
    where command_tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      and object_type in ('table','partitioned table')
  loop
     if cmd.schema_name is not null and cmd.schema_name in ('public') and cmd.schema_name not in ('pg_catalog','information_schema') and cmd.schema_name not like 'pg_toast%' and cmd.schema_name not like 'pg_temp%' then
      begin
        execute format('alter table if exists %s enable row level security', cmd.object_identity);
        raise log 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      exception
        when others then
          raise log 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      end;
     else
        raise log 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     end if;
  end loop;
end;
$function$;

reset role;
create event trigger ensure_rls on ddl_command_end
  when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
  execute function public.rls_auto_enable();

-- fixtures used by supabase/tests/least_privilege_migration_test.sql (placeholder ids in that file)
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000002', 'owner@example.test'),
  ('00000000-0000-0000-0000-000000000003', 'other@example.test');

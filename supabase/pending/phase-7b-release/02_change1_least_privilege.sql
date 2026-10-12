-- PRODUCTION CHANGE 1: least-privilege grants on the 5 app tables. NOT EXECUTED. Needs the Commander's explicit authorization.
-- Source of the statements: supabase/pending/20261010120000_least_privilege_public_tables.sql (identical statements).
-- Run as `postgres` through the Supabase MCP `apply_migration` (name: least_privilege_public_tables) or the SQL editor.
-- ATOMIC: preflight assertions -> snapshot -> change -> post-assertions, in ONE transaction. Any failed assertion raises
-- an exception, the whole transaction is rolled back and NOTHING changes. Success = the call returns without error.
-- Expected strings are PostgreSQL 17 ACL text (MAINTAIN = letter m).

begin;
set local lock_timeout = '5s';        -- fail fast instead of queueing behind another session
set local statement_timeout = '60s';

-- A. PREFLIGHT ASSERTIONS (state must equal what was audited on 2026-10-11)
do $preflight$
declare
  t text; exp text[]; got aclitem[]; own text; rls boolean; n bigint; snap jsonb;
begin
  if current_user <> 'postgres' then raise exception '%: must run as postgres, running as %', 'PREFLIGHT', current_user; end if;
  if (select rolsuper from pg_roles where rolname = current_user) then raise exception '%: postgres must not be superuser', 'PREFLIGHT'; end if;
  if current_setting('server_version_num')::int not between 170000 and 179999 then
    raise exception '%: expected PostgreSQL 17, got %', 'PREFLIGHT', current_setting('server_version'); end if;
  select count(*) into n from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r', 'p');
  if n <> 5 then raise exception '%: expected exactly 5 tables in schema public, found %', 'PREFLIGHT', n; end if;

  for t, exp in
    select v.t, v.e from (values
    ('env_vars', array['postgres=arwdDxtm/postgres','anon=arwdDxtm/postgres','authenticated=arwdDxtm/postgres','service_role=Dxtm/postgres']::text[]),
    ('forgestudio_project_versions', array['postgres=arwdDxtm/postgres','anon=Dxtm/postgres','authenticated=ardDxtm/postgres','service_role=Dxtm/postgres']::text[]),
    ('forgestudio_projects', array['postgres=arwdDxtm/postgres','anon=arDxtm/postgres','authenticated=arwdDxtm/postgres','service_role=Dxtm/postgres']::text[]),
    ('integrations', array['postgres=arwdDxtm/postgres','anon=arwdDxtm/postgres','authenticated=arwdDxtm/postgres','service_role=Dxtm/postgres']::text[]),
    ('seo_settings', array['postgres=arwdDxtm/postgres','anon=arwdDxtm/postgres','authenticated=arwdDxtm/postgres','service_role=Dxtm/postgres']::text[])
    ) v(t, e)
  loop
    select c.relacl, pg_get_userbyid(c.relowner), c.relrowsecurity into got, own, rls
    from pg_class c where c.oid = ('public.' || t)::regclass;
    if own <> 'postgres' then raise exception 'PREFLIGHT: public.% is owned by % (expected postgres)', t, own; end if;
    if not rls then raise exception 'PREFLIGHT: RLS is OFF on public.%', t; end if;
    if (select coalesce(array_agg(x::text order by x::text), '{}'::text[]) from unnest(got) x)
       is distinct from (select array_agg(y order by y) from unnest(exp) y) then
      raise exception 'PREFLIGHT: ACL of public.% is % but expected %', t, got::text, exp::text;
    end if;
  end loop;
  select d.defaclacl into got from pg_default_acl d
   where d.defaclrole = 'postgres'::regrole and d.defaclnamespace = 'public'::regnamespace and d.defaclobjtype = 'r';
  if (select coalesce(array_agg(x::text order by x::text), '{}'::text[]) from unnest(got) x)
     is distinct from (select array_agg(y order by y) from unnest(array['postgres=arwdDxtm/postgres','anon=Dxtm/postgres','authenticated=Dxtm/postgres','service_role=Dxtm/postgres']::text[]) y) then
    raise exception 'PREFLIGHT: default ACL (postgres, public, tables) is % but expected %', got::text, array['postgres=arwdDxtm/postgres','anon=Dxtm/postgres','authenticated=Dxtm/postgres','service_role=Dxtm/postgres']::text[]::text;
  end if;
  select count(*) into n from pg_policies where schemaname = 'public';
  if n <> 19 then raise exception '%: expected 19 policies in public, found %', 'PREFLIGHT', n; end if;
  if (select md5(string_agg(format('%s|%s|%s|%s|%s|%s|%s', tablename, policyname, cmd, permissive, roles::text, coalesce(qual,''), coalesce(with_check,'')), E'\n' order by tablename, policyname)) from pg_policies where schemaname = 'public') <> '0e857fa80e4bec97dd561ac6e5415905' then raise exception '%: policy fingerprint differs from the recorded production value', 'PREFLIGHT'; end if;
  perform set_config('forge.snapshot', jsonb_build_object(
    'projects', (select count(*) from public.forgestudio_projects),
    'versions', (select count(*) from public.forgestudio_project_versions),
    'integrations', (select count(*) from public.integrations),
    'seo_settings', (select count(*) from public.seo_settings),
    'env_vars', (select count(*) from public.env_vars),
    'policies', (select count(*) from pg_policies where schemaname = 'public'),
    'policy_fp', (select md5(string_agg(format('%s|%s|%s|%s|%s|%s|%s', tablename, policyname, cmd, permissive, roles::text, coalesce(qual,''), coalesce(with_check,'')), E'\n' order by tablename, policyname)) from pg_policies where schemaname = 'public'),
    'rls', (select string_agg(relname || ':' || relrowsecurity::text, ',' order by relname) from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r', 'p'))
  )::text, true);
end
$preflight$;

-- B. THE CHANGE
revoke all privileges on table
  public.forgestudio_projects,
  public.forgestudio_project_versions,
  public.integrations,
  public.seo_settings,
  public.env_vars
from anon;

revoke truncate, trigger, references, maintain on table
  public.forgestudio_projects,
  public.forgestudio_project_versions,
  public.integrations,
  public.seo_settings,
  public.env_vars
from authenticated;

grant select, insert, update, delete on table public.forgestudio_projects            to authenticated;
grant select, insert, delete         on table public.forgestudio_project_versions    to authenticated;
grant select, insert, update, delete on table public.integrations                    to authenticated;
grant select, insert, update, delete on table public.seo_settings                    to authenticated;
grant select, insert, update, delete on table public.env_vars                        to authenticated;

alter default privileges for role postgres in schema public
  revoke truncate, references, trigger, maintain on tables from anon, authenticated;

-- C. POST-ASSERTIONS (exact PG17 ACLs, effective privileges, RLS, 19 policies, row counts unchanged)
do $postcheck$
declare
  t text; exp text[]; got aclitem[]; own text; rls boolean; n bigint; snap jsonb;
begin

  for t, exp in
    select v.t, v.e from (values
    ('env_vars', array['postgres=arwdDxtm/postgres','authenticated=arwd/postgres','service_role=Dxtm/postgres']::text[]),
    ('forgestudio_project_versions', array['postgres=arwdDxtm/postgres','authenticated=ard/postgres','service_role=Dxtm/postgres']::text[]),
    ('forgestudio_projects', array['postgres=arwdDxtm/postgres','authenticated=arwd/postgres','service_role=Dxtm/postgres']::text[]),
    ('integrations', array['postgres=arwdDxtm/postgres','authenticated=arwd/postgres','service_role=Dxtm/postgres']::text[]),
    ('seo_settings', array['postgres=arwdDxtm/postgres','authenticated=arwd/postgres','service_role=Dxtm/postgres']::text[])
    ) v(t, e)
  loop
    select c.relacl, pg_get_userbyid(c.relowner), c.relrowsecurity into got, own, rls
    from pg_class c where c.oid = ('public.' || t)::regclass;
    if own <> 'postgres' then raise exception 'POSTCHECK: public.% is owned by % (expected postgres)', t, own; end if;
    if not rls then raise exception 'POSTCHECK: RLS is OFF on public.%', t; end if;
    if (select coalesce(array_agg(x::text order by x::text), '{}'::text[]) from unnest(got) x)
       is distinct from (select array_agg(y order by y) from unnest(exp) y) then
      raise exception 'POSTCHECK: ACL of public.% is % but expected %', t, got::text, exp::text;
    end if;
  end loop;
  select d.defaclacl into got from pg_default_acl d
   where d.defaclrole = 'postgres'::regrole and d.defaclnamespace = 'public'::regnamespace and d.defaclobjtype = 'r';
  if (select coalesce(array_agg(x::text order by x::text), '{}'::text[]) from unnest(got) x)
     is distinct from (select array_agg(y order by y) from unnest(array['postgres=arwdDxtm/postgres','service_role=Dxtm/postgres']::text[]) y) then
    raise exception 'POSTCHECK: default ACL (postgres, public, tables) is % but expected %', got::text, array['postgres=arwdDxtm/postgres','service_role=Dxtm/postgres']::text[]::text;
  end if;
  -- effective privileges, not just ACL text
  select count(*) into n from pg_class c
    cross join (values ('anon'), ('authenticated')) r(rn)
    cross join unnest(array['TRUNCATE','TRIGGER','REFERENCES','MAINTAIN']) as p(priv)
   where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and has_table_privilege(r.rn, c.oid, p.priv);
  if n <> 0 then raise exception 'POSTCHECK: % prohibited privilege(s) (TRUNCATE/TRIGGER/REFERENCES/MAINTAIN) still held by anon/authenticated', n; end if;
  select count(*) into n from pg_class c
    cross join unnest(array['SELECT','INSERT','UPDATE','DELETE']) as p(priv)
   where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and has_table_privilege('anon', c.oid, p.priv);
  if n <> 0 then raise exception 'POSTCHECK: anon still has % table privilege(s)', n; end if;
  if not (has_table_privilege('authenticated', 'public.forgestudio_projects', 'SELECT,INSERT,UPDATE,DELETE')
      and has_table_privilege('authenticated', 'public.integrations', 'SELECT,INSERT,UPDATE,DELETE')
      and has_table_privilege('authenticated', 'public.seo_settings', 'SELECT,INSERT,UPDATE,DELETE')
      and has_table_privilege('authenticated', 'public.env_vars', 'SELECT,INSERT,UPDATE,DELETE')
      and has_table_privilege('authenticated', 'public.forgestudio_project_versions', 'SELECT,INSERT,DELETE')) then
    raise exception 'POSTCHECK: authenticated lost a DML privilege the app needs'; end if;
  if has_table_privilege('authenticated', 'public.forgestudio_project_versions', 'UPDATE') then
    raise exception 'POSTCHECK: authenticated unexpectedly has UPDATE on forgestudio_project_versions'; end if;
  select count(*) into n from pg_policies where schemaname = 'public';
  if n <> 19 then raise exception '%: expected 19 policies in public, found %', 'POSTCHECK', n; end if;
  if (select md5(string_agg(format('%s|%s|%s|%s|%s|%s|%s', tablename, policyname, cmd, permissive, roles::text, coalesce(qual,''), coalesce(with_check,'')), E'\n' order by tablename, policyname)) from pg_policies where schemaname = 'public') <> '0e857fa80e4bec97dd561ac6e5415905' then raise exception '%: policy fingerprint differs from the recorded production value', 'POSTCHECK'; end if;
  snap := current_setting('forge.snapshot')::jsonb;
  if snap <> jsonb_build_object(
    'projects', (select count(*) from public.forgestudio_projects),
    'versions', (select count(*) from public.forgestudio_project_versions),
    'integrations', (select count(*) from public.integrations),
    'seo_settings', (select count(*) from public.seo_settings),
    'env_vars', (select count(*) from public.env_vars),
    'policies', (select count(*) from pg_policies where schemaname = 'public'),
    'policy_fp', (select md5(string_agg(format('%s|%s|%s|%s|%s|%s|%s', tablename, policyname, cmd, permissive, roles::text, coalesce(qual,''), coalesce(with_check,'')), E'\n' order by tablename, policyname)) from pg_policies where schemaname = 'public'),
    'rls', (select string_agg(relname || ':' || relrowsecurity::text, ',' order by relname) from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r', 'p'))
  ) then raise exception 'POSTCHECK: row counts / RLS flags / policies changed. before=% ', snap::text; end if;
end
$postcheck$;

commit;

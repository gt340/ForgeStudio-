-- PRODUCTION ROLLBACK OF CHANGE 1 (re-opens TRUNCATE/TRIGGER/REFERENCES/MAINTAIN and anon access). NOT EXECUTED.
-- Use only to recover from a verified break. Same statements as supabase/rollbacks/20261010120000_least_privilege_public_tables.rollback.sql.
-- ATOMIC like the change: it first asserts Change 1 is in place, restores the audited ACLs, then asserts the ACLs are
-- exactly the pre-change values, and that RLS, the 19 policies and row counts are unchanged. Any failure rolls everything back.
-- If the precondition fails because the state differs from what Change 1 produced, stop and inspect before forcing anything.

begin;
set local lock_timeout = '5s';        -- fail fast instead of queueing behind another session
set local statement_timeout = '60s';

do $rb_pre$
declare
  t text; exp text[]; got aclitem[]; own text; rls boolean; n bigint; snap jsonb;
begin
  if current_user <> 'postgres' then raise exception '%: must run as postgres, running as %', 'ROLLBACK-PRECHECK', current_user; end if;
  if (select rolsuper from pg_roles where rolname = current_user) then raise exception '%: postgres must not be superuser', 'ROLLBACK-PRECHECK'; end if;
  if current_setting('server_version_num')::int not between 170000 and 179999 then
    raise exception '%: expected PostgreSQL 17, got %', 'ROLLBACK-PRECHECK', current_setting('server_version'); end if;
  select count(*) into n from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r', 'p');
  if n <> 5 then raise exception '%: expected exactly 5 tables in schema public, found %', 'ROLLBACK-PRECHECK', n; end if;

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
    if own <> 'postgres' then raise exception 'ROLLBACK-PRECHECK: public.% is owned by % (expected postgres)', t, own; end if;
    if not rls then raise exception 'ROLLBACK-PRECHECK: RLS is OFF on public.%', t; end if;
    if (select coalesce(array_agg(x::text order by x::text), '{}'::text[]) from unnest(got) x)
       is distinct from (select array_agg(y order by y) from unnest(exp) y) then
      raise exception 'ROLLBACK-PRECHECK: ACL of public.% is % but expected %', t, got::text, exp::text;
    end if;
  end loop;
  select d.defaclacl into got from pg_default_acl d
   where d.defaclrole = 'postgres'::regrole and d.defaclnamespace = 'public'::regnamespace and d.defaclobjtype = 'r';
  if (select coalesce(array_agg(x::text order by x::text), '{}'::text[]) from unnest(got) x)
     is distinct from (select array_agg(y order by y) from unnest(array['postgres=arwdDxtm/postgres','service_role=Dxtm/postgres']::text[]) y) then
    raise exception 'ROLLBACK-PRECHECK: default ACL (postgres, public, tables) is % but expected %', got::text, array['postgres=arwdDxtm/postgres','service_role=Dxtm/postgres']::text[]::text;
  end if;
  select count(*) into n from pg_policies where schemaname = 'public';
  if n <> 19 then raise exception '%: expected 19 policies in public, found %', 'ROLLBACK-PRECHECK', n; end if;
  if (select md5(string_agg(format('%s|%s|%s|%s|%s|%s|%s', tablename, policyname, cmd, permissive, roles::text, coalesce(qual,''), coalesce(with_check,'')), E'\n' order by tablename, policyname)) from pg_policies where schemaname = 'public') <> '0e857fa80e4bec97dd561ac6e5415905' then raise exception '%: policy fingerprint differs from the recorded production value', 'ROLLBACK-PRECHECK'; end if;
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
$rb_pre$;

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

do $rb_post$
declare
  t text; exp text[]; got aclitem[]; own text; rls boolean; n bigint; snap jsonb;
begin

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
    if own <> 'postgres' then raise exception 'ROLLBACK-POSTCHECK: public.% is owned by % (expected postgres)', t, own; end if;
    if not rls then raise exception 'ROLLBACK-POSTCHECK: RLS is OFF on public.%', t; end if;
    if (select coalesce(array_agg(x::text order by x::text), '{}'::text[]) from unnest(got) x)
       is distinct from (select array_agg(y order by y) from unnest(exp) y) then
      raise exception 'ROLLBACK-POSTCHECK: ACL of public.% is % but expected %', t, got::text, exp::text;
    end if;
  end loop;
  select d.defaclacl into got from pg_default_acl d
   where d.defaclrole = 'postgres'::regrole and d.defaclnamespace = 'public'::regnamespace and d.defaclobjtype = 'r';
  if (select coalesce(array_agg(x::text order by x::text), '{}'::text[]) from unnest(got) x)
     is distinct from (select array_agg(y order by y) from unnest(array['postgres=arwdDxtm/postgres','anon=Dxtm/postgres','authenticated=Dxtm/postgres','service_role=Dxtm/postgres']::text[]) y) then
    raise exception 'ROLLBACK-POSTCHECK: default ACL (postgres, public, tables) is % but expected %', got::text, array['postgres=arwdDxtm/postgres','anon=Dxtm/postgres','authenticated=Dxtm/postgres','service_role=Dxtm/postgres']::text[]::text;
  end if;
  select count(*) into n from pg_policies where schemaname = 'public';
  if n <> 19 then raise exception '%: expected 19 policies in public, found %', 'ROLLBACK-POSTCHECK', n; end if;
  if (select md5(string_agg(format('%s|%s|%s|%s|%s|%s|%s', tablename, policyname, cmd, permissive, roles::text, coalesce(qual,''), coalesce(with_check,'')), E'\n' order by tablename, policyname)) from pg_policies where schemaname = 'public') <> '0e857fa80e4bec97dd561ac6e5415905' then raise exception '%: policy fingerprint differs from the recorded production value', 'ROLLBACK-POSTCHECK'; end if;
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
  ) then raise exception 'ROLLBACK-POSTCHECK: row counts / RLS flags / policies changed. before=% ', snap::text; end if;
end
$rb_post$;

commit;

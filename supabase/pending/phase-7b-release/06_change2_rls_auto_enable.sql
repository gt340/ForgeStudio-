-- PRODUCTION CHANGE 2: revoke EXECUTE on public.rls_auto_enable() from public, anon, authenticated. NOT EXECUTED.
-- Apply only AFTER Change 1 is applied and verified, and only with the Commander's separate authorization.
-- Run as `postgres` with psql through the Supabase session pooler (psql -X -v ON_ERROR_STOP=1 -f <file>; no --single-transaction; password from a hidden prompt, never on the command line). Production execution must use psql; the MCP apply_migration / execute_sql routes are NOT verified.
-- ATOMIC: preflight assertions -> change -> post-assertions (+ probe) in ONE transaction; any failure rolls everything back.
-- The ensure_rls event trigger does not check the creating role's EXECUTE privilege (proven on PostgreSQL 17.6 in CI),
-- and the probe re-proves it on production inside the transaction.

begin;
set local lock_timeout = '5s';        -- fail fast instead of queueing behind another session
set local statement_timeout = '60s';

do $c2_pre$
declare
  fo oid; facl aclitem[]; own text; secdef boolean; cfg text[]; ret text; evf oid; evs text; n bigint; snap jsonb; t text; got aclitem[]; acl_txt text[];
begin
  if current_user <> 'postgres' then raise exception 'PREFLIGHT: must run as postgres, running as %', current_user; end if;
  if (select rolsuper from pg_roles where rolname = current_user) then raise exception 'PREFLIGHT: postgres must not be superuser'; end if;
  if current_setting('server_version_num')::int not between 170000 and 179999 then
    raise exception 'PREFLIGHT: expected PostgreSQL 17, got %', current_setting('server_version'); end if;
  select p.oid, p.proacl, pg_get_userbyid(p.proowner), p.prosecdef, p.proconfig, p.prorettype::regtype::text
    into fo, facl, own, secdef, cfg, ret
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'rls_auto_enable' and p.pronargs = 0;
  if fo is null then raise exception 'PREFLIGHT: public.rls_auto_enable() not found'; end if;
  if own <> 'postgres' or not secdef or ret <> 'event_trigger' or not (cfg @> array['search_path=pg_catalog']) then
    raise exception 'PREFLIGHT: rls_auto_enable() is not the audited function (owner %, secdef %, returns %, config %)', own, secdef, ret, cfg::text; end if;
  select evtfoid, evtenabled::text into evf, evs from pg_event_trigger where evtname = 'ensure_rls';
  if evf is distinct from fo or evs <> 'O' then
    raise exception 'PREFLIGHT: event trigger ensure_rls is missing, not enabled (%), or does not call rls_auto_enable()', evs; end if;
  -- audited value is NULL (= implicit PUBLIC execute); {postgres=X/postgres,=X/postgres} is the same effective state after a rollback of this change
  if facl is not null then
    select coalesce(array_agg(x::text), '{}'::text[]) into acl_txt from unnest(facl) x;
    if not (acl_txt @> array['postgres=X/postgres', '=X/postgres'] and acl_txt <@ array['postgres=X/postgres', '=X/postgres']) then
      raise exception 'PREFLIGHT: proacl is % (audited value: NULL = implicit PUBLIC execute)', facl::text; end if;
  end if;
  if not (has_function_privilege('anon', fo, 'EXECUTE') and has_function_privilege('authenticated', fo, 'EXECUTE')) then
    raise exception 'PREFLIGHT: anon/authenticated cannot execute it already; nothing to revoke, stop and investigate'; end if;
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
$c2_pre$;

revoke execute on function public.rls_auto_enable() from public, anon, authenticated;

do $c2_post$
declare
  fo oid; facl aclitem[]; own text; secdef boolean; cfg text[]; ret text; evf oid; evs text; n bigint; snap jsonb; t text; got aclitem[]; acl_txt text[];
  rls boolean;
begin
  if current_user <> 'postgres' then raise exception 'POSTCHECK: must run as postgres, running as %', current_user; end if;
  if (select rolsuper from pg_roles where rolname = current_user) then raise exception 'POSTCHECK: postgres must not be superuser'; end if;
  if current_setting('server_version_num')::int not between 170000 and 179999 then
    raise exception 'POSTCHECK: expected PostgreSQL 17, got %', current_setting('server_version'); end if;
  select p.oid, p.proacl, pg_get_userbyid(p.proowner), p.prosecdef, p.proconfig, p.prorettype::regtype::text
    into fo, facl, own, secdef, cfg, ret
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'rls_auto_enable' and p.pronargs = 0;
  if fo is null then raise exception 'POSTCHECK: public.rls_auto_enable() not found'; end if;
  if own <> 'postgres' or not secdef or ret <> 'event_trigger' or not (cfg @> array['search_path=pg_catalog']) then
    raise exception 'POSTCHECK: rls_auto_enable() is not the audited function (owner %, secdef %, returns %, config %)', own, secdef, ret, cfg::text; end if;
  select evtfoid, evtenabled::text into evf, evs from pg_event_trigger where evtname = 'ensure_rls';
  if evf is distinct from fo or evs <> 'O' then
    raise exception 'POSTCHECK: event trigger ensure_rls is missing, not enabled (%), or does not call rls_auto_enable()', evs; end if;
  select p.proacl into facl from pg_proc p where p.oid = fo;
  if (select coalesce(array_agg(x::text order by x::text), '{}'::text[]) from unnest(facl) x) is distinct from array['postgres=X/postgres']::text[] then
    raise exception 'POSTCHECK: proacl is % (expected only the owner: {postgres=X/postgres})', facl::text; end if;
  if has_function_privilege('anon', fo, 'EXECUTE') or has_function_privilege('authenticated', fo, 'EXECUTE')
     or has_function_privilege('service_role', fo, 'EXECUTE') then
    raise exception 'POSTCHECK: an API role can still execute rls_auto_enable()'; end if;
  if exists (select 1 from aclexplode(facl) a where a.grantee = 0) then raise exception 'POSTCHECK: PUBLIC can still execute rls_auto_enable()'; end if;
  if not has_function_privilege('postgres', fo, 'EXECUTE') then raise exception 'POSTCHECK: owner lost EXECUTE'; end if;
  select evtfoid, evtenabled::text into evf, evs from pg_event_trigger where evtname = 'ensure_rls';
  if evf is distinct from fo or evs <> 'O' then raise exception 'POSTCHECK: ensure_rls trigger changed'; end if;
  -- PROBE (net zero change): prove the RLS auto-enable trigger still works after the revoke. Creates and drops a table in
  -- the same transaction; if RLS is not switched on automatically the whole change rolls back. Delete this block to skip it.
  create table public._rls_gate_probe (id int);
  select c.relrowsecurity into rls from pg_class c where c.oid = 'public._rls_gate_probe'::regclass;
  drop table public._rls_gate_probe;
  if rls is distinct from true then raise exception 'POSTCHECK: event trigger did NOT enable RLS on a new table after the revoke'; end if;
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
$c2_post$;

commit;

-- VERIFY CHANGE 2 (READ-ONLY, one SELECT). Run right after Change 2 commits. Every row must be PASS.
-- Expected now: the monitor returns ZERO violation rows (all six counts 0).
with
viol as (
  select "check", count(*)::int as c from (
with tbl as (
  select c.oid, c.relname, c.relrowsecurity, pg_get_userbyid(c.relowner) as owner
  from pg_class c
  where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
),
roles as (select unnest(array['anon', 'authenticated']) as rolname)
-- 1) never TRUNCATE / TRIGGER / REFERENCES / MAINTAIN for anon or authenticated (TRUNCATE ignores RLS)
select 'PROHIBITED_PRIVILEGE' as "check", r.rolname as role, t.relname as object, p.priv as detail
from tbl t cross join roles r cross join (values ('TRUNCATE'), ('TRIGGER'), ('REFERENCES'), ('MAINTAIN')) p(priv)
where has_table_privilege(r.rolname, t.oid, p.priv)
union all
-- 2) anon has no table access at all
select 'ANON_TABLE_ACCESS', 'anon', t.relname, p.priv
from tbl t cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) p(priv)
where has_table_privilege('anon', t.oid, p.priv)
union all
-- 3) row level security must be enabled on every public table
select 'RLS_DISABLED', '-', t.relname, 'owner=' || t.owner from tbl t where not t.relrowsecurity
union all
-- 4) every public table should be owned by postgres (supabase_admin-owned tables inherit supabase_admin's defaults)
select 'NON_POSTGRES_OWNER', t.owner, t.relname, 'owned by ' || t.owner || ': inherits that role''s default privileges and is invisible to the RLS auto-enable trigger'
from tbl t where t.owner <> 'postgres'
union all
-- 5) postgres' own default privileges for future tables must not hand out the dangerous privileges
select 'FUTURE_TABLE_DEFAULT', pg_get_userbyid(a.grantee), 'default privileges (postgres, schema public)', a.privilege_type
from pg_default_acl d cross join lateral aclexplode(d.defaclacl) a
where d.defaclnamespace = 'public'::regnamespace and d.defaclobjtype = 'r'
  and pg_get_userbyid(d.defaclrole) = 'postgres'
  and pg_get_userbyid(a.grantee) in ('anon', 'authenticated')
  and a.privilege_type in ('TRUNCATE', 'TRIGGER', 'REFERENCES', 'MAINTAIN')
union all
-- 6) no SECURITY DEFINER function in public may be executable by anon / authenticated via /rest/v1/rpc
select 'SECDEF_FUNCTION_EXECUTABLE', r.rolname, p.oid::regprocedure::text, 'SECURITY DEFINER, owner ' || pg_get_userbyid(p.proowner)
from pg_proc p cross join roles r
where p.pronamespace = 'public'::regnamespace and p.prosecdef and has_function_privilege(r.rolname, p.oid, 'EXECUTE')
  ) v group by 1
)
select n, chk, expected, actual,
  case when expected = 'INFO' then 'INFO' when expected = actual then 'PASS' else 'FAIL' end as result
from (
select 1 as n, 'role / superuser' as chk, 'postgres/false' as expected, current_user || '/' || (select rolsuper::text from pg_roles where rolname = current_user) as actual
  union all select 2, 'PostgreSQL major version', '17', (current_setting('server_version_num')::int / 10000)::text
  union all select 3, 'server_version (informational)', 'INFO', current_setting('server_version')
  union all select 4, 'anon can execute rls_auto_enable()', 'false', has_function_privilege('anon', 'public.rls_auto_enable()', 'EXECUTE')::text
  union all select 5, 'authenticated can execute rls_auto_enable()', 'false', has_function_privilege('authenticated', 'public.rls_auto_enable()', 'EXECUTE')::text
  union all select 6, 'postgres (owner) can execute rls_auto_enable()', 'true', has_function_privilege('postgres', 'public.rls_auto_enable()', 'EXECUTE')::text
  union all select 7, 'rls_auto_enable() proacl', '{postgres=X/postgres}', (select p.proacl::text from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'rls_auto_enable' and p.pronargs = 0)
  union all select 8, 'ensure_rls event trigger enabled', 'O', (select evtenabled::text from pg_event_trigger where evtname = 'ensure_rls')
  union all select 9, 'ensure_rls calls public.rls_auto_enable()', 'true', (select (evtfoid = 'public.rls_auto_enable()'::regprocedure)::text from pg_event_trigger where evtname = 'ensure_rls')
  union all select 10, 'leftover probe table', '0', (select count(*)::text from pg_class where relnamespace = 'public'::regnamespace and relname = '_rls_gate_probe')
  union all select 11, 'RLS enabled on all public tables', 'true', (select bool_and(relrowsecurity)::text from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r', 'p'))
  union all select 12, 'policies in public', '19', (select count(*)::text from pg_policies where schemaname = 'public')
  union all select 13, 'policy fingerprint', '0e857fa80e4bec97dd561ac6e5415905', (select md5(string_agg(format('%s|%s|%s|%s|%s|%s|%s', tablename, policyname, cmd, permissive, roles::text, coalesce(qual,''), coalesce(with_check,'')), E'\n' order by tablename, policyname)) from pg_policies where schemaname = 'public')
  union all select 14, 'row counts projects,versions,integrations,seo,env_vars: compare with the PREFLIGHT output', 'INFO', (select count(*) from public.forgestudio_projects)::text || ',' || (select count(*) from public.forgestudio_project_versions) || ',' || (select count(*) from public.integrations) || ',' || (select count(*) from public.seo_settings) || ',' || (select count(*) from public.env_vars)
  union all select 20, 'monitor ANON_TABLE_ACCESS rows', '0', coalesce((select c::text from viol where "check" = 'ANON_TABLE_ACCESS'), '0')
  union all select 21, 'monitor FUTURE_TABLE_DEFAULT rows', '0', coalesce((select c::text from viol where "check" = 'FUTURE_TABLE_DEFAULT'), '0')
  union all select 22, 'monitor NON_POSTGRES_OWNER rows', '0', coalesce((select c::text from viol where "check" = 'NON_POSTGRES_OWNER'), '0')
  union all select 23, 'monitor PROHIBITED_PRIVILEGE rows', '0', coalesce((select c::text from viol where "check" = 'PROHIBITED_PRIVILEGE'), '0')
  union all select 24, 'monitor RLS_DISABLED rows', '0', coalesce((select c::text from viol where "check" = 'RLS_DISABLED'), '0')
  union all select 25, 'monitor SECDEF_FUNCTION_EXECUTABLE rows', '0', coalesce((select c::text from viol where "check" = 'SECDEF_FUNCTION_EXECUTABLE'), '0')
) r order by n;

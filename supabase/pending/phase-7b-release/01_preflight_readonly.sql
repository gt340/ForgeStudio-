-- PRODUCTION PREFLIGHT (READ-ONLY, one SELECT; changes nothing). Run with psql through the Supabase session pooler (psql -X -v ON_ERROR_STOP=1 -f <file>; no --single-transaction; password from a hidden prompt, never on the command line) immediately before Change 1.
-- Every row must say PASS (INFO rows are for the record). SAVE THE OUTPUT: it is the recovery record and the row-count baseline.
-- Any FAIL = stop, do not run Change 1; report the row.
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
  union all select 4, 'ACL public.env_vars', 'anon=arwdDxtm/postgres,authenticated=arwdDxtm/postgres,postgres=arwdDxtm/postgres,service_role=Dxtm/postgres', (select coalesce(string_agg(x::text, ',' order by x::text), 'NULL') from pg_class c, unnest(c.relacl) x where c.oid = 'public.env_vars'::regclass)
  union all select 5, 'ACL public.forgestudio_project_versions', 'anon=Dxtm/postgres,authenticated=ardDxtm/postgres,postgres=arwdDxtm/postgres,service_role=Dxtm/postgres', (select coalesce(string_agg(x::text, ',' order by x::text), 'NULL') from pg_class c, unnest(c.relacl) x where c.oid = 'public.forgestudio_project_versions'::regclass)
  union all select 6, 'ACL public.forgestudio_projects', 'anon=arDxtm/postgres,authenticated=arwdDxtm/postgres,postgres=arwdDxtm/postgres,service_role=Dxtm/postgres', (select coalesce(string_agg(x::text, ',' order by x::text), 'NULL') from pg_class c, unnest(c.relacl) x where c.oid = 'public.forgestudio_projects'::regclass)
  union all select 7, 'ACL public.integrations', 'anon=arwdDxtm/postgres,authenticated=arwdDxtm/postgres,postgres=arwdDxtm/postgres,service_role=Dxtm/postgres', (select coalesce(string_agg(x::text, ',' order by x::text), 'NULL') from pg_class c, unnest(c.relacl) x where c.oid = 'public.integrations'::regclass)
  union all select 8, 'ACL public.seo_settings', 'anon=arwdDxtm/postgres,authenticated=arwdDxtm/postgres,postgres=arwdDxtm/postgres,service_role=Dxtm/postgres', (select coalesce(string_agg(x::text, ',' order by x::text), 'NULL') from pg_class c, unnest(c.relacl) x where c.oid = 'public.seo_settings'::regclass)
  union all select 9, 'default ACL (postgres, public, tables)', 'anon=Dxtm/postgres,authenticated=Dxtm/postgres,postgres=arwdDxtm/postgres,service_role=Dxtm/postgres', (select coalesce(string_agg(x::text, ',' order by x::text), 'NULL') from pg_default_acl d, unnest(d.defaclacl) x where d.defaclrole = 'postgres'::regrole and d.defaclnamespace = 'public'::regnamespace and d.defaclobjtype = 'r')
  union all select 10, 'tables in schema public', '5', (select count(*)::text from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r', 'p'))
  union all select 11, 'RLS enabled on all public tables', 'true', (select bool_and(relrowsecurity)::text from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r', 'p'))
  union all select 12, 'policies in public', '19', (select count(*)::text from pg_policies where schemaname = 'public')
  union all select 13, 'policy fingerprint', '0e857fa80e4bec97dd561ac6e5415905', (select md5(string_agg(format('%s|%s|%s|%s|%s|%s|%s', tablename, policyname, cmd, permissive, roles::text, coalesce(qual,''), coalesce(with_check,'')), E'\n' order by tablename, policyname)) from pg_policies where schemaname = 'public')
  union all select 20, 'row counts projects,versions,integrations,seo,env_vars (INFO: save)', 'INFO', (select count(*) from public.forgestudio_projects)::text || ',' || (select count(*) from public.forgestudio_project_versions) || ',' || (select count(*) from public.integrations) || ',' || (select count(*) from public.seo_settings) || ',' || (select count(*) from public.env_vars)
  union all select 21, 'active other sessions on this database', '0', (select count(*)::text from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and state <> 'idle')
  union all select 22, 'history rows named least_privilege_public_tables', '0', (select count(*)::text from supabase_migrations.schema_migrations where name = 'least_privilege_public_tables')
  union all select 23, 'rls_auto_enable() proacl (NULL = implicit PUBLIC execute)', 'NULL', (select coalesce(p.proacl::text, 'NULL') from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'rls_auto_enable' and p.pronargs = 0)
  union all select 24, 'ensure_rls event trigger enabled', 'O', (select evtenabled::text from pg_event_trigger where evtname = 'ensure_rls')
  union all select 14, 'monitor ANON_TABLE_ACCESS rows', '14', coalesce((select c::text from viol where "check" = 'ANON_TABLE_ACCESS'), '0')
  union all select 15, 'monitor FUTURE_TABLE_DEFAULT rows', '8', coalesce((select c::text from viol where "check" = 'FUTURE_TABLE_DEFAULT'), '0')
  union all select 16, 'monitor NON_POSTGRES_OWNER rows', '0', coalesce((select c::text from viol where "check" = 'NON_POSTGRES_OWNER'), '0')
  union all select 17, 'monitor PROHIBITED_PRIVILEGE rows', '40', coalesce((select c::text from viol where "check" = 'PROHIBITED_PRIVILEGE'), '0')
  union all select 18, 'monitor RLS_DISABLED rows', '0', coalesce((select c::text from viol where "check" = 'RLS_DISABLED'), '0')
  union all select 19, 'monitor SECDEF_FUNCTION_EXECUTABLE rows', '2', coalesce((select c::text from viol where "check" = 'SECDEF_FUNCTION_EXECUTABLE'), '0')
) r order by n;

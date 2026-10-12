-- ForgeStudio ongoing control: public tables / functions with excessive privileges or without RLS.
-- READ-ONLY (a single SELECT; changes nothing). EXPECTED RESULT: ZERO ROWS.  Run it:
--   * after every migration or dashboard SQL change that touches schema public, and
--   * on a schedule (at least weekly) -- see docs/PHASE-7B-PRODUCTION-CHANGE-PLAN.md, section "Control for supabase_admin defaults".
-- Every table in schema public is checked, not only today's five, so a table added later is covered.
--
-- Why this exists: tables created by the role `supabase_admin` (e.g. by the platform or an extension) inherit
-- supabase_admin's default privileges (arwdDxtm for anon/authenticated/service_role). A migration run as `postgres`
-- cannot change those defaults (postgres is not a member of supabase_admin, error 42501), so detection is the control.
-- The RLS auto-enable event trigger runs as postgres and cannot alter a table owned by supabase_admin, so such a
-- table also arrives with RLS OFF.

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
where p.pronamespace = 'public'::regnamespace and p.prosecdef and has_function_privilege(r.rolname, p.oid, 'EXECUTE');

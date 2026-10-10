-- ForgeStudio database access checks (Phase 7 / 7A / 7B).
-- PART 1 (below): owner-only RLS + delete behaviour probe.  PART 2 (end of file): prohibited-privilege and
-- future-table-default check (read-only query; expected result: ZERO rows).
-- NOT run by CI: it needs a real Supabase database. Run it manually in the Supabase SQL editor or via the
-- Supabase MCP. It creates a throw-away fixture project INSIDE the transaction and the final RAISE EXCEPTION
-- rolls everything back, so no real project is ever deleted or changed.
-- Replace owner_id / other_id with two existing, different user ids.
--
-- Expected output (the error text IS the result):
--   fixture_inserted=true;
--   ANON_delete_blocked=permission denied for table forgestudio_projects;
--   B_delete_rows=0; B_delete_all_owner_rows=0; B_hijack_update_rows=0; B_delete_after_hijack_rows=0; B_select_rows=0;
--   OWNER_fixture_still_exists=1; OWNER_update_rows=1; OWNER_delete_rows=1; OWNER_fixture_after_delete=0;
--   real_projects_before=N after=N   (identical: nothing real was touched)

do $$
declare
  r text := '';
  n int;
  fid uuid;
  owner_id text := '00000000-0000-0000-0000-000000000002';
  other_id text := '00000000-0000-0000-0000-000000000003';
  real_before int;
  real_after int;
begin
  select count(*) into real_before from forgestudio_projects;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', owner_id, true);
  insert into forgestudio_projects (user_id, prompt, code) values (owner_id::uuid, 'RLS-TEST-FIXTURE', 'x') returning id into fid;
  r := r || 'fixture_inserted=' || (fid is not null) || '; ';
  reset role;

  -- ANONYMOUS
  begin
    set local role anon;
    delete from forgestudio_projects where id = fid;
    get diagnostics n = row_count;
    r := r || 'ANON_delete_rows=' || n || '; ';
  exception when others then r := r || 'ANON_delete_blocked=' || sqlerrm || '; ';
  end;
  reset role;

  -- USER B (another authenticated user), including an attempt to take over the row first
  begin
    set local role authenticated;
    perform set_config('request.jwt.claim.sub', other_id, true);
    delete from forgestudio_projects where id = fid;
    get diagnostics n = row_count;
    r := r || 'B_delete_rows=' || n || '; ';
    delete from forgestudio_projects where user_id = owner_id::uuid;
    get diagnostics n = row_count;
    r := r || 'B_delete_all_owner_rows=' || n || '; ';
    update forgestudio_projects set user_id = other_id::uuid where id = fid;
    get diagnostics n = row_count;
    r := r || 'B_hijack_update_rows=' || n || '; ';
    delete from forgestudio_projects where id = fid;
    get diagnostics n = row_count;
    r := r || 'B_delete_after_hijack_rows=' || n || '; ';
    select count(*) into n from forgestudio_projects;
    r := r || 'B_select_rows=' || n || '; ';
  exception when others then r := r || 'B_error=' || sqlerrm || '; ';
  end;
  reset role;

  -- OWNER
  begin
    set local role authenticated;
    perform set_config('request.jwt.claim.sub', owner_id, true);
    select count(*) into n from forgestudio_projects where id = fid;
    r := r || 'OWNER_fixture_still_exists=' || n || '; ';
    update forgestudio_projects set github_owner = 'rls-probe' where id = fid;
    get diagnostics n = row_count;
    r := r || 'OWNER_update_rows=' || n || '; ';
    delete from forgestudio_projects where id = fid;
    get diagnostics n = row_count;
    r := r || 'OWNER_delete_rows=' || n || '; ';
    select count(*) into n from forgestudio_projects where id = fid;
    r := r || 'OWNER_fixture_after_delete=' || n || '; ';
  exception when others then r := r || 'OWNER_error=' || sqlerrm || '; ';
  end;
  reset role;

  select count(*) into real_after from forgestudio_projects;
  r := r || 'real_projects_before=' || real_before || ' after=' || real_after || '; ';
  raise exception 'PROBE %', r;
end $$;


-- =====================================================================================================
-- PART 2 (Phase 7B-B): prohibited privileges, anonymous access, required privileges, RLS, future-table defaults.
-- READ-ONLY (changes nothing). Run it as a separate statement. EXPECTED RESULT: ZERO ROWS.
-- Any row is a violation: `check` names the rule, the other columns say which role/table/privilege broke it.
-- Covers EVERY table in schema public (not just today's five), so a table added later is checked too.
-- =====================================================================================================
with tbl as (
  select c.oid, c.relname, c.relrowsecurity
  from pg_class c
  where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
),
roles as (select unnest(array['anon', 'authenticated']) as rolname),
default_acl as (
  select a.privilege_type, pg_get_userbyid(a.grantee) as grantee
  from pg_default_acl d
  cross join lateral aclexplode(d.defaclacl) a
  where d.defaclnamespace = 'public'::regnamespace
    and d.defaclobjtype = 'r'
    and pg_get_userbyid(d.defaclrole) = 'postgres'   -- migrations (and the SQL editor / MCP) run as postgres
)
-- 1) never hand out TRUNCATE / TRIGGER / REFERENCES / MAINTAIN to anon or authenticated
select 'PROHIBITED_PRIVILEGE' as "check", r.rolname as role, t.relname as object, p.priv as detail
from tbl t cross join roles r cross join (values ('TRUNCATE'), ('TRIGGER'), ('REFERENCES'), ('MAINTAIN')) p(priv)
where has_table_privilege(r.rolname, t.oid, p.priv)
union all
-- 2) anon has NO table access (every policy needs auth.uid(), so anon can never use a row anyway)
select 'ANON_TABLE_ACCESS', 'anon', t.relname, p.priv
from tbl t cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) p(priv)
where has_table_privilege('anon', t.oid, p.priv)
union all
-- 3) authenticated keeps the minimum DML the app needs (a missing GRANT = "permission denied" even with RLS policies)
select 'AUTHENTICATED_MISSING_REQUIRED', 'authenticated', req.t, req.priv
from (values
  ('forgestudio_projects', 'SELECT'), ('forgestudio_projects', 'INSERT'), ('forgestudio_projects', 'UPDATE'), ('forgestudio_projects', 'DELETE'),
  ('forgestudio_project_versions', 'SELECT'), ('forgestudio_project_versions', 'INSERT'),
  ('integrations', 'SELECT'), ('integrations', 'INSERT'), ('integrations', 'UPDATE'), ('integrations', 'DELETE'),
  ('seo_settings', 'SELECT'), ('seo_settings', 'INSERT'), ('seo_settings', 'UPDATE'), ('seo_settings', 'DELETE'),
  ('env_vars', 'SELECT'), ('env_vars', 'INSERT'), ('env_vars', 'UPDATE'), ('env_vars', 'DELETE')
) req(t, priv)
where not has_table_privilege('authenticated', ('public.' || req.t)::regclass, req.priv)
union all
-- 4) row level security stays enabled everywhere
select 'RLS_DISABLED', '-', t.relname, '-' from tbl t where not t.relrowsecurity
union all
-- 5) future tables created by postgres must not inherit the dangerous privileges
select 'FUTURE_TABLE_DEFAULT', d.grantee, 'default privileges (postgres, schema public)', d.privilege_type
from default_acl d
where d.grantee in ('anon', 'authenticated') and d.privilege_type in ('TRUNCATE', 'TRIGGER', 'REFERENCES', 'MAINTAIN');

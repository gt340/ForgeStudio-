-- Phase 7B-B controlled test of 20261010120000_least_privilege_public_tables.sql AND its rollback.
-- Runs everything inside ONE DO block that always ends in RAISE EXCEPTION, so the whole transaction (migration,
-- fixtures, rollback) is discarded: nothing is changed permanently. The error text IS the result.
-- It: snapshots the ACLs -> applies the forward migration -> asserts the privilege matrix + owner-only RLS
-- behaviour as anon / other user / owner -> proves future tables get no privileges -> applies the ROLLBACK
-- -> asserts the ACLs are byte-identical to the snapshot.
-- Replace owner_id / other_id with two existing, different user ids.

do $$
declare
  r text := '';
  n int;
  t text;
  p text;
  bad text;
  owner_id text := '00000000-0000-0000-0000-000000000002';
  other_id text := '00000000-0000-0000-0000-000000000003';
  tabs text[] := array['forgestudio_projects','forgestudio_project_versions','integrations','seo_settings','env_vars'];
  snap_tables text;
  snap_defaults text;
  after_tables text;
  after_defaults text;
  fid uuid;
  pid uuid;
begin
  -- ---- 0) snapshot (exact ACL text, per table + default ACL entries)
  select string_agg(x.k, ' | ' order by x.k) into snap_tables from (
      select c.relname || ':' || case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end || ':' || pg_get_userbyid(a.grantor) || ':' || a.privilege_type || ':' || a.is_grantable as k
      from pg_class c cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
      where c.relnamespace = 'public'::regnamespace and c.relkind = 'r') x;
  select string_agg(x.k, ' | ' order by x.k) into snap_defaults from (
      select pg_get_userbyid(d.defaclrole) || ':' || d.defaclobjtype::text || ':' || case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end || ':' || a.privilege_type as k
      from pg_default_acl d cross join lateral aclexplode(d.defaclacl) a
      where d.defaclnamespace = 'public'::regnamespace) x;

  select count(*) into n from pg_class c cross join (values ('TRUNCATE'),('TRIGGER'),('REFERENCES'),('MAINTAIN')) x(pv)
    cross join (values ('anon'),('authenticated')) ro(rn)
    where c.relnamespace='public'::regnamespace and c.relkind='r' and has_table_privilege(ro.rn, c.oid, x.pv);
  r := r || 'BEFORE_prohibited_privilege_count=' || n || '; ';

  -- ---- 1) apply the forward migration (verbatim statements)
  revoke all privileges on table public.forgestudio_projects, public.forgestudio_project_versions, public.integrations, public.seo_settings, public.env_vars from anon;
  revoke truncate, trigger, references, maintain on table public.forgestudio_projects, public.forgestudio_project_versions, public.integrations, public.seo_settings, public.env_vars from authenticated;
  grant select, insert, update, delete on table public.forgestudio_projects     to authenticated;
  grant select, insert, delete         on table public.forgestudio_project_versions to authenticated;
  grant select, insert, update, delete on table public.integrations             to authenticated;
  grant select, insert, update, delete on table public.seo_settings             to authenticated;
  grant select, insert, update, delete on table public.env_vars                 to authenticated;
  alter default privileges for role postgres in schema public revoke truncate, references, trigger, maintain on tables from anon, authenticated;

  -- ---- 2) privilege matrix after migration
  bad := '';
  foreach t in array tabs loop
    foreach p in array array['TRUNCATE','TRIGGER','REFERENCES','MAINTAIN','SELECT','INSERT','UPDATE','DELETE'] loop
      if has_table_privilege('anon', ('public.'||t)::regclass, p) then bad := bad || 'anon:' || t || ':' || p || ' '; end if;
    end loop;
    foreach p in array array['TRUNCATE','TRIGGER','REFERENCES','MAINTAIN'] loop
      if has_table_privilege('authenticated', ('public.'||t)::regclass, p) then bad := bad || 'authenticated:' || t || ':' || p || ' '; end if;
    end loop;
  end loop;
  r := r || 'AFTER_forbidden_privileges_still_present=[' || bad || ']; ';

  bad := '';
  foreach t in array array['forgestudio_projects','integrations','seo_settings','env_vars'] loop
    foreach p in array array['SELECT','INSERT','UPDATE','DELETE'] loop
      if not has_table_privilege('authenticated', ('public.'||t)::regclass, p) then bad := bad || t || ':' || p || ' '; end if;
    end loop;
  end loop;
  foreach p in array array['SELECT','INSERT','DELETE'] loop
    if not has_table_privilege('authenticated', 'public.forgestudio_project_versions'::regclass, p) then bad := bad || 'forgestudio_project_versions:' || p || ' '; end if;
  end loop;
  r := r || 'AFTER_required_authenticated_privileges_missing=[' || bad || ']; ';

  -- ---- 3) behaviour after migration
  -- anon: blocked everywhere (permission denied), including the Google-callback-style insert
  foreach t in array tabs loop
    begin
      set local role anon;
      execute format('select count(*) from public.%I', t) into n;
      r := r || 'ANON_select_' || t || '=allowed(' || n || '); ';
    exception when others then r := r || 'ANON_select_' || t || '=' || sqlstate || '; ';
    end;
    reset role;
  end loop;
  begin
    set local role anon;
    insert into public.integrations (provider, access_token) values ('Google Business', 'x');
    r := r || 'ANON_google_style_insert=allowed; ';
  exception when others then r := r || 'ANON_google_style_insert=' || sqlstate || '; ';
  end;
  reset role;

  -- authenticated: TRUNCATE is refused on every table
  foreach t in array tabs loop
    begin
      set local role authenticated;
      perform set_config('request.jwt.claim.sub', owner_id, true);
      execute format('truncate table public.%I', t);
      r := r || 'AUTH_truncate_' || t || '=ALLOWED(BAD); ';
    exception when others then r := r || 'AUTH_truncate_' || t || '=' || sqlstate || '; ';
    end;
    reset role;
  end loop;

  -- owner-only RLS still works: owner full CRUD on a fixture project (+ version), other user sees/changes nothing
  begin
    set local role authenticated;
    perform set_config('request.jwt.claim.sub', owner_id, true);
    insert into public.forgestudio_projects (user_id, prompt, code) values (owner_id::uuid, 'GRANT-TEST-FIXTURE', 'x') returning id into fid;
    r := r || 'OWNER_insert=ok; ';
    update public.forgestudio_projects set github_owner = 'probe' where id = fid;
    get diagnostics n = row_count; r := r || 'OWNER_update_rows=' || n || '; ';
    select count(*) into n from public.forgestudio_projects where id = fid; r := r || 'OWNER_select_rows=' || n || '; ';
    -- versions table: insert + select (columns per the app's insert)
    begin
      insert into public.forgestudio_project_versions (project_id, user_id, version_number, code) values (fid, owner_id::uuid, 1, 'c');
      select count(*) into n from public.forgestudio_project_versions where project_id = fid;
      r := r || 'OWNER_version_insert_select_rows=' || n || '; ';
    exception when others then r := r || 'OWNER_version_error=' || sqlerrm || '; ';
    end;
  exception when others then r := r || 'OWNER_error=' || sqlerrm || '; ';
  end;
  reset role;

  begin
    set local role authenticated;
    perform set_config('request.jwt.claim.sub', other_id, true);
    select count(*) into n from public.forgestudio_projects where id = fid; r := r || 'OTHER_select_fixture_rows=' || n || '; ';
    update public.forgestudio_projects set github_owner = 'hijack' where id = fid; get diagnostics n = row_count; r := r || 'OTHER_update_rows=' || n || '; ';
    delete from public.forgestudio_projects where id = fid; get diagnostics n = row_count; r := r || 'OTHER_delete_rows=' || n || '; ';
    select count(*) into n from public.forgestudio_project_versions where project_id = fid; r := r || 'OTHER_select_version_rows=' || n || '; ';
    select count(*) into n from public.integrations; r := r || 'OTHER_integrations_visible=' || n || '; ';
  exception when others then r := r || 'OTHER_error=' || sqlerrm || '; ';
  end;
  reset role;

  begin
    set local role authenticated;
    perform set_config('request.jwt.claim.sub', owner_id, true);
    delete from public.forgestudio_projects where id = fid; get diagnostics n = row_count; r := r || 'OWNER_delete_rows=' || n || '; ';
    select count(*) into n from public.forgestudio_project_versions where project_id = fid; r := r || 'OWNER_versions_after_cascade=' || n || '; ';
  exception when others then r := r || 'OWNER_delete_error=' || sqlerrm || '; ';
  end;
  reset role;

  -- ---- 4) future table defaults: a new table created by postgres gets NO anon/authenticated privileges
  create table public._grant_probe_tmp (id int);
  select count(*) into n from (
    select 1 from pg_class c cross join lateral aclexplode(c.relacl) a
    where c.oid = 'public._grant_probe_tmp'::regclass and pg_get_userbyid(a.grantee) in ('anon','authenticated')
  ) s;
  r := r || 'FUTURE_TABLE_anon_or_authenticated_grants=' || n || '; ';

  -- supabase_admin's own defaults (only matter for tables created BY supabase_admin): can postgres change them?
  begin
    alter default privileges for role supabase_admin in schema public revoke truncate, references, trigger, maintain on tables from anon, authenticated;
    r := r || 'SUPABASE_ADMIN_default_acl_change=possible; ';
  exception when others then r := r || 'SUPABASE_ADMIN_default_acl_change=' || sqlstate || '(' || sqlerrm || '); ';
  end;

  -- ---- 5) ROLLBACK migration (verbatim) and compare with the snapshot
  grant delete, insert, maintain, references, select, trigger, truncate, update on table public.env_vars to anon;
  grant maintain, references, trigger, truncate on table public.forgestudio_project_versions to anon;
  grant insert, maintain, references, select, trigger, truncate on table public.forgestudio_projects to anon;
  grant delete, insert, maintain, references, select, trigger, truncate, update on table public.integrations to anon;
  grant delete, insert, maintain, references, select, trigger, truncate, update on table public.seo_settings to anon;
  grant delete, insert, maintain, references, select, trigger, truncate, update on table public.env_vars to authenticated;
  grant delete, insert, maintain, references, select, trigger, truncate on table public.forgestudio_project_versions to authenticated;
  grant delete, insert, maintain, references, select, trigger, truncate, update on table public.forgestudio_projects to authenticated;
  grant delete, insert, maintain, references, select, trigger, truncate, update on table public.integrations to authenticated;
  grant delete, insert, maintain, references, select, trigger, truncate, update on table public.seo_settings to authenticated;
  alter default privileges for role postgres in schema public grant truncate, references, trigger, maintain on tables to anon, authenticated;

  drop table public._grant_probe_tmp;

  select string_agg(x.k, ' | ' order by x.k) into after_tables from (
      select c.relname || ':' || case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end || ':' || pg_get_userbyid(a.grantor) || ':' || a.privilege_type || ':' || a.is_grantable as k
      from pg_class c cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
      where c.relnamespace = 'public'::regnamespace and c.relkind = 'r') x;
  select string_agg(x.k, ' | ' order by x.k) into after_defaults from (
      select pg_get_userbyid(d.defaclrole) || ':' || d.defaclobjtype::text || ':' || case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end || ':' || a.privilege_type as k
      from pg_default_acl d cross join lateral aclexplode(d.defaclacl) a
      where d.defaclnamespace = 'public'::regnamespace) x;
  r := r || 'ROLLBACK_table_acls_identical_to_snapshot=' || (after_tables is not distinct from snap_tables) || '; ';
  r := r || 'ROLLBACK_default_acls_identical_to_snapshot=' || (after_defaults is not distinct from snap_defaults) || '; ';

  raise exception 'RESULT: %', r;
end $$;

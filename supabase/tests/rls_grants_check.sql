-- ForgeStudio database access checks (Phase 7 / 7A).
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

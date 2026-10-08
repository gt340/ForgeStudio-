-- ForgeStudio database access checks (Phase 7).
-- NOT run by CI: it needs a real Supabase database. Run it manually in the Supabase SQL editor or via
-- the Supabase MCP. Every probe is rolled back by the final RAISE EXCEPTION, so it changes no data.
-- Replace the three placeholder UUIDs with: an existing project id, its owner's user id, and any OTHER user id.
--
-- Expected output (the error text IS the result):
--   anon_select_rows=0; other_user_select_rows=0; other_user_update_rows=0;
--   other_insert_for_owner=new row violates row-level security policy ...;
--   owner_update_rows=1;
--   owner_delete=permission denied for table forgestudio_projects   <-- known gap: DELETE is not granted (see report)

do $$
declare
  r text := '';
  n int;
  project_id uuid := '00000000-0000-0000-0000-000000000001';
  owner_id uuid := '00000000-0000-0000-0000-000000000002';
  other_id uuid := '00000000-0000-0000-0000-000000000003';
begin
  begin
    set local role anon;
    select count(*) into n from forgestudio_projects;
    r := r || 'anon_select_rows=' || n || '; ';
  exception when others then r := r || 'anon_select_err=' || sqlerrm || '; ';
  end;
  reset role;

  begin
    set local role authenticated;
    perform set_config('request.jwt.claim.sub', other_id::text, true);
    select count(*) into n from forgestudio_projects;
    r := r || 'other_user_select_rows=' || n || '; ';
    update forgestudio_projects set github_owner = 'probe' where id = project_id;
    get diagnostics n = row_count;
    r := r || 'other_user_update_rows=' || n || '; ';
    begin
      insert into forgestudio_projects (user_id, prompt, code) values (owner_id, 'probe', 'probe');
      r := r || 'other_insert_for_owner=ALLOWED(BAD); ';
    exception when others then r := r || 'other_insert_for_owner=' || sqlerrm || '; ';
    end;
  exception when others then r := r || 'other_user_err=' || sqlerrm || '; ';
  end;
  reset role;

  begin
    set local role authenticated;
    perform set_config('request.jwt.claim.sub', owner_id::text, true);
    update forgestudio_projects set github_owner = github_owner where id = project_id;
    get diagnostics n = row_count;
    r := r || 'owner_update_rows=' || n || '; ';
    delete from forgestudio_projects where id = project_id;
    get diagnostics n = row_count;
    r := r || 'owner_delete_rows=' || n || '; ';
  exception when others then r := r || 'owner_delete=' || sqlerrm || '; ';
  end;

  raise exception 'PROBE RESULT: %', r;
end $$;

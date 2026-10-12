-- VERIFY BEHAVIOUR AS THE API ROLES (writes nothing). The DO block always ends with RAISE EXCEPTION, so the call "fails" and the
-- error text IS the result (same technique as supabase/tests/least_privilege_migration_test.sql); nothing can persist.
-- Run after Change 1. Expected text: RESULT: anon_denied=5/5 auth_rls_filtered=5/5 owner_sees_own_rows=true (all tokens ok).
-- It never writes and never runs TRUNCATE on production (TRUNCATE is covered by the exact ACL and has_table_privilege checks).
do $beh$
declare
  tbls text[] := array['forgestudio_projects','forgestudio_project_versions','integrations','seo_settings','env_vars'];
  t text; n bigint; st text; anon_ok int := 0; filt_ok int := 0; uid uuid; own_total bigint; own_seen bigint;
begin
  select user_id into uid from public.forgestudio_projects order by created_at limit 1;
  select count(*) into own_total from public.forgestudio_projects where user_id = uid;
  foreach t in array tbls loop
    begin
      set local role anon;
      execute format('select count(*) from public.%I', t) into n;
      st := 'ALLOWED';
    exception when others then st := sqlstate;
    end;
    reset role;
    if st = '42501' then anon_ok := anon_ok + 1; end if;
  end loop;
  -- an authenticated session for a user id that owns nothing must see 0 rows everywhere (RLS still filtering)
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-000000000000', 'role', 'authenticated')::text, true);
  foreach t in array tbls loop
    begin
      set local role authenticated;
      execute format('select count(*) from public.%I', t) into n;
      st := n::text;
    exception when others then st := 'ERR ' || sqlstate;
    end;
    reset role;
    if st = '0' then filt_ok := filt_ok + 1; end if;
  end loop;
  -- the real owner of the oldest project still sees exactly their own projects
  if uid is not null then
    perform set_config('request.jwt.claims', json_build_object('sub', uid::text, 'role', 'authenticated')::text, true);
    begin
      set local role authenticated;
      select count(*) into own_seen from public.forgestudio_projects;
    exception when others then own_seen := -1;
    end;
    reset role;
  end if;
  raise exception 'RESULT: anon_denied=%/5 auth_rls_filtered=%/5 owner_sees_own_rows=% (owner rows %, seen %)',
    anon_ok, filt_ok, case when uid is null or own_seen = own_total then 'true' else 'FALSE' end, own_total, own_seen;
end
$beh$;

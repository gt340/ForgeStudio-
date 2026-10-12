-- Phase 7B release gate D: public.rls_auto_enable() signature / owner / EXECUTE privileges / event-trigger behaviour,
-- before and after the PROPOSED revoke, and after its rollback. Run as `postgres` on the DISPOSABLE PG17 replica only.
-- Prints one `GATE|key|value` line per fact. The revoke is NOT part of the app migration and is never applied to production.
--
-- Question being answered: does `revoke execute ... from public, anon, authenticated` (a) stop anon/authenticated from
-- calling the function directly, and (b) leave the event trigger working, including when the table is created by a
-- role other than the function owner (an event trigger does not check the creating role's EXECUTE privilege)?

\set ON_ERROR_STOP on

create schema gate;
create table gate.results (n serial primary key, k text not null, v text);
create function gate.rec(k text, v text) returns void language sql as $$ insert into gate.results (k, v) values ($1, $2) $$;

-- a second, ordinary table-creating role (stand-in for "some role other than the function owner creates a table")
create role lowpriv nologin;
grant lowpriv to postgres with inherit true, set true;
grant create, usage on schema public to lowpriv;

create function gate.check_state(label text) returns void language plpgsql as $$
declare
  f record;
  st text;
  rls boolean;
begin
  select p.oid, p.proacl, p.proowner into f from pg_proc p where p.proname = 'rls_auto_enable' and p.pronamespace = 'public'::regnamespace;
  perform gate.rec(label || '.proacl', coalesce(f.proacl::text, 'NULL'));
  perform gate.rec(label || '.public_execute', (exists (select 1 from aclexplode(coalesce(f.proacl, acldefault('f', f.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE'))::text);
  perform gate.rec(label || '.anon_execute', has_function_privilege('anon', f.oid, 'EXECUTE')::text);
  perform gate.rec(label || '.authenticated_execute', has_function_privilege('authenticated', f.oid, 'EXECUTE')::text);
  perform gate.rec(label || '.service_role_execute', has_function_privilege('service_role', f.oid, 'EXECUTE')::text);
  perform gate.rec(label || '.owner_execute', has_function_privilege('postgres', f.oid, 'EXECUTE')::text);

  -- direct calls from the API roles
  begin
    set local role anon;
    perform public.rls_auto_enable();
    st := 'ALLOWED';
  exception when others then st := sqlstate;
  end;
  reset role;
  perform gate.rec(label || '.direct_call_anon', st);
  begin
    set local role authenticated;
    perform public.rls_auto_enable();
    st := 'ALLOWED';
  exception when others then st := sqlstate;
  end;
  reset role;
  perform gate.rec(label || '.direct_call_authenticated', st);

  -- event trigger still enabled?
  perform gate.rec(label || '.event_trigger_enabled', (select evtenabled::text from pg_event_trigger where evtname = 'ensure_rls'));

  -- event trigger behaviour: tables created by the function owner and by another role
  execute 'create table public._gate_owner_t (id int)';
  select relrowsecurity into rls from pg_class where oid = 'public._gate_owner_t'::regclass;
  perform gate.rec(label || '.rls_on_new_table_by_owner', rls::text);
  execute 'create table public._gate_ctas_t as select 1 as id';
  select relrowsecurity into rls from pg_class where oid = 'public._gate_ctas_t'::regclass;
  perform gate.rec(label || '.rls_on_ctas_table_by_owner', rls::text);
  begin
    set local role lowpriv;
    execute 'create table public._gate_lowpriv_t (id int)';
    st := 'created';
  exception when others then st := 'ERR ' || sqlstate;
  end;
  reset role;
  perform gate.rec(label || '.lowpriv_create_table', st);
  select relrowsecurity into rls from pg_class where oid = 'public._gate_lowpriv_t'::regclass;
  perform gate.rec(label || '.rls_on_new_table_by_other_role', rls::text);
  execute 'drop table public._gate_owner_t, public._gate_ctas_t, public._gate_lowpriv_t';
end $$;

-- static facts
select gate.rec('func.signature', p.oid::regprocedure::text) from pg_proc p where p.proname = 'rls_auto_enable' and p.pronamespace = 'public'::regnamespace;
select gate.rec('func.owner', pg_get_userbyid(p.proowner)) from pg_proc p where p.proname = 'rls_auto_enable' and p.pronamespace = 'public'::regnamespace;
select gate.rec('func.security_definer', p.prosecdef::text) from pg_proc p where p.proname = 'rls_auto_enable' and p.pronamespace = 'public'::regnamespace;
select gate.rec('func.config', coalesce(p.proconfig::text, 'NULL')) from pg_proc p where p.proname = 'rls_auto_enable' and p.pronamespace = 'public'::regnamespace;
select gate.rec('func.returns', p.prorettype::regtype::text) from pg_proc p where p.proname = 'rls_auto_enable' and p.pronamespace = 'public'::regnamespace;
select gate.rec('evt.' || evtname, 'owner=' || pg_get_userbyid(evtowner) || ' event=' || evtevent::text || ' enabled=' || evtenabled::text || ' func=' || evtfoid::regproc::text || ' tags=' || coalesce(evttags::text, '')) from pg_event_trigger where evtname = 'ensure_rls';

select gate.check_state('baseline');

-- THE PROPOSED REMEDIATION (not applied to production)
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
select gate.check_state('after_revoke');

-- ITS ROLLBACK
grant execute on function public.rls_auto_enable() to public;
select gate.check_state('after_rollback');

select 'GATE|' || k || '|' || v from gate.results order by n;

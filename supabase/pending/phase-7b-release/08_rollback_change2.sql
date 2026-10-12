-- PRODUCTION ROLLBACK OF CHANGE 2: restores EXECUTE for PUBLIC (and therefore anon/authenticated). NOT EXECUTED.
-- Use only to recover from a verified break. Effective privileges return to the audited baseline; the stored proacl text
-- becomes {postgres=X/postgres,=X/postgres} instead of NULL, which is functionally identical.
-- ATOMIC: any failed assertion rolls everything back.

begin;
set local lock_timeout = '5s';        -- fail fast instead of queueing behind another session
set local statement_timeout = '60s';

do $rb2$
declare
  fo oid; facl aclitem[]; own text; secdef boolean; cfg text[]; ret text; evf oid; evs text; n bigint; snap jsonb; t text; got aclitem[]; acl_txt text[];
begin
  if current_user <> 'postgres' then raise exception 'ROLLBACK-PRECHECK: must run as postgres, running as %', current_user; end if;
  if (select rolsuper from pg_roles where rolname = current_user) then raise exception 'ROLLBACK-PRECHECK: postgres must not be superuser'; end if;
  if current_setting('server_version_num')::int not between 170000 and 179999 then
    raise exception 'ROLLBACK-PRECHECK: expected PostgreSQL 17, got %', current_setting('server_version'); end if;
  select p.oid, p.proacl, pg_get_userbyid(p.proowner), p.prosecdef, p.proconfig, p.prorettype::regtype::text
    into fo, facl, own, secdef, cfg, ret
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'rls_auto_enable' and p.pronargs = 0;
  if fo is null then raise exception 'ROLLBACK-PRECHECK: public.rls_auto_enable() not found'; end if;
  if own <> 'postgres' or not secdef or ret <> 'event_trigger' or not (cfg @> array['search_path=pg_catalog']) then
    raise exception 'ROLLBACK-PRECHECK: rls_auto_enable() is not the audited function (owner %, secdef %, returns %, config %)', own, secdef, ret, cfg::text; end if;
  select evtfoid, evtenabled::text into evf, evs from pg_event_trigger where evtname = 'ensure_rls';
  if evf is distinct from fo or evs <> 'O' then
    raise exception 'ROLLBACK-PRECHECK: event trigger ensure_rls is missing, not enabled (%), or does not call rls_auto_enable()', evs; end if;
  if has_function_privilege('anon', fo, 'EXECUTE') then raise exception 'ROLLBACK-PRECHECK: anon can already execute it; Change 2 does not look applied'; end if;
end
$rb2$;

grant execute on function public.rls_auto_enable() to public;

do $rb2_post$
declare
  fo oid; facl aclitem[]; own text; secdef boolean; cfg text[]; ret text; evf oid; evs text; n bigint; snap jsonb; t text; got aclitem[]; acl_txt text[];
begin
  if current_user <> 'postgres' then raise exception 'ROLLBACK-POSTCHECK: must run as postgres, running as %', current_user; end if;
  if (select rolsuper from pg_roles where rolname = current_user) then raise exception 'ROLLBACK-POSTCHECK: postgres must not be superuser'; end if;
  if current_setting('server_version_num')::int not between 170000 and 179999 then
    raise exception 'ROLLBACK-POSTCHECK: expected PostgreSQL 17, got %', current_setting('server_version'); end if;
  select p.oid, p.proacl, pg_get_userbyid(p.proowner), p.prosecdef, p.proconfig, p.prorettype::regtype::text
    into fo, facl, own, secdef, cfg, ret
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'rls_auto_enable' and p.pronargs = 0;
  if fo is null then raise exception 'ROLLBACK-POSTCHECK: public.rls_auto_enable() not found'; end if;
  if own <> 'postgres' or not secdef or ret <> 'event_trigger' or not (cfg @> array['search_path=pg_catalog']) then
    raise exception 'ROLLBACK-POSTCHECK: rls_auto_enable() is not the audited function (owner %, secdef %, returns %, config %)', own, secdef, ret, cfg::text; end if;
  select evtfoid, evtenabled::text into evf, evs from pg_event_trigger where evtname = 'ensure_rls';
  if evf is distinct from fo or evs <> 'O' then
    raise exception 'ROLLBACK-POSTCHECK: event trigger ensure_rls is missing, not enabled (%), or does not call rls_auto_enable()', evs; end if;
  if not (has_function_privilege('anon', fo, 'EXECUTE') and has_function_privilege('authenticated', fo, 'EXECUTE')
          and has_function_privilege('postgres', fo, 'EXECUTE')) then
    raise exception 'ROLLBACK-POSTCHECK: baseline execute privileges were not restored'; end if;
end
$rb2_post$;

commit;

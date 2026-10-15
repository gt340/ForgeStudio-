-- Phase 7B backup validation: catalog + content snapshot of schema `public`, one `key|value` line per fact.
-- Read-only. Run as a superuser (it hashes row contents, so RLS must not hide rows) with `psql -X -At -v ON_ERROR_STOP=1`.
-- Row VALUES are never printed: contents appear only as md5 hashes. Compare the snapshot of the source with the snapshot of the restore.
-- Prefix: T tables, C columns, K constraints, I indexes, P policies, A table ACLs, F functions, R row counts, H content hashes,
--         D default ACLs of schema public, E event triggers, Edep event-trigger dependency, N schema-level ACL of public.
select line from (
  select 'T|' || c.relname || '|kind=' || c.relkind::text || '|owner=' || pg_get_userbyid(c.relowner) || '|rls=' || c.relrowsecurity
         || '|force=' || c.relforcerowsecurity || '|opts=' || coalesce(c.reloptions::text, '') as line
    from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'S')
  union all
  select 'C|' || c.relname || '|' || a.attnum || '|' || a.attname || '|' || format_type(a.atttypid, a.atttypmod) || '|notnull=' || a.attnotnull
         || '|default=' || coalesce(pg_get_expr(d.adbin, d.adrelid), '')
    from pg_attribute a join pg_class c on c.oid = a.attrelid
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
   where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
  union all
  select 'K|' || c.relname || '|' || k.conname || '|' || k.contype::text || '|' || pg_get_constraintdef(k.oid)
    from pg_constraint k join pg_class c on c.oid = k.conrelid where c.relnamespace = 'public'::regnamespace
  union all
  select 'I|' || tablename || '|' || indexname || '|' || indexdef from pg_indexes where schemaname = 'public'
  union all
  select 'P|' || tablename || '|' || policyname || '|' || cmd || '|' || permissive || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, '')
    from pg_policies where schemaname = 'public'
  union all
  select 'A|' || c.relname || '|' || coalesce((select string_agg(x::text, ',' order by x::text) from unnest(c.relacl) x), 'NULL')
    from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'S')
  union all
  select 'F|' || p.oid::regprocedure::text || '|owner=' || pg_get_userbyid(p.proowner) || '|secdef=' || p.prosecdef || '|returns=' || p.prorettype::regtype::text
         || '|config=' || coalesce(p.proconfig::text, '') || '|acl=' || coalesce(p.proacl::text, 'NULL') || '|src=' || md5(p.prosrc)
    from pg_proc p where p.pronamespace = 'public'::regnamespace
  union all
  select 'R|forgestudio_projects|' || count(*) from public.forgestudio_projects
  union all
  select 'R|forgestudio_project_versions|' || count(*) from public.forgestudio_project_versions
  union all
  select 'R|integrations|' || count(*) from public.integrations
  union all
  select 'R|seo_settings|' || count(*) from public.seo_settings
  union all
  select 'R|env_vars|' || count(*) from public.env_vars
  union all
  select 'H|forgestudio_projects|' || md5(coalesce(string_agg(t::text, E'\n' order by t.id), '')) from public.forgestudio_projects t
  union all
  select 'H|forgestudio_project_versions|' || md5(coalesce(string_agg(t::text, E'\n' order by t.id), '')) from public.forgestudio_project_versions t
  union all
  select 'H|integrations|' || md5(coalesce(string_agg(t::text, E'\n' order by t.id), '')) from public.integrations t
  union all
  select 'H|seo_settings|' || md5(coalesce(string_agg(t::text, E'\n' order by t.id), '')) from public.seo_settings t
  union all
  select 'H|env_vars|' || md5(coalesce(string_agg(t::text, E'\n' order by t.id), '')) from public.env_vars t
  union all
  select 'D|' || pg_get_userbyid(d.defaclrole) || '|' || d.defaclobjtype::text || '|' || coalesce((select string_agg(x::text, ',' order by x::text) from unnest(d.defaclacl) x), 'NULL')
    from pg_default_acl d where d.defaclnamespace = 'public'::regnamespace
  union all
  select 'E|' || e.evtname || '|' || e.evtevent || '|owner=' || pg_get_userbyid(e.evtowner) || '|enabled=' || e.evtenabled::text
         || '|tags=' || coalesce(e.evttags::text, '') || '|function=' || e.evtfoid::regprocedure::text
    from pg_event_trigger e
  union all
  select 'Edep|' || e.evtname || '|depends on function=' || (select count(*) from pg_depend d
           where d.classid = 'pg_event_trigger'::regclass and d.objid = e.oid and d.refobjid = e.evtfoid and d.deptype = 'n')
    from pg_event_trigger e
  union all
  select 'N|public|owner=' || pg_get_userbyid(n.nspowner) || '|acl=' || coalesce((select string_agg(x::text, ',' order by x::text) from unnest(n.nspacl) x), 'NULL')
    from pg_namespace n where n.nspname = 'public'
) s order by line collate "C";

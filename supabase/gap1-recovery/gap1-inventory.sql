-- ForgeStudio Phase 7B, Gap 1, Step 1: READ-ONLY TLS and role inventory.
-- Run only through gap1-run.sh (it enforces sslmode=verify-full). Reads catalogs only: no application rows, no password hashes.
-- The whole file runs inside one READ ONLY transaction that is rolled back; the server refuses any write.
--
-- Failure behaviour: ON_ERROR_STOP is set inside this file, so any error (including the safety gate below) makes psql exit
-- with status 3. The sentinel lines GAP1_GATE_OK and GAP1_INVENTORY_COMPLETE are printed only on the success path;
-- the caller requires both. Note: psql's \quit takes no exit status, so it is never used to signal failure.
\set ON_ERROR_STOP on
\set QUIET on
\pset pager off
\pset null '(null)'
\pset border 1

begin read only;

-- Safety gate: if the server does not confirm a read-only transaction, raise an error (psql then exits with status 3).
select (current_setting('transaction_read_only') = 'on')::text as ro \gset
\if :ro
  \echo GAP1_GATE_OK
\else
  do $$ begin raise exception 'GAP1_GATE_FAILED: transaction is not read-only'; end $$;
\endif

\echo '== S0 read-only confirmation =='
select current_setting('transaction_read_only') as transaction_read_only,
       (now() at time zone 'utc')::timestamp(0) as utc_time;

\echo '== S1 client-side TLS (psql view of the client-to-endpoint connection) =='
\conninfo

\echo '== S2 server settings visible to SQL =='
select name, setting
from pg_settings
where name in ('server_version', 'ssl', 'ssl_min_protocol_version', 'password_encryption', 'transaction_read_only')
order by name;

\echo '== S3 TLS of THIS backend connection (behind a pooler this is the pooler-to-database leg, NOT the client leg) =='
select ssl, version as tls_version, cipher, bits
from pg_stat_ssl
where pid = pg_backend_pid();

\echo '== S4 identity =='
select current_user, session_user, current_database() as database;

\echo '== S5 attributes of the connected role =='
select rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin, rolreplication, rolbypassrls,
       rolconnlimit, (rolvaliduntil is not null) as has_expiry,
       has_database_privilege(current_user, current_database(), 'CONNECT') as can_connect,
       has_database_privilege(current_user, current_database(), 'CREATE') as can_create_schema
from pg_roles
where rolname = current_user;

\echo '== S6 all non-internal roles (attributes only) =='
select rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin, rolreplication, rolbypassrls,
       rolconnlimit, (rolvaliduntil is not null) as has_expiry, (rolconfig is not null) as has_role_settings
from pg_roles
where rolname !~ '^pg_'
order by rolname;

\echo '== S7 role memberships (members that are not internal pg_* roles) =='
select m.rolname as member, g.rolname as granted_role, a.admin_option, a.inherit_option, a.set_option
from pg_auth_members a
join pg_roles m on m.oid = a.member
join pg_roles g on g.oid = a.roleid
where m.rolname !~ '^pg_'
order by 1, 2;

\echo '== S8 schemas: owner and whether the connected role can use them =='
select n.nspname as schema, pg_get_userbyid(n.nspowner) as owner,
       has_schema_privilege(current_user, n.oid, 'USAGE') as can_use,
       has_schema_privilege(current_user, n.oid, 'CREATE') as can_create
from pg_namespace n
where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
order by 1;

\echo '== S9 schema ACL of public (the entries the restore test had to recover) =='
select pg_get_userbyid(a.grantor) as grantor,
       case a.grantee when 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee,
       a.privilege_type, a.is_grantable
from pg_namespace n, aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
where n.nspname = 'public'
order by 1, 2, 3;

\echo '== S10 default privileges =='
select pg_get_userbyid(d.defaclrole) as for_role, d.defaclobjtype as objtype, d.defaclnamespace::regnamespace::text as in_schema, d.defaclacl as acl
from pg_default_acl d
order by 1, 2, 3;

\echo '== S11 what the connected role can read in schema public (privilege checks only; no rows are read) =='
select c.relkind, c.relname as object, pg_get_userbyid(c.relowner) as owner, c.relrowsecurity as rls_enabled,
       case when c.relkind = 'S' then has_sequence_privilege(current_user, c.oid, 'SELECT')
            else has_table_privilege(current_user, c.oid, 'SELECT') end as can_select
from pg_class c
where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
order by c.relkind, c.relname;

\echo '== S12 functions in public =='
select p.oid::regprocedure::text as function, pg_get_userbyid(p.proowner) as owner, p.prosecdef as security_definer,
       has_function_privilege(current_user, p.oid, 'EXECUTE') as can_execute
from pg_proc p
where p.pronamespace = 'public'::regnamespace
order by 1;

\echo '== S13 event triggers (not carried by a schema-only dump) =='
select evtname, evtevent, pg_get_userbyid(evtowner) as owner, evtenabled
from pg_event_trigger
order by 1;

\echo '== S14 extensions =='
select extname, extversion from pg_extension order by 1;

\echo '== S15 platform tables the dump scope excludes: existence and readability (booleans only) =='
-- Looked up by catalog name, not by regclass name resolution: resolving "auth.users" raises an error when the role has no USAGE on schema auth.
select v.sch || '.' || v.rel as object, (c.oid is not null) as exists_,
       case when c.oid is not null then has_table_privilege(current_user, c.oid, 'SELECT') end as can_select
from (values ('auth', 'users'), ('storage', 'objects')) as v(sch, rel)
left join pg_namespace n on n.nspname = v.sch
left join pg_class c on c.relnamespace = n.oid and c.relname = v.rel
order by 1;

rollback;
\echo GAP1_INVENTORY_COMPLETE

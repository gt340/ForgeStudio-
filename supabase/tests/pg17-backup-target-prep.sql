-- Phase 7B backup validation: prepare an EMPTY restore target (disposable PostgreSQL 17.6 only; never production).
-- Run as the container bootstrap superuser (supabase_admin) inside the target database BEFORE pg_restore.
-- pg_dump never creates cluster-level objects, so the roles the dump refers to must already exist, and the `auth` schema
-- (excluded from the dump) must provide `auth.users(id)` for the foreign keys and `auth.uid()` for the policies. In a real Supabase
-- project the platform provides these; here they are stand-ins. The four synthetic user ids below are what the data rows point at.
\set ON_ERROR_STOP on

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'postgres') then create role postgres login createrole createdb bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin noinherit bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator login noinherit; end if;
end $$;

-- `pg_dump --schema=public` includes CREATE SCHEMA public (observed on the local PostgreSQL 16 smoke run; confirmed or corrected by the
-- PostgreSQL 17.6 CI run), so a fresh database's own empty `public` schema must be removed first, otherwise the restore fails with
-- "schema public already exists". Only ever run this in an empty, disposable target.
drop schema if exists public;

create schema if not exists auth;
create table if not exists auth.users (id uuid primary key, email text);
create or replace function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;
grant usage on schema auth to anon, authenticated, service_role, postgres;
grant execute on function auth.uid() to anon, authenticated, service_role, postgres;
grant select, insert, delete, references on auth.users to postgres;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000002', 'owner@example.test'),
  ('00000000-0000-0000-0000-000000000003', 'other@example.test'),
  ('00000000-0000-0000-0000-0000000000c4', 'synthetic-c@example.test'),
  ('00000000-0000-0000-0000-0000000000d5', 'synthetic-d@example.test')
on conflict (id) do nothing;

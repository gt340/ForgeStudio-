-- Phase 7B backup validation: SYNTHETIC fixtures (never production data).
-- Run as role `postgres` against the disposable database `app` AFTER supabase/tests/pg17_replica_setup.sql.
-- The __CANARY_*__ tokens are replaced by the test with per-run random strings. They stand in for integration tokens and
-- environment-variable values and exist only so the test can prove that no command output ever discloses them.
-- Shape: nonempty tables (projects 4, integrations 3, seo_settings 2, env_vars 2) and one empty table (versions 0).
\set ON_ERROR_STOP on

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000c4', 'synthetic-c@example.test'),
  ('00000000-0000-0000-0000-0000000000d5', 'synthetic-d@example.test');

insert into public.forgestudio_projects (id, created_at, prompt, code, user_id, github_owner, github_repo) values
  ('22222222-0000-4000-8000-000000000001', '2026-01-01 10:00:00+00', 'synthetic prompt one', E'export default function Page() {\n  return <p>café ''single'' "double" \\ backslash</p>;\n}', '00000000-0000-0000-0000-000000000002', 'synthetic-owner', 'synthetic-repo'),
  ('22222222-0000-4000-8000-000000000002', '2026-01-02 10:00:00+00', 'synthetic prompt two', 'export default function Page() { return null; }', '00000000-0000-0000-0000-000000000002', null, null),
  ('22222222-0000-4000-8000-000000000003', '2026-01-03 10:00:00+00', 'synthetic prompt three', 'export default function Page() { return <h1>x</h1>; }', '00000000-0000-0000-0000-000000000003', null, null),
  ('22222222-0000-4000-8000-000000000004', '2026-01-04 10:00:00+00', 'synthetic prompt four', '', '00000000-0000-0000-0000-0000000000c4', null, null);

-- forgestudio_project_versions stays EMPTY on purpose (an empty table must restore empty and keep its definition)

insert into public.integrations (id, provider, status, created_at, access_token, refresh_token, user_id, github_login) values
  ('33333333-0000-4000-8000-000000000001', 'github', 'connected', '2026-01-01 11:00:00+00', '__CANARY_ACCESS__', '__CANARY_REFRESH__', '00000000-0000-0000-0000-000000000002', 'synthetic-login'),
  ('33333333-0000-4000-8000-000000000002', 'vercel', 'connected', '2026-01-01 11:05:00+00', '__CANARY_ACCESS__', null, '00000000-0000-0000-0000-000000000002', null),
  ('33333333-0000-4000-8000-000000000003', 'github', 'connected', '2026-01-02 11:00:00+00', '__CANARY_ACCESS__', '__CANARY_REFRESH__', '00000000-0000-0000-0000-000000000003', null);

insert into public.seo_settings (id, meta_title, meta_description, created_at, user_id) values
  ('44444444-0000-4000-8000-000000000001', 'Synthetic title', 'Synthetic description', '2026-01-01 12:00:00+00', '00000000-0000-0000-0000-000000000002'),
  ('44444444-0000-4000-8000-000000000002', null, null, '2026-01-02 12:00:00+00', '00000000-0000-0000-0000-000000000003');

insert into public.env_vars (id, key, value, environment, created_at, user_id) values
  ('55555555-0000-4000-8000-000000000001', 'SYNTHETIC_API_KEY', '__CANARY_ENVVALUE__', 'production', '2026-01-01 13:00:00+00', '00000000-0000-0000-0000-000000000002'),
  ('55555555-0000-4000-8000-000000000002', 'SYNTHETIC_FLAG', 'true', 'preview', '2026-01-01 13:05:00+00', '00000000-0000-0000-0000-000000000003');

-- extra structure the dump must carry: secondary indexes and a CHECK constraint (the replica itself only has PK / FK / UNIQUE)
create index forgestudio_projects_user_id_idx on public.forgestudio_projects (user_id);
create index integrations_provider_idx on public.integrations (provider);
alter table public.forgestudio_project_versions
  add constraint forgestudio_project_versions_version_number_check check (version_number > 0);

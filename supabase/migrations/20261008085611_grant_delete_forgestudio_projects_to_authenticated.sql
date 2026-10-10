-- Phase 7A: restore project deletion (applied to production 2026-10-08).
-- The "Owner delete" RLS policy (auth.uid() = user_id) already exists and is unchanged, but the
-- `authenticated` role had no DELETE privilege, so owners got "permission denied" on their own projects.
-- RLS still restricts deletes to the caller's own rows. `anon` is NOT granted DELETE.
-- forgestudio_project_versions rows are removed by the existing ON DELETE CASCADE foreign key.
grant delete on public.forgestudio_projects to authenticated;

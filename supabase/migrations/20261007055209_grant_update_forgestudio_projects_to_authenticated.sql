-- Applied to production on 2026-10-07 (Phase 6A).
-- The "Owner update" RLS policy existed, but the `authenticated` role had no UPDATE privilege, so every
-- UPDATE from the app failed with 42501 and GitHub/Vercel links could never be saved.
-- RLS (USING and WITH CHECK auth.uid() = user_id) still restricts updates to the owner's own rows.
-- (File renamed in Phase 7A so its version/name match what the database recorded when it was applied.)
grant update on public.forgestudio_projects to authenticated;

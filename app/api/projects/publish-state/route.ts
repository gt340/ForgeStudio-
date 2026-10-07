import { NextResponse } from 'next/server';
import { createSupabaseServerClient, getCurrentUser } from '@/lib/supabase-server';

// Returns ONLY the publish-related columns of a project the caller owns, so the Publish panel can
// rebuild its GitHub/Vercel state from the database (after a remount, reload, or reopened project).
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const projectId = new URL(req.url).searchParams.get('projectId');
  if (!projectId) return NextResponse.json({ error: 'Missing projectId' }, { status: 400 });

  const supabase = await createSupabaseServerClient();
  const { data: p, error } = await supabase
    .from('forgestudio_projects')
    .select(
      'id, github_owner, github_repo, github_repo_url, github_default_branch, github_last_commit_sha, github_synced_at, vercel_project_id, vercel_project_name, vercel_deployment_id, vercel_deployment_url, vercel_production_url, vercel_last_status, vercel_deployed_at'
    )
    .eq('id', projectId)
    .eq('user_id', user.id)
    .single();

  if (error || !p) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

  const github =
    p.github_owner && p.github_repo && p.github_repo_url
      ? {
          owner: p.github_owner,
          repo: p.github_repo,
          url: p.github_repo_url,
          defaultBranch: p.github_default_branch || 'main',
          lastCommitSha: p.github_last_commit_sha || undefined,
          syncedAt: p.github_synced_at || undefined,
        }
      : null;

  const vercel =
    p.vercel_project_id && p.vercel_project_name
      ? {
          projectId: p.vercel_project_id,
          projectName: p.vercel_project_name,
          deploymentId: p.vercel_deployment_id || null,
          url: p.vercel_deployment_url || null,
          productionUrl: p.vercel_production_url || null,
          status: p.vercel_last_status || 'NONE',
          deployedAt: p.vercel_deployed_at || undefined,
        }
      : null;

  return NextResponse.json({ github, vercel });
}

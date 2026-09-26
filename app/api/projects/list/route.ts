import { NextResponse } from 'next/server';
import { createSupabaseServerClient, getCurrentUser } from '@/lib/supabase-server';

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('forgestudio_projects')
    .select('id, created_at, prompt, code, preview_url, sandbox_id, github_owner, github_repo, github_repo_url, github_default_branch, github_last_commit_sha, github_synced_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) {
    console.error('List projects failed:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const projects = data || [];

  if (projects.length > 0) {
    const { data: versionCounts } = await supabase
      .from('forgestudio_project_versions')
      .select('project_id')
      .eq('user_id', user.id)
      .in('project_id', projects.map((p) => p.id));

    const counts: Record<string, number> = {};
    for (const v of versionCounts || []) {
      counts[v.project_id] = (counts[v.project_id] || 0) + 1;
    }

    for (const p of projects as any[]) {
      p.latest_version = counts[p.id] || 1;
    }
  }

  return NextResponse.json({ projects });
}

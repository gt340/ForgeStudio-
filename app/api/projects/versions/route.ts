import { NextResponse } from 'next/server';
import { createSupabaseServerClient, getCurrentUser } from '@/lib/supabase-server';

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const projectId = searchParams.get('projectId');
  if (!projectId) {
    return NextResponse.json({ error: 'Missing projectId' }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();

  const { data: project } = await supabase
    .from('forgestudio_projects')
    .select('id')
    .eq('id', projectId)
    .eq('user_id', user.id)
    .single();

  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  const { data, error } = await supabase
    .from('forgestudio_project_versions')
    .select('id, version_number, description, created_at')
    .eq('project_id', projectId)
    .eq('user_id', user.id)
    .order('version_number', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ versions: data || [] });
}

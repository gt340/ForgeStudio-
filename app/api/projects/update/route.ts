import { NextResponse } from 'next/server';
import { createSupabaseServerClient, getCurrentUser } from '@/lib/supabase-server';

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id, code, previewUrl, description } = await req.json();

  if (!id || !code) {
    return NextResponse.json({ error: 'Missing id or code' }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();

  const { data: updated, error } = await supabase
    .from('forgestudio_projects')
    .update({ code, preview_url: previewUrl || null })
    .eq('id', id)
    .eq('user_id', user.id)
    .select()
    .single();

  if (error) {
    console.error('Update project failed:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!updated) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  const { count } = await supabase
    .from('forgestudio_project_versions')
    .select('id', { count: 'exact', head: true })
    .eq('project_id', id);

  const { error: versionError } = await supabase.from('forgestudio_project_versions').insert({
    project_id: id,
    user_id: user.id,
    version_number: (count || 0) + 1,
    code,
    preview_url: previewUrl || null,
    description: description || 'Edit',
  });
  if (versionError) {
    console.error('Failed to record version (project still updated):', versionError);
  }

  return NextResponse.json({ success: true });
}

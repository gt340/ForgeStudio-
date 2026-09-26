import { NextResponse } from 'next/server';
import { createSupabaseServerClient, getCurrentUser } from '@/lib/supabase-server';

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id, code, previewUrl, description, expectedVersion } = await req.json();

  if (!id || !code) {
    return NextResponse.json({ error: 'Missing id or code' }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();

  // Ownership check up front, before any concurrency check, so we never leak
  // "stale version" vs "not found" distinctions for a project the caller doesn't own.
  const { data: existing, error: fetchError } = await supabase
    .from('forgestudio_projects')
    .select('id')
    .eq('id', id)
    .eq('user_id', user.id)
    .single();

  if (fetchError || !existing) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  const { count: latestCount } = await supabase
    .from('forgestudio_project_versions')
    .select('id', { count: 'exact', head: true })
    .eq('project_id', id);

  const currentLatestVersion = latestCount || 0;

  if (typeof expectedVersion === 'number' && expectedVersion !== currentLatestVersion) {
    return NextResponse.json(
      {
        error: 'This project has changed since you last loaded it. Reopen it to get the latest version before editing.',
        currentVersion: currentLatestVersion,
      },
      { status: 409 }
    );
  }

  const { error } = await supabase
    .from('forgestudio_projects')
    .update({ code, preview_url: previewUrl || null })
    .eq('id', id)
    .eq('user_id', user.id);

  if (error) {
    console.error('Update project failed:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const newVersionNumber = currentLatestVersion + 1;

  const { error: versionError } = await supabase.from('forgestudio_project_versions').insert({
    project_id: id,
    user_id: user.id,
    version_number: newVersionNumber,
    code,
    preview_url: previewUrl || null,
    description: description || 'Edit',
  });
  if (versionError) {
    console.error('Failed to record version (project still updated):', versionError);
  }

  return NextResponse.json({ success: true, version: newVersionNumber });
}

import { NextResponse } from 'next/server';
import { createSupabaseServerClient, getCurrentUser } from '@/lib/supabase-server';

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { prompt, code, previewUrl, sandboxId } = await req.json();

  if (!prompt || !code) {
    return NextResponse.json({ error: 'Missing prompt or code' }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('forgestudio_projects')
    .insert({
      prompt,
      code,
      preview_url: previewUrl || null,
      sandbox_id: sandboxId || null,
      user_id: user.id,
    })
    .select()
    .single();

  if (error) {
    console.error('Save project failed:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const { error: versionError } = await supabase.from('forgestudio_project_versions').insert({
    project_id: data.id,
    user_id: user.id,
    version_number: 1,
    code,
    preview_url: previewUrl || null,
    description: 'Initial generation',
  });
  if (versionError) {
    console.error('Failed to record initial version (project still saved):', versionError);
  }

  return NextResponse.json({ project: data });
}

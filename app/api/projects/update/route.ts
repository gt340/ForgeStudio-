import { NextResponse } from 'next/server';
import { createSupabaseServerClient, getCurrentUser } from '@/lib/supabase-server';

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id, code, previewUrl } = await req.json();

  if (!id || !code) {
    return NextResponse.json({ error: 'Missing id or code' }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from('forgestudio_projects')
    .update({ code, preview_url: previewUrl || null })
    .eq('id', id)
    .eq('user_id', user.id);

  if (error) {
    console.error('Update project failed:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}

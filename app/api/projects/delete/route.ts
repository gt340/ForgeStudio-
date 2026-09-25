import { NextResponse } from 'next/server';
import { createSupabaseServerClient, getCurrentUser } from '@/lib/supabase-server';

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await req.json().catch(() => ({}));
  if (!id) {
    return NextResponse.json({ error: 'Missing project id' }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();

  const { data: existing, error: fetchError } = await supabase
    .from('forgestudio_projects')
    .select('id')
    .eq('id', id)
    .eq('user_id', user.id)
    .single();

  if (fetchError || !existing) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  const { error } = await supabase
    .from('forgestudio_projects')
    .delete()
    .eq('id', id)
    .eq('user_id', user.id);

  if (error) {
    console.error('Delete project failed:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}

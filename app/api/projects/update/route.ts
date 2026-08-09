import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export async function POST(req: Request) {
  const { id, code, previewUrl } = await req.json();

  if (!id || !code) {
    return NextResponse.json({ error: 'Missing id or code' }, { status: 400 });
  }

  const { error } = await supabase
    .from('forgestudio_projects')
    .update({ code, preview_url: previewUrl || null })
    .eq('id', id);

  if (error) {
    console.error('Update project failed:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
  }

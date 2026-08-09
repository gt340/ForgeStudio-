import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export async function POST(req: Request) {
  const { prompt, code, previewUrl, sandboxId } = await req.json();

  if (!prompt || !code) {
    return NextResponse.json({ error: 'Missing prompt or code' }, { status: 400 });
  }

  const { data, error } = await supabase
    .from('forgestudio_projects')
    .insert({
      prompt,
      code,
      preview_url: previewUrl || null,
      sandbox_id: sandboxId || null,
    })
    .select()
    .single();

  if (error) {
    console.error('Save project failed:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ project: data });
  }

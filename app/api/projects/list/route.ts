import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export async function GET() {
  const { data, error } = await supabase
    .from('forgestudio_projects')
    .select('id, created_at, prompt, code, preview_url, sandbox_id')
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) {
    console.error('List projects failed:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ projects: data || [] });
                            }

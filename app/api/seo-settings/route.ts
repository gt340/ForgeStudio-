import { supabase } from '@/lib/supabase';

export async function GET() {
  const { data, error } = await supabase
    .from('seo_settings')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ settings: data });
}

export async function POST(req: Request) {
  const { meta_title, meta_description, og_image_url, favicon_url } = await req.json();
  const { data, error } = await supabase
    .from('seo_settings')
    .insert({ meta_title, meta_description, og_image_url, favicon_url })
    .select()
    .single();
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ setting: data });
}

export async function DELETE(req: Request) {
  const { id } = await req.json();
  const { error } = await supabase.from('seo_settings').delete().eq('id', id);
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ success: true });
}

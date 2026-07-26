import { supabase } from '@/lib/supabase';

export async function GET() {
  const { data, error } = await supabase
    .from('integrations')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ integrations: data });
}

export async function POST(req: Request) {
  const { provider } = await req.json();
  const { data, error } = await supabase
    .from('integrations')
    .insert({ provider })
    .select()
    .single();
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ integration: data });
}

export async function DELETE(req: Request) {
  const { id } = await req.json();
  const { error } = await supabase.from('integrations').delete().eq('id', id);
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ success: true });
}

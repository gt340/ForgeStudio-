import { supabase } from '@/lib/supabase';

export async function GET() {
  const { data, error } = await supabase
    .from('env_vars')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ vars: data });
}

export async function POST(req: Request) {
  const { key, value, environment } = await req.json();
  const { data, error } = await supabase
    .from('env_vars')
    .insert({ key, value, environment: environment || 'production' })
    .select()
    .single();
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ var: data });
}

export async function DELETE(req: Request) {
  const { id } = await req.json();
  const { error } = await supabase.from('env_vars').delete().eq('id', id);
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ success: true });
}

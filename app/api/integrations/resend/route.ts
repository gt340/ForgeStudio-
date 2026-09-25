import { NextResponse } from 'next/server';
import { createSupabaseServerClient, getCurrentUser } from '@/lib/supabase-server';

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { apiKey } = await req.json();

  if (!apiKey) {
    return NextResponse.json({ error: 'Missing API key' }, { status: 400 });
  }

  const verifyRes = await fetch('https://api.resend.com/domains', {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!verifyRes.ok) {
    return NextResponse.json({ error: 'Invalid Resend API key' }, { status: 401 });
  }

  const supabase = await createSupabaseServerClient();
  await supabase.from('integrations').upsert(
    { provider: 'Resend', status: 'connected', access_token: apiKey, user_id: user.id },
    { onConflict: 'user_id,provider' }
  );

  return NextResponse.json({ success: true });
}

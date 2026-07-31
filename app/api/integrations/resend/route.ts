import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export async function POST(req: Request) {
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

  await supabase.from('integrations').upsert({
    provider: 'Resend',
    status: 'connected',
    access_token: apiKey,
  });

  return NextResponse.json({ success: true });
}

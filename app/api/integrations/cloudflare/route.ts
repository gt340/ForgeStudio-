import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export async function POST(req: Request) {
  const { apiKey } = await req.json();

  console.log("CLOUDFLARE_KEY_DEBUG length:", apiKey ? apiKey.length : 0, "first5:", apiKey ? apiKey.slice(0,5) : "", "last5:", apiKey ? apiKey.slice(-5) : "");

  if (!apiKey) {
    return NextResponse.json({ error: 'Missing API key' }, { status: 400 });
  }

  const verifyRes = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!verifyRes.ok) {
    return NextResponse.json({ error: 'Invalid Cloudflare API token' }, { status: 401 });
  }

  await supabase.from('integrations').upsert({
    provider: 'Cloudflare',
    status: 'connected',
    access_token: apiKey,
  });

  return NextResponse.json({ success: true });
}

import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export async function POST(req: Request) {
  const { secretKey } = await req.json();

  if (!secretKey || !secretKey.startsWith('sk_')) {
    return NextResponse.json({ error: 'Invalid Paystack secret key' }, { status: 400 });
  }

  const verifyRes = await fetch('https://api.paystack.co/balance', {
    headers: { Authorization: `Bearer ${secretKey}` },
  });

  if (!verifyRes.ok) {
    return NextResponse.json({ error: 'Could not verify key with Paystack' }, { status: 400 });
  }

  await supabase.from('integrations').upsert({
    provider: 'Paystack',
    status: 'connected',
    access_token: secretKey,
  });

  return NextResponse.json({ success: true });
}

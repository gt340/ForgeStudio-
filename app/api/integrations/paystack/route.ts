import { NextResponse } from 'next/server';
import { createSupabaseServerClient, getCurrentUser } from '@/lib/supabase-server';

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

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

  const supabase = await createSupabaseServerClient();
  await supabase.from('integrations').upsert(
    { provider: 'Paystack', status: 'connected', access_token: secretKey, user_id: user.id },
    { onConflict: 'user_id,provider' }
  );

  return NextResponse.json({ success: true });
}

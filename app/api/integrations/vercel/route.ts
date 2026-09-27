import { NextResponse } from 'next/server';
import { createSupabaseServerClient, getCurrentUser } from '@/lib/supabase-server';

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { token } = await req.json().catch(() => ({}));

  if (!token || typeof token !== 'string' || !token.trim()) {
    return NextResponse.json({ error: 'Missing Vercel Personal Access Token' }, { status: 400 });
  }

  // Validate the token against a real Vercel API request BEFORE reporting success.
  const verifyRes = await fetch('https://api.vercel.com/v2/user', {
    headers: { Authorization: `Bearer ${token.trim()}` },
  });

  if (!verifyRes.ok) {
    if (verifyRes.status === 401 || verifyRes.status === 403) {
      return NextResponse.json({ error: 'That token was rejected by Vercel — check that you copied it correctly and it has not expired.' }, { status: 401 });
    }
    return NextResponse.json({ error: `Could not verify token with Vercel (status ${verifyRes.status})` }, { status: 502 });
  }

  const verifyData = await verifyRes.json();
  const vercelUserId: string | null = verifyData?.user?.id || null;
  const vercelTeamId: string | null = verifyData?.user?.defaultTeamId || null;

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from('integrations').upsert(
    {
      provider: 'Vercel',
      status: 'connected',
      access_token: token.trim(),
      vercel_user_id: vercelUserId,
      vercel_team_id: vercelTeamId,
      user_id: user.id,
    },
    { onConflict: 'user_id,provider' }
  );

  if (error) {
    console.error('Vercel integration save failed:', error);
    return NextResponse.json({ error: 'Could not save the connection. Please try again.' }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}

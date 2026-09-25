import { NextResponse } from 'next/server';
import { createSupabaseServerClient, getCurrentUser } from '@/lib/supabase-server';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const code = searchParams.get('code');
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host');
  const protocol = req.headers.get('x-forwarded-proto') || 'https';
  const origin = `${protocol}://${host}`;

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.redirect(`${origin}/login?error=not_authenticated`);
  }

  if (!code) {
    return NextResponse.redirect(`${origin}?error=missing_code`);
  }

  const redirectUri = `${origin}/api/auth/supabase/callback`;

  const tokenRes = await fetch('https://api.supabase.com/v1/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: process.env.SUPABASE_OAUTH_CLIENT_ID!,
      client_secret: process.env.SUPABASE_OAUTH_CLIENT_SECRET!,
      code,
      redirect_uri: redirectUri,
    }),
  });

  const tokenData = await tokenRes.json();

  if (!tokenData.access_token) {
    return NextResponse.redirect(`${origin}?error=supabase_auth_failed`);
  }

  const supabase = await createSupabaseServerClient();
  await supabase.from('integrations').upsert(
    {
      provider: 'Supabase',
      status: 'connected',
      access_token: tokenData.access_token,
      user_id: user.id,
    },
    { onConflict: 'user_id,provider' }
  );

  return NextResponse.redirect(`${origin}?connected=supabase`);
}

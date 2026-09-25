import { NextResponse } from 'next/server';
import { createSupabaseServerClient, getCurrentUser } from '@/lib/supabase-server';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const code = searchParams.get('code');
  const origin = new URL(req.url).origin;

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.redirect(`${origin}/login?error=not_authenticated`);
  }

  if (!code) {
    return NextResponse.redirect(`${origin}?error=missing_code`);
  }

  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: process.env.GITHUB_CLIENT_ID,
      client_secret: process.env.GITHUB_CLIENT_SECRET,
      code,
    }),
  });

  const tokenData = await tokenRes.json();

  if (!tokenData.access_token) {
    return NextResponse.redirect(`${origin}?error=github_auth_failed`);
  }

  const supabase = await createSupabaseServerClient();
  await supabase.from('integrations').upsert(
    {
      provider: 'GitHub',
      status: 'connected',
      access_token: tokenData.access_token,
      user_id: user.id,
    },
    { onConflict: 'user_id,provider' }
  );

  return NextResponse.redirect(`${origin}?connected=github`);
}

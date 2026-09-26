import { NextResponse } from 'next/server';
import { createSupabaseServerClient, getCurrentUser } from '@/lib/supabase-server';
import { cookies } from 'next/headers';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const origin = new URL(req.url).origin;

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.redirect(`${origin}/login?error=not_authenticated`);
  }

  const cookieStore = await cookies();
  const expectedState = cookieStore.get('github_oauth_state')?.value;

  if (!state || !expectedState || state !== expectedState) {
    const res = NextResponse.redirect(`${origin}?error=github_invalid_state`);
    res.cookies.set('github_oauth_state', '', { maxAge: 0, path: '/' });
    return res;
  }

  if (!code) {
    const res = NextResponse.redirect(`${origin}?error=missing_code`);
    res.cookies.set('github_oauth_state', '', { maxAge: 0, path: '/' });
    return res;
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
    const res = NextResponse.redirect(`${origin}?error=github_auth_failed`);
    res.cookies.set('github_oauth_state', '', { maxAge: 0, path: '/' });
    return res;
  }

  let githubLogin: string | null = null;
  try {
    const ghUserRes = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: 'application/vnd.github+json' },
    });
    if (ghUserRes.ok) {
      const ghUser = await ghUserRes.json();
      githubLogin = ghUser?.login || null;
    }
  } catch (e) {
    console.error('Failed to fetch GitHub username after connect:', e);
  }

  const supabase = await createSupabaseServerClient();
  await supabase.from('integrations').upsert(
    {
      provider: 'GitHub',
      status: 'connected',
      access_token: tokenData.access_token,
      github_login: githubLogin,
      user_id: user.id,
    },
    { onConflict: 'user_id,provider' }
  );

  const res = NextResponse.redirect(`${origin}?connected=github`);
  res.cookies.set('github_oauth_state', '', { maxAge: 0, path: '/' });
  return res;
}

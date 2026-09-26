import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/supabase-server';
import { randomBytes } from 'crypto';

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.redirect('https://forge-studio-rosy.vercel.app/login?error=not_authenticated');
  }

  const clientId = process.env.GITHUB_CLIENT_ID;
  const redirectUri = 'https://forge-studio-rosy.vercel.app/api/auth/github/callback';
  const state = randomBytes(16).toString('hex');

  const url = `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&scope=repo&state=${state}`;

  const response = NextResponse.redirect(url);
  response.cookies.set('github_oauth_state', state, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 600,
    path: '/',
  });
  return response;
}

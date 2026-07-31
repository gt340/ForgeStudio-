import { NextResponse } from 'next/server';

export async function GET(req: Request) {
  const clientId = process.env.SUPABASE_OAUTH_CLIENT_ID;
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host');
  const protocol = req.headers.get('x-forwarded-proto') || 'https';
  const origin = `${protocol}://${host}`;
  const redirectUri = `${origin}/api/auth/supabase/callback`;
  console.log("SUPABASE_REDIRECT_URI:", redirectUri);
  const url = `https://api.supabase.com/v1/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code`;
  return NextResponse.redirect(url);
}

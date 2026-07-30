import { NextResponse } from 'next/server';

export async function GET(req: Request) {
  const clientId = process.env.SLACK_CLIENT_ID;
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host');
  const protocol = req.headers.get('x-forwarded-proto') || 'https';
  const origin = `${protocol}://${host}`;
  const redirectUri = `${origin}/api/auth/slack/callback`;
  const scope = 'chat:write,channels:read';
  const url = `https://slack.com/oauth/v2/authorize?client_id=${clientId}&scope=${scope}&redirect_uri=${redirectUri}`;
  return NextResponse.redirect(url);
}

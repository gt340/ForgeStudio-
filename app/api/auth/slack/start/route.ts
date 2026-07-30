import { NextResponse } from 'next/server';

export async function GET(req: Request) {
  const clientId = process.env.SLACK_CLIENT_ID;
  const origin = new URL(req.url).origin;
  const redirectUri = `${origin}/api/auth/slack/callback`;
  const scope = 'chat:write,channels:read';
  const url = `https://slack.com/oauth/v2/authorize?client_id=${clientId}&scope=${scope}&redirect_uri=${redirectUri}`;
  return NextResponse.redirect(url);
}

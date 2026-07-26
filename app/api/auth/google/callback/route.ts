import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const error = searchParams.get("error");

  if (error || !code) {
    return NextResponse.redirect("https://forge-studio-rosy.vercel.app/?google=error");
  }

  const clientId = process.env.GOOGLE_CLIENT_ID!;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET!;
  const redirectUri = "https://forge-studio-rosy.vercel.app/api/auth/google/callback";

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  const tokenData = await tokenRes.json();

  if (!tokenRes.ok) {
    console.error("Google token exchange failed:", tokenData);
    return NextResponse.redirect("https://forge-studio-rosy.vercel.app/?google=error");
  }

  // At this point tokenData.access_token / refresh_token exist.
  // TODO: store tokenData in your integrations table (Supabase), same pattern as Stripe/Slack.

  return NextResponse.redirect("https://forge-studio-rosy.vercel.app/?google=connected");
}

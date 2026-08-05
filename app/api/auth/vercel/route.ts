import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const clientId = process.env.VERCEL_CLIENT_ID;
  const redirectUri = "https://forge-studio-rosy.vercel.app/api/auth/vercel/callback";

  if (!clientId) {
    return NextResponse.json(
      { error: "VERCEL_CLIENT_ID is not set" },
      { status: 500 }
    );
  }

  const authUrl = new URL("https://vercel.com/integrations/forgestudio/new");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);

  return NextResponse.redirect(authUrl.toString());
                          }

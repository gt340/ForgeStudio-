import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const code = searchParams.get("code");

  if (!code) {
    return NextResponse.redirect(
      "https://forge-studio-rosy.vercel.app/build?error=vercel_no_code"
    );
  }

  const clientId = process.env.VERCEL_CLIENT_ID;
  const clientSecret = process.env.VERCEL_CLIENT_SECRET;
  const redirectUri = "https://forge-studio-rosy.vercel.app/api/auth/vercel/callback";

  try {
    const tokenRes = await fetch("https://api.vercel.com/v2/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId!,
        client_secret: clientSecret!,
        code,
        redirect_uri: redirectUri,
      }),
    });

    const tokenData = await tokenRes.json();

    if (!tokenRes.ok || !tokenData.access_token) {
      console.error("Vercel token exchange failed:", tokenData);
      return NextResponse.redirect(
        "https://forge-studio-rosy.vercel.app/build?error=vercel_token_failed"
      );
    }

    const supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_ANON_KEY!
    );

    const { error } = await supabase.from("integrations").upsert(
      {
        service: "vercel",
        access_token: tokenData.access_token,
        team_id: tokenData.team_id || null,
        connected: true,
      },
      { onConflict: "service" }
    );

    if (error) {
      console.error("Supabase upsert failed:", error);
      return NextResponse.redirect(
        "https://forge-studio-rosy.vercel.app/build?error=vercel_save_failed"
      );
    }

    return NextResponse.redirect(
      "https://forge-studio-rosy.vercel.app/build?connected=vercel"
    );
  } catch (err) {
    console.error("Vercel callback error:", err);
    return NextResponse.redirect(
      "https://forge-studio-rosy.vercel.app/build?error=vercel_callback_exception"
    );
  }
      }

import { NextResponse } from 'next/server';
import { createSupabaseServerClient, getCurrentUser } from '@/lib/supabase-server';
import { randomUUID } from 'crypto';

// Safe structured logging only — never logs the token, the Authorization header,
// or a raw provider response body (which could itself carry sensitive detail).
function logAttempt(fields: Record<string, unknown>) {
  console.log(JSON.stringify({ event: 'vercel_token_verification', ...fields }));
}

export async function POST(req: Request) {
  const requestId = randomUUID();
  const startedAt = Date.now();

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { token } = await req.json().catch(() => ({}));

  if (!token || typeof token !== 'string' || !token.trim()) {
    return NextResponse.json({ error: 'Missing Vercel Personal Access Token' }, { status: 400 });
  }

  const trimmedToken = token.trim();
  const endpointPath = '/v2/user';

  // Validate the token against a real Vercel API request BEFORE reporting success
  // or persisting anything. On any failure below, we return early without touching
  // the database, so an existing valid integration is never overwritten by a bad
  // replacement attempt.
  let verifyRes: Response;
  try {
    verifyRes = await fetch(`https://api.vercel.com${endpointPath}`, {
      headers: { Authorization: `Bearer ${trimmedToken}` },
    });
  } catch (e: any) {
    logAttempt({
      requestId,
      userId: user.id,
      provider: 'vercel',
      endpointPath,
      status: null,
      result: 'network_error',
      durationMs: Date.now() - startedAt,
    });
    return NextResponse.json({ error: 'Vercel could not be reached. Please try again.' }, { status: 502 });
  }

  if (!verifyRes.ok) {
    // Parse the provider's error body for diagnostics only (code + message strings
    // are safe to log; Vercel error bodies never contain the token itself). We do
    // NOT log the raw body object, per the "no full provider responses" rule.
    let providerErrorCode: string | null = null;
    let providerErrorMessage: string | null = null;
    try {
      const errBody = await verifyRes.json();
      providerErrorCode = errBody?.error?.code || null;
      providerErrorMessage = errBody?.error?.message || null;
    } catch {
      // Non-JSON error body — nothing more to safely extract.
    }

    logAttempt({
      requestId,
      userId: user.id,
      provider: 'vercel',
      endpointPath,
      status: verifyRes.status,
      providerErrorCode,
      result: 'rejected',
      durationMs: Date.now() - startedAt,
    });

    const status = verifyRes.status;

    if (status === 401 || status === 403) {
      return NextResponse.json(
        { error: 'Vercel rejected this token. Check that it is a valid Personal Access Token with the required access.' },
        { status: 401 }
      );
    }

    if (status === 404) {
      // A 404 "user not found" from /v2/user does NOT reliably mean the token is
      // invalid \u2014 this exact symptom (a token shown as active with correct scope
      // on vercel.com/account/tokens, yet rejected by every API call) matches an
      // open, currently unresolved Vercel platform-side issue affecting some
      // Personal Access Tokens. We surface this honestly rather than call it
      // "invalid" outright.
      return NextResponse.json(
        {
          error:
            'Vercel returned "user not found" for this token. This can mean the token is invalid or expired, or \u2014 in some currently-reported cases \u2014 a valid token being rejected by a Vercel-side issue. Please confirm the token still shows as active at vercel.com/account/tokens, try generating a brand new token, and try again.',
        },
        { status: 502 }
      );
    }

    if (status === 429) {
      return NextResponse.json({ error: 'Vercel rate-limited the verification request. Please try again shortly.' }, { status: 429 });
    }

    if (status >= 500) {
      return NextResponse.json({ error: 'Vercel could not be reached. Please try again.' }, { status: 502 });
    }

    return NextResponse.json(
      { error: `ForgeStudio could not verify the Vercel credential using the current API endpoint (status ${status}).` },
      { status: 502 }
    );
  }

  const verifyData = await verifyRes.json();
  const vercelUserId: string | null = verifyData?.user?.id || null;
  const vercelTeamId: string | null = verifyData?.user?.defaultTeamId || null;

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from('integrations').upsert(
    {
      provider: 'Vercel',
      status: 'connected',
      access_token: trimmedToken,
      vercel_user_id: vercelUserId,
      vercel_team_id: vercelTeamId,
      user_id: user.id,
    },
    { onConflict: 'user_id,provider' }
  );

  logAttempt({
    requestId,
    userId: user.id,
    provider: 'vercel',
    endpointPath,
    status: verifyRes.status,
    result: error ? 'save_failed' : 'success',
    durationMs: Date.now() - startedAt,
  });

  if (error) {
    console.error('Vercel integration save failed:', error);
    return NextResponse.json({ error: 'Could not save the connection. Please try again.' }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}

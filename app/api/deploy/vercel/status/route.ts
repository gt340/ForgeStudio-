import { NextResponse } from 'next/server';
import { createSupabaseServerClient, getCurrentUser } from '@/lib/supabase-server';
import { phaseFromState, pickProductionUrl } from '@/lib/vercel-utils';

export const maxDuration = 30;

// Reports the REAL Vercel state of the deployment ForgeStudio recorded for this project.
// The deployment ID always comes from the database row the caller owns — never from the client —
// so this is not a generic Vercel proxy.
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const projectId = new URL(req.url).searchParams.get('projectId');
  if (!projectId) return NextResponse.json({ error: 'Missing projectId' }, { status: 400 });

  const supabase = await createSupabaseServerClient();

  const { data: project, error: projectError } = await supabase
    .from('forgestudio_projects')
    .select('id, vercel_deployment_id')
    .eq('id', projectId)
    .eq('user_id', user.id)
    .single();

  if (projectError || !project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  if (!project.vercel_deployment_id) {
    return NextResponse.json({ error: 'This project has no Vercel deployment yet' }, { status: 404 });
  }

  const { data: integration } = await supabase
    .from('integrations')
    .select('access_token')
    .eq('provider', 'Vercel')
    .eq('user_id', user.id)
    .single();

  const token = integration?.access_token;
  if (!token) return NextResponse.json({ error: 'Vercel not connected' }, { status: 401 });

  try {
    const res = await fetch(`https://api.vercel.com/v13/deployments/${encodeURIComponent(project.vercel_deployment_id)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 404) {
      return NextResponse.json({ error: 'Vercel no longer has this deployment' }, { status: 404 });
    }
    if (!res.ok) {
      return NextResponse.json({ error: `Could not read deployment status (status ${res.status})` }, { status: 502 });
    }

    const data: any = await res.json();
    const status: string = data.readyState || 'QUEUED';
    const deploymentUrl = data.url ? `https://${data.url}` : null;

    const aliasReady = Array.isArray(data.alias) && data.alias.length > 0;
    const productionUrl = status === 'READY' && aliasReady ? pickProductionUrl(data) : null;

    // Only verify the live site once Vercel itself says READY and a production hostname exists.
    let liveCheck: { ok: boolean; status: number | null } | null = null;
    if (productionUrl) {
      try {
        const live = await fetch(productionUrl, { redirect: 'follow', cache: 'no-store', signal: AbortSignal.timeout(8000) });
        liveCheck = { ok: live.ok, status: live.status };
      } catch {
        liveCheck = { ok: false, status: null };
      }
    }

    const updatePayload: Record<string, any> = { vercel_last_status: status };
    if (deploymentUrl) updatePayload.vercel_deployment_url = deploymentUrl;
    if (productionUrl) updatePayload.vercel_production_url = productionUrl;

    const { error: updateError } = await supabase
      .from('forgestudio_projects')
      .update(updatePayload)
      .eq('id', projectId)
      .eq('user_id', user.id);
    if (updateError) console.error('Failed to store Vercel status:', updateError);

    return NextResponse.json({
      deploymentId: project.vercel_deployment_id,
      status,
      phase: phaseFromState(status),
      url: deploymentUrl,
      productionUrl,
      aliasPending: status === 'READY' && !aliasReady,
      liveCheck,
      commitSha: data?.meta?.githubCommitSha ?? null,
      errorMessage: status === 'ERROR' ? data?.errorMessage ?? null : null,
    });
  } catch (e) {
    console.error('Vercel status check failed:', e instanceof Error ? e.message : 'unknown error');
    return NextResponse.json({ error: 'Could not check deployment status' }, { status: 502 });
  }
}

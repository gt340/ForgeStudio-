import { NextResponse } from 'next/server';
import { createSupabaseServerClient, getCurrentUser } from '@/lib/supabase-server';
import { pickProductionUrl } from '@/lib/vercel-utils';

export const maxDuration = 60;

function sanitizeProjectName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 100) || 'forgestudio-site';
}

async function pollDeployment(deploymentId: string, token: string, maxAttempts = 8, intervalMs = 2500) {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const res = await fetch(`https://api.vercel.com/v13/deployments/${deploymentId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) continue;
    const data = await res.json();
    if (data.readyState === 'READY' || data.readyState === 'ERROR' || data.readyState === 'CANCELED') {
      return data;
    }
  }
  return null; // Bounded polling exhausted — caller reports last known state; the client keeps polling /api/deploy/vercel/status.
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { projectId } = await req.json().catch(() => ({}));
  if (!projectId || typeof projectId !== 'string') {
    return NextResponse.json({ error: 'Missing projectId' }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();

  const { data: project, error: projectError } = await supabase
    .from('forgestudio_projects')
    .select('id, github_owner, github_repo, github_repo_id, github_default_branch, github_last_commit_sha, vercel_project_id, vercel_project_name')
    .eq('id', projectId)
    .eq('user_id', user.id)
    .single();

  if (projectError || !project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  if (!project.github_owner || !project.github_repo || !project.github_repo_id) {
    return NextResponse.json({ error: 'Push this project to GitHub first — Vercel deploys from the linked GitHub repository.' }, { status: 400 });
  }

  const { data: integration } = await supabase
    .from('integrations')
    .select('access_token')
    .eq('provider', 'Vercel')
    .eq('user_id', user.id)
    .single();

  const token = integration?.access_token;
  if (!token) {
    return NextResponse.json({ error: 'Vercel not connected' }, { status: 401 });
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  try {
    let vercelProjectId: string | undefined = project.vercel_project_id || undefined;
    let vercelProjectName: string | undefined = project.vercel_project_name || undefined;

    if (vercelProjectId) {
      // Existing association — verify it still actually exists before reusing it.
      const checkRes = await fetch(`https://api.vercel.com/v10/projects/${vercelProjectId}`, { headers });
      if (checkRes.status === 404) {
        await supabase
          .from('forgestudio_projects')
          .update({ vercel_project_id: null, vercel_project_name: null })
          .eq('id', projectId)
          .eq('user_id', user.id);
        return NextResponse.json(
          { error: 'The connected Vercel project no longer exists. Its link has been cleared — deploy again to create a new one.' },
          { status: 409 }
        );
      }
      if (!checkRes.ok) {
        return NextResponse.json({ error: `Could not verify existing Vercel project (status ${checkRes.status})` }, { status: 502 });
      }
      const projData = await checkRes.json();
      vercelProjectName = projData.name;
    } else {
      // No association yet — create (or adopt) a Vercel project linked to the GitHub repo.
      const baseName = sanitizeProjectName(project.github_repo);
      const gitRepository = { type: 'github', repo: `${project.github_owner}/${project.github_repo}` };
      const createProject = (name: string) =>
        fetch('https://api.vercel.com/v11/projects', {
          method: 'POST',
          headers,
          body: JSON.stringify({ name, framework: 'nextjs', gitRepository }),
        });

      let createRes = await createProject(baseName);
      let projData: any = await createRes.json().catch(() => ({}));

      if (!createRes.ok && (createRes.status === 400 || createRes.status === 409)) {
        // A project with this name may be a leftover from an earlier attempt for THIS SAME repository
        // (e.g. its deployment step failed). Adopt it rather than creating a duplicate.
        let adopted = false;
        const existingRes = await fetch(`https://api.vercel.com/v9/projects/${encodeURIComponent(baseName)}`, { headers });
        if (existingRes.ok) {
          const existing: any = await existingRes.json().catch(() => null);
          const link = existing?.link;
          const sameRepo =
            !!link &&
            (String(link.repoId) === String(project.github_repo_id) ||
              (String(link.org || '').toLowerCase() === String(project.github_owner).toLowerCase() &&
                String(link.repo || '').toLowerCase() === String(project.github_repo).toLowerCase()));
          if (existing?.id && sameRepo) {
            projData = existing;
            createRes = existingRes;
            adopted = true;
          }
        }

        if (!adopted) {
          // Genuine name conflict with an unrelated project — retry once with a short unique suffix.
          const retryName = `${baseName}-${Math.random().toString(36).slice(2, 7)}`;
          createRes = await createProject(retryName);
          projData = await createRes.json().catch(() => ({}));
        }
      }

      if (!createRes.ok || !projData?.id) {
        console.error('Vercel project creation failed:', createRes.status, projData?.error || projData);
        return NextResponse.json({ error: projData?.error?.message || 'Vercel project creation failed' }, { status: 502 });
      }

      vercelProjectId = projData.id;
      vercelProjectName = projData.name;

      // Persist the association IMMEDIATELY so a failure in the deployment step below can never
      // cause the next attempt to create a second Vercel project for this ForgeStudio project.
      await supabase
        .from('forgestudio_projects')
        .update({ vercel_project_id: vercelProjectId, vercel_project_name: vercelProjectName })
        .eq('id', projectId)
        .eq('user_id', user.id);
    }

    const deployRes = await fetch('https://api.vercel.com/v13/deployments', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: vercelProjectName,
        project: vercelProjectId,
        target: 'production',
        gitSource: {
          type: 'github',
          ref: project.github_default_branch || 'main',
          repoId: project.github_repo_id,
          // Pin to the exact commit ForgeStudio last synced, when known.
          ...(project.github_last_commit_sha ? { sha: project.github_last_commit_sha } : {}),
        },
      }),
    });

    const deployData: any = await deployRes.json().catch(() => ({}));

    if (!deployRes.ok || !deployData.id) {
      console.error('Vercel deployment creation failed:', deployRes.status, deployData?.error || deployData);
      return NextResponse.json({ error: deployData?.error?.message || `Deployment failed (status ${deployRes.status})` }, { status: 502 });
    }

    const settled = await pollDeployment(deployData.id, token);
    const finalState = settled || deployData;
    const status: string = finalState.readyState || 'QUEUED';
    const deploymentUrl = finalState.url ? `https://${finalState.url}` : null;

    // The stable production hostname comes from Vercel's assigned aliases, and only counts once the
    // deployment is READY. The per-deployment URL can sit behind Vercel deployment protection.
    const aliasReady = Array.isArray(finalState.alias) && finalState.alias.length > 0;
    const productionUrl = status === 'READY' && aliasReady ? pickProductionUrl(finalState) : null;

    const updatePayload: Record<string, any> = {
      vercel_project_id: vercelProjectId,
      vercel_project_name: vercelProjectName,
      vercel_deployment_id: deployData.id,
      vercel_deployment_url: deploymentUrl,
      vercel_last_status: status,
      vercel_deployed_at: new Date().toISOString(),
    };
    if (productionUrl) {
      updatePayload.vercel_production_url = productionUrl;
    }

    const { error: updateError } = await supabase
      .from('forgestudio_projects')
      .update(updatePayload)
      .eq('id', projectId)
      .eq('user_id', user.id);

    if (updateError) {
      console.error('Failed to store Vercel deployment result (deployment itself was created):', updateError);
    }

    return NextResponse.json({
      deploymentId: deployData.id,
      url: deploymentUrl,
      productionUrl,
      aliasPending: status === 'READY' && !aliasReady,
      status,
      projectId: vercelProjectId,
      projectName: vercelProjectName,
      polled: !!settled,
      commitSha: finalState?.meta?.githubCommitSha ?? deployData?.meta?.githubCommitSha ?? null,
      errorMessage: status === 'ERROR' ? finalState?.errorMessage ?? null : null,
    });
  } catch (e) {
    console.error('Vercel deploy failed unexpectedly:', e instanceof Error ? e.message : 'unknown error');
    return NextResponse.json({ error: 'Deployment request failed unexpectedly — please try again.' }, { status: 502 });
  }
}

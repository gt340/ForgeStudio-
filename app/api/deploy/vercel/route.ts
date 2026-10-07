import { NextResponse } from 'next/server';
import { createSupabaseServerClient, getCurrentUser } from '@/lib/supabase-server';
import { pickProductionUrl } from '@/lib/vercel-utils';

export const maxDuration = 60;

const IN_PROGRESS = ['QUEUED', 'INITIALIZING', 'BUILDING'];
const REUSE_WINDOW_MS = 3 * 60 * 1000;

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
    .select(
      'id, github_owner, github_repo, github_repo_id, github_default_branch, github_last_commit_sha, vercel_project_id, vercel_project_name, vercel_deployment_id, vercel_last_status, vercel_deployed_at'
    )
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
    // Idempotency: a deployment for this project was started moments ago and is still running
    // (double tap, remount, repeated request). Return it instead of starting another one.
    const startedMsAgo = project.vercel_deployed_at ? Date.now() - new Date(project.vercel_deployed_at).getTime() : Infinity;
    if (project.vercel_deployment_id && IN_PROGRESS.includes(project.vercel_last_status) && startedMsAgo < REUSE_WINDOW_MS) {
      const curRes = await fetch(`https://api.vercel.com/v13/deployments/${project.vercel_deployment_id}`, { headers });
      if (curRes.ok) {
        const cur: any = await curRes.json().catch(() => null);
        if (cur && IN_PROGRESS.includes(cur.readyState)) {
          return NextResponse.json({
            deploymentId: project.vercel_deployment_id,
            url: cur.url ? `https://${cur.url}` : null,
            productionUrl: null,
            aliasPending: false,
            status: cur.readyState,
            projectId: project.vercel_project_id,
            projectName: project.vercel_project_name,
            polled: false,
            reused: true,
            commitSha: cur?.meta?.githubCommitSha ?? null,
            errorMessage: null,
          });
        }
      }
    }

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

      // Persist the association IMMEDIATELY and verify it saved. If it did not, stop: the Vercel project
      // exists and will be ADOPTED on the next attempt (matched by name + repository), never duplicated.
      const { error: linkError } = await supabase
        .from('forgestudio_projects')
        .update({ vercel_project_id: vercelProjectId, vercel_project_name: vercelProjectName })
        .eq('id', projectId)
        .eq('user_id', user.id);

      if (linkError) {
        console.error('Failed to save Vercel link to the project:', linkError.code, linkError.message);
        return NextResponse.json(
          { error: 'The Vercel project exists, but ForgeStudio could not save the link to this project. Try again — the existing Vercel project will be reused.' },
          { status: 500 }
        );
      }
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
      console.error('Failed to store Vercel deployment result (deployment itself was created):', updateError.code, updateError.message);
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
      persisted: !updateError,
      warning: updateError ? 'The deployment was created, but ForgeStudio could not save its details. Status updates may not survive a reload.' : null,
    });
  } catch (e) {
    console.error('Vercel deploy failed unexpectedly:', e instanceof Error ? e.message : 'unknown error');
    return NextResponse.json({ error: 'Deployment request failed unexpectedly — please try again.' }, { status: 502 });
  }
}

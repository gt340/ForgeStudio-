import { NextResponse } from 'next/server';
import { createSupabaseServerClient, getCurrentUser } from '@/lib/supabase-server';
import { prepareDeployableCode } from '@/lib/deploy-code';

export const maxDuration = 60;

const REPO_NAME_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function buildRepoFiles(code: string): Record<string, string> {
  return {
    'package.json': JSON.stringify(
      {
        name: 'forgestudio-site',
        private: true,
        scripts: { dev: 'next dev', build: 'next build', start: 'next start' },
        dependencies: {
          next: '14.2.32',
          react: '18.3.1',
          'react-dom': '18.3.1',
          '@supabase/supabase-js': '2.45.4',
        },
      },
      null,
      2
    ),
    'next.config.js': 'module.exports = {};\n',
    'app/layout.js':
      'export default function RootLayout({ children }) {\n' +
      '  return (\n' +
      '    <html lang="en">\n' +
      '      <body>{children}</body>\n' +
      '    </html>\n' +
      '  );\n' +
      '}\n',
    'app/page.js': code,
    'README.md': '# ForgeStudio Site\n\nGenerated and synced from ForgeStudio. Run `npm install` then `npm run dev` to preview locally.\n',
  };
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { projectId, repoName } = await req.json().catch(() => ({}));

  if (!projectId || typeof projectId !== 'string') {
    return NextResponse.json({ error: 'Missing projectId' }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();

  // Ownership check + load the AUTHORITATIVE saved code — never trust code from the browser here.
  const { data: project, error: projectError } = await supabase
    .from('forgestudio_projects')
    .select('id, code, github_owner, github_repo, github_default_branch')
    .eq('id', projectId)
    .eq('user_id', user.id)
    .single();

  if (projectError || !project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }
  if (!project.code) {
    return NextResponse.json({ error: 'This project has no saved code yet' }, { status: 400 });
  }

  const { data: integration } = await supabase
    .from('integrations')
    .select('access_token')
    .eq('provider', 'GitHub')
    .eq('user_id', user.id)
    .single();

  const token = integration?.access_token;
  if (!token) {
    return NextResponse.json({ error: 'GitHub not connected' }, { status: 401 });
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
  };

  try {
    const userRes = await fetch('https://api.github.com/user', { headers });
    if (!userRes.ok) {
      return NextResponse.json({ error: 'GitHub authentication failed — try reconnecting GitHub' }, { status: 401 });
    }
    const ghUser = await userRes.json();

    let owner: string = project.github_owner;
    let repo: string = project.github_repo;
    let defaultBranch: string = project.github_default_branch || 'main';
    let repoId: number | undefined;
    let repoUrl: string | undefined;
    let isNewRepo = false;

    if (owner && repo) {
      // Existing association — verify the repo still actually exists before reusing it.
      const checkRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });
      if (checkRes.status === 404) {
        await supabase
          .from('forgestudio_projects')
          .update({ github_owner: null, github_repo: null, github_repo_id: null, github_default_branch: null, github_repo_url: null })
          .eq('id', projectId)
          .eq('user_id', user.id);
        return NextResponse.json(
          { error: 'The connected GitHub repository no longer exists. Its link has been cleared — sync again to create a new one.' },
          { status: 409 }
        );
      }
      if (!checkRes.ok) {
        return NextResponse.json({ error: `Could not verify existing GitHub repository (status ${checkRes.status})` }, { status: 502 });
      }
      const repoData = await checkRes.json();
      repoId = repoData.id;
      repoUrl = repoData.html_url;
      defaultBranch = repoData.default_branch || defaultBranch;
    } else {
      // No association yet — create a new repository.
      if (!repoName || typeof repoName !== 'string' || !repoName.trim()) {
        return NextResponse.json({ error: 'This project is not linked to a GitHub repository yet — provide a repository name.' }, { status: 400 });
      }
      const cleanName = repoName.trim();
      if (!REPO_NAME_PATTERN.test(cleanName) || cleanName === '.' || cleanName === '..') {
        return NextResponse.json({ error: 'Repository names may only contain letters, numbers, ".", "-" and "_".' }, { status: 400 });
      }

      const createRes = await fetch('https://api.github.com/user/repos', {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: cleanName, private: false, auto_init: true }),
      });
      const repoData = await createRes.json().catch(() => ({}));

      if (createRes.status === 422) {
        return NextResponse.json({ error: `A GitHub repository named "${cleanName}" already exists on your account — choose a different name.` }, { status: 409 });
      }
      if (!createRes.ok || !repoData.full_name) {
        console.error('GitHub repo creation failed:', createRes.status, repoData?.message);
        return NextResponse.json({ error: repoData?.message || 'Repository creation failed' }, { status: 502 });
      }

      owner = ghUser.login;
      repo = repoData.name;
      repoId = repoData.id;
      repoUrl = repoData.html_url;
      defaultBranch = repoData.default_branch || 'main';
      isNewRepo = true;

      // Persist the association IMMEDIATELY so that if a later step fails, a retry reuses this
      // repository instead of trying (and failing) to create a second one.
      await supabase
        .from('forgestudio_projects')
        .update({
          github_owner: owner,
          github_repo: repo,
          github_repo_id: repoId,
          github_default_branch: defaultBranch,
          github_repo_url: repoUrl,
        })
        .eq('id', projectId)
        .eq('user_id', user.id);
    }

    // Same page transform the sandbox preview applies, so the deployed site matches what the user saw.
    const files = buildRepoFiles(await prepareDeployableCode(project.code));

    // Push everything as ONE atomic commit (Git Data API) instead of one commit per file.
    // Per-file commits left the branch in half-written states and fired a Vercel Git build per push.
    const base = `https://api.github.com/repos/${owner}/${repo}`;
    const branchPath = defaultBranch.split('/').map(encodeURIComponent).join('/');

    let headSha: string | undefined;
    for (let attempt = 0; attempt < 4; attempt++) {
      const refRes = await fetch(`${base}/git/ref/heads/${branchPath}`, { headers });
      if (refRes.ok) {
        const refData = await refRes.json();
        headSha = refData?.object?.sha;
        break;
      }
      if (refRes.status !== 404 && refRes.status !== 409) break;
      await sleep(800); // a freshly created repo can take a moment before its first branch is readable
    }
    if (!headSha) {
      return NextResponse.json({ error: `Could not read the "${defaultBranch}" branch of the GitHub repository` }, { status: 502 });
    }

    const headCommitRes = await fetch(`${base}/git/commits/${headSha}`, { headers });
    if (!headCommitRes.ok) {
      return NextResponse.json({ error: `Could not read the latest GitHub commit (status ${headCommitRes.status})` }, { status: 502 });
    }
    const baseTreeSha: string | undefined = (await headCommitRes.json())?.tree?.sha;
    if (!baseTreeSha) {
      return NextResponse.json({ error: 'Could not read the repository tree from GitHub' }, { status: 502 });
    }

    const treeRes = await fetch(`${base}/git/trees`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        base_tree: baseTreeSha,
        tree: Object.entries(files).map(([path, content]) => ({ path, mode: '100644', type: 'blob', content })),
      }),
    });
    const treeData = await treeRes.json().catch(() => ({}));
    if (!treeRes.ok || !treeData?.sha) {
      console.error('GitHub tree creation failed:', treeRes.status, treeData?.message);
      return NextResponse.json({ error: `Failed to stage files on GitHub (status ${treeRes.status}): ${treeData?.message || 'unknown error'}` }, { status: 502 });
    }

    let commitSha: string = headSha;
    let changed = false;

    if (treeData.sha !== baseTreeSha) {
      const commitRes = await fetch(`${base}/git/commits`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          message: isNewRepo ? 'ForgeStudio: initial site' : 'ForgeStudio: update website',
          tree: treeData.sha,
          parents: [headSha],
        }),
      });
      const commitData = await commitRes.json().catch(() => ({}));
      if (!commitRes.ok || !commitData?.sha) {
        console.error('GitHub commit creation failed:', commitRes.status, commitData?.message);
        return NextResponse.json({ error: `Failed to create the GitHub commit (status ${commitRes.status}): ${commitData?.message || 'unknown error'}` }, { status: 502 });
      }

      const patchRes = await fetch(`${base}/git/refs/heads/${branchPath}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ sha: commitData.sha, force: false }),
      });
      if (!patchRes.ok) {
        const patchErr = await patchRes.json().catch(() => ({}));
        console.error('GitHub ref update failed:', patchRes.status, patchErr?.message);
        if (patchRes.status === 422) {
          return NextResponse.json({ error: 'The repository changed on GitHub while syncing — please sync again.' }, { status: 409 });
        }
        return NextResponse.json({ error: `Failed to update the GitHub branch (status ${patchRes.status}): ${patchErr?.message || 'unknown error'}` }, { status: 502 });
      }

      commitSha = commitData.sha;
      changed = true;
    }

    const { error: updateError } = await supabase
      .from('forgestudio_projects')
      .update({
        github_owner: owner,
        github_repo: repo,
        github_repo_id: repoId,
        github_default_branch: defaultBranch,
        github_repo_url: repoUrl,
        github_last_commit_sha: commitSha,
        github_synced_at: new Date().toISOString(),
      })
      .eq('id', projectId)
      .eq('user_id', user.id);

    if (updateError) {
      console.error('Failed to store GitHub sync result (GitHub push itself succeeded):', updateError);
    }

    return NextResponse.json({
      url: repoUrl,
      owner,
      repo,
      defaultBranch,
      lastCommitSha: commitSha,
      changed,
      isNewRepo,
    });
  } catch (e) {
    console.error('GitHub sync failed unexpectedly:', e instanceof Error ? e.message : 'unknown error');
    return NextResponse.json({ error: 'GitHub sync failed unexpectedly — please try again.' }, { status: 502 });
  }
}

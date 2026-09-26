import { NextResponse } from 'next/server';
import { createSupabaseServerClient, getCurrentUser } from '@/lib/supabase-server';

function toBase64(str: string) {
  return Buffer.from(str, 'utf-8').toString('base64');
}

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
      // Repo was deleted externally. Report clearly and stop, rather than silently
      // recreating a new repo under the same association or corrupting project state.
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

    const createRes = await fetch('https://api.github.com/user/repos', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: repoName.trim(), private: false, auto_init: true }),
    });
    const repoData = await createRes.json();

    if (createRes.status === 422) {
      return NextResponse.json({ error: `A GitHub repository named "${repoName}" already exists on your account — choose a different name.` }, { status: 409 });
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
  }

  const files = buildRepoFiles(project.code);
  let lastCommitSha: string | undefined;

  for (const [path, content] of Object.entries(files)) {
    const contentsUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;

    let existingSha: string | undefined;
    const existingRes = await fetch(`${contentsUrl}?ref=${defaultBranch}`, { headers });
    if (existingRes.ok) {
      const existingData = await existingRes.json();
      existingSha = existingData.sha;
    }

    const putRes = await fetch(contentsUrl, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        message: isNewRepo ? `ForgeStudio: initial commit (${path})` : `ForgeStudio: update website (${path})`,
        content: toBase64(content),
        branch: defaultBranch,
        ...(existingSha ? { sha: existingSha } : {}),
      }),
    });

    if (!putRes.ok) {
      const errBody = await putRes.json().catch(() => ({}));
      console.error(`GitHub file write failed for ${path}:`, putRes.status, errBody?.message);
      return NextResponse.json(
        { error: `Failed to write ${path} to GitHub (status ${putRes.status}): ${errBody?.message || 'unknown error'}` },
        { status: 502 }
      );
    }

    const putData = await putRes.json();
    if (putData?.commit?.sha) lastCommitSha = putData.commit.sha;
  }

  const { error: updateError } = await supabase
    .from('forgestudio_projects')
    .update({
      github_owner: owner,
      github_repo: repo,
      github_repo_id: repoId,
      github_default_branch: defaultBranch,
      github_repo_url: repoUrl,
      github_last_commit_sha: lastCommitSha,
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
    lastCommitSha,
    isNewRepo,
  });
}

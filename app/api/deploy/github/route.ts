import { NextResponse } from 'next/server';
import { createSupabaseServerClient, getCurrentUser } from '@/lib/supabase-server';

function toBase64(str: string) {
  return Buffer.from(str, 'utf-8').toString('base64');
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { code, repoName } = await req.json();

  if (!code || !repoName) {
    return NextResponse.json({ error: 'Missing code or repoName' }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
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
  const ghUser = await userRes.json();

  const createRepoRes = await fetch('https://api.github.com/user/repos', {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: repoName, private: false, auto_init: true }),
  });
  const repo = await createRepoRes.json();

  if (!repo.full_name) {
    return NextResponse.json({ error: repo.message || 'Repo creation failed' }, { status: 400 });
  }

  const files: Record<string, string> = {
    'package.json': JSON.stringify(
      {
        name: repoName,
        private: true,
        scripts: { dev: 'next dev', build: 'next build', start: 'next start' },
        dependencies: {
          next: '14.2.32',
          react: '18.3.1',
          'react-dom': '18.3.1',
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
  };

  for (const [path, content] of Object.entries(files)) {
    await fetch(
      `https://api.github.com/repos/${ghUser.login}/${repoName}/contents/${path}`,
      {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          message: `Add ${path}`,
          content: toBase64(content),
        }),
      }
    );
  }

  return NextResponse.json({ url: repo.html_url });
}

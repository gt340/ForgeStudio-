import { NextResponse } from 'next/server';
import { Sandbox } from 'e2b';
import { getCurrentUser } from '@/lib/supabase-server';

const MAX_FILES = 50;
const MAX_FILE_BYTES = 500_000;

// Files are written under /home/user/project/ — reject anything that could escape that folder.
function isSafePath(p: string) {
  return p.length > 0 && p.length <= 200 && !p.startsWith('/') && !p.includes('..') && !p.includes('\\') && /^[\w./-]+$/.test(p);
}

export async function POST(req: Request) {
  // Creating a sandbox spends E2B compute and runs `npm install` — never for anonymous callers.
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { files } = await req.json().catch(() => ({}));

  if (!files || typeof files !== 'object' || Array.isArray(files)) {
    return NextResponse.json({ error: 'Missing files' }, { status: 400 });
  }
  const entries = Object.entries(files as Record<string, unknown>);
  if (entries.length === 0 || entries.length > MAX_FILES) {
    return NextResponse.json({ error: 'Invalid number of files' }, { status: 400 });
  }
  for (const [path, content] of entries) {
    if (!isSafePath(path) || typeof content !== 'string' || content.length > MAX_FILE_BYTES) {
      return NextResponse.json({ error: 'Invalid file' }, { status: 400 });
    }
  }

  try {
    const sandbox = await Sandbox.create({ timeoutMs: 15 * 60 * 1000 });

    for (const [path, content] of entries) {
      await sandbox.files.write(`/home/user/project/${path}`, content as string);
    }

    await sandbox.commands.run(
      'cd /home/user/project && (npm install && npm run dev -- --hostname 0.0.0.0 --port 3000) > /home/user/project/dev.log 2>&1',
      { background: true }
    );

    return NextResponse.json({ sandboxId: sandbox.sandboxId });
  } catch (e) {
    console.error('Sandbox create failed:', e instanceof Error ? e.message : 'unknown error');
    return NextResponse.json({ error: 'Could not start the preview sandbox' }, { status: 502 });
  }
}

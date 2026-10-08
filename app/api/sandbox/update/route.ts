import { NextResponse } from 'next/server';
import { Sandbox } from 'e2b';
import { getCurrentUser } from '@/lib/supabase-server';

const MAX_FILES = 50;
const MAX_FILE_BYTES = 500_000;

function isSafePath(p: string) {
  return p.length > 0 && p.length <= 200 && !p.startsWith('/') && !p.includes('..') && !p.includes('\\') && /^[\w./-]+$/.test(p);
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { sandboxId, files } = await req.json().catch(() => ({}));

  if (!sandboxId || typeof sandboxId !== 'string' || !files || typeof files !== 'object' || Array.isArray(files)) {
    return NextResponse.json({ error: 'Missing sandboxId or files' }, { status: 400 });
  }
  if (!/^[A-Za-z0-9_-]{5,100}$/.test(sandboxId)) {
    return NextResponse.json({ error: 'Invalid sandboxId' }, { status: 400 });
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
    const sandbox = await Sandbox.connect(sandboxId);

    for (const [path, content] of entries) {
      await sandbox.files.write(`/home/user/project/${path}`, content as string);
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error('Sandbox update failed:', e instanceof Error ? e.message : 'unknown error');
    return NextResponse.json({ error: 'Could not update the preview sandbox' }, { status: 502 });
  }
}

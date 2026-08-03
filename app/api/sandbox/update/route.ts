import { NextResponse } from 'next/server';
import { Sandbox } from 'e2b';

export async function POST(req: Request) {
  const { sandboxId, files } = await req.json();

  if (!sandboxId || !files || typeof files !== 'object') {
    return NextResponse.json({ error: 'Missing sandboxId or files' }, { status: 400 });
  }

  const sandbox = await Sandbox.connect(sandboxId);

  for (const [path, content] of Object.entries(files)) {
    await sandbox.files.write(`/home/user/project/${path}`, content as string);
  }

  return NextResponse.json({ ok: true });
}

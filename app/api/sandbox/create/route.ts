import { NextResponse } from 'next/server';
import { Sandbox } from 'e2b';

export async function POST(req: Request) {
  const { files } = await req.json();

  if (!files || typeof files !== 'object') {
    return NextResponse.json({ error: 'Missing files' }, { status: 400 });
  }

  const sandbox = await Sandbox.create({ timeoutMs: 15 * 60 * 1000 });

  for (const [path, content] of Object.entries(files)) {
    await sandbox.files.write(`/home/user/project/${path}`, content as string);
  }

  await sandbox.commands.run(
    'cd /home/user/project && npm install && npm run dev -- --host 0.0.0.0 --port 3000',
    { background: true }
  );

  return NextResponse.json({ sandboxId: sandbox.sandboxId });
}

import { NextResponse } from 'next/server';
import { Sandbox } from 'e2b';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');

  if (!id) {
    return NextResponse.json({ error: 'Missing id' }, { status: 400 });
  }

  const sandbox = await Sandbox.connect(id);

  const check = await sandbox.commands.run(
    'curl -s -o /dev/null -w "%{http_code}" http://localhost:3000 || echo 000'
  );

  const statusCode = check.stdout.trim();
  const ready = statusCode.startsWith('2') || statusCode.startsWith('3');

  if (!ready) {
    const logCheck = await sandbox.commands.run(
      'tail -n 60 /home/user/project/dev.log 2>/dev/null || echo "no log yet"'
    );
    return NextResponse.json({ ready: false, log: logCheck.stdout });
  }

  const host = sandbox.getHost(3000);
  return NextResponse.json({ ready: true, url: `https://${host}` });
}

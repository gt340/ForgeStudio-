import JSZip from 'jszip';
import { getCurrentUser } from '@/lib/supabase-server';
import { buildDeployableRepoFiles, EXPORT_REPO_OPTIONS } from '@/lib/repo-files';

// Route Handler: runs on the server only ('use client' does not apply here and must not be added).
// Phase 7B: the ZIP now contains exactly the files the GitHub sync would push — the shared builder in
// lib/repo-files.ts prepares the page (adds 'use client', resolves {{IMG}}/{{VIDEO}} placeholders) so the
// exported project builds and shows real media instead of the raw saved source.
export const maxDuration = 30;

const MAX_CODE_CHARS = 500_000;

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { code } = await req.json().catch(() => ({}));

  if (!code || typeof code !== 'string') {
    return Response.json({ error: 'Missing code' }, { status: 400 });
  }
  if (code.length > MAX_CODE_CHARS) {
    return Response.json({ error: 'Code is too large to export' }, { status: 400 });
  }

  try {
    const files = await buildDeployableRepoFiles(code, EXPORT_REPO_OPTIONS);

    const zip = new JSZip();
    for (const [path, content] of Object.entries(files)) zip.file(path, content);
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });

    return new Response(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="forgestudio-export.zip"',
      },
    });
  } catch (e) {
    console.error('Export failed:', e);
    return Response.json({ error: 'Could not build the export. Please try again.' }, { status: 500 });
  }
}

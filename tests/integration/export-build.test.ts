import { describe, it, expect, vi } from 'vitest';
import JSZip from 'jszip';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// REAL end-to-end check of the ZIP export: call the real route, unpack the ZIP to a temp directory, run
// `npm install` and a real Next.js production build (the pinned next@14.2.32 the exported project declares).
//
// It needs the npm registry, so it runs in CI (GitHub sets CI=true) or when RUN_EXPORT_BUILD=1, and is skipped
// in offline sandboxes. Auth is mocked; no database, Pexels or GitHub call is made (no PEXELS_API_KEY -> media
// placeholders resolve to the fallback image URL, which is only a string at build time).

vi.mock('@/lib/supabase-server', () => ({
  getCurrentUser: async () => ({ id: 'u1' }),
  createSupabaseServerClient: async () => {
    throw new Error('export must not touch the database');
  },
}));

const enabled = Boolean(process.env.CI || process.env.RUN_EXPORT_BUILD);

// Shaped like the real saved projects: hooks (useState) + media placeholders + no 'use client' directive.
const SAVED_PAGE = `import { useState } from "react";

const items = ["Sourdough", "Croissant", "Baguette"];

export default function Page() {
  const [picked, setPicked] = useState(items[0]);
  return (
    <main style={{ fontFamily: "sans-serif", padding: 24 }}>
      <img src="{{IMG:artisan bakery storefront}}" alt="storefront" style={{ width: "100%" }} />
      <h1>Fresh today: {picked}</h1>
      {items.map((i) => (
        <button key={i} onClick={() => setPicked(i)}>{i}</button>
      ))}
      <video src="{{VIDEO:baker kneading dough}}" autoPlay muted loop style={{ width: "100%" }} />
    </main>
  );
}
`;

// Explicit NodeJS.ProcessEnv type: Next's type augmentation narrows NODE_ENV to 'development' | 'production' | 'test',
// so a widened `string` here would not type-check against execFileSync's `env` option.
const buildEnv: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_ENV: 'production', // vitest sets NODE_ENV=test, which Next's build rejects/warns about
  NEXT_TELEMETRY_DISABLED: '1',
  CI: '1',
};
delete buildEnv.PEXELS_API_KEY;

// GitHub Actions turns `::notice` lines into annotations, so the evidence is visible on the run summary page.
function notice(message: string) {
  console.log(`::notice title=export-build::${message.replace(/\r?\n/g, '%0A').slice(0, 900)}`);
}

function run(cmd: string, args: string[], cwd: string, timeout: number): { ok: boolean; output: string } {
  try {
    const out = execFileSync(cmd, args, { cwd, env: buildEnv, timeout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
    return { ok: true, output: out };
  } catch (e: any) {
    return { ok: false, output: `${e.stdout ?? ''}\n${e.stderr ?? ''}\n${e.message ?? ''}` };
  }
}

describe.skipIf(!enabled)('exported ZIP builds with a real Next.js production build', () => {
  it(
    'unpacks the export, npm installs, and `next build` succeeds — while the raw saved source (the pre-7B export) does NOT',
    async () => {
      const { POST } = await import('@/app/api/export/route');
      const res = await POST(new Request('http://localhost/api/export', { method: 'POST', body: JSON.stringify({ code: SAVED_PAGE }) }));
      expect(res.status).toBe(200);

      const zip = await JSZip.loadAsync(await res.arrayBuffer());
      const dir = mkdtempSync(path.join(tmpdir(), 'forgestudio-export-'));
      try {
        for (const name of Object.keys(zip.files)) {
          const entry = zip.files[name];
          const target = path.join(dir, name);
          if (entry.dir) { mkdirSync(target, { recursive: true }); continue; }
          mkdirSync(path.dirname(target), { recursive: true });
          writeFileSync(target, await entry.async('nodebuffer'));
        }

        const install = run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], dir, 300_000);
        expect(install.ok, `npm install failed:\n${install.output}`).toBe(true);

        // 1) the exported project builds
        const build = run('node', [path.join('node_modules', 'next', 'dist', 'bin', 'next'), 'build'], dir, 420_000);
        console.log(`[export-build] exported project build:\n${build.output.split('\n').slice(0, 40).join('\n')}`);
        notice(`EXPORTED ZIP BUILD ok=${build.ok} | ${build.output.split('\n').filter((l) => /Next\.js|Compiled|Generating|Route|Collecting|First Load|rror/.test(l)).slice(0, 8).join(' | ')}`);
        expect(build.ok, `next build of the exported ZIP failed:\n${build.output}`).toBe(true);
        expect(existsSync(path.join(dir, '.next', 'BUILD_ID'))).toBe(true);

        // 2) control: the pre-7B behaviour (raw saved source as app/page.js) must fail to build,
        //    which confirms the root cause rather than assuming it
        rmSync(path.join(dir, '.next'), { recursive: true, force: true });
        writeFileSync(path.join(dir, 'app', 'page.js'), SAVED_PAGE);
        const control = run('node', [path.join('node_modules', 'next', 'dist', 'bin', 'next'), 'build'], dir, 420_000);
        console.log(`[export-build] CONTROL (raw source, no directive) build ok=${control.ok}:\n${control.output.split('\n').slice(0, 25).join('\n')}`);
        notice(`CONTROL raw pre-7B source build ok=${control.ok} | ${control.output.split('\n').filter((l) => /rror|useState|Client Component|use client/.test(l)).slice(0, 6).join(' | ')}`);
        expect(control.ok, 'the raw (pre-7B) export unexpectedly built; the root-cause explanation is wrong').toBe(false);
        expect(control.output).toMatch(/useState|Client Component|use client/i);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    1_200_000
  );
});

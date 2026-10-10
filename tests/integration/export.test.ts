import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import JSZip from 'jszip';

// POST /api/export — authentication, input validation, ZIP contents, dependencies, placeholder resolution and
// error handling. Mocks only: no real Pexels / Supabase calls. (The real `next build` of the generated ZIP
// is exercised separately by tests/integration/export-build.test.ts.)

const h = vi.hoisted(() => ({ user: { id: 'u1' } as any, failBuild: false }));
vi.mock('@/lib/supabase-server', () => ({
  getCurrentUser: async () => h.user,
  createSupabaseServerClient: async () => {
    throw new Error('export must not touch the database');
  },
}));
vi.mock('@/lib/repo-files', async (importOriginal) => {
  const real: any = await importOriginal();
  return {
    ...real,
    buildDeployableRepoFiles: (...args: any[]) => {
      if (h.failBuild) throw new Error('boom');
      return real.buildDeployableRepoFiles(...args);
    },
  };
});

const PAGE = `import { useState } from "react";

export default function Page() {
  const [n, setN] = useState(0);
  return (
    <main>
      <img src="{{IMG:luxury house exterior}}" alt="house" />
      <video src="{{VIDEO:city drone}}" />
      <button onClick={() => setN(n + 1)}>Clicked {n}</button>
    </main>
  );
}
`;

const post = async (body: unknown, raw = false) => {
  const { POST } = await import('@/app/api/export/route');
  return POST(new Request('http://localhost/api/export', { method: 'POST', body: raw ? (body as string) : JSON.stringify(body) }));
};
const unzip = async (res: Response) => {
  const zip = await JSZip.loadAsync(await res.arrayBuffer());
  const out: Record<string, string> = {};
  for (const name of Object.keys(zip.files)) if (!zip.files[name].dir) out[name] = await zip.files[name].async('string');
  return out;
};

function stubPexels() {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(String(url));
      if (String(url).includes('/videos/search'))
        return { ok: true, json: async () => ({ videos: [{ video_files: [{ quality: 'sd', link: 'https://v.example/sd.mp4' }, { quality: 'hd', link: 'https://v.example/hd.mp4' }] }] }) };
      return { ok: true, json: async () => ({ photos: [{ src: { large: 'https://img.example/house.jpg' } }] }) };
    })
  );
  return calls;
}

beforeEach(() => {
  h.user = { id: 'u1' };
  h.failBuild = false;
  process.env.PEXELS_API_KEY = 'test-pexels-key';
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.PEXELS_API_KEY;
});

describe('POST /api/export', () => {
  describe('authentication', () => {
    it('rejects anonymous callers with 401 and builds nothing', async () => {
      h.user = null;
      const fetchSpy = stubPexels();
      const res = await post({ code: PAGE });
      expect(res.status).toBe(401);
      expect((await res.json()).error).toBe('Unauthorized');
      expect(fetchSpy).toHaveLength(0);
    });
  });

  describe('input validation', () => {
    it('400 for a missing code field', async () => {
      expect((await post({})).status).toBe(400);
    });
    it('400 for non-string / empty code', async () => {
      for (const code of [123, ['x'], { a: 1 }, null, '']) expect((await post({ code })).status).toBe(400);
    });
    it('400 for an unparseable body', async () => {
      expect((await post('{not json', true)).status).toBe(400);
    });
    it('400 for code over the size limit, and accepts code at the limit', async () => {
      stubPexels();
      expect((await post({ code: 'x'.repeat(500_001) })).status).toBe(400);
      expect((await post({ code: 'x'.repeat(500_000) })).status).toBe(200);
    });
    it('error responses are JSON, never a ZIP', async () => {
      const res = await post({});
      expect(res.headers.get('content-type')).toMatch(/application\/json/);
    });
  });

  describe('ZIP contents', () => {
    it('returns a valid ZIP attachment with exactly the shared repository files', async () => {
      stubPexels();
      const res = await post({ code: PAGE });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/zip');
      expect(res.headers.get('content-disposition')).toMatch(/attachment; filename="forgestudio-export\.zip"/);
      const files = await unzip(res);
      expect(Object.keys(files).sort()).toEqual(['README.md', 'app/layout.js', 'app/page.js', 'next.config.js', 'package.json']);
      expect(files['app/layout.js']).toContain('RootLayout');
      expect(files['README.md']).toContain('npm run dev');
    });

    it("page.js starts with the 'use client' directive (a hooks page cannot build without it)", async () => {
      stubPexels();
      const files = await unzip(await post({ code: PAGE }));
      expect(files['app/page.js'].startsWith("'use client';")).toBe(true);
      expect(files['app/page.js']).toContain('useState');
    });

    it("does not duplicate an existing 'use client' directive", async () => {
      stubPexels();
      const files = await unzip(await post({ code: `"use client";\n${PAGE}` }));
      expect(files['app/page.js'].match(/use client/g)).toHaveLength(1);
    });

    it('is byte-identical to what the GitHub sync pushes for the same code (no drift)', async () => {
      stubPexels();
      const exported = await unzip(await post({ code: PAGE }));
      const { buildDeployableRepoFiles, GITHUB_REPO_OPTIONS } = await import('@/lib/repo-files');
      const github = await buildDeployableRepoFiles(PAGE, GITHUB_REPO_OPTIONS);
      expect(exported['app/page.js']).toBe(github['app/page.js']);
      expect(exported['app/layout.js']).toBe(github['app/layout.js']);
      expect(exported['next.config.js']).toBe(github['next.config.js']);
      expect(JSON.parse(exported['package.json']).dependencies).toEqual(JSON.parse(github['package.json']).dependencies);
    });
  });

  describe('dependencies', () => {
    it('declares next, react, react-dom AND @supabase/supabase-js at pinned versions, with build scripts', async () => {
      stubPexels();
      const pkg = JSON.parse((await unzip(await post({ code: PAGE })))['package.json']);
      expect(pkg.dependencies).toEqual({
        next: '14.2.32',
        react: '18.3.1',
        'react-dom': '18.3.1',
        '@supabase/supabase-js': '2.45.4',
      });
      expect(pkg.scripts).toMatchObject({ dev: 'next dev', build: 'next build', start: 'next start' });
      expect(pkg.private).toBe(true);
    });
  });

  describe('placeholder resolution', () => {
    it('replaces {{IMG}} and {{VIDEO}} placeholders with real Pexels URLs (hd video preferred)', async () => {
      const calls = stubPexels();
      const page = (await unzip(await post({ code: PAGE })))['app/page.js'];
      expect(page).toContain('https://img.example/house.jpg');
      expect(page).toContain('https://v.example/hd.mp4');
      expect(page).not.toMatch(/\{\{(IMG|VIDEO):/);
      expect(calls.some((c) => c.includes('/v1/search'))).toBe(true);
      expect(calls.some((c) => c.includes('/videos/search'))).toBe(true);
    });

    it('falls back to a placeholder image (never leaves {{…}} behind) when Pexels fails', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
      const page = (await unzip(await post({ code: PAGE })))['app/page.js'];
      expect(page).not.toMatch(/\{\{(IMG|VIDEO):/);
      expect(page).toContain('via.placeholder.com');
    });

    it('falls back when no PEXELS_API_KEY is configured, without calling Pexels', async () => {
      delete process.env.PEXELS_API_KEY;
      const calls = stubPexels();
      const page = (await unzip(await post({ code: PAGE })))['app/page.js'];
      expect(page).not.toMatch(/\{\{(IMG|VIDEO):/);
      expect(calls).toHaveLength(0);
    });

    it('leaves code without placeholders untouched apart from the directive', async () => {
      const calls = stubPexels();
      const code = 'export default function P(){return <p>hi</p>}';
      expect((await unzip(await post({ code })))['app/page.js']).toBe(`'use client';\n${code}`);
      expect(calls).toHaveLength(0);
    });
  });

  describe('error handling', () => {
    it('answers 500 with a safe JSON error (no stack/internal message) if the build step throws', async () => {
      h.failBuild = true;
      const res = await post({ code: PAGE });
      expect(res.status).toBe(500);
      expect(res.headers.get('content-type')).toMatch(/application\/json/);
      const data = await res.json();
      expect(data.error).toBe('Could not build the export. Please try again.');
      expect(JSON.stringify(data)).not.toMatch(/boom/);
    });
  });
});

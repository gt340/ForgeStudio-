import { describe, it, expect, vi, afterEach } from 'vitest';
import { phaseFromState, pickProductionUrl } from '@/lib/vercel-utils';
import { ensureUseClient, prepareDeployableCode } from '@/lib/deploy-code';

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  delete process.env.PEXELS_API_KEY;
});

describe('phaseFromState', () => {
  it('only READY counts as ready; unknown states never count as success', () => {
    expect(phaseFromState('READY')).toBe('ready');
    expect(phaseFromState('ERROR')).toBe('failed');
    expect(phaseFromState('CANCELED')).toBe('canceled');
    expect(phaseFromState('BUILDING')).toBe('deploying');
    expect(phaseFromState('QUEUED')).toBe('preparing');
    expect(phaseFromState('SOMETHING_NEW')).toBe('preparing');
    expect(phaseFromState(undefined)).toBe('preparing');
  });
});

describe('pickProductionUrl', () => {
  it('prefers the shortest *.vercel.app alias over the per-deployment URL', () => {
    const url = pickProductionUrl({
      url: 'my-site-abc123.vercel.app',
      alias: ['my-site-git-main-user.vercel.app', 'my-site.vercel.app'],
    });
    expect(url).toBe('https://my-site.vercel.app');
  });

  it('falls back to the deployment URL only when no alias exists', () => {
    expect(pickProductionUrl({ url: 'my-site-abc123.vercel.app', alias: [] })).toBe('https://my-site-abc123.vercel.app');
  });

  it('returns null when there is nothing to point at', () => {
    expect(pickProductionUrl({})).toBeNull();
  });
});

describe('ensureUseClient', () => {
  it('adds the directive when missing and never duplicates it', () => {
    expect(ensureUseClient('import { useState } from "react";')).toBe("'use client';\nimport { useState } from \"react\";");
    expect(ensureUseClient("'use client';\nconst a = 1;")).toBe("'use client';\nconst a = 1;");
    expect(ensureUseClient('"use client";\nconst a = 1;')).toBe('"use client";\nconst a = 1;');
  });
});

describe('prepareDeployableCode', () => {
  it('makes no network calls when there are no media placeholders', async () => {
    global.fetch = vi.fn();
    const out = await prepareDeployableCode('export default function Page() { return null; }');
    expect(out.startsWith("'use client';")).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('replaces image placeholders with the resolved URL', async () => {
    process.env.PEXELS_API_KEY = 'test-key';
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ photos: [{ src: { large: 'https://images.example/photo.jpg' } }] }),
    }) as unknown as typeof fetch;
    const out = await prepareDeployableCode('<img src="{{IMG:coffee shop}}" /><img src="{{IMG:coffee shop}}" />');
    expect(out).not.toContain('{{IMG:');
    expect(out).toContain('https://images.example/photo.jpg');
    expect((global.fetch as any).mock.calls.length).toBe(1); // duplicates resolved once
  });
});

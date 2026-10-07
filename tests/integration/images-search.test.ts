import { describe, it, expect, vi, afterEach } from 'vitest';

const h = vi.hoisted(() => ({ user: null as any }));
vi.mock('@/lib/supabase-server', () => ({
  getCurrentUser: async () => h.user,
  createSupabaseServerClient: async () => {
    throw new Error('not needed');
  },
}));

const PEXELS_KEY = 'pexels_SECRET_KEY_123';

const call = async (body: unknown) => {
  const { POST } = await import('@/app/api/images/search/route');
  const { NextRequest } = await import('next/server');
  const res = await POST(new NextRequest('http://localhost/api/images/search', { method: 'POST', body: JSON.stringify(body) }));
  const text = await res.text();
  return { res, text };
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.PEXELS_API_KEY;
});

describe('POST /api/images/search (Phase 7K: no anonymous use of the shared Pexels quota)', () => {
  it('rejects anonymous callers with 401 and never calls Pexels', async () => {
    process.env.PEXELS_API_KEY = PEXELS_KEY;
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    h.user = null;

    const { res } = await call({ query: 'coffee shop' });

    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([undefined, '', '   ', 42, { a: 1 }, 'x'.repeat(201)])('rejects a bad query %j with 400 and never calls Pexels', async (query) => {
    process.env.PEXELS_API_KEY = PEXELS_KEY;
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    h.user = { id: 'u1' };

    const { res } = await call({ query });

    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('serves a signed-in user with one Pexels request and never returns the API key', async () => {
    process.env.PEXELS_API_KEY = PEXELS_KEY;
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ photos: [{ src: { large: 'https://img/l.jpg', medium: 'https://img/m.jpg' } }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    h.user = { id: 'u1' };

    const { res, text } = await call({ query: 'coffee shop', type: 'photo' });

    expect(res.status).toBe(200);
    expect(JSON.parse(text)).toEqual({ url: 'https://img/l.jpg', thumbnail: 'https://img/m.jpg' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(text).not.toContain(PEXELS_KEY);
  });

  it('fails safely (500, no key, no stack) when the upstream call throws', async () => {
    process.env.PEXELS_API_KEY = PEXELS_KEY;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error(`network down for ${PEXELS_KEY}`);
    }));
    h.user = { id: 'u1' };

    const { res, text } = await call({ query: 'coffee shop' });

    expect(res.status).toBe(500);
    expect(text).not.toContain(PEXELS_KEY);
    expect(text).not.toMatch(/at .*\.ts/);
  });
});

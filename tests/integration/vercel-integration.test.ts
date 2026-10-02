import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetCurrentUser = vi.fn();
const mockUpsert = vi.fn();
const mockSupabase = {
  from: () => ({
    upsert: (...a: any[]) => { mockUpsert(...a); return Promise.resolve({ error: null }); },
  }),
};

vi.mock('@/lib/supabase-server', () => ({
  getCurrentUser: (...args: any[]) => mockGetCurrentUser(...args),
  createSupabaseServerClient: vi.fn(() => Promise.resolve(mockSupabase)),
}));

const originalFetch = global.fetch;

function makeRequest(token: unknown) {
  return new Request('http://localhost/api/integrations/vercel', {
    method: 'POST',
    body: JSON.stringify({ token }),
  });
}

describe('/api/integrations/vercel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = originalFetch;
  });

  it('rejects an anonymous request with 401 and never calls Vercel', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    global.fetch = vi.fn();
    const { POST } = await import('@/app/api/integrations/vercel/route');

    const res = await POST(makeRequest('vcp_sometoken'));

    expect(res.status).toBe(401);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('rejects an empty token with 400 and never calls Vercel', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u1' });
    global.fetch = vi.fn();
    const { POST } = await import('@/app/api/integrations/vercel/route');

    const res = await POST(makeRequest('   '));

    expect(res.status).toBe(400);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('maps a 401 from Vercel to a safe "token rejected" message and does not save anything', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u1' });
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: { code: 'forbidden' } }) });
    const { POST } = await import('@/app/api/integrations/vercel/route');

    const res = await POST(makeRequest('vcp_badtoken'));

    expect(res.status).toBe(401);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('maps a 404 from Vercel to a message that does not claim the token is definitely invalid', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u1' });
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({ error: { code: 'not_found', message: 'User not found' } }) });
    const { POST } = await import('@/app/api/integrations/vercel/route');

    const res = await POST(makeRequest('vcp_validbuttrickytoken'));
    const data = await res.json();

    expect(res.status).toBe(502);
    expect(data.error.toLowerCase()).not.toContain('invalid personal access token');
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('maps a 429 from Vercel to 429 and does not save anything', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u1' });
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({}) });
    const { POST } = await import('@/app/api/integrations/vercel/route');

    const res = await POST(makeRequest('vcp_token'));

    expect(res.status).toBe(429);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('handles a network failure safely without throwing, and never saves anything', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u1' });
    global.fetch = vi.fn().mockRejectedValue(new Error('fetch failed'));
    const { POST } = await import('@/app/api/integrations/vercel/route');

    const res = await POST(makeRequest('vcp_token'));

    expect(res.status).toBe(502);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('on success, saves safe metadata and NEVER returns access_token in the JSON response', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u1' });
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ user: { id: 'vercel-user-1', defaultTeamId: 'team-1' } }),
    });
    const { POST } = await import('@/app/api/integrations/vercel/route');

    const res = await POST(makeRequest('vcp_validtoken'));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(JSON.stringify(data)).not.toContain('vcp_validtoken');
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    const savedRow = mockUpsert.mock.calls[0][0];
    expect(savedRow.access_token).toBe('vcp_validtoken');
    expect(savedRow.vercel_user_id).toBe('vercel-user-1');
  });
});

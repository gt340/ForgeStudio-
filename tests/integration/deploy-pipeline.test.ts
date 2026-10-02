import { describe, it, expect, vi, beforeEach } from 'vitest';

// Same minimal thenable-chain Supabase mock pattern used in projects.test.ts.
let responseQueue: any[] = [];
function makeChain() {
  const response = responseQueue.shift() ?? { data: null, error: null };
  const chain: any = {
    select: () => chain,
    update: () => chain,
    eq: () => chain,
    single: () => Promise.resolve(response),
    then: (resolve: any) => resolve(response),
  };
  return chain;
}

const mockGetCurrentUser = vi.fn();
const mockSupabase = { from: () => makeChain() };

vi.mock('@/lib/supabase-server', () => ({
  getCurrentUser: (...args: any[]) => mockGetCurrentUser(...args),
  createSupabaseServerClient: vi.fn(() => Promise.resolve(mockSupabase)),
}));

const originalFetch = global.fetch;

function makeRequest(body: unknown) {
  return new Request('http://localhost/api/deploy/vercel', { method: 'POST', body: JSON.stringify(body) });
}

const OWNER_ID = 'owner-uuid';

const PROJECT_WITH_GITHUB = {
  id: 'p1',
  github_owner: 'gt340',
  github_repo: 'some-site',
  github_repo_id: 999,
  github_default_branch: 'main',
  vercel_project_id: null,
  vercel_project_name: null,
};

describe('GitHub \u2192 Vercel deployment pipeline (/api/deploy/vercel)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    responseQueue = [];
    global.fetch = originalFetch;
  });

  it('refuses to deploy \u2014 and makes zero Vercel API calls \u2014 when the project has no GitHub association', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: OWNER_ID });
    responseQueue = [{ data: { id: 'p1', github_owner: null, github_repo: null }, error: null }];
    global.fetch = vi.fn();
    const { POST } = await import('@/app/api/deploy/vercel/route');

    const res = await POST(makeRequest({ projectId: 'p1' }));

    expect(res.status).toBe(400);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('stops before any Vercel call when Vercel is not connected (no stored token)', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: OWNER_ID });
    responseQueue = [{ data: PROJECT_WITH_GITHUB, error: null }, { data: null, error: { message: 'no rows' } }];
    global.fetch = vi.fn();
    const { POST } = await import('@/app/api/deploy/vercel/route');

    const res = await POST(makeRequest({ projectId: 'p1' }));

    expect(res.status).toBe(401);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('never attempts a deployment when Vercel project creation fails, and reports a real error, not success', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: OWNER_ID });
    responseQueue = [{ data: PROJECT_WITH_GITHUB, error: null }, { data: { access_token: 'vcp_realtoken' }, error: null }];
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: { message: 'name taken' } }) });
    global.fetch = fetchMock;
    const { POST } = await import('@/app/api/deploy/vercel/route');

    const res = await POST(makeRequest({ projectId: 'p1' }));
    const data = await res.json();

    expect(res.status).toBe(502);
    expect(data.status).toBeUndefined();
    // Only project-creation attempts (initial + one retry) \u2014 deployments endpoint never reached.
    const deploymentCalls = fetchMock.mock.calls.filter((c: any[]) => String(c[0]).includes('/v13/deployments'));
    expect(deploymentCalls.length).toBe(0);
  });

  it('reports the true in-progress state \u2014 never a fabricated READY \u2014 when polling is exhausted before Vercel finishes building', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: OWNER_ID });
    responseQueue = [{ data: PROJECT_WITH_GITHUB, error: null }, { data: { access_token: 'vcp_realtoken' }, error: null }];
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/v11/projects')) {
        return Promise.resolve({ ok: true, json: async () => ({ id: 'vprj_1', name: 'some-site' }) });
      }
      if (url.includes('/v13/deployments') && !url.match(/deployments\/.+/)) {
        return Promise.resolve({ ok: true, json: async () => ({ id: 'dpl_1', url: 'some-site-abc.vercel.app' }) });
      }
      if (url.includes('/v13/deployments/')) {
        // Deployment never settles \u2014 stays BUILDING forever.
        return Promise.resolve({ ok: true, json: async () => ({ readyState: 'BUILDING' }) });
      }
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    });
    global.fetch = fetchMock;
    const { POST } = await import('@/app/api/deploy/vercel/route');

    const res = await POST(makeRequest({ projectId: 'p1' }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.status).toBe('QUEUED'); // falls back to the deployment-creation response's own state, never fabricated as READY
    expect(data.polled).toBe(false);
    const statusPollCalls = fetchMock.mock.calls.filter((c: any[]) => String(c[0]).includes('/v13/deployments/'));
    expect(statusPollCalls.length).toBeLessThanOrEqual(8); // bounded polling, never infinite
  }, 30000);

  it('happy path: creates a Vercel project, triggers a deployment, and reports READY with a real production URL only once Vercel actually confirms it', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: OWNER_ID });
    responseQueue = [{ data: PROJECT_WITH_GITHUB, error: null }, { data: { access_token: 'vcp_realtoken' }, error: null }];
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/v11/projects')) {
        return Promise.resolve({ ok: true, json: async () => ({ id: 'vprj_1', name: 'some-site' }) });
      }
      if (url.includes('/v13/deployments') && !url.match(/deployments\/.+/)) {
        return Promise.resolve({ ok: true, json: async () => ({ id: 'dpl_1', url: 'some-site-abc.vercel.app' }) });
      }
      if (url.includes('/v13/deployments/')) {
        return Promise.resolve({ ok: true, json: async () => ({ readyState: 'READY', url: 'some-site-abc.vercel.app' }) });
      }
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    });
    global.fetch = fetchMock;
    const { POST } = await import('@/app/api/deploy/vercel/route');

    const res = await POST(makeRequest({ projectId: 'p1' }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.status).toBe('READY');
    expect(data.url).toBe('https://some-site-abc.vercel.app');
    expect(data.deploymentId).toBe('dpl_1');
  }, 10000);
});
